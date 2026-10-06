import { describe, expect, test } from 'bun:test';
import type { GatewayClient } from '../core/types.js';
import type { GatewayClientRepository } from '../core/repositories.js';
import { runClientsCli } from './clients-cli.js';
import {
  CLIENT_TOKEN_PREFIX,
  createGatewayAuthorizer,
  generateClientToken,
  hashClientToken,
  legacyTokenEnabled,
} from './gateway-clients.js';

const LEGACY = 'a'.repeat(64);

function fakeRepo(seed: GatewayClient[] = [], hashes = new Map<string, string>()) {
  const calls = { find: 0, touch: 0 };
  const clients = [...seed];
  const repo: GatewayClientRepository = {
    async create(name, hash) {
      if (clients.some((c) => c.name === name))
        throw new Error(`já existe um cliente chamado "${name}"`);
      const c = {
        id: `id-${clients.length + 1}`,
        name,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      };
      clients.push(c);
      hashes.set(hash, c.id);
      return c;
    },
    async findActiveByHash(hash) {
      calls.find++;
      const id = hashes.get(hash);
      return clients.find((c) => c.id === id && !c.revokedAt) ?? null;
    },
    async touch() {
      calls.touch++;
    },
    list: async () => clients,
    async revoke(x) {
      const c = clients.find((k) => (k.id === x || k.name === x) && !k.revokedAt);
      if (c) c.revokedAt = new Date();
      return Boolean(c);
    },
  };
  return { repo, calls };
}

describe('generateClientToken / hash', () => {
  test('token tem prefixo e entropia; o hash é SHA-256 estável e não é o token', () => {
    const a = generateClientToken();
    expect(a.token.startsWith(CLIENT_TOKEN_PREFIX)).toBe(true);
    expect(a.token.length).toBe(CLIENT_TOKEN_PREFIX.length + 43);
    expect(a.hash).toBe(hashClientToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateClientToken().token).not.toBe(a.token);
  });
});

describe('authorize', () => {
  test('sem token / lixo → null, sem tocar o banco', async () => {
    const { repo, calls } = fakeRepo();
    const auth = createGatewayAuthorizer(LEGACY, { clients: repo, legacyEnabled: true });
    expect(await auth.authorize(null)).toBeNull();
    expect(await auth.authorize('qualquer-coisa')).toBeNull();
    expect(calls.find).toBe(0);
  });

  test('token legado vale como `legacy` (sem banco)', async () => {
    const { repo, calls } = fakeRepo();
    const auth = createGatewayAuthorizer(LEGACY, { clients: repo, legacyEnabled: true });
    expect(await auth.authorize(LEGACY)).toEqual({ clientId: 'legacy', clientName: 'legacy' });
    expect(calls.find).toBe(0);
  });

  test('legado desligado → o token compartilhado deixa de valer', async () => {
    const { repo } = fakeRepo();
    const auth = createGatewayAuthorizer(LEGACY, { clients: repo, legacyEnabled: false });
    expect(await auth.authorize(LEGACY)).toBeNull();
  });

  test('token de cliente válido → principal; cache evita o 2º hit no banco; touch best-effort', async () => {
    const hashes = new Map<string, string>();
    const { repo, calls } = fakeRepo([], hashes);
    const { token, hash } = generateClientToken();
    await repo.create('app-externa', hash);
    const auth = createGatewayAuthorizer(LEGACY, { clients: repo, legacyEnabled: true });
    const p = await auth.authorize(token, 0);
    expect(p?.clientName).toBe('app-externa');
    await auth.authorize(token, 1_000);
    expect(calls.find).toBe(1);
    expect(calls.touch).toBe(1);
  });

  test('revogado: some do banco; o cache segura no máximo 30 s', async () => {
    const { repo } = fakeRepo();
    const { token, hash } = generateClientToken();
    await repo.create('c1', hash);
    const auth = createGatewayAuthorizer(LEGACY, { clients: repo, legacyEnabled: true });
    expect(await auth.authorize(token, 0)).not.toBeNull();
    await repo.revoke('c1');
    expect(await auth.authorize(token, 10_000)).not.toBeNull(); // ainda no cache
    expect(await auth.authorize(token, 31_000)).toBeNull(); // cache expirou → banco nega
  });

  test('token de cliente desconhecido → null', async () => {
    const { repo } = fakeRepo();
    const auth = createGatewayAuthorizer(LEGACY, { clients: repo, legacyEnabled: true });
    expect(await auth.authorize(generateClientToken().token)).toBeNull();
  });
});

test('legacyTokenEnabled: só "0" desliga', () => {
  expect(legacyTokenEnabled({})).toBe(true);
  expect(legacyTokenEnabled({ NIO_GATEWAY_LEGACY_TOKEN: '1' })).toBe(true);
  expect(legacyTokenEnabled({ NIO_GATEWAY_LEGACY_TOKEN: '0' })).toBe(false);
});

describe('clients-cli', () => {
  const run = async (argv: string[], repo: GatewayClientRepository) => {
    const lines: string[] = [];
    const code = await runClientsCli(argv, repo, (l) => lines.push(l));
    return { code, text: lines.join('\n') };
  };

  test('create mostra o token UMA vez e o hash casa com o que foi guardado', async () => {
    const hashes = new Map<string, string>();
    const { repo } = fakeRepo([], hashes);
    const { code, text } = await run(['create', 'app'], repo);
    expect(code).toBe(0);
    const token = text.split('\n').find((l) => l.startsWith(CLIENT_TOKEN_PREFIX))!;
    expect(hashes.has(hashClientToken(token))).toBe(true);
    const listed = await run(['list'], repo);
    expect(listed.text).not.toContain(token); // list nunca devolve o token
  });

  test('create: nome ausente/longo → 2; duplicado propaga o erro', async () => {
    const { repo } = fakeRepo();
    expect((await run(['create'], repo)).code).toBe(2);
    expect((await run(['create', 'x'.repeat(65)], repo)).code).toBe(2);
    await run(['create', 'app'], repo);
    await expect(run(['create', 'app'], repo)).rejects.toThrow(/já existe/);
  });

  test('revoke: ok → 0; inexistente → 1; sem argumento → uso', async () => {
    const { repo } = fakeRepo();
    await run(['create', 'app'], repo);
    expect((await run(['revoke', 'app'], repo)).code).toBe(0);
    expect((await run(['revoke', 'app'], repo)).code).toBe(1);
    expect((await run(['revoke'], repo)).code).toBe(2);
  });
});
