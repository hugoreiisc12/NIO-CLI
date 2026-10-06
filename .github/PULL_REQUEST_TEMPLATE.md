## O quê e por quê

<!-- Uma ou duas frases. Link pra issue/backlog (ex.: BACKLOG-TECNICO §2.2) se houver. -->

## Como foi verificado

- [ ] `bunx tsc --noEmit`
- [ ] `bun test` (e, se mexeu em banco/auth: integração com `NIO_TEST_DB_OK=1`)
- [ ] `bunx biome format .`
- [ ] `bun audit --audit-level=high`

## Checklist

- [ ] Comportamento novo ou bug corrigido tem teste (contrato, não implementação)
- [ ] Mudança de schema → `db/migrations/NNNN_*.sql` **e** `db/schema.sql` atualizados
- [ ] Decisão de arquitetura → ADR em `docs/adr/`
- [ ] Sem segredo, `.env` ou dado pessoal no diff (`bash scripts/ci/scan-secrets.sh`)
- [ ] Respeita as camadas (`src/architecture.test.ts` verde)

## Impacto em produção

<!-- Migration a rodar? Variável de ambiente nova? Quebra de compatibilidade? Ou "nenhum". -->
