// Personagem NIO em pixel-art com efeito Matrix.
import { envName } from './brand.js';
import type { Canvas } from './avatar-paint.js';
import {
  createCanvas,
  mulberry32,
  paintAmbientRain,
  paintDisintegrate,
  paintIntegrate,
  paintMorph,
  paintPose,
  paintShimmer,
} from './avatar-paint.js';
import type { Pose } from './avatar-sprites.js';
import { ANIM, HIDE_CURSOR, PALETTE, RESET, SHOW_CURSOR } from './avatar-sprites.js';

export * from './avatar-sprites.js';
export * from './avatar-paint.js';

// ─── Linha do tempo ────────────────────────────────────────────────────
export type Step =
  | { kind: 'integrate' | 'hold' | 'disintegrate'; pose: Pose }
  | { kind: 'morph'; from: Pose; to: Pose }
  | { kind: 'empty' };

/** Ida: integra parado → cruza → desintegra cruzado. Volta: o inverso. */
export const CYCLE: readonly Step[] = [
  { kind: 'integrate', pose: 'idle' },
  { kind: 'hold', pose: 'idle' },
  { kind: 'morph', from: 'idle', to: 'mid' },
  { kind: 'morph', from: 'mid', to: 'crossed' },
  { kind: 'hold', pose: 'crossed' },
  { kind: 'disintegrate', pose: 'crossed' },
  { kind: 'empty' },
  { kind: 'integrate', pose: 'crossed' },
  { kind: 'hold', pose: 'crossed' },
  { kind: 'morph', from: 'crossed', to: 'mid' },
  { kind: 'morph', from: 'mid', to: 'idle' },
  { kind: 'hold', pose: 'idle' },
  { kind: 'disintegrate', pose: 'idle' },
  { kind: 'empty' },
];

export function stepFrames(step: Step): number {
  switch (step.kind) {
    case 'integrate':
      return ANIM.integrateFrames;
    case 'hold':
      return ANIM.holdFrames;
    case 'morph':
      return ANIM.morphFrames;
    case 'disintegrate':
      return ANIM.disintegrateFrames;
    case 'empty':
      return ANIM.emptyFrames;
  }
}

/** Progresso 0..1 do quadro `i` de `n`, esticado pra caber a janela de glitch / a queda. */
function progress(i: number, n: number, extra: number): number {
  return (n <= 1 ? 1 : i / (n - 1)) * (1 + extra);
}

/**
 * Núcleo puro: monta o quadro `i` do passo `step`. `g` = quadro global
 * (mantém a chuva de fundo contínua entre fases).
 */
export function buildFrame(step: Step, i: number, g: number, width = 70, height = 32): Canvas {
  const cv = createCanvas(width, height);
  const rand = mulberry32((ANIM.settleSeed + g * 0x9e37) >>> 0);
  const n = stepFrames(step);
  const busy = step.kind === 'integrate' || step.kind === 'disintegrate';
  paintAmbientRain(cv, g, busy ? 1.6 : 1, step.kind === 'hold' || step.kind === 'morph');

  switch (step.kind) {
    case 'integrate':
      paintIntegrate(cv, step.pose, progress(i, n, ANIM.glitchWindow), rand);
      break;
    case 'disintegrate':
      paintDisintegrate(cv, step.pose, progress(i, n, ANIM.glitchWindow + 0.75), rand);
      break;
    case 'morph':
      paintMorph(cv, step.from, step.to, i, rand);
      break;
    case 'hold':
      paintPose(cv, step.pose);
      if (ANIM.shimmer > 0) paintShimmer(cv, step.pose, rand);
      break;
    case 'empty':
      break;
  }
  return cv;
}

