import type { DocSection } from "./content.js";

/** Seções de arquitetura/segurança/diagnóstico do `nio docs` (continuação de `content.ts`). */
export const SECTIONS_TAIL: DocSection[] = [
  {
    id: "arquitetura",
    title: "Como é construída",
    blurb: "Hexagonal — o núcleo não conhece IO; os adapters implementam os contratos.",
    blocks: [
      {
        kind: "code",
        text: [
          "entrypoints:  src/cli.ts (nio)         src/gateway/index.ts (nio-gateway)",
          "              src/mcp-server.ts (nio-cli)  src/mcp-server-lang.ts (nio-lang)",
          "app:          SessionManager · EnvironmentBuilder · DependencyWatcher · DockerManager",
          "core/:        entidades  +  ports (interfaces, sem IO nenhum)",
          "adapters/:    pg/ (Postgres)  ide/  pkg/ (npm,pip,…)  docker/  sms/  skills/",
          "profiles/:    catálogo dos 6 perfis (fixos no fonte)",
        ].join("\n"),
      },
      {
        kind: "list",
        items: [
          "Runtime: Node 20.12+. Bun roda em dev, mas nada depende de API exclusiva do Bun.",
          "Build: tsc puro → dist/. Sem bundler.",
          "Banco: driver pg + um Pool único. Sem Supabase, sem PostgREST, sem Bun.sql.",
          "Gateway: http.createServer nativo, loopback, atrás do Kong OSS (opcional, rate-limiting). JWT HS256, jti = id da auth_session. Trilha de auth em stderr — nunca a senha nem o OTP em texto puro.",
          'Contrato "nunca lança" nos ports de IO: falha vira { status, error? }.',
        ],
      },
    ],
  },
  {
    id: "2fa",
    title: "2º fator (WhatsApp)",
    blocks: [
      {
        kind: "p",
        text: "Opt-in por conta. Com auth_2 ativo, o `nio login` pede um código de 6 dígitos por WhatsApp; se o WhatsApp não chega, vale um dos 10 códigos de backup (mostrados uma vez no enable-2fa).",
      },
      {
        kind: "code",
        text: [
          "nio security enable-2fa               cadastra o celular, confirma via WhatsApp, mostra os backups",
          "nio security status                   ativo? número (mascarado)? quantos backups restam?",
          "nio security disable-2fa",
          "nio security regenerate-backup-codes",
        ].join("\n"),
      },
      {
        kind: "p",
        text: "O gateway gera/valida o OTP em processo (sem Twilio, sem broker), guarda só o HMAC do código (TTL 5 min, 3 tentativas, uso único) e manda o WhatsApp por um adapter da Meta Graph (template de autenticação). Sem WHATSAPP_ENDPOINT_URL/WHATSAPP_TOKEN, o login com auth_2 responde 503 — o de 1 fator segue normal.",
      },
    ],
  },
  {
    id: "debug",
    title: "Debug da própria CLI",
    blocks: [
      {
        kind: "p",
        text: "`nio debug` roda uma bateria de checagens read-only e mostra ✓ / ⚠ / ✗ com uma dica acionável em cada: nio.json no diretório, login local, conexão Postgres, sessão ativa, OpenCode no PATH, cache de skills.",
      },
      {
        kind: "p",
        text: "`NIO_DEBUG=1` liga log verboso em stderr (`[nio:debug]`): quais `.env` carregaram, config resolvida (URL mascarada, `SELECT 1`), cada request pro gateway (URL + status), e **stack trace completo** nos erros em vez de só a mensagem.",
      },
      { kind: "code", text: "NIO_DEBUG=1 nio login" },
      {
        kind: "p",
        text: "O logo Matrix anima (chuva) em TTY; `NIO_NO_ANIM=1` deixa estático (fora de TTY já é).",
      },
      {
        kind: "list",
        items: [
          '"NIO_DATABASE_URL não definida" → ponha em ~/.nio/config.env, ou rode `nio config setup`.',
          '"Não consegui falar com o nio-gateway" → suba `nio-gateway &`.',
          '"Não autenticado" → `nio register` (1ª vez) e `nio login`.',
          '"2FA não configurado no servidor" (503) → faltam as WHATSAPP_* no ambiente do nio-gateway.',
          '`nio ai` diz "precisa de um terminal interativo" → você está num pipe/CI; rode num terminal de verdade.',
          '`nio ai` travado em "processando" → `Esc` aborta o turno. O motor recupera permissão perdida sozinho em ~4s; se persistir, `NIO_DEBUG=1 nio ai` e veja `~/.nio/tui.log`.',
          'A IDE não abriu o terminal do NIO sozinha → permita "tarefas automáticas", ou rode a task "NIO" (Cmd/Ctrl+Shift+P → Run Task), ou só `nio ai`.',
          "Tools não aparecem no cliente → reinicie o cliente depois do `nio init`; cheque com /mcp.",
        ],
      },
      {
        kind: "p",
        text: "Logs do gateway saem em stderr como JSON estruturado (event: gateway_request / auth_attempt) — nunca com senha ou OTP.",
      },
    ],
  },
];
