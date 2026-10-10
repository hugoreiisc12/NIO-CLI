import { test, expect } from 'bun:test';
import {
  applyEvent,
  pushUserMessage,
  emptyChat,
  pendingQuestion,
  questionOptions,
  looksLikeScaffolding,
  isInternalMessage,
} from './state.js';
import type { ChatMessage } from './state.js';
import { ev } from './state.test-helpers.js';

test('looksLikeScaffolding — detecta o bloco work-state (≥3 headers), ignora prosa normal', () => {
  const block =
    '## Objective\n- listar tools\n\n## Work State\nCompleted\n- feito\n\n## Next Move\n1. aguardar';
  expect(looksLikeScaffolding(block)).toBe(true);
  expect(looksLikeScaffolding('Aqui está a resposta: os arquivos foram criados com sucesso.')).toBe(
    false,
  );
  expect(looksLikeScaffolding('## Objective\nsó um header, não é scaffolding')).toBe(false); // <3
});

test('isInternalMessage — flag mode:compaction/summary OU texto-scaffolding; resposta normal = false', () => {
  const scaffold: ChatMessage = {
    id: 'a',
    role: 'assistant',
    parts: [{ id: 't', kind: 'text', text: '## Objective\nx\n## Work State\ny\n## Next Move\nz' }],
  };
  expect(isInternalMessage(scaffold)).toBe(true);
  const compact: ChatMessage = {
    id: 'b',
    role: 'assistant',
    mode: 'compaction',
    parts: [{ id: 't', kind: 'text', text: 'resumo' }],
  };
  expect(isInternalMessage(compact)).toBe(true);
  const summary: ChatMessage = { id: 'c', role: 'assistant', summary: true, parts: [] };
  expect(isInternalMessage(summary)).toBe(true);
  const normal: ChatMessage = {
    id: 'd',
    role: 'assistant',
    parts: [{ id: 't', kind: 'text', text: 'resposta normal ao usuário' }],
  };
  expect(isInternalMessage(normal)).toBe(false);
});

test('message.updated captura mode:compaction/summary na mensagem (→ ofuscada)', () => {
  const s = applyEvent(
    emptyChat,
    ev('message.updated', {
      info: { id: 'm', role: 'assistant', mode: 'compaction', summary: true },
    }),
  );
  const m = s.messages.find((x) => x.id === 'm')!;
  expect(m.mode).toBe('compaction');
  expect(m.summary).toBe(true);
  expect(isInternalMessage(m)).toBe(true);
});

test('session.status idle também limpa busy', () => {
  const s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.status', { status: { type: 'idle' } }),
  );
  expect(s.busy).toBe(false);
});

test('Sprint 7.3 — session.error: ProviderAuthError vira bloco com dica; abort não mostra nada', () => {
  let s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.error', {
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'opencode', message: 'token expired' },
      },
    }),
  );
  expect(s.busy).toBe(false);
  expect(s.error).toEqual({
    name: 'ProviderAuthError',
    message: 'credencial do provedor inválida — rode `opencode auth login`',
    retryable: false,
  });

  // APIError retryable
  s = applyEvent(
    emptyChat,
    ev('session.error', {
      error: { name: 'APIError', data: { message: '503 upstream', isRetryable: true } },
    }),
  );
  expect(s.error).toEqual({ name: 'APIError', message: '503 upstream', retryable: true });

  // MessageAbortedError (usuário apertou Esc) → não vira erro
  s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.error', {
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    }),
  );
  expect(s.error).toBeNull();
  expect(s.busy).toBe(false);

  // novo prompt limpa o erro
  const withErr = { ...emptyChat, error: { name: 'APIError', message: 'x', retryable: true } };
  expect(pushUserMessage(withErr, 'de novo').error).toBeNull();
});

