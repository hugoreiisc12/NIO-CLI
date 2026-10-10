import type { MutableRefObject } from 'react';
import { useInput } from 'ink';
import type { ChatState } from './state.js';
import type { OpencodeHandle } from './opencode.js';

interface GlobalKeysCtx {
  chat: ChatState;
  /** Há overlay (info/run) aberto — o Esc é dele. */
  overlayUp: boolean;
  handle: OpencodeHandle;
  sessionId: MutableRefObject<string>;
  setChat: React.Dispatch<React.SetStateAction<ChatState>>;
  setShowReasoning: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Atalhos globais — inativos quando há overlay/permissão/pergunta por cima. */
export function useGlobalKeys(ctx: GlobalKeysCtx): void {
  const { chat, overlayUp, handle, sessionId, setChat, setShowReasoning } = ctx;
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'r') {
        setShowReasoning((v) => !v); // Sprint 3
        return;
      }
      if (key.escape && chat.busy && sessionId.current) {
        handle.client.session.abort({ path: { id: sessionId.current } }).catch(() => {});
        setChat((prev) => ({ ...prev, busy: false }));
      }
    },
    { isActive: !overlayUp && chat.permissions.length === 0 && chat.questions.length === 0 },
  );
}
