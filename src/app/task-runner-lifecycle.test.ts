/**
 * O laço do worker, com banco e motor falsos. O foco são as transições que, se
 * erradas, corrompem a execução em silêncio: step com halt marcado como `done`,
 * escrita após perder o lease, e `INCOMPLETE` virando loop infinito.
 */
import { test, expect } from 'bun:test';
import type { Verdict } from '../core/agent.js';
import {
  criarMundo,
  planoDe,
  executorQue,
  OK,
  validadorQue,
  concluiu,
  montar,
} from './task-runner.test-helpers.js';

test('caminho feliz: planeja, executa tudo, valida e conclui', async () => {
  const m = criarMundo();
  const runner = montar(
    m,
    planoDe('a', 'b'),
    validadorQue(concluiu),
    executorQue(() => OK),
  );

  expect(await runner.runOnce('w1', 7)).toBe(true);
  expect(m.task.status).toBe('completed');
  expect(m.task.result).toBe('pronto');
  expect(m.steps.every((s) => s.status === 'done')).toBe(true);
  expect(m.eventos).toContain('task_planned');
  expect(m.eventos).toContain('task_completed');
});

test('halt de aprovação: task estaciona e o step SEGUE pendente (retomável)', async () => {
  const m = criarMundo();
  const halt = {
    ...OK,
    halt: { kind: 'approval' as const, subject: 'bash', reason: 'precisa humano' },
  };
  const runner = montar(
    m,
    planoDe('a', 'b'),
    validadorQue(concluiu),
    executorQue(() => halt),
  );

  await runner.runOnce('w1', 7);
  expect(m.task.status).toBe('waiting_approval');
  // O step NÃO pode virar `done` — e fica `pending` para o worker retomar daqui.
  expect(m.steps[0]!.status).toBe('pending');
  expect(m.steps.some((s) => s.status === 'done')).toBe(false);
  // Estacionar não é falhar: sem erro gravado.
  expect(m.task.error).toBeNull();
  // E registra O QUE travou — sem isto o `approve` não teria alvo e a task
  // ficaria num estado que ninguém sabe destravar.
  expect(m.task.awaitingKind).toBe('approval');
  expect(m.task.awaitingSubject).toBe('bash');
});

test('halt de erro do motor: falha com o diagnóstico REAL, não um genérico', async () => {
  // O executor já tentou recuperar sozinho (sessão nova / continuação) e não
  // conseguiu — `reason` carrega o motivo real, diferente do texto fixo do timeout.
  const m = criarMundo();
  const halt = {
    ...OK,
    halt: {
      kind: 'engine_error' as const,
      subject: 'ContextOverflowError',
      reason: 'estouro de contexto — 2 tentativa(s) de recuperação esgotada(s)',
    },
  };
  const runner = montar(
    m,
    planoDe('a'),
    validadorQue(concluiu),
    executorQue(() => halt),
  );

  await runner.runOnce('w1', 7);
  expect(m.task.status).toBe('failed');
  expect(m.task.error).toBe('estouro de contexto — 2 tentativa(s) de recuperação esgotada(s)');
  expect(m.steps[0]!.status).toBe('failed');
});

test('halt de timeout: falha e marca o step, não estaciona', async () => {
  const m = criarMundo();
  const halt = { ...OK, halt: { kind: 'timeout' as const, subject: 'a', reason: 'estourou' } };
  const runner = montar(
    m,
    planoDe('a'),
    validadorQue(concluiu),
    executorQue(() => halt),
  );

  await runner.runOnce('w1', 7);
  expect(m.task.status).toBe('failed');
  expect(m.steps[0]!.status).toBe('failed');
});

test('validator INCOMPLETO com próximos passos: acrescenta e executa de novo', async () => {
  const m = criarMundo();
  const incompleto: Verdict = {
    complete: false,
    reason: 'falta juntar',
    nextSteps: [{ name: 'c', instruction: 'junte' }],
  };
  const runner = montar(
    m,
    planoDe('a'),
    validadorQue(incompleto, concluiu),
    executorQue(() => OK),
  );

  await runner.runOnce('w1', 7);
  expect(m.eventos).toContain('task_extended');
  expect(m.steps).toHaveLength(2);
  // Numeração com folga: o passo novo entra DEPOIS, sem colidir.
  expect(m.steps[1]!.stepNumber).toBeGreaterThan(m.steps[0]!.stepNumber);
  expect(m.task.status).toBe('completed');
});

test('INCOMPLETO sem próximos passos vira falha — não loop infinito', async () => {
  const m = criarMundo();
  const semSaida: Verdict = { complete: false, reason: 'orçamento acabou', nextSteps: [] };
  const runner = montar(
    m,
    planoDe('a'),
    validadorQue(semSaida),
    executorQue(() => OK),
  );

  await runner.runOnce('w1', 7);
  // Era a obrigação herdada da fatia 1.7: o Validator não tem estado de "esgotado".
  expect(m.task.status).toBe('failed');
  expect(m.task.error).toContain('Teto de passos');
  expect(m.eventos).toContain('task_exhausted');
});
