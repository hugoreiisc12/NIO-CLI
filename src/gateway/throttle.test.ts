import { test, expect, beforeEach } from 'bun:test';
import {
  __clear,
  hit,
  LOGIN_FAILS_PER_IP,
  loginDelayMs,
  loginIpBlocked,
  recordIpLoginFail,
  recordLoginFail,
  recordLoginOk,
  smsAllowed,
  sweep,
  SMS_PER_USER,
  useThrottleStore,
} from './throttle.js';

beforeEach(__clear);

// ─── hit (janela fixa) ──────────────────────────────────────────────

test('hit: libera até o limite, bloqueia depois, reabre na virada da janela', async () => {
  const t0 = 1_000_000;
  expect((await hit('k', 2, 1000, t0)).ok).toBe(true);
  expect((await hit('k', 2, 1000, t0 + 100)).ok).toBe(true);
  const blocked = await hit('k', 2, 1000, t0 + 200);
  expect(blocked.ok).toBe(false);
  expect(blocked.retryAfterMs).toBe(800);
  expect((await hit('k', 2, 1000, t0 + 1001)).ok).toBe(true); // passou a janela → conta zera
});

test('hit: chaves independentes', async () => {
  const t = 5_000;
  expect((await hit('a', 1, 1000, t)).ok).toBe(true);
  expect((await hit('a', 1, 1000, t)).ok).toBe(false);
  expect((await hit('b', 1, 1000, t)).ok).toBe(true);
});

// ─── smsAllowed (M-4) ───────────────────────────────────────────────

test('smsAllowed: cap por número = 1/min', async () => {
  const t = 0;
  expect(await smsAllowed(1, '+5511999998888', t)).toBe(true);
  expect(await smsAllowed(1, '+5511999998888', t + 10_000)).toBe(false); // mesmo número, <60s
  expect(await smsAllowed(1, '+5511999998888', t + 61_000)).toBe(true); // janela reabriu
});

test('smsAllowed: cap por usuário na janela', async () => {
  const t = 0;
  for (let i = 0; i < SMS_PER_USER; i++) {
    expect(await smsAllowed(7, `+55110000000${i}`, t)).toBe(true);
  }
  expect(await smsAllowed(7, '+5511000000098', t)).toBe(false); // 4º na janela do usuário 7
  expect(await smsAllowed(9, '+5511000000097', t)).toBe(true); // outro usuário → ok
});

test('smsAllowed: store fora do ar → FALHA FECHADO (não deixa passar SMS)', async () => {
  useThrottleStore(brokenStore());
  expect(await smsAllowed(1, '+5511999998888')).toBe(false);
});

// ─── loginDelayMs (M-3) ─────────────────────────────────────────────

test('loginDelayMs: 4 falhas de graça, depois escala e capa em 20s', async () => {
  const k = 'hugo';
  const t = 0;
  for (let i = 0; i < 5; i++) {
    expect(await loginDelayMs(k, t)).toBe(0); // n = 0..4 → sem atraso
    await recordLoginFail(k, t);
  }
  expect(await loginDelayMs(k, t)).toBe(500); // n=5 → 2^0 * 500
  await recordLoginFail(k, t);
  expect(await loginDelayMs(k, t)).toBe(1000); // n=6 → 2^1 * 500
  for (let i = 0; i < 20; i++) await recordLoginFail(k, t);
  expect(await loginDelayMs(k, t)).toBe(20_000); // capado
});

test('recordLoginOk: zera o histórico', async () => {
  for (let i = 0; i < 8; i++) await recordLoginFail('hugo', 0);
  expect(await loginDelayMs('hugo', 0)).toBeGreaterThan(0);
  await recordLoginOk('hugo');
  expect(await loginDelayMs('hugo', 0)).toBe(0);
});

test('loginDelayMs: histórico esquecido após o TTL', async () => {
  for (let i = 0; i < 8; i++) await recordLoginFail('hugo', 0);
  expect(await loginDelayMs('hugo', 0)).toBeGreaterThan(0);
  expect(await loginDelayMs('hugo', 61 * 60 * 1000)).toBe(0); // > 1h depois
});

test('loginDelayMs: store fora do ar → FALHA ABERTO (sem atraso, não trava o login)', async () => {
  useThrottleStore(brokenStore());
  expect(await loginDelayMs('hugo')).toBe(0);
  await recordLoginFail('hugo'); // não lança
});

// ─── limite de falhas por IP (N-5) ──────────────────────────────────

test('IP: bloqueia só depois de LOGIN_FAILS_PER_IP falhas, e reabre com a janela', async () => {
  const ip = '203.0.113.7';
  const t = 0;
  for (let i = 0; i < LOGIN_FAILS_PER_IP - 1; i++) await recordIpLoginFail(ip, t);
  expect((await loginIpBlocked(ip, t)).ok).toBe(true);
  await recordIpLoginFail(ip, t); // atinge o teto
  const gate = await loginIpBlocked(ip, t);
  expect(gate.ok).toBe(false);
  expect(gate.retryAfterMs).toBeGreaterThan(0);
  expect((await loginIpBlocked(ip, 16 * 60 * 1000)).ok).toBe(true); // 15 min depois
});

test('IP: consultar não conta; outro IP não é afetado', async () => {
  for (let i = 0; i < 100; i++) await loginIpBlocked('198.51.100.1', 0);
  expect((await loginIpBlocked('198.51.100.1', 0)).ok).toBe(true);
  for (let i = 0; i < LOGIN_FAILS_PER_IP; i++) await recordIpLoginFail('198.51.100.2', 0);
  expect((await loginIpBlocked('198.51.100.2', 0)).ok).toBe(false);
  expect((await loginIpBlocked('198.51.100.3', 0)).ok).toBe(true);
});

// ─── sweep ──────────────────────────────────────────────────────────

test('sweep: descarta expirados sem afetar os vivos', async () => {
  await hit('velho', 1, 1000, 0);
  await hit('novo', 1, 100_000, 0);
  await sweep(2000); // "velho" expirou (resetAt=1000); "novo" ainda vale
  expect((await hit('velho', 1, 1000, 2000)).ok).toBe(true); // recriada = como nova
  expect((await hit('novo', 1, 100_000, 2000)).ok).toBe(false); // sobreviveu, já tinha 1
});

function brokenStore() {
  const boom = async () => {
    throw new Error('db down');
  };
  return { hit: boom, peek: boom, fail: boom, failures: boom, clear: boom, sweep: boom };
}
