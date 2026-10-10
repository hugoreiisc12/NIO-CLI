import { ICON_ROWS, avatarFits } from './avatar-view.js';
import { liveMessageLines, roomForAvatar } from './live-layout.js';
import type { ChatMessage } from './state.js';

interface LayoutInput {
  rows: number;
  busy: boolean;
  overlayUp: boolean;
  paletteOpen: boolean;
  live: ChatMessage | null;
}

/** Alturas da área viva: o personagem cede, o conteúdo não. */
export function computeLayout({ rows, busy, overlayUp, paletteOpen, live }: LayoutInput): {
  paletteMaxItems: number;
  avatarUp: boolean;
  liveMax: number;
} {
  // teto da área viva — encolhe quando a droplist `/` abre, pro total (live +
  // status + input + droplist + rodapé) caber e não corromper o Ink.
  const paletteMaxItems = Math.max(3, Math.min(6, rows - 16));
  const liveCap = Math.max(3, Math.floor(rows * 0.45) - (paletteOpen ? paletteMaxItems + 3 : 0));
  // O personagem cede, o conteúdo não: ele acompanha o turno enquanto a resposta
  // ainda couber SEM as linhas dele, e sai de cena quando o texto precisa da tela.
  const avatarUp =
    busy &&
    !overlayUp &&
    avatarFits(rows) &&
    roomForAvatar(live ? liveMessageLines(live) : 1, liveCap, ICON_ROWS);
  const liveMax = avatarUp ? Math.max(3, liveCap - ICON_ROWS) : liveCap;
  return { paletteMaxItems, avatarUp, liveMax };
}
