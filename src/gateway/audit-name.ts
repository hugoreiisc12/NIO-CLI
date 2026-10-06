/**
 * Nome tentado, seguro pra trilha de auth (N-9). `auth_events.name` e o log guardam o
 * usuário tentado — mas quem erra o campo e digita a SENHA no lugar do nome gravaria a
 * senha em claro. Nome que existe é um usuário real (guarda cru); o resto vira uma
 * impressão HMAC curta: ainda correlaciona spray/enumeração, sem expor o texto.
 */
import { createHmac } from 'node:crypto';
import type { UserRepository } from '../core/repositories.js';
import { createUserRepository } from '../adapters/pg/user-repository.js';
import { otpHmacSecret } from './auth/secrets.js';

const MAX_AUDIT_NAME = 64;

export async function auditableName(
  raw: string,
  users: Pick<UserRepository, 'findByName'> = createUserRepository(),
): Promise<string> {
  const name = raw.trim().slice(0, MAX_AUDIT_NAME);
  try {
    if (await users.findByName(name)) return name;
  } catch {
    /* sem banco: cai na impressão — nunca grava o texto cru */
  }
  const fp = createHmac('sha256', otpHmacSecret()).update(name).digest('hex').slice(0, 12);
  return `~${fp}`;
}
