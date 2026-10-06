-- 0017 — Tokens de gateway por cliente (auditoria N-8).
--
-- Antes: UM token compartilhado (`NIO_GATEWAY_TOKEN`) pra toda app/CLI — sem
-- identidade, sem revogação individual (revogar = rotacionar pra todo mundo).
-- Agora: cada cliente tem o seu, guardado só como SHA-256 (o token tem 256 bits
-- aleatórios, então hash rápido basta — não é senha escolhida). O texto do token
-- aparece UMA vez, na criação (`nio-gateway-client create`).
--
-- O token compartilhado segue valendo por compatibilidade
-- (`NIO_GATEWAY_LEGACY_TOKEN=0` desliga).
--
-- Reversão: DROP TABLE IF EXISTS gateway_clients;

CREATE TABLE IF NOT EXISTS gateway_clients (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 64),
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

COMMENT ON TABLE gateway_clients IS
    'Clientes autorizados do gateway (um token cada, só o SHA-256 fica aqui). Revogação individual via revoked_at. Ver N-8.';

GRANT SELECT, INSERT, UPDATE ON gateway_clients TO nio_gateway;
