import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { PromptInput } from './prompt-input.js';
import type { PasteStore } from './pasted-text.js';
import { filterPalette, type PaletteItem } from './palette-source.js';
import type { PaletteAction } from './components-blocks.js';
import { KIND_LABEL, QuestionPicker } from './components-blocks.js';

function SlashList({ items, sel }: { items: PaletteItem[]; sel: number }): React.ReactElement {
  const cur = items[sel];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {items.length === 0 && <Text color={theme.dim}>nenhum comando casa</Text>}
      {items.map((it, n) => (
        <Text
          key={`${it.kind}:${it.name}`}
          inverse={n === sel}
          color={n === sel ? theme.accentBright : undefined}
          wrap="truncate-end"
        >
          {' '}
          <Text color={theme.dim}>[{KIND_LABEL[it.kind]}]</Text> {it.name}{' '}
          <Text color={theme.dim}>{it.desc}</Text>
        </Text>
      ))}
      <Text color={theme.dim}>
        ↑↓ · Enter{' '}
        {cur?.kind === 'capability'
          ? 'manda pro agente'
          : cur?.kind === 'command'
            ? 'roda'
            : 'abre'}{' '}
        · Esc sai
      </Text>
    </Box>
  );
}

/** Ação default da paleta por tipo de item (Sprint 6: comando = RODAR). */
export function defaultPaletteAction(kind: PaletteItem['kind']): PaletteAction {
  return kind === 'capability' ? 'prompt' : kind === 'command' ? 'run' : 'info';
}

/**
 * Input do chat. `/` no início liga o modo paleta **inline** — a lista fica
 * embaixo, o `/` fica visível, e apagar o `/` sai do modo. A edição de texto
 * (cursor, multi-linha, atalhos, paste) vive no `<PromptInput>` (Sprint 1).
 *
 * **Controlado** (Sprint 6): `value`/`onChange` vêm do App, então o rascunho
 * sobrevive a abrir/fechar overlay. `active=false` = um overlay está por cima,
 * o input mostra o rascunho mas não captura teclado.
 */
export function InputBox({
  value,
  onChange,
  disabled,
  active = true,
  palette,
  onSubmit,
  onDispatch,
  onCycleMode,
  options = [],
  width = 80,
  maxItems = 6,
  pastes,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  active?: boolean;
  palette: PaletteItem[];
  onSubmit: (text: string) => void;
  onDispatch: (item: PaletteItem, action: PaletteAction) => void;
  /** Sprint 5: Tab cicla o modo do agente (o App resolve o próximo). */
  onCycleMode?: (reverse: boolean) => void;
  /** Sprint 7.6: opções da pergunta do modelo — vira um menu quando o input está vazio. */
  options?: string[];
  /** colunas disponíveis pro texto (o App calcula descontando sidebar/borda). */
  width?: number;
  /** teto de itens na droplist — o App encolhe quando a tela é curta. */
  maxItems?: number;
  /** Store das colagens compactadas — o App expande no envio. */
  pastes?: PasteStore;
}): React.ReactElement {
  const [sel, setSel] = React.useState(0);
  const [optSel, setOptSel] = React.useState(0);

  const inPalette = value.startsWith('/');
  const picking = active && options.length > 0 && value === '' && !inPalette;
  const optSelC = Math.min(optSel, Math.max(0, options.length - 1));
  const optsKey = options.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: efeito de gatilho: roda só quando as deps listadas mudam; o corpo lê o closure fresco da própria render
  React.useEffect(() => {
    setOptSel(0);
  }, [optsKey]);
  const matches = React.useMemo(
    () => (inPalette ? filterPalette(palette, value.slice(1)).slice(0, Math.max(1, maxItems)) : []),
    [inPalette, value, palette, maxItems],
  );
  const selC = Math.min(sel, Math.max(0, matches.length - 1));

  const handleSubmit = (v: string): void => {
    const t = v.trim();
    onChange('');
    setSel(0);
    if (t) onSubmit(t);
  };
  const handleNav = (dir: 'up' | 'down' | 'submit' | 'cancel'): void => {
    if (picking) {
      if (dir === 'up') {
        setOptSel((n) => Math.max(0, n - 1));
        return;
      }
      if (dir === 'down') {
        setOptSel((n) => Math.min(options.length - 1, n + 1));
        return;
      }
      if (dir === 'cancel') return; // Esc no menu — deixa quieto, dá pra digitar
      const chosen = options[optSelC];
      if (chosen) {
        setOptSel(0);
        onSubmit(chosen);
      }
      return;
    }
    if (dir === 'up') {
      setSel((n) => Math.max(0, n - 1));
      return;
    }
    if (dir === 'down') {
      setSel((n) => Math.min(matches.length - 1, n + 1));
      return;
    }
    if (dir === 'cancel') {
      onChange('');
      setSel(0);
      return;
    }
    const it = matches[selC];
    if (!it) return;
    onChange('');
    setSel(0);
    onDispatch(it, defaultPaletteAction(it.kind));
  };
  const handleChange = (v: string): void => {
    onChange(v);
    if (v.startsWith('/')) setSel(0);
  };

  return (
    <Box flexDirection="column">
      {picking && <QuestionPicker options={options} sel={optSelC} />}
      <PromptInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        navCapture={(inPalette || picking) && active}
        onNav={handleNav}
        onTab={onCycleMode}
        disabled={disabled}
        active={active}
        width={width}
        pastes={pastes}
        placeholder={
          disabled
            ? '(pode digitar; envia quando a resposta terminar)'
            : picking
              ? '↑↓ pra escolher, ou digite'
              : ''
        }
        borderColor={
          disabled ? theme.dim : inPalette || picking ? theme.accentBright : theme.accent
        }
      />
      {inPalette && active && <SlashList items={matches} sel={selC} />}
    </Box>
  );
}
