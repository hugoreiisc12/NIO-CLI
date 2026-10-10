#!/usr/bin/env node

/**
 * `nio-gateway` — entrypoint HTTP do Gateway. Node nativo (`http.createServer`,
 * sem framework nem deps externas), loopback only. Rotas: `/register`, `/login`
 * (1º fator), `/verify-2fa` (2º fator → JWT), `/logout`, `/logout-all`,
 * `/health`, `/security/*`.
 */

import '../lib/load-env.js';

import { createServer } from 'node:http';
import { sweep } from './throttle.js';
import { createLoginIpRepository } from '../adapters/pg/login-ip-repository.js';
import { createAuthEventRepository } from '../adapters/pg/auth-event-repository.js';
import {
  BadRequestError,
  buildContext,
  extractGatewayToken,
  hasBrowserOrigin,
  logRequest,
  tokensMatch,
} from './edge-filter.js';
import { logEvent } from './log.js';
import { GATEWAY_PORT, GATEWAY_HOST } from './config.js';
import { VERSION } from '../version.js';
import { getOrCreateGatewayToken } from '../lib/auth/gateway-token.js';
import {
  TOKEN_REQUIRED,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleRegister,
  handleVerify2fa,
  sendJson,
} from './handlers.js';
import { handleSecurity } from './handlers-security.js';

/** Retenção da auditoria de IP de login (ADR 0011 §F / LGPD). */
const LOGIN_IP_RETENTION_DAYS = 90;

/** Retenção da trilha de auth (ADR 0012 / LGPD) — janela maior, é forense.
 * Clamp em >= 1: um valor negativo faria o `DELETE` apagar a tabela inteira (TP-5). */
const AUTH_EVENTS_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.NIO_AUTH_EVENTS_RETENTION_DAYS) || 180,
);

async function main(): Promise<void> {
  // TP-1 (migration 0008): o gateway usa o role privilegiado `nio_gateway`.
  // Roda antes de qualquer `getPool()`. Fallback: `NIO_DATABASE_URL` (setup
  // single-role legado).
  if (process.env.NIO_GATEWAY_DATABASE_URL?.trim()) {
    process.env.NIO_DATABASE_URL = process.env.NIO_GATEWAY_DATABASE_URL.trim();
  }

  const gatewayToken = await getOrCreateGatewayToken();

  const server = createServer((req, res) => {
    const ctx = buildContext(req);

    if (hasBrowserOrigin(req)) {
      logRequest(ctx, { rejected: 'origin_de_browser' }, 'warn');
      sendJson(res, 403, { error: 'requests com header Origin não são aceitas' });
      return;
    }

    if (TOKEN_REQUIRED(ctx.path) && !tokensMatch(extractGatewayToken(req), gatewayToken)) {
      logRequest(ctx, { rejected: 'token_invalido' }, 'warn');
      sendJson(res, 403, { error: 'token do gateway ausente ou inválido' });
      return;
    }

    logRequest(ctx);

    void (async () => {
      try {
        if (ctx.method === 'POST' && ctx.path === '/register')
          return await handleRegister(req, res, ctx);
        if (ctx.method === 'POST' && ctx.path === '/login') return await handleLogin(req, res, ctx);
        if (ctx.method === 'POST' && ctx.path === '/verify-2fa')
          return await handleVerify2fa(req, res, ctx);
        if (ctx.method === 'POST' && ctx.path === '/logout')
          return await handleLogout(req, res, ctx);
        if (ctx.method === 'POST' && ctx.path === '/logout-all')
          return await handleLogoutAll(req, res, ctx);
        if (ctx.path.startsWith('/security/')) return await handleSecurity(req, res, ctx, ctx.path);
        if (ctx.method === 'GET' && ctx.path === '/health')
          return sendJson(res, 200, { ok: true, version: VERSION });
        sendJson(res, 404, { error: 'rota desconhecida' });
      } catch (err) {
        logRequest(ctx, { error: (err as Error).message, stack: (err as Error).stack }, 'error');
        if (err instanceof BadRequestError) {
          sendJson(res, 400, { error: err.message });
        } else {
          // Não vaza mensagem interna (erro de DB, stack) pro cliente — só o
          // traceId pra correlacionar com o log (auditoria L-3).
          sendJson(res, 500, {
            error: 'erro interno ao processar a request',
            traceId: ctx.traceId,
          });
        }
      }
    })();
  });

  // GC das janelas de rate limiting em memória (M-3/M-4) — `unref` pra não
  // segurar o processo.
  setInterval(() => sweep(), 5 * 60_000).unref();

  // Retenção das trilhas de auditoria (LGPD) — no boot e 1×/dia.
  //   login_ip_events → 90 d (ADR 0011 §F)   ·   auth_events → 180 d (ADR 0012)
  const pruneAudit = async () => {
    try {
      const a = await createLoginIpRepository().pruneOlderThan(LOGIN_IP_RETENTION_DAYS);
      const b = await createAuthEventRepository().pruneOlderThan(AUTH_EVENTS_RETENTION_DAYS);
      if (a + b > 0) logEvent('audit_pruned', { loginIpEvents: -a, authEvents: -b });
    } catch {
      /* best-effort */
    }
  };
  void pruneAudit();
  setInterval(() => void pruneAudit(), 24 * 60 * 60_000).unref();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logEvent(
        'listen_failed',
        {
          reason: 'port_in_use',
          host: GATEWAY_HOST,
          port: GATEWAY_PORT,
          hint: 'outro gateway rodando (container?)',
        },
        'error',
      );
    } else {
      logEvent('socket_error', { code: err.code, error: err.message }, 'error');
    }
    process.exit(1);
  });

  server.listen(GATEWAY_PORT, GATEWAY_HOST, () => {
    logEvent('gateway_listening', { host: GATEWAY_HOST, port: GATEWAY_PORT, version: VERSION });
  });
}

main().catch((err) => {
  logEvent('fatal', { error: (err as Error).message, stack: (err as Error).stack }, 'error');
  process.exit(1);
});
