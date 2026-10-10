import type { OpencodeHandle } from './opencode.js';

/** Handle fake — session.create resolve, event stream não emite nada por padrão. */
export function fakeHandle(
  over: { onPrompt?: (body: unknown) => void; onAbort?: () => void; agents?: unknown[] } = {},
): OpencodeHandle {
  const client = {
    session: {
      create: async () => ({ data: { id: 'ses_fake' } }),
      abort: async () => {
        over.onAbort?.();
        return {};
      },
      prompt: async (opts: { body?: unknown }) => {
        over.onPrompt?.(opts.body);
        return {};
      },
    },
    app: {
      agents: async () => ({
        data: over.agents ?? [
          { name: 'build', mode: 'primary' },
          { name: 'plan', mode: 'primary' },
        ],
      }),
    },
    event: {
      subscribe: async () => ({ stream: (async function* () {})() }),
    },
    postSessionIdPermissionsPermissionId: async () => ({}),
  };
  return {
    client: client as unknown as OpencodeHandle['client'],
    url: 'http://127.0.0.1:4096',
    close: () => {},
  };
}

/** Handle com stream controlável + espião de abort/summarize. */
export function handleComStream(eventos: unknown[]) {
  const espiao = { aborts: 0, summarizes: 0 };
  const client = {
    session: {
      create: async () => ({ data: { id: 'ses_fake' } }),
      abort: async () => {
        espiao.aborts += 1;
        return {};
      },
      prompt: async () => ({}),
      summarize: async () => {
        espiao.summarizes += 1;
        return {};
      },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      delete: async () => ({}),
    },
    app: { agents: async () => ({ data: [{ name: 'build', mode: 'primary' }] }) },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          await new Promise((r) => setTimeout(r, 30));
          for (const e of eventos) {
            yield e;
            await new Promise((r) => setTimeout(r, 10));
          }
          await new Promise((r) => setTimeout(r, 400));
        })(),
      }),
    },
    postSessionIdPermissionsPermissionId: async () => ({}),
  };
  const handle = {
    client: client as unknown as OpencodeHandle['client'],
    url: 'http://127.0.0.1:4096',
    close: () => {},
  };
  return { handle, espiao };
}
