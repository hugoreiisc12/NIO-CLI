import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { brand } from "../../brand.js";
import { c, sym, section } from "../../lib/colors.js";
import { input, confirm } from "../../lib/prompts.js";
import { createDockerGateway } from "../../adapters/docker/docker-gateway.js";
import { buildDebugPrompt, collectDebugContext, runOperator } from "../../app/docker-manager.js";
import type { ComposeAction, RunSpec } from "../../core/docker.js";
import { reportResult, requireDocker, requireOperator } from "./docker-shared.js";

export * from "./docker-cluster.js";

export const COMPOSE_ACTIONS: readonly ComposeAction[] = ["up", "down", "restart", "ps", "logs"];

export async function runCompose(
  action: string,
  service: string | undefined,
  opts: { file?: string; detach?: boolean; build?: boolean; tail?: string },
): Promise<void> {
  requireDocker();
  if (!COMPOSE_ACTIONS.includes(action as ComposeAction)) {
    console.error(
      `${c.red(sym.err)} ação inválida "${action}" — use: ${COMPOSE_ACTIONS.join(" | ")}`,
    );
    process.exit(1);
  }
  const file = opts.file ? resolve(opts.file) : undefined;
  if (file && !existsSync(file)) {
    console.error(`${c.red(sym.err)} compose file não encontrado: ${file}`);
    process.exit(1);
  }
  section("docker compose", `${action}${service ? ` ${service}` : ""}${file ? ` (${file})` : ""}`);
  const res = await createDockerGateway().compose(action as ComposeAction, {
    file,
    detach: opts.detach,
    build: opts.build,
    service,
    tail: opts.tail ? Number(opts.tail) : undefined,
  });
  reportResult(res, `docker compose ${action}`);
}

// ─── create ──────────────────────────────────────────────────────────

/** `"a,b, c"` → `["a","b","c"]` (vazio → `[]`). */
function splitList(v?: string): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runCreate(opts: {
  image?: string;
  name?: string;
  port?: string;
  env?: string;
  volume?: string;
  detach?: boolean;
  yes?: boolean;
}): Promise<void> {
  requireDocker();
  section("docker create", "novo container");

  const image =
    opts.image?.trim() ||
    (
      await input({
        message: "Imagem (ex.: redis:7, node:20)",
        validate: (v) => v.trim().length > 0 || "obrigatório",
      })
    ).trim();

  const interactive = !opts.image && process.stdout.isTTY;
  const name =
    opts.name?.trim() ||
    (interactive
      ? (await input({ message: "Nome do container (opcional)", default: "" })).trim()
      : "");
  const ports = opts.port
    ? splitList(opts.port)
    : interactive
      ? splitList(
          await input({
            message: "Portas host:container, separadas por vírgula (opcional)",
            default: "",
          }),
        )
      : [];
  const env = Object.fromEntries(
    (opts.env
      ? splitList(opts.env)
      : interactive
        ? splitList(
            await input({
              message: "Env KEY=VALUE, separadas por vírgula (opcional)",
              default: "",
            }),
          )
        : []
    )
      .map((pair) => pair.split("="))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k!.trim(), v!.trim()]),
  );
  const volumes = opts.volume
    ? splitList(opts.volume)
    : interactive
      ? splitList(
          await input({
            message: "Volumes host:container, separados por vírgula (opcional)",
            default: "",
          }),
        )
      : [];

  const spec: RunSpec = {
    image,
    name: name || undefined,
    ports: ports.length ? ports : undefined,
    env: Object.keys(env).length ? env : undefined,
    volumes: volumes.length ? volumes : undefined,
    detach: opts.detach ?? true,
  };

  console.log(
    `  ${c.dim(`docker run ${spec.detach ? "-d " : ""}${name ? `--name ${name} ` : ""}${image}`)}`,
  );
  const ok =
    opts.yes === true ||
    (interactive && (await confirm({ message: "Criar e subir o container?", default: true })));
  if (!ok) {
    console.log(
      c.dim(interactive ? "cancelado." : "sem TTY — passe `-y` pra criar sem confirmação."),
    );
    return;
  }

  reportResult(await createDockerGateway().run(spec), "docker run");
}

// ─── debug (operador) ────────────────────────────────────────────────

export async function runDebug(
  container: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  requireDocker();
  const gateway = createDockerGateway();

  if (!container) {
    // sem alvo → lista os containers pra o usuário escolher
    section("docker debug", "nenhum container informado — containers do host:");
    reportResult(await gateway.ps(true), "docker ps");
    console.log(c.dim(`\n  rode \`${brand.name} docker debug <nome|id>\``));
    return;
  }

  if (!opts.json) requireOperator();
  const ctx = await collectDebugContext(gateway, container);

  if (opts.json) {
    console.log(JSON.stringify(ctx, null, 2));
    return;
  }

  section("docker debug", `${container} — entregando pro operador`);
  const code = await runOperator(buildDebugPrompt(ctx));
  if (code !== 0) process.exitCode = code;
}

// ─── orquest (operador) ──────────────────────────────────────────────
