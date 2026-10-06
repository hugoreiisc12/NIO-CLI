# ADR 0011 — Endurecimento criptográfico da autenticação

- **Data**: 2026-09-07 (decisão) · reconstruído em 2026-10-05
- **Status**: aceita — **retroativa**
- **Contexto**: Lote 5 da auditoria de segurança (`docs/security/README.md`)

> **Nota de proveniência.** O texto original deste ADR e o doc de trabalho
> `lote5-cripto-arquitetura.md` foram perdidos (nunca entraram no histórico deste
> repositório). Este documento foi reconstruído a partir do código e das migrations
> 0005–0007, que citam "ADR 0011 §A–§F". Cada decisão aponta o arquivo que a
> implementa; onde o raciocínio original não é recuperável, está dito.

## Contexto

O login v2 (senha + argon2id + Postgres) estava de pé, mas a auditoria apontou:
hash de senha sem segredo adicional (um dump do banco bastava para ataque offline),
um único `JWT_SECRET` com três papéis (assinar JWT, assinar OTP, e era o único
segredo de auth), sem rotação, e sem registro de onde o usuário logava.

## Decisão

**§A — Pepper de senha via `secret` do argon2.** `NIO_PEPPERS` é um CSV
`id:segredo` (o maior id é o atual; `NIO_PEPPER` singular vira `1:<valor>`). Cada
segredo tem ≥ 32 chars. O id usado fica em `user_cli.password_pepper_id` (e
`backup_pepper_id`), `0` = sem pepper. Perder o pepper = reset forçado de senha.
→ `src/gateway/auth/secrets.ts`, `password.ts`, migration `0005`.

**§B — Re-hash no login.** `needsRehash()` devolve `true` se o pepper está
desatualizado ou se `m/t/p` do PHC diferem dos parâmetros em vigor. Migração
transparente, sem fluxo de reset. → `password.ts`.

**§C — Parâmetros do argon2id.** Default = piso OWASP (19 MiB, t=2, p=1),
ajustável por `NIO_ARGON2_MEMORY_MIB|TIME|PARALLELISM`; `scripts/dev/argon2-calibrate.mjs`
mede no host. → `password.ts`.

**§D — Chave do OTP separada do JWT.** `OTP_HMAC_SECRET` assina o HMAC-SHA256 do
código de 6 dígitos; **fallback para `JWT_SECRET`** por compatibilidade. O código
puro nunca é persistido (ANPD); a comparação é em tempo constante. →
`otp.ts`, `secrets.ts#otpHmacSecret`.

**§E — Rotação do JWT por `kid`.** `JWT_SECRETS` = CSV `kid:segredo`; a última
entrada assina e qualquer uma verifica. Token sem `kid` (legado) verifica contra
`JWT_SECRET`. Algoritmo travado em HS256, `iss=nio-gateway`, `aud=nio-cli`; o
`jti` é a `auth_session` e é revogável. → `secrets.ts`, `middleware/auth.ts`,
`config.ts`.

**§F — Auditoria de IP de login, sem enforcement.** `login_ip_events` guarda IP,
primeira/última vez e contagem; retenção 90 d (LGPD, base legal: segurança).
`user_cli.ips_using` fica reservada para allowlist futuro. → migration `0006`,
`login-ip-repository.ts`.

## Consequências

- (+) Dump do banco sem o pepper não permite ataque offline às senhas.
- (+) Rotação de JWT e de pepper sem downtime.
- (−) O pepper vira segredo crítico com backup obrigatório.
- (−) **Dívida conhecida** (acompanhada na Sprint 1): o `fallback` do §D amarra a
  rotação do OTP à do JWT (QP-5), e o `JWT_SECRET` legado nunca é aposentado nem
  revalidado quando `JWT_SECRETS` está ativo (QP-4 / N-7).

## Referências

`docs/security/README.md`, `docs/security/fourth-pass.md` (QP-4, QP-5),
ADR 0012, migrations `0005`, `0006`.
