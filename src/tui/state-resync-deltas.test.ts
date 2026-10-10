import { test, expect } from 'bun:test';
import {
  applyDeltas,
  applyEvent,
  reconcilePendingPermissions,
  reconcilePendingQuestions,
  emptyChat,
  replyFailed,
  replyErrorDetail,
} from './state.js';
import { ev, delta } from './state.test-helpers.js';

test('resync não ressuscita permissão já respondida (tombstone)', () => {
  const asked = applyEvent(
    emptyChat,
    ev('permission.asked', {
      id: 'p1',
      sessionID: 's',
      permission: 'bash',
      metadata: { command: 'ls' },
    }),
  );
  // o usuário respondeu: some da fila local e o id entra no tombstone
  const respondido = { ...asked, permissions: [] };
  const settled = new Set(['p1']);
  const doServidor = [{ id: 'p1', sessionID: 's', permission: 'bash' }];

  const depois = reconcilePendingPermissions(respondido, doServidor, settled);
  expect(depois.permissions).toHaveLength(0); // não voltou
});

test('resync não ressuscita pergunta já respondida (tombstone)', () => {
  const respondido = { ...emptyChat, questions: [] };
  const settled = new Set(['q1']);
  const doServidor = [
    { requestID: 'q1', sessionID: 's', questions: [{ question: 'qual?', options: [] }] },
  ];

  expect(reconcilePendingQuestions(respondido, doServidor, settled).questions).toHaveLength(0);
});

test('tombstone é liberado quando o servidor esquece o id', () => {
  const settled = new Set(['q1']);
  // servidor não lista mais q1 → pode sair do tombstone, senão cresce para sempre
  reconcilePendingQuestions({ ...emptyChat, questions: [] }, [], settled);
  expect(settled.has('q1')).toBe(false);
});

test('sem tombstone, pedido novo do servidor ainda entra na fila', () => {
  const settled = new Set(['outro-id']);
  const doServidor = [
    { requestID: 'q2', sessionID: 's', questions: [{ question: 'nova?', options: [] }] },
  ];
  const depois = reconcilePendingQuestions({ ...emptyChat, questions: [] }, doServidor, settled);
  expect(depois.questions).toHaveLength(1);
  expect(depois.questions[0]!.id).toBe('q2');
});

test('4xx do client do opencode conta como falha, mesmo vindo resolvido', () => {
  // O SDK não lança em resposta não-2xx (`throwOnError` é falsy por padrão): um
  // 4xx chega numa promessa cumprida. Se isto virar `false`, o tombstone fica
  // preso e o modal some sem decisão enquanto o motor segue esperando.
  expect(replyFailed({ error: { message: 'permission ja consumida' } })).toBe(true);
  expect(replyFailed({ error: {} })).toBe(true);
});

test('reply aceito pelo server não é falha, mesmo com envelope do SDK', () => {
  expect(replyFailed({ data: { reply: 'ok' }, request: {}, response: {} })).toBe(false);
  expect(replyFailed({ data: undefined, error: undefined })).toBe(false);
  expect(replyFailed(undefined)).toBe(false);
  expect(replyFailed(null)).toBe(false);
});

test('fetch cru segue o ok, não o envelope', () => {
  expect(replyFailed({ ok: false, status: 409 })).toBe(true);
  expect(replyFailed({ ok: true, status: 200 })).toBe(false);
});

test('replyErrorDetail extrai a recusa e não inventa motivo no sucesso', () => {
  expect(replyErrorDetail({ error: { message: 'permission ja consumida' } })).toBe(
    'permission ja consumida',
  );
  expect(replyErrorDetail({ error: 'texto puro' })).toBe('texto puro');
  expect(replyErrorDetail({ ok: false, status: 409 })).toBe(''); // sem corpo: o status já vai no log
  expect(replyErrorDetail({ data: {} })).toBe('');
  expect(replyErrorDetail({ error: { message: 'x'.repeat(500) } })).toHaveLength(200);
});

// Bug de produção (29/09): usuário manda a request, a CLI "pensa" e o turno morre
// sem nada na tela. A condição exigia `err.name`; sem ele o evento era descartado
// — mas `busy` já virara false logo acima, então o spinner sumia e nenhum erro
// aparecia. Provider OpenAI-compatível (nio-local) erra fora do formato nomeado.
test('session.error SEM name ainda vira erro visível (não morre calado)', () => {
  const s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.error', {
      error: { data: { message: 'upstream connect error or disconnect/reset' } },
    }),
  );
  expect(s.busy).toBe(false);
  expect(s.error).not.toBeNull();
  expect(s.error!.message).toContain('upstream connect error');
});

test('session.error sem payload nenhum também aparece', () => {
  const s = applyEvent({ ...emptyChat, busy: true }, ev('session.error', {}));
  expect(s.error).not.toBeNull();
  expect(s.error!.name).toBe('EngineError');
  expect(s.error!.message).toBe('erro no motor');
});

test('overflow sem name é detectado pela mensagem e vira ContextOverflowError', () => {
  const s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.error', {
      error: { data: { message: "This model's maximum context length is 32768 tokens" } },
    }),
  );
  expect(s.error!.name).toBe('ContextOverflowError');
});

