/**
 * Autorização do header `x-nio-gateway-token` (N-8): token por cliente, revogável
 * individualmente, mais o token compartilhado legado (arquivo/`NIO_GATEWAY_TOKEN`).
 *
 * O token de cliente é aleatório de 256 bits, então SHA-256 basta (não é senha
 * escolhida por gente). Só o hash fica no banco; o texto aparece uma vez, na criação.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { GatewayClientRepository } from '../core/repositories.js';
import { createGatewayClientRepository } from '../adapters/pg/gateway-client-repository.js';
import { tokensMatch } from './edge-filter.js';

export const CLIENT_TOKEN_PREFIX = 'nio_gw_';
/** Quanto uma resposta positiva do banco vale em cache — teto do atraso de uma revogação. */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1_000;

export interface GatewayPrincipal {
  /** `legacy` = o token compartilhado; senão o id do `gateway_clients`. */
  clientId: string;
  /** Nome do cliente (`legacy` pro compartilhado) — só pra log. */
  clientName: string;
}

export const hashClientToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Token novo (`nio_gw_` + 43 chars base64url). O texto só existe neste retorno. */
export function generateClientToken(): { token: string; hash: string } {
  const token = CLIENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashClientToken(token) };
}

/** O token compartilhado legado está ligado? `NIO_GATEWAY_LEGACY_TOKEN=0` desliga. */
export function legacyTokenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NIO_GATEWAY_LEGACY_TOKEN?.trim() !== '0';
}

export interface GatewayAuthorizer {
  authorize(provided: string | null, now?: number): Promise<GatewayPrincipal | null>;
}

export function createGatewayAuthorizer(
  legacyToken: string,
  deps: { clients?: GatewayClientRepository; legacyEnabled?: boolean } = {},
): GatewayAuthorizer {
  const clients = deps.clients ?? createGatewayClientRepository();
  const legacyOn = deps.legacyEnabled ?? legacyTokenEnabled();
  const cache = new Map<string, { principal: GatewayPrincipal; until: number }>();

  return {
    async authorize(provided, now = Date.now()) {
      if (!provided) return null;
      if (legacyOn && tokensMatch(provided, legacyToken)) {
        return { clientId: 'legacy', clientName: 'legacy' };
      }
      // Só tokens no formato de cliente chegam ao banco — lixo não vira query.
      if (!provided.startsWith(CLIENT_TOKEN_PREFIX)) return null;

      const hash = hashClientToken(provided);
      const hit = cache.get(hash);
      if (hit && now < hit.until) return hit.principal;
      cache.delete(hash);

      const client = await clients.findActiveByHash(hash);
      if (!client) return null;
      const principal = { clientId: client.id, clientName: client.name };
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(hash, { principal, until: now + CACHE_TTL_MS });
      void clients.touch(client.id).catch(() => {}); // telemetria: nunca bloqueia
      return principal;
    },
  };
}
