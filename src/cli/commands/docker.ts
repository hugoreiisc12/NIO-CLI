/**
 * `nio docker *` — camada Docker. `toolkit`/`portainer` sobem a infra NIO;
 * `compose`/`create` são wrapper determinístico sobre `docker`; `debug`/`orquest`/
 * `cluster` fazem handoff pro operador de IA. Ver `docs/arch/ARQUITETURA-DOCKER.md`.
 */

import type { Command } from "commander";
import { CLUSTER_STACK } from "../../lib/docker/config.js";
import {
  headroomDown,
  headroomStatus,
  headroomUp,
  stackDown,
  stackStatus,
  stackUp,
  toolkitDown,
  toolkitStatus,
  toolkitUp,
} from "./docker-infra.js";
import {
  CLUSTER_ACTIONS,
  COMPOSE_ACTIONS,
  runCluster,
  runCompose,
  runCreate,
  runDebug,
  runOrquest,
  runPortainer,
} from "./docker-run.js";

export function registerDockerCommand(program: Command): void {
  const cmd = program
    .command("docker")
    .description("Camada Docker: stack NIO, compose, debug e cluster (Swarm)");

  const stack = cmd
    .command("stack")
    .description(
      "Stack NIO unificado (gateway · kong · headroom · mcp · portainer) — docker/docker-compose.yml",
    );
  stack
    .command("up", { isDefault: true })
    .description("Sobe o stack inteiro (build do gateway) + registra o MCP")
    .action(stackUp);
  stack.command("down").description("Derruba o stack inteiro").action(stackDown);
  stack.command("status").description("ps + health dos 5 serviços").action(stackStatus);

  const toolkit = cmd
    .command("toolkit")
    .description("Infra NIO: Docker MCP Gateway + Portainer (docker/docker-compose.yml)");
  toolkit
    .command("up", { isDefault: true })
    .description("Sobe a infra e registra o gateway no opencode.json")
    .action(toolkitUp);
  toolkit
    .command("down")
    .description("Derruba a infra e desabilita o MCP no opencode.json")
    .action(toolkitDown);
  toolkit
    .command("status")
    .description("Estado dos containers + health dos endpoints")
    .action(toolkitStatus);

  const headroom = cmd
    .command("headroom")
    .description("Proxy de compressão de contexto — dormente, opcional pro `nio ai`");
  headroom
    .command("up", { isDefault: true })
    .description("Sobe o container do Headroom")
    .action(headroomUp);
  headroom.command("down").description("Derruba o container do Headroom").action(headroomDown);
  headroom.command("status").description("O Headroom está no ar?").action(headroomStatus);

  cmd
    .command("compose <action> [service]")
    .description(`Wrapper sobre \`docker compose\` do projeto (${COMPOSE_ACTIONS.join("|")})`)
    .option("-f, --file <path>", "compose file (default: ./docker-compose.yml)")
    .option("-d, --detach", "up em background (default)")
    .option("--no-detach", "up em foreground")
    .option("--build", "up com rebuild das imagens")
    .option("--tail <n>", "linhas de logs")
    .action(runCompose);

  cmd
    .command("create")
    .description("Cria e sobe um container (wizard ou flags)")
    .option("--image <ref>", "imagem (pula o wizard)")
    .option("--name <name>", "nome do container")
    .option("--port <list>", "portas host:container separadas por vírgula")
    .option("--env <list>", "env KEY=VALUE separadas por vírgula")
    .option("--volume <list>", "volumes host:container separados por vírgula")
    .option("--no-detach", "roda em foreground")
    .option("-y, --yes", "não pede confirmação")
    .action(runCreate);

  cmd
    .command("debug [container]")
    .description("Coleta o contexto de um container e entrega o diagnóstico pro operador de IA")
    .option("--json", "só imprime o contexto coletado (ps/logs/inspect)")
    .action(runDebug);

  cmd
    .command("orquest [instruction]")
    .description(
      "Orquestra os serviços do projeto via compose, dirigido pelo operador (linguagem natural)",
    )
    .option("--dry-run", "gera o compose e mostra, sem aplicar")
    .action(runOrquest);

  cmd
    .command("cluster <action> [arg]")
    .description(`Docker Swarm — stack \`${CLUSTER_STACK}\` (${CLUSTER_ACTIONS.join("|")})`)
    .action(runCluster);

  cmd
    .command("portainer")
    .description("Abre o Portainer no navegador")
    .option("--url", "só imprime a URL")
    .action(runPortainer);
}
