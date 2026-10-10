// - Ajuste fino da animação ( só afeta TTY). O dono mexe aqui.
export const ANIM = {
  frameMs: 55, //            ms entre quadros
  integrateFrames: 34, //    quadros da integração (chuva assentando no corpo)
  holdFrames: 18, //         quadros parado entre fases
  morphFrames: 4, //         quadros por pose intermediária (cruzar/descruzar)
  morphGlitchFrames: 2, //   desses, quantos mostram o "glitch" nas células que mudam
  disintegrateFrames: 40, // quadros da desintegração (pixels viram código e caem)
  emptyFrames: 12, //        quadros só com chuva antes de reintegrar
  glitchWindow: 0.22, //     fração do tempo em que o pixel fica "código" antes de virar sólido
  fallSpeed: 34, //          linhas por unidade de tempo na queda da desintegração
  ambientColumns: 9, //      colunas de chuva de fundo
  shimmer: 2, //             pixels piscando por quadro quando parado (0 = desliga)
  settleSeed: 42, //         seed do frame final (o estático)
};

export const MATRIX_CHARS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾜﾝ0123456789';

// ─── Sprite ────────────────────────────────────────────────────────────
// 1 caractere do sprite = 1 pixel = 2 colunas no terminal (corrige o aspecto 2:1).
//   .  vazio          H  cabelo        S  pele        s  pele (sombra)
//   G  óculos         B  barba         T  camisa      E  borda da camisa
//   P  calça          K  sapato
const HEAD_AND_TORSO = [
  '......HHHHHHHH......',
  '.....HHSSSSSSHH.....',
  '.....HGGGSSGGGH.....',
  '.....SGsGSSGsGS.....',
  '.....SSSSssSSSS.....',
  '.....sSBBBBBBSs.....',
  '......BBSSSSBB......',
  '......BBBBBBBB......',
  '.......BBBBBB.......',
  '....EETTsSSsTTEE....',
  '...ETTTTTsSTTTTTE...',
  '..ETTTTTTTTTTTTTTE..',
  '..ETTTTTTTTTTTTTTE..',
] as const;

const LEGS = [
  '.....PPPP..PPPP.....',
  '.....PPPP..PPPP.....',
  '.....PPPP..PPPP.....',
  '.....PPPP..PPPP.....',
  '.....PPPP..PPPP.....',
  '....EPPPP..PPPPE....',
  '...KKKKKK..KKKKKK...',
] as const;

/** Só o bloco dos braços muda entre as poses. */
const ARMS = {
  idle: [
    '.SSSTTTTTTTTTTTTSSS.',
    '.SSS.TTTTTTTTTT.SSS.',
    '.SSS.TTTTTTTTTT.SSS.',
    '.sSS.TTTTTTTTTT.SSs.',
    '..SS.TTTTTTTTTT.SS..',
    '.SSS.PPPPPPPPPP.SSS.',
    '.SsS.PPPPPPPPPP.SsS.',
    '.S.S.PPPP..PPPP.S.S.',
  ],
  mid: [
    '.SSSTTTTTTTTTTTTSSS.',
    '.SSSSTTTTTTTTTTSSSS.',
    '..SSSSTTTTTTTTSSSS..',
    '....SSSSTTTTSSSS....',
    '.....TTTTTTTTTT.....',
    '.....PPPPPPPPPP.....',
    '.....PPPPPPPPPP.....',
    '.....PPPP..PPPP.....',
  ],
  crossed: [
    '.SSETTTTTTTTTTTTESS.',
    '.SSSSSSSSSSSTTTTSSS.',
    '.SSSSSSSssSSSSSSSSS.',
    '.SSSTTTTSSSSSSSSSSS.',
    '.....TTTTTTTTTT.....',
    '.....PPPPPPPPPP.....',
    '.....PPPPPPPPPP.....',
    '.....PPPP..PPPP.....',
  ],
} as const;

export type Pose = keyof typeof ARMS;

export const SPRITES: Record<Pose, readonly string[]> = {
  idle: [...HEAD_AND_TORSO, ...ARMS.idle, ...LEGS],
  mid: [...HEAD_AND_TORSO, ...ARMS.mid, ...LEGS],
  crossed: [...HEAD_AND_TORSO, ...ARMS.crossed, ...LEGS],
};

export const SPRITE_W = HEAD_AND_TORSO[0].length;

export const SPRITE_H = SPRITES.idle.length;

// Falha cedo se alguém editar o sprite e quebrar a largura.
for (const [pose, rows] of Object.entries(SPRITES)) {
  rows.forEach((row, i) => {
    if (row.length !== SPRITE_W) {
      throw new Error(`sprite "${pose}" linha ${i}: largura ${row.length}, esperado ${SPRITE_W}`);
    }
  });
}

// ─── Paleta ────────────────────────────────────────────────────────────
export type PixelKind = 'H' | 'S' | 's' | 'G' | 'B' | 'T' | 'E' | 'P' | 'K';

export type GlyphTone = 'head' | 'bright' | 'green' | 'dim';

export type Tone = PixelKind | GlyphTone;

/** ansi = terminal 256 cores · mono = sem cor (forma ainda legível) · hex = preview web */
export const PALETTE: Record<Tone, { ansi: string; mono: string; hex: string }> = {
  H: { ansi: '\x1b[38;5;23m', mono: '▓▓', hex: '#0e4a5c' },
  S: { ansi: '\x1b[38;5;119m', mono: '██', hex: '#7cf05a' },
  s: { ansi: '\x1b[38;5;77m', mono: '▓▓', hex: '#3fc85a' },
  G: { ansi: '\x1b[38;5;17m', mono: '░░', hex: '#0a1f4a' },
  B: { ansi: '\x1b[38;5;71m', mono: '▓▓', hex: '#3aa860' },
  T: { ansi: '\x1b[38;5;18m', mono: '▒▒', hex: '#0c2a66' },
  E: { ansi: '\x1b[38;5;30m', mono: '▓▓', hex: '#11907a' },
  P: { ansi: '\x1b[38;5;24m', mono: '▒▒', hex: '#0d3870' },
  K: { ansi: '\x1b[38;5;41m', mono: '▓▓', hex: '#2fd67a' },
  head: { ansi: '\x1b[1;38;5;157m', mono: '', hex: '#d8ffd0' },
  bright: { ansi: '\x1b[92m', mono: '', hex: '#5dff6a' },
  green: { ansi: '\x1b[32m', mono: '', hex: '#1fae3a' },
  dim: { ansi: '\x1b[90m', mono: '', hex: '#1d5a2a' },
};

export const RESET = '\x1b[0m';

export const HIDE_CURSOR = '\x1b[?25l';

export const SHOW_CURSOR = '\x1b[?25h';
