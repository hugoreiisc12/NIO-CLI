import type { AppRefs } from './use-app-refs.js';
import { tlog } from './debug.js';
import { replyErrorDetail, replyFailed, type ChatState } from './state.js';
import type { OpencodeHandle } from './opencode.js';

/** O que o `App` entrega pra responder permissões e perguntas do motor. */
export interface EngineRepliesCtx {
  chat: ChatState;
  handle: OpencodeHandle;
  refs: AppRefs;
  setChat: React.Dispatch<React.SetStateAction<ChatState>>;
  resync: () => Promise<void>;
}

export interface EngineReplies {
  respondPermission: (r: 'once' | 'always' | 'reject') => void;
  settleQuestion: (path: 'reply' | 'reject', answers?: string[][]) => void;
}

/** Responde o 1º da fila de permissões/perguntas e faz shift; tombstone evita o modal ressuscitar. */
export function useEngineReplies(ctx: EngineRepliesCtx): EngineReplies {
  const { chat, handle, setChat, resync } = ctx;
  const { settledPerms, settledQuestions } = ctx.refs;
  // Sprint 7.1: responde o 1º da FILA e faz shift — os outros N-1 do batch
  // paralelo aparecem em sequência (antes: só 1 slot, o resto ficava órfão e
  // o opencode travava em `busy`).
  const respondPermission = (r: 'once' | 'always' | 'reject') => {
    const perm = chat.permissions[0];
    if (!perm) return;
    settledPerms.current.add(perm.id);
    setChat((prev) => ({ ...prev, permissions: prev.permissions.slice(1) }));
    /** Não respondeu de fato: solta o tombstone para o pedido voltar e ser refeito. */
    const desfazer = (motivo: string, detalhe: string): void => {
      settledPerms.current.delete(perm.id);
      tlog('permission respond', motivo, detalhe);
    };
    handle.client
      .postSessionIdPermissionsPermissionId({
        path: { id: perm.sessionId, permissionID: perm.id },
        body: { response: r },
      })
      .then((res) => {
        // O client do opencode só lança em erro de rede — um 4xx chega aqui numa
        // promessa cumprida, como `{ error }`. Sem esta checagem o tombstone
        // ficaria preso: o modal sumiria sem decisão e o motor esperaria para sempre.
        if (replyFailed(res)) desfazer('recusado', replyErrorDetail(res));
      })
      .catch((err) => desfazer('falhou', (err as Error).message))
      .finally(() => {
        void resync();
      });
  };

  // Tool `question` — responde/rejeita via REST (`/session/:id/question/:id/reply|reject`,
  // o SDK não tipa) e faz shift na fila. Sem isto o turno trava em `running`.
  const settleQuestion = (path: 'reply' | 'reject', answers?: string[][]) => {
    const q = chat.questions[0];
    if (!q) return;
    settledQuestions.current.add(q.id);
    setChat((prev) => ({ ...prev, questions: prev.questions.slice(1) }));
    /** Não respondeu de fato: solta o tombstone para a pergunta voltar e ser refeita. */
    const desfazer = (motivo: string, detalhe: string): void => {
      settledQuestions.current.delete(q.id);
      tlog('question respond', motivo, detalhe);
    };
    fetch(new URL(`/session/${q.sessionId}/question/${q.id}/${path}`, handle.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: answers ? JSON.stringify({ answers }) : undefined,
    })
      .then(async (res) => {
        // `fetch` só rejeita em erro de rede — um 4xx chegaria aqui como sucesso,
        // a pergunta voltaria no resync e não haveria uma linha sobre o motivo.
        if (replyFailed(res))
          desfazer(
            `recusado ${(res as Response).status}`,
            (await res.text().catch(() => '')).slice(0, 200),
          );
      })
      .catch((err) => desfazer('falhou', (err as Error).message))
      .finally(() => void resync());
  };

  return { respondPermission, settleQuestion };
}
