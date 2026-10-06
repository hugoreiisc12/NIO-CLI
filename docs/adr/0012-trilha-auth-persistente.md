# ADR 0012 — Trilha de auth persistente (`auth_events`)

- **Data**: 2026-09-07 (decisão) · reconstruído em 2026-10-05
- **Status**: aceita — **retroativa**
- **Contexto**: SP-1 da segunda passada de segurança

> **Nota de proveniência.** O original (e `sp1-trilha-auth.md`) foi perdido; esta
> versão vem do código e da migration `0007`, que citam este ADR.

## Contexto

Eventos de auth saíam só no stderr do gateway: sem histórico consultável, sem
correlação entre tentativas e sem forense depois de rotação de logs.

## Decisão

1. **Tabela append-only `auth_events`** (`event`, `name` tentado, `user_id`, `ip`,
   `trace_id`, `detail JSONB`). `user_id` é `ON DELETE SET NULL`: a trilha
   sobrevive ao usuário apagado. → migration `0007`.
2. **Dupla escrita, best-effort.** `auditAuth()` loga no stderr (tempo real) **e**
   grava na tabela; a falha do INSERT nunca bloqueia a resposta. →
   `src/gateway/index.ts`, `auth-event-repository.ts`.
3. **Só metadados.** Nunca senha, OTP ou token (`logAuthEvent`, `log.ts`).
4. **Correlação por `x-nio-trace-id`**, truncado em 64 chars (TP-6).
5. **Retenção de 180 d** (`NIO_AUTH_EVENTS_RETENTION_DAYS`, piso 1 — TP-5), mais
   longa que a de IP (90 d) por ser forense. Limpeza no boot e 1×/dia.
6. `login_ip_events` (ADR 0011 §F) continua como rollup barato para
   `nio security status`.

## Consequências

- (+) Investigação de brute-force/spray por nome, IP ou usuário.
- (−) Guarda o **nome tentado** (dado pessoal); base legal = segurança, acesso =
  quem tem o banco. Risco aberto (N-9): se o usuário digitar a senha no campo de
  nome, ela é gravada.
- (−) O IP vem de `clientIp()`, forjável atrás de proxy se mal configurado (N-4).

## Referências

ADR 0011, migration `0007`, `docs/security/README.md` (SP-1).
