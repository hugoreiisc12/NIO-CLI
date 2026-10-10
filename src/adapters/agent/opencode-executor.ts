/**
 * `StepExecutor` sobre o `opencode serve`. Um step = uma chamada `session.prompt`;
 * a NIO orquestra a SEQUÊNCIA de steps, o OpenCode executa UM deles com tools.
 *
 * Contrato de segurança deste arquivo:
 *  - **Nada executa sem decisão explícita.** O default do `PermissionDecider` é
 *    `park`: sem política injetada, nenhuma tool roda.
 *  - **Nenhum caminho de saída deixa o motor pendurado.** Todo pedido bloqueante
 *    (permissão ou pergunta) recebe resposta ou a sessão é abortada. Headless,
 *    um turno preso não aparece para ninguém — é o pior modo de falha do sistema.
 *  - **Timeout é obrigatório**, não opcional: step sem teto trava o worker.
 */

import type { PermissionDecider, StepExecutor, StepHalt, StepOutcome } from '../../core/agent.js';
import type { Task, TaskStep } from '../../core/tasks.js';
import {
  type OpencodeExecutorDeps,
  consumeStep,
  criarSessaoNova,
} from './opencode-executor-loop.js';
import { DECIDER_PADRAO } from './opencode-executor-support.js';
import type { StepAccumulated } from './step-events.js';

export { buildStepPrompt, type OpencodeExecutorDeps } from './opencode-executor-loop.js';

/** Teto por step. Generoso para trabalho real, finito para não travar o worker. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const SEM_RESULTADO: StepAccumulated = { text: '', toolCalls: [], tokensIn: 0, tokensOut: 0 };

function toOutcome(
  resultado: StepAccumulated,
  engineSessionId: string,
  halt: StepHalt | undefined,
): StepOutcome {
  return {
    output: { text: resultado.text },
    toolCalls: resultado.toolCalls,
    tokensIn: resultado.tokensIn,
    tokensOut: resultado.tokensOut,
    engineSessionId,
    ...(halt ? { halt } : {}),
  };
}

export function createOpencodeStepExecutor(deps: OpencodeExecutorDeps): StepExecutor {
  const deciderFor = deps.deciderFor ?? ((): PermissionDecider => DECIDER_PADRAO);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async run(task: Task, step: TaskStep, priorSteps: readonly TaskStep[]): Promise<StepOutcome> {
      // Reusa a sessão da task (re-attach) ou cria uma.
      let sessionId = task.engineSessionId ?? (await criarSessaoNova(deps, task));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let halt: StepHalt | undefined;
      let resultado = SEM_RESULTADO;

      try {
        const consumo = await consumeStep(deps, {
          decider: deciderFor(task),
          sessionId,
          step,
          task,
          priorSteps,
          ac,
          onSessionChange: (novoId) => {
            sessionId = novoId;
          },
        });
        halt = consumo.halt;
        resultado = consumo.resultado;
      } finally {
        clearTimeout(timer);
        ac.abort();
        // Abortar SEMPRE, na sessão FINAL (pode ter trocado por recuperação de
        // estouro): saída por halt, erro ou timeout não pode deixar o motor
        // trabalhando numa sessão que ninguém mais está lendo.
        await deps.client.session.abort({ path: { id: sessionId } }).catch(() => {});
      }
      return toOutcome(resultado, sessionId, halt);
    },
  };
}
