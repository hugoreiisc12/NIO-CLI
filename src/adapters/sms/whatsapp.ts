/**
 * Adapter do 2º fator via WhatsApp Business API (Meta Graph) — `POST` no endpoint
 * de mensagens com token Bearer. Substitui o adapter SMS genérico (`http-generic`).
 */
import type { OtpSender, SmsResult } from '../../core/messaging.js';

export interface WhatsAppEnv {
  url?: string;
  token?: string;
  templateName?: string;
  templateLanguage?: string;
}

/** Número E.164 sem o `+` de prefixo (como a API da Meta espera no `to`). */
export function formatWhatsAppNumber(phone: string): string {
  return phone.replace(/^\+/, '');
}

/** Monta o JSON do POST. Exportado pra teste unitário sem rede. */
export function buildPayload(phone: string, code: string, env: WhatsAppEnv = {}): string {
  const payload = {
    messaging_product: 'whatsapp',
    to: formatWhatsAppNumber(phone),
    type: 'template',
    template: {
      name: env.templateName ?? 'autenticao',
      language: { code: env.templateLanguage ?? 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: code }],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: code }],
        },
      ],
    },
  };
  return JSON.stringify(payload);
}

interface WhatsAppReadEnv {
  url?: string;
  token?: string;
  templateName?: string;
  templateLanguage?: string;
}

function readEnv(): WhatsAppReadEnv {
  return {
    url: process.env.WHATSAPP_ENDPOINT_URL?.trim(),
    token: process.env.WHATSAPP_TOKEN?.trim(),
    templateName: process.env.WHATSAPP_TEMPLATE_NAME?.trim(),
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim(),
  };
}

/**
 * `echo` — endpoint em loopback (o mock `scripts/dev/whatsapp-echo.ts`): NENHUM
 * WhatsApp de verdade é acionado; o código só aparece no terminal do mock /
 * `~/.nio/whatsapp-echo-last.json`. `provider` — endpoint externo.
 * `unconfigured` — sem `WHATSAPP_*` (2FA indisponível).
 */
export type SmsMode = 'echo' | 'provider' | 'unconfigured';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * O modo `echo` devolve o OTP na resposta HTTP — só existe pra dev. Fail-closed:
 * exige opt-in explícito (`NIO_ALLOW_ECHO=1`) e nunca vale com `NODE_ENV=production`.
 * Sem isso, um `WHATSAPP_ENDPOINT_URL` em loopback esquecido em prod anularia o 2FA.
 */
export function echoAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NIO_ALLOW_ECHO?.trim() === '1' && env.NODE_ENV !== 'production';
}

/** Campo `devCode` da resposta: o código só sai em modo `echo` **e** autorizado. */
export function devCodeField(mode: SmsMode, code: string): { devCode?: string } {
  return mode === 'echo' && echoAllowed() ? { devCode: code } : {};
}

/** Boot do gateway: backend `echo` sem opt-in é configuração perigosa → recusa subir. */
export function assertEchoSafe(): void {
  if (smsMode() !== 'echo' || echoAllowed()) return;
  throw new Error(
    'WHATSAPP_ENDPOINT_URL aponta pra loopback (modo echo): o OTP voltaria na resposta e o 2FA ' +
      'não valeria nada. Use um provedor real, ou defina NIO_ALLOW_ECHO=1 (só dev, nunca com NODE_ENV=production).',
  );
}

/** Classifica o backend ativo — a CLI usa pra avisar que está em modo echo. */
export function smsMode(env: WhatsAppReadEnv = readEnv()): SmsMode {
  if (!env.url || !env.token) return 'unconfigured';
  try {
    return LOOPBACK_HOSTS.has(new URL(env.url).hostname) ? 'echo' : 'provider';
  } catch {
    return 'provider'; // URL malformada → deixa o sendOtp() reportar a falha
  }
}

/** Host do provedor (sem esquema/porta/caminho), pra exibir no `status`. `null` se não configurado/inválido. */
export function smsProviderHost(env: WhatsAppReadEnv = readEnv()): string | null {
  if (!env.url) return null;
  try {
    return new URL(env.url).hostname;
  } catch {
    return null;
  }
}

/** WhatsApp via HTTP. `env` é seam opcional (default = `process.env`). */
export function createWhatsAppSender(env: WhatsAppReadEnv = readEnv()): OtpSender {
  return {
    async sendOtp(to: string, code: string): Promise<SmsResult> {
      if (!env.url || !env.token) {
        return {
          status: 'skipped',
          error: 'WHATSAPP_ENDPOINT_URL / WHATSAPP_TOKEN não configurados',
        };
      }
      const body = buildPayload(to, code, env);
      try {
        const res = await fetch(env.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.token}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          return { status: 'failed', error: `WhatsApp respondeu ${res.status} ${detail}`.trim() };
        }
        return { status: 'sent' };
      } catch (err) {
        return { status: 'failed', error: (err as Error).message };
      }
    },
  };
}
