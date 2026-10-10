import { spawnSync } from "node:child_process";
import { brand } from "../../brand.js";
import { c, sym } from "../../lib/colors.js";
import { infraComposePath } from "../../lib/docker/config.js";
import { dockerAvailable, unreachableDocker } from "../../lib/docker/health.js";
import { isBinaryInstalled } from "../../lib/clients/client-install.js";
import { loadSession } from "../../lib/auth/cli-session-store.js";
import { SessionManager } from "../../app/session-manager.js";
import type { DockerResult } from "../../core/docker.js";
import type { Session } from "../../core/types.js";

/** `docker` está utilizável? Senão, erro acionável + exit 1. */
export function requireDocker(): void {
  if (!dockerAvailable()) {
    console.error(`${c.red(sym.err)} ${unreachableDocker().message}`);
    process.exit(1);
  }
}

/** Sessão ativa do usuário logado, ou encerra (padrão do `nio deps`). */
export async function requireActiveSession(): Promise<Session> {
  const stored = await loadSession();
  if (!stored) {
    console.error(`${c.yellow(sym.warn)} Não autenticado. Rode ${c.cyan(`${brand.name} login`)}.`);
    process.exit(1);
  }
  let session: Session | null;
  try {
    session = await new SessionManager().findActive(stored.userId);
  } catch (err) {
    console.error(`${c.red(sym.err)} Falha no banco: ${(err as Error).message}`);
    process.exit(1);
    throw err;
  }
  if (!session) {
    console.error(
      `${c.yellow(sym.warn)} Nenhuma sessão ativa. Rode ${c.cyan(`${brand.name} init`)} ou ` +
        `${c.cyan(`${brand.name} sessions activate <id>`)}.`,
    );
    process.exit(1);
  }
  return session;
}

/** O operador (`opencode`) está no PATH? Senão, orienta + exit 1. */
export function requireOperator(): void {
  if (!isBinaryInstalled("opencode")) {
    console.error(
      `${c.yellow(sym.warn)} OpenCode não encontrado no PATH — \`nio docker debug/orquest/cluster\` ` +
        `dependem dele. Instale com \`npm i -g opencode-ai\`.`,
    );
    process.exit(1);
  }
}

/** `docker compose -f <infra> …` herdando o terminal. Retorna o exit code. */
export function infraCompose(args: string[]): number {
  const res = spawnSync("docker", ["compose", "-f", infraComposePath(), ...args], {
    stdio: "inherit",
  });
  return res.status ?? 1;
}

// ─── headroom ────────────────────────────────────────────────────────

/** Reporta um `DockerResult` e sai 1 se falhou. `ok` já streamou/imprimiu. */
export function reportResult(res: DockerResult, whatFailed: string): void {
  if (res.status === "unavailable") {
    console.error(`${c.red(sym.err)} ${res.error}`);
    process.exit(1);
  }
  if (res.status === "failed") {
    console.error(`${c.red(sym.err)} ${whatFailed}: ${res.error}`);
    process.exit(1);
  }
  if (res.stdout) console.log(res.stdout);
}
