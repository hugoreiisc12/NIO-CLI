import { test, expect } from 'bun:test';
import {
  applyEvent,
  reconcilePendingPermissions,
  reconcilePendingQuestions,
  emptyChat,
  summarizeToolInput,
  contextUsage,
  stripReasoningTags,
  shouldCompact,
} from './state.js';
import type { ChatMessage } from './state.js';
import { ev } from './state.test-helpers.js';

test('stripReasoningTags: tira <think> fechado, tag aberta sem fechar, e vários pares', () => {
  expect(stripReasoningTags('antes<think>raciocínio</think>depois')).toBe('antesdepois');
  expect(stripReasoningTags('resposta<think>pensando sem fim')).toBe('resposta'); // aberto sem fechar
  expect(stripReasoningTags('a<thinking>x</thinking>b◁think▷y◁/think▷c')).toBe('abc');
  expect(stripReasoningTags('sem tag nenhuma')).toBe('sem tag nenhuma'); // no-op
});

test('shouldCompact: dispara ao cruzar o teto menos a folga; ignora casos degenerados', () => {
  const ctx = 65536;
  const reserved = 8000; // teto efetivo = 57536
  expect(shouldCompact(57535, ctx, reserved)).toBe(false); // 1 abaixo
  expect(shouldCompact(57536, ctx, reserved)).toBe(true); // exatamente no teto efetivo
  expect(shouldCompact(60000, ctx, reserved)).toBe(true); // acima
  expect(shouldCompact(1000, ctx, reserved)).toBe(false); // bem abaixo
  expect(shouldCompact(60000, 0, reserved)).toBe(false); // contexto inválido → nunca
  expect(shouldCompact(0, ctx, reserved)).toBe(false); // sem tokens → nunca
});

