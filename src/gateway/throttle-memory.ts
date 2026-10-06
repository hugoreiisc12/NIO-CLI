/**
 * `ThrottleStore` em memória do processo — default de teste/dev. Zera no restart e
 * não é compartilhado entre réplicas; em produção o gateway troca pelo de Postgres
 * (`adapters/pg/throttle-store.ts`).
 */
import type { ThrottleStore } from '../core/repositories.js';

interface Entry {
  count: number;
  resetAt: number;
}

export function createMemoryThrottleStore(): ThrottleStore {
  const entries = new Map<string, Entry>();
  const live = (key: string, now: number): Entry | undefined => {
    const e = entries.get(key);
    return e && now < e.resetAt ? e : undefined;
  };

  return {
    async hit(key, limit, windowMs, now = Date.now()) {
      const e = live(key, now);
      if (!e) {
        entries.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, retryAfterMs: 0 };
      }
      e.count++;
      return e.count <= limit
        ? { ok: true, retryAfterMs: 0 }
        : { ok: false, retryAfterMs: e.resetAt - now };
    },

    async peek(key, limit, now = Date.now()) {
      const e = live(key, now);
      return e && e.count >= limit
        ? { ok: false, retryAfterMs: e.resetAt - now }
        : { ok: true, retryAfterMs: 0 };
    },

    async fail(key, ttlMs, now = Date.now()) {
      const e = live(key, now);
      const count = (e?.count ?? 0) + 1;
      entries.set(key, { count, resetAt: now + ttlMs });
      return count;
    },

    async failures(key, now = Date.now()) {
      return live(key, now)?.count ?? 0;
    },

    async clear(key) {
      entries.delete(key);
    },

    async sweep(now = Date.now()) {
      for (const [k, e] of entries) if (now >= e.resetAt) entries.delete(k);
    },
  };
}
