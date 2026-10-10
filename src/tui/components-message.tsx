import type React from 'react';
import { Box, Text } from 'ink';
import { theme, sym } from './theme.js';
import { Markdown } from './markdown.js';
import { LIVE_TOOLS_SHOWN } from './live-layout.js';
import {
  messageUsage,
  summarizeToolInput,
  isInternalMessage,
  type ChatMessage,
  type ChatPart,
  type ChatState,
  type TodoItem,
} from './state.js';
import { clip, kfmt } from './components-blocks.js';

/** Tool em árvore: `● nome(arg) status` + `⎿ 1ª linha da saída` (Sprint 2). */
function ToolBlock({ part }: { part: ChatPart }): React.ReactElement {
  const t = part.tool;
  const running = t?.status === 'running' || t?.status === 'pending';
  const badge = running ? theme.warn : t?.status === 'error' ? theme.err : theme.dim;
  const arg = clip(summarizeToolInput(t?.input), 48);
  const outLine = (t?.output ?? '').split('\n').find((l) => l.trim()) ?? '';
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.accent}>{sym.dot} </Text>
        <Text color={theme.text}>{t?.name ?? part.text}</Text>
        {arg ? <Text color={theme.dim}>({arg})</Text> : null}{' '}
        <Text color={badge}>{t?.status ?? ''}</Text>
      </Text>
      {outLine && !running && (
        <Text color={theme.dim} wrap="truncate-end">
          {'  ⎿ '}
          {clip(outLine, 66)}
        </Text>
      )}
    </Box>
  );
}

/** Fork: sub-agente disparado pelo modelo (part `subtask`) — `⑂ agente · descrição`. */
function ForkBlock({ part }: { part: ChatPart }): React.ReactElement {
  const f = part.fork;
  return (
    <Text wrap="truncate-end">
      <Text color={theme.accent}>{'⑂ '}</Text>
      <Text color={theme.accentBright}>{f?.agent ?? part.text}</Text>
      {f?.description ? <Text color={theme.dim}>{` · ${clip(f.description, 60)}`}</Text> : null}
    </Text>
  );
}

const TODO_MARK: Record<string, string> = {
  completed: '☑',
  in_progress: '◐',
  cancelled: '⊘',
  pending: '☐',
};

/** Checklist do modelo (`todo.updated`) — o "caminho" que ele está seguindo. */
function TodoList({ todos }: { todos: TodoItem[] }): React.ReactElement | null {
  if (todos.length === 0) return null;
  return (
    <Box flexDirection="column">
      {todos.slice(0, 8).map((t, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: linhas posicionais derivadas de texto: sem identidade nem reordenação, o índice é a chave estável
          key={i}
          wrap="truncate-end"
          color={
            t.status === 'completed'
              ? theme.dim
              : t.status === 'in_progress'
                ? theme.warn
                : t.status === 'cancelled'
                  ? theme.dim
                  : theme.text
          }
        >
          {'  '}
          {TODO_MARK[t.status] ?? '☐'} {t.content}
        </Text>
      ))}
    </Box>
  );
}

/** Rodapé compacto: tokens · custo · arquivos editados. */
function UsageFooter({
  usage,
  files = 0,
}: {
  usage: { tokensIn: number; tokensOut: number; cost: number } | null;
  files?: number;
}): React.ReactElement | null {
  const bits: string[] = [];
  if (usage && (usage.tokensIn || usage.tokensOut))
    bits.push(`↑${kfmt(usage.tokensIn)} ↓${kfmt(usage.tokensOut)}`);
  if (usage && usage.cost > 0) bits.push(`$${usage.cost.toFixed(3)}`);
  if (files > 0) bits.push(`${files} arquivo(s)`);
  if (bits.length === 0) return null;
  return (
    <Text color={theme.dim} wrap="truncate-end">
      {'  '}
      {bits.join(' · ')}
    </Text>
  );
}

function Author({ role }: { role: ChatMessage['role'] }): React.ReactElement {
  // marcadores tipo Claude Code: `> você` / `⏺ nio` (Sprint 4)
  return (
    <Text bold color={role === 'user' ? theme.user : theme.accentBright}>
      {role === 'user' ? '> você' : '⏺ nio'}
    </Text>
  );
}

function Part({ part }: { part: ChatPart }): React.ReactElement | null {
  if (part.kind === 'step') return null; // agregado no rodapé (UsageFooter)
  if (part.kind === 'tool') return <ToolBlock part={part} />;
  if (part.kind === 'fork') return <ForkBlock part={part} />; // sub-agente disparado
  // raciocínio é só pra acompanhar AO VIVO (LiveMessage); não entra no histórico/output.
  if (part.kind === 'reasoning') return null;
  return part.text.trim() ? <Markdown text={part.text} /> : null;
}

/** Marcador discreto no lugar de uma mensagem interna ofuscada (resumo/scaffolding). */
function InternalMarker(): React.ReactElement {
  return (
    <Box marginBottom={1} paddingX={1}>
      <Text color={theme.dim}>{'✂ resumo interno ocultado'}</Text>
    </Box>
  );
}

