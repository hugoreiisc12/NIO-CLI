# Publicando no npm

Este projeto é publicado como pacote scoped `@nio-cli/cli` no npm público. O CI cuida do publish automático em push de tag `v*`.

## Setup inicial (uma vez)

### 1. Organização `nio-cli` no npm — ✅ já criada

Confirmado em 2026-07-27 (`npmjs.com/settings/nio-cli/packages`, 0 pacotes
publicados ainda). O scope real é `@nio-cli` — **não** `@nio` (o npm sempre
normaliza o nome da org pra minúsculo; "Nio-cli" virou `nio-cli`). O
`package.json` já reflete isso (`"name": "@nio-cli/cli"`).

### 2. Gerar token de automação no npm

Token tipo **Automation** (não expira, ignora 2FA — apropriado pra CI):

```
https://www.npmjs.com/settings/<seu-usuário>/tokens
→ Generate New Token → tipo Automation
```

Guarde o valor — só é mostrado uma vez.

### 3. Adicionar o token como secret no GitHub

No repo `hugoreiisc12/NIO-CLI`:

```
Settings → Secrets and variables → Actions → New repository secret
Name: NPM_TOKEN
Value: <token gerado no passo 2>
```

### 4. Primeiro publish manual (recomendado)

Antes de confiar no CI, faça um publish controlado pra confirmar que tudo tá certo:

```bash
npm login                                  # auth interativo
npm publish --dry-run --access public      # confere o que vai ser enviado
npm publish --access public                # publish real
```

O `--dry-run` mostra a lista de arquivos. Deve ser só:
- `dist/` (todo o build)
- `package.json`
- `README.md`

## Publishes seguintes (via tag)

O workflow `.github/workflows/publish.yml` dispara em push de tag `v*`. Fluxo:

```bash
npm version patch -m "release v%s"   # bump + commit + tag (use minor/major se for o caso)
git push --follow-tags               # envia commit + tag → CI publica
```

`npm version` cria a tag local no formato `vX.Y.Z`. O `--follow-tags` garante que ela vai junto.

## Setup do repositório (uma vez, em `hugoreiisc12/NIO-CLI`)

Nada disto vem no git — é configuração do GitHub. Sem isso a esteira não fecha o ciclo.

**Secrets** (Settings → Secrets and variables → Actions):

| Secret | Para quê |
|---|---|
| `NPM_TOKEN` | `publish.yml` (token **Automation** do npm) |

`GITHUB_TOKEN` já existe e basta para o GHCR e para o commit de bump do `image.yml`.

**Branch protection em `main`** (Settings → Branches → Add rule):

- Require a pull request + **Require review from Code Owners** (usa `.github/CODEOWNERS`)
- Require status checks: **`secrets`**, **`test`** (CI) e **`analyze`** (CodeQL)
- Require branches to be up to date; bloquear force-push e deleção
- ⚠️ O `image.yml` faz `git push origin main` (bump do compose de deploy). Com a regra acima
  ele é barrado: permita o `github-actions[bot]` em "Allow specified actors to bypass", ou
  troque o push direto por um PR automático.

**Pacotes e segurança** (Settings):

- Code security → habilite **Dependabot alerts/security updates**, **Secret scanning** com
  push protection, **Code scanning** (CodeQL) e **Private vulnerability reporting**
- Packages → o pacote `nio-gateway` nasce **privado** no primeiro push; torne-o público
  (Package settings → Change visibility) ou o Portainer não consegue puxar a imagem sem login
- Actions → General → *Workflow permissions*: **Read and write** (o bump precisa escrever)

**Portainer (GitOps):** repointe o stack para `https://github.com/hugoreiisc12/NIO-CLI.git`,
branch `main`, arquivo `docker/docker-compose.deploy.yml`, e confirme as variáveis do stack
(`NIO_DATABASE_URL`, `JWT_SECRET`, `NIO_GATEWAY_TOKEN`, `OTP_HMAC_SECRET`, …).

**Primeira release:** o `docker-compose.deploy.yml` aponta para `ghcr.io/hugoreiisc12/nio-gateway:v0.18.3`,
tag que **ainda não existe** nesse dono. Não redeploye o stack antes da primeira tag nova
(`v0.19.0` sugerida: há migrations `0016`/`0017` e o opt-in `NIO_ALLOW_ECHO`) publicar a imagem.
Rode as migrations em produção **antes** de subir a imagem nova.

## Esteira (resumo)

| Workflow | Quando | O que faz |
|---|---|---|
| `ci.yml` | PR, push em `main`, e como gate das releases | scan de segredos → `bun audit` → tipos → formatação → build → schema + migrations em Postgres efêmero → testes (com integração) |
| `codeql.yml` | PR, `main`, segunda-feira | análise estática de segurança (JS/TS) |
| `publish.yml` | tag `v*` | gate (CI) → confere tag × `package.json` → publica `@nio-cli/cli` no npm |
| `image.yml` | tag `v*` | gate (CI) → build/push da imagem do gateway no GHCR → bump do compose de deploy |
| Dependabot | semanal | PRs de dependência (bun, actions, docker), agrupando minor/patch |

## Trigger manual

Se precisar republicar sem novo commit (ex: falha de rede no primeiro try):

```
Actions → Publish to npm → Run workflow
```

## Provenance

O workflow **ainda não** publica com `--provenance`. Se o repositório for público, dá pra ligar: `permissions: id-token: write` no job `publish` e `npm publish --access public --provenance`. Assina o pacote via sigstore e mostra o selo "Provenance" no npm.

## Versionamento

Versão `0.x` enquanto não há garantia de estabilidade de contrato — hoje já existem testes
automatizados (suíte cobrindo `src/`, gate obrigatório em `ci.yml` antes de publish/build de
imagem). Subir pra `1.0.0` quando:

- A schema do `nio.json` estiver congelada
- A lista de tools MCP for considerada estável (renomes/remoções viram breaking change)
