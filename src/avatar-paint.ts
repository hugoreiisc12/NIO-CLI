import type { GlyphTone, PixelKind, Pose, Tone } from './avatar-sprites.js';
import { ANIM, MATRIX_CHARS, SPRITES, SPRITE_H, SPRITE_W } from './avatar-sprites.js';

// ─── PRNG ──────────────────────────────────────────────────────────────
/** PRNG determinístico (mulberry32) — mesma seed, mesma saída sempre. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function pickChar(rand: () => number, s: string): string {
  return s[Math.floor(rand() * s.length)] ?? ' ';
}

/** Ruído estável por célula (mesma célula + salt → mesmo valor em todo quadro). */
function noise(r: number, c: number, salt: number): number {
  return mulberry32((Math.imul(r, 73856093) ^ Math.imul(c, 19349663) ^ salt) >>> 0)();
}

// ─── Grade ─────────────────────────────────────────────────────────────
/** Célula = 2 colunas de terminal. `glyph` vazio + `solid` = bloco de cor. */
export interface Cell {
  glyph: string;
  tone: Tone | null;
  solid: boolean;
}

export interface Canvas {
  cols: number; // em células (cada uma = 2 colunas de terminal)
  rows: number;
  cells: Cell[][];
  top: number; //  onde o sprite começa
  left: number;
}

const EMPTY: Cell = { glyph: '', tone: null, solid: false };

export function createCanvas(width: number, height: number): Canvas {
  const cols = Math.floor(width / 2);
  return {
    cols,
    rows: height,
    cells: Array.from({ length: height }, () => Array.from({ length: cols }, () => EMPTY)),
    top: Math.max(0, Math.floor((height - SPRITE_H) / 2)),
    left: Math.max(0, Math.floor((cols - SPRITE_W) / 2)),
  };
}

function inside(cv: Canvas, r: number, c: number): boolean {
  return r >= 0 && r < cv.rows && c >= 0 && c < cv.cols;
}

/** Pinta código (katakana) só onde não há pixel sólido — a chuva nunca pisa no corpo. */
function paintGlyph(cv: Canvas, r: number, c: number, tone: GlyphTone, rand: () => number): void {
  if (!inside(cv, r, c) || cv.cells[r][c].solid) return;
  cv.cells[r][c] = { glyph: pickChar(rand, MATRIX_CHARS), tone, solid: false };
}

function paintSolid(cv: Canvas, r: number, c: number, kind: PixelKind): void {
  if (inside(cv, r, c)) cv.cells[r][c] = { glyph: '', tone: kind, solid: true };
}

function forEachPixel(pose: Pose, fn: (r: number, c: number, kind: PixelKind) => void): void {
  const rows = SPRITES[pose];
  for (let r = 0; r < SPRITE_H; r++) {
    for (let c = 0; c < SPRITE_W; c++) {
      const ch = rows[r][c];
      if (ch !== '.') fn(r, c, ch as PixelKind);
    }
  }
}

/**
 * Quando cada pixel "chega" (integração) ou "solta" (desintegração), em 0..1.
 * De cima pra baixo como a chuva, com ruído pra não ficar uma linha reta.
 */
function threshold(r: number, c: number, salt: number): number {
  return (r / (SPRITE_H - 1)) * 0.7 + noise(r, c, salt) * 0.3;
}

// ─── Camadas ───────────────────────────────────────────────────────────
/** Chuva de fundo contínua. `g` = contador global de quadros (não reinicia por fase). */
export function paintAmbientRain(
  cv: Canvas,
  g: number,
  density: number,
  avoidSprite = false,
): void {
  const layout = mulberry32(ANIM.settleSeed ^ 0x51ed);
  const total = Math.round(ANIM.ambientColumns * density);
  for (let n = 0; n < total; n++) {
    const col = randInt(layout, 0, cv.cols - 1);
    const speed = 0.35 + layout() * 0.6;
    const len = randInt(layout, 4, 11);
    const span = cv.rows + len;
    const head = Math.floor((g * speed + layout() * span) % span);
    const flicker = mulberry32((g * 131 + n * 977) >>> 0);
    // Com o corpo montado, a chuva passa por trás da silhueta inteira (como no logo):
    // senão ela vaza pelos vãos do sprite (entre as pernas) e vira uma listra no corpo.
    if (avoidSprite && col >= cv.left - 1 && col <= cv.left + SPRITE_W) continue;
    for (let i = 0; i < len; i++) {
      const tone: GlyphTone = i === 0 ? 'bright' : i < 3 ? 'green' : 'dim';
      paintGlyph(cv, head - i, col, tone, flicker);
    }
  }
}

