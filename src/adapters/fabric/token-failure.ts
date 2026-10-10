import type { TokenResult, TokenStatus } from './token.js';

/** Corpo lido para parse (o `error_description` do Entra é longo) e teto exibido. */
export const ERROR_BODY_CHARS = 2_000;

const ERROR_DETAIL_CHARS = 300;

/** Janelas em que a falha fica cacheada — ver `failureResult`. */
export const UNAUTHORIZED_BLOCK_MS = 60_000;

export const UNAVAILABLE_BLOCK_MS = 15_000;

const DEFAULT_RETRY_AFTER_S = 30;

/** Dicas por código AADSTS — só os que mudam a ação do usuário (doc: reference-error-codes). */
const AAD_HINTS: ReadonlyArray<[RegExp, string]> = [
  [
    /AADSTS5007[69]|AADSTS53003|AADSTS50158/,
    'a conta exige MFA/Conditional Access — o grant de usuário (ROPC) não passa por MFA; use service principal ou peça exceção ao admin',
  ],
  [
    /AADSTS7000222/,
    'client secret EXPIRADO — gere outro em Entra → App registrations → Certificates & secrets e atualize AZURE_CLIENT_SECRET',
  ],
  [
    /AADSTS7000215|AADSTS7000218/,
    'client secret inválido ou ausente — AZURE_CLIENT_SECRET é o Value do segredo, não o Secret ID',
  ],
  [/AADSTS50126/, 'usuário ou senha inválidos (NIO_FABRIC_USERNAME/NIO_FABRIC_PASSWORD)'],
  [/AADSTS50053/, 'conta bloqueada por tentativas repetidas — aguarde antes de tentar de novo'],
  [/AADSTS5005[57]|AADSTS50034/, 'conta desabilitada, senha expirada ou usuário fora do tenant'],
  [
    /AADSTS65001|AADSTS90094/,
    'app sem consentimento — o admin precisa conceder as permissões (Power BI Service) ao app',
  ],
  [
    /AADSTS700016|AADSTS90002|AADSTS500011/,
    'tenant ou client id errado — confira AZURE_TENANT_ID/AZURE_CLIENT_ID',
  ],
];

/** Traduz o corpo de erro do Entra em mensagem acionável, preservando o código AADSTS. */
export function describeAadFailure(status: number, body: string): string {
  let desc = body;
  try {
    const j = JSON.parse(body) as { error?: string; error_description?: string };
    desc = [j.error, j.error_description].filter(Boolean).join(': ') || body;
  } catch {
    desc = body; // corpo não-JSON (HTML de proxy, etc.): mostra cru
  }
  const code = /AADSTS\d+/.exec(desc)?.[0];
  const hint = code ? AAD_HINTS.find(([re]) => re.test(code))?.[1] : undefined;
  const head = `token endpoint respondeu ${status}${code ? ` (${code})` : ''}`;
  return hint ? `${head}: ${hint}` : `${head} ${desc.slice(0, ERROR_DETAIL_CHARS)}`.trim();
}

/** Segundos do header `Retry-After` (429) — número ou data HTTP; `null` se ausente. */
export function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}

export function unconfiguredResult(): TokenResult {
  return {
    status: 'unconfigured',
    error:
      'Fabric não configurado: defina AZURE_TENANT_ID/AZURE_CLIENT_ID e ' +
      '(NIO_FABRIC_USERNAME/NIO_FABRIC_PASSWORD p/ token de usuário com RLS, ' +
      'ou AZURE_CLIENT_SECRET p/ service principal).',
  };
}

/**
 * Falha + por quanto tempo não vale a pena repetir. Repetir uma chamada que vai
 * falhar igual não é resiliência: no 429 piora o limite, e no 400 gasta 10 s de
 * timeout por tool do agente para receber a mesma resposta.
 */
export function failureResult(
  res: Response,
  body: string,
): { result: TokenResult; blockMs: number } {
  if (res.status === 429) {
    const s = retryAfterSeconds(res);
    return {
      result: {
        status: 'unavailable',
        error: `token endpoint limitou (429)${s !== null ? ` — aguarde ${s}s` : ''}`,
      },
      // O servidor disse quando voltar; obedecer é o mínimo. Sem header, 30 s.
      blockMs: (s ?? DEFAULT_RETRY_AFTER_S) * 1000,
    };
  }
  const status: TokenStatus =
    res.status === 400 || res.status === 401 ? 'unauthorized' : 'unavailable';
  return {
    result: { status, error: describeAadFailure(res.status, body) },
    // Credencial recusada não se conserta sozinha — só com `nio config setup`,
    // que chama invalidate() e derruba este bloqueio na hora.
    blockMs: status === 'unauthorized' ? UNAUTHORIZED_BLOCK_MS : UNAVAILABLE_BLOCK_MS,
  };
}