test('Sprint 7.4 — pendingQuestion: assistant termina com "?" e parou → devolve a pergunta', () => {
  const asst = (text: string): ChatMessage => ({
    id: 'a',
    role: 'assistant',
    parts: [{ id: 't', kind: 'text', text }],
  });

  const q = {
    ...emptyChat,
    busy: false,
    messages: [asst('Fiz X e Y.\nQuer que eu rode os testes agora?')],
  };
  expect(pendingQuestion(q)).toBe('Quer que eu rode os testes agora?');

  // sem "?" → null
  expect(pendingQuestion({ ...emptyChat, messages: [asst('Pronto, tudo verde.')] })).toBeNull();
  // ainda processando → null
  expect(pendingQuestion({ ...q, busy: true })).toBeNull();
  // tem permissão na fila → null (a permissão vem primeiro)
  expect(
    pendingQuestion({
      ...q,
      permissions: [{ id: 'p', sessionId: 's', kind: 'bash', patterns: [], always: [], title: '' }],
    }),
  ).toBeNull();
  // última msg é do user → null
  expect(
    pendingQuestion({
      ...emptyChat,
      messages: [
        asst('e aí?'),
        { id: 'u', role: 'user', parts: [{ id: 'x', kind: 'text', text: 'sim' }] },
      ],
    }),
  ).toBeNull();
  // "?" só dentro de bloco de código não conta
  expect(
    pendingQuestion({ ...emptyChat, messages: [asst('rode isto:\n```\necho "ok?"\n```')] }),
  ).toBeNull();
});

test('Sprint 7.3 — session.compacted e installation.update-available viram toast', () => {
  expect(
    applyEvent(emptyChat, ev('session.compacted', { sessionID: 's' })).toasts[0].message,
  ).toContain('compactado');
  expect(
    applyEvent(emptyChat, ev('installation.update-available', { version: '1.19.0' })).toasts[0]
      .message,
  ).toContain('1.19.0');
});

test('Sprint 7.6 — questionOptions: parseia menu numerado/marcado; < 2 → []', () => {
  const asst = (text: string): ChatMessage => ({
    id: 'a',
    role: 'assistant',
    parts: [{ id: 't', kind: 'text', text }],
  });

  const s = {
    ...emptyChat,
    messages: [asst('Por onde começo?\n1. Pelo core\n2) Pelos adapters\n3. Pelos testes')],
  };
  expect(questionOptions(s)).toEqual(['Pelo core', 'Pelos adapters', 'Pelos testes']);

  // checkbox e letras
  expect(
    questionOptions({
      ...emptyChat,
      messages: [asst('Escolha:\n- [ ] opção A\n- [ ] opção B\n?')],
    }),
  ).toEqual(['opção A', 'opção B']);

  // só 1 item → não é menu
  expect(questionOptions({ ...emptyChat, messages: [asst('Faço assim?\n1. sim')] })).toEqual([]);
  // sem pergunta → []
  expect(
    questionOptions({ ...emptyChat, messages: [asst('Feito:\n1. core\n2. adapters')] }),
  ).toEqual([]);
  // dentro de código não conta
  expect(
    questionOptions({ ...emptyChat, messages: [asst('rode?\n```\n1. x\n2. y\n```')] }),
  ).toEqual([]);
});

test('Sprint 7.8 — session.diff vira o resumo de arquivos +/−; prompt limpa', () => {
  const s = applyEvent(
    emptyChat,
    ev('session.diff', {
      sessionID: 's',
      diff: [
        { file: 'src/a.ts', additions: 12, deletions: 3, before: '', after: '' },
        { file: 'src/b.ts', additions: 5, deletions: 0, before: '', after: '' },
      ],
    }),
  );
  expect(s.diff).toEqual([
    { file: 'src/a.ts', added: 12, removed: 3 },
    { file: 'src/b.ts', added: 5, removed: 0 },
  ]);
  expect(pushUserMessage(s, 'próximo').diff).toEqual([]);
});

test('Sprint 7.2 — tui.toast.show vira um toast (variant + message + teto de 5)', () => {
  let s = applyEvent(
    emptyChat,
    ev('tui.toast.show', { title: 'Deploy', message: 'ok!', variant: 'success', duration: 9999 }),
  );
  expect(s.toasts).toHaveLength(1);
  expect(s.toasts[0]).toMatchObject({ message: 'Deploy — ok!', variant: 'success' });
  expect(s.toasts[0].until).toBeGreaterThan(Date.now());

  // variant inválido → 'info'; teto de 5
  for (let i = 0; i < 8; i++)
    s = applyEvent(s, ev('tui.toast.show', { message: `m${i}`, variant: 'xxx' }));
  expect(s.toasts.length).toBeLessThanOrEqual(5);
  expect(s.toasts.at(-1)).toMatchObject({ message: 'm7', variant: 'info' });
});
