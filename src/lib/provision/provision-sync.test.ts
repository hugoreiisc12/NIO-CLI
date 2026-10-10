import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyProvision, MANIFEST_NAME } from './provision.js';

// Caracterização do plano de arquivos gerado por applyProvision/provision ANTES do
// split em provision-collect.ts (coleta) + provision-apply.ts (motor/manifesto) —
// pina create/update/unchanged/skip-conflict/prune/prune-kept/force/dry-run/write-error.
import { fresh } from './provision.test-helpers.js';

test('create: arquivo novo é escrito e entra no manifesto', () => {
  const target = fresh();
  try {
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('hello') }], {
      targetDir: target,
    });
    expect(res.files).toEqual([{ relPath: 'commands/foo.md', action: 'create' }]);
    expect(readFileSync(join(target, 'commands/foo.md'), 'utf8')).toBe('hello');

    const manifest = JSON.parse(readFileSync(join(target, MANIFEST_NAME), 'utf8'));
    expect(manifest.generator).toBe('@nio-cli/cli');
    expect(Object.keys(manifest.files)).toEqual(['commands/foo.md']);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('dryRun: calcula o plano mas não escreve nada no disco', () => {
  const target = fresh();
  try {
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('hello') }], {
      targetDir: target,
      dryRun: true,
    });
    expect(res.files).toEqual([{ relPath: 'commands/foo.md', action: 'create' }]);
    expect(existsSync(join(target, 'commands/foo.md'))).toBe(false);
    expect(existsSync(join(target, MANIFEST_NAME))).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('unchanged: mesmo conteúdo na 2ª rodada não reescreve', () => {
  const target = fresh();
  try {
    const docs = [{ relPath: 'commands/foo.md', content: Buffer.from('hello') }];
    applyProvision(docs, { targetDir: target });
    const res = applyProvision(docs, { targetDir: target });
    expect(res.files).toEqual([{ relPath: 'commands/foo.md', action: 'unchanged' }]);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('update: conteúdo mudou e o usuário não tocou → atualiza sem detail', () => {
  const target = fresh();
  try {
    applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v1') }], {
      targetDir: target,
    });
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v2') }], {
      targetDir: target,
    });
    expect(res.files).toEqual([{ relPath: 'commands/foo.md', action: 'update' }]);
    expect(readFileSync(join(target, 'commands/foo.md'), 'utf8')).toBe('v2');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('skip-conflict: usuário editou localmente → não sobrescreve (sem --force)', () => {
  const target = fresh();
  try {
    applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v1') }], {
      targetDir: target,
    });
    writeFileSync(join(target, 'commands/foo.md'), 'user-edited');
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v2') }], {
      targetDir: target,
    });
    expect(res.files).toEqual([
      { relPath: 'commands/foo.md', action: 'skip-conflict', detail: 'editado localmente' },
    ]);
    expect(readFileSync(join(target, 'commands/foo.md'), 'utf8')).toBe('user-edited');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('skip-conflict: arquivo de terceiros (nunca provisionado por nós)', () => {
  const target = fresh();
  try {
    mkdirSync(join(target, 'commands'), { recursive: true });
    writeFileSync(join(target, 'commands/foo.md'), 'third party');
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v2') }], {
      targetDir: target,
    });
    expect(res.files).toEqual([
      { relPath: 'commands/foo.md', action: 'skip-conflict', detail: 'arquivo de terceiros' },
    ]);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('force: sobrescreve arquivo divergente com detail explicando', () => {
  const target = fresh();
  try {
    applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v1') }], {
      targetDir: target,
    });
    writeFileSync(join(target, 'commands/foo.md'), 'user-edited');
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v2') }], {
      targetDir: target,
      force: true,
    });
    expect(res.files).toEqual([
      { relPath: 'commands/foo.md', action: 'update', detail: 'forçado sobre arquivo divergente' },
    ]);
    expect(readFileSync(join(target, 'commands/foo.md'), 'utf8')).toBe('v2');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('prune: arquivo que saiu da fonte e está intacto é removido', () => {
  const target = fresh();
  try {
    applyProvision(
      [
        { relPath: 'commands/foo.md', content: Buffer.from('v1') },
        { relPath: 'commands/bar.md', content: Buffer.from('v1') },
      ],
      { targetDir: target },
    );
    const res = applyProvision([{ relPath: 'commands/foo.md', content: Buffer.from('v1') }], {
      targetDir: target,
    });
    const bar = res.files.find((f) => f.relPath === 'commands/bar.md');
    expect(bar).toEqual({ relPath: 'commands/bar.md', action: 'prune' });
    expect(existsSync(join(target, 'commands/bar.md'))).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
