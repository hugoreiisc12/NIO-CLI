/**
 * `ThrottleStore` em Postgres (`auth_throttle`, migration 0016). Os contadores são
 * `UPSERT` atômico — réplicas do gateway concorrentes contam juntas e o estado
 * sobrevive a restart. O relógio é o do banco (`NOW()`), o que evita desvio entre nós.
 */
import type { HitResult, ThrottleStore } from '../../core/repositories.js';
import { query } from './client.js';

interface CountRow {
  count: number;
  retry_ms: string | number;
}

const RETRY_MS = '(EXTRACT(EPOCH FROM (reset_at - NOW())) * 1000)::bigint AS retry_ms';

function toHit(row: CountRow | undefined, limit: number, counted: boolean): HitResult {
  if (!row) return { ok: true, retryAfterMs: 0 };
  const over = counted ? row.count > limit : row.count >= limit;
  return over
    ? { ok: false, retryAfterMs: Math.max(0, Number(row.retry_ms)) }
    : { ok: true, retryAfterMs: 0 };
}

export function createThrottleStore(): ThrottleStore {
  return {
    async hit(key, limit, windowMs) {
      const res = await query<CountRow>(
        `INSERT INTO auth_throttle (key, count, reset_at)
         VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
         ON CONFLICT (key) DO UPDATE SET
           count    = CASE WHEN auth_throttle.reset_at <= NOW() THEN 1 ELSE auth_throttle.count + 1 END,
           reset_at = CASE WHEN auth_throttle.reset_at <= NOW() THEN EXCLUDED.reset_at ELSE auth_throttle.reset_at END
         RETURNING count, ${RETRY_MS}`,
        [key, windowMs],
      );
      return toHit(res.rows[0], limit, true);
    },

    async peek(key, limit) {
      const res = await query<CountRow>(
        `SELECT count, ${RETRY_MS} FROM auth_throttle WHERE key = $1 AND reset_at > NOW()`,
        [key],
      );
      return toHit(res.rows[0], limit, false);
    },

    async fail(key, ttlMs) {
      const res = await query<{ count: number }>(
        `INSERT INTO auth_throttle (key, count, reset_at)
         VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
         ON CONFLICT (key) DO UPDATE SET
           count    = CASE WHEN auth_throttle.reset_at <= NOW() THEN 1 ELSE auth_throttle.count + 1 END,
           reset_at = EXCLUDED.reset_at
         RETURNING count`,
        [key, ttlMs],
      );
      return Number(res.rows[0]?.count ?? 0);
    },

    async failures(key) {
      const res = await query<{ count: number }>(
        'SELECT count FROM auth_throttle WHERE key = $1 AND reset_at > NOW()',
        [key],
      );
      return Number(res.rows[0]?.count ?? 0);
    },

    async clear(key) {
      await query('DELETE FROM auth_throttle WHERE key = $1', [key]);
    },

    async sweep() {
      await query('DELETE FROM auth_throttle WHERE reset_at <= NOW()');
    },
  };
}
