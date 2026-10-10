import { test, expect } from 'bun:test';
import { render } from 'ink-testing-library';
import { App } from './app.js';
import { buildProgram } from '../cli/program.js';
import { fakeHandle, handleComStream } from './app.test-helpers.js';

test('App: nio termina com pergunta → cue "↳ o nio perguntou" acima do input (Sprint 7.4)', async () => {
  const stream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    yield {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'text',
          text: 'Analisei o projeto.\nQuer que eu comece pelo core ou pelos adapters?',
          messageID: 'm1',
          id: 't1',
        },
      },
    };
    await new Promise((r) => setTimeout(r, 20));
    yield { type: 'session.idle', properties: { sessionID: 'ses_fake' } };
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
  expect(f).toContain('o nio perguntou');
  expect(f).toContain('Quer que eu comece pelo core ou pelos adapters?');
  unmount();
});

test('App: session.error → bloco vermelho, input segue vivo (Sprint 7.3)', async () => {
  const stream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } };
    await new Promise((r) => setTimeout(r, 30));
    yield {
      type: 'session.error',
      properties: {
        error: { name: 'APIError', data: { message: '429 rate limited', isRetryable: true } },
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
  await new Promise((r) => setTimeout(r, 80));
  const f = lastFrame() ?? '';
  expect(f).toContain('APIError');
  expect(f).toContain('429 rate limited');
  expect(f).toContain('reenvie o prompt');

  // input não foi bloqueado — dá pra digitar
  stdin.write('tenta de novo');
  await new Promise((r) => setTimeout(r, 20));
  expect(lastFrame() ?? '').toContain('tenta de novo');
  unmount();
});

test('App: resposta gigante em andamento NÃO estoura o frame (Static + LiveMessage capado)', async () => {
  const bigStream = (async function* () {
    yield { type: 'session.status', properties: { status: { type: 'busy' } } };
    yield { type: 'message.updated', properties: { info: { id: 'msg_a', role: 'assistant' } } };
    let acc = '';
    for (let i = 0; i < 80; i++) {
      acc += `raciocínio linha ${i}\n`;
      yield {
        type: 'message.part.updated',
        properties: { part: { type: 'text', text: acc, messageID: 'msg_a', id: 'prt_t' } },
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  })();
  const h = fakeHandle();
  (
    h.client as unknown as { event: { subscribe: () => Promise<{ stream: AsyncGenerator }> } }
  ).event.subscribe = async () => ({ stream: bigStream });

  const { lastFrame, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 80));

  const lines = (lastFrame() ?? '').split('\n');
  expect(lines.length).toBeLessThan(40); // não vira uma parede de 80+ linhas
  unmount();
});

test('emenda NÃO solicitada pelo usuário nem pela TUI segue sendo abortada', async () => {
  // O guard existe por um motivo real: o motor emendava um turno sozinho após a
  // resposta e a sessão ficava `busy` pra sempre. A correção não pode desligá-lo.
  const { handle, espiao } = handleComStream([
    { type: 'session.idle', properties: {} },
    { type: 'message.updated', properties: { info: { mode: 'compaction' } } },
  ]);
  const { unmount } = render(
    <App handle={handle} program={buildProgram()} cwd="/tmp/p" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 250));
  unmount();
  expect(espiao.aborts).toBe(1);
});

test('App: colagem grande vira token no campo e no eco, mas o motor recebe o texto INTEIRO', async () => {
  let sentBody: { parts?: Array<{ type: string; text?: string }> } | undefined;
  const h = fakeHandle({ onPrompt: (b) => (sentBody = b as typeof sentBody) });
  const colado = Array.from({ length: 30 }, (_, i) => `registro-${i}: valor ${i * 7}`).join('\n');
  const { lastFrame, stdin, unmount } = render(
    <App handle={h} program={buildProgram()} cwd="/tmp/proj" session={null} splashMs={0} />,
  );
  await new Promise((r) => setTimeout(r, 40));
  stdin.write(colado);
  await new Promise((r) => setTimeout(r, 30));
  const campo = lastFrame() ?? '';
  expect(campo).toContain('[Pasted text #1 +30 lines]');
  expect(campo).not.toContain('registro-12');

  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 60));
  const texto = sentBody?.parts?.find((p) => p.type === 'text')?.text ?? '';
  expect(texto).toContain('registro-0: valor 0');
  expect(texto).toContain('registro-29: valor 203');
  expect(texto).not.toContain('[Pasted text');
  expect(lastFrame() ?? '').toContain('[Pasted text #1 +30 lines]'); // o eco no histórico fica curto
  expect(lastFrame() ?? '').not.toContain('registro-12');
  unmount();
});
