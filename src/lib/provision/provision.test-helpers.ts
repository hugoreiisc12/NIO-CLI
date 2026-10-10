import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDir } from './provision.js';

// Caracterização do plano de arquivos gerado por applyProvision/provision ANTES do
// split em provision-collect.ts (coleta) + provision-apply.ts (motor/manifesto) —
// pina create/update/unchanged/skip-conflict/prune/prune-kept/force/dry-run/write-error.

export function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'nio-prov-'));
}

// Semântica de symlink de dotfile é POSIX: no Windows, `symlinkSync` p/ alvo
// inexistente cria link tipo-`file` (não `dir`), então `mkdir` através dele nunca
// funciona — o comportamento que este teste valida não existe lá. Roda no
// CI/Mac/Linux, onde dotfiles simbolicados são o caso real.
export const posixTest = process.platform === 'win32' ? test.skip : test;

posixTest('ensureDir: materializa o alvo de um symlink pendurado em vez de estourar ENOENT', () => {
  const base = fresh();
  try {
    const realTarget = join(base, 'real-target');
    const link = join(base, 'link');
    symlinkSync(realTarget, link); // pendurado: realTarget ainda não existe
    ensureDir(join(link, 'sub', 'deep'));
    expect(existsSync(join(realTarget, 'sub', 'deep'))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
