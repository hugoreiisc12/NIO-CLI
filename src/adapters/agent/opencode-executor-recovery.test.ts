/**
 * Executor com o motor inteiro falsificado. O foco não é o caminho feliz — é
 * garantir que **nenhuma saída deixa o motor pendurado** e que nada executa sem
 * decisão explícita. Headless, um turno preso não aparece pra ninguém.
 */
import { test, expect } from 'bun:test';
import { buildStepPrompt } from './opencode-executor.js';
import type { TaskStep } from '../../core/tasks.js';
import {
  evt,
  fakeTask,
  fakeStep,
  permitir,
  montar,
  parteTexto,
  fakeStepWith,
} from './opencode-executor.test-helpers.js';

test('estouro de contexto: cria sessão NOVA, reenvia com resumo, conclui normalmente', async () => {
  const { exec, reg } = montar(
    [
      evt('session.error', { error: { name: 'ContextOverflowError' } }), // sem sessionID = vale em qualquer sessão
      // sessionID 's-nova-1' de propósito: depois da recuperação a sessão ativa
      // TROCOU — se este evento viesse com o 's1' antigo (como o `parteTexto`
      // padrão faz), `ehDeOutraSessao` o descartaria e o teste passaria vazio
      // pelo motivo errado.
      evt('message.part.updated', {
        part: { id: 't1', sessionID: 's-nova-1', type: 'text', text: 'achei depois de recuperar' },
      }),
      evt('session.idle', {}),
    ],
    permitir,
  );

  const priorSteps: TaskStep[] = [
    fakeStepWith({
      id: 9,
      stepNumber: 0,
      name: 'passo anterior',
      status: 'done',
      output: { text: 'resultado do passo 1' },
    }),
  ];
  const out = await exec.run(fakeTask(), fakeStep(), priorSteps);

  // Sessão trocou: a de recuperação é uma NOVA (s-nova-1), não a original (s1).
  expect(reg.sessoesCriadas).toEqual(['s-nova-1']);
  expect(out.engineSessionId).toBe('s-nova-1');
  expect(out.halt).toBeUndefined();
  expect(out.output).toEqual({ text: 'achei depois de recuperar' });

  // O resumo de recuperação carrega o objetivo, o step atual E o que já foi feito.
  const digest = reg.prompts[1]; // prompts[0] = tentativa original; prompts[1] = o resumo
  expect(digest).toContain('contar arquivos'); // goal
  expect(digest).toContain('listar arquivos'); // step atual
  expect(digest).toContain('passo anterior'); // trilha já concluída
  expect(digest).toContain('resultado do passo 1');
  expect(digest).toContain('Continue a partir daqui');
});

test('estouro de contexto repetido esgota as tentativas e falha com diagnóstico HONESTO', async () => {
  const { exec, reg } = montar(
    [
      evt('session.error', { error: { name: 'ContextOverflowError' } }),
      evt('session.error', { error: { name: 'ContextOverflowError' } }),
      evt('session.error', { error: { name: 'ContextOverflowError' } }), // além do teto — nunca deveria ser processado
      evt('session.idle', {}),
    ],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.halt?.kind).toBe('engine_error');
  // Diagnóstico real, não "timeout" — é a diferença que o § do usuário pedia.
  expect(out.halt?.reason).toContain('estouro de contexto');
  // 2 sessões novas (o teto), não 3 — prova que o cap realmente existe, não é decorativo.
  expect(reg.sessoesCriadas).toHaveLength(2);
});

test('resposta cortada (output_length): MESMA sessão, pede continuação, concatena o texto', async () => {
  const { exec, reg } = montar(
    [
      parteTexto('t1', 'começo da resposta, cortado aqui'),
      evt('session.error', { error: { name: 'MessageOutputLengthError' } }),
      parteTexto('t2', ' — e o resto depois de continuar'),
      evt('session.idle', { sessionID: 's1' }),
    ],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  // NENHUMA sessão nova: o problema é o teto de UMA geração, não o histórico.
  expect(reg.sessoesCriadas).toEqual([]);
  expect(out.engineSessionId).toBe('s1');
  expect(out.halt).toBeUndefined();
  // As duas partes concatenam — é a resposta "continuada", não duas respostas soltas.
  expect(out.output).toEqual({
    text: 'começo da resposta, cortado aqui — e o resto depois de continuar',
  });
  expect(reg.prompts[1]).toContain('Continue EXATAMENTE de onde parou');
});

test('resposta cortada repetidamente esgota as tentativas e falha com diagnóstico HONESTO', async () => {
  const eventos = Array.from({ length: 4 }, () =>
    evt('session.error', { error: { name: 'MessageOutputLengthError' } }),
  );
  const { exec, reg } = montar([...eventos, evt('session.idle', {})], permitir);

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.halt?.kind).toBe('engine_error');
  expect(out.halt?.reason).toContain('resposta cortada');
  expect(reg.sessoesCriadas).toEqual([]); // continuação nunca cria sessão
});

test('erro genérico do motor (sem recuperação conhecida) falha na hora, sem retry', async () => {
  const { exec, reg } = montar(
    [evt('session.error', { error: { name: 'ProviderAuthError' } }), evt('session.idle', {})],
    permitir,
  );

  const out = await exec.run(fakeTask(), fakeStep(), []);
  expect(out.halt).toMatchObject({ kind: 'engine_error', subject: 'ProviderAuthError' });
  expect(reg.sessoesCriadas).toEqual([]);
  // Só o prompt original — nenhuma tentativa de recuperação pra um erro sem receita.
  expect(reg.prompts).toHaveLength(1);
});

test('prompt carrega o objetivo da task E a instrução do step', () => {
  const p = buildStepPrompt(fakeTask(), fakeStep());
  expect(p).toContain('contar arquivos'); // sem o goal o modelo perde o fio entre steps
  expect(p).toContain('liste os .ts');
  expect(p).toContain('listar arquivos');
});