test('Esc do usuário (MessageAbortedError) segue sem mostrar erro', () => {
  const s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.error', {
      error: { name: 'MessageAbortedError' },
    }),
  );
  expect(s.busy).toBe(false);
  expect(s.error).toBeNull();
});

test('RACE DO RESYNC — permissão que chegou por SSE depois do snapshot não é apagada', () => {
  const snapshotAt = 1_000;
  // snapshot (GET /permission) foi tirado ANTES de p_new existir no servidor → vem vazio
  const asked = applyEvent(
    emptyChat,
    ev('permission.asked', { id: 'p_new', sessionID: 's', permission: 'bash', patterns: ['ls'] }),
  );
  const nowStamp = asked.permissions[0]!;
  const fresh = { ...asked, permissions: [{ ...nowStamp, receivedAt: snapshotAt + 5 }] };
  expect(reconcilePendingPermissions(fresh, [], undefined, snapshotAt).permissions).toHaveLength(1);

  // já estava na fila ANTES do snapshot e o servidor não lista mais → sai (respondida noutro lugar)
  const stale = { ...asked, permissions: [{ ...nowStamp, receivedAt: snapshotAt - 5 }] };
  expect(reconcilePendingPermissions(stale, [], undefined, snapshotAt).permissions).toHaveLength(0);

  // sem snapshotAt o comportamento antigo se mantém
  expect(reconcilePendingPermissions(fresh, []).permissions).toHaveLength(0);
});

test('RACE DO RESYNC — mesma regra para perguntas', () => {
  const snapshotAt = 1_000;
  const q = { id: 'q1', sessionId: 's', questions: [] };
  const base = { ...emptyChat, questions: [{ ...q, receivedAt: snapshotAt + 1 }] };
  expect(reconcilePendingQuestions(base, [], undefined, snapshotAt).questions).toHaveLength(1);
  const old = { ...emptyChat, questions: [{ ...q, receivedAt: snapshotAt - 1 }] };
  expect(reconcilePendingQuestions(old, [], undefined, snapshotAt).questions).toHaveLength(0);
});

test('tool bash: evento posterior sem input NÃO apaga o comando já conhecido', () => {
  const part = (state: Record<string, unknown>) =>
    ev('message.part.updated', {
      part: { type: 'tool', messageID: 'msg_a', id: 'prt_t', tool: 'bash', state },
    });
  let s = applyEvent(
    emptyChat,
    part({ status: 'pending', input: { command: 'git push --force origin main' } }),
  );
  s = applyEvent(s, part({ status: 'running' })); // sem input
  const tool = s.messages[0]!.parts[0]!.tool!;
  expect(tool.status).toBe('running');
  expect(tool.input).toEqual({ command: 'git push --force origin main' });
});

test('applyDeltas: deltas de texto concatenam no part, criando-o se o snapshot não veio', () => {
  const s = applyDeltas(emptyChat, [delta('text', 'Olá'), delta('text', ' mundo')]);
  const parts = s.messages.at(-1)!.parts;
  expect(parts).toHaveLength(1);
  expect(parts[0]!.kind).toBe('text');
  expect(parts[0]!.text).toBe('Olá mundo');
});

test('applyDeltas: `field: reasoning` vira part de raciocínio, separado do texto', () => {
  const s = applyDeltas(emptyChat, [
    delta('reasoning', 'pensando...', 'prt_r'),
    delta('text', 'resposta', 'prt_t'),
  ]);
  const parts = s.messages.at(-1)!.parts;
  expect(parts.find((p) => p.kind === 'reasoning')!.text).toBe('pensando...');
  expect(parts.find((p) => p.kind === 'text')!.text).toBe('resposta');
});

test('applyDeltas: field desconhecido e delta vazio são ignorados SEM novo objeto de estado', () => {
  // Identidade preservada = o Ink não redesenha de graça.
  expect(applyDeltas(emptyChat, [delta('tool_input', '{}')])).toBe(emptyChat);
  expect(applyDeltas(emptyChat, [delta('text', '')])).toBe(emptyChat);
  expect(applyDeltas(emptyChat, [])).toBe(emptyChat);
});

test('ACEITE: o snapshot é a autoridade — part.updated reconcilia em cima dos deltas', () => {
  // Deltas dão fluidez e podem driftar; o texto cheio do motor tem a última palavra.
  let s = applyDeltas(emptyChat, [delta('text', 'parci')]);
  expect(s.messages.at(-1)!.parts[0]!.text).toBe('parci');
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: { id: 'prt_1', messageID: 'msg_d', type: 'text', text: 'parcial completo' },
    }),
  );
  const textos = s.messages.at(-1)!.parts.filter((p) => p.kind === 'text');
  expect(textos).toHaveLength(1); // reconciliou o MESMO part, não criou um segundo
  expect(textos[0]!.text).toBe('parcial completo');
});

test('ACEITE: snapshot sem `text` não apaga o que os deltas já montaram', () => {
  let s = applyDeltas(emptyChat, [delta('text', 'mantém isto')]);
  s = applyEvent(
    s,
    ev('message.part.updated', { part: { id: 'prt_1', messageID: 'msg_d', type: 'text' } }),
  );
  expect(s.messages.at(-1)!.parts[0]!.text).toBe('mantém isto');
});
