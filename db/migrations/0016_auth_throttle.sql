-- 0016 — Estado de rate limiting compartilhado (auditoria N-5).
--
-- O throttle do gateway vivia em `Map` do processo: zerava a cada restart e não
-- valia com mais de uma réplica. Esta tabela guarda os contadores (janela fixa de
-- SMS, falhas de login por nome e por IP). Chave opaca + contador + fim da janela;
-- o `UPSERT` é atômico, então réplicas concorrentes contam juntas.
--
-- Sem dado pessoal além da própria chave (nome tentado / IP) e expira sozinho:
-- o gateway apaga `reset_at <= NOW()` periodicamente.
--
-- Reversão: DROP TABLE IF EXISTS auth_throttle;

CREATE TABLE IF NOT EXISTS auth_throttle (
    key      TEXT PRIMARY KEY,
    count    INTEGER     NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_throttle_reset_at ON auth_throttle(reset_at);

COMMENT ON TABLE auth_throttle IS
    'Contadores de rate limiting do gateway (SMS, falhas de login por nome/IP). Expira por reset_at. Ver N-5.';

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_throttle TO nio_gateway;
