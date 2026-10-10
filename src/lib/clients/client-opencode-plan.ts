import { brand, envName } from '../../brand.js';
import type { McpSpec } from '../../core/environment.js';
import { hasMissingAskRules, withMcpAskRules } from './mcp-permissions.js';
import {
  NIO_AI_CONTEXT,
  NIO_AI_MODEL_ID,
  NIO_AI_OUTPUT,
  NIO_AI_PROVIDER,
  NIO_AI_VISION,
  NIO_OPERATOR_MODEL,
  declaredContextWindow,
} from './client-env.js';
import type {
  OpencodeModelEntry,
  OpencodeProviderEntry,
  OpencodeServerEntry,
} from './client-opencode-shape.js';
import {
  DEFAULT_OPENCODE_COMPACTION,
  DEFAULT_OPENCODE_PERMISSION,
  DEFAULT_OPENCODE_WATCHER,
  modelCapabilities,
  opencodeMcpEntry,
  opencodeMcpOk,
} from './client-opencode-shape.js';

/**
 * Semeia o **provider dedicado** do motor de IA da CLI (`provider.<id>`, OpenAI-compatível
 * via `@ai-sdk/openai-compatible`) apontando DIRETO no backend (`baseURL`) e declarando o
 * modelo (`modelId`) com seu limite de contexto. Isto **não** toca o provider `opencode` —
 * ele fica no default (big-pickle), fora do motor da CLI. Preserva campos/modelos já
 * presentes no provider. Pura, sem IO.
 */
export function planNioAiProvider(
  existing: Record<string, unknown>,
  provider: string,
  baseURL: string,
  modelId: string,
  context: number,
  output: number,
): Record<string, unknown> {
  const providers = {
    ...((existing.provider ?? {}) as Record<string, OpencodeProviderEntry | undefined>),
  };
  const cur = providers[provider] ?? {};
  const models = { ...(cur.models ?? {}) } as Record<string, OpencodeModelEntry>;
  // Declara a janela COM margem: `context` é a real do modelo, não a orçável.
  const declared = declaredContextWindow(context, output);
  const limit =
    context > 0 ? { ...models[modelId]?.limit, context: declared, output } : models[modelId]?.limit;
  // As capacidades vêm DEPOIS do que já existe: um modelo local não está no catálogo
  // models.dev, então sem declaração o OpenCode assume que ele não aceita anexo.
  models[modelId] = {
    name: 'NIO local (vLLM)',
    ...models[modelId],
    ...(limit ? { limit } : {}),
    ...modelCapabilities(),
  };
  providers[provider] = {
    ...cur,
    npm: cur.npm ?? '@ai-sdk/openai-compatible',
    name: cur.name ?? 'NIO local (vLLM)',
    options: {
      ...cur.options,
      baseURL,
      apiKey: (cur.options?.apiKey as string | undefined) ?? 'local',
    },
    models,
  };
  return { ...existing, provider: providers };
}

/** O provider dedicado já está OK? (existe, baseURL bate, e o modelo tem o limite pedido). */
function nioAiProviderOk(
  existing: Record<string, unknown>,
  provider: string,
  baseURL: string,
  modelId: string,
  context: number,
  output: number,
): boolean {
  const p = (existing.provider as Record<string, OpencodeProviderEntry | undefined> | undefined)?.[
    provider
  ];
  if (!p || p.options?.baseURL !== baseURL) return false;
  // Capacidade também entra na comparação: sem isto o config JÁ EXISTENTE do usuário nunca
  // ganharia `attachment` e a imagem seguiria sendo descartada em silêncio.
  const entry = p.models?.[modelId];
  if (Boolean(entry?.attachment) !== NIO_AI_VISION) return false;
  if (context <= 0) return Boolean(entry);
  const lim = entry?.limit;
  // Compara com a janela DECLARADA — senão o config em disco nunca bate e reescreve sempre.
  return lim?.context === declaredContextWindow(context, output) && lim?.output === output;
}

/** Tem um `baseURL` de provider `opencode` gravado? (legado do hijack — não deve mais ter). */
function opencodeHasBaseURL(existing: Record<string, unknown>): boolean {
  const p = (existing.provider as { opencode?: OpencodeProviderEntry } | undefined)?.opencode;
  return p?.options?.baseURL !== undefined;
}

/**
 * Remove o `baseURL` do provider `opencode` (Headroom DESATIVADO — client fala direto
 * no OpenCode Zen). Limpa `options`/`provider.opencode` que ficarem vazios. Pura, sem IO.
 */
