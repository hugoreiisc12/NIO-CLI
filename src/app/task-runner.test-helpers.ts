import { TaskRunner } from './task-runner.js';
import type { Planner, StepExecutor, StepOutcome, Validator, Verdict } from '../core/agent.js';
import type {
  NewStepInput,
  StepRepository,
  Task,
  TaskQueue,
  TaskRepository,
  TaskStep,
} from '../core/tasks.js';
import type { TaskStatus } from '../core/types.js';

export function novaTask(status: TaskStatus = 'planning'): Task {
  return {
    id: 't1',
    sessionId: null,
    userId: 7,
    profile: 'qa',
    goal: 'contar arquivos',
    status,
    currentStep: null,
    maxSteps: 25,
    workingSet: {},
    engineSessionId: null,
    result: null,
    error: null,
    attempts: 0,
    fence: 1,
    lockedBy: 'w1',
    lockedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    awaitingKind: null,
    awaitingSubject: null,
    approvedTools: [],
    kind: 'agent',
  };
}

export interface Mundo {
  task: Task;
  steps: TaskStep[];
  leaseVivo: boolean;
  /** Simula o fence recusando a escrita de step (heartbeat ainda não percebeu). */
  stepsRecusados?: boolean;
  eventos: string[];
}

export function criarMundo(status: TaskStatus = 'planning'): Mundo {
  return { task: novaTask(status), steps: [], leaseVivo: true, eventos: [] };
}

export function fakeRepos(m: Mundo): {
  tasks: TaskRepository;
  steps: StepRepository;
  queue: TaskQueue;
} {
  let proximoId = 1;
  const inserir = (novos: readonly NewStepInput[]): TaskStep[] =>
    novos.map((s) => {
      const step: TaskStep = {
        id: proximoId++,
        taskId: m.task.id,
        stepNumber: s.stepNumber,
        attempt: 1,
        name: s.name,
        status: 'pending',
        input: s.input ?? null,
        output: null,
        toolCalls: null,
        tokensIn: null,
        tokensOut: null,
        error: null,
        startedAt: null,
        completedAt: null,
      };
      m.steps.push(step);
      return step;
    });
  const acharStep = (id: number): TaskStep | undefined => m.steps.find((s) => s.id === id);
  /** Só grava se o fence bater — espelha a guarda real do Postgres. */
  const comFence = (fence: number, fn: () => void): boolean => {
    if (fence !== m.task.fence) return false;
    fn();
    return true;
  };

  return {
    tasks: {
      create: async () => m.task,
      findById: async () => m.task,
      listByUser: async () => [m.task],
      setStatus: async (_id, status, fence, patch) =>
        comFence(fence, () => {
          m.task.status = status;
          if (patch?.currentStep !== undefined) m.task.currentStep = patch.currentStep;
          if (patch?.engineSessionId !== undefined) m.task.engineSessionId = patch.engineSessionId;
          if (patch?.error !== undefined) m.task.error = patch.error;
          if (patch?.awaitingKind !== undefined) m.task.awaitingKind = patch.awaitingKind;
          if (patch?.awaitingSubject !== undefined) m.task.awaitingSubject = patch.awaitingSubject;
        }),
      complete: async (_id, fence, result) =>
        comFence(fence, () => {
          m.task.status = 'completed';
          m.task.result = result;
        }),
      fail: async (_id, fence, error) =>
        comFence(fence, () => {
          m.task.status = 'failed';
          m.task.error = error;
        }),
      approve: async () => true,
      cancel: async () => true,
    },
    steps: {
      insertAll: async (_t, novos) => inserir(novos),
      append: async (_t, novos) => inserir(novos),
      listByTask: async () => m.steps,
      nextPending: async () => m.steps.find((s) => s.status === 'pending') ?? null,
      start: async (id) => {
        const s = acharStep(id);
        if (s) s.status = 'running';
        return true;
      },
      reopen: async (id) => {
        const s = acharStep(id);
        if (s?.status === 'running') s.status = 'pending';
        return true;
      },
      finish: async (id, _fence, r) => {
        const s = acharStep(id);
        if (s) {
          s.status = 'done';
          s.output = r.output;
        }
        return !m.stepsRecusados;
      },
      failStep: async (id, _fence, error) => {
        const s = acharStep(id);
        if (s) {
          s.status = 'failed';
          s.error = error;
        }
        return true;
      },
      retry: async (id) => acharStep(id)!,
      lastStepNumber: async () => Math.max(0, ...m.steps.map((s) => s.stepNumber)),
    },
    queue: {
      claim: async () => m.task,
      // `false` = lease perdido; o runner tem que parar de escrever.
      heartbeat: async () => m.leaseVivo,
      release: async () => {},
      reclaimExpired: async () => 0,
      notifyNew: async () => {},
      waitForNew: async () => {},
    },
  };
}

export const planoDe = (...nomes: string[]): Planner => ({
  plan: async () => nomes.map((name) => ({ name, instruction: `faça ${name}` })),
});

export const executorQue = (fn: (step: TaskStep) => StepOutcome): StepExecutor => ({
  run: async (_t, step) => fn(step),
});

export const OK: StepOutcome = { output: { text: 'ok' }, toolCalls: [], tokensIn: 1, tokensOut: 1 };

export const validadorQue = (...vereditos: Verdict[]): Validator => {
  let i = 0;
  return { judge: async () => vereditos[Math.min(i++, vereditos.length - 1)]! };
};

export const concluiu: Verdict = { complete: true, result: 'pronto' };

export function montar(
  m: Mundo,
  planner: Planner,
  validator: Validator,
  executor: StepExecutor,
): TaskRunner {
  const { tasks, steps, queue } = fakeRepos(m);
  return new TaskRunner({
    planner,
    validator,
    executor,
    tasks,
    steps,
    queue,
    heartbeatMs: 5,
    onEvent: (e) => m.eventos.push(e),
  });
}
