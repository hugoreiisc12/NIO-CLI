/**
 * Laço de eventos de UM step do `opencode serve`. Pode atravessar VÁRIAS sessões do
 * motor (estouro de contexto) e VÁRIOS envios (resposta cortada), tudo invisível pro
 * `run()`: o stream SSE é global (não por sessão), então trocar de sessão é só trocar
 * qual `sessionId` o filtro e o próximo envio usam — não precisa reconectar.
 */
import type { Event, OpencodeClient } from '@opencode-ai/sdk';
import type { PermissionDecider, StepHalt } from '../../core/agent.js';
import type { Task, TaskStep } from '../../core/tasks.js';
import {
  PROMPT_CONTINUAR,
  digestoDeRecuperacao,
  ehDeOutraSessao,
  haltDe,
  haltErroDoMotor,
  rejeitarPergunta,
  responderPermissao,
} from './opencode-executor-support.js';
import {
  createStepAccumulator,
  engineErrorFrom,
  isTurnEnd,
  permissionFrom,
  questionFrom,
  type StepAccumulated,
} from './step-events.js';

/**
 * Teto de sessões novas por estouro de contexto NO MESMO STEP. Se o resumo de
 * recuperação — que é montado localmente e deliberadamente curto — ainda assim
 * não cabe, insistir é desperdício: o step falha com diagnóstico honesto em vez
 * de ficar criando sessão atrás de sessão.
 */
const MAX_CONTEXT_RETRIES = 2;

/** Teto de "continue" por resposta cortada. Sem isto um step preso em saída
 * gigante (ou um modelo que nunca converge) pediria continuação pra sempre. */
const MAX_CONTINUATION_RETRIES = 3;

export interface OpencodeExecutorDeps {
  client: OpencodeClient;
  /** Base do `opencode serve` — a resposta a `question` não está no SDK. */
  baseUrl: string;
  model: { providerID: string; modelID: string };
  /**
   * Política POR TASK: a decisão depende das concessões pontuais que o humano
   * deu a ela (`tasks.approved_tools`), não só do perfil. Ausente = cofre
   * fechado, nada roda.
   */
  deciderFor?: (task: Task) => PermissionDecider;
  timeoutMs?: number;
  /**
   * Stream SSE do motor. **Obrigatório**: o executor é um adapter e não pode
   * importar de `tui/` (seta invertida). Quem liga os fios é o entrypoint do
   * worker, que pode conhecer as duas pontas.
   */
  subscribe: (client: OpencodeClient, signal: AbortSignal) => AsyncGenerator<Event | null>;
}

/**
 * Prompt do step. O `goal` da task entra como contexto, a `instruction` como a
 * ordem — o modelo precisa dos dois para não perder o fio entre steps.
 */
export function buildStepPrompt(task: Task, step: TaskStep): string {
  const instrucao = (step.input?.instruction as string | undefined) ?? step.name;
  return [
    `Objetivo geral da tarefa: ${task.goal}`,
    '',
    `Passo atual (${step.stepNumber}): ${step.name}`,
    instrucao,
  ].join('\n');
}

export interface ResultadoConsumo {
  halt?: StepHalt;
  resultado: StepAccumulated;
}

/** Cria uma sessão nova no motor, ignorando a da task (usado na recuperação). */
export async function criarSessaoNova(
  deps: OpencodeExecutorDeps,
  task: Task,
  sufixoTitulo = '',
): Promise<string> {
  const criada = await deps.client.session.create({
    body: { title: `nio task ${task.id.slice(0, 8)}${sufixoTitulo}` },
  });
  const id = (criada as { data?: { id?: string } }).data?.id;
  if (!id) throw new Error('opencode não devolveu id de sessão.');
  return id;
}

/** Estado mutável de UM step: o laço e os tratadores de recuperação compartilham isto. */
interface Loop {
  deps: OpencodeExecutorDeps;
  decider: PermissionDecider;
  task: Task;
  step: TaskStep;
  priorSteps: readonly TaskStep[];
  onSessionChange: (novoId: string) => void;
  sessionId: string;
  acc: ReturnType<typeof createStepAccumulator>;
  promptEnviado: boolean;
  tentativasContexto: number;
  tentativasContinuacao: number;
}

/** `ignore` = o tratador não é deste evento; `handled` = tratou e o laço segue. */
type Verdict = ResultadoConsumo | 'handled' | 'ignore';

function parar(loop: Loop, halt: StepHalt): ResultadoConsumo {
  return { halt, resultado: loop.acc.result() };
}

function enviar(loop: Loop, texto: string): void {
  void loop.deps.client.session
    .prompt({
      path: { id: loop.sessionId },
      body: { model: loop.deps.model, parts: [{ type: 'text', text: texto }] },
    })
    .catch(() => {
      /* falha de envio aparece como turno que nunca fecha → timeout */
    });
}