export function clearOpencodeProviderBaseURL(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const providers = existing.provider as
    | Record<string, OpencodeProviderEntry | undefined>
    | undefined;
  const cur = providers?.opencode;
  if (cur?.options?.baseURL === undefined) return existing; // nada a limpar
  const restOptions: Record<string, unknown> = { ...cur.options };
  delete restOptions.baseURL; // Record plano → delete permitido
  // `options: undefined` some no JSON.stringify (chaves undefined são omitidas).
  const opencode: OpencodeProviderEntry =
    Object.keys(restOptions).length > 0
      ? { ...cur, options: restOptions }
      : { ...cur, options: undefined };
  return { ...existing, provider: { ...providers, opencode } };
}

/**
 * Decide se o `nio` (+ os MCPs do perfil) já estão OK no `opencode.json` e monta
 * o próximo objeto se precisar atualizar (pura, sem IO). O OpenCode usa `mcp`
 * (não `mcpServers`/`mcp_servers`), `command` como array (binário + args juntos)
 * e `environment` (não `env`). Também garante o `model` default
 * (`NIO_OPERATOR_MODEL`) no nível raiz.
 */
export function planOpencodeUpdate(
  existing: Record<string, unknown>,
  nioEntry: { command: string[]; environment: Record<string, string> },
  profileMcps: McpSpec[] = [],
  baseURL?: string,
): { alreadyConfigured: boolean; next: Record<string, unknown> } {
  const servers = (existing.mcp ?? {}) as Record<string, OpencodeServerEntry | undefined>;
  const current = servers[brand.mcpServerKey];

  const nioOk = Boolean(
    current &&
      current.command?.[0] === nioEntry.command[0] &&
      current.environment?.[envName('CLIENT')] === 'opencode' &&
      current.enabled !== false,
  );
  const mcpsOk = profileMcps.every((spec) => opencodeMcpOk(spec, servers[spec.id]));
  // Motor = provider dedicado (NIO_AI_PROVIDER) direto no backend. Com baseURL, ele
  // precisa existir com o modelo+limite declarados; sem baseURL, o opencode não deve
  // ter baseURL de hijack legado (fica no default big-pickle).
  const providerOk = baseURL
    ? nioAiProviderOk(
        existing,
        NIO_AI_PROVIDER,
        baseURL,
        NIO_AI_MODEL_ID,
        NIO_AI_CONTEXT,
        NIO_AI_OUTPUT,
      )
    : !opencodeHasBaseURL(existing);
  const alreadyConfigured =
    nioOk &&
    existing.model === NIO_OPERATOR_MODEL &&
    mcpsOk &&
    providerOk &&
    Boolean(existing.permission) &&
    !hasMissingAskRules(existing.permission, profileMcps) &&
    Boolean(existing.compaction) &&
    Boolean(existing.watcher);

  const nextMcp: Record<string, OpencodeServerEntry> = {
    ...(servers as Record<string, OpencodeServerEntry>),
    [brand.mcpServerKey]: {
      type: 'local',
      ...current,
      command: nioEntry.command,
      environment: { ...current?.environment, [envName('CLIENT')]: 'opencode' },
      enabled: true,
    },
  };
  for (const spec of profileMcps) {
    nextMcp[spec.id] = opencodeMcpEntry(spec, servers[spec.id]);
  }

  let next: Record<string, unknown> = { ...existing, model: NIO_OPERATOR_MODEL, mcp: nextMcp };
  // Sprint 7.5 — nunca sobrescreve o do usuário; só acrescenta o `ask` das tools de MCP que mexem em estado
  next.permission = withMcpAskRules(
    existing.permission ?? DEFAULT_OPENCODE_PERMISSION,
    profileMcps,
  );
  if (!existing.compaction) next.compaction = DEFAULT_OPENCODE_COMPACTION; // janela apertada — nunca sobrescreve
  if (!existing.watcher) next.watcher = DEFAULT_OPENCODE_WATCHER; // nunca sobrescreve
  next = clearOpencodeProviderBaseURL(next); // limpa qualquer hijack legado no provider `opencode`
  if (baseURL)
    next = planNioAiProvider(
      next,
      NIO_AI_PROVIDER,
      baseURL,
      NIO_AI_MODEL_ID,
      NIO_AI_CONTEXT,
      NIO_AI_OUTPUT,
    );
  return { alreadyConfigured, next };
}
