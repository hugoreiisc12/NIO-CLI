/**
 * Rate limiting do gateway (auditoria M-3 + M-4 + N-5): cap de SMS, atraso
 * escalonado de login por nome e limite de falhas por IP.
 *
 * O estado mora num `ThrottleStore`. Default = memória do processo (testes/dev);
 * o gateway chama `useThrottleStore(createThrottleStore())` no boot pra usar o
 * Postgres — contadores compartilhados entre réplicas e que sobrevivem a restart.
 *
 * Falha do store: o cap de **SMS falha fechado** (custo / toll fraud); o de
 * **login falha aberto** (um banco fora do ar já derruba o login de qualquer forma,
 * e travar todo mundo por causa do contador seria pior que o atraso perdido).
 */
import type { HitResult, ThrottleStore } from '../core/repositories.js';
import { logEvent } from './log.js';
import { createMemoryThrottleStore } from './throttle-memory.js';

export type { HitResult };

let store: ThrottleStore = createMemoryThrottleStore();

/** Troca o backend (boot do gateway). */
export function useThrottleStore(next: ThrottleStore): void {
  store = next;
}

/** Só pra teste — volta pra um store em memória vazio. */
export function __clear(): void {
  store = createMemoryThrottleStore();
}

function storeFailed(op: string, err: unknown): void {
  logEvent('throttle_store_failed', { op, error: (err as Error).message }, 'warn');
}

/** Janela fixa em `key`; erro do store vira `ok: failOpen`. */
async function guardedHit(
  key: string,
  limit: number,
  windowMs: number,
  now: number | undefined,
  failOpen: boolean,
): Promise<HitResult> {
  try {
    return await store.hit(key, limit, windowMs, now);
  } catch (err) {
    storeFailed('hit', err);
    return { ok: failOpen, retryAfterMs: failOpen ? 0 : windowMs };
  }
}

export const hit = (key: string, limit: number, windowMs: number, now?: number) =>
  guardedHit(key, limit, windowMs, now, true);

// ─── cap de envio de SMS (M-4: toll fraud / SMS pumping) ────────────

/** SMS por usuário na janela. */
export const SMS_PER_USER = 3;
export const SMS_USER_WINDOW_MS = 15 * 60 * 1000;
/** SMS por número — 1 a cada minuto (evita flood no mesmo alvo). */
export const SMS_PHONE_WINDOW_MS = 60 * 1000;

/**
 * Pode disparar um SMS pra este usuário/número agora? **Conta a tentativa** nos dois
 * contadores. `false` = estourou o cap (por usuário OU por número) ou o store caiu.
 */
export async function smsAllowed(
  userId: number,
  phone: string,
  now: number = Date.now(),
): Promise<boolean> {
  const perUser = await guardedHit(`sms:u:${userId}`, SMS_PER_USER, SMS_USER_WINDOW_MS, now, false);
  const perPhone = await guardedHit(`sms:p:${phone}`, 1, SMS_PHONE_WINDOW_MS, now, false);
  return perUser.ok && perPhone.ok;
}

// ─── atraso escalonado de login por nome (M-3) ──────────────────────

/** 1h sem falha nova → esquece o histórico daquela chave. */
const LOGIN_FAIL_TTL_MS = 60 * 60 * 1000;
/** Teto do atraso — não vira DoS de conexão pendurada. */
const LOGIN_MAX_DELAY_MS = 20_000;
/** Falhas "de graça" antes do atraso começar (erro de digitação honesto). */
const LOGIN_FREE_ATTEMPTS = 4;

const loginKey = (name: string) => `login:${name}`;

/**
 * Quanto atrasar a resposta do `/login` pra este nome, dado o histórico de falhas.
 * **Atraso, não bloqueio** — de propósito: um bloqueio duro por nome deixaria um
 * terceiro trancar a conta de um colega. O atraso exponencial (capado) já torna o
 * brute-force online inviável, e some no primeiro login certo.
 */
export async function loginDelayMs(name: string, now?: number): Promise<number> {
  try {
    const n = await store.failures(loginKey(name), now);
    if (n <= LOGIN_FREE_ATTEMPTS) return 0;
    return Math.min(2 ** (n - LOGIN_FREE_ATTEMPTS - 1) * 500, LOGIN_MAX_DELAY_MS); // 500ms, 1s, 2s, …
  } catch (err) {
    storeFailed('failures', err);
    return 0;
  }
}

/** Registra uma falha de credencial para o nome. */
export async function recordLoginFail(name: string, now?: number): Promise<void> {
  await store.fail(loginKey(name), LOGIN_FAIL_TTL_MS, now).catch((e) => storeFailed('fail', e));
}

/** Login OK → limpa o histórico do nome. */
export async function recordLoginOk(name: string): Promise<void> {
  await store.clear(loginKey(name)).catch((e) => storeFailed('clear', e));
}

// ─── limite de falhas por IP (N-5: credential stuffing entre contas) ─

/** Falhas de login por IP na janela — acima disso, 429. `NIO_LOGIN_FAIL_PER_IP` ajusta. */
export const LOGIN_FAILS_PER_IP = Math.max(1, Number(process.env.NIO_LOGIN_FAIL_PER_IP) || 30);
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;

const ipKey = (ip: string) => `loginip:${ip}`;

/** O IP já estourou o teto de falhas? Só consulta, não conta. */
export async function loginIpBlocked(ip: string, now?: number): Promise<HitResult> {
  try {
    return await store.peek(ipKey(ip), LOGIN_FAILS_PER_IP, now);
  } catch (err) {
    storeFailed('peek', err);
    return { ok: true, retryAfterMs: 0 };
  }
}

/** Conta uma falha de credencial para o IP. */
export async function recordIpLoginFail(ip: string, now?: number): Promise<void> {
  await guardedHit(ipKey(ip), LOGIN_FAILS_PER_IP, LOGIN_IP_WINDOW_MS, now, true);
}

/** Descarta entradas expiradas do store. Chamar periodicamente (ver `index.ts`). */
export async function sweep(now?: number): Promise<void> {
  await store.sweep(now).catch((e) => storeFailed('sweep', e));
}
