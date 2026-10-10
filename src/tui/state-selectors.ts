import type { ToolAttempt } from '../core/learning.js';
import type { ChatMessage, ChatPart, ChatState } from './state-types.js';

/**
 * Compactação proativa: os `tokens` (input+output do último step, = contexto atual)
 * já cruzaram o teto menos a folga reservada? Se sim, o App dispara `session.summarize`
 * no próximo idle — compacta entre turnos, não no início do próximo prompt (evita a
 * trava de "demora pra continuar após estourar"). Puro e testável; sem IO.
 */
export function shouldCompact(tokens: number, context: number, reserved: number): boolean {
  if (context <= 0 || tokens <= 0) return false;
  return tokens >= context - reserved;
}

/**
 * Uso da janela de contexto no último turno do assistant, pra o rodapé medir
 * "quanto o turno gastou" contra a janela do provider. `tokensIn` = o MAIOR
 * `tokensIn` entre os steps (o prompt de pico já inclui todo o histórico —
 * somar contaria o contexto N vezes); `tokensOut` = a SOMA do output gerado nos
 * steps. Em turno multi-step o total in+out superestima um pouco (o output de um
 * step vira input do próximo), o que é o lado seguro pra um medidor de teto.
 * `{0,0}` se nenhum turno reportou uso. Puro.
 */
export function contextUsage(messages: ChatMessage[]): { tokensIn: number; tokensOut: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    const steps = m.parts.filter((p) => p.step).map((p) => p.step!);
    if (steps.length === 0) continue;
    return {
      tokensIn: Math.max(...steps.map((s) => s.tokensIn)),
      tokensOut: steps.reduce((n, s) => n + s.tokensOut, 0),
    };
  }
  return { tokensIn: 0, tokensOut: 0 };
}

/** Soma dos tokens/custo de todos os `step` parts de uma mensagem. */
export function messageUsage(
  msg: ChatMessage,
): { tokensIn: number; tokensOut: number; cost: number } | null {
  const steps = msg.parts.filter(
    (p): p is ChatPart & { step: NonNullable<ChatPart['step']> } => !!p.step,
  );
  if (steps.length === 0) return null;
  return steps.reduce(
    (acc, s) => ({
      tokensIn: acc.tokensIn + s.step.tokensIn,
      tokensOut: acc.tokensOut + s.step.tokensOut,
      cost: acc.cost + s.step.cost,
    }),
    { tokensIn: 0, tokensOut: 0, cost: 0 },
  );
}

/** Texto (sem blocos de código) da última mensagem, se ela for do assistant e a
 *  conversa estiver parada e sem permissão pendente. `null` caso contrário. */
function idleAssistantText(state: ChatState): string | null {
  if (state.busy || state.permissions.length > 0) return null;
  const last = state.messages[state.messages.length - 1];
  if (last?.role !== 'assistant') return null;
  const text = last.parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('')
    .replace(/```[\s\S]*?```/g, '') // ignora blocos de código
    .trim();
  return text || null;
}

/**
 * Sprint 7.4 — o big-pickle não tem "pergunta e espera"; ele termina o texto com
 * `?` e para. Devolve a pergunta (a linha com `?`) pra a UI destacar. `null` =
 * nada aguardando.
 */
