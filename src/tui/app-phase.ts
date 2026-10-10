import { permGroupLabel, type ChatMessage, type ChatState } from './state.js';

/** Fase atual do motor, em português, pro `StatusLine`. */
export function phaseLabel(chat: ChatState, live: ChatMessage | null): string {
  if (chat.retry) return `tentando de novo (${chat.retry.attempt})`;
  // O motor deixa o tool `running` enquanto espera o humano: sem isto o status mente.
  const waiting = chat.permissions[0];
  if (waiting) return `aguardando autorização · ${permGroupLabel(waiting.kind)}`;
  const parts = live?.parts ?? [];
  const tool = parts.find(
    (p) => p.kind === 'tool' && (p.tool?.status === 'running' || p.tool?.status === 'pending'),
  );
  if (tool) return `executando ${tool.tool?.name ?? tool.text}`;
  const hasText = parts.some((p) => p.kind === 'text' && p.text.trim());
  const hasReasoning = parts.some((p) => p.kind === 'reasoning' && p.text.trim());
  if (hasText) return 'escrevendo';
  if (hasReasoning) return 'raciocinando';
  return 'pensando';
}
