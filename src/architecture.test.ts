/**
 * Gate de arquitetura (ADR 0016): `core/` não importa `lib/` nem `adapters/`, `lib/` é
 * base (não sobe pra camadas de cima) e nenhum adapter importa de `app/`.
 */
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** Arquivos de `layer` que importam algum dos `forbidden` (caminho relativo a `src/`). */
function violations(layer: string, forbidden: RegExp): string[] {
  return sources(join(SRC, layer))
    .filter((f) => {
      const imports = readFileSync(f, 'utf8').match(/from\s+['"][^'"]+['"]/g) ?? [];
      return imports.some((i) => forbidden.test(i));
    })
    .map((f) => relative(SRC, f));
}

test('core/ não importa lib/ nem adapters/', () => {
  expect(violations('core', /\/(lib|adapters)\//)).toEqual([]);
});

test('lib/ é base: não importa adapters/, gateway/, tools/ nem cli/ (ADR 0016)', () => {
  expect(violations('lib', /\/(adapters|gateway|tools|cli)\//)).toEqual([]);
});

test('adapters/ não importam app/', () => {
  expect(violations('adapters', /\.\.\/app\//)).toEqual([]);
});
