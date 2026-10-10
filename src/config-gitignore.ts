import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { brand } from './brand.js';
import { PROJECT_CONFIG_FILE, USER_CONFIG_FILE } from './config-core.js';

function readGitignore(cwd: string): { path: string; text: string } {
  const path = join(cwd, '.gitignore');
  return { path, text: existsSync(path) ? readFileSync(path, 'utf8') : '' };
}

// Sufixos ESTÁVEIS dos marcadores do `.gitignore`. O prefixo é a marca (`# nio`),
// que muda num rebrand — então casamos por sufixo pra reconhecer/limpar o marcador de
// QUALQUER marca (é a migração que remove o marcador antigo).
const GITIGNORE_USER_SUFFIX = '(config local do usuário)';

const GITIGNORE_PROJECT_SUFFIX = '(binding local do projeto)';

/** Linha é um marcador nosso do sufixo dado? Agnóstico à marca. */
function isGitignoreMarker(line: string, suffix: string): boolean {
  const t = line.trim();
  return t.startsWith('#') && t.endsWith(suffix);
}

/** Garante uma entrada no `.gitignore` (idempotente). Cria o arquivo se não existir. */
export function ensureGitignored(
  entry: string = USER_CONFIG_FILE,
  cwd: string = process.cwd(),
): 'added' | 'present' {
  const { path, text } = readGitignore(cwd);
  const marker = `# ${brand.name} ${GITIGNORE_USER_SUFFIX}`;
  // Migração: varre marcadores de usuário de outra marca (preserva o atual).
  const kept = text
    .split(/\r?\n/)
    .filter((l) => l.trim() === marker || !isGitignoreMarker(l, GITIGNORE_USER_SUFFIX));
  const base = kept.join('\n');

  if (kept.some((l) => l.trim() === entry)) {
    if (base !== text) writeFileSync(path, base, 'utf8'); // persiste a limpeza
    return 'present';
  }
  const sep = base.length > 0 && !base.endsWith('\n') ? '\n' : '';
  const block = `${sep}${base.length > 0 ? '\n' : ''}${marker}\n${entry}\n`;
  writeFileSync(path, base + block, 'utf8');
  return 'added';
}

/** Remove uma entrada exata do `.gitignore` (+ o marcador de projeto órfão, de qualquer marca). `true` se removeu. */
export function removeFromGitignore(entry: string, cwd: string = process.cwd()): boolean {
  const { path, text } = readGitignore(cwd);
  if (!text) return false;
  const lines = text.split(/\r?\n/);
  const kept = lines.filter(
    (l) => l.trim() !== entry && !isGitignoreMarker(l, GITIGNORE_PROJECT_SUFFIX),
  );
  if (kept.length === lines.length) return false;
  writeFileSync(path, kept.join('\n'), 'utf8');
  return true;
}

/**
 * Ajusta o `.gitignore` pro split: tira o `nio.json` (agora versionado, do time) e
 * garante o `nio.user.json` (do usuário) ignorado. Retorna se acrescentou o user file.
 */
export function fixGitignoreForSplit(cwd: string = process.cwd()): 'added' | 'present' {
  removeFromGitignore(PROJECT_CONFIG_FILE, cwd);
  return ensureGitignored(USER_CONFIG_FILE, cwd);
}
