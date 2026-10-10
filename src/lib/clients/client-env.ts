import { env } from '../../brand.js';

/**
 * Motor de IA da CLI (ver `docs/arch/ARQUITETURA-CLIENTE-IA.md`). O NIO **não** roteia
 * mais pelo provider `opencode` (Zen) — esse fica no default dele (big-pickle) e sem
 * competência sobre o motor da CLI. Em vez disso, o NIO semeia um **provider dedicado**
 * (`NIO_AI_PROVIDER`, OpenAI-compatível) que fala DIRETO no backend, e é ESSE o `model`
 * default. Assim o OpenCode vira só o runtime (serve/TUI/SDK), não o motor.
 */
export const NIO_AI_PROVIDER = env('AI_PROVIDER')?.trim() || 'nio-local';

/** Id do modelo **exatamente como o backend serve** (sem prefixo de provider). Override `NIO_AI_MODEL`. */
export const NIO_AI_MODEL_ID = env('AI_MODEL')?.trim() || 'RedHatAI/Qwen3.8-27B-INT4';

/**
 * Modelo de **embedding** do RAG — roda local, em CPU, via ONNX. É um encoder
 * (~278M params) que só transforma texto em vetor: não gera texto, não é a LLM
 * acima. Trocar o modelo muda a dimensão do vetor → exige migration nova.
 */
export const NIO_AI_EMBED_MODEL = env('AI_EMBED_MODEL')?.trim() || 'Xenova/multilingual-e5-base';

/**
 * Limiar do **Nível 1** (adaptar um template parecido). Derivado de benchmark: ponto
 * médio entre "pergunta não relacionada" (0,83) e "paráfrase legítima" (0,93).
 *
 * **Nunca** autoriza replay: medimos que perguntas ERRADAS (ano/métrica/dimensão
 * diferentes) pontuam 0,955–0,965 — acima das paráfrases legítimas. Acima do limiar o
 * template só serve de base pra adaptação pelo modelo.
 */
export const NIO_FABRIC_RAG_TEMPLATE_MIN = envNum('FABRIC_RAG_TEMPLATE_MIN', 0.88);

/**
 * Top-k da busca na documentação. **Sem limiar de score**: pergunta em pt-BR contra doc
 * em inglês fica na faixa 0,72–0,82, então um corte em 0,9 não retornaria nada.
 */
export const NIO_FABRIC_RAG_TOPK = envNum('FABRIC_RAG_TOPK', 5);

/**
 * Teto de linhas devolvidas ao agente por consulta. A API permite 100k; despejar isso
 * no contexto é desperdício e ainda estoura a janela. O `row_count` real é **sempre**
 * reportado, e a truncagem é explícita — o agente deve agregar no DAX, não varrer.
 */
export const NIO_FABRIC_MAX_ROWS = envNum('FABRIC_MAX_ROWS', 100);

/**
 * Teto de **tamanho** do bloco de linhas. Contagem sozinha não limita o payload:
 * medido, 100 linhas de `INFO.VIEW.MEASURES()` (16 colunas) dão ~13k tokens. O que
 * vier primeiro — linhas ou caracteres — encerra a lista.
 */
export const NIO_FABRIC_MAX_ROW_CHARS = envNum('FABRIC_MAX_ROW_CHARS', 20_000);

/**
 * Piso de similaridade do grounding. Pergunta em pt-BR contra chunk de schema fica na
 * faixa 0,72–0,85; abaixo de 0,60 o vizinho é ruído e só gasta token.
 */
export const NIO_FABRIC_RAG_MIN_SCORE = envNum('FABRIC_RAG_MIN_SCORE', 0.6);

/** Teto de caracteres por chunk de grounding (tabela larga vira string enorme). */
export const NIO_FABRIC_RAG_MAX_CHUNK_CHARS = envNum('FABRIC_RAG_MAX_CHUNK_CHARS', 1200);

/** Teto total do bloco de grounding injetado no prompt. */
export const NIO_FABRIC_RAG_MAX_TOTAL_CHARS = envNum('FABRIC_RAG_MAX_TOTAL_CHARS', 6000);