/** Uma mensagem completa — vai pro `<Static>`. */
export function MessageView({ message }: { message: ChatMessage }): React.ReactElement {
  if (isInternalMessage(message)) return <InternalMarker />;
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Author role={message.role} />
      {message.parts.map((p) => (
        <Part key={p.id} part={p} />
      ))}
      {message.role === 'assistant' && <UsageFooter usage={messageUsage(message)} />}
    </Box>
  );
}

/**
 * A mensagem em andamento — reflete o motor: checklist de tarefas, tentativa em
 * curso, tools (com args + saída), raciocínio, texto e o rodapé de tokens/custo.
 * Altura do bloco de texto limitada a `maxLines` (nunca estoura a tela).
 */
export function LiveMessage({
  message,
  maxLines,
  todos = [],
  files = [],
  retry = null,
  expandReasoning = false,
}: {
  message: ChatMessage;
  maxLines: number;
  todos?: TodoItem[];
  files?: string[];
  retry?: ChatState['retry'];
  /** Sprint 3: `true` = mostra o raciocínio inteiro (toggle Ctrl-R no App). */
  expandReasoning?: boolean;
}): React.ReactElement {
  if (isInternalMessage(message)) return <InternalMarker />; // resumo/scaffolding: ofusca já ao vivo
  const text = message.parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('');
  const reasoningRaw = message.parts
    .filter((p) => p.kind === 'reasoning')
    .map((p) => p.text)
    .join('\n')
    .trim();
  const reasoningFlat = reasoningRaw.replace(/\s+/g, ' ');
  const reasoningLines = reasoningRaw.split('\n').filter((l) => l.trim());
  const allTools = message.parts.filter((p) => p.kind === 'tool');
  const tools = allTools.slice(-LIVE_TOOLS_SHOWN); // o histórico tem todas
  const toolsHidden = allTools.length - tools.length;
  const forks = message.parts.filter((p) => p.kind === 'fork'); // sub-agentes disparados
  // orça a altura: chrome (todo + tools + rodapé + raciocínio) sai do budget de texto
  const reasoningShown =
    expandReasoning && reasoningLines.length
      ? reasoningLines.slice(-Math.min(10, Math.max(3, maxLines - 6)))
      : [];
  const chrome =
    Math.min(6, todos.length) + tools.length * 2 + (retry ? 1 : 0) + reasoningShown.length + 2;
  const textBudget = Math.max(2, maxLines - chrome);
  const lines = text.split('\n');
  const shown = lines.slice(-textBudget);
  const clipped = lines.length > shown.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Author role={message.role} />
      {retry && (
        <Text color={theme.warn} wrap="truncate-end">
          {'  ↻ tentativa '}
          {retry.attempt}
          {' — '}
          {retry.note}
        </Text>
      )}
      <TodoList todos={todos} />
      {toolsHidden > 0 && (
        <Text color={theme.dim}>{`  · +${toolsHidden} ferramenta(s) acima`}</Text>
      )}
      {tools.map((t) => (
        <ToolBlock key={t.id} part={t} />
      ))}
      {forks.map((f) => (
        <ForkBlock key={f.id} part={f} />
      ))}
      {reasoningRaw && !expandReasoning && (
        <Text color={theme.dim} wrap="truncate-end">
          {'  ✻ raciocínio '}
          <Text color={theme.accent}>Ctrl-R</Text>
          {'  '}
          {reasoningFlat.slice(-120)}
        </Text>
      )}
      {reasoningRaw && expandReasoning && (
        <Box flexDirection="column">
          <Text color={theme.accent}>
            {'  ✻ raciocínio'}
            {reasoningLines.length > reasoningShown.length
              ? ` · ${reasoningLines.length} linhas`
              : ''}
          </Text>
          {reasoningShown.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: linhas posicionais derivadas de texto: sem identidade nem reordenação, o índice é a chave estável
            <Text key={i} color={theme.dim} wrap="truncate-end">
              {'    '}
              {l}
            </Text>
          ))}
        </Box>
      )}
      {clipped && <Text color={theme.dim}> … (rolagem acima)</Text>}
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: linhas posicionais derivadas de texto: sem identidade nem reordenação, o índice é a chave estável
        <Text key={i} wrap="truncate-end">
          {l || ' '}
        </Text>
      ))}
      <UsageFooter usage={messageUsage(message)} files={files.length} />
    </Box>
  );
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Reflete o processamento do opencode: spinner + **fase atual** (pensando /
 * raciocinando / executando ferramenta / escrevendo) + **tempo decorrido** — pra que
 * o gap silencioso do 1º token (o modelo pode levar ~20s) não pareça travamento.
 */
export function StatusLine({
  busy,
  frame,
  seconds = 0,
  label = 'processando',
}: {
  busy: boolean;
  frame: number;
  seconds?: number;
  label?: string;
}): React.ReactElement | null {
  if (!busy) return null;
  return (
    <Box paddingX={1}>
      <Text color={theme.warn}>
        {FRAMES[frame % FRAMES.length]} {label}…{' '}
        <Text color={theme.dim}>{seconds}s · Esc aborta</Text>
      </Text>
    </Box>
  );
}
