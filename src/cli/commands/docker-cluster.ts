import { brand } from "../../brand.js";
import { c, sym, section, link } from "../../lib/colors.js";
import { input } from "../../lib/prompts.js";
import { CLUSTER_STACK, PORTAINER_URL } from "../../lib/docker/config.js";
import { portainerHealthy } from "../../lib/docker/health.js";
import { openUrl } from "../../lib/open-url.js";
import { SessionManager } from "../../app/session-manager.js";
import { createDockerGateway } from "../../adapters/docker/docker-gateway.js";
import {
  buildClusterPrompt,
  buildOrquestPrompt,
  parseScaleArg,
  parseStackServices,
  persistClusterState,
  readClusterState,
  runOperator,
} from "../../app/docker-manager.js";
import type { ClusterAction } from "../../core/docker.js";
import {
  reportResult,
  requireActiveSession,
  requireDocker,
  requireOperator,
} from "./docker-shared.js";

export async function runOrquest(
  instruction: string | undefined,
  opts: { dryRun?: boolean },
): Promise<void> {
  requireDocker();
  requireOperator();
  const session = await requireActiveSession();

  const task =
    instruction?.trim() ||
    (
      await input({
        message: "O que orquestrar? (linguagem natural)",
        validate: (v) => v.trim().length > 0 || "descreva a tarefa",
      })
    ).trim();

  section("docker orquest", opts.dryRun ? `${task} (dry-run)` : task);
  const code = await runOperator(
    buildOrquestPrompt(task, session.projectPath, Boolean(opts.dryRun)),
    { cwd: session.projectPath },
  );
  if (code !== 0) process.exitCode = code;
}

// ─── cluster (Swarm) ─────────────────────────────────────────────────

export const CLUSTER_ACTIONS: readonly ClusterAction[] = ["up", "down", "status", "scale"];

export async function runCluster(
  action: string,
  arg: string | undefined,
  _opts: { dryRun?: boolean },
): Promise<void> {
  requireDocker();
  if (!CLUSTER_ACTIONS.includes(action as ClusterAction)) {
    console.error(
      `${c.red(sym.err)} ação inválida "${action}" — use: ${CLUSTER_ACTIONS.join(" | ")}`,
    );
    process.exit(1);
  }
  const session = await requireActiveSession();
  const gateway = createDockerGateway();
  const repo = new SessionManager();

  if (action === "status") {
    section("docker cluster", `stack ${CLUSTER_STACK}`);
    const live = await gateway.stackServices(CLUSTER_STACK);
    if (live.status !== "ok") {
      console.log(c.dim("  stack não encontrada (nunca deployada, ou Swarm inativo)."));
    } else {
      for (const s of parseStackServices(live.stdout ?? "")) {
        console.log(`  ${c.green(sym.dot)} ${s.name}  ${c.dim(s.replicas)}`);
      }
    }
    const persisted = readClusterState(session);
    if (persisted) {
      console.log(
        c.dim(
          `\n  persistido: ${persisted.services.length} serviço(s), deploy ${persisted.deployedAt}`,
        ),
      );
    }
    return;
  }

  if (action === "down") {
    section("docker cluster", `removendo stack ${CLUSTER_STACK}`);
    reportResult(await gateway.stackRm(CLUSTER_STACK), "docker stack rm");
    await persistClusterState(repo, session, null).catch(() => {});
    console.log(`  ${c.green(sym.ok)} estado limpo em ${brand.projectConfigFile} (sessão)`);
    return;
  }

  if (action === "scale") {
    const parsed = arg ? parseScaleArg(arg) : null;
    if (!parsed) {
      console.error(`${c.red(sym.err)} use \`${brand.name} docker cluster scale <servico>=<n>\``);
      process.exit(1);
    }
    section("docker cluster", `scale ${parsed.service}=${parsed.replicas}`);
    reportResult(
      await gateway.serviceScale(`${CLUSTER_STACK}_${parsed.service}`, parsed.replicas),
      "docker service scale",
    );
    return;
  }

  // action === "up"
  requireOperator();
  const instruction =
    arg?.trim() ||
    (
      await input({
        message: "O que subir no cluster? (ex.: api + worker + redis + postgres)",
        validate: (v) => v.trim().length > 0 || "descreva os serviços",
      })
    ).trim();

  section("docker cluster", `up — ${instruction}`);
  const init = await gateway.swarmInit();
  if (init.status === "failed") {
    console.error(`${c.red(sym.err)} docker swarm init: ${init.error}`);
    process.exit(1);
  }

  const code = await runOperator(buildClusterPrompt(instruction, session.projectPath), {
    cwd: session.projectPath,
  });
  if (code !== 0) {
    console.warn(
      `${c.yellow(sym.warn)} operador saiu com código ${code} — validando o estado real...`,
    );
  }

  // Validação: pergunta ao Docker (não confia na saída do operador) e persiste.
  const live = await gateway.stackServices(CLUSTER_STACK);
  const services =
    live.status === "ok" ? parseStackServices(live.stdout ?? "").map((s) => s.name) : [];
  if (services.length === 0) {
    console.error(
      `${c.red(sym.err)} nenhum serviço na stack ${CLUSTER_STACK} — o deploy não completou.`,
    );
    process.exit(1);
  }
  await persistClusterState(repo, session, {
    stack: CLUSTER_STACK,
    services,
    composePath: "(gerado pelo operador)",
    deployedAt: new Date().toISOString(),
  }).catch((err) =>
    console.warn(`${c.yellow(sym.warn)} não persisti o estado: ${(err as Error).message}`),
  );

  console.log(
    `\n  ${c.green(sym.ok)} stack ${CLUSTER_STACK} — ${services.length} serviço(s): ${services.join(", ")}`,
  );
}

// ─── portainer ───────────────────────────────────────────────────────

export async function runPortainer(opts: { url?: boolean }): Promise<void> {
  if (opts.url) {
    console.log(PORTAINER_URL);
    return;
  }
  if (!(await portainerHealthy())) {
    console.error(
      `${c.yellow(sym.warn)} Portainer não está no ar. Rode ${c.cyan(`${brand.name} docker toolkit up`)}.`,
    );
    process.exit(1);
  }
  console.log(`${c.green(sym.ok)} Abrindo ${link(PORTAINER_URL)}`);
  openUrl(PORTAINER_URL);
}

// ─── registro ────────────────────────────────────────────────────────
