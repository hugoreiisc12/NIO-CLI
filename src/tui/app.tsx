/**
 * Raiz da interface NIO (Ink). Histórico → `<Static>` (scrollback, não re-renderiza);
 *
 * área dinâmica = mensagem em andamento (altura limitada) + input. Evita o estouro
 * de altura que corrompe o Ink.
 */
import type React from 'react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { Box, Static } from 'ink';
import type { Command } from 'commander';
import { ThinkingAvatar } from './avatar-view.js';
import { useIdentity } from './identity-reveal.js';
import {
  Footer,
  MessageView,
  LiveMessage,
  StatusLine,
  InputBox,
  Toasts,
  ErrorBlock,
  DiffSummary,
  AttachChips,
  type PaletteAction,
} from './components.js';
import { useTurnTask } from './use-turn-task.js';
import { useEngineStream } from './use-engine-stream.js';
import { useTurnActions } from './use-turn-actions.js';
import { useTurnWatchers } from './use-turn-watchers.js';
import { useEngineReplies } from './use-engine-replies.js';
import { useTerminalSize } from './use-terminal-size.js';
import { OverlayLayer, type Overlay } from './app-overlays.js';
import { computeLayout } from './app-layout.js';
import { useBusyClock, useToastPruning } from './use-ui-clock.js';
import { AskedQuestion, Splash } from './app-parts.js';
import { useChatView } from './use-chat-view.js';
import { useAppRefs } from './use-app-refs.js';
import { useGlobalKeys } from './use-global-keys.js';
import { nextMode, runEngineCommand } from './app-commands.js';
import { buildPalette, type PaletteItem } from './palette-source.js';
import { createDeltaBuffer } from './delta-buffer.js';
import { applyDeltas, emptyChat, type ChatState } from './state.js';
import type { OpencodeHandle } from './opencode.js';
import { NIO_AI_CONTEXT } from '../lib/clients/client-configs.js';

interface AppProps {
  handle: OpencodeHandle;
  program: Command;
  cwd: string;
  session: { name: string; profile: string; id: string } | null;
  splashMs?: number;
  /** força um modelo (só testes/probe; prod usa o default do opencode.json = big-pickle). */
  model?: { providerID: string; modelID: string };
}

