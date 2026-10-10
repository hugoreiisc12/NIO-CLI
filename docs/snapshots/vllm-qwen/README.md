# Snapshot — motor vLLM / Qwen (2026-10-10)

Registro da configuração do motor de IA **antes** de trocar para Ollama (Nemotron mini).
Nada aqui contém segredo (`apiKey: "local"` é placeholder).

| Arquivo | Conteúdo |
|---|---|
| `vllm-qwen.env` | Todas as variáveis `NIO_AI_*`, `NIO_LEARN_*` e `NIO_FABRIC_RAG_*` com os valores efetivos. |
| `opencode-provider.json` | Bloco `provider.nio-local` + `model` + `compaction` do `~/.config/opencode/opencode.json`. |

## Backend

- Servidor: vLLM interno, `http://192.168.0.140:8001/v1` (OpenAI-compatível, `/chat/completions`).
- Modelo: `RedHatAI/Qwen3.8-27B-INT4` (id exato servido; reasoning; aceita imagem).
- `max_model_len` documentado nos testes: **98304** (estouro real: prompt 96257 + output 2048 = 98305). A TUI declara 65536 → 50790 utilizáveis após saída e margem de 10%.
- Flags de subida do vLLM (`--max-model-len`, `--reasoning-parser`, etc.) **não estão no repositório** e o servidor estava inalcançável ao gerar este snapshot — copie-as do host do vLLM (`ps`/compose/systemd) se quiser o registro completo.

## Como o código usa o vLLM (pontos que mudam com o Ollama)

| Ponto | Onde | Observação para Ollama |
|---|---|---|
| Provider `nio-local` (`@ai-sdk/openai-compatible`) | `src/lib/clients/client-opencode-plan.ts` | Ollama expõe `http://<host>:11434/v1`; basta `NIO_AI_BASE_URL` + `NIO_AI_MODEL`. |
| `chat_template_kwargs {enable_thinking:false}` | `src/lib/exec/qwen-client.ts` | Campo específico do vLLM/Qwen; Ollama o ignora (ou usa `think` próprio). |
| `max_tokens`/`temperature 0.2`, timeout 120 s | `qwen-client.ts` | Idem. |
| Janela declarada e compactação (`reserved 8000`) | `client-env.ts` | Ajustar `NIO_AI_CONTEXT` à janela real do Nemotron mini (`num_ctx` no Ollama, default baixo). |
| Visão (`attachment`) | `client-env.ts` | Nemotron mini é, a princípio, texto-only (confirmar no modelo escolhido): use `NIO_AI_VISION=false`. |
| `NIO_AI_OUTPUT=8192` | `client-env.ts` | Foi calibrado para reasoning do Qwen; revisar. |
| Limiares do RAG/aprendizado | `client-env.ts` | Dependem dos embeddings locais (e5), não do LLM — não mudam. |
| Warmup de prefixo | `src/tui/warmup.ts` | Útil ao prefix-cache do vLLM; no Ollama, avaliar `NIO_AI_WARMUP=false`. |

## Restaurar

1. Copie as linhas de `vllm-qwen.env` para `~/.nio/config.env` (comentando as do Ollama).
2. `nio sync` (ou `nio init`) regrava o provider `nio-local` em `~/.config/opencode/opencode.json`; o conteúdo esperado está em `opencode-provider.json`.
