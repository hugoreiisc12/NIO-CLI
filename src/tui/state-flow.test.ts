import { test, expect } from 'bun:test';
import {
  applyEvent,
  reconcilePendingPermissions,
  reconcilePendingQuestions,
  pushUserMessage,
  emptyChat,
  messageUsage,
} from './state.js';
import { ev } from './state.test-helpers.js';

test('fluxo típico: eco do usuário é reconciliado, reasoning separado do texto, idle limpa busy', () => {
  let s = pushUserMessage(emptyChat, 'Diga PONG');
  expect(s.messages).toHaveLength(1);
  expect(s.busy).toBe(true);

  // mensagem real do usuário → substitui o eco `pending-user`
  s = applyEvent(s, ev('message.updated', { info: { id: 'msg_u', role: 'user' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: { type: 'text', text: 'Diga PONG', messageID: 'msg_u', id: 'prt_u' },
    }),
  );
  expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  expect(s.messages[0].id).toBe('msg_u');

  // assistant: step-start (ignorado) + reasoning + text streamado
  s = applyEvent(s, ev('message.updated', { info: { id: 'msg_a', role: 'assistant' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', { part: { type: 'step-start', messageID: 'msg_a', id: 'prt_s' } }),
  );
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: { type: 'reasoning', text: 'pensa...', messageID: 'msg_a', id: 'prt_r' },
    }),
  );
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: { type: 'text', text: '', messageID: 'msg_a', id: 'prt_t' },
    }),
  );
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: { type: 'text', text: 'PONG', messageID: 'msg_a', id: 'prt_t' },
    }),
  );

  const a = s.messages.find((m) => m.role === 'assistant')!;
  expect(a.parts.find((p) => p.id === 'prt_s')).toBeUndefined(); // step-start não vira parte
  expect(a.parts.find((p) => p.kind === 'reasoning')?.text).toBe('pensa...');
  expect(a.parts.find((p) => p.kind === 'text')?.text).toBe('PONG'); // último snapshot vence

  s = applyEvent(s, ev('session.idle', { sessionID: 'ses_x' }));
  expect(s.busy).toBe(false);
});

test('tool part: nome + título + status + input + output (e error vira output)', () => {
  let s = emptyChat;
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'tool',
        tool: 'read',
        messageID: 'msg_a',
        id: 'prt_tool',
        state: {
          status: 'completed',
          title: 'Lendo x.ts',
          output: 'conteúdo',
          input: { filePath: 'x.ts' },
        },
      },
    }),
  );
  const tp = s.messages[0].parts[0];
  expect(tp.kind).toBe('tool');
  expect(tp.text).toBe('Lendo x.ts');
  expect(tp.tool).toEqual({
    name: 'read',
    status: 'completed',
    input: { filePath: 'x.ts' },
    output: 'conteúdo',
  });

  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'tool',
        tool: 'bash',
        messageID: 'msg_a',
        id: 'prt_err',
        state: { status: 'error', error: 'falhou feio' },
      },
    }),
  );
  expect(s.messages[0].parts[1].tool).toEqual({
    name: 'bash',
    status: 'error',
    input: undefined,
    output: 'falhou feio',
  });
});

test('Sprint 2 — todo.updated vira a checklist do estado', () => {
  let s = pushUserMessage(emptyChat, 'faça X');
  expect(s.todos).toEqual([]);
  s = applyEvent(
    s,
    ev('todo.updated', {
      sessionID: 's',
      todos: [
        { content: 'Ler o adapter', status: 'completed', priority: 'high' },
        { content: 'Trocar o port', status: 'in_progress', priority: 'high' },
        { content: 'Rodar os testes', status: 'pending', priority: 'medium' },
      ],
    }),
  );
  expect(s.todos).toEqual([
    { content: 'Ler o adapter', status: 'completed' },
    { content: 'Trocar o port', status: 'in_progress' },
    { content: 'Rodar os testes', status: 'pending' },
  ]);
  // novo prompt zera a checklist
  expect(pushUserMessage(s, 'próximo').todos).toEqual([]);
});

