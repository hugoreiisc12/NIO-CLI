/**
 * `GatewayClientRepository` em Postgres (`gateway_clients`, migration 0017). O token
 * em texto nunca chega aqui — só o SHA-256 dele. Role: `nio_gateway`.
 */
import type { GatewayClient } from '../../core/types.js';
import type { GatewayClientRepository } from '../../core/repositories.js';
import { isUuid, query } from './client.js';

interface ClientRow {
  id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const COLS = 'id, name, created_at, last_used_at, revoked_at';
const UNIQUE_VIOLATION = '23505';

export function mapGatewayClientRow(row: ClientRow): GatewayClient {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function createGatewayClientRepository(): GatewayClientRepository {
  return {
    async create(name, tokenHash) {
      try {
        const res = await query<ClientRow>(
          `INSERT INTO gateway_clients (name, token_hash) VALUES ($1, $2) RETURNING ${COLS}`,
          [name, tokenHash],
        );
        return mapGatewayClientRow(res.rows[0]!);
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new Error(`já existe um cliente chamado "${name}"`);
        }
        throw err;
      }
    },

    async findActiveByHash(tokenHash) {
      const res = await query<ClientRow>(
        `SELECT ${COLS} FROM gateway_clients WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
      return res.rows[0] ? mapGatewayClientRow(res.rows[0]) : null;
    },

    async touch(id) {
      if (!isUuid(id)) return;
      await query(
        `UPDATE gateway_clients SET last_used_at = NOW()
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`,
        [id],
      );
    },

    async list() {
      const res = await query<ClientRow>(`SELECT ${COLS} FROM gateway_clients ORDER BY created_at`);
      return res.rows.map(mapGatewayClientRow);
    },

    async revoke(idOrName) {
      // `id::text` evita 22P02 quando o argumento é um nome (não-UUID).
      const res = await query(
        `UPDATE gateway_clients SET revoked_at = NOW()
         WHERE revoked_at IS NULL AND (id::text = $1 OR name = $1)`,
        [idOrName],
      );
      return (res.rowCount ?? 0) > 0;
    },
  };
}
