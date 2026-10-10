import { test, expect } from 'bun:test';
import {
  shouldAbortCompaction,
  toolAttempts,
  failedTools,
  applyEvent,
  emptyChat,
} from './state.js';
import { ev, toolPart, reasoningPart } from './state.test-helpers.js';

test('ACEITE: estouro de contexto é normalizado, mesmo chegando como APIError cru', () => {
  // O caso real veio como a mensagem crua do vLLM. Sem normalizar aqui, a TUI mostrava
  // "erro no motor" e ninguém disparava a recuperação — a sessão morria de vez.
  const cru =
    "This model's maximum context length is 98304 tokens. However, you requested 2048 " +
    'output tokens and your prompt contains at least 96257 input tokens';
  const s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.error', { error: { name: 'APIError', data: { message: cru } } }),
  );

  expect(s.error?.name).toBe('ContextOverflowError'); // é o que dispara a recuperação
  expect(s.error?.message).toContain('janela de contexto estourou');
  expect(s.busy).toBe(false);
});

test('estouro nomeado pelo motor também é reconhecido', () => {
  const s = applyEvent(
    emptyChat,
    ev('session.error', { error: { name: 'ContextOverflowError', data: { message: 'x' } } }),
  );
  expect(s.error?.name).toBe('ContextOverflowError');
});

test('APIError comum não vira estouro (a recuperação não pode disparar à toa)', () => {
  const s = applyEvent(
    emptyChat,
    ev('session.error', { error: { name: 'APIError', data: { message: 'connection reset' } } }),
  );
  expect(s.error?.name).toBe('APIError');
});

test('ACEITE: custom:true chega ao estado — é a saída pra opção que não cobre o caso', () => {
  // Sem isto, uma pergunta mal formulada prende o usuário nas opções oferecidas.
  const s = applyEvent(
    emptyChat,
    ev('question.asked', {
      requestID: 'req_1',
      sessionID: 'ses_1',
      questions: [{ question: 'Qual dataset?', custom: true, options: [{ label: 'COMERCIAL' }] }],
    }),
  );
  expect(s.questions[0]!.questions[0]!.custom).toBe(true);
});

test('pergunta sem custom não vira campo livre por acidente', () => {
  const s = applyEvent(
    emptyChat,
    ev('question.asked', {
      requestID: 'req_2',
      sessionID: 'ses_1',
      questions: [{ question: 'Apagar?', options: [{ label: 'sim' }, { label: 'não' }] }],
    }),
  );
  expect(s.questions[0]!.questions[0]!.custom).toBe(false);
});

test('question.rejected tira a pergunta da fila (antes ficava órfã)', () => {
  let s = applyEvent(
    emptyChat,
    ev('question.asked', {
      requestID: 'req_3',
      sessionID: 'ses_1',
      questions: [{ question: 'x', options: [{ label: 'a' }] }],
    }),
  );
  expect(s.questions).toHaveLength(1);
  s = applyEvent(s, ev('question.rejected', { requestID: 'req_3' }));
  expect(s.questions).toHaveLength(0);
});

test('família question.v2.* é tratada igual à v1 (o motor emite qualquer uma)', () => {
  let s = applyEvent(
    emptyChat,
    ev('question.v2.asked', {
      requestID: 'req_4',
      sessionID: 'ses_1',
      questions: [
        {
          question: 'Qual período?',
          multiple: true,
          options: [{ label: '2025' }, { label: '2026' }],
        },
      ],
    }),
  );
  expect(s.questions).toHaveLength(1);
  expect(s.questions[0]!.questions[0]!.multi).toBe(true);

  s = applyEvent(s, ev('question.v2.replied', { requestID: 'req_4' }));
  expect(s.questions).toHaveLength(0);
});

test('ACEITE: compactação pedida pela TUI não é abortada (bug de prod)', () => {
  // A proativa roda com a sessão OCIOSA — userTurnActive falso é a condição normal
  // dela, não sinal de emenda intrusa. Abortar aqui impedia qualquer compactação.
  expect(shouldAbortCompaction({ userTurnActive: false, requestedByTui: true })).toBe(false);
});

test('emenda que ninguém pediu continua sendo abortada', () => {
  expect(shouldAbortCompaction({ userTurnActive: false, requestedByTui: false })).toBe(true);
});

test('turno do usuário em curso nunca é morto, venha o que vier', () => {
  expect(shouldAbortCompaction({ userTurnActive: true, requestedByTui: false })).toBe(false);
  expect(shouldAbortCompaction({ userTurnActive: true, requestedByTui: true })).toBe(false);
});

test('ACEITE: o raciocínio atribuído é o ANTERIOR à chamada (a causa, não a consequência)', () => {
  const msgs = [
    {
      id: 'm1',
      role: 'assistant' as const,
      parts: [
        reasoningPart('vou supor que a tabela é VENDAS'),
        toolPart('nio_fabric_query', 'error', { dax: 'a' }, 'Cannot find table'),
        reasoningPart('agora entendi, é VISAO_COMERCIAL'),
        toolPart('nio_fabric_query', 'completed', { dax: 'b' }),
      ],
    },
  ];
  const attempts = toolAttempts(msgs);

  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.reasoning).toBe('vou supor que a tabela é VENDAS'); // causa do erro
  expect(attempts[1]!.reasoning).toBe('agora entendi, é VISAO_COMERCIAL');
});

test('raciocínio não vaza para a chamada seguinte quando não há um novo', () => {
  const msgs = [
    {
      id: 'm1',
      role: 'assistant' as const,
      parts: [
        reasoningPart('pensei uma vez'),
        toolPart('a', 'completed', {}),
        toolPart('b', 'completed', {}),
      ],
    },
  ];
  const attempts = toolAttempts(msgs);
  expect(attempts[0]!.reasoning).toBe('pensei uma vez');
  expect(attempts[1]!.reasoning).toBeUndefined();
});

test('failedTools lista só o que realmente falhou nesta sessão', () => {
  const msgs = [
    {
      id: 'm1',
      role: 'assistant' as const,
      parts: [
        toolPart('bash', 'error', {}, 'x'),
        toolPart('read', 'completed', {}),
        toolPart('bash', 'error', {}, 'y'),
      ],
    },
  ];
  expect(failedTools(msgs)).toEqual(['bash']);
});

test('histórico sem tool nenhuma → nada a aprender', () => {
  expect(
    toolAttempts([{ id: 'm', role: 'assistant', parts: [reasoningPart('só pensei')] }]),
  ).toEqual([]);
});

test('ACEITE: request em voo nunca é morta, mesmo sem turno marcado como ativo', () => {
  // A regra que o dono pediu: enquanto houver o que processar com retorno pendente,
  // a request não pode morrer. `userTurnActive` sozinho não cobre — ele é zerado no
  // primeiro `idle`, que pode chegar entre passos de um turno agêntico.
  expect(
    shouldAbortCompaction({ userTurnActive: false, requestedByTui: false, workInFlight: true }),
  ).toBe(false);
});

test('sem nada em voo e sem pedido, a emenda intrusa segue sendo abortada', () => {
  expect(
    shouldAbortCompaction({ userTurnActive: false, requestedByTui: false, workInFlight: false }),
  ).toBe(true);
});

// Bug de produção (28/09): a fila é esvaziada na hora ao responder, mas o resync
// logo em seguida ainda via o pedido no servidor e o RESSUSCITAVA. O modal voltava
// e responder de novo repetia o ciclo — sem saída.
