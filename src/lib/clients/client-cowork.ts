import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupFile, writeJson } from '../file-merge.js';
import { brand, envName } from '../../brand.js';
import type { InstallResult } from './client-base.js';
import { ensureMcpServersJson, readJsonSafe } from './client-base.js';

export function installVSCodeRepo(cwd: string): InstallResult {
  const path = join(cwd, '.vscode', 'mcp.json');
  return ensureMcpServersJson(path, 'servers');
}

// ---------------------------------------------------------------------------
// Claude Desktop / Cowork — ativa o conector direto no config, sem `.mcpb`.
// ---------------------------------------------------------------------------

/** Diretório de config do Claude Desktop por SO (criado pelo app quando instalado). */
export function coworkConfigDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');
  }
  return join(homedir(), '.config', 'Claude');
}

export function coworkConfigPath(): string {
  return join(coworkConfigDir(), 'claude_desktop_config.json');
}

/** O app está instalado? Presença do dir de config é o sinal (o app o cria). */
export function coworkAppInstalled(): boolean {
  return existsSync(coworkConfigDir());
}

/** O conector nio já está no `claude_desktop_config.json`? */
export function coworkConfigured(): boolean {
  const path = coworkConfigPath();
  if (!existsSync(path)) return false;
  try {
    const json = (readJsonSafe(path) ?? {}) as { mcpServers?: Record<string, unknown> };
    return Boolean(json.mcpServers?.[brand.mcpServerKey]);
  } catch {
    return false;
  }
}

/** Path absoluto do `dist/mcp-server.js` deste pacote (compila pra `dist/lib/clients/`). */
export function mcpServerJsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../dist/lib/clients
  return join(here, '..', '..', 'mcp-server.js'); // .../dist/mcp-server.js
}

interface CoworkEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Ativa o conector nio direto no `claude_desktop_config.json` do Claude Desktop.
 *
 * Usa caminhos ABSOLUTOS (`process.execPath` + `dist/mcp-server.js`) porque o app é
 * GUI e tem PATH mínimo — `nio-cli`/`node` via nvm não seriam encontrados. O PAT
 * vem do `~/.nio/credentials.json` (via `nio login`); `NIO_CLIENT=cowork`
 * faz o server servir as skills por prompts/resources e escolher projeto por sessão.
 * Não-destrutivo: faz merge + backup do config existente.
 */
export function installCoworkGlobal(): InstallResult {
  const path = coworkConfigPath();
  const entry: CoworkEntry = {
    command: process.execPath,
    args: [mcpServerJsPath()],
    env: { [envName('CLIENT')]: 'cowork' },
  };

  if (!existsSync(path)) {
    writeJson(path, { mcpServers: { [brand.mcpServerKey]: entry } });
    return { status: 'created', path };
  }

  const existing = (readJsonSafe(path) ?? {}) as Record<string, unknown>;
  const root = (existing.mcpServers ?? {}) as Record<string, CoworkEntry | undefined>;
  const current = root[brand.mcpServerKey];

  if (
    current &&
    current.command === entry.command &&
    current.args?.[0] === entry.args?.[0] &&
    current.env?.[envName('CLIENT')] === 'cowork'
  ) {
    return { status: 'already_configured', path };
  }

  const backup = backupFile(path);
  writeJson(path, { ...existing, mcpServers: { ...root, [brand.mcpServerKey]: entry } });
  return { status: 'updated', path, backup };
}