export function paintPose(cv: Canvas, pose: Pose): void {
  forEachPixel(pose, (r, c, kind) => paintSolid(cv, cv.top + r, cv.left + c, kind));
}

/** Integração: cada pixel desce como código e "trava" em cor sólida. */
export function paintIntegrate(cv: Canvas, pose: Pose, t: number, rand: () => number): void {
  const W = ANIM.glitchWindow;
  const pending: [number, number, number][] = [];
  forEachPixel(pose, (r, c, kind) => {
    const th = threshold(r, c, 0x1a7e);
    if (t >= th + W) paintSolid(cv, cv.top + r, cv.left + c, kind);
    else if (t >= th) pending.push([r, c, (t - th) / W]);
  });
  // Depois dos sólidos, pra o rastro não sobrescrever o corpo já formado.
  for (const [r, c, k] of pending) {
    const R = cv.top + r;
    const C = cv.left + c;
    paintGlyph(cv, R, C, k < 0.35 ? 'head' : 'bright', rand);
    const trail = Math.round((1 - k) * 4);
    for (let i = 1; i <= trail; i++) paintGlyph(cv, R - i, C, i === 1 ? 'green' : 'dim', rand);
  }
}

/** Desintegração: o pixel vira código no lugar e depois escorre pra baixo, apagando. */
export function paintDisintegrate(cv: Canvas, pose: Pose, t: number, rand: () => number): void {
  const W = ANIM.glitchWindow;
  const falling: [number, number, number][] = [];
  forEachPixel(pose, (r, c, kind) => {
    const th = threshold(r, c, 0xd15e);
    if (t < th) paintSolid(cv, cv.top + r, cv.left + c, kind);
    else falling.push([r, c, t - th]);
  });
  for (const [r, c, d] of falling) {
    const R = cv.top + r;
    const C = cv.left + c;
    if (d < W) {
      paintGlyph(cv, R, C, d < W / 2 ? 'head' : 'bright', rand);
      continue;
    }
    const fall = Math.floor((d - W) * ANIM.fallSpeed);
    if (R + fall >= cv.rows) continue;
    const tone: GlyphTone = fall < 4 ? 'bright' : fall < 10 ? 'green' : 'dim';
    // Some com probabilidade crescente → os grãos rareiam enquanto caem.
    if (noise(r, c, fall) < fall / 22) continue;
    paintGlyph(cv, R + fall, C, tone, rand);
    if (fall > 0) paintGlyph(cv, R + fall - 1, C, 'dim', rand);
  }
}

/** Troca de pose: só as células que mudam "glitcham" em código por um instante. */
export function paintMorph(cv: Canvas, from: Pose, to: Pose, i: number, rand: () => number): void {
  paintPose(cv, i === 0 ? from : to);
  if (i >= ANIM.morphGlitchFrames) return;
  const a = SPRITES[from];
  const b = SPRITES[to];
  for (let r = 0; r < SPRITE_H; r++) {
    for (let c = 0; c < SPRITE_W; c++) {
      if (a[r][c] === b[r][c]) continue;
      const R = cv.top + r;
      const C = cv.left + c;
      cv.cells[R][C] = EMPTY; // libera a célula pro glifo
      paintGlyph(cv, R, C, rand() < 0.4 ? 'head' : 'bright', rand);
    }
  }
}

/** Parado: alguns pixels piscam em código, pra parecer "vivo". */
export function paintShimmer(cv: Canvas, pose: Pose, rand: () => number): void {
  const pixels: [number, number][] = [];
  forEachPixel(pose, (r, c) => pixels.push([r, c]));
  for (let n = 0; n < ANIM.shimmer; n++) {
    const [r, c] = pixels[Math.floor(rand() * pixels.length)];
    const R = cv.top + r;
    const C = cv.left + c;
    cv.cells[R][C] = EMPTY;
    paintGlyph(cv, R, C, 'green', rand);
  }
}
