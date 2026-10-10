import type { MutableRefObject } from 'react';
import type { ChatState } from './state.js';
import type { OpencodeHandle } from './opencode.js';

interface EngineCommandCtx {
  handle: OpencodeHandle;
  sessionId: MutableRefObject<string>;
  compactingRef: MutableRefObject<boolean>;
  setChat: React.Dispatch<React.SetStateAction<ChatState>>;
  setDraft: (value: string) => void;
  draft: string;
  send: (text: string) => Promise<void>;
  cycleMode: (reverse: boolean) => void;
  toast: (message: string, variant?: 'info' | 'warning') => void;
}

/** `tui.command.execute` do motor → ação na TUI (Sprint 7.2). */
export function runEngineCommand(cmd: string, ctx: EngineCommandCtx): unknown {
  const { handle, sessionId, compactingRef, setChat, setDraft, draft, send, cycleMode, toast } =
    ctx;
  switch (cmd) {
    case 'prompt.clear':
      return setDraft('');
    case 'prompt.submit':
      return send(draft);
    case 'agent.cycle':
      return cycleMode(false);
    case 'session.interrupt':
      if (sessionId.current)
        handle.client.session.abort({ path: { id: sessionId.current } }).catch(() => {});
      return setChat((prev) => ({ ...prev, busy: false }));
    case 'session.compact':
      if (sessionId.current) {
        compactingRef.current = true; // fomos nós: o guard abaixo não pode matar
        handle.client.session.summarize({ path: { id: sessionId.current } }).catch(() => {
          compactingRef.current = false;
        });
      }
      return toast('compactando o contexto…');
    default:
      return toast(`comando do motor ignorado: ${cmd}`);
  }
}

/** Sprint 5: Tab cicla o modo do agente (build ⇄ plan ⇄ …). */
export function nextMode(modes: string[], current: string, reverse: boolean): string {
  const n = modes.length;
  if (n === 0) return current;
  const i = Math.max(0, modes.indexOf(current));
  return modes[(i + (reverse ? -1 : 1) + n) % n] ?? current;
}
