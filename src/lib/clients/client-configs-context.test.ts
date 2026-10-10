import { test, expect } from 'bun:test';
import { n8nMcp, n8nNativeMcp } from '../../profiles/mcps.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planOpencodeUpdate,
  installOpencodeGlobal,
  NIO_AI_BASE_URL,
  NIO_AI_PROVIDER,
  NIO_AI_MODEL_ID,
  NIO_AI_CONTEXT,
  NIO_AI_OUTPUT,
  declaredContextWindow,
  modelCapabilities,
  contextConfigWarning,
  toolOutputLimits,
  mcpServerJsPath,
} from './client-configs.js';
import {
  NIO_ENTRY,
  PG_MCP,
  REMOTE_TIMEOUT_MCP,
  LOCAL_TIMEOUT_MCP,
  entrada,
} from './client-configs.test-helpers.js';

test('a margem cobre a subestimativa medida do contador do opencode', () => {
  // Medido: o prompt chegou a 96257 reais sem disparar a compactação prevista para
  // ~90304 — o contador do opencode erra pra menos em ao menos 6%.
  const real = 98304;
  const declarado = declaredContextWindow(real, 2048);
  const piorCaso = declarado * 1.06; // mesmo subestimando, o prompt real fica abaixo do teto

  expect(piorCaso + 2048).toBeLessThan(real);
});

test('não sub-declara a ponto de reabrir o loop de compactação', () => {
  // Regressão conhecida: janela apertada demais faz o opencode compactar em loop.
  expect(contextConfigWarning(98304, 2048)).toBeNull();
  expect(declaredContextWindow(98304, 2048)).toBeGreaterThan(2048 + 8000);
});

test('declaração desativada (0) passa reta', () => {
  expect(declaredContextWindow(0, 2048)).toBe(0);
});

test('ACEITE: o modelo é declarado como capaz de anexo — sem isso a imagem é descartada', () => {
  // Medido com proxy no caminho real (opencode serve → vLLM):
  //   sem `attachment: true` → 0 partes image_url chegam, o modelo responde
  //   "não aceito imagens"; com a flag → 1 image_url chega e ele descreve a imagem.
  const { next } = planOpencodeUpdate({}, NIO_ENTRY, [], NIO_AI_BASE_URL);
  const modelo = (next.provider as Record<string, any>)[NIO_AI_PROVIDER].models[NIO_AI_MODEL_ID];

  expect(modelo.attachment).toBe(true);
  expect(modelo.modalities.input).toContain('image');
});

test('capacidades usam só chaves do schema oficial (additionalProperties: false)', () => {
  // Chave inventada aqui quebra o opencode.json inteiro, não só a visão.
  const permitidas = ['attachment', 'modalities'];
  expect(Object.keys(modelCapabilities(true)).every((k) => permitidas.includes(k))).toBe(true);
  expect(modelCapabilities(true).modalities).toEqual({
    input: ['text', 'image'],
    output: ['text'],
  });
});

test('backend texto-only → nenhuma capacidade declarada', () => {
  // Declarar visão num backend que não tem faria o opencode mandar imagem que o servidor recusa.
  expect(modelCapabilities(false)).toEqual({});
});

test('config antigo sem attachment é considerado desatualizado (força a reescrita)', () => {
  // A regressão da frente 1 foi exatamente esta: o disco divergia do esperado e ninguém
  // reconciliava, então o usuário ficava com a config velha pra sempre.
  const seeded = planOpencodeUpdate({}, NIO_ENTRY, [], NIO_AI_BASE_URL).next;
  const p = seeded.provider as Record<string, any>;
  delete p[NIO_AI_PROVIDER].models[NIO_AI_MODEL_ID].attachment;

  expect(planOpencodeUpdate(seeded, NIO_ENTRY, [], NIO_AI_BASE_URL).alreadyConfigured).toBe(false);
});

test('tool_output: teto padrão corta o que entraria no contexto, sem perder o dado', () => {
  // O opencode grava o texto inteiro em disco e devolve preview — apertar é barato.
  const lim = toolOutputLimits()!;
  expect(lim.max_bytes).toBe(20_000);
  expect(lim.max_lines).toBe(800);
  expect(lim.max_bytes!).toBeLessThan(51_200); // mais apertado que o default do opencode
});

