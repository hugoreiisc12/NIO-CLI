/**
 * Modelo de estado da conversa + normalização dos eventos do `opencode serve`.
 * Formas confirmadas com o SDK 1.18.x (`NIO_DEBUG=1` loga o evento cru).
 *
 * Sprint 2 de UI/UX: reflete o que o motor realmente faz — não só o texto final.
 * Além dos parts de texto/raciocínio/tool, guarda: a **lista de tarefas** do
 * modelo (`todo.updated`), os **arquivos editados** (`file.edited`), a
 * **tentativa em curso** (`session.status` type `retry`) e, por part,
 * **tokens/custo** (`step-finish`) e os **args + saída** de cada tool.
 */
import type { Event } from '@opencode-ai/sdk';
import { tlog } from './debug.js';
import type { RawPart } from './state-parts.js';
import { PENDING_USER, applyRawPart, metaFromInfo, withMessage } from './state-parts.js';
import { EVENT_HANDLERS, normalizeEventType } from './state-events.js';
import type { ChatMessage, ChatState } from './state-types.js';

export * from './state-types.js';
export * from './state-requests.js';
export * from './state-text.js';
export * from './state-parts.js';
export * from './state-selectors.js';

/** Aplica um evento ao estado (o caller passa o `prev`; devolve uma cópia nova). */
export function applyEvent(prev: ChatState, evt: Event): ChatState {
  const state: ChatState = { ...prev };
  const p = (evt as { properties?: Record<string, unknown> }).properties ?? {};
  tlog('event', evt.type, p); // o cap de tamanho fica no tlog (debug.ts), não aqui
  const type = normalizeEventType(evt.type as string);
  if (Object.hasOwn(EVENT_HANDLERS, type)) EVENT_HANDLERS[type]!(state, p);
  return state;
}

/**
 * Reconstrói as mensagens a partir do `session.messages()` do server (fonte da
 * verdade). Usado no re-sync após reconexão / no poll de segurança.
 */
export function syncMessages(
  prev: ChatState,
  raw: Array<{
    info?: { id?: string; role?: string; mode?: unknown; summary?: unknown };
    parts?: Array<Record<string, unknown>>;
  }>,
  busy: boolean,
): ChatState {
  let messages: ChatMessage[] = [];
  for (const m of raw) {
    if (!m.info?.id) continue;
    const role = m.info.role === 'user' ? 'user' : 'assistant';
    const meta = metaFromInfo(m.info);
    messages = withMessage(
      messages,
      m.info.id,
      role,
      (parts) => {
        let acc = parts;
        for (const rp of m.parts ?? []) acc = applyRawPart(acc, rp as RawPart);
        return acc;
      },
      meta,
    );
  }
  // se o server ainda não listou a última pergunta, preserva o eco local
  const pending = prev.messages.find((x) => x.id === PENDING_USER);
  if (pending && !messages.some((x) => x.role === 'user' && sameText(x, pending))) {
    messages = [...messages, pending];
  }
  return { ...prev, messages, busy, retry: busy ? prev.retry : null };
}

function sameText(a: ChatMessage, b: ChatMessage): boolean {
  const t = (m: ChatMessage) =>
    m.parts
      .map((p) => p.text)
      .join('')
      .trim();
  return t(a) === t(b);
}

/** Eco imediato da mensagem do usuário + marca busy. Zera todos/arquivos da volta anterior. */
export function pushUserMessage(prev: ChatState, text: string): ChatState {
  return {
    messages: [
      ...prev.messages.filter((m) => m.id !== PENDING_USER),
      { id: PENDING_USER, role: 'user', parts: [{ id: 'p0', kind: 'text', text }] },
    ],
    busy: true,
    permissions: prev.permissions,
    questions: prev.questions,
    toasts: prev.toasts,
    todos: [],
    files: [],
    retry: null,
    error: null,
    diff: [],
  };
}

// ─── seletores pra UI (puros) ───────────────────────────────────────────────
