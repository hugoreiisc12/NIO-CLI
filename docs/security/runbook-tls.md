# Runbook — ligar TLS verificado (Postgres e Kong)

> Fecha o backlog §4.1 (Kong sem TLS) e §6.4 / §4.2 (Postgres sem verificação). **O código e o
> overlay estão prontos; a execução é em produção** e a ORDEM abaixo importa — o overlay falha
> fechado (sem fallback inseguro), então subir fora de ordem derruba o login.

## O que existe
| Peça | Onde |
|---|---|
| CA interna + certs (`init`, `server`, `kong`) | `scripts/db-tls-setup.sh` (`bun run db:tls`) |
| Cliente Postgres verificado | `NIO_DATABASE_SSL=true` + `NIO_DATABASE_CA` (`src/adapters/pg/client-tls.ts`) |
| Cliente → Kong verificado | `NIO_GATEWAY_URL=https://…` + `NIO_GATEWAY_CA` (`src/lib/auth/gateway-fetch.ts`, testado com TLS real) |
| Overlay do deploy | `docker/docker-compose.deploy.tls.yml` |

Uma CA só assina os dois certs; o cliente confia no mesmo `ca.crt` para banco e Kong.

## Ordem
1. **Gerar a CA e os certs** (numa máquina de confiança, não no servidor):
   ```bash
   bash scripts/db-tls-setup.sh init
   bash scripts/db-tls-setup.sh server 192.168.0.142            # IP/nome EXATOS do NIO_DATABASE_URL
   bash scripts/db-tls-setup.sh kong <ip-ou-nome-do-kong> [outros nomes]
   ```
   `db-tls/ca.key` é segredo (cofre do time, offline). `db-tls/` já está no `.gitignore`.
2. **Postgres (.142)**: instalar `server.crt/key`, `ssl = on`, e **primeiro** uma linha `hostssl` ao lado
   da `host` existente (não troque ainda), `pg_reload_conf()`. Valide de um cliente:
   `NIO_DATABASE_SSL=true NIO_DATABASE_CA=/…/ca.crt bun run db:ping`.
3. **Stack no Portainer** — variáveis: `NIO_DATABASE_CA_PEM` (conteúdo do `ca.crt`, público),
   `NIO_KONG_TLS_CERT` (`kong.crt`), `NIO_KONG_TLS_KEY` (`kong.key`, segredo). Adicione
   `docker/docker-compose.deploy.tls.yml` aos "Additional paths" e redeploye.
   Confira: `docker logs nio-gateway` sem erro de TLS e `curl --cacert ca.crt https://<kong>:<porta>/health`.
4. **Clientes** (cada máquina com a CLI): `NIO_GATEWAY_URL=https://<kong>:<porta>` e
   `NIO_GATEWAY_CA=/…/ca.crt` (em `~/.nio/config.env`). O host da URL tem de estar no SAN do `kong.crt`.
5. **Fechar**: trocar a `host` por `hostssl` no `pg_hba.conf` (só TLS), e tirar `NIO_DATABASE_SSL_INSECURE`
   de qualquer `config.env` que ainda o tenha.

## Rollback
- Gateway não conecta ao banco: remover o overlay do stack e redeployar (volta ao `NIO_DATABASE_SSL=false`);
  no Postgres, restaurar a linha `host` no `pg_hba.conf`.
- Clientes sem acesso ao Kong: `NIO_GATEWAY_URL` volta para `http://…` só depois de remover o overlay.

## Renovação
Os certs de servidor duram 825 dias (`SRV_DAYS`). Reemita com o mesmo script e o mesmo `ca.crt` — os
clientes não precisam mudar. Trocar a **CA** exige redistribuir o `ca.crt` a todos.

## Não verificado
O overlay foi validado só com `docker compose config` (sintaxe e interpolação). O Kong com o cert real
não foi subido (sem daemon Docker nesta máquina): faça o `curl --cacert` do passo 3 antes de avisar o time.
