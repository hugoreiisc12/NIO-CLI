import { useMemo } from 'react';
import type { MutableRefObject } from 'react';
import { detectPaths } from './attachments.js';
import { phaseLabel } from './app-phase.js';
import {
  contextUsage,
  pendingQuestion,
  questionOptions,
  type ChatMessage,
  type ChatState,
} from './state.js';

export interface ChatView {
  finished: ChatMessage[];
  live: ChatMessage | null;
  phase: string;
  elapsed: number;
  question: string | null;
  options: string[];
  usage: { tokensIn: number; tokensOut: number };
  attachLabels: string[];
}

/** Valores derivados do estado da conversa que a tela precisa, memoizados. */
export function useChatView(
  chat: ChatState,
  draft: string,
  busyStartedAt: MutableRefObject<number>,
): ChatView {
  // histórico (Static) vs. a última mensagem se estiver streamando
  const { finished, live } = useMemo(() => {
    const msgs = chat.messages;
    const lastIsLive = chat.busy && msgs.length > 0 && msgs[msgs.length - 1]!.role === 'assistant';
    return {
      finished: lastIsLive ? msgs.slice(0, -1) : msgs,
      live: lastIsLive ? msgs[msgs.length - 1]! : null,
    };
  }, [chat.messages, chat.busy]);

  // fase atual (reflete o que o opencode está fazendo) — mostrada no StatusLine
  const phase = useMemo(() => phaseLabel(chat, live), [live, chat]);
  // tempo decorrido (o frame do spinner força o re-render ~11×/s enquanto busy)
  const elapsed = chat.busy
    ? Math.max(0, Math.floor((Date.now() - busyStartedAt.current) / 1000))
    : 0;
  // Sprint 7.4/7.6 — o nio terminou com uma pergunta (e às vezes opções)
  const question = useMemo(() => pendingQuestion(chat), [chat]);
  const options = useMemo(() => questionOptions(chat), [chat]);
  // uso da janela de contexto do último turno (input de pico + output gerado), pra
  // o rodapé medir o gasto contra a janela do provider. Só muda no `step-finish`;
  // recalcular a cada frame do spinner era desperdício (o tick não muda as mensagens).
  const usage = useMemo(() => contextUsage(chat.messages), [chat.messages]);
  // Item 4 — arquivos detectados no rascunho (chips acima do input). fs-based, mas
  // barato e memoizado no draft (só alguns tokens por vez).
  const attachLabels = useMemo(
    () => detectPaths(draft).map((d) => `${d.path.split(/[\\/]/).pop() ?? d.path} [${d.kind}]`),
    [draft],
  );
  return { finished, live, phase, elapsed, question, options, usage, attachLabels };
}