test('computePart: <think> inline num part de texto NÃO chega ao output (Item 1)', () => {
  let s = applyEvent(emptyChat, ev('message.updated', { info: { id: 'm', role: 'assistant' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: { type: 'text', messageID: 'm', id: 't1', text: '<think>oculto</think>Resposta final' },
    }),
  );
  const msg = s.messages.find((x) => x.role === 'assistant')!;
  const text = msg.parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('');
  expect(text).toBe('Resposta final');
  expect(text).not.toContain('oculto');
});

test('part type:compaction NÃO vira texto no output (não vaza o resumo interno)', () => {
  let s = applyEvent(emptyChat, ev('message.updated', { info: { id: 'm', role: 'assistant' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'compaction',
        messageID: 'm',
        id: 'c1',
        text: 'RESUMO INTERNO que não deve aparecer',
      },
    }),
  );
  const msg = s.messages.find((x) => x.role === 'assistant')!;
  expect(msg.parts.some((p) => p.kind === 'text')).toBe(false);
  expect(JSON.stringify(msg.parts)).not.toContain('RESUMO INTERNO');
});

test('Task 2 — contextUsage: input de pico + output somado do último turno', () => {
  const step = (id: string, input: number, output: number): ChatMessage['parts'][number] => ({
    id,
    kind: 'step',
    text: '',
    step: { tokensIn: input, tokensOut: output, cost: 0 },
  });
  const messages: ChatMessage[] = [
    { id: 'a1', role: 'assistant', parts: [step('s1', 5000, 999)] }, // turno antigo — ignorado
    { id: 'u1', role: 'user', parts: [{ id: 'p', kind: 'text', text: 'oi' }] },
    { id: 'a2', role: 'assistant', parts: [step('s2', 20000, 100), step('s3', 31000, 400)] }, // último turno
  ];
  // input = MAIOR tokensIn do último turno (31000, não a soma 51000); output = SOMA (500).
  expect(contextUsage(messages)).toEqual({ tokensIn: 31000, tokensOut: 500 });
  // sem turno com uso → {0,0}.
  expect(
    contextUsage([{ id: 'u', role: 'user', parts: [{ id: 'p', kind: 'text', text: 'oi' }] }]),
  ).toEqual({ tokensIn: 0, tokensOut: 0 });
  expect(contextUsage([])).toEqual({ tokensIn: 0, tokensOut: 0 });
});

test('Sprint 2 — summarizeToolInput pega o campo mais útil', () => {
  expect(summarizeToolInput({ filePath: 'x.ts', extra: 1 })).toBe('x.ts');
  expect(summarizeToolInput({ command: 'bun test' })).toBe('bun test');
  expect(summarizeToolInput({ pattern: 'TODO', path: 'src' })).toBe('TODO'); // pattern (grep) antes de path
  expect(summarizeToolInput({ foo: 'bar' })).toBe('bar');
  expect(summarizeToolInput(undefined)).toBe('');
});

test('permission.updated → entra na fila; replied remove por id (Sprint 7.1)', () => {
  let s = applyEvent(
    emptyChat,
    ev('permission.updated', {
      id: 'perm_1',
      sessionID: 'ses_1',
      title: 'rodar bash `rm`',
      type: 'bash',
      patterns: ['rm -rf x'],
    }),
  );
  expect(s.permissions).toHaveLength(1);
  expect(s.permissions[0]).toMatchObject({
    id: 'perm_1',
    sessionId: 'ses_1',
    kind: 'bash',
    patterns: ['rm -rf x'],
  });
  s = applyEvent(
    s,
    ev('permission.replied', { sessionID: 'ses_1', permissionID: 'perm_1', response: 'reject' }),
  );
  expect(s.permissions).toEqual([]);
});

test('permission.asked — kind, patterns, command (metadata) e always', () => {
  const s = applyEvent(
    emptyChat,
    ev('permission.asked', {
      id: 'per_x',
      sessionID: 'ses_2',
      permission: 'read',
      patterns: ['proj/.env'],
      always: ['*'],
    }),
  );
  expect(s.permissions[0]).toMatchObject({
    id: 'per_x',
    sessionId: 'ses_2',
    kind: 'read',
    patterns: ['proj/.env'],
    always: ['*'],
  });

  const b = applyEvent(
    emptyChat,
    ev('permission.asked', {
      id: 'per_b',
      sessionID: 'ses_2',
      permission: 'bash',
      patterns: ['find src', 'sort'],
      always: ['find *', 'sort *'],
      metadata: { command: 'find src | sort' },
    }),
  );
  expect(b.permissions[0].command).toBe('find src | sort');
});

test('reconcilePendingPermissions — recupera permissão perdida (sub-agente) e tira as que sumiram', () => {
  // a TUI não viu o `permission.asked` (veio de um sub-agente `task`) → fila vazia,
  // mas o `GET /permission` mostra 2 pendentes.
  const live = [
    {
      id: 'per_sub1',
      sessionID: 'ses_child',
      permission: 'bash',
      patterns: ['ls -la'],
      metadata: { command: 'cd x && ls -la' },
    },
    { id: 'per_sub2', sessionID: 'ses_child', permission: 'bash', patterns: ['git log'] },
  ];
  let s = reconcilePendingPermissions(emptyChat, live);
  expect(s.permissions.map((p) => p.id)).toEqual(['per_sub1', 'per_sub2']);
  expect(s.permissions[0]).toMatchObject({
    sessionId: 'ses_child',
    kind: 'bash',
    command: 'cd x && ls -la',
  });

  // já tinha uma na fila (per_a) que o server não lista mais (respondida noutro lugar) → sai
  s = {
    ...s,
    permissions: [
      { id: 'per_a', sessionId: 's', kind: 'bash', patterns: [], always: [], title: 'shell' },
      ...s.permissions,
    ],
  };
  s = reconcilePendingPermissions(s, live);
  expect(s.permissions.map((p) => p.id)).toEqual(['per_sub1', 'per_sub2']);

  // idempotente: mesma lista → mesma referência (sem re-render à toa)
  expect(reconcilePendingPermissions(s, live)).toBe(s);
});

test('BATCH PARALELO — 3 permission.asked = 3 na fila (não sobrescreve); responder faz shift', () => {
  let s = emptyChat;
  for (const id of ['p1', 'p2', 'p3']) {
    s = applyEvent(
      s,
      ev('permission.asked', { id, sessionID: 's', permission: 'bash', patterns: [`cmd ${id}`] }),
    );
  }
  expect(s.permissions.map((x) => x.id)).toEqual(['p1', 'p2', 'p3']);
  // evento repetido do mesmo id → não duplica
  s = applyEvent(
    s,
    ev('permission.asked', { id: 'p2', sessionID: 's', permission: 'bash', patterns: ['x'] }),
  );
  expect(s.permissions).toHaveLength(3);
  // responde o p1 (via replied vindo do server)
  s = applyEvent(s, ev('permission.replied', { permissionID: 'p1', response: 'once' }));
  expect(s.permissions.map((x) => x.id)).toEqual(['p2', 'p3']);
});

test('tool question — question.asked entra na fila estruturada; replied remove por requestID', () => {
  let s = applyEvent(
    emptyChat,
    ev('question.asked', {
      requestID: 'q1',
      sessionID: 'ses_1',
      questions: [
        {
          question: 'Qual passo?',
          header: 'Próximo',
          options: [{ label: 'Plan', description: 'd' }, { label: 'Review' }],
        },
      ],
    }),
  );
  expect(s.questions).toHaveLength(1);
  expect(s.questions[0]).toMatchObject({ id: 'q1', sessionId: 'ses_1' });
  expect(s.questions[0].questions[0].question).toBe('Qual passo?');
  expect(s.questions[0].questions[0].options.map((o) => o.label)).toEqual(['Plan', 'Review']);
  // evento repetido do mesmo id → não duplica
  s = applyEvent(s, ev('question.updated', { requestID: 'q1', sessionID: 'ses_1', questions: [] }));
  expect(s.questions).toHaveLength(1);
  // replied remove por requestID
  s = applyEvent(s, ev('question.replied', { requestID: 'q1', sessionID: 'ses_1' }));
  expect(s.questions).toEqual([]);
});

test('reconcilePendingQuestions — recupera a perdida e tira as que sumiram; idempotente', () => {
  const live = [
    { requestID: 'qa', sessionID: 's', questions: [{ question: 'x?', options: [{ label: 'y' }] }] },
  ];
  const s = reconcilePendingQuestions(emptyChat, live);
  expect(s.questions.map((q) => q.id)).toEqual(['qa']);
  expect(reconcilePendingQuestions(s, live)).toBe(s); // idempotente
  expect(reconcilePendingQuestions(s, []).questions).toEqual([]); // sumiu do server → sai
});
