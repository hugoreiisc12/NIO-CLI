import { stripReasoningTags } from './state-text.js';
import type { ChatMessage, ChatPart, ChatState } from './state-types.js';

export const PENDING_USER = 'pending-user';

/** Part cru vindo do SDK (`message.part.updated` / `session.messages`). */
export interface RawPart {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: {
    status?: string;
    output?: string;
    error?: string;
    title?: string;
    input?: Record<string, unknown>;
  };
  tokens?: { input?: number; output?: number };
  cost?: number;
  /** part `subtask` (fork disparado pelo modelo). */
  agent?: string;
  description?: string;
  /** metadata do part; `compaction_continue` = aviso sintético de mídia removida. */
  metadata?: { compaction_continue?: boolean };
}

/** COW: tira o eco local `pending-user` quando a mensagem real chega. `messages`
 *  intacto (mesma referência) quando não há eco a remover. */
export function withoutPending(messages: ChatMessage[], realId: string): ChatMessage[] {
  if (realId === PENDING_USER) return messages;
  const i = messages.findIndex((m) => m.id === PENDING_USER);
  if (i < 0) return messages;
  return [...messages.slice(0, i), ...messages.slice(i + 1)];
}

/**
 * COW: array de mensagens com a mensagem `id` transformada (criada como `role` se
 * ausente). **Só a mensagem tocada é copiada** — as demais mantêm identidade, o que
 * evita o clone total do histórico a cada evento (era o custo O(N×M) por evento).
 */
export function withMessage(
  messages: ChatMessage[],
  id: string,
  role: ChatMessage['role'],
  transform: (parts: ChatPart[]) => ChatPart[],
  meta?: { mode?: string; summary?: boolean },
): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return [...messages, { id, role, parts: transform([]), ...meta }];
  const msg = messages[i]!;
  const parts = transform(msg.parts);
  const metaChanged =
    !!meta &&
    ((meta.mode !== undefined && meta.mode !== msg.mode) ||
      (meta.summary !== undefined && meta.summary !== msg.summary));
  if (parts === msg.parts && !metaChanged) return messages;
  const next = messages.slice();
  next[i] = { ...msg, parts, ...meta };
  return next;
}

/** Extrai `mode`/`summary` do `info` de um evento/mensagem (só chaves presentes). */
export function metaFromInfo(info: { mode?: unknown; summary?: unknown }): {
  mode?: string;
  summary?: boolean;
} {
  const meta: { mode?: string; summary?: boolean } = {};
  if (typeof info.mode === 'string') meta.mode = info.mode;
  if (typeof info.summary === 'boolean') meta.summary = info.summary;
  return meta;
}

/**
 * Interpreta um part cru do SDK sobre o part anterior (por id) e devolve o novo part
 * — ou `null` pra ignorar (`step-start`, ou texto ausente sem part prévio). Puro.
 */
function computePart(prev: ChatPart | undefined, raw: RawPart): ChatPart | null {
  const id = raw.id as string;
  const type = raw.type ?? 'text';
  // step-start não tem conteúdo; `compaction` é o resumo interno da auto-compaction
  // do opencode — nunca renderiza, senão o "pensamento de compressão" vaza no output.
  if (type === 'step-start' || type === 'compaction') return null;
  if (type === 'step-finish') {
    return {
      id,
      kind: 'step',
      text: prev?.text ?? '',
      step: {
        tokensIn: raw.tokens?.input ?? 0,
        tokensOut: raw.tokens?.output ?? 0,
        cost: raw.cost ?? 0,
      },
    };
  }
  if (type === 'tool') {
    return {
      id,
      kind: 'tool',
      text: raw.state?.title ?? raw.tool ?? 'tool',
      tool: {
        name: raw.tool ?? 'tool',
        status: raw.state?.status ?? 'running',
        // evento sem `input` (ex.: pending) não pode apagar o comando já conhecido
        input: raw.state?.input ?? prev?.tool?.input,
        output: String(raw.state?.output ?? raw.state?.error ?? ''),
      },
    };
  }
  if (type === 'subtask') {
    const agent = raw.agent ?? 'agent';
    const description = raw.description ?? '';
    return { id, kind: 'fork', text: description || agent, fork: { agent, description } };
  }
  // aviso sintético do opencode: anexo grande removido + contexto compactado. Mostra
  // um marcador conciso no lugar do parágrafo longo (senão parece que travou raciocinando).
  if (raw.metadata?.compaction_continue) {
    return {
      id,
      kind: 'text',
      text: '✂ anexo grande removido — contexto compactado; reenvie menor se precisar.',
    };
  }
  if (typeof raw.text === 'string') {
    const kind = type === 'reasoning' ? 'reasoning' : 'text';
    // no output (`text`), tira reasoning inline que o provider não separou; o part
    // `reasoning` em si (live) mantém o texto cru.
    return { id, kind, text: kind === 'text' ? stripReasoningTags(raw.text) : raw.text };
  }
  return prev ?? null;
}

/** COW: aplica um part cru a `parts` (cria/atualiza por id). `parts` intacto se ignorado. */
export function applyRawPart(parts: ChatPart[], raw: RawPart): ChatPart[] {
  if (!raw.id) return parts;
  const i = parts.findIndex((p) => p.id === raw.id);
  const next = computePart(i < 0 ? undefined : parts[i]!, raw);
  if (next === null || next === parts[i]) return parts;
  if (i < 0) return [...parts, next];
  const arr = parts.slice();
  arr[i] = next;
  return arr;
}

/** Um `message.part.delta` do motor — texto incremental de um part. */
export interface PartDelta {
  messageID: string;
  partID: string;
  /** Campo do part que o delta alimenta; só `text`/`reasoning` são renderizados. */
  field: string;
  delta: string;
}

/** `field` do delta → `kind` do part. Campo fora daqui é ignorado (snapshot cobre). */
const DELTA_KINDS: Record<string, ChatPart['kind'] | undefined> = {
  text: 'text',
  reasoning: 'reasoning',
};

/** COW: concatena `delta` no part `id`, criando-o se o delta chegou antes do snapshot. */
function appendDelta(
  parts: ChatPart[],
  id: string,
  kind: ChatPart['kind'],
  delta: string,
): ChatPart[] {
  const i = parts.findIndex((p) => p.id === id);
  if (i < 0) return [...parts, { id, kind, text: delta }];
  const arr = parts.slice();
  arr[i] = { ...parts[i]!, text: parts[i]!.text + delta };
  return arr;
}

/**
 * Aplica um lote de deltas coalescidos (ver `delta-buffer.ts`).
 *
 * Os deltas dão fluidez; a **autoridade segue sendo o snapshot**: quando
 * `message.part.updated` chega, `computePart` reescreve `text` com o valor cheio do
 * motor, então qualquer drift acumulado aqui é reconciliado sem caso especial.
 */
export function applyDeltas(prev: ChatState, deltas: readonly PartDelta[]): ChatState {
  let messages = prev.messages;
  for (const d of deltas) {
    const kind = DELTA_KINDS[d.field];
    if (!kind || !d.messageID || !d.partID || !d.delta) continue;
    messages = withMessage(
      withoutPending(messages, d.messageID),
      d.messageID,
      'assistant',
      (parts) => appendDelta(parts, d.partID, kind, d.delta),
    );
  }
  if (messages === prev.messages) return prev; // nada aplicável: não força re-render
  return { ...prev, messages };
}
