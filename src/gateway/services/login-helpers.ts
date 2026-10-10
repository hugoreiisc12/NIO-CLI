import type { LoginChallenge } from '../../core/types.js';

/** Converte '12h' | '30m' | '3600s' | '1d' em milissegundos. Throw se o formato não bater. */
export function expiresInMs(spec: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(spec.trim());
  if (!m) {
    throw new Error(`JWT_EXPIRES_IN inválido: "${spec}" (formato esperado: 12h, 30m, 3600s, 1d).`);
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

/** `+5511999998888` → `+55•••••••8888` (mantém DDI + últimos 4). Nunca revela o número inteiro. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 8) return '•'.repeat(Math.max(1, digits.length));
  return digits.slice(0, 3) + '•'.repeat(digits.length - 7) + digits.slice(-4);
}

/** Um desafio existe e ainda pode ser usado? (não consumido, não expirado) */
export function challengeUsable(
  ch: LoginChallenge | null,
): { ok: true; ch: LoginChallenge } | { ok: false; reason: 'not_found' | 'consumed' | 'expired' } {
  if (!ch) return { ok: false, reason: 'not_found' };
  if (ch.consumedAt) return { ok: false, reason: 'consumed' };
  if (ch.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, ch };
}
