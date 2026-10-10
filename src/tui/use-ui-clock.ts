import { useEffect, useRef, useState } from 'react';
import type { ChatState } from './state.js';

/** Relógio do spinner: marca o início do turno e tica o frame (parado com modal aberto). */
export function useBusyClock(
  busy: boolean,
  awaitingPermission: boolean,
): { frame: number; busyStartedAt: React.MutableRefObject<number> } {
  const [frame, setFrame] = useState(0);
  const busyStartedAt = useRef<number>(0); // pro tempo decorrido no StatusLine
  useEffect(() => {
    if (busy) busyStartedAt.current = Date.now();
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    // Modal aberto: sem tick. Cada tick redesenha o Ink inteiro e, com o modal por cima
    // do live, o frame passa das linhas do terminal e o bloco do bash pisca/some.
    if (awaitingPermission) return;
    const t = setInterval(() => setFrame((f) => f + 1), 90);
    return () => clearInterval(t);
  }, [busy, awaitingPermission]);
  return { frame, busyStartedAt };
}

/** Sprint 7.2 — poda os toasts expirados (`until`) enquanto houver algum. */
export function useToastPruning(
  count: number,
  setChat: React.Dispatch<React.SetStateAction<ChatState>>,
): void {
  useEffect(() => {
    if (count === 0) return;
    const iv = setInterval(() => {
      setChat((prev) => {
        const now = Date.now();
        const kept = prev.toasts.filter((x) => x.until > now);
        return kept.length === prev.toasts.length ? prev : { ...prev, toasts: kept };
      });
    }, 700);
    return () => clearInterval(iv);
  }, [count, setChat]);
}
