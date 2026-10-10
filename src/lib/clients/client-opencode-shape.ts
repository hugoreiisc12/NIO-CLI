import type { McpSpec } from '../../core/environment.js';
import { NIO_AI_VISION, compactionReserved } from './client-env.js';

export interface OpencodeServerEntry {
  type?: string;
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

/** Capacidades do modelo no `opencode.json`. Chaves do schema oficial — inventar quebra tudo. */
export function modelCapabilities(vision: boolean = NIO_AI_VISION): Partial<OpencodeModelEntry> {
  if (!vision) return {};
  return { attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } };
}

export const DEFAULT_OPENCODE_COMPACTION: Record<string, unknown> = {
  auto: true,
  prune: true,
  reserved: compactionReserved(),
};

/** Watcher: ignora dirs volumosos (não dispara reindex/eventos à toa). Só se ausente. */
export const DEFAULT_OPENCODE_WATCHER: Record<string, unknown> = {
  ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**'],
};

/**
 * Defaults de permissão do `opencode.json` (Sprint 7.5 de UI/UX).
 *
 * `bash` é `ask` sem allowlist, e isso é deliberado: uma allowlist de leitura
 * (`ls`, `git status`, `cat`) tirava o modal de aprovação justamente nos comandos
 * mais usados, e quem filtra por substring erra fácil — `git status` e
 * `git push` casam com o mesmo prefixo. O atalho legítimo continua sendo
 * responder `s` ("sempre") no próprio modal, que grava a regra de forma
 * consciente e visível.
 *
 * Só é semeado quando o config ainda não tem um bloco `permission` (nunca
 * sobrescreve o do usuário).
 */
export const DEFAULT_OPENCODE_PERMISSION: Record<string, unknown> = {
  bash: 'ask',
  edit: 'ask',
  webfetch: 'ask',
  external_directory: 'ask',
};

/** Monta a entrada OpenCode de um MCP, preservando campos do usuário. Remoto (`spec.url`) → `type: 'remote'`. */
export function opencodeMcpEntry(
  spec: McpSpec,
  current?: OpencodeServerEntry,
): OpencodeServerEntry {
  // `timeout` só entra quando o spec declara — ausente, fica o default do cliente.
  const timeout = spec.timeout !== undefined ? { timeout: spec.timeout } : {};
  if (spec.url) {
    return {
      type: 'remote',
      ...current,
      url: spec.url,
      enabled: true,
      ...(spec.headers ? { headers: { ...current?.headers, ...spec.headers } } : {}),
      ...timeout,
    };
  }
  const entry: OpencodeServerEntry = {
    type: 'local',
    ...current,
    command: spec.command,
    enabled: true,
    ...timeout,
  };
  if (spec.environment) {
    entry.environment = { ...current?.environment, ...spec.environment };
  }
  return entry;
}

/**
 * Uma entrada de MCP já está OK no `opencode.json`? (command/url batem, timeout
 * declarado está gravado, não desabilitada). Sem o `timeout` aqui, mudar o teto
 * no spec nunca chegaria ao arquivo — o `alreadyConfigured` barraria a escrita.
 */
export function opencodeMcpOk(spec: McpSpec, cur?: OpencodeServerEntry): boolean {
  if (!cur || cur.enabled === false) return false;
  if (spec.timeout !== undefined && cur.timeout !== spec.timeout) return false;
  return spec.url ? cur.url === spec.url : cur.command?.[0] === spec.command?.[0];
}

export interface OpencodeModelEntry {
  name?: string;
  limit?: { context?: number; output?: number };
  /** Capacidade de anexo — sem ela o OpenCode **descarta** a part de imagem (medido). */
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  [k: string]: unknown;
}

export interface OpencodeProviderEntry {
  npm?: string;
  name?: string;
  options?: Record<string, unknown>;
  models?: Record<string, OpencodeModelEntry | undefined>;
}
