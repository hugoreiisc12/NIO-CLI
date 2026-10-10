/**
 * Handlers dos eventos do `opencode serve`, um por tipo. Cada um MUTA a cópia de
 * trabalho que o `applyEvent` criou — nunca o `prev` do chamador.
 */
import { isContextOverflow } from './context-recovery.js';
import type { RawPart } from './state-parts.js';
import { applyRawPart, metaFromInfo, withMessage, withoutPending } from './state-parts.js';
import { toPermissionReq, toQuestionReq } from './state-requests.js';
import { errorHint } from './state-text.js';
import type { ChatState, Toast } from './state-types.js';

type Props = Record<string, unknown>;
type Handler = (state: ChatState, p: Props) => void;

/** Teto de toasts simultâneos — o mais antigo sai. */
const MAX_TOASTS = 5;

function pushToast(state: ChatState, toast: Toast): void {
  state.toasts = [...state.toasts.slice(-(MAX_TOASTS - 1)), toast];
}

/**
 * O SDK expõe a família `question.*` e uma `question.v2.*` paralela; o motor pode
 * emitir qualquer uma. Normaliza o prefixo em vez de listar os dois conjuntos.
 */
export function normalizeEventType(type: string): string {
  return type.startsWith('question.v2.') ? type.replace('.v2.', '.') : type;
}

// `permission.asked` é o que o opencode 1.18 emite de verdade (os tipos do SDK ainda
// listam só `permission.updated`). Batch paralelo = N eventos → **empilha na fila**.
const onPermissionAsked: Handler = (state, p) => {
  const req = toPermissionReq(p);
  if (req && !state.permissions.some((x) => x.id === req.id)) {
    state.permissions = [...state.permissions, { ...req, receivedAt: Date.now() }];
  }
};

const onPermissionReplied: Handler = (state, p) => {
  const id = p.permissionID as string | undefined;
  state.permissions = id ? state.permissions.filter((x) => x.id !== id) : [];
};

// Tool `question` — mesmo padrão de fila da permissão. Sem isto o turno trava em
// `running` esperando a resposta que a TUI nunca enviava.
const onQuestionAsked: Handler = (state, p) => {
  const req = toQuestionReq(p);
  if (req && !state.questions.some((x) => x.id === req.id)) {
    state.questions = [...state.questions, { ...req, receivedAt: Date.now() }];
  }
};

// `rejected` some junto com `replied`: a pergunta saiu do ar de qualquer modo, e sem
// isto um reject externo deixava o modal órfão na fila.
const onQuestionSettled: Handler = (state, p) => {
  const id = (p.requestID ?? p.questionID) as string | undefined;
  state.questions = id ? state.questions.filter((x) => x.id !== id) : [];
};

const onMessageUpdated: Handler = (state, p) => {
  const info = (p.info ?? p) as { id?: string; role?: string; mode?: unknown; summary?: unknown };
  if (!info.id) return;
  const role = info.role === 'user' ? 'user' : 'assistant';
  state.messages = withMessage(
    withoutPending(state.messages, info.id),
    info.id,
    role,
    (parts) => parts,
    metaFromInfo(info),
  );
};

const onPartUpdated: Handler = (state, p) => {
  const raw = (p.part ?? p) as RawPart;
  if (!raw.messageID || !raw.id) return;
  state.messages = withMessage(
    withoutPending(state.messages, raw.messageID),
    raw.messageID,
    'assistant',
    (parts) => applyRawPart(parts, raw),
  );
};

const onTodoUpdated: Handler = (state, p) => {
  state.todos = ((p.todos as Array<Record<string, unknown>>) ?? []).map((t) => ({
    content: String(t.content ?? ''),
    status: String(t.status ?? 'pending'),
  }));
};

const onFileEdited: Handler = (state, p) => {
  const f = p.file as string | undefined;
  if (f && !state.files.includes(f)) state.files = [...state.files, f];
};

const TOAST_VARIANTS = ['info', 'success', 'warning', 'error'];

