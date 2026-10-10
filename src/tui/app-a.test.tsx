import { test, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import { App } from './app.js';
import { buildProgram } from '../cli/program.js';
import { fakeHandle } from './app.test-helpers.js';

test('App: pula o splash → mostra o input e o rodapé (sem sidebar — Sprint 4)', async () => {
  const { lastFrame, unmount } = render(
    <App
      handle={fakeHandle()}
      program={buildProgram()}
      cwd="/tmp/proj"
      session={{ name: 'demo', profile: 'dba', id: 'aaaa1111bb' }}
      splashMs={0}
    />,
  );
  await new Promise((r) => setTimeout(r, 20));
  const f = lastFrame() ?? '';
  expect(f).toContain('›'); // input
  expect(f).toContain('big-pickle'); // rodapé: modelo
  expect(f).toContain('demo · dba'); // rodapé: sessão
  expect(f).toContain('paleta'); // rodapé: atalhos
  expect(f).not.toContain('Sessão'); // a sidebar sumiu
  unmount();
});

test('App: Tab cicla o modo do agente e o prompt vai com o `agent` escolhido — Sprint 5', async () => {
  let sentBody: Record<string, unknown> | undefined;
  const h = fakeHandle({
    onPrompt: (b) => {
      sentBody = b as Record<string, unknown>;
    },
    agents: [
      { name: 'build', mode: 'primary' },
      { name: 'plan', mode: 'primary' },
      { name: 'reviewer', mode: 'subagent' },
    ],
  });
  const { lastFrame, stdin, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 40));
  expect(lastFrame() ?? '').toContain('[build]'); // pill no rodapé, modo default

  stdin.write('\t'); // Tab → próximo modo
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame() ?? '').toContain('[plan]');
  expect(lastFrame() ?? '').not.toContain('[reviewer]'); // subagent não entra no ciclo

  stdin.write('\t'); // volta pro build (ciclo)
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame() ?? '').toContain('[build]');

  stdin.write('\t'); // plan de novo
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('faça o plano');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r'); // Enter separado (evita virar paste)
  await new Promise((r) => setTimeout(r, 40));
  expect(sentBody?.agent).toBe('plan');
  unmount();
});

test('App: splash mostra o wordmark do operador', () => {
  const { lastFrame, unmount } = render(
    <App
      handle={fakeHandle()}
      program={buildProgram()}
      cwd="/tmp/p"
      session={null}
      splashMs={5000}
    />,
  );
  expect(lastFrame() ?? '').toContain('operador NIO');
  unmount();
});

test('App: rascunho do input sobrevive a um overlay (permissão) — Sprint 6', async () => {
  const stream = (async function* () {
    // segura o stream aberto; a gente empurra o evento de permissão via delay
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    await new Promise((r) => setTimeout(r, 40));
    yield {
      type: 'permission.asked',
      properties: {
        id: 'perm1',
        sessionID: 'ses_fake',
        permission: 'bash',
        patterns: ['rm -rf build'],
        metadata: { command: 'rm -rf build' },
      },
    };
    await new Promise((r) => setTimeout(r, 200));
  })();
  const h = fakeHandle();
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream });

  const { lastFrame, stdin, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 15));
  stdin.write('meu rascunho pendente');
  await new Promise((r) => setTimeout(r, 20));
  expect(lastFrame() ?? '').toContain('meu rascunho pendente');

  await new Promise((r) => setTimeout(r, 60)); // deixa o permission.asked chegar
  const f = lastFrame() ?? '';
  expect(f).toContain('permissão'); // o modal apareceu
  expect(f).toContain('rm -rf build'); // mostra o comando
  expect(f).toContain('aguardando autorização'); // e não "executando bash" enquanto espera o humano
  expect(f).toContain('meu rascunho pendente'); // e o rascunho continua lá

  stdin.write('a'); // responde "permitir uma vez"
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame() ?? '').toContain('meu rascunho pendente'); // ainda lá após fechar o modal
  unmount();
});

test('App: Ctrl-R alterna o raciocínio colapsado ⇄ expandido — Sprint 3', async () => {
  const reason = Array.from({ length: 6 }, (_, i) => `linha de raciocínio ${i}`).join('\n');
  const stream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    yield {
      type: 'message.part.updated',
      properties: { part: { type: 'reasoning', text: reason, messageID: 'm1', id: 'r1' } },
    };
    await new Promise((r) => setTimeout(r, 400));
  })();
  const h = fakeHandle();
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream });

  const { lastFrame, stdin, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 40));

  expect(lastFrame() ?? '').toContain('Ctrl-R'); // colapsado, com a dica
  const collapsedLines = (lastFrame() ?? '')
    .split('\n')
    .filter((l) => l.includes('linha de raciocínio')).length;

  stdin.write('\x12'); // Ctrl-R
  await new Promise((r) => setTimeout(r, 40));
  const expandedLines = (lastFrame() ?? '')
    .split('\n')
    .filter((l) => l.includes('linha de raciocínio')).length;
  expect(expandedLines).toBeGreaterThan(collapsedLines);
  expect(lastFrame() ?? '').toContain('✻ raciocínio');
  unmount();
});

test('Sprint — emenda de compactação (mode:compaction) sem prompt do usuário → aborta e fica idle', async () => {
  let aborted = 0;
  const stream = (async function* () {
    yield {
      type: 'message.updated',
      properties: { info: { id: 'm_c', role: 'assistant', mode: 'compaction', summary: true } },
    };
    await new Promise((r) => setTimeout(r, 200));
  })();
  const h = fakeHandle({
    onAbort: () => {
      aborted++;
    },
  });
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream });
  const { lastFrame, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 80));
  expect(aborted).toBeGreaterThan(0); // encerrou a emenda não-solicitada
  expect(lastFrame() ?? '').not.toContain('processando'); // não fica "pensando" depois
  unmount();
});
