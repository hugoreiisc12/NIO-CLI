import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { env } from '../../brand.js';

/** Corpo sem payload por spec — `new Response(body, { status })` lança se vier body nestes. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** CA privada do Kong/gateway (`NIO_GATEWAY_CA` = caminho do `ca.crt`), ou `undefined`. */
function readGatewayCa(): Buffer | undefined {
  const path = env('GATEWAY_CA')?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`NIO_GATEWAY_CA não pôde ser lido ("${path}"): ${(err as Error).message}`);
  }
}

/** `fetch` via `node:https` com a CA privada — o `fetch` global do Node não aceita CA por chamada. */
function fetchWithCa(url: string, init: RequestInit, ca: Buffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string> | undefined,
        ca,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          }
          const body = NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers }));
        });
      },
    );
    req.on('error', reject);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}

/**
 * `fetch` do CLI → gateway/Kong. `https://` + `NIO_GATEWAY_CA` valida o certificado
 * contra a CA interna (TLS verificado); sem CA, cai no `fetch` global (CA do sistema ou
 * `NODE_EXTRA_CA_CERTS`). Nunca desliga a verificação.
 */
export async function gatewayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ca = url.startsWith('https://') ? readGatewayCa() : undefined;
  return ca ? fetchWithCa(url, init, ca) : fetch(url, init);
}
