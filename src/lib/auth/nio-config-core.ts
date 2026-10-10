import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homePath } from '../../brand.js';
import { NIO_AI_BASE_URL, NIO_AI_MODEL_ID } from '../clients/client-configs.js';
import { closePool, pingDetailed, type PingResult } from '../../adapters/pg/client.js';
import { jwtSecretWeakness } from '../../gateway/config.js';
import { c, sym } from '../colors.js';
import { dlog } from '../debug.js';
import { hardenSecretFile } from '../secure-file.js';

export const CONFIG_FILE = homePath('config.env');

export const PG_URL = /^postgres(ql)?:\/\/.+/i;

export interface ConfigProblem {
  key: string;
  issue: 'missing' | 'invalid' | 'unreachable';
  hint: string;
  fixable?: boolean; // erro que o wizard resolve (ex.: TLS mal configurado) → dispara o setup
}

export type SslMode = 'off' | 'verify' | 'insecure';

const TLS_CERT_HINT =
  'TLS rejeitou o certificado (self-signed?). Escolha "Sem TLS" na LAN, ou informe uma CA em NIO_DATABASE_CA.';

const TLS_EXPIRED_HINT =
  'Certificado do Postgres vencido — renove no servidor (scripts/db-tls-setup.sh server <host>) e rode de novo.';

const TLS_SERVER_OFF_HINT =
  'Servidor sem TLS e cliente forçando TLS — escolha "Sem TLS" (NIO_DATABASE_SSL=false).';

const TLS_REQUIRED_HINT =
  'Servidor exige TLS (hostssl) — "Sem TLS" não conecta aqui. Use "TLS com verificação + CA" ou "insecure" temporário.';

const CONN_HINT = 'Confira o endereço/credencial e a rede/VPN, e rode de novo.';

export interface PingFailureHelp {
  hint: string;
  /** Erro que o wizard resolve → `ensureConfig` reabre o setup em TTY. */
  fixable: boolean;
}

/**
 * Hint + retomada a partir do `PingResult`. Pura (testável). `unknown` sem o
 * sinal legado cai no hint genérico — fallback idêntico ao comportamento antigo.
 */
export function describePingFailure(res: PingResult): PingFailureHelp {
  switch (res.tlsKind) {
    case 'tls-self-signed':
      return { fixable: true, hint: TLS_CERT_HINT };
    case 'tls-expired':
      return { fixable: true, hint: TLS_EXPIRED_HINT };
    case 'tls-server-off':
      return { fixable: true, hint: TLS_SERVER_OFF_HINT };
    case 'tls-required':
      return { fixable: true, hint: TLS_REQUIRED_HINT };
    default:
      return res.tlsCertError
        ? { fixable: true, hint: TLS_CERT_HINT }
        : { fixable: false, hint: CONN_HINT };
  }
}

/** Parse simples de `KEY=value` (ignora `#` comentário e linha vazia). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function readConfigFile(path = CONFIG_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Funde `updates` no arquivo (cria se não existe), preservando o resto. chmod 600. */
export function writeConfigFile(updates: Record<string, string>, path = CONFIG_FILE): void {
  const merged = { ...readConfigFile(path), ...updates };
  const body =
    '# Config da NIO-CLI — gerado por `nio config setup`. Não commitar.\n' +
    Object.entries(merged)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // `mode` fecha a janela do arquivo novo em 0644 (auditoria L-4); o harden cobre
  // um arquivo pré-existente com permissão frouxa — e a ACL no Windows, onde o
  // modo POSIX é inócuo.
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  const hard = hardenSecretFile(path);
  if (hard.outcome !== 'ok') {
    console.error(
      `${c.yellow(sym.warn)} não consegui restringir ${path} ao seu usuário ` +
        `${c.dim(`(${hard.error ?? hard.outcome})`)} — o arquivo guarda segredos do time.`,
    );
  }
}

