#!/usr/bin/env node
/**
 * Gestão dos clientes do gateway (N-8) — ferramenta de OPERAÇÃO, não de usuário: usa a
 * credencial do banco do gateway (`NIO_GATEWAY_DATABASE_URL`), então só quem a tem
 * cria/revoga token. Em produção: `docker exec nio-gateway node dist/gateway/clients-cli.js …`.
 *
 *   create <nome>          gera o token e o mostra UMA vez
 *   list                   clientes, último uso e situação
 *   revoke <id|nome>       o token deixa de valer em até 30 s (cache do gateway)
 */
import '../lib/load-env.js';
import type { GatewayClientRepository } from '../core/repositories.js';
import { generateClientToken } from './gateway-clients.js';

const USAGE = 'uso: clients-cli create <nome> | list | revoke <id|nome>';
const MAX_NAME = 64;

export async function runClientsCli(
  argv: string[],
  repo: GatewayClientRepository,
  out: (line: string) => void = console.log,
): Promise<number> {
  const [cmd, arg] = argv;

  if (cmd === 'create') {
    const name = arg?.trim();
    if (!name || name.length > MAX_NAME) {
      out(`nome obrigatório, até ${MAX_NAME} caracteres. ${USAGE}`);
      return 2;
    }
    const { token, hash } = generateClientToken();
    const client = await repo.create(name, hash);
    out(`cliente "${client.name}" criado (${client.id}).`);
    out('Token (aparece só agora — guarde num cofre; o banco guarda apenas o hash):');
    out(token);
    return 0;
  }

  if (cmd === 'list') {
    const clients = await repo.list();
    if (clients.length === 0) out('nenhum cliente cadastrado.');
    for (const c of clients) {
      const state = c.revokedAt ? `revogado em ${c.revokedAt.toISOString()}` : 'ativo';
      const used = c.lastUsedAt ? c.lastUsedAt.toISOString() : 'nunca';
      out(`${c.id}  ${c.name}  ${state}  último uso: ${used}`);
    }
    return 0;
  }

  if (cmd === 'revoke' && arg) {
    const done = await repo.revoke(arg);
    out(
      done
        ? `cliente "${arg}" revogado.`
        : `nada revogado: "${arg}" não existe ou já estava revogado.`,
    );
    return done ? 0 : 1;
  }

  out(USAGE);
  return 2;
}

async function main(): Promise<void> {
  if (process.env.NIO_GATEWAY_DATABASE_URL?.trim()) {
    process.env.NIO_DATABASE_URL = process.env.NIO_GATEWAY_DATABASE_URL.trim();
  }
  const { createGatewayClientRepository } = await import(
    '../adapters/pg/gateway-client-repository.js'
  );
  const { closePool } = await import('../adapters/pg/client.js');
  try {
    process.exitCode = await runClientsCli(process.argv.slice(2), createGatewayClientRepository());
  } catch (err) {
    console.error(`erro: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith('clients-cli.js')) void main();
