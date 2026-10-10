/**
 * O laço do worker, com banco e motor falsos. O foco são as transições que, se
 * erradas, corrompem a execução em silêncio: step com halt marcado como `done`,
 * escrita após perder o lease, e `INCOMPLETE` virando loop infinito.
 */
import { test, expect } from 'bun:test';
import { TaskRunner } from './task-runner.js';
import type { Planner } from '../core/agent.js';
import {
  criarMundo,
  fakeRepos,
  planoDe,
  executorQue,
  OK,
  validadorQue,
  concluiu,
  montar,
} from './task-runner.test-helpers.js';

test('lease perdido interrompe o processamento na hora', async () => {
  const m = criarMundo();
  const executados: string[] = [];
  const runner = montar(
    m,
    planoDe('a', 'b'),
    validadorQue(concluiu),
    executorQue((step) => {
      executados.push(step.name);
      m.leaseVivo = false; // outro worker assumiu no meio do 1º step
      return OK;
    }),
  );

  await runner.runOnce('w1', 7);

  // Parou no 1º step: seguir para o 2º seria escrever na trilha de outro worker.
  expect(executados).toEqual(['a']);
  expect(m.eventos).toContain('lease_lost');
  // Nem falha nem conclusão: a task não é mais nossa para rotular.
  expect(m.task.status).not.toBe('failed');
  expect(m.task.status).not.toBe('completed');
});

test('step gravado com fence velho encerra o processamento como lease perdido', async () => {
  const m = criarMundo();
  m.stepsRecusados = true; // heartbeat ainda diz vivo; só o fence do step acusa
  const executados: string[] = [];
  const runner = montar(
    m,
    planoDe('a', 'b'),
    validadorQue(concluiu),
    executorQue((step) => {
      executados.push(step.name);
      return OK;
    }),
  );

  await runner.runOnce('w1', 7);

  expect(executados).toEqual(['a']);
  expect(m.eventos).toContain('lease_lost');
});

test('escrita com fence velho não afeta nada (guarda do Postgres espelhada)', async () => {
  const m = criarMundo();
  const { tasks } = fakeRepos(m);
  expect(await tasks.setStatus('t1', 'completed', 999)).toBe(false);
  expect(m.task.status).toBe('planning');
});

test('retomada: task já planejada não replaneja', async () => {
  const m = criarMundo('running');
  m.steps.push({
    id: 1,
    taskId: 't1',
    stepNumber: 10,
    attempt: 1,
    name: 'a',
    status: 'pending',
    input: null,
    output: null,
    toolCalls: null,
    tokensIn: null,
    tokensOut: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });
  const plannerQueExplode: Planner = {
    plan: async () => {
      throw new Error('não deveria replanejar');
    },
  };
  const runner = montar(
    m,
    plannerQueExplode,
    validadorQue(concluiu),
    executorQue(() => OK),
  );

  await runner.runOnce('w1', 7);
  expect(m.task.status).toBe('completed');
  expect(m.steps).toHaveLength(1); // retomou o step existente, não criou outro
});

test('erro do executor vira falha da task, não derruba o worker', async () => {
  const m = criarMundo();
  const runner = montar(
    m,
    planoDe('a'),
    validadorQue(concluiu),
    executorQue(() => {
      throw new Error('motor caiu');
    }),
  );

  await runner.runOnce('w1', 7);
  expect(m.task.status).toBe('failed');
  expect(m.task.error).toContain('motor caiu');
});

test('fila vazia devolve false', async () => {
  const m = criarMundo();
  const { tasks, steps, queue } = fakeRepos(m);
  const runner = new TaskRunner({
    planner: planoDe('a'),
    validator: validadorQue(concluiu),
    executor: executorQue(() => OK),
    tasks,
    steps,
    queue: { ...queue, claim: async () => null },
  });
  expect(await runner.runOnce('w1', 7)).toBe(false);
});
