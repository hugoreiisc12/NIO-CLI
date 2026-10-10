import { useRef } from 'react';
import { createPasteStore } from './pasted-text.js';
import type { InjectedLesson } from '../app/lesson-outcome.js';

/** Refs mutáveis do `App` que não dependem de estado — agrupadas só pra enxugar o componente. */
export function useAppRefs() {
  return {
    /** Colagens grandes compactadas no input; expandem no `send`. */
    pastes: useRef(createPasteStore()),
    sessionId: useRef<string>(''),
    abortRef: useRef(new AbortController()),
    /** Sprint 7.2 — closures frescas pro `tui.command.execute` do motor. */
    tuiCommandRef: useRef<(cmd: string) => void>(() => {}),
    /** Turno em curso foi pedido pelo usuário? (senão = compactação/emenda → aborta) */
    userTurnActive: useRef(false),
    /**
     * Lições injetadas no prompt atual + quantas tentativas já existiam quando ele saiu:
     * o crédito só olha o que aconteceu DEPOIS da injeção.
     */
    injectedLessons: useRef<InjectedLesson[]>([]),
    attemptsAtSend: useRef(0),
    /** Chars do prompt em voo — vira o `pending` do livro-caixa. 0 = nada pendente. */
    inFlightChars: useRef(0),
    /** Sessão descartável do aquecimento — eventos dela são ignorados. */
    warmupSessionId: useRef(''),
    /** Frente 5 — já disparou a compactação proativa? (evita duplicar) */
    compactingRef: useRef(false),
    /**
     * Ids já respondidos, aguardando o servidor refletir. Sem isto o `resync` logo
     * depois da resposta relista o pedido e o modal ressuscita. Separados por domínio
     * para não depender de ids de permissão e de pergunta nunca coincidirem.
     */
    settledPerms: useRef<Set<string>>(new Set()),
    settledQuestions: useRef<Set<string>>(new Set()),
  };
}

export type AppRefs = ReturnType<typeof useAppRefs>;
