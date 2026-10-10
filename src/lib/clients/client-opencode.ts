import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupFile, writeJson } from '../file-merge.js';
import { envName } from '../../brand.js';
import type { McpSpec } from '../../core/environment.js';
import type { InstallResult } from './client-base.js';
import { MCP_COMMAND, readJsonSafe } from './client-base.js';
import { NIO_AI_BASE_URL } from './client-env.js';
import { planOpencodeUpdate } from './client-opencode-plan.js';
import type { OpencodeServerEntry } from './client-opencode-shape.js';
import { opencodeMcpEntry, opencodeMcpOk } from './client-opencode-shape.js';

export * from './client-opencode-shape.js';
export * from './client-opencode-plan.js';

/** Path global do `opencode.json` (~/.config/opencode). Seam pra teste. */
export function opencodeGlobalPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

/**
 * `~/.config/opencode/opencode.json` — registro global do MCP `nio` + os MCPs do
 * perfil (`profileMcps`, do `EnvironmentBuilder`). Sem perfil, escreve só o `nio`
 * (comportamento anterior preservado). Semeia o provider dedicado `NIO_AI_PROVIDER`
 * apontando pro backend de IA direto (`baseURL`, default `NIO_AI_BASE_URL`) e grava
 * `model: NIO_OPERATOR_MODEL` no nível raiz — o `opencode` vira só o runtime, não o
 * motor (ver `docs/arch/ARQUITETURA-CLIENTE-IA.md`). Passe `''` pra não semear
 * provider (fica no default big-pickle). `path` é seam opcional (default = global)
 * pra teste não tocar no arquivo real do usuário.
 */
export function installOpencodeGlobal(
  profileMcps: McpSpec[] = [],
  path = opencodeGlobalPath(),
  baseURL: string | undefined = NIO_AI_BASE_URL,
): InstallResult {
  // `NIO_CLIENT=opencode` avisa o servidor MCP a (1) provisionar/auto-pull pra
  // `~/.config/opencode` e (2) filtrar os docs pelo surface `opencode`.
  const nioEntry = { command: [MCP_COMMAND], environment: { [envName('CLIENT')]: 'opencode' } };

  if (!existsSync(path)) {
    const { next } = planOpencodeUpdate({}, nioEntry, profileMcps, baseURL);
    writeJson(path, next);
    return { status: 'created', path };
  }

  const existing = readJsonSafe(path) ?? {};
  const { alreadyConfigured, next } = planOpencodeUpdate(existing, nioEntry, profileMcps, baseURL);
  if (alreadyConfigured) return { status: 'already_configured', path };

  const backup = backupFile(path);
  writeJson(path, next);
  return { status: 'updated', path, backup };
}

/**
 * Funde **uma** entrada de MCP no `opencode.json` global (fora do fluxo de
 * perfil) — usado pelo `nio docker toolkit up`. Preserva o resto do arquivo, faz
 * `.bak`. `remove: true` desabilita (`enabled: false`) em vez de fundir.
 */
export function upsertOpencodeMcp(
  spec: McpSpec,
  opts: { remove?: boolean; path?: string } = {},
): InstallResult {
  const path = opts.path ?? opencodeGlobalPath();

  if (!existsSync(path)) {
    if (opts.remove) return { status: 'already_configured', path };
    const servers = { [spec.id]: opencodeMcpEntry(spec) };
    writeJson(path, { mcp: servers });
    return { status: 'created', path };
  }

  const existing = readJsonSafe(path) ?? {};
  const servers = { ...((existing.mcp ?? {}) as Record<string, OpencodeServerEntry>) };
  const cur = servers[spec.id];

  if (opts.remove) {
    if (!cur || cur.enabled === false) return { status: 'already_configured', path };
    servers[spec.id] = { ...cur, enabled: false };
  } else {
    if (opencodeMcpOk(spec, cur)) return { status: 'already_configured', path };
    servers[spec.id] = opencodeMcpEntry(spec, cur);
  }

  const backup = backupFile(path);
  writeJson(path, { ...existing, mcp: servers });
  return { status: 'updated', path, backup };
}
