/**
 * Executor com o motor inteiro falsificado. O foco não é o caminho feliz — é
 * garantir que **nenhuma saída deixa o motor pendurado** e que nada executa sem
 * decisão explícita. Headless, um turno preso não aparece pra ninguém.
 */
import { test, expect } from 'bun:test';
import {
  evt,
  fakeTask,
  fakeStep,
  permitir,
  negar,
  montar,
  parteTexto,
} from './opencode-executor.test-helpers.js';

test('caminho feliz: texto, tools e tokens chegam no outcome', async () => {
  const { exec, reg } = montar(
    [
      parteTexto('t1', 'achei 42 arquivos'),
      evt('message.part.updated', {
        part: {
          id: 'a',
          sessionID: 's1',
          type: 'tool',
          tool: 'grep',
          state: { status: 'completed' },
        },
      }),
      evt('message.part.updated', {
        part: { id: 's', sessionID: 's1', type: 'step-finish', tokens: { input: 90, output: 12 } },
      }),
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.output).toEqual({ text: 'achei 42 arquivos' });
  expect(out.toolCalls).toEqual([{ tool: 'grep', status: 'completed' }]);
  expect(out).toMatchObject({ tokensIn: 90, tokensOut: 12, engineSessionId: 's1' });
  expect(out.halt).toBeUndefined();
  expect(reg.prompts).toHaveLength(1);
});

test('SEGURANÇA: sem decider injetado, nada executa — a task estaciona', async () => {
  const { exec, reg } = montar([
    evt('permission.asked', { id: 'p1', sessionID: 's1', tool: { name: 'bash' } }),
    evt('session.idle', { sessionID: 's1' }),
  ]); // sem decider → default `park`

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.halt).toMatchObject({ kind: 'approval', subject: 'bash' });
  // O cofre nasce fechado: nenhuma permissão concedida por omissão.
  expect(reg.permissoes).toEqual([]);
  // E o motor não fica trabalhando numa sessão que ninguém lê.
  expect(reg.aborts).toBeGreaterThanOrEqual(1);
});

test('decider `allow` responde `once`, nunca `always`', async () => {
  const { exec, reg } = montar(
    [
      evt('permission.asked', { id: 'p1', sessionID: 's1', tool: { name: 'read' } }),
      parteTexto('t1', 'ok'),
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.halt).toBeUndefined();
  // `always` é decisão do humano, não do worker — conceder permanente aqui
  // vazaria para todos os steps seguintes da sessão.
  expect(reg.permissoes).toEqual([{ id: 'p1', response: 'once' }]);
});

test('decider `deny` rejeita e o turno SEGUE (não estaciona)', async () => {
  const { exec, reg } = montar(
    [
      evt('permission.asked', { id: 'p1', sessionID: 's1', tool: { name: 'bash' } }),
      parteTexto('t1', 'segui sem bash'),
      evt('session.idle', { sessionID: 's1' }),
    ],
    negar,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(reg.permissoes).toEqual([{ id: 'p1', response: 'reject' }]);
  expect(out.halt).toBeUndefined();
  expect(out.output).toEqual({ text: 'segui sem bash' });
});

test('pergunta do motor estaciona o step em vez de pendurar o turno', async () => {
  const { exec, reg } = montar(
    [
      evt('question.asked', { id: 'q1', sessionID: 's1', title: 'qual banco?' }),
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.halt).toMatchObject({ kind: 'question', subject: 'qual banco?' });
  expect(reg.aborts).toBeGreaterThanOrEqual(1);
});

test('família paralela `question.v2.*` também estaciona', async () => {
  const { exec } = montar(
    [
      evt('question.v2.asked', { id: 'q9', sessionID: 's1' }),
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );
  expect((await exec.run(fakeTask(), fakeStep(), [])).halt?.kind).toBe('question');
});

test('evento de OUTRA sessão não contamina o step', async () => {
  const { exec } = montar(
    [
      parteTexto('t1', 'meu texto'),
      evt('message.part.updated', {
        part: { id: 't2', sessionID: 'OUTRA', type: 'text', text: 'texto alheio' },
      }),
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.output).toEqual({ text: 'meu texto' });
});

test('stream que acaba sem idle vira halt, não sucesso silencioso', async () => {
  const { exec } = montar([parteTexto('t1', 'parcial')], permitir);
  const out = await exec.run(fakeTask(), fakeStep(), []);
  // Sem isto, um step interrompido seria gravado como `done` com saída parcial.
  expect(out.halt).toMatchObject({ kind: 'timeout' });
});

test('reconexão não reenvia o prompt (duplicaria o turno)', async () => {
  const { exec, reg } = montar(
    [
      parteTexto('t1', 'a'),
      null, // reconectou no meio
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );

  await exec.run(fakeTask(), fakeStep(), []);
  expect(reg.prompts).toHaveLength(1);
});

test('sem engineSessionId, cria sessão e devolve o id pro re-attach', async () => {
  const { exec } = montar([evt('session.idle', { sessionID: 's-nova-1' })], permitir);
  const out = await exec.run(fakeTask(null), fakeStep(), []);
  expect(out.engineSessionId).toBe('s-nova-1');
});
