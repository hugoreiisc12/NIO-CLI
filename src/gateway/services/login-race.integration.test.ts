/**
 * Corrida no 2º fator (N-1/N-2) contra o Postgres real: requisições paralelas não
 * podem furar o teto de tentativas nem consumir o mesmo código duas vezes. Só
 * Postgres de verdade prova isso — um fake em memória é síncrono e nunca corre.
 *
 * Gated em `NIO_TEST_DB_OK=1` + `NIO_DATABASE_URL` + `JWT_SECRET`.
 */
import { test, expect, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createUserRepository } from '../../adapters/pg/user-repository.js';
import { createLoginChallengeRepository } from '../../adapters/pg/login-challenge-repository.js';
import { query, closePool } from '../../adapters/pg/client.js';
import { generateBackupCodes } from '../auth/backup-codes.js';
import type { OtpSender } from '../../core/messaging.js';
import { __clear as clearThrottle } from '../throttle.js';
import { login, verifyLogin, OTP_MAX_ATTEMPTS } from './login.js';

const hasEnv =
  process.env.NIO_TEST_DB_OK === '1' &&
  Boolean(process.env.NIO_DATABASE_URL && process.env.JWT_SECRET);
const dbTest = hasEnv ? test : test.skip;
const PARALLEL = 40;

afterAll(async () => {
  if (hasEnv) await closePool();
});

/** Usuário descartável com 2FA + um desafio de login aberto; devolve o OTP correto. */
async function openChallenge() {
  const users = createUserRepository();
  const password = `pw-${randomUUID()}`;
  const user = await users.create({ name: `nio-race-${randomUUID()}`, password });
  const { hashes, pepperId } = await generateBackupCodes();
  await users.enable2fa(user.id, '+5511999998888', hashes, pepperId);

  clearThrottle(); // o cap de SMS por número (1/min) barraria o 2º teste
  let otp = '';
  const sms: OtpSender = {
    sendOtp: async (_to, code) => {
      otp = code;
      return { status: 'sent' };
    },
  };
  const started = await login(user.name, password, { sms });
  if (!started.ok || started.step !== '2fa_required') throw new Error('esperava 2fa_required');
  const cleanup = () => query('DELETE FROM user_cli WHERE id = $1', [user.id]);
  return { challengeId: started.challengeId, otp, cleanup };
}

dbTest('claimAttempt: N chamadas paralelas reservam no máximo `max` tentativas', async () => {
  const { challengeId, cleanup } = await openChallenge();
  try {
    const repo = createLoginChallengeRepository();
    const claims = await Promise.all(
      Array.from({ length: PARALLEL }, () => repo.claimAttempt(challengeId, OTP_MAX_ATTEMPTS)),
    );
    const won = claims.filter((n): n is number => n !== null).sort();
    expect(won).toEqual([1, 2, 3]);
  } finally {
    await cleanup();
  }
});

dbTest('consume: só uma chamada paralela consome o desafio', async () => {
  const { challengeId, cleanup } = await openChallenge();
  try {
    const repo = createLoginChallengeRepository();
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => repo.consume(challengeId)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

dbTest('verifyLogin: OTP certo submetido em paralelo emite UMA sessão só', async () => {
  const { challengeId, otp, cleanup } = await openChallenge();
  try {
    const outs = await Promise.all(
      Array.from({ length: 10 }, () => verifyLogin(challengeId, otp, 'otp')),
    );
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

dbTest('verifyLogin: chutes em paralelo não passam do teto — nem o OTP certo depois', async () => {
  const { challengeId, otp, cleanup } = await openChallenge();
  try {
    const wrong = otp === '000000' ? '111111' : '000000';
    await Promise.all(
      Array.from({ length: PARALLEL }, () => verifyLogin(challengeId, wrong, 'otp')),
    );
    const row = await query<{ attempts: number }>(
      'SELECT attempts FROM login_challenges WHERE id = $1',
      [challengeId],
    );
    expect(Number(row.rows[0]?.attempts)).toBe(OTP_MAX_ATTEMPTS);
    const late = await verifyLogin(challengeId, otp, 'otp');
    expect(late.ok).toBe(false);
  } finally {
    await cleanup();
  }
});
