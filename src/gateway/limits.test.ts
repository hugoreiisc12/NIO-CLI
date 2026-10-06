import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import {
  applyServerLimits,
  loginInputInBounds,
  maxConnections,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  sleepWithinBudget,
} from './limits.js';

describe('applyServerLimits (N-10)', () => {
  test('define timeouts e teto de conexões', () => {
    const s = createServer();
    applyServerLimits(s);
    expect(s.headersTimeout).toBe(15_000);
    expect(s.requestTimeout).toBe(30_000);
    expect(s.maxConnections).toBe(1_000);
  });

  test('maxConnections: env válida vence; inválida cai no default', () => {
    expect(maxConnections({ NIO_GATEWAY_MAX_CONNECTIONS: '50' })).toBe(50);
    expect(maxConnections({ NIO_GATEWAY_MAX_CONNECTIONS: '-3' })).toBe(1_000);
    expect(maxConnections({ NIO_GATEWAY_MAX_CONNECTIONS: 'abc' })).toBe(1_000);
  });
});

describe('loginInputInBounds (N-5)', () => {
  test('aceita nos tetos, recusa acima', () => {
    expect(loginInputInBounds('a'.repeat(MAX_NAME_LENGTH), 'p'.repeat(MAX_PASSWORD_LENGTH))).toBe(
      true,
    );
    expect(loginInputInBounds('a'.repeat(MAX_NAME_LENGTH + 1), 'x')).toBe(false);
    expect(loginInputInBounds('a', 'p'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });
});

describe('sleepWithinBudget (N-5)', () => {
  test('sem vaga → false sem dormir; a vaga volta ao terminar', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const first = sleepWithinBudget(1, () => blocked, 1);
    expect(await sleepWithinBudget(1, async () => {}, 1)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await sleepWithinBudget(1, async () => {}, 1)).toBe(true);
  });
});
