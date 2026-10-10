import type { AppRefs } from './use-app-refs.js';
import type { FilePartInput } from '@opencode-ai/sdk';
import { tlog } from './debug.js';
import { pushUserMessage, toolAttempts, failedTools, type ChatState } from './state.js';
import type { OpencodeHandle } from './opencode.js';
import type { useIdentity } from './identity-reveal.js';
import { expandPastes } from './pasted-text.js';
import type { useTurnTask } from './use-turn-task.js';
import { buildAttachedInput } from './attachments.js';
import { remindLessons } from './learning-wire.js';
import { compactInput } from '../lib/exec/map-reduce.js';
import { buildHandoffDigest } from './context-recovery.js';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

/** Estado e refs do `App` de que as ações precisam — o dono continua sendo o `App`. */
export interface TurnActionsCtx {
  handle: OpencodeHandle;
  refs: AppRefs;
  cwd: string;
  model?: { providerID: string; modelID: string };
  mode: string;
  chat: ChatState;
  identity: ReturnType<typeof useIdentity>;
  setChat: Setter<ChatState>;
  setDraft: Setter<string>;
  turnTask: ReturnType<typeof useTurnTask>;
  toast: (message: string, variant?: 'info' | 'warning') => void;
}

export interface TurnActions {
  send: (text: string) => Promise<void>;
  recoverFromOverflow: () => Promise<void>;
  delegateToWorker: () => Promise<void>;
  continueFromOutputLength: () => Promise<void>;
}

