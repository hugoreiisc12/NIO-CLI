import type { Command } from "commander";
import {
  type SyncOpts,
  fetchSkillsPhase,
  offerActions,
  offerSelfUpdate,
  provisionTargets,
  reportCowork,
  reportHarness,
  runUninstall,
} from "./sync-phases.js";
import { loadProjectConfig } from "../../config.js";
import { ensureUserConfig } from "../flows/user-config.js";
import { flushTelemetry } from "../../lib/telemetry.js";
import { opencodeTarget, detectConfiguredTargets } from "../../lib/clients/targets.js";
import { clearScreen } from "../../lib/colors.js";
import { SyncReport, renderReport, browseReport, resolveReportMode } from "../ui/report.js";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description(
      "Instala/atualiza skills, commands e agents nos clientes configurados, a partir do bundle (idempotente); checa atualização do pacote",
    )
    .option("--dry-run", "mostra o que mudaria, sem escrever nada")
    .option("--force", "sobrescreve arquivos divergentes de mesmo nome")
    .option("--no-prune", "mantém arquivos que saíram do bundle")
    .option("--uninstall", "remove os arquivos que o nio instalou")
    .option("--no-install-deps", "não oferece instalar as libs externas requeridas")
    .option("-y, --yes", "aprova automaticamente a instalação das libs (não-interativo)")
    .option(
      "--reanalyze",
      "re-roda a análise de patterns (regera docs/_patterns.md) mesmo se já existir",
    )
    .option("--verbose", "expande todos os detalhes inline (sem resumo/menu)")
    .option("--quiet", "só o resumo de uma linha por seção")
    .action(async (opts: SyncOpts) => {
      try {
        if (await offerSelfUpdate(opts)) return;

        const mode = resolveReportMode(opts);
        const report = new SyncReport();
        if (!opts.dryRun) await fetchSkillsPhase(report, opts);

        const detected = detectConfiguredTargets();
        const targets = detected.length > 0 ? detected : [opencodeTarget];
        if (opts.uninstall) {
          runUninstall(targets, opts);
          return;
        }

        let config = null;
        try {
          config = loadProjectConfig();
        } catch {
          /* sem nio.json / inválido → provisiona tudo */
        }
        const selection = config?.selection;

        // Split de config: migra o formato antigo + garante o nio.user.json (prefs).
        if (!opts.dryRun) {
          await ensureUserConfig({
            interactive: Boolean(process.stdout.isTTY),
            hasRepoConfig: Boolean(config),
          });
        }

        provisionTargets(report, targets, selection, opts);
        reportCowork(report, opts);
        reportHarness(report, config, opts);

        // ---- Render do resumo + menu navegável (só no modo interativo) ----
        // Limpa a tela (TTY) pra o resumo aparecer sem o "lixo" das etapas acima.
        clearScreen();
        renderReport(report, mode);
        if (mode === "summary") await browseReport(report);

        await offerActions(config, selection, opts);
        await flushTelemetry();
      } catch (err) {
        console.error(`[erro] ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
