import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { login, logout, logoutAll, verifyLogin } from './services/login.js';
import { register } from './services/register.js';
import { loginDelayMs, recordLoginFail, recordLoginOk } from './throttle.js';
import { authenticate } from './middleware/auth.js';
import { createLoginIpRepository } from '../adapters/pg/login-ip-repository.js';
import { createAuthEventRepository } from '../adapters/pg/auth-event-repository.js';
import { clientIp, logAuthEvent, readJsonBody, type RequestContext } from './edge-filter.js';
import { logEvent } from './log.js';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Rotas que exigem o token local — `/health` fica de fora, é só liveness probe. */
export const TOKEN_REQUIRED = (path: string): boolean =>
  path === '/register' ||
  path === '/login' ||
  path === '/logout' ||
  path === '/logout-all' ||
  path === '/verify-2fa' ||
  path.startsWith('/security/');

/** Extrai o `userId` do Bearer JWT (rotas `/security/*`). `null` → já respondeu 401. */
export async function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  const auth = await authenticate(req.headers.authorization);
  if (!auth.ok) {
    sendJson(res, 401, { error: 'não autenticado', reason: auth.reason });
    return null;
  }
  return auth.userId;
}

function sessionJson(s: {
  token: string;
  userId: number;
  name: string;
  sessionId: string;
  expiresAt: Date;
}) {
  return {
    token: s.token,
    userId: s.userId,
    name: s.name,
    sessionId: s.sessionId,
    expiresAt: s.expiresAt.toISOString(),
  };
}

/** Auditoria de IP de login (ADR 0011 §F) — best-effort, nunca afeta a resposta. */
async function recordLoginIp(req: IncomingMessage, userId: number): Promise<void> {
  const ip = clientIp(req);
  if (!ip) return;
  try {
    await createLoginIpRepository().record(userId, ip);
  } catch (err) {
    logEvent('login_ip_record_failed', { error: (err as Error).message }, 'warn');
  }
}

/**
 * Trilha de auth (ADR 0012): loga no stderr (real-time) **e** grava em
 * `auth_events` (histórico consultável). O INSERT é best-effort — nunca bloqueia
 * a resposta.
 */
export function auditAuth(
  req: IncomingMessage,
  ctx: RequestContext,
  event: string,
  meta: { name?: string; userId?: number; reason?: string } = {},
): void {
  logAuthEvent(ctx, event, meta);
  void createAuthEventRepository()
    .record({
      event,
      name: meta.name ?? null,
      userId: meta.userId ?? null,
      ip: clientIp(req),
      traceId: ctx.traceId,
      detail: meta.reason ? { reason: meta.reason } : null,
    })
    .catch((err: unknown) =>
      logEvent('auth_event_record_failed', { error: (err as Error).message }, 'warn'),
    );
}

export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody<{ name?: string; password?: string }>(req);
  if (!body.name || !body.password) {
    sendJson(res, 400, { error: 'name e password são obrigatórios' });
    return;
  }
  const out = await register(body.name, body.password);
  if (!out.ok) {
    const msg = {
      invalid_name: 'nome inválido (1–64 chars)',
      weak_password: 'senha muito curta',
      name_taken: 'nome já em uso',
    }[out.reason];
    sendJson(res, out.reason === 'name_taken' ? 409 : 400, { error: msg, reason: out.reason });
    return;
  }
  auditAuth(req, ctx, 'register', { name: out.name, userId: out.userId });
  sendJson(res, 201, {
    userId: out.userId,
    name: out.name,
    ...(out.passwordWarning ? { passwordWarning: out.passwordWarning } : {}),
  });
}

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody<{ name?: string; password?: string }>(req);
  if (!body.name || !body.password) {
    sendJson(res, 400, { error: 'name e password são obrigatórios' });
    return;
  }

  // M-3: atraso escalonado por `name` — brute-force online fica inviável sem
  // trancar a conta de ninguém. Some no primeiro login certo.
  const delay = loginDelayMs(body.name);
  if (delay > 0) await sleep(delay);

  const out = await login(body.name, body.password);
  if (!out.ok) {
    if (out.reason === 'bad_credentials') {
      recordLoginFail(body.name);
      auditAuth(req, ctx, 'password_fail', { name: body.name });
      sendJson(res, 401, { error: 'usuário ou senha inválidos' });
    } else {
      auditAuth(req, ctx, 'password_ok', { name: body.name, reason: 'sms_error' });
      sendJson(res, 503, { error: out.error });
    }
    return;
  }
  recordLoginOk(body.name); // senha certa (com ou sem 2FA pendente)
  if (out.step === 'done') {
    auditAuth(req, ctx, 'password_ok', { name: body.name, userId: out.session.userId });
    void recordLoginIp(req, out.session.userId);
    sendJson(res, 200, { step: 'done', ...sessionJson(out.session) });
    return;
  }
  auditAuth(req, ctx, '2fa_sent', { name: body.name });
  sendJson(res, 200, {
    step: '2fa_required',
    challengeId: out.challengeId,
    phoneHint: out.phoneHint,
    smsMode: out.smsMode,
    devCode: out.devCode,
  });
}

export async function handleVerify2fa(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody<{ challengeId?: string; code?: string; type?: 'otp' | 'backup' }>(
    req,
  );
  if (!body.challengeId || !body.code) {
    sendJson(res, 400, { error: 'challengeId e code são obrigatórios' });
    return;
  }
  const out = await verifyLogin(
    body.challengeId,
    body.code,
    body.type === 'backup' ? 'backup' : 'otp',
  );
  if (!out.ok) {
    auditAuth(req, ctx, out.reason === 'expired' ? '2fa_expired' : '2fa_fail', {
      reason: out.reason,
      userId: out.userId,
    });
    const status = out.reason === 'attempts_exhausted' ? 429 : 401;
    sendJson(res, status, {
      error: 'código incorreto ou expirado',
      reason: out.reason,
      remaining: out.remaining,
      requiresBackupCode: out.requiresBackupCode,
    });
    return;
  }
  auditAuth(req, ctx, '2fa_ok', { userId: out.session.userId });
  void recordLoginIp(req, out.session.userId);
  sendJson(res, 200, {
    step: 'done',
    ...sessionJson(out.session),
    backupCodesRemaining: out.backupCodesRemaining,
  });
}

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  // Só revoga a sessão do próprio Bearer — sem isto, qualquer um com o token do
  // gateway revogava sessão alheia por `sessionId` (auditoria L-5).
  const auth = await authenticate(req.headers.authorization);
  if (!auth.ok) {
    // Token já inválido/revogado/expirado → não há o que revogar; o cliente
    // limpa o estado local do mesmo jeito.
    sendJson(res, 200, { ok: true });
    return;
  }
  await logout(auth.sessionId);
  auditAuth(req, ctx, 'logout', { userId: auth.userId });
  sendJson(res, 200, { ok: true });
}

export async function handleLogoutAll(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const auth = await authenticate(req.headers.authorization);
  if (!auth.ok) {
    sendJson(res, 200, { ok: true }); // nada ativo pra revogar; cliente limpa local
    return;
  }
  await logoutAll(auth.userId);
  auditAuth(req, ctx, 'logout_all', { userId: auth.userId });
  sendJson(res, 200, { ok: true });
}
