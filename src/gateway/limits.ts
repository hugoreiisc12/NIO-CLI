/**
 * Limites de recurso do gateway (N-5 / N-10): o Node sozinho deixa conexão lenta,
 * corpo gigante e atraso de login pendurados sem teto.
 */
import type { Server } from 'node:http';

/** Mesmo teto de `register` (`invalid_name`) — o login não pode aceitar mais que isso. */
export const MAX_NAME_LENGTH = 64;
/** Argon2 aceita senha enorme; sem teto, 1 MB de senha vira trabalho de CPU de graça. */
export const MAX_PASSWORD_LENGTH = 1024;

const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 1_000;
/** Respostas de login dormindo (atraso escalonado) ao mesmo tempo, no processo. */
const MAX_PENDING_DELAYS = 256;

/** `NIO_GATEWAY_MAX_CONNECTIONS` (inteiro > 0) ou o default. */
export function maxConnections(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.NIO_GATEWAY_MAX_CONNECTIONS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONNECTIONS;
}

/** Aplica timeouts e teto de conexões ao servidor HTTP. */
export function applyServerLimits(server: Server): void {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxConnections = maxConnections();
}

/** `name`/`password` do login dentro dos tetos? (checagem de borda, antes de qualquer hash). */
export function loginInputInBounds(name: string, password: string): boolean {
  return name.length <= MAX_NAME_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

let pendingDelays = 0;

/**
 * Dorme `ms` ocupando uma vaga de atraso. `false` = sem vaga: o caller responde 429
 * na hora em vez de empilhar mais uma conexão dormindo.
 */
export async function sleepWithinBudget(
  ms: number,
  sleep: (ms: number) => Promise<unknown>,
  max: number = MAX_PENDING_DELAYS,
): Promise<boolean> {
  if (pendingDelays >= max) return false;
  pendingDelays++;
  try {
    await sleep(ms);
    return true;
  } finally {
    pendingDelays--;
  }
}