/** Ref completo `<provider>/<id>` gravado no `model` do `opencode.json` e usado no `opencode run`. */
export const NIO_OPERATOR_MODEL = `${NIO_AI_PROVIDER}/${NIO_AI_MODEL_ID}`;

/**
 * baseURL do backend de IA (OpenAI-compatível, `/v1`) que o provider dedicado consome —
 * o SDK anexa `/chat/completions`. Default = vLLM interno; override via `NIO_AI_BASE_URL`.
 */
export const NIO_AI_BASE_URL = env('AI_BASE_URL')?.trim() || 'http://192.168.0.140:8001/v1';

/** Lê um env numérico (`NIO_<name>`); vazio/ausente/inválido → `dflt`. `0` é honrado. */
function envNum(name: string, dflt: number): number {
  const raw = env(name)?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Janela de contexto (tokens) do modelo do backend de IA, **declarada** no provider
 * (`provider.opencode.models.<id>.limit`). O OpenCode só aceita/orça um modelo fora
 * do catálogo Zen se ele estiver declarado — sem isto, um id de vLLM/local vira
 * "Model not found". Default 65536 (o vLLM local); override `NIO_AI_CONTEXT`.
 * `NIO_AI_CONTEXT=0` desativa a declaração (usa o catálogo do provider).
 */
export const NIO_AI_CONTEXT = envNum('AI_CONTEXT', 65536);

/**
 * Teto de tokens de saída reservados dentro da janela. Override `NIO_AI_OUTPUT`.
 *
 * 8192, não 2048: o modelo do backend é de **reasoning**, e no vLLM os tokens de
 * raciocínio saem deste mesmo teto. Medido contra o backend em 2026-10-02, numa
 * pergunta técnica real: com 2048 o raciocínio consumiu 2048/2048, `content` voltou
 * VAZIO e `finish_reason: 'length'` — a TUI renderizava tela branca. Com 4096 a
 * resposta vinha truncada; com 8192, `finish_reason: 'stop'` e resposta íntegra.
 */
export const NIO_AI_OUTPUT = envNum('AI_OUTPUT', 8192);

/**
 * Margem sobre a janela real, porque o orçamento do OpenCode é **estimado** e o do
 * vLLM é o tokenizer de verdade. Medido num estouro real: o prompt chegou a 96.257
 * tokens reais enquanto o OpenCode ainda não tinha disparado a compactação prevista
 * para ~90.304 — subestimativa de ao menos 6%. 10% cobre isso com folga.
 */
const CONTEXT_SAFETY_RATIO = 0.1;

/**
 * Converte a janela **real** do modelo na janela **declarada** ao OpenCode.
 *
 * O servidor conta `prompt + max_tokens` contra o `max_model_len`: declarar a janela
 * cheia autoriza um prompt que, somado ao output, estoura por construção — foi
 * exatamente o `96257 + 2048 = 98305` contra um teto de 98304. Some-se a isso a
 * subestimativa do contador e o resultado é a compactação falhando, que é o que
 * mata a sessão (ela reenvia o histórico inteiro pra resumir).
 */
/**
 * O backend aceita imagem? **Medido** contra o vLLM local: sem `attachment: true` na
 * entrada do modelo, o OpenCode descarta a part de imagem e o que chega ao servidor é só
 * texto — o modelo então responde "não aceito imagens" e o usuário culpa o modelo.
 *
 * Com a flag: `image_url` chega e a imagem é descrita corretamente. `NIO_AI_VISION=false`
 * desliga, para quem apontar `NIO_AI_BASE_URL` a um backend texto-only.
 */
export const NIO_AI_VISION = !/^(0|false|no|off)$/i.test((env('AI_VISION') ?? '').trim());

export function declaredContextWindow(context: number, output: number): number {
  if (context <= 0) return context; // 0 = não declarar (usa o catálogo do provider)
  const usable = context - output - Math.ceil(context * CONTEXT_SAFETY_RATIO);
  return Math.max(1, usable);
}

/**
 * Chain-of-thought (reasoning) do modelo nos caminhos headless (`nio exec`/`plan`/
 * `validate-plan`). **Off por padrão**: em tarefa determinística o "pensar" só soma
 * ~2x de latência e pode esvaziar o output (o raciocínio consome o teto antes da
 * resposta). Reabilite com `NIO_AI_THINK=true`.
 *
 * A TUI não passa por aqui (roteia pelo opencode), mas **sofre do mesmo problema** por
 * outra via: o opencode só repassa o teto, e o vLLM serve o reasoning de dentro dele.
 * Lá a defesa é o tamanho de `NIO_AI_OUTPUT`, não este flag.
 */
export const NIO_AI_THINK = /^(1|true|yes|on)$/i.test((env('AI_THINK') ?? '').trim());

// Supressão de thinking na TUI: NÃO é viável via config do opencode (1.18.31).
// Testado (proxy): `provider.options.extraBody` é enviado como campo LITERAL
// `extraBody`, que o vLLM ignora; e `chat_template_kwargs` direto em `options`
// quebra o provider (UnknownError). O reasoning do Qwen é tratado no CLIENTE — a
// Camada B (`tui/components.tsx`) não renderiza reasoning no output (só ao vivo).
// O headless (`qwen-client.ts`) segue desligando via `chat_template_kwargs` no
// corpo (ali o NIO monta a request direto, sem o opencode no meio).

/**
 * Teto de tokens de **input** por prompt (hard cap). Prompts acima disso são
 * recusados antes do `fetch` (ver `qwenComplete`) — com schemas de MCP pesados,
 * o boot do `nio ai` estourava os 65536 da janela mesmo com output baixo.
 * Override `NIO_AI_MAX_INPUT`. `0` desativa a trava.
 */
export const NIO_AI_MAX_INPUT = envNum('AI_MAX_INPUT', 32000);

/**
 * Teto acima do qual o input do usuário é compactado por map-reduce antes de enviar
 * (lossy). Default = `NIO_AI_MAX_INPUT`. `0` desativa o map-reduce. Ver `map-reduce.ts`.
 */
export const NIO_AI_MAPREDUCE_THRESHOLD = envNum('AI_MAPREDUCE_THRESHOLD', NIO_AI_MAX_INPUT);

/**
 * Teto de bytes do arquivo de imagem anexado (~1,5 MB → base64 ~2 MB). Imagem acima
 * disso não é enviada crua (fura a janela do provider) — vira aviso. `0` desativa o
 * guard. Override `NIO_AI_MAX_IMAGE_BYTES`. Ver `tui/attachments.ts`.
 */
export const NIO_AI_MAX_IMAGE_BYTES = envNum('AI_MAX_IMAGE_BYTES', 1_500_000);

/** Dimensão-alvo (px) ao reduzir imagem acima do teto (scaleToFit). Override `NIO_AI_IMAGE_MAX_DIM`. */
export const NIO_AI_IMAGE_MAX_DIM = envNum('AI_IMAGE_MAX_DIM', 1024);

// A janela declarada ao opencode (`limit.context`) é a REAL do provider
// (`NIO_AI_CONTEXT`), não um teto de input rebaixado. Sub-declarar (o antigo
// `min(context, max_input+output)`) fazia o opencode achar a janela menor que o
// prompt real e auto-compactar em loop infinito. O teto de input é assunto
// separado — vive só no fail-fast do headless (`NIO_AI_MAX_INPUT`, qwen-client).

/** Piso da folga de compactação; a folga real é `max(piso, 10% do contexto)`. */
const COMPACTION_FLOOR = 8000;

/** Fração da janela reservada pro resumo → compacta quando falta ~10% pro teto. */
const COMPACTION_RESERVE_RATIO = 0.1;

/**
 * Aviso de config de contexto suspeita: janela declarada pequena demais (≤ output +
 * folga de compactação) faz o opencode achar o contexto sempre cheio e auto-compactar
 * em loop — exatamente o bug que corrigimos. `null` = ok. Puro (params testáveis).
 */
export function contextConfigWarning(
  context = NIO_AI_CONTEXT,
  output = NIO_AI_OUTPUT,
): string | null {
  // Avalia a janela DECLARADA (com margem), que é contra o que o opencode orça.
  const declared = declaredContextWindow(context, output);
  if (context > 0 && declared <= output + COMPACTION_FLOOR) {
    return (
      `NIO_AI_CONTEXT=${context} é pequeno demais (declarado ${declared} ≤ output ${output} + ` +
      `folga ${COMPACTION_FLOOR}): o opencode pode auto-compactar em loop. ` +
      'Ajuste NIO_AI_CONTEXT ao --max-model-len real do vLLM.'
    );
  }
  return null;
}

/**
 * Compaction automática do OpenCode: com a janela apertada (64K num backend local +
 * schemas de MCP pesados), deixa o motor compactar/podar o histórico sozinho,
 * reservando `reserved` tokens pro resumo. Só semeado se ausente (não sobrescreve).
 */
/**
 * Folga (`reserved`) que a auto-compactação deixa antes de estourar: **10% da janela
 * real** (`NIO_AI_CONTEXT`), com piso `COMPACTION_FLOOR`. Assim o opencode começa a
 * compactar quando falta ~10% pro teto, sem rebaixar janelas pequenas abaixo do piso.
 * Nunca ultrapassa o próprio contexto (não recria o loop de auto-compactação).
 */
export function compactionReserved(context = NIO_AI_CONTEXT): number {
  if (context <= 0) return COMPACTION_FLOOR;
  return Math.min(
    context,
    Math.max(COMPACTION_FLOOR, Math.round(context * COMPACTION_RESERVE_RATIO)),
  );
}

/**
 * Aquecer o cache de prefixo do backend na subida da TUI? Medido: a 1ª request custa
 * ~31s (prefill de ~21k tokens num KV cache frio) e a 2ª ~1,6s. O aquecimento paga esse
 * custo enquanto a pessoa ainda digita. `NIO_AI_WARMUP=false` desliga — útil em backend
 * cobrado por request, onde a chamada extra não compensa.
 */
export const NIO_AI_WARMUP = !/^(0|false|no|off)$/i.test((env('AI_WARMUP') ?? '').trim());

/**
 * Teto de saída de tool (`tool_output`). O default do opencode é 2000 linhas / 50 KB —
 * 50 KB é ~12.500 tokens de UMA chamada, num orçamento total de 86.425. O que passa do
 * teto **não se perde**: o opencode grava o texto inteiro em disco e devolve um preview.
 * Por isso apertar aqui é barato — tira do contexto sem tirar do alcance.
 */
export const NIO_AI_TOOL_OUTPUT_BYTES = envNum('AI_TOOL_OUTPUT_BYTES', 20_000);

export const NIO_AI_TOOL_OUTPUT_LINES = envNum('AI_TOOL_OUTPUT_LINES', 800);

/** Bloco `tool_output` do config. `0` em qualquer um desliga aquele teto. */
export function toolOutputLimits(): { max_bytes?: number; max_lines?: number } | undefined {
  const out: { max_bytes?: number; max_lines?: number } = {};
  if (NIO_AI_TOOL_OUTPUT_BYTES > 0) out.max_bytes = NIO_AI_TOOL_OUTPUT_BYTES;
  if (NIO_AI_TOOL_OUTPUT_LINES > 0) out.max_lines = NIO_AI_TOOL_OUTPUT_LINES;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Aprendizado contínuo. O piso de score é **alto de propósito**: medimos no RAG de DAX
 * que pergunta errada pontua 0,955 e paráfrase legítima 0,928 — similaridade não separa
 * caso certo de caso parecido. Lição irrelevante no prompt é pior que lição nenhuma,
 * porque desvia o modelo com ar de autoridade. `NIO_LEARN=false` desliga tudo.
 */
export const NIO_LEARN = !/^(0|false|no|off)$/i.test((env('LEARN') ?? '').trim());

export const NIO_LEARN_MIN_SCORE = envNum('LEARN_MIN_SCORE', 0.82);

export const NIO_LEARN_TOPK = envNum('LEARN_TOPK', 3);
