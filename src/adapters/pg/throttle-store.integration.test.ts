/**
 * `ThrottleStore` em Postgres de verdade (N-5): o ponto de ter saído da memória é
 * contar certo sob concorrência (réplicas) e expirar pelo relógio do banco.
 * Gated em `NIO_TEST_DB_OK=1` + `NIO_DATABASE_URL`.
 */
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { closePool } from './client.js';
import { createThrottleStore } from './throttle-store.js';

// NIO_TEST_DB_OK: opt-in explícito (outro teste pode setar a URL no processo — ver scripts/test/test-env.ts).
const hasEnv = process.env.NIO_TEST_DB_OK === '1' && Boolean(process.env.NIO_DATABASE_URL);
const dbTest = hasEnv ? test : test.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `test:${randomUUID()}`;

afterAll(async () => {
  if (hasEnv) await closePool();
});

dbTest('hit: 40 chamadas paralelas, limite 5 → exatamente 5 passam', async () => {
  const store = createThrottleStore();
  const k = key();
  const out = await Promise.all(Array.from({ length: 40 }, () => store.hit(k, 5, 60_000)));
  expect(out.filter((r) => r.ok)).toHaveLength(5);
  const blocked = out.find((r) => !r.ok)!;
  expect(blocked.retryAfterMs).toBeGreaterThan(0);
  await store.clear(k);
});

dbTest('peek não conta; passa a bloquear quando o contador atinge o limite', async () => {
  const store = createThrottleStore();
  const k = key();
  for (let i = 0; i < 10; i++) expect((await store.peek(k, 2)).ok).toBe(true);
  await store.hit(k, 2, 60_000);
  expect((await store.peek(k, 2)).ok).toBe(true); // 1 < 2
  await store.hit(k, 2, 60_000);
  expect((await store.peek(k, 2)).ok).toBe(false); // 2 >= 2
  await store.clear(k);
});

dbTest('fail/failures: soma, esquece depois do TTL e clear zera', async () => {
  const store = createThrottleStore();
  const k = key();
  await Promise.all(Array.from({ length: 6 }, () => store.fail(k, 60_000)));
  expect(await store.failures(k)).toBe(6);
  await store.clear(k);
  expect(await store.failures(k)).toBe(0);

  await store.fail(k, 50);
  await sleep(150);
  expect(await store.failures(k)).toBe(0); // expirou
  expect(await store.fail(k, 60_000)).toBe(1); // recomeça do 1
  await store.clear(k);
});

dbTest('sweep apaga só o expirado', async () => {
  const store = createThrottleStore();
  const [old, live] = [key(), key()];
  await store.fail(old, 30);
  await store.fail(live, 60_000);
  await sleep(100);
  await store.sweep();
  expect(await store.failures(old)).toBe(0);
  expect(await store.failures(live)).toBe(1);
  await store.clear(live);
});
