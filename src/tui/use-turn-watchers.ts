import type { AppRefs } from './use-app-refs.js';
import React, { useEffect, useRef } from 'react';
import { shouldCompact, type ChatState } from './state.js';
import type { OpencodeHandle } from './opencode.js';
import { buildLedger, hasWorkInFlight, ledgerTotal } from './token-ledger.js';
import { NIO_AI_CONTEXT, compactionReserved } from '../lib/clients/client-configs.js';

/** O que o `App` entrega aos vigias do turno — o dono do estado continua sendo ele. */
export interface TurnWatchersCtx {
  chat: ChatState;
  handle: OpencodeHandle;
  refs: AppRefs;
  toast: (message: string, variant?: 'info' | 'warning') => void;
  recoverFromOverflow: () => Promise<void>;
  continueFromOutputLength: () => Promise<void>;
  delegateToWorker: () => Promise<void>;
}

/** Efeitos reativos do turno: recuperação de erro, delegação por intensidade e compactação proativa. */
export function useTurnWatchers(ctx: TurnWatchersCtx): void {
  const { chat, handle, toast, recoverFromOverflow, continueFromOutputLength, delegateToWorker } =
    ctx;
  const { sessionId, inFlightChars, compactingRef } = ctx.refs;
  // Monitora intensidade (tokens/s) — se dispara threshold, dispara delegação (Fase 3).
  const intensityMetricsRef = useRef({ startTime: 0, tokensSoFar: 0 });
  const recordTokens = React.useCallback((delta: number) => {
    if (intensityMetricsRef.current.startTime === 0) {
      intensityMetricsRef.current.startTime = Date.now();
    }
    intensityMetricsRef.current.tokensSoFar += delta;
  }, []);
  const shouldDelegate = React.useCallback(() => {
    const elapsed = (Date.now() - intensityMetricsRef.current.startTime) / 1000;
    if (elapsed < 1) return false;
    const tokensPerSec = intensityMetricsRef.current.tokensSoFar / elapsed;
    return tokensPerSec > 500; // INTENSITY_THRESHOLD_TOKENS_PER_SEC
  }, []);

  // Recupera sozinho: deixar o usuário reenviar só repetiria o mesmo erro.
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  useEffect(() => {
    if (chat.error?.name === 'ContextOverflowError') void recoverFromOverflow();
  }, [chat.error?.name]);

  // Continua automaticamente de resposta cortada (output length).
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  useEffect(() => {
    if (chat.error?.name === 'MessageOutputLengthError') void continueFromOutputLength();
  }, [chat.error?.name]);

  // Rastreia tokens de mensagens completadas — usado para detectar intensidade.
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  useEffect(() => {
    if (!chat.busy && chat.messages.length > 0) {
      const ultima = chat.messages[chat.messages.length - 1];
      if (ultima?.role === 'assistant') {
        for (const parte of ultima.parts) {
          if (parte.kind === 'step' && parte.step?.tokensOut) {
            recordTokens(parte.step.tokensOut);
          }
        }
      }
    }
  }, [chat.messages.length, chat.busy]);

  // Monitora intensidade — se passou do threshold, delega pro worker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  useEffect(() => {
    if (chat.busy && shouldDelegate()) {
      void delegateToWorker();
    }
  }, [chat.busy, chat.messages.length]);

  // Frente 5 — compactação proativa: quando o turno acaba (idle) e o contexto já
  // cruzou o teto menos a folga, dispara `session.summarize` AGORA (ocioso, o
  // usuário está lendo) — o próximo prompt não paga a compactação inline (a trava
  // de "demora pra continuar após estourar"). Mesma sessão, contexto vira resumo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  useEffect(() => {
    if (chat.busy || !sessionId.current) return;
    // Livro-caixa: conta a partir do ÚLTIMO RESUMO, não do início da sessão. Somar o
    // histórico inteiro faria o orçamento parecer estourado logo após compactar.
    const ledger = buildLedger(chat.messages, inFlightChars.current);
    if (hasWorkInFlight(ledger)) return; // há request em voo: não mexer na sessão
    if (!shouldCompact(ledgerTotal(ledger), NIO_AI_CONTEXT, compactionReserved())) {
      compactingRef.current = false; // abaixo do teto (pós-compactação) → re-arma
      return;
    }
    if (compactingRef.current) return; // já disparou; aguardando o motor compactar
    compactingRef.current = true;
    handle.client.session.summarize({ path: { id: sessionId.current } }).catch(() => {
      compactingRef.current = false; // falhou → re-arma pra tentar de novo
    });
    toast('compactando o contexto proativamente…');
  }, [chat.busy, chat.messages, handle]);
}
