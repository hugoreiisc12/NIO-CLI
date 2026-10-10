import { readFileSync } from 'node:fs';

/** Um flag env vale `true`/`1` (case-insensitive). */
function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Flag env tri-estado: `true` (true/1/yes/on), `false` (false/0/no/off), ou `undefined` se ausente/ilegível. */
function envTriState(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

/** Hosts de banco em loopback — TLS não é o default aí (dev local, sem cert). */
const LOOPBACK_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `true` se a URL aponta pra um Postgres em loopback. URL ilegível → `false` (prefere TLS). */
function isLoopbackDbHost(url: string): boolean {
  try {
    return LOOPBACK_DB_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Opção `ssl` do `pg.Pool` a partir do ambiente. Pura o suficiente pra testar. */
export type PgSslOption =
  | boolean
  | { rejectUnauthorized: boolean; ca?: string; servername?: string };

/**
 * Monta a opção TLS **verificada** (`rejectUnauthorized: true`), com CA e servername
 * opcionais. `NIO_DATABASE_SSL_SERVERNAME` força a verificação de hostname contra ESSE
 * nome (o do SAN do cert) quando a URL conecta por **IP** — o `pg` só injeta o próprio
 * host como servername quando é hostname (`net.isIP(host) === 0`), então pra IP o nosso
 * valor passa intacto ao `tls.connect`. Uso: cert self-signed cujo SAN é um nome, mas o
 * cliente conecta pelo IP (evita `ERR_TLS_CERT_ALTNAME_INVALID` sem afrouxar a verificação).
 */
function verifiedSsl(ca?: string): PgSslOption {
  const servername = process.env.NIO_DATABASE_SSL_SERVERNAME?.trim() || undefined;
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}), ...(servername ? { servername } : {}) };
}

/**
 * TLS **ligado por padrão** — só fica off em banco loopback (dev local) ou com
 * opt-out explícito (`NIO_DATABASE_SSL=false`). A versão antiga exigia opt-in, o
 * que deixava a senha do banco e todo o tráfego em texto claro por descuido de
 * config no cenário remoto/nuvem (MITM). Quando ligado, o certificado do servidor
 * **é verificado** (`rejectUnauthorized: true`). `NIO_DATABASE_CA` aponta um PEM
 * de CA privada; só `NIO_DATABASE_SSL_INSECURE=1` desliga a verificação, e isso
 * grita no log.
 */
export function readSslOption(
  url: string = process.env.NIO_DATABASE_URL?.trim() ?? '',
): PgSslOption | undefined {
  const explicit = envTriState('NIO_DATABASE_SSL');
  const enabled = explicit ?? !isLoopbackDbHost(url);
  if (!enabled) return undefined;

  const caPath = process.env.NIO_DATABASE_CA?.trim();
  const insecure = envFlag('NIO_DATABASE_SSL_INSECURE');

  // CA + insecure juntos: a CA vence (TLS verificado). Se a CA estiver
  // ilegível, FALLBACK para insecure (não quebra quem já conectava assim) —
  // com aviso alto pra corrigir o caminho da CA.
  if (insecure && caPath) {
    try {
      const ca = readFileSync(caPath, 'utf8');
      console.error(
        '[pg] NIO_DATABASE_CA e NIO_DATABASE_SSL_INSECURE definidos juntos — ' +
          'usando a CA (TLS verificado). Remova o flag insecure.',
      );
      return verifiedSsl(ca);
    } catch {
      console.error(
        `[pg] AVISO: NIO_DATABASE_CA ilegível ("${caPath}") — fallback para ` +
          'INSECURE (TLS sem verificação). Corrija o caminho da CA.',
      );
    }
  }

  if (insecure) {
    console.error(
      '[pg] AVISO: NIO_DATABASE_SSL_INSECURE=1 — TLS sem verificação de certificado. ' +
        'A conexão com o banco fica vulnerável a MITM. Use NIO_DATABASE_CA em vez disso.',
    );
    return { rejectUnauthorized: false };
  }

  if (caPath) {
    try {
      return verifiedSsl(readFileSync(caPath, 'utf8'));
    } catch (err) {
      throw new Error(`NIO_DATABASE_CA não pôde ser lido ("${caPath}"): ${(err as Error).message}`);
    }
  }
  return verifiedSsl();
}

/** Códigos de erro TLS por certificado não-confiável (self-signed / CA privada). */
const TLS_CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** `true` se o erro do pg é rejeição de certificado TLS — não credencial/host/rede. */
export function isTlsCertError(code?: string, message?: string): boolean {
  if (code && TLS_CERT_ERROR_CODES.has(code)) return true;
  return /self[- ]signed certificate|unable to verify|certificate/i.test(message ?? '');
}

/**
 * Causa raiz da falha de conexão, para retomada guiada (wizard `nio config
 * setup`, `db:ping`). `unknown` = mantém o comportamento legado (hint genérico
 * de rede) — fallback seguro quando nada específico casa.
 */
export type DbFailKind =
  | 'tls-self-signed'
  | 'tls-expired'
  | 'tls-server-off'
  | 'tls-required'
  | 'unknown';

/** Servidor sem SSL e o cliente forçou TLS (`NIO_DATABASE_SSL=true` à toa). */
const SERVER_NO_SSL_RE = /does not support SSL|SSL (is not enabled|connections are not)/i;

/** Servidor exige TLS (`hostssl` no pg_hba) e o cliente foi sem TLS. */
const SERVER_REQUIRES_SSL_RE = /SSL off/i;

/**
 * Classifica o erro do pg. Pura (testável), não lança. `isTlsCertError`
 * continua existindo (compat) — o `kind` só refina qual ação sugerir.
 */
export function classifyDbError(code?: string, message?: string): DbFailKind {
  const msg = message ?? '';
  if (code === 'CERT_HAS_EXPIRED' || /certificate has expired/i.test(msg)) return 'tls-expired';
  if (SERVER_NO_SSL_RE.test(msg)) return 'tls-server-off';
  if (code === '28000' && SERVER_REQUIRES_SSL_RE.test(msg)) return 'tls-required';
  if (isTlsCertError(code, msg)) return 'tls-self-signed';
  return 'unknown';
}
