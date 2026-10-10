import type { IncomingMessage, ServerResponse } from 'node:http';
import * as security from './services/security.js';
import { createUserRepository } from '../adapters/pg/user-repository.js';
import { readJsonBody, type RequestContext } from './edge-filter.js';
import { auditAuth, requireAuth, sendJson } from './handlers.js';

export async function handleSecurity(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
): Promise<void> {
  const userId = await requireAuth(req, res);
  if (userId === null) return;

  if (req.method === 'GET' && path === '/security/status') {
    sendJson(res, 200, await security.status(userId));
    return;
  }

  const body = await readJsonBody<{
    phone?: string;
    challengeId?: string;
    code?: string;
    type?: 'otp' | 'backup';
    currentPassword?: string;
    newPassword?: string;
  }>(req);
  const type = body.type === 'backup' ? 'backup' : 'otp';

  if (path === '/security/change-password') {
    if (!body.currentPassword || !body.newPassword) {
      return sendJson(res, 400, { error: 'currentPassword e newPassword são obrigatórios' });
    }
    const r = await security.changePassword(userId, body.currentPassword, body.newPassword);
    auditAuth(req, ctx, r.ok ? 'password_changed' : 'password_fail', {
      userId,
      reason: r.ok ? undefined : r.error,
    });
    return sendJson(res, r.ok ? 200 : 401, r.ok ? { ok: true } : { error: r.error });
  }

  if (path === '/security/enable-2fa') {
    // envia o OTP pro número NOVO (o usuário ainda não tem phone registrado)
    if (!body.phone) return sendJson(res, 400, { error: 'phone é obrigatório' });
    const r = await security.startSecurityChallenge(userId, body.phone);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return sendJson(res, 200, {
      challengeId: r.challengeId,
      smsMode: r.smsMode,
      devCode: r.devCode,
    });
  }

  if (path === '/security/challenge') {
    // envia o OTP pro número REGISTRADO (pra confirmar disable / regenerate)
    const user = await createUserRepository().findById(userId);
    if (!user?.phone) return sendJson(res, 400, { error: '2FA não está ativo' });
    const r = await security.startSecurityChallenge(userId, user.phone);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return sendJson(res, 200, {
      challengeId: r.challengeId,
      smsMode: r.smsMode,
      devCode: r.devCode,
    });
  }

  if (!body.challengeId || !body.code) {
    return sendJson(res, 400, { error: 'challengeId e code são obrigatórios' });
  }

  if (path === '/security/confirm-2fa') {
    if (!body.phone) return sendJson(res, 400, { error: 'phone é obrigatório' });
    const r = await security.confirmEnable2fa(userId, body.challengeId, body.code, body.phone);
    auditAuth(req, ctx, r.ok ? '2fa_enabled' : '2fa_fail', {
      userId,
      reason: r.ok ? undefined : r.error,
    });
    return sendJson(
      res,
      r.ok ? 200 : 401,
      r.ok ? { backupCodes: r.backupCodes } : { error: r.error },
    );
  }
  if (path === '/security/disable-2fa') {
    const r = await security.disable2fa(userId, body.challengeId, body.code, type);
    auditAuth(req, ctx, r.ok ? '2fa_disabled' : '2fa_fail', {
      userId,
      reason: r.ok ? undefined : r.error,
    });
    return sendJson(res, r.ok ? 200 : 401, r.ok ? { ok: true } : { error: r.error });
  }
  if (path === '/security/regenerate-backup-codes') {
    const r = await security.regenerateBackupCodes(userId, body.challengeId, body.code, type);
    return sendJson(
      res,
      r.ok ? 200 : 401,
      r.ok ? { backupCodes: r.backupCodes } : { error: r.error },
    );
  }
  sendJson(res, 404, { error: 'rota desconhecida' });
}
