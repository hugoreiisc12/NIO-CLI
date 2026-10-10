import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayFetch } from './gateway-fetch.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const tls = hasOpenssl ? test : test.skip;

let dir = '';
let server: Server;
let url = '';

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

/** CA + cert de servidor para 127.0.0.1, como o `scripts/db-tls-setup.sh` emite. */
function issue(name: string): void {
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}-ca.key`,
    '-out',
    `${name}-ca.crt`,
    '-days',
    '1',
    '-subj',
    `/CN=${name} CA`,
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    '/CN=127.0.0.1',
  );
  writeFileSync(join(dir, `${name}.ext`), 'subjectAltName=IP:127.0.0.1\n');
  openssl(
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    `${name}-ca.crt`,
    '-CAkey',
    `${name}-ca.key`,
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    `${name}.ext`,
    '-out',
    `${name}.crt`,
  );
}

beforeAll(async () => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'nio-gw-tls-'));
  issue('good');
  issue('other');
  server = createServer(
    { key: readFileSync(join(dir, 'good.key')), cert: readFileSync(join(dir, 'good.crt')) },
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method }));
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.NIO_GATEWAY_CA;
});

tls('https com NIO_GATEWAY_CA válida: valida o certificado e devolve a resposta', async () => {
  process.env.NIO_GATEWAY_CA = join(dir, 'good-ca.crt');
  const res = await gatewayFetch(url, { method: 'POST', body: '{}' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, method: 'POST' });
});

tls('https sem a CA: recusa (a verificação nunca é desligada)', async () => {
  delete process.env.NIO_GATEWAY_CA;
  await expect(gatewayFetch(url)).rejects.toThrow();
});

tls('https com a CA errada: recusa', async () => {
  process.env.NIO_GATEWAY_CA = join(dir, 'other-ca.crt');
  await expect(gatewayFetch(url)).rejects.toThrow();
});

test('NIO_GATEWAY_CA ilegível: erro claro, sem cair em modo inseguro', async () => {
  process.env.NIO_GATEWAY_CA = '/nao/existe/ca.crt';
  await expect(gatewayFetch('https://127.0.0.1:1/health')).rejects.toThrow(/NIO_GATEWAY_CA/);
  delete process.env.NIO_GATEWAY_CA;
});
