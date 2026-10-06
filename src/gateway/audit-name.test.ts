import { beforeAll, describe, expect, test } from 'bun:test';
import { auditableName } from './audit-name.js';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'audit-name-test-4f9c2ka7Qh1Zpx8Rbn3Vdw6Tty0';
});

const exists = (names: string[]) => ({
  findByName: async (n: string) => (names.includes(n) ? ({ name: n } as never) : null),
});

describe('auditableName (N-9)', () => {
  test('usuário existente → nome cru', async () => {
    expect(await auditableName('hugo', exists(['hugo']))).toBe('hugo');
  });

  test('nome inexistente (pode ser senha digitada no campo) → impressão, nunca o texto', async () => {
    const out = await auditableName('Sup3rS3nha!2026', exists([]));
    expect(out).toMatch(/^~[0-9a-f]{12}$/);
    expect(out).not.toContain('Sup3rS3nha');
  });

  test('a impressão é estável: mesma entrada → mesma chave (correlaciona spray)', async () => {
    const a = await auditableName('x-guess', exists([]));
    expect(await auditableName('x-guess', exists([]))).toBe(a);
    expect(await auditableName('y-guess', exists([]))).not.toBe(a);
  });

  test('banco indisponível → impressão, não lança nem grava cru', async () => {
    const down = {
      findByName: async () => {
        throw new Error('db down');
      },
    };
    expect(await auditableName('hugo', down)).toMatch(/^~[0-9a-f]{12}$/);
  });
});