async function onPermission(loop: Loop, evt: Event): Promise<Verdict> {
  const perm = permissionFrom(evt);
  if (!perm) return 'ignore';
  const decisao = loop.decider.decide(perm.subject, loop.task.profile);
  if (decisao === 'park') return parar(loop, haltDe('approval', perm.subject));
  await responderPermissao(loop.deps.client, perm, decisao === 'allow');
  return 'handled';
}

async function onQuestion(loop: Loop, evt: Event): Promise<Verdict> {
  const pergunta = questionFrom(evt);
  if (!pergunta) return 'ignore';
  // Rejeita ANTES de sair: sem resposta o motor fica preso esperando.
  await rejeitarPergunta(loop.deps.baseUrl, pergunta);
  return parar(loop, haltDe('question', pergunta.subject));
}

/**
 * Sessão NOVA, não reenvio: é o histórico acumulado que estourou — insistir na mesma
 * sessão bateria no mesmo teto imediatamente.
 */
async function recuperarContexto(loop: Loop, nome: string): Promise<Verdict> {
  if (loop.tentativasContexto >= MAX_CONTEXT_RETRIES) {
    return parar(
      loop,
      haltErroDoMotor(
        nome,
        `estouro de contexto — ${MAX_CONTEXT_RETRIES} tentativa(s) de recuperação esgotada(s)`,
      ),
    );
  }
  loop.tentativasContexto++;
  const digest = digestoDeRecuperacao(
    loop.task,
    loop.step,
    loop.priorSteps,
    loop.acc.result().text,
  );
  loop.sessionId = await criarSessaoNova(loop.deps, loop.task, ' (cont.)');
  loop.onSessionChange(loop.sessionId);
  loop.acc = createStepAccumulator(); // descarta o acumulado contaminado — o digest leva o resumo
  enviar(loop, digest);
  return 'handled';
}

/**
 * MESMA sessão: o problema é o teto de UMA geração, não o histórico acumulado. O
 * acumulador não é resetado — a parte nova concatena com a parcial de antes (ids de
 * part diferentes, ver step-events.ts).
 */
function continuarSaida(loop: Loop, nome: string): Verdict {
  if (loop.tentativasContinuacao >= MAX_CONTINUATION_RETRIES) {
    return parar(
      loop,
      haltErroDoMotor(
        nome,
        `resposta cortada repetidamente — ${MAX_CONTINUATION_RETRIES} tentativa(s) de continuação esgotada(s)`,
      ),
    );
  }
  loop.tentativasContinuacao++;
  enviar(loop, PROMPT_CONTINUAR);
  return 'handled';
}

async function onEngineError(loop: Loop, evt: Event): Promise<Verdict> {
  const erro = engineErrorFrom(evt);
  if (!erro) return 'ignore';
  if (erro.kind === 'context_overflow') return recuperarContexto(loop, erro.name);
  if (erro.kind === 'output_length') return continuarSaida(loop, erro.name);
  // 'other': erro genuíno do motor, sem recuperação conhecida.
  return parar(loop, haltErroDoMotor(erro.name, erro.message));
}

/** Primeiro tratador que reconhecer o evento decide; ordem = prioridade. */
async function dispatch(loop: Loop, evt: Event): Promise<Verdict> {
  for (const handler of [onPermission, onQuestion, onEngineError]) {
    const verdict = await handler(loop, evt);
    if (verdict !== 'ignore') return verdict;
  }
  return 'ignore';
}

export async function consumeStep(
  deps: OpencodeExecutorDeps,
  args: {
    decider: PermissionDecider;
    sessionId: string;
    step: TaskStep;
    task: Task;
    priorSteps: readonly TaskStep[];
    ac: AbortController;
    onSessionChange: (novoId: string) => void;
  },
): Promise<ResultadoConsumo> {
  const { ac, sessionId, ...rest } = args;
  const loop: Loop = {
    deps,
    ...rest,
    sessionId,
    acc: createStepAccumulator(),
    promptEnviado: false,
    tentativasContexto: 0,
    tentativasContinuacao: 0,
  };

  for await (const evt of deps.subscribe(deps.client, ac.signal)) {
    // `null` = (re)conectou. Na primeira vez é o sinal de que dá pra mandar o
    // prompt sem perder evento; nas seguintes é reconexão — reenviar duplicaria o turno.
    if (evt === null) {
      if (!loop.promptEnviado) {
        loop.promptEnviado = true;
        enviar(loop, buildStepPrompt(loop.task, loop.step));
      }
      continue;
    }
    if (ac.signal.aborted) return parar(loop, haltDe('timeout', loop.step.name));
    if (ehDeOutraSessao(evt, loop.sessionId)) continue;

    const verdict = await dispatch(loop, evt);
    if (verdict === 'handled') continue;
    if (verdict !== 'ignore') return verdict;

    loop.acc.apply(evt);
    if (isTurnEnd(evt)) return { halt: undefined, resultado: loop.acc.result() };
  }
  // Stream acabou sem `idle`: o `subscribeEvents` só sai por abort.
  return parar(loop, haltDe('timeout', loop.step.name));
}
