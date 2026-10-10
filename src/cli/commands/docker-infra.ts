import { brand } from "../../brand.js";
import { c, sym, section } from "../../lib/colors.js";
import { DOCKER_MCP_URL, PORTAINER_URL } from "../../lib/docker/config.js";
import { mcpGatewayHealthy, portOpen, portainerHealthy } from "../../lib/docker/health.js";
import { upsertOpencodeMcp } from "../../lib/clients/client-configs.js";
import { ensureHeadroomRunning, headroomHealthy, HEADROOM_URL } from "../../lib/headroom.js";
import { gatewayHealth } from "../../lib/auth/gateway-process.js";
import { GATEWAY_URL } from "../../gateway/config.js";
import { dockerGatewayMcp } from "../../profiles/mcps.js";
import { infraCompose, requireDocker } from "./docker-shared.js";

export async function headroomUp(): Promise<void> {
  section("Headroom", "proxy de compressão de contexto");
  const r = await ensureHeadroomRunning();
  if (!r.ok) {
    console.error(`${c.red(sym.err)} ${r.error}`);
    process.exit(1);
  }
  console.log(
    `  ${c.green(sym.ok)} Headroom no ar ${c.dim(HEADROOM_URL)}${r.started ? "" : " (já estava)"}`,
  );
}

export async function headroomDown(): Promise<void> {
  requireDocker();
  section("Headroom", "derrubando o container");
  // `down` derrubaria o STACK inteiro (compose único) — paramos/removemos só o serviço.
  infraCompose(["stop", "headroom"]);
  infraCompose(["rm", "-f", "headroom"]);
}

export async function headroomStatus(): Promise<void> {
  const up = await headroomHealthy();
  console.log(
    `  ${up ? c.green(sym.ok) : c.red(sym.err)} Headroom ${c.dim(HEADROOM_URL)} — ${up ? "no ar" : "fora"}`,
  );
}

// ─── toolkit ─────────────────────────────────────────────────────────

export async function toolkitUp(): Promise<void> {
  requireDocker();
  section("Docker toolkit", "subindo MCP Gateway + Portainer");

  // Escopo explícito: o compose é único; sem os nomes subiria o stack todo.
  // `docker-socket-proxy` entra junto (o Portainer depende dele).
  if (infraCompose(["up", "-d", "mcp-gateway", "portainer", "docker-socket-proxy"]) !== 0) {
    console.error(`${c.red(sym.err)} Falha ao subir a infra (\`docker compose\` saiu != 0).`);
    process.exit(1);
  }

  // Registra o gateway remoto no opencode.json — o operador ganha as tools Docker.
  try {
    const r = upsertOpencodeMcp(dockerGatewayMcp);
    const msg = { created: "criado", updated: "atualizado", already_configured: "já estava" }[
      r.status
    ];
    console.log(
      `  ${c.green(sym.ok)} opencode.json — MCP \`docker\` ${msg} (${c.dim(DOCKER_MCP_URL)})`,
    );
    if (r.backup) console.log(`  ${c.dim(`backup: ${r.backup}`)}`);
  } catch (err) {
    console.warn(
      `  ${c.yellow(sym.warn)} não consegui registrar o MCP no opencode.json: ${(err as Error).message}`,
    );
  }

  const [gw, pt] = await Promise.all([mcpGatewayHealthy(), portainerHealthy()]);
  console.log("");
  console.log(
    `  ${gw ? c.green(sym.ok) : c.yellow(sym.warn)} MCP Gateway  ${c.dim(DOCKER_MCP_URL)}`,
  );
  console.log(
    `  ${pt ? c.green(sym.ok) : c.yellow(sym.warn)} Portainer    ${c.dim(PORTAINER_URL)}`,
  );
  console.log("");
  console.log(
    c.dim(`  1º acesso ao Portainer pede setup de admin — abra ${PORTAINER_URL} e crie o usuário.`),
  );
  console.log(c.dim(`  reinicie o \`opencode\` da sessão pra ele pegar as tools Docker.`));
}

export async function toolkitDown(): Promise<void> {
  requireDocker();
  section("Docker toolkit", "derrubando MCP Gateway + Portainer");
  // Só os serviços do toolkit — `down` derrubaria o stack inteiro.
  infraCompose(["stop", "mcp-gateway", "portainer", "docker-socket-proxy"]);
  infraCompose(["rm", "-f", "mcp-gateway", "portainer", "docker-socket-proxy"]);
  try {
    const r = upsertOpencodeMcp(dockerGatewayMcp, { remove: true });
    if (r.status !== "already_configured") {
      console.log(`  ${c.green(sym.ok)} MCP \`docker\` desabilitado no opencode.json`);
    }
  } catch {
    /* best-effort */
  }
}

