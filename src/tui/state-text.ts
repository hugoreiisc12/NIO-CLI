import type { ChatMessage } from './state-types.js';

/** Pares de tag de reasoning inline (lista canônica, espelha o open-webui). */
const REASONING_TAGS: [string, string][] = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
  ['<reason>', '</reason>'],
  ['<reasoning>', '</reasoning>'],
  ['<thought>', '</thought>'],
  ['◁think▷', '◁/think▷'],
  ['<|begin_of_thought|>', '<|end_of_thought|>'],
];

/**
 * Fallback: tira reasoning inline do texto de saída, pra quando o provider NÃO
 * separa o reasoning num part próprio (ex.: vLLM sem `--reasoning-parser`, ou
 * outro modelo que emite `<think>` no content). Remove spans fechados; um tag
 * aberto sem fechamento (streaming) corta do tag até o fim. Puro, sem regex.
 */
export function stripReasoningTags(text: string): string {
  let out = text;
  for (const [open, close] of REASONING_TAGS) {
    let start = out.indexOf(open);
    while (start >= 0) {
      const end = out.indexOf(close, start + open.length);
      if (end < 0) {
        out = out.slice(0, start); // aberto sem fechar → some do tag em diante
        break;
      }
      out = out.slice(0, start) + out.slice(end + close.length);
      start = out.indexOf(open);
    }
  }
  return out;
}

/**
 * Marcadores de seção do scaffolding/resumo interno (formato da compactação do
 * opencode e de "work-state/handoff"). Token = a keyword; semântica = header de seção.
 */
const SCAFFOLD_MARKERS = [
  'objective',
  'important details',
  'work state',
  'completed',
  'active',
  'blocked',
  'next move',
  'relevant files',
];

/** `true` se o texto casa o padrão de scaffolding (≥3 headers de seção). Puro. */
export function looksLikeScaffolding(text: string): boolean {
  if (!text) return false;
  let hits = 0;
  for (const m of SCAFFOLD_MARKERS) {
    if (new RegExp(`(^|\\n)\\s*#{0,3}\\s*${m}\\b`, 'i').test(text)) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

/**
 * `true` = mensagem interna a OFUSCAR do output: resumo da compactação (flag exata
 * `mode:compaction`/`summary`) OU texto que casa o scaffolding (rede semântica).
 */
export function isInternalMessage(m: ChatMessage): boolean {
  if (m.mode === 'compaction' || m.summary === true) return true;
  const text = m.parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
  return looksLikeScaffolding(text);
}

/** Resumo curto dos args de uma tool (arquivo / comando / pattern / url…). */
export function summarizeToolInput(input?: Record<string, unknown>): string {
  if (!input) return '';
  const keys = [
    'filePath',
    'file_path',
    'command',
    'pattern',
    'query',
    'url',
    'path',
    'prompt',
    'description',
  ];
  for (const k of keys) if (typeof input[k] === 'string' && input[k]) return String(input[k]);
  const first = Object.values(input).find((v) => typeof v === 'string' && v);
  return first ? String(first) : '';
}

/** Dica humana por tipo de erro do motor. */
export function errorHint(name: string): string {
  switch (name) {
    case 'ContextOverflowError':
      return 'a janela de contexto estourou — zerando e seguindo com um resumo da conversa';
    case 'ProviderAuthError':
      return 'credencial do provedor inválida — rode `opencode auth login`';
    case 'MessageOutputLengthError':
      return 'a resposta ficou longa demais — peça em partes menores';
    case 'APIError':
      return 'erro na API do provedor';
    default:
      return 'erro no motor';
  }
}
