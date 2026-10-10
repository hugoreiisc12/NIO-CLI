import type { McpSpec } from '../../core/environment.js';

export const NIO_ENTRY = { command: ['nio-cli'], environment: {} as Record<string, string> };

export const PG_MCP: McpSpec = {
  id: 'postgres',
  command: ['npx', '-y', '@modelcontextprotocol/server-postgres'],
  environment: { DATABASE_URL: 'x' },
};

export const REMOTE_TIMEOUT_MCP: McpSpec = {
  id: 'bi-gw',
  url: 'http://10.0.0.1:8011/mcp',
  timeout: 120_000,
};

export const LOCAL_TIMEOUT_MCP: McpSpec = { ...PG_MCP, id: 'pg-lan', timeout: 30_000 };

export type McpMap = Record<string, { timeout?: number; type?: string } | undefined>;

/** Entrada de MCP do config planejado — falha o teste se o id não foi gravado. */
export function entrada(
  next: Record<string, unknown>,
  id: string,
): { timeout?: number; type?: string } {
  const found = (next.mcp as McpMap)[id];
  if (!found) throw new Error(`o config planejado não tem o MCP "${id}"`);
  return found;
}
