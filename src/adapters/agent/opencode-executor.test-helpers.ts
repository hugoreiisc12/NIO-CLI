import type { Event, OpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeStepExecutor } from './opencode-executor.js';
import type { PermissionDecider } from '../../core/agent.js';
import type { Task, TaskStep } from '../../core/tasks.js';

export const evt = (type: string, properties: Record<string, unknown> = {}): Event =>
  ({ type, properties }) as unknown as Event;

export function fakeTask(engineSessionId: string | null = 's1'): Task {
  return {
    id: 'abc12345',
    sessionId: null,
    userId: 1,
    profile: 'qa',
    goal: 'contar arquivos',
    status: 'running',
    currentStep: 10,
    maxSteps: 25,
    workingSet: {},
    engineSessionId,
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

export function fakeStep(): TaskStep {
  return {
    id: 1,
    taskId: 'abc12345',
    stepNumber: 10,
    attempt: 1,
    name: 'listar arquivos',
    status: 'running',
    input: { instruction: 'liste os .ts' },
    output: null,
    toolCalls: null,
    tokensIn: null,
    tokensOut: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

export interface Registro {
  prompts: string[];
  aborts: number;
  permissoes: Array<{ id: string; response: string }>;
  sessoesCriadas: string[];
}

/** Client falso: registra o que o executor mandou pro motor. */
export function fakeClient(reg: Registro): OpencodeClient {
  const client = {
    session: {
      create: async () => {
        const id = `s-nova-${reg.sessoesCriadas.length + 1}`;
        reg.sessoesCriadas.push(id);
        return { data: { id } };
      },
      prompt: async (a: { body: { parts: Array<{ text?: string }> } }) => {
        reg.prompts.push(a.body.parts[0]?.text ?? '');
        return {};
      },
      abort: async () => {
        reg.aborts++;
        return {};
      },
    },
    postSessionIdPermissionsPermissionId: async (a: {
      path: { permissionID: string };
      body: { response: string };
    }) => {
      reg.permissoes.push({ id: a.path.permissionID, response: a.body.response });
      return {};
    },
  };
  return client as unknown as OpencodeClient;
}

/** Stream falso: `null` (conectou) e depois os eventos dados. */
export function fakeSubscribe(eventos: Array<Event | null>) {
  return async function* (): AsyncGenerator<Event | null> {
    yield null;
    for (const e of eventos) yield e;
  };
}

export const permitir: PermissionDecider = { decide: () => 'allow' };

export const negar: PermissionDecider = { decide: () => 'deny' };

export function montar(
  eventos: Array<Event | null>,
  decider?: PermissionDecider,
  timeoutMs = 5000,
) {
  const reg: Registro = { prompts: [], aborts: 0, permissoes: [], sessoesCriadas: [] };
  const exec = createOpencodeStepExecutor({
    client: fakeClient(reg),
    baseUrl: 'http://127.0.0.1:1/',
    model: { providerID: 'nio-local', modelID: 'qwen' },
    subscribe: fakeSubscribe(eventos),
    timeoutMs,
    ...(decider ? { deciderFor: () => decider } : {}),
  });
  return { exec, reg };
}

export const parteTexto = (id: string, text: string): Event =>
  evt('message.part.updated', { part: { id, sessionID: 's1', type: 'text', text } });

export function fakeStepWith(over: Partial<TaskStep>): TaskStep {
  return { ...fakeStep(), ...over };
}