// ─── Terminal ──────────────────────────────────────────────────────────
function serialize(cv: Canvas, colored: boolean): string {
  const lines: string[] = [];
  for (const row of cv.cells) {
    let line = '';
    for (const cell of row) {
      if (!cell.tone) {
        line += '  ';
        continue;
      }
      const p = PALETTE[cell.tone];
      const text = cell.solid ? (colored ? '██' : p.mono) : `${cell.glyph} `;
      line += colored ? `${p.ansi}${text}${RESET}` : text;
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

export interface MatrixCharacterOptions {
  width?: number;
  height?: number;
  /** Pose do frame estático. Default: `idle`. */
  pose?: Pose;
  /** Default: `true` só quando a saída é um TTY (evita sujar log/arquivo com ANSI). */
  colored?: boolean;
  /** Quantos ciclos completos tocar. Default: infinito (Ctrl+C sai limpo). */
  loops?: number;
}

function dims(opts: MatrixCharacterOptions): { width: number; height: number } {
  return { width: opts.width ?? 70, height: opts.height ?? 32 };
}

/** O personagem estático (pose assentada). Determinístico: mesma seed, mesma saída. */
export function renderMatrixCharacter(opts: MatrixCharacterOptions = {}): string {
  const { width, height } = dims(opts);
  const colored = opts.colored ?? Boolean(process.stdout.isTTY);
  const cv = createCanvas(width, height);
  paintAmbientRain(cv, ANIM.settleSeed, 1, true);
  paintPose(cv, opts.pose ?? 'idle');
  return serialize(cv, colored);
}

/**
 * Vale desenhar agora? O personagem é **para humano em terminal**. Fora de TTY
 * (pipe, captura por agente, CI) ele vira ruído — mesma regra do logo.
 */
export function shouldDrawCharacter(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function animationDisabled(width: number, height: number): boolean {
  return (
    !process.stdout.isTTY ||
    Boolean(process.env.CI) ||
    Boolean(process.env[envName('NO_ANIM')]) ||
    (process.stdout.rows ?? 24) < height + 2 ||
    (process.stdout.columns ?? 80) < width
  );
}

/**
 * Toca o ciclo integra → cruza → desintegra → reintegra → descruza → desintegra.
 * Fora de TTY / com `NIO_NO_ANIM` / `CI` / terminal pequeno → só o estático.
 * Com `loops` finito, termina reintegrando e deixa o personagem parado na tela.
 */
export async function animateMatrixCharacter(opts: MatrixCharacterOptions = {}): Promise<void> {
  const { width, height } = dims(opts);
  if (animationDisabled(width, height)) {
    if (shouldDrawCharacter()) process.stdout.write(renderMatrixCharacter(opts) + '\n');
    return;
  }

  const out = process.stdout;
  const colored = opts.colored ?? true;
  const loops = opts.loops ?? Infinity;
  const up = `\x1b[${height}A`;
  let g = 0;

  // Linhas com `trimEnd` não apagam o que sobrou do quadro anterior → `\x1b[K` limpa o resto.
  const draw = (cv: Canvas): void => {
    const frame = serialize(cv, colored).split('\n').join('\x1b[K\n');
    out.write((g === 0 ? '' : up) + frame + '\x1b[K\n');
    g++;
  };
  const play = async (step: Step): Promise<void> => {
    for (let i = 0, n = stepFrames(step); i < n; i++) {
      draw(buildFrame(step, i, g, width, height));
      await sleep(ANIM.frameMs);
    }
  };

  const restore = (): void => {
    out.write(SHOW_CURSOR);
  };
  const onSigint = (): void => {
    restore();
    out.write('\n');
    process.exit(130);
  };
  out.write(HIDE_CURSOR);
  process.once('SIGINT', onSigint);

  try {
    for (let l = 0; l < loops; l++) for (const step of CYCLE) await play(step);
    // Assenta: reintegra parado e deixa o frame final na tela.
    await play({ kind: 'integrate', pose: 'idle' });
    draw(buildFrame({ kind: 'hold', pose: 'idle' }, 0, g, width, height));
  } finally {
    process.off('SIGINT', onSigint);
    restore();
  }
}
