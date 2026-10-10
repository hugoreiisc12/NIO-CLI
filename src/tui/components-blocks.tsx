import type React from 'react';
import { Box, Text } from 'ink';
import { theme, sym } from './theme.js';
import type { PaletteItem } from './palette-source.js';
import type { ChatState, Toast } from './state.js';

export type PaletteAction = 'info' | 'run' | 'prompt';

export const KIND_LABEL: Record<PaletteItem['kind'], string> = {
  command: 'cmd',
  capability: 'agente',
  help: 'ajuda',
};

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const kfmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const TOAST_STYLE: Record<Toast['variant'], { color: string; icon: string }> = {
  info: { color: theme.dim, icon: sym.bullet },
  success: { color: theme.accent, icon: sym.ok },
  warning: { color: theme.warn, icon: sym.warn },
  error: { color: theme.err, icon: sym.err },
};

/** Resumo do diff da volta (`session.diff`, Sprint 7.8). */
export function DiffSummary({
  changes,
}: {
  changes: ChatState['diff'];
}): React.ReactElement | null {
  if (changes.length === 0) return null;
  const parts = changes.slice(0, 4).map((c) => {
    const name = c.file.split('/').pop() || c.file;
    const a = c.added ? `+${c.added}` : '';
    const r = c.removed ? `−${c.removed}` : '';
    return `${name} ${[a, r].filter(Boolean).join(' ')}`.trim();
  });
  const more = changes.length - parts.length;
  return (
    <Box paddingX={1}>
      <Text color={theme.accent} wrap="truncate-end">
        {'✎ '}
        {changes.length} arquivo(s):{' '}
        <Text color={theme.dim}>
          {parts.join(' · ')}
          {more > 0 ? ` · +${more}` : ''}
        </Text>
      </Text>
    </Box>
  );
}

/** Chips dos arquivos detectados no input (Item 4 — anexos). `[]` → nada. */
export function AttachChips({ files }: { files: string[] }): React.ReactElement | null {
  if (files.length === 0) return null;
  return (
    <Box paddingX={1}>
      <Text color={theme.accent} wrap="truncate-end">
        {'anexos: '}
        <Text color={theme.dim}>{files.join('  ·  ')}</Text>
      </Text>
    </Box>
  );
}

/** Menu de opções da pergunta do modelo (`questionOptions`, Sprint 7.6). */
export function QuestionPicker({
  options,
  sel,
}: {
  options: string[];
  sel: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accentBright} paddingX={1}>
      {options.map((o, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: linhas posicionais derivadas de texto: sem identidade nem reordenação, o índice é a chave estável
          key={i}
          inverse={i === sel}
          color={i === sel ? theme.accentBright : undefined}
          wrap="truncate-end"
        >
          {' '}
          {i + 1}. {o}
        </Text>
      ))}
      <Text color={theme.dim}>↑↓ escolher · ↵ responder · ou digite a sua</Text>
    </Box>
  );
}

/** Erro do motor (`session.error`, Sprint 7.3) — bloco vermelho, não bloqueia o input. */
export function ErrorBlock({
  error,
}: {
  error: NonNullable<ChatState['error']>;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.err} paddingX={1}>
      <Text color={theme.err}>
        {sym.err} {error.name}
      </Text>
      <Text wrap="truncate-end">
        {'  '}
        {error.message}
      </Text>
      {error.retryable && <Text color={theme.dim}>{'  reenvie o prompt pra tentar de novo'}</Text>}
    </Box>
  );
}

/** Toasts do motor (`tui.toast.show`, Sprint 7.2) — linhas efêmeras acima do input. */
export function Toasts({ toasts }: { toasts: Toast[] }): React.ReactElement | null {
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {toasts.map((t) => {
        const s = TOAST_STYLE[t.variant];
        return (
          <Text key={t.id} color={s.color} wrap="truncate-end">
            {s.icon} {t.message}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Rodapé de 1–2 linhas — substitui a sidebar (Sprint 4, layout tipo Claude Code).
 * Linha 1: modelo · pasta · sessão · [modo] · tokens da sessão.
 * Linha 2: atalhos.
 */
export function Footer({
  model,
  cwd,
  session,
  mode,
  tokensIn = 0,
  tokensOut = 0,
  contextLimit = 0,
}: {
  model: string;
  cwd: string;
  session: { name: string; profile: string } | null;
  mode?: string;
  /** input de pico do último turno (já inclui o histórico). */
  tokensIn?: number;
  /** output gerado no último turno. */
  tokensOut?: number;
  /** janela de contexto do provider (NIO_AI_CONTEXT); 0 = não mostra %. */
  contextLimit?: number;
}): React.ReactElement {
  const folder = cwd.replace(/\/+$/, '').split('/').pop() || cwd;
  const used = tokensIn + tokensOut;
  const pct = contextLimit > 0 ? used / contextLimit : 0;
  const tokenColor = pct >= 0.9 ? theme.err : pct >= 0.7 ? theme.warn : theme.dim;
  const tokenLabel =
    used > 0
      ? `↑${kfmt(tokensIn)} ↓${kfmt(tokensOut)}${contextLimit > 0 ? ` · ${Math.round(pct * 100)}%` : ''}`
      : null;
  const bits: string[] = [`⏵ ${model}`, folder];
  if (session) bits.push(`${session.name} · ${session.profile}`);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={theme.dim}>{bits.join('  ·  ')}</Text>
        {mode ? <Text color={theme.accentBright}>{`  [${mode}]`}</Text> : null}
        {tokenLabel ? <Text color={tokenColor}>{`  ${tokenLabel}`}</Text> : null}
      </Text>
      <Text color={theme.dim}>
        <Text color={theme.accent}>/</Text> paleta{'   '}
        <Text color={theme.accent}>^R</Text> raciocínio{'   '}
        <Text color={theme.accent}>Tab</Text> modo{'   '}
        <Text color={theme.accent}>Esc</Text> abortar{'   '}
        <Text color={theme.accent}>^C</Text> sair
      </Text>
    </Box>
  );
}
