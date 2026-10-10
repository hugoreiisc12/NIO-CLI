import type { ChatState, PermissionReq, QuestionItem, QuestionReq } from './state-types.js';

/** Rótulo humano por grupo de permissão. */
export function permGroupLabel(kind: string): string {
  const g: Record<string, string> = {
    bash: 'shell',
    edit: 'editar arquivo',
    read: 'ler arquivo',
    glob: 'listar arquivos',
    grep: 'buscar no código',
    webfetch: 'baixar URL',
    websearch: 'buscar na web',
    external_directory: 'acessar fora do projeto',
    doom_loop: 'continuar (possível loop)',
    task: 'sub-agente',
    skill: 'rodar skill',
    todowrite: 'atualizar checklist',
  };
  return g[kind] ?? (kind.includes('_') ? `MCP · ${kind}` : kind);
}

/**
 * Normaliza uma permissão pendente — venha ela do evento SSE (`permission.asked`/
 * `.updated`) ou do `GET /permission` (o `resync` usa isso). O REST manda
 * `permission`/`patterns`; o SDK tipa `type`/`pattern` — aceitamos os dois.
 * `sessionID` pode ser de um **sub-agente** (`task`): guardamos como veio, sem
 * filtrar — o `respondPermission` responde nessa sessão.
 */
export function toPermissionReq(raw: Record<string, unknown>): PermissionReq | null {
  const perm = raw as {
    id?: string;
    sessionID?: string;
    title?: string;
    permission?: string;
    type?: string;
    patterns?: string[];
    pattern?: string | string[];
    always?: string[];
    metadata?: { command?: string };
    tool?: { name?: string };
  };
  if (!perm.id || !perm.sessionID) return null;
  const kind = perm.permission ?? perm.type ?? perm.tool?.name ?? 'ação';
  const patterns =
    perm.patterns ??
    (Array.isArray(perm.pattern) ? perm.pattern : perm.pattern ? [perm.pattern] : []);
  return {
    id: perm.id,
    sessionId: perm.sessionID,
    kind,
    patterns,
    command: perm.metadata?.command,
    always: perm.always ?? [],
    title: perm.title ?? permGroupLabel(kind),
  };
}

/**
 * Reconcilia a fila de permissões com a verdade do server (`GET /permission`).
 * Sem isto, um `permission.asked` perdido (reconexão do SSE no meio, ou vindo de
 * um **sub-agente** que a TUI não estava ouvindo) trava o motor pra sempre em
 * "processando" — não há evento de repetição. Chamado no `resync` (a cada 4s
 * enquanto `busy`). Adiciona as novas (dedup por id), tira as que sumiram.
 */
/**
 * Tira do tombstone o que o servidor já esqueceu — o `settled` existe só para
 * cobrir a janela entre responder e o servidor refletir a resposta. Sem esta
 * limpeza ele cresceria para sempre, e um id reaproveitado nunca mais entraria.
 */
function forgetSettled(settled: Set<string> | undefined, liveIds: ReadonlySet<string>): void {
  if (!settled) return;
  for (const id of settled) if (!liveIds.has(id)) settled.delete(id);
}

/**
 * `settled` = ids já respondidos nesta TUI, aguardando o servidor processar.
 *
 * Sem ele o resync **ressuscita o que acabou de ser respondido**: a fila local é
 * limpa na hora (otimista), mas o `GET /permission` logo em seguida ainda lista o
 * pedido, e ele voltava como se fosse novo. O modal reaparecia e não havia como
 * sair — responder de novo só repetia o ciclo.
 */
/**
 * Itens da fila local que o `GET` não listou mas chegaram por SSE DEPOIS de o snapshot
 * começar: o snapshot é anterior a eles, então a ausência não prova que sumiram. Sem
 * isto o resync apagava o pedido recém-chegado e o modal só voltava ~4s depois, com o
 * motor parado esperando e o spinner dizendo "executando".
 */
function newerThanSnapshot<T extends { receivedAt?: number }>(r: T, snapshotAt?: number): boolean {
  return snapshotAt !== undefined && r.receivedAt !== undefined && r.receivedAt >= snapshotAt;
}

export function reconcilePendingPermissions(
  prev: ChatState,
  rawList: Array<Record<string, unknown>> | null,
  settled?: Set<string>,
  snapshotAt?: number,
): ChatState {
  if (rawList === null) return prev; // fetch falhou → mantém a fila (não apaga o modal)
  const live = rawList.map(toPermissionReq).filter((r): r is PermissionReq => r !== null);
  const liveIds = new Set(live.map((r) => r.id));
  forgetSettled(settled, liveIds);
  const kept = prev.permissions.filter(
    (r) => liveIds.has(r.id) || newerThanSnapshot(r, snapshotAt),
  );
  const known = new Set(kept.map((r) => r.id));
  const added = live.filter((r) => !known.has(r.id) && !settled?.has(r.id));
  if (added.length === 0 && kept.length === prev.permissions.length) return prev;
  return { ...prev, permissions: [...kept, ...added] };
}

/**
 * Normaliza um pedido de `question` — do evento SSE (`question.asked`/`.updated`) ou
 * do `GET /session/:id/question` (resync). `requestID` é o id do reply; as perguntas
 * podem vir no topo (`questions`) ou em `input.questions`. `null` se malformado.
 */
export function toQuestionReq(raw: Record<string, unknown>): QuestionReq | null {
  const r = raw as {
    id?: string;
    requestID?: string;
    sessionID?: string;
    questions?: Array<Record<string, unknown>>;
    input?: { questions?: Array<Record<string, unknown>> };
  };
  const id = r.requestID ?? r.id;
  if (!id || !r.sessionID) return null;
  const rawQs = r.questions ?? r.input?.questions ?? [];
  const questions: QuestionItem[] = rawQs.map((q) => ({
    question: String(q.question ?? ''),
    header: q.header ? String(q.header) : undefined,
    multi: Boolean(q.multi ?? q.multiple),
    custom: Boolean(q.custom),
    options: ((q.options as Array<Record<string, unknown>>) ?? []).map((o) => ({
      label: String(o.label ?? o.value ?? o ?? ''),
      description: o.description ? String(o.description) : undefined,
    })),
  }));
  return { id: String(id), sessionId: String(r.sessionID), questions };
}

/** Reconcilia a fila de perguntas com a verdade do server (`GET /session/:id/question`). */
export function reconcilePendingQuestions(
  prev: ChatState,
  rawList: Array<Record<string, unknown>> | null,
  settled?: Set<string>,
  snapshotAt?: number,
): ChatState {
  if (rawList === null) return prev; // fetch falhou → mantém a fila (não apaga a pergunta)
  const live = rawList.map(toQuestionReq).filter((r): r is QuestionReq => r !== null);
  const liveIds = new Set(live.map((r) => r.id));
  forgetSettled(settled, liveIds);
  const kept = prev.questions.filter((r) => liveIds.has(r.id) || newerThanSnapshot(r, snapshotAt));
  const known = new Set(kept.map((r) => r.id));
  const added = live.filter((r) => !known.has(r.id) && !settled?.has(r.id));
  if (added.length === 0 && kept.length === prev.questions.length) return prev;
  return { ...prev, questions: [...kept, ...added] };
}
