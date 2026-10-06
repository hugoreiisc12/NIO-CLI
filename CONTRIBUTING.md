# Contribuindo com o NIO-CLI

Obrigado por querer ajudar. Este guia diz como rodar o projeto, o que esperamos de uma
mudança e como ela chega em produção. Em caso de dúvida, abra uma issue antes de codar.

## Pré-requisitos

- **Node.js 20.12+** (alvo de runtime) e **Bun** (gerenciador, testes e scripts)
- **PostgreSQL 16** com a extensão `pgvector` (só para testes de integração)
- Docker é opcional — só para validar a imagem do gateway

```bash
git clone https://github.com/hugoreiisc12/NIO-CLI.git
cd NIO-CLI
bun install --frozen-lockfile
cp .env.example .env        # preencha NIO_DATABASE_URL e JWT_SECRET (≥ 32 chars)
```

## O ciclo de trabalho

```bash
bunx tsc --noEmit            # tipos
bun test                     # suíte (sem banco: integração é pulada)
bunx biome format .          # formatação (gate do CI) — `--write` pra corrigir
bun audit --audit-level=high # dependências (gate do CI)
bun run build                # compila para dist/
```

O CI roda exatamente isso, mais o scan de segredos e o CodeQL. **PR só entra com tudo verde.**

### Testes de integração (Postgres real)

Os `*.integration.test.ts` só rodam com opt-in explícito, para nunca tocarem um banco
compartilhado por acidente:

```bash
NIO_TEST_DB_OK=1 NIO_DATABASE_URL=postgres://postgres@127.0.0.1:55432/nio_test \
JWT_SECRET=<32+ chars> NIO_HIBP_DISABLE=1 bun test
```

Use sempre um banco **descartável** (`initdb` numa pasta temporária, ou
`docker/docker-compose.test.yml`) e aplique `db/schema.sql`. **Nunca** aponte para o banco
da equipe ou de produção.

## Arquitetura e regras de código

O projeto é hexagonal; leia `AGENT.md` e os ADRs em `docs/adr/` antes de uma mudança
estrutural.

- `core/` é puro (sem IO e sem importar `lib/` ou `adapters/`); `adapters/` não importam `app/`;
  `lib/` é base e não importa camadas de cima. **`src/architecture.test.ts` falha** se você violar.
- Acesso a sessão passa pelo `SessionManager`; acesso a task, pelo `TaskManager`.
- Uma decisão de arquitetura nova ou que reverte uma antiga vira um **ADR** (`docs/adr/NNNN-*.md`).

As regras de estilo estão em `docs/_rules/nio.md`. As que mais pesam em revisão:

- Arquivo ≤ **300 linhas**; função ≤ **30 linhas** e um só nível de abstração
- Comentário de **uma linha** (se precisa de parágrafo, o código não está claro)
- Early-return em vez de `if/else` aninhado; sem número ou string mágica
- **DRY** (procure o que já existe antes de escrever) e **YAGNI** (nada "pro futuro")
- Sem `any`; erros tratados ou propagados, nunca engolidos
- Código em inglês; texto de produto em português

## Banco de dados

- Toda mudança de schema tem **duas** partes: `db/migrations/NNNN_descricao.sql` (idempotente,
  com a reversão comentada) e a mesma alteração em `db/schema.sql`.
- Tabela nova precisa de `GRANT` explícito ao role certo (`nio_cli` ou `nio_gateway`) —
  o princípio é o menor privilégio.
- Queries sempre parametrizadas; listagens sempre limitadas; escrita multi-passo, em transação.
- Migration que muda dado em produção entra na descrição do PR (seção "Impacto em produção").

## Segurança

- **Nunca** commite segredo, `.env`, token ou dado pessoal. O hook `pre-commit` e o job
  `secrets` do CI rodam `scripts/ci/scan-secrets.sh`.
- Mudou autenticação, criptografia, gateway ou rate limiting? Peça revisão explícita e
  traga **teste de concorrência** quando houver estado compartilhado.
- Vulnerabilidade: **não** abra issue pública — veja `.github/SECURITY.md`.

## Commits e Pull Requests

- Branch a partir de `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- **Conventional Commits**: `tipo(escopo): resumo` — título em inglês, até 80 caracteres;
  corpo em português, linhas até 120. Tipos: `feat`, `fix`, `docs`, `refactor`, `test`,
  `chore`, `perf`, `ci`.
- Separe commits por assunto (docs, refactor mecânico, comportamento). Refactor de mover
  arquivos vai **isolado**, sem mudança de comportamento, para o `git blame` continuar útil.
- Preencha o template do PR. PRs pequenos e focados são revisados mais rápido.

## Releases

Só quem mantém o repositório publica. Resumo (detalhes em `PUBLISHING.md`):

1. Bump de versão em `package.json` **no mesmo commit** da tag (`npm version <patch|minor|major>`).
2. `git push --follow-tags` — a tag `vX.Y.Z` dispara, depois do CI, a publicação no npm
   (`publish.yml`) e a imagem do gateway no GHCR (`image.yml`).
3. Mudança incompatível ou migration nova pede **versão menor** no mínimo e nota no PR.

## Licença

O projeto é **proprietário** ([`LICENSE`](LICENSE)). Ao enviar uma contribuição você concede
ao titular uma licença perpétua e irrevogável para usá-la e distribuí-la como parte do
Software (cláusula 3), e declara ter o direito de fazê-lo. Não envie código que não seja seu
ou que venha de fonte com licença incompatível.