const onToastShow: Handler = (state, p) => {
  const t = p as { title?: string; message?: string; variant?: string; duration?: number };
  const variant = (
    TOAST_VARIANTS.includes(t.variant ?? '') ? t.variant : 'info'
  ) as Toast['variant'];
  pushToast(state, {
    id: `toast-${Date.now()}-${state.toasts.length}`,
    message: [t.title, t.message].filter(Boolean).join(' — ') || 'aviso',
    variant,
    until: Date.now() + Math.max(1500, t.duration ?? 4000),
  });
};

const onIdle: Handler = (state) => {
  state.busy = false;
  state.retry = null;
};

/**
 * Sem `name` o motor **ainda falhou**: antes, a condição exigia `err.name` e o evento
 * era descartado — o `busy` já tinha virado `false`, o spinner sumia e o turno morria em
 * silêncio. Provider OpenAI-compatível (o `nio-local`) erra fora do formato que o
 * opencode nomeia, e caía exatamente aqui.
 */
function engineError(p: Props): ChatState['error'] {
  const err = p.error as { name?: string; data?: Record<string, unknown> } | undefined;
  const data = err?.data ?? {};
  const raw = typeof data.message === 'string' ? data.message : '';
  const bruto = err?.name ?? '';
  // Estouro de janela chega ora nomeado, ora como APIError com a mensagem crua do
  // provider. Normaliza aqui pra quem trata a recuperação não repetir a heurística.
  const name = isContextOverflow(bruto, raw) ? 'ContextOverflowError' : bruto || 'EngineError';
  const useHint =
    name === 'ProviderAuthError' ||
    name === 'MessageOutputLengthError' ||
    name === 'ContextOverflowError' ||
    !raw;
  return {
    name,
    message: useHint ? errorHint(name) : raw,
    retryable: name === 'APIError' && Boolean(data.isRetryable),
  };
}

const onSessionError: Handler = (state, p) => {
  state.busy = false;
  state.retry = null;
  // `MessageAbortedError` = o usuário apertou Esc — não é erro pra mostrar.
  if ((p.error as { name?: string } | undefined)?.name === 'MessageAbortedError') return;
  state.error = engineError(p);
};

const onSessionDiff: Handler = (state, p) => {
  const files = (p.diff as Array<{ file?: string; additions?: number; deletions?: number }>) ?? [];
  state.diff = files
    .filter((d) => d.file)
    .map((d) => ({ file: String(d.file), added: d.additions ?? 0, removed: d.deletions ?? 0 }));
};

const onCompacted: Handler = (state) => {
  pushToast(state, {
    id: `toast-${Date.now()}`,
    message: '✂ contexto compactado',
    variant: 'info',
    until: Date.now() + 4000,
  });
};

const onUpdateAvailable: Handler = (state, p) => {
  pushToast(state, {
    id: `toast-${Date.now()}`,
    message: `nova versão do opencode: ${(p as { version?: string }).version ?? '?'}`,
    variant: 'info',
    until: Date.now() + 6000,
  });
};

const onSessionStatus: Handler = (state, p) => {
  const st = p.status as { type?: string; attempt?: number; message?: string } | undefined;
  if (st?.type === 'idle') {
    state.busy = false;
    state.retry = null;
  } else if (st?.type === 'busy') {
    state.busy = true;
  } else if (st?.type === 'retry') {
    state.busy = true;
    state.retry = { attempt: st.attempt ?? 1, note: st.message ?? 'tentando de novo' };
  }
};

/** Tipo (já normalizado) → handler. Tipo ausente = evento ignorado. */
export const EVENT_HANDLERS: Readonly<Record<string, Handler>> = {
  'permission.asked': onPermissionAsked,
  'permission.updated': onPermissionAsked,
  'permission.replied': onPermissionReplied,
  'question.asked': onQuestionAsked,
  'question.updated': onQuestionAsked,
  'question.replied': onQuestionSettled,
  'question.answered': onQuestionSettled,
  'question.rejected': onQuestionSettled,
  'message.updated': onMessageUpdated,
  'message.part.updated': onPartUpdated,
  'todo.updated': onTodoUpdated,
  'file.edited': onFileEdited,
  'tui.toast.show': onToastShow,
  'session.idle': onIdle,
  'session.error': onSessionError,
  'session.diff': onSessionDiff,
  'session.compacted': onCompacted,
  'installation.update-available': onUpdateAvailable,
  'session.status': onSessionStatus,
};
