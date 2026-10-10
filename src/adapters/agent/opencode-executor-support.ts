import type { OpencodeClient } from '@opencode-ai/sdk';
import type { PermissionDecider, StepHalt } from '../../core/agent.js';
import type { Task, TaskStep } from '../../core/tasks.js';
import { eventSessionId, type PedidoBloqueante } from './step-events.js';

/** Teto do resumo de recuperação — pequeno de propósito: se ELE também
 * estourasse, a recuperação falharia pelo mesmo motivo do erro original. */
const RECOVERY_DIGEST_MAX_CHARS = 3000;

/** Teto por step concluído no resumo — um output gigante não pode comer o resto. */
const PRIOR_STEP_MAX_CHARS = 300;

/** Teto do progresso parcial (texto já acumulado nesta sessão antes do reset). */
const PARTIAL_PROGRESS_MAX_CHARS = 800;

export const PROMPT_CONTINUAR =
  'Sua resposta anterior foi cortada por exceder o teto de tokens de saída. ' +
  'Continue EXATAMENTE de onde parou, sem repetir o que já foi dito.';

/** Sem política injetada nada roda — o cofre nasce fechado. */
export const DECIDER_PADRAO: PermissionDecider = { decide: () => 'park' };

/** Responde uma permissão. `once` nunca `always`: o "sempre" é decisão do humano. */
export async function responderPermissao(
  client: OpencodeClient,
  pedido: PedidoBloqueante,
  permitir: boolean,
): Promise<void> {
  await client
    .postSessionIdPermissionsPermissionId({
      path: { id: pedido.sessionId, permissionID: pedido.id },
      body: { response: permitir ? 'once' : 'reject' },
    })
    .catch(() => {
      /* motor já pode ter desistido; abortar depois cobre */
    });
}

/** Rejeita uma pergunta via REST — o SDK não expõe essa rota. */
export async function rejeitarPergunta(baseUrl: string, pedido: PedidoBloqueante): Promise<void> {
  await fetch(new URL(`/session/${pedido.sessionId}/question/${pedido.id}/reject`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    /* idem: o abort da sessão é a rede de segurança */
  });
}

/** Evento de OUTRA sessão não pode entrar neste step. Sem `sessionID`, passa. */
export function ehDeOutraSessao(evt: unknown, sessionId: string): boolean {
  const id = eventSessionId(evt);
  return id !== undefined && id !== sessionId;
}

export function haltDe(kind: 'approval' | 'question' | 'timeout', subject: string): StepHalt {
  const motivo = {
    approval: `a tool "${subject}" exige aprovação humana neste perfil`,
    question: `o motor perguntou "${subject}" e não há humano na sessão`,
    timeout: `o passo excedeu o tempo máximo`,
  }[kind];
  return { kind, subject, reason: motivo };
}

/** `engine_error` carrega diagnóstico livre — não um template dos outros 3 kinds. */
export function haltErroDoMotor(subject: string, reason: string): StepHalt {
  return { kind: 'engine_error', subject, reason };
}

/**
 * Resumo local (SEM chamar o motor — é ele que estourou) pra retomar numa
 * sessão nova. Curto de propósito e feito só de dados já em mãos (a trilha
 * persistida + o que já saiu deste step antes do reset).
 */
export function digestoDeRecuperacao(
  task: Task,
  step: TaskStep,
  priorSteps: readonly TaskStep[],
  progressoParcial: string,
): string {
  const linhas: string[] = [
    'A sessão anterior estourou a janela de contexto e foi reiniciada.',
    `Objetivo da tarefa: ${task.goal}`,
  ];

  const concluidos = priorSteps.filter((s) => s.status === 'done');
  if (concluidos.length > 0) {
    linhas.push('', 'Passos já concluídos:');
    for (const s of concluidos) {
      const saida =
        typeof s.output?.text === 'string' ? s.output.text : JSON.stringify(s.output ?? {});
      linhas.push(`- [${s.stepNumber}] ${s.name}: ${saida.slice(0, PRIOR_STEP_MAX_CHARS)}`);
    }
  }

  linhas.push('', `Passo atual (${step.stepNumber}): ${step.name}`);
  linhas.push((step.input?.instruction as string | undefined) ?? step.name);

  if (progressoParcial.trim()) {
    linhas.push(
      '',
      'Progresso parcial deste passo antes do reset (pode estar incompleto):',
      progressoParcial.slice(0, PARTIAL_PROGRESS_MAX_CHARS),
    );
  }

  linhas.push('', 'Continue a partir daqui. Não repita o que já foi feito.');
  const texto = linhas.join('\n');
  return texto.length > RECOVERY_DIGEST_MAX_CHARS
    ? `${texto.slice(0, RECOVERY_DIGEST_MAX_CHARS)}…`
    : texto;
}