/** Validação síncrona (sem rede): `NIO_DATABASE_URL` e `JWT_SECRET` presentes/ok. */
export function validateConfigShape(env: NodeJS.ProcessEnv): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const url = env.NIO_DATABASE_URL?.trim();
  const jwt = env.JWT_SECRET?.trim();

  if (!url) {
    problems.push({
      key: 'NIO_DATABASE_URL',
      issue: 'missing',
      hint: 'endereço do Postgres da equipe',
    });
  } else if (!PG_URL.test(url)) {
    problems.push({
      key: 'NIO_DATABASE_URL',
      issue: 'invalid',
      hint: 'precisa começar com postgres://',
    });
  }
  // `JWT_SECRETS` (rotação por kid, ADR 0011) supre o `JWT_SECRET` — o gateway
  // lança no boot se a lista estiver malformada, então aqui só checamos presença.
  const hasJwtSecrets = Boolean(env.JWT_SECRETS?.trim());
  if (!jwt && !hasJwtSecrets) {
    problems.push({
      key: 'JWT_SECRET',
      issue: 'missing',
      hint: 'segredo compartilhado do time (assina o login) — ou use JWT_SECRETS',
    });
  } else if (jwt) {
    const weak = jwtSecretWeakness(jwt);
    if (weak) problems.push({ key: 'JWT_SECRET', issue: 'invalid', hint: weak });
  }
  return problems;
}

/** Mascara a senha da connection string pro log. */
function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:***@');
}

/** Checa a config já carregada em `process.env`, incluindo um `SELECT 1`. `[]` = ok. */
export async function checkConfig(): Promise<ConfigProblem[]> {
  dlog(
    'config: NIO_DATABASE_URL =',
    process.env.NIO_DATABASE_URL ? maskUrl(process.env.NIO_DATABASE_URL) : '(vazio)',
  );
  dlog(
    'config: JWT_SECRET =',
    process.env.JWT_SECRET ? `(${process.env.JWT_SECRET.length} chars)` : '(vazio)',
  );
  dlog(
    'config: NIO_GATEWAY_URL =',
    process.env.NIO_GATEWAY_URL ?? '(default :3000 = nio-gateway direto)',
  );
  const problems = validateConfigShape(process.env);
  if (!problems.some((p) => p.key === 'NIO_DATABASE_URL')) {
    await closePool();
    const res = await pingDetailed();
    dlog('config: SELECT 1 =>', res.ok ? 'ok' : `FALHOU ${res.code ?? res.message ?? ''}`);
    if (!res.ok) {
      const help = describePingFailure(res);
      problems.push({
        key: 'NIO_DATABASE_URL',
        issue: 'unreachable',
        fixable: help.fixable,
        hint: help.hint,
      });
    }
  }
  return problems;
}

export interface AiBackendStatus {
  ok: boolean;
  models: string[];
  detail: string;
}

/**
 * Sonda o backend de IA (`GET <base>/models`): precisa estar no ar **e** servir
 * o `NIO_AI_MODEL_ID`. Consultivo — `nio config check` avisa sem reprovar, e o
 * `ensureConfig` não bloqueia por isso (comandos sem IA seguem funcionando).
 * `baseURL` é seam pra teste (default = `NIO_AI_BASE_URL`).
 */
export async function probeAiBackend(
  timeoutMs = 8000,
  baseURL: string = NIO_AI_BASE_URL,
): Promise<AiBackendStatus> {
  const base = baseURL.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, { signal: controller.signal });
    if (!res.ok) return { ok: false, models: [], detail: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    if (!models.includes(NIO_AI_MODEL_ID)) {
      return {
        ok: false,
        models,
        detail: `no ar, mas não serve ${NIO_AI_MODEL_ID} (serve: ${models.join(', ') || 'nada'})`,
      };
    }
    return { ok: true, models, detail: `no ar e serve ${NIO_AI_MODEL_ID}` };
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return { ok: false, models: [], detail: `inacessível (${cause})` };
  } finally {
    clearTimeout(timer);
  }
}