/** Envio do prompt e recuperações automáticas do turno (overflow, corte de saída, delegação). */
export function useTurnActions(ctx: TurnActionsCtx): TurnActions {
  const { handle, cwd, model, mode, chat, identity, setChat, setDraft, turnTask, toast } = ctx;
  const { pastes, sessionId, userTurnActive, attemptsAtSend, injectedLessons, inFlightChars } =
    ctx.refs;
  const send = async (text: string) => {
    if (!sessionId.current) return;
    setDraft('');
    if (identity.tryStart(text)) return;
    const pasted = pastes.current.take(); // tokens `[Pasted text #n]` do rascunho → conteúdo real
    userTurnActive.current = true; // este turno foi pedido pelo usuário → não abortar
    setChat((prev) => pushUserMessage(prev, text)); // eco mostra o texto ORIGINAL
    turnTask.begin(text); // registra o turno com o texto do usuário, não o enriquecido
    // Anexos: embute o conteúdo dos arquivos (csv/txt/xlsx) no texto e coleta parts de
    // imagem (Item 4b). Falha → segue com o texto cru.
    let enriched = text;
    let fileParts: FilePartInput[] = [];
    try {
      const built = await buildAttachedInput(text);
      enriched = built.text;
      fileParts = built.fileParts;
    } catch (err) {
      tlog('buildAttachedInput falhou, texto cru', (err as Error).message);
    }
    // Lição das tools que já falharam NESTA sessão — o filtro por tool é o que impede
    // a lição de uma ferramenta de contaminar outra (similaridade sozinha não separa).
    try {
      attemptsAtSend.current = toolAttempts(chat.messages).length;
      const pista = await remindLessons(failedTools(chat.messages), text);
      injectedLessons.current = pista.injected;
      if (pista.text)
        enriched = `${pista.text}

${enriched}`;
    } catch (err) {
      tlog('recall de lições falhou', (err as Error).message);
    }
    // Map-reduce: input grande é compactado (lossy) antes de enviar; erro → manda cru.
    // As colagens voltam só aqui: o eco, o registro do turno e a busca de anexos/lições
    // acima trabalham com o token curto, não com o texto colado.
    enriched = expandPastes(enriched, pasted);
    let payload = enriched;
    try {
      payload = await compactInput(enriched, {
        onProgress: (n) => toast(`compactando input · ${n} trecho(s)`),
      });
    } catch (err) {
      tlog('compactInput falhou, enviando cru', (err as Error).message);
    }
    // Sem o antigo sufixo `/no_think` (poluía o contexto). O reasoning do Qwen não é
    // suprimível via config do opencode (ver client-configs) — a Camada B não o mostra no output.
    inFlightChars.current = payload.length; // em voo até a resposta (ou o erro) voltar
    handle.client.session
      .prompt({
        path: { id: sessionId.current },
        body: { model, agent: mode, parts: [...fileParts, { type: 'text', text: payload }] },
      })
      .catch((err) => tlog('prompt falhou', (err as Error).message))
      .finally(() => {
        inFlightChars.current = 0;
      }); // voltou (ou falhou): nada pendente
  };

  /**
   * Janela estourada: cria uma sessão nova e semeia com um resumo montado LOCALMENTE.
   *
   * Não dá pra usar o `session.summarize` aqui — é ele que estoura, porque reenvia o
   * histórico inteiro pro modelo resumir. Era isso que deixava a sessão morta: a
   * recuperação falhava pelo mesmo motivo do erro original, em toda request seguinte.
   */
  const recoverFromOverflow = async () => {
    const digest = buildHandoffDigest(chat.messages);
    try {
      const created = await handle.client.session.create({
        body: { title: `${cwd.split('/').pop() ?? 'nio'} (cont.)` },
      });
      const novaId = (created as { data?: { id?: string } }).data?.id ?? '';
      if (!novaId) throw new Error('sessão nova sem id');
      sessionId.current = novaId;
      setChat((prev) => ({ ...prev, error: null, busy: false }));
      toast('janela zerada — sessão nova com o resumo da anterior');
      if (digest) {
        await handle.client.session.prompt({
          path: { id: novaId },
          body: { model, agent: mode, parts: [{ type: 'text', text: digest }] },
        });
      }
    } catch (err) {
      tlog('recuperação do overflow falhou', (err as Error).message);
      toast('não consegui zerar a janela — saia e entre de novo', 'warning');
    }
  };

  /**
   * Delegação de request intensa ao worker: persistir checkpoint, parar execução local
   * e deixar o worker retomar duramente. Sem criar sessão nova (sessão já existe e
   * será re-attached pelo worker).
   */
  const delegateToWorker = async () => {
    const taskId = turnTask.currentTaskId();
    if (!taskId || !sessionId.current) return;
    try {
      // Persiste ANTES de parar o motor local: se a delegação falhar, a TUI
      // segue executando em vez de deixar o turno sem dono.
      if (!(await turnTask.delegate(sessionId.current))) {
        toast('não consegui delegar pro background — seguindo local', 'warning');
        return;
      }
      setChat((prev) => ({ ...prev, busy: false }));
      toast(
        `delegando pro background… rodando via nio-worker\n\nAcompanhe com:\nnio task show ${taskId.slice(0, 8)}`,
      );
      await handle.client.session.abort({ path: { id: sessionId.current } }).catch(() => {});
    } catch (err) {
      tlog('delegação falhou', (err as Error).message);
      toast('não consegui delegar pro background — tente de novo', 'warning');
    }
  };

  /**
   * Resposta cortada: envia automaticamente um prompt de continuação MESMA SESSÃO.
   * Não precisa de sessão nova — o problema é UMA geração passando do teto de output,
   * não o histórico inteiro. Recuperação transparente: o usuário não vê.
   */
  const continueFromOutputLength = async () => {
    const promptContinuar =
      'Sua resposta anterior foi cortada por exceder o teto de tokens de saída. ' +
      'Continue EXATAMENTE de onde parou, sem repetir o que já foi dito.';
    try {
      setChat((prev) => ({ ...prev, error: null, busy: false }));
      toast('continuando a resposta cortada…');
      await handle.client.session.prompt({
        path: { id: sessionId.current },
        body: { model, agent: mode, parts: [{ type: 'text', text: promptContinuar }] },
      });
    } catch (err) {
      tlog('recuperação de output length falhou', (err as Error).message);
      toast('não consegui continuar a resposta — tente de novo', 'warning');
    }
  };

  return { send, recoverFromOverflow, delegateToWorker, continueFromOutputLength };
}