test('Sprint 2 — file.edited acumula (dedup) os arquivos da volta', () => {
  let s = pushUserMessage(emptyChat, 'edite');
  s = applyEvent(s, ev('file.edited', { file: 'src/a.ts' }));
  s = applyEvent(s, ev('file.edited', { file: 'src/b.ts' }));
  s = applyEvent(s, ev('file.edited', { file: 'src/a.ts' })); // dup
  expect(s.files).toEqual(['src/a.ts', 'src/b.ts']);
});

test('Sprint 2 — session.status retry marca/limpa a tentativa', () => {
  let s = applyEvent(
    { ...emptyChat, busy: true },
    ev('session.status', {
      status: { type: 'retry', attempt: 2, message: 'rate limit', next: 0 },
    }),
  );
  expect(s.retry).toEqual({ attempt: 2, note: 'rate limit' });
  s = applyEvent(s, ev('session.idle', { sessionID: 's' }));
  expect(s.retry).toBeNull();
});

test('Sprint 2 — step-finish vira part `step` com tokens/custo; messageUsage soma', () => {
  let s = applyEvent(emptyChat, ev('message.updated', { info: { id: 'm', role: 'assistant' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'step-finish',
        messageID: 'm',
        id: 'st1',
        tokens: { input: 1000, output: 200 },
        cost: 0.01,
      },
    }),
  );
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'step-finish',
        messageID: 'm',
        id: 'st2',
        tokens: { input: 300, output: 400 },
        cost: 0.005,
      },
    }),
  );
  const msg = s.messages.find((m) => m.role === 'assistant')!;
  expect(msg.parts.filter((p) => p.kind === 'step')).toHaveLength(2);
  expect(messageUsage(msg)).toEqual({ tokensIn: 1300, tokensOut: 600, cost: 0.015 });
});

test('Bug mídia — part compaction_continue vira marcador conciso (não parágrafo longo)', () => {
  let s = applyEvent(emptyChat, ev('message.updated', { info: { id: 'm', role: 'assistant' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'text',
        messageID: 'm',
        id: 'cc1',
        synthetic: true,
        metadata: { compaction_continue: true },
        text: "The previous request exceeded the provider's size limit due to large media attachments.",
      },
    }),
  );
  const msg = s.messages.find((x) => x.role === 'assistant')!;
  const t = msg.parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('');
  expect(t).toContain('✂ anexo grande removido');
  expect(t).not.toContain("provider's size limit");
});

test('Item 5 — part subtask vira kind:fork (sub-agente disparado fica visível)', () => {
  let s = applyEvent(emptyChat, ev('message.updated', { info: { id: 'm', role: 'assistant' } }));
  s = applyEvent(
    s,
    ev('message.part.updated', {
      part: {
        type: 'subtask',
        messageID: 'm',
        id: 'sub1',
        agent: 'explore',
        description: 'varrer o core',
        prompt: 'x',
      },
    }),
  );
  const msg = s.messages.find((x) => x.role === 'assistant')!;
  const fork = msg.parts.find((p) => p.kind === 'fork');
  expect(fork).toBeTruthy();
  expect(fork!.fork).toEqual({ agent: 'explore', description: 'varrer o core' });
});

test('Item 6 — reconcile(null) = no-op (fetch falhou não apaga o modal); [] ainda remove', () => {
  const asked = applyEvent(
    emptyChat,
    ev('permission.asked', {
      id: 'p1',
      sessionID: 's',
      permission: 'bash',
      metadata: { command: 'git push' },
    }),
  );
  expect(asked.permissions).toHaveLength(1);
  // fetch falhou (null) → mantém a fila intacta (mesma referência)
  expect(reconcilePendingPermissions(asked, null)).toBe(asked);
  expect(reconcilePendingQuestions(asked, null)).toBe(asked);
  // server respondeu vazio de verdade ([]) → remove (comportamento antigo preservado)
  expect(reconcilePendingPermissions(asked, []).permissions).toHaveLength(0);
});
