# ADR 0016 — `src/lib/` é camada transversal, com regra de entrada

- **Data**: 2026-10-05
- **Status**: aceita
- **Contexto**: backlog § 8.1 (`docs/BACKLOG-TECNICO.md`)

## Contexto

O `AGENT.md` descreve a arquitetura como `core/` · `app/` · `adapters/` · `gateway/`,
mas `src/lib/` (~9.200 linhas, 85 arquivos) é o maior diretório e não aparece no
mapa. Ele mistura utilitário puro, lógica de app (`deps/`, `provision/`, `exec/`) e
adapters de fato (`auth/gateway-client.ts`, `skills/skills-cache.ts`).

## Decisão

1. `lib/` é uma **camada transversal declarada**: pode ser importada por qualquer
   camada **exceto `core/`** (que continua sem IO e sem dependência de `lib/`).
2. **Entra em `lib/`**: utilitário sem regra de negócio (`proc`, `colors`, `duration`,
   `secure-file`, `tool-result`) e cliente de infraestrutura compartilhado.
3. **Não entra em `lib/`**: regra de domínio nova → `app/`; acesso a sistema externo
   com port em `core/` → `adapters/`.
4. O que hoje viola (3) — `lib/deps`, `lib/provision`, `lib/exec`,
   `cli/auth/gateway-client`, `lib/skills/skills-cache` — fica **registrado como
   dívida** e migra para `app/` e `adapters/` de forma incremental, a cada vez que o
   arquivo for tocado. Sem migração em massa.
5. Fronteira verificável: `src/architecture.test.ts` falha se `core/` importar
   `lib/` ou `adapters/`, ou se `lib/` importar `adapters/`, `gateway/`, `tools/` ou `cli/`.

## Execução (2026-10-06)

O que só o CLI usava saiu de `lib/` para `cli/`: `cli/support/` (prompts, spinner,
open-url, telemetry, ide-tasks, dotfiles, headroom) e `cli/auth/` (gateway-client,
gateway-process, nio-config, n8n-config, fabric-config). `lib/` ficou com utilitário de
verdade (`proc`, `debug`, `colors`, `load-env`, `shutdown`, `secure-file`, …) e os
subdomínios `clients/ deps/ docker/ exec/ provision/ skills/ worker/ auth/`. Código morto
removido (`cowork-extension`, `duration`). Restam como dívida conhecida: `lib/deps|exec|
provision` (lógica de app) e 4 setas "para cima" documentadas abaixo.

| Seta | Motivo de aceitar por ora |
|---|---|
| `adapters/pg/user-repository` → `gateway/auth/password` | hashing mora no gateway; mover exige levar `secrets` e `config` |
| `lib/clients/nio-oc-config` → `profiles/` e `profiles/mcps` → `lib/docker/config` | ciclo de domínio; resolver junto com `lib/clients` |
| `tui/launch` → `cli/program`, `tui/palette-source` → `cli/commands/docs/content` | a paleta do TUI reaproveita a árvore de comandos |

## Alternativas

- **Realocar tudo agora**: correto, mas toca ~36 arquivos com IO e disputa o mesmo
  código que a Sprint 2 altera. Adiada.
- **Remover a alegação de hexágono**: descarta a disciplina real de `core/`.

## Consequências

- (+) O mapa passa a descrever 100% do código; a regra de entrada para o balde.
- (−) A migração incremental depende de disciplina; o teste de fronteira só cobre
  `core/`.
