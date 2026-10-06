/**
 * `gateway_clients` em Postgres de verdade (N-8): unicidade do nome, busca só por hash
 * de cliente ativo, revogação por id e por nome, `touch` limitado a 1×/min.
 * Gated em `NIO_TEST_DB_OK=1` + `NIO_DATABASE_URL`.
 */
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { closePool, query } from './client.js';
import { createGatewayClientRepository } from './gateway-client-repository.js';
import { generateClientToken } from '../../gateway/gateway-clients.js';

const hasEnv = process.env.NIO_TEST_DB_OK === '1' && Boolean(process.env.NIO_DATABASE_URL);
const dbTest = hasEnv ? test : test.skip;

afterAll(async () => {
  if (hasEnv) await closePool();
});

dbTest('create → findActiveByHash → revoke (por nome e por id) → some da busca', async () => {
  const repo = createGatewayClientRepository();
  const name = `test-${randomUUID()}`;
  const { hash } = generateClientToken();
  const created = await repo.create(name, hash);
  try {
    expect((await repo.findActiveByHash(hash))?.id).toBe(created.id);
    expect(await repo.findActiveByHash('0'.repeat(64))).toBeNull();

    expect(await repo.revoke(name)).toBe(true); // por nome
    expect(await repo.revoke(name)).toBe(false); // já revogado
    expect(await repo.findActiveByHash(hash)).toBeNull();

    const other = generateClientToken();
    const second = await repo.create(`${name}-b`, other.hash);
    expect(await repo.revoke(second.id)).toBe(true); // por id (UUID)
  } finally {
    await query('DELETE FROM gateway_clients WHERE name LIKE $1', [`${name}%`]);
  }
});

dbTest(
  'nome duplicado → erro legível; touch grava last_used_at e é limitado a 1×/min',
  async () => {
    const repo = createGatewayClientRepository();
    const name = `test-${randomUUID()}`;
    const c = await repo.create(name, generateClientToken().hash);
    try {
      await expect(repo.create(name, generateClientToken().hash)).rejects.toThrow(/já existe/);
      expect(c.lastUsedAt).toBeNull();
      await repo.touch(c.id);
      const first = (await repo.list()).find((x) => x.id === c.id)!.lastUsedAt;
      expect(first).not.toBeNull();
      await repo.touch(c.id); // dentro do minuto → não regrava
      const second = (await repo.list()).find((x) => x.id === c.id)!.lastUsedAt;
      expect(second?.getTime()).toBe(first!.getTime());
    } finally {
      await query('DELETE FROM gateway_clients WHERE name = $1', [name]);
    }
  },
);
