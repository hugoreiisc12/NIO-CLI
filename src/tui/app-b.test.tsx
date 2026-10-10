import { test, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import { waitForFrame, waitForText } from './test-utils.js';
import { App } from './app.js';
import { buildProgram } from '../cli/program.js';
import { fakeHandle } from './app.test-helpers.js';

test('App: batch de 3 permissões → modal 1/3 → 2/3 → 3/3, cada resposta faz POST (Sprint 7.1)', async () => {
  const posted: string[] = [];
  const stream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    for (const id of ['pA', 'pB', 'pC']) {
      yield {
        type: 'permission.asked',
        properties: {
          id,
          sessionID: 'ses_fake',
          permission: 'bash',
          metadata: { command: `echo ${id}` },
        },
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  })();
  const h = fakeHandle();
  (
    h.client as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncGenerator }> };
      postSessionIdPermissionsPermissionId: (o: {
        path: { permissionID: string };
      }) => Promise<unknown>;
    }
  ).event.subscribe = async () => ({ stream });
  (
    h.client as unknown as {
      postSessionIdPermissionsPermissionId: (o: {
        path: { permissionID: string };
      }) => Promise<unknown>;
    }
  ).postSessionIdPermissionsPermissionId = async (o) => {
    posted.push(o.path.permissionID);
    return {};
  };

  const { lastFrame, stdin, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(lastFrame() ?? '').toContain('+2 na fila');
  expect(lastFrame() ?? '').toContain('echo pA');

  stdin.write('a'); // permitir
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame() ?? '').toContain('+1 na fila');
  expect(lastFrame() ?? '').toContain('echo pB');

  stdin.write('\x1b'); // Esc → negar/pular (único jeito, Item 6)
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame() ?? '').toContain('echo pC');
  expect(lastFrame() ?? '').not.toContain('na fila'); // último — sem contador

  stdin.write('a');
  await new Promise((r) => setTimeout(r, 30));
  expect(posted).toEqual(['pA', 'pB', 'pC']); // as 3 respondidas, nenhuma órfã
  unmount();
});

test('App: eventos tui.* — toast, prompt.append, command.execute (Sprint 7.2)', async () => {
  const gate = { resume: () => {} };
  const wait = () =>
    new Promise<void>((r) => {
      gate.resume = r;
    });
  const stream = (async function* () {
    yield {
      type: 'tui.toast.show',
      properties: { message: 'skill carregada', variant: 'success', duration: 9999 },
    };
    await wait();
    yield { type: 'tui.prompt.append', properties: { text: 'nio deps check' } };
    await wait();
    yield { type: 'tui.command.execute', properties: { command: 'agent.cycle' } };
    await wait();
    yield { type: 'tui.command.execute', properties: { command: 'prompt.clear' } };
    await new Promise((r) => setTimeout(r, 500));
  })();
  const h = fakeHandle({
    agents: [
      { name: 'build', mode: 'primary' },
      { name: 'plan', mode: 'primary' },
    ],
  });
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream });

  const { lastFrame, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await waitForText(lastFrame, ['skill carregada', '[build]']);

  gate.resume();
  await waitForText(lastFrame, 'nio deps check'); // prompt.append injetou no input

  gate.resume();
  await waitForText(lastFrame, '[plan]'); // agent.cycle rodou

  gate.resume();
  await waitForFrame(lastFrame, (f) => !f.includes('nio deps check')); // prompt.clear limpou
  unmount();
});

test('App: pergunta com opções → menu navegável; ↓+Enter manda a opção 2 (Sprint 7.6)', async () => {
  let sent: string | undefined;
  const stream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'text',
          text: 'Por onde começo?\n1. Pelo core\n2. Pelos adapters\n3. Pelos testes',
          messageID: 'm1',
          id: 't1',
        },
      },
    };
    yield { type: 'session.idle', properties: { sessionID: 'ses_fake' } };
    await new Promise((r) => setTimeout(r, 300));
  })();
  const h = fakeHandle({
    onPrompt: (b) => {
      sent = (b as { parts: { text: string }[] }).parts[0].text;
    },
  });
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream });

  const { lastFrame, stdin, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 60));
  const f = lastFrame() ?? '';
  expect(f).toContain('1. Pelo core');
  expect(f).toContain('2. Pelos adapters');
  expect(f).toContain('↑↓ escolher');

  stdin.write('\x1b[B'); // ↓ → seleciona opção 2
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r'); // Enter
  await new Promise((r) => setTimeout(r, 40));
  // o thinking é desligado no provider (extraBody), não mais por sufixo textual — o fio vai limpo.
  expect(sent).toBe('Pelos adapters');
  expect(lastFrame() ?? '').toContain('Pelos adapters');
  expect(lastFrame() ?? '').not.toContain('/no_think');
  unmount();
});

test('App: session.diff → resumo "✎ N arquivo(s)" (Sprint 7.8)', async () => {
  const stream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    yield {
      type: 'session.diff',
      properties: {
        sessionID: 'ses_fake',
        diff: [
          { file: 'src/gateway/services/security.ts', additions: 18, deletions: 4 },
          { file: 'src/adapters/messaging/smtp.ts', additions: 42, deletions: 0 },
        ],
      },
    };
    await new Promise((r) => setTimeout(r, 200));
  })();
  const h = fakeHandle();
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream });

  const { lastFrame, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 80));
  const f = lastFrame() ?? '';
  expect(f).toContain('✎ 2 arquivo(s)');
  expect(f).toContain('security.ts +18 −4');
  expect(f).toContain('smtp.ts +42');
  unmount();
});
