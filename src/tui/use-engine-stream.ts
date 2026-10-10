import type { AppRefs } from './use-app-refs.js';
import React, { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { tlog } from './debug.js';
import {
  applyEvent,
  reconcilePendingPermissions,
  reconcilePendingQuestions,
  shouldAbortCompaction,
  syncMessages,
  toolAttempts,
  type ChatState,
} from './state.js';
import {
  fetchPendingPermissions,
  fetchPendingQuestions,
  listPrimaryAgents,
  subscribeEvents,
  type OpencodeHandle,
} from './opencode.js';
import { NIO_AI_WARMUP } from '../lib/clients/client-configs.js';
import { eventSessionId, warmPrefixCache } from './warmup.js';
import { creditLessons, learnTurn } from './learning-wire.js';
import { summarizeTurn } from './turn-summary.js';
import type { createDeltaBuffer } from './delta-buffer.js';
import type { useTurnTask } from './use-turn-task.js';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
type Ref<T> = MutableRefObject<T>;

/** Estado e refs do `App` de que o stream precisa — o dono continua sendo o `App`. */
export interface EngineStreamCtx {
  handle: OpencodeHandle;
  refs: AppRefs;
  cwd: string;
  splash: boolean;
  model?: { providerID: string; modelID: string };
  mode: string;
  session: { name: string; profile: string; id: string } | null;
  chatRef: Ref<ChatState>;
  setChat: Setter<ChatState>;
  setDraft: Setter<string>;
  setModes: Setter<string[]>;
  setMode: Setter<string>;
  setReady: Setter<boolean>;
  deltas: Ref<ReturnType<typeof createDeltaBuffer>>;
  turnTask: ReturnType<typeof useTurnTask>;
}

/** Sessão do motor + stream de eventos (reconecta pra sempre) + resync com o server. */
export function useEngineStream(ctx: EngineStreamCtx): { resync: () => Promise<void> } {
  const {
    handle,
    cwd,
    splash,
    model,
    mode,
    session,
    chatRef,
    setChat,
    setDraft,
    setModes,
    setMode,
    setReady,
    deltas,
    turnTask,
  } = ctx;
  const {
    sessionId,
    abortRef,
    userTurnActive,
    warmupSessionId,
    injectedLessons,
    attemptsAtSend,
    inFlightChars,
    settledPerms,
    settledQuestions,
    tuiCommandRef,
    compactingRef,
  } = ctx.refs;
  const resync = React.useCallback(async () => {
    const id = sessionId.current;
    if (!id) return;
    const snapshotAt = Date.now(); // antes dos fetches: SSE posterior a isto não é apagado
    try {
      const [st, msgs, perms, ques] = await Promise.all([
        handle.client.session.status(),
        handle.client.session.messages({ path: { id } }),
        fetchPendingPermissions(handle.url),
        fetchPendingQuestions(handle.url),
      ]);
      const status = (st as { data?: Record<string, { type?: string }> }).data?.[id]?.type;
      const busy = status === 'busy' || status === 'retry';
      const raw = ((msgs as { data?: unknown[] }).data ?? []) as Parameters<typeof syncMessages>[1];
      setChat((prev) =>
        reconcilePendingQuestions(
          reconcilePendingPermissions(
            syncMessages(prev, raw, busy),
            perms,
            settledPerms.current,
            snapshotAt,
          ),
          ques,
          settledQuestions.current,
          snapshotAt,
        ),
      );
    } catch (err) {
      tlog('resync falhou', (err as Error).message);
    }
  }, [handle, sessionId, settledPerms, settledQuestions, setChat]);

  // sessão + stream de eventos (reconecta pra sempre)
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  useEffect(() => {
    if (splash) return;
    let alive = true;
    const ac = abortRef.current;
    (async () => {
      try {
        const created = await handle.client.session.create({
          body: { title: cwd.split('/').pop() ?? 'nio' },
        });
        sessionId.current = (created as { data?: { id?: string } }).data?.id ?? '';
        const agents = await listPrimaryAgents(handle.client);
        setModes(agents);
        setMode((cur) => (agents.includes(cur) ? cur : (agents[0] ?? 'build')));
      } catch (err) {
        tlog('falha ao criar sessão', (err as Error).message);
      }
      setReady(true);
      // Aquece o prefixo ENQUANTO a pessoa digita: paga o prefill de ~21k tokens numa
      // sessão descartável pra a 1ª request real cair no cache (medido: 31s → ~1,6s).
      if (model && NIO_AI_WARMUP) {
        void warmPrefixCache({
          client: handle.client,
          model,
          agent: mode,
          onSession: (id) => {
            warmupSessionId.current = id;
          },
        }).then((ok) => tlog('aquecimento', ok ? 'ok' : 'falhou'));
      }
      for await (const evt of subscribeEvents(handle.client, ac.signal)) {
        if (!alive) break;
        if (evt === null) {
          void resync(); // (re)conectou → re-sincroniza
          continue;
        }
        const et = evt.type as string;
        if (et === 'message.part.delta') {
          // Antes: descartado, e o texto andava só nos 7 snapshots da resposta. O
          // buffer dá a fluidez de token sem pagar um redraw do Ink por delta.
          const d = (evt as { properties?: Record<string, unknown> }).properties ?? {};
          if (warmupSessionId.current && eventSessionId(d) === warmupSessionId.current) continue;
          deltas.current.push({
            messageID: String(d.messageID ?? ''),
            partID: String(d.partID ?? ''),
            field: String(d.field ?? ''),
            delta: String(d.delta ?? ''),
          });
          continue;
        }
        // Qualquer outro evento pode mudar o mesmo part que os deltas estão montando:
        // esvazia antes, pra o snapshot reconciliar em cima do texto já aplicado.
        deltas.current.flushNow();
        // Sprint — "respondeu = parou": o turno do usuário fecha no idle; se o motor
        // emenda OUTRO turno (compactação/continuação) sem prompt novo, encerra e fica idle.
        const props = (evt as { properties?: Record<string, unknown> }).properties ?? {};
        // O aquecimento roda numa sessão própria; `applyEvent` não filtra por sessão,
        // então sem isto a resposta descartável dele apareceria no chat do usuário.
        if (warmupSessionId.current && eventSessionId(props) === warmupSessionId.current) continue;
        const stType = (props.status as { type?: string } | undefined)?.type;
        if (et === 'session.idle' || (et === 'session.status' && stType === 'idle')) {
          userTurnActive.current = false;
          // Turno fechado: o que errou e depois acertou vira lição. Assíncrono e
          // silencioso — aprender não pode atrasar nem derrubar a interface.
          void learnTurn(chatRef.current.messages, session?.profile);
          turnTask.end(summarizeTurn(chatRef.current.messages));
          // Credita as lições do prompt que acabou de fechar, olhando só o que veio
          // depois dele — e zera, pra não creditar duas vezes no próximo idle.
          if (injectedLessons.current.length > 0) {
            const novas = toolAttempts(chatRef.current.messages).slice(attemptsAtSend.current);
            void creditLessons(injectedLessons.current, novas);
            injectedLessons.current = [];
          }
        }
        const info = (props.info ?? props) as { mode?: string };
        // emenda não-solicitada = compactação/resumo que o motor dispara sozinho após
        // a resposta (o modelo não inicia turno novo por conta própria fora disso).
        if (
          et === 'message.updated' &&
          info.mode === 'compaction' &&
          shouldAbortCompaction({
            userTurnActive: userTurnActive.current,
            requestedByTui: compactingRef.current,
            workInFlight: inFlightChars.current > 0,
          })
        ) {
          if (sessionId.current)
            handle.client.session.abort({ path: { id: sessionId.current } }).catch(() => {});
          setChat((prev) => ({ ...prev, busy: false }));
          continue;
        }
        // Sprint 7.2 — o motor dirige a TUI (imperativo, fora do ChatState):
        if (et === 'tui.prompt.append') {
          const text = (evt as { properties?: { text?: string } }).properties?.text ?? '';
          if (text) setDraft((d) => (d ? `${d} ${text}` : text));
          continue;
        }
        if (et === 'tui.command.execute') {
          const cmd = (evt as { properties?: { command?: string } }).properties?.command ?? '';
          tuiCommandRef.current(cmd);
          continue;
        }
        setChat((prev) => applyEvent(prev, evt));
      }
    })();
    return () => {
      alive = false;
      ac.abort();
      deltas.current.stop();
    };
  }, [splash, handle, cwd, resync]);

  return { resync };
}
