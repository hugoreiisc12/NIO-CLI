import type React from 'react';
import { InfoPanel, CommandRunner, PermissionModal } from './palette.js';
import { QuestionModal } from './question-modal.js';
import type { PaletteItem } from './palette-source.js';
import type { PermissionReq, QuestionReq } from './state.js';

export type Overlay =
  | { kind: 'none' }
  | { kind: 'info'; item: PaletteItem }
  | { kind: 'run'; item: Extract<PaletteItem, { kind: 'command' }> };

interface OverlayLayerProps {
  pendingPerm: PermissionReq | null;
  pendingQ: QuestionReq | null;
  queuedPerms: number;
  queuedQuestions: number;
  overlay: Overlay;
  cwd: string;
  onRespondPermission: (r: 'once' | 'always' | 'reject') => void;
  onSettleQuestion: (path: 'reply' | 'reject', answers?: string[][]) => void;
  onClose: () => void;
}

/** Qual camada fica por cima do input: permissão > pergunta > painel de info/execução. */
export function OverlayLayer(props: OverlayLayerProps): React.ReactElement | null {
  const { pendingPerm, pendingQ, overlay } = props;
  if (pendingPerm) {
    return (
      <PermissionModal
        req={pendingPerm}
        queued={props.queuedPerms}
        onRespond={props.onRespondPermission}
      />
    );
  }
  if (pendingQ) {
    return (
      <QuestionModal
        key={pendingQ.id}
        req={pendingQ}
        queued={props.queuedQuestions}
        onAnswer={(answers) => props.onSettleQuestion('reply', answers)}
        onReject={() => props.onSettleQuestion('reject')}
      />
    );
  }
  if (overlay.kind === 'info') return <InfoPanel item={overlay.item} onClose={props.onClose} />;
  if (overlay.kind === 'run') {
    return <CommandRunner item={overlay.item} cwd={props.cwd} onClose={props.onClose} />;
  }
  return null;
}