export function pendingQuestion(state: ChatState): string | null {
  const text = idleAssistantText(state);
  if (!text) return null;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  if (/\?["'`)\]]*$/.test(lastLine)) return lastLine;
  // pergunta seguida de opções: pega a última linha que termina com `?`
  const qLine = [...lines].reverse().find((l) => /\?["'`)\]]*$/.test(l));
  return qLine ?? null;
}

/**
 * Sprint 7.6 — extrai opções numeradas/marcadas da última mensagem do assistant
 * (só quando ela contém uma pergunta). `1. …` / `2) …` / `- [ ] …` / `a) …`.
 * `[]` se < 2 opções (aí é texto normal, não menu).
 */
export function questionOptions(state: ChatState): string[] {
  const text = idleAssistantText(state);
  if (!text?.includes('?')) return [];
  const opts: string[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:\d{1,2}[.)]|[-*]\s*\[[ xX]?\]|[a-zA-Z][.)])\s+(.{2,120}?)\s*$/.exec(raw);
    if (m?.[1]) opts.push(m[1].trim());
  }
  return opts.length >= 2 ? opts.slice(0, 8) : [];
}

/**
 * A compactação que chegou deve ser abortada?
 *
 * Bug de produção: a TUI dispara `session.summarize` proativamente **quando a sessão
 * está ociosa** (é o momento certo — não atrapalha ninguém). Mas `userTurnActive` é
 * falso justamente por estar ociosa, então o guard de "emenda não solicitada" matava a
 * compactação que a própria TUI tinha pedido. Efeito: o contexto nunca compactava,
 * crescia até estourar a janela, e o turno morria.
 *
 * O sinal que faltava é **quem pediu**. Emenda que ninguém pediu segue sendo abortada.
 */
export function shouldAbortCompaction(opts: {
  /** Há um turno do usuário em curso? */
  userTurnActive: boolean;
  /** A TUI pediu esta compactação (proativa ou `/compact`)? */
  requestedByTui: boolean;
  /** Há prompt enviado e ainda sem resposta (livro-caixa: `pending > 0`)? */
  workInFlight?: boolean;
}): boolean {
  if (opts.userTurnActive) return false; // turno vivo: nunca matar
  if (opts.workInFlight) return false; // request pendente: idem — ela não pode morrer
  return !opts.requestedByTui;
}

/**
 * O servidor recusou o reply? — decide se o tombstone pode ser solto.
 *
 * Dois clientes, a mesma armadilha: `fetch` só rejeita em erro de rede, e o client
 * do opencode também (`throwOnError` é falsy por padrão) — um 4xx chega numa promessa
 * **cumprida**. Quem trata só `.catch` acredita que respondeu, o tombstone fica preso,
 * e o reconcile passa a ignorar um pedido que o servidor continua listando: o modal
 * some em silêncio e o motor trava sem uma linha no `tlog`.
 *
 * Aceita as duas formas: `Response` cru (`{ ok }`) e o envelope do SDK (`{ error }`).
 */
export function replyFailed(res: unknown): boolean {
  if (typeof res !== 'object' || res === null) return false;
  const r = res as { ok?: unknown; error?: unknown };
  if (typeof r.ok === 'boolean') return !r.ok; // fetch cru
  return r.error != null; // client do opencode: 4xx/5xx vem como `{ error }`
}

/** Motivo curto da recusa, pro `tlog`. Vazio quando o reply foi aceito. */
export function replyErrorDetail(res: unknown): string {
  if (!replyFailed(res) || typeof res !== 'object' || res === null) return '';
  const err = (res as { error?: unknown }).error;
  if (err == null) return '';
  if (typeof err === 'string') return err.slice(0, 200);
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' ? msg.slice(0, 200) : JSON.stringify(err).slice(0, 200);
}

/**
 * Converte o histórico em tentativas de tool, para o aprendizado contínuo.
 *
 * O raciocínio atribuído a cada chamada é o **imediatamente anterior a ela na mesma
 * mensagem** — é o que o modelo pensou ANTES de chamar, ou seja, o que levou ao erro.
 * Pegar o raciocínio posterior seria pegar a consequência, não a causa.
 */
export function toolAttempts(messages: readonly ChatMessage[]): ToolAttempt[] {
  const out: ToolAttempt[] = [];
  for (const msg of messages) {
    let reasoning = '';
    for (const part of msg.parts) {
      if (part.kind === 'reasoning') {
        reasoning = part.text.trim();
        continue;
      }
      if (part.kind !== 'tool' || !part.tool) continue;
      out.push({
        tool: part.tool.name,
        status: part.tool.status,
        input: part.tool.input,
        output: part.tool.output,
        reasoning: reasoning || undefined,
      });
      reasoning = ''; // consumido: não vaza pra próxima chamada da mesma mensagem
    }
  }
  return out;
}

/** Tools que falharam nesta sessão — o recall só lembra do que já mordeu aqui. */
export function failedTools(messages: readonly ChatMessage[]): string[] {
  const falhas = new Set<string>();
  for (const a of toolAttempts(messages)) {
    if (a.status === 'error' || a.status === 'failed') falhas.add(a.tool);
  }
  return [...falhas];
}
