export interface ChatPart {
  id: string;
  kind: 'text' | 'reasoning' | 'tool' | 'step' | 'fork';
  /** texto (text/reasoning) ou título (tool/fork). */
  text: string;
  /** kind tool: nome, estado, args de entrada e saída. */
  tool?: {
    name: string;
    status: string;
    input?: Record<string, unknown>;
    output: string;
  };
  /** kind step: uso do passo agêntico (step-finish). */
  step?: { tokensIn: number; tokensOut: number; cost: number };
  /** kind fork: sub-agente disparado pelo modelo (part `subtask`). */
  fork?: { agent: string; description: string };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
  /** `message.info.mode` — `compaction` marca o resumo interno do opencode (ofuscado). */
  mode?: string;
  /** `message.info.summary` — `true` = mensagem-resumo (compactação), não é resposta real. */
  summary?: boolean;
}

export interface TodoItem {
  content: string;
  /** pending | in_progress | completed | cancelled */
  status: string;
}

/**
 * Um pedido de permissão do motor (Sprint 7.1). Batch paralelo = N desses — daí
 * `ChatState.permissions` ser uma **fila** (era 1 slot só, que perdia os outros
 * N-1 e travava o opencode em `busy`).
 */
export interface PermissionReq {
  id: string;
  sessionId: string;
  /** `bash` | `edit` | `read` | … | `<mcpServer>_<tool>`. */
  kind: string;
  /** Os comandos/paths exatos (cada item do pipe, no caso do bash). */
  patterns: string[];
  /** `metadata.command` — a linha de shell completa (só bash). */
  command?: string;
  /** Os globs que "sempre" salvaria (ex.: `["find *", "sort *"]`). */
  always: string[];
  title: string;
  /** epoch ms em que chegou por evento SSE — o resync não derruba o que é mais novo que o snapshot. */
  receivedAt?: number;
}

/** Uma opção de uma pergunta estruturada (tool `question` do opencode). */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** Uma pergunta do tool `question` (o modelo pergunta com opções). */
export interface QuestionItem {
  question: string;
  header?: string;
  /** `true` = múltipla escolha; senão single-select. */
  multi?: boolean;
  /**
   * `true` = o usuário pode escrever uma resposta fora das opções. Sem isso, uma
   * pergunta mal formulada vira beco sem saída — não há como dizer "nenhuma dessas".
   */
  custom?: boolean;
  options: QuestionOption[];
}

/**
 * Pedido do tool `question` (Sprint UX). Fila paralela à de permissões — o opencode
 * fica `awaiting answer` até a TUI responder via `POST /session/:id/question/:id/reply`
 * com `{ answers }`. Sem handler, o turno trava em `running` pra sempre.
 */
export interface QuestionReq {
  /** `requestID` do evento — usado no reply/reject. */
  id: string;
  sessionId: string;
  questions: QuestionItem[];
  /** idem `PermissionReq.receivedAt`. */
  receivedAt?: number;
}

/** Toast do motor (`tui.toast.show`, Sprint 7.2) — some sozinho em `until`. */
export interface Toast {
  id: string;
  message: string;
  variant: 'info' | 'success' | 'warning' | 'error';
  /** epoch ms — o App poda quando `Date.now() > until`. */
  until: number;
}

export interface ChatState {
  messages: ChatMessage[];
  busy: boolean;
  /** Fila de pedidos de permissão — mostra `[0]`, ao responder faz shift. */
  permissions: PermissionReq[];
  /** Fila de perguntas do tool `question` — mostra `[0]`, ao responder faz shift. */
  questions: QuestionReq[];
  /** Toasts efêmeros do motor (`tui.toast.show`). */
  toasts: Toast[];
  /** Lista de tarefas do modelo nesta volta (`todo.updated`). */
  todos: TodoItem[];
  /** Arquivos que o modelo editou nesta volta (`file.edited`, dedup). */
  files: string[];
  /** Tentativa em curso (rate-limit / erro transitório) — `session.status`. */
  retry: { attempt: number; note: string } | null;
  /** Último erro do motor (`session.error`) — some no próximo prompt. */
  error: { name: string; message: string; retryable: boolean } | null;
  /** Diff da volta (`session.diff`) — arquivos + linhas +/−. Some no próximo prompt. */
  diff: { file: string; added: number; removed: number }[];
}

export const emptyChat: ChatState = {
  messages: [],
  busy: false,
  permissions: [],
  questions: [],
  toasts: [],
  todos: [],
  files: [],
  retry: null,
  error: null,
  diff: [],
};