export function App({
  handle,
  program,
  cwd,
  session,
  splashMs = 1200,
  model,
}: AppProps): React.ReactElement {
  const { rows, columns } = useTerminalSize();
  const refs = useAppRefs();
  const { pastes, sessionId, tuiCommandRef, compactingRef } = refs;
  // Rótulos do modelo (só exibição) — refletem o modelo REAL passado pela TUI;
  // fallback só quando nenhum `model` foi injetado (testes/probe).
  const engineLabel = model ? `${model.providerID}/${model.modelID}` : 'opencode/big-pickle';
  const modelLabel = model ? model.modelID : 'big-pickle';
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [draft, setDraft] = useState(''); // rascunho do input — no App pra sobreviver a overlays (Sprint 6)
  const [showReasoning, setShowReasoning] = useState(false); // Sprint 3: Ctrl-R expande o raciocínio
  const [modes, setModes] = useState<string[]>(['build', 'plan']); // Sprint 5: agentes primários (Tab cicla)
  const [mode, setMode] = useState('build');
  const [ready, setReady] = useState(false);
  // O loop de eventos vive num closure criado na montagem: sem este ref ele leria um
  // `chat` velho pra sempre. Atualizado a cada render.
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // Deltas de token coalescidos: fluidez do stream sem um redraw do Ink por token.
  const deltas = useRef(createDeltaBuffer((batch) => setChat((prev) => applyDeltas(prev, batch))));

  const [splash, setSplash] = useState(splashMs > 0);
  // Trilha do turno em `tasks` (kind=chat): mesma persistência do worker.
  // Dispara e volta — nunca aguarda o banco (ver use-turn-task).
  const turnTask = useTurnTask({ session });
  const identity = useIdentity(rows, columns); // "Quem é você?" → cena local, não vai pro modelo

  useEffect(() => {
    if (splashMs <= 0) return;
    const t = setTimeout(() => setSplash(false), splashMs);
    return () => clearTimeout(t);
  }, [splashMs]);

  const awaitingPermission = chat.permissions.length > 0;
  const { frame, busyStartedAt } = useBusyClock(chat.busy, awaitingPermission);

  const { resync } = useEngineStream({
    handle,
    refs,
    cwd,
    splash,
    model,
    mode,
    session,
    chatRef,
    setChat,
    setModes,
    setMode,
    setReady,
    deltas,
    turnTask,
    setDraft,
  });

  // rede de segurança: se ficar `busy` sem eventos, confere o status no server
  useEffect(() => {
    if (!chat.busy) return;
    const t = setInterval(resync, 4000);
    return () => clearInterval(t);
  }, [chat.busy, resync]);

  useToastPruning(chat.toasts.length, setChat);

  useGlobalKeys({
    chat,
    overlayUp: overlay.kind !== 'none',
    handle,
    sessionId,
    setChat,
    setShowReasoning,
  });

  useEffect(() => () => handle.close(), [handle]);

  // Sprint 7.2 — mapeia `tui.command.execute` do motor. Guardado num ref
  // (atualizado a cada render) pra o loop de eventos ver closures frescas.
  const toast = (message: string, variant: 'info' | 'warning' = 'info') =>
    setChat((prev) => ({
      ...prev,
      toasts: [
        ...prev.toasts.slice(-4),
        { id: `toast-${Date.now()}`, message, variant, until: Date.now() + 3000 },
      ],
    }));

  const { send, recoverFromOverflow, delegateToWorker, continueFromOutputLength } = useTurnActions({
    handle,
    refs,
    cwd,
    model,
    mode,
    chat,
    identity,
    setChat,
    setDraft,
    turnTask,
    toast,
  });

  useTurnWatchers({
    chat,
    handle,
    refs,
    toast,
    recoverFromOverflow,
    continueFromOutputLength,
    delegateToWorker,
  });

  const cycleMode = (reverse: boolean) => setMode((cur) => nextMode(modes, cur, reverse));

  tuiCommandRef.current = (cmd) =>
    runEngineCommand(cmd, {
      handle,
      sessionId,
      compactingRef,
      setChat,
      setDraft,
      draft,
      send,
      cycleMode,
      toast,
    });

  const palette = useMemo(() => buildPalette(program), [program]);
  const onDispatch = (item: PaletteItem, action: PaletteAction) => {
    setDraft('');
    if (action === 'prompt' && item.kind === 'capability') return send(item.prompt);
    if (action === 'run' && item.kind === 'command') return setOverlay({ kind: 'run', item });
    setOverlay({ kind: 'info', item }); // 'info' (help, ou comando sem run)
  };
  const closeOverlay = () => setOverlay({ kind: 'none' });

  const { respondPermission, settleQuestion } = useEngineReplies({
    chat,
    handle,
    refs,
    setChat,
    resync,
  });

  const { finished, live, phase, elapsed, question, options, usage, attachLabels } = useChatView(
    chat,
    draft,
    busyStartedAt,
  );

  if (splash) return <Splash columns={columns} engineLabel={engineLabel} />;

  const disabled = chat.busy || !ready || identity.active;
  const pendingPerm = chat.permissions[0] ?? null;
  const pendingQ = !pendingPerm ? (chat.questions[0] ?? null) : null; // permissão tem prioridade
  const overlayUp = overlay.kind !== 'none' || !!pendingPerm || !!pendingQ;
  const paletteOpen = draft.startsWith('/') && !overlayUp;
  const { paletteMaxItems, avatarUp, liveMax } = computeLayout({
    rows,
    busy: chat.busy,
    overlayUp,
    paletteOpen,
    live,
  });
  const inputActive = !overlayUp;

  // layout tipo Claude Code (Sprint 4): fluxo vertical, sem sidebar, rodapé de 1–2 linhas.
  return (
    <Box flexDirection="column" width={columns}>
      <Static items={finished}>{(m) => <MessageView key={m.id} message={m} />}</Static>

      {identity.node}

      {live && (
        <LiveMessage
          message={live}
          maxLines={liveMax}
          todos={chat.todos}
          files={chat.files}
          retry={chat.retry}
          expandReasoning={showReasoning}
        />
      )}
      <DiffSummary changes={chat.diff} />
      <ThinkingAvatar active={avatarUp} frame={frame} rows={rows} />
      <StatusLine busy={chat.busy} frame={frame} seconds={elapsed} label={phase} />
      {chat.error && <ErrorBlock error={chat.error} />}
      <Toasts toasts={chat.toasts} />

      {question && !overlayUp && <AskedQuestion question={question} columns={columns} />}

      {/* Item 4 — chips dos arquivos detectados no rascunho, acima do input. */}
      {!overlayUp && <AttachChips files={attachLabels} />}

      {/* o input NUNCA desmonta — o rascunho fica no App (Sprint 6). */}
      <InputBox
        value={draft}
        onChange={setDraft}
        disabled={disabled}
        active={inputActive}
        palette={palette}
        onSubmit={send}
        pastes={pastes.current}
        onDispatch={onDispatch}
        onCycleMode={cycleMode}
        options={overlayUp ? [] : options}
        width={Math.max(24, columns - 6)}
        maxItems={paletteMaxItems}
      />

      {/* camada por cima do input — não substitui, só sobrepõe. */}
      <OverlayLayer
        pendingPerm={pendingPerm}
        pendingQ={pendingQ}
        queuedPerms={chat.permissions.length}
        queuedQuestions={chat.questions.length}
        overlay={overlay}
        cwd={cwd}
        onRespondPermission={respondPermission}
        onSettleQuestion={settleQuestion}
        onClose={closeOverlay}
      />

      <Footer
        model={modelLabel}
        cwd={cwd}
        session={session}
        mode={mode}
        tokensIn={usage.tokensIn}
        tokensOut={usage.tokensOut}
        contextLimit={NIO_AI_CONTEXT}
      />
    </Box>
  );
}