test('mcpServerJsPath sobe DOIS níveis (§10.4) — não um, como no bug antigo', () => {
  // `client-configs.ts` mora em `lib/clients/`; o alvo `mcp-server.js` é irmão
  // do pacote (raiz de `src/` em teste, raiz de `dist/` no build). Testar a
  // ESTRUTURA (dois níveis acima), não uma string literal de diretório — o
  // teste roda contra `src/`, não contra `dist/`, então ancorar em "/dist/"
  // teria falhado no caminho certo e mascarado o bug no caminho errado.
  const aqui = dirname(fileURLToPath(import.meta.url)); // .../src/lib/clients
  const esperado = join(aqui, '..', '..', 'mcp-server.js'); // .../src/mcp-server.js
  const bugAntigo = join(aqui, '..', 'mcp-server.js'); // .../src/lib/mcp-server.js — o path quebrado

  expect(mcpServerJsPath()).toBe(esperado);
  expect(mcpServerJsPath()).not.toBe(bugAntigo);
});

test('installOpencodeGlobal: n8n → ask nas tools que mexem em estado, preserva o permission do usuário e é idempotente', () => {
  const d = mkdtempSync(join(tmpdir(), 'nio-n8n-'));
  const p = join(d, 'opencode.json');
  writeFileSync(
    p,
    JSON.stringify({ permission: { bash: 'allow', n8n_n8n_delete_workflow: 'deny' } }),
  );

  installOpencodeGlobal([n8nMcp, n8nNativeMcp], p, '');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  expect(cfg.permission.bash).toBe('allow'); // do usuário
  expect(cfg.permission['n8n_n8n_delete_workflow']).toBe('deny'); // do usuário vence
  expect(cfg.permission['n8n_n8n_create_workflow']).toBe('ask'); // nossa
  expect(cfg.permission['n8n_n8n_search_nodes']).toBeUndefined(); // leitura livre
  expect(cfg.mcp.n8n.environment).toEqual({ MCP_MODE: 'stdio', LOG_LEVEL: 'error' });
  // remoto: URL e token são referências {env:…}, nunca o valor
  expect(cfg.mcp['n8n-native']).toMatchObject({
    type: 'remote',
    url: '{env:N8N_NATIVE_MCP_URL}',
    headers: { Authorization: 'Bearer {env:N8N_NATIVE_MCP_TOKEN}' },
  });

  const antes = readFileSync(p, 'utf8');
  installOpencodeGlobal([n8nMcp, n8nNativeMcp], p, '');
  expect(readFileSync(p, 'utf8')).toBe(antes);

  rmSync(d, { recursive: true, force: true });
});

test('NIO_AI_OUTPUT acomoda o reasoning do modelo — 2048 esvaziava o content', () => {
  // Medido contra o backend: numa pergunta técnica real o raciocínio sozinho gastou
  // 2048/2048 tokens, `content` voltou vazio e `finish_reason` foi 'length'. O teto é
  // orçamento COMPARTILHADO entre reasoning e resposta; abaixo de 4096 não fecha.
  expect(NIO_AI_OUTPUT).toBeGreaterThanOrEqual(4096);
  // E o teto maior não pode reabrir o loop de auto-compactação.
  expect(contextConfigWarning(NIO_AI_CONTEXT, NIO_AI_OUTPUT)).toBeNull();
});

test('planOpencodeUpdate: grava o timeout declarado no spec (local e remoto)', () => {
  const { next } = planOpencodeUpdate({}, NIO_ENTRY, [LOCAL_TIMEOUT_MCP, REMOTE_TIMEOUT_MCP]);
  expect(entrada(next, 'pg-lan').timeout).toBe(30_000);
  expect(entrada(next, 'pg-lan').type).toBe('local');
  expect(entrada(next, 'bi-gw').timeout).toBe(120_000);
  expect(entrada(next, 'bi-gw').type).toBe('remote');
});

test('planOpencodeUpdate: spec sem timeout não inventa a chave', () => {
  const { next } = planOpencodeUpdate({}, NIO_ENTRY, [PG_MCP]);
  expect('timeout' in entrada(next, 'postgres')).toBe(false);
});

test('planOpencodeUpdate: mudar o timeout do spec reescreve o arquivo', () => {
  const { next } = planOpencodeUpdate({}, NIO_ENTRY, [REMOTE_TIMEOUT_MCP]);
  expect(planOpencodeUpdate(next, NIO_ENTRY, [REMOTE_TIMEOUT_MCP]).alreadyConfigured).toBe(true);
  const maior = { ...REMOTE_TIMEOUT_MCP, timeout: 180_000 };
  const replan = planOpencodeUpdate(next, NIO_ENTRY, [maior]);
  expect(replan.alreadyConfigured).toBe(false);
  expect(entrada(replan.next, 'bi-gw').timeout).toBe(180_000);
});