export async function toolkitStatus(): Promise<void> {
  requireDocker();
  section("Docker toolkit", "status");
  infraCompose(["ps", "mcp-gateway", "portainer", "docker-socket-proxy"]);
  const [gw, pt] = await Promise.all([mcpGatewayHealthy(), portainerHealthy()]);
  console.log("");
  console.log(`  ${gw ? c.green(sym.ok) : c.red(sym.err)} MCP Gateway  ${c.dim(DOCKER_MCP_URL)}`);
  console.log(`  ${pt ? c.green(sym.ok) : c.red(sym.err)} Portainer    ${c.dim(PORTAINER_URL)}`);
}

// ─── stack (o compose unificado inteiro) ─────────────────────────────

/** Porta do proxy Kong (ingresso do gateway). `NIO_KONG_PROXY_PORT`, default 8000. */
const KONG_PORT = Number(process.env.NIO_KONG_PROXY_PORT?.trim()) || 8000;

/** Health compacto dos 5 serviços do stack. */
async function printStackHealth(): Promise<void> {
  const [gw, kong, hr, mcp, pt] = await Promise.all([
    gatewayHealth(),
    portOpen(KONG_PORT),
    headroomHealthy(),
    mcpGatewayHealthy(),
    portainerHealthy(),
  ]);
  const line = (ok: boolean, name: string, url: string) =>
    console.log(`  ${ok ? c.green(sym.ok) : c.red(sym.err)} ${name.padEnd(12)} ${c.dim(url)}`);
  console.log("");
  line(gw, "gateway", GATEWAY_URL);
  line(kong, "kong", `http://127.0.0.1:${KONG_PORT}`);
  line(hr, "headroom", HEADROOM_URL);
  line(mcp, "mcp-gateway", DOCKER_MCP_URL);
  line(pt, "portainer", PORTAINER_URL);
}

export async function stackUp(): Promise<void> {
  requireDocker();
  section("Docker stack", "subindo o stack NIO (gateway · kong · headroom · mcp · portainer)");

  // `--build` gera a imagem do nio-gateway a partir do dist/ + Dockerfile.gateway.
  if (infraCompose(["up", "-d", "--build"]) !== 0) {
    console.error(`${c.red(sym.err)} Falha ao subir o stack (\`docker compose\` saiu != 0).`);
    process.exit(1);
  }

  // Registra o MCP `docker` no opencode.json (idempotente) — o operador ganha as tools.
  try {
    const r = upsertOpencodeMcp(dockerGatewayMcp);
    const msg = { created: "criado", updated: "atualizado", already_configured: "já estava" }[
      r.status
    ];
    console.log(
      `  ${c.green(sym.ok)} opencode.json — MCP \`docker\` ${msg} (${c.dim(DOCKER_MCP_URL)})`,
    );
    if (r.backup) console.log(`  ${c.dim(`backup: ${r.backup}`)}`);
  } catch (err) {
    console.warn(
      `  ${c.yellow(sym.warn)} não consegui registrar o MCP no opencode.json: ${(err as Error).message}`,
    );
  }

  // Espera o gateway publicar a porta no host antes de reportar (o `up -d` volta
  // assim que os containers "iniciam", mas o port-forward/boot leva alguns segundos).
  for (let i = 0; i < 20 && !(await gatewayHealth()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await printStackHealth();
  console.log("");
  console.log(
    c.dim(
      `  se algum serviço vier ✗, aguarde alguns segundos e rode \`${brand.name} docker stack status\`.`,
    ),
  );
  console.log(
    c.dim(`  1º acesso ao Portainer pede setup de admin — abra ${PORTAINER_URL} e crie o usuário.`),
  );
}

export async function stackDown(): Promise<void> {
  requireDocker();
  section("Docker stack", "derrubando o stack NIO inteiro");
  infraCompose(["down"]); // aqui o `down` total é legítimo — é o stack inteiro.
  try {
    upsertOpencodeMcp(dockerGatewayMcp, { remove: true });
  } catch {
    /* best-effort */
  }
}

export async function stackStatus(): Promise<void> {
  requireDocker();
  section("Docker stack", "status");
  infraCompose(["ps"]);
  await printStackHealth();
}

// ─── compose (projeto) ───────────────────────────────────────────────
