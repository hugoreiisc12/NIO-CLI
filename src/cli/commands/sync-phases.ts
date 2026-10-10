import { brand } from "../../brand.js";
import { spawnSyncPortable } from "../../lib/proc.js";
import { confirm } from "../../lib/prompts.js";
import type { loadProjectConfig } from "../../config.js";
import { checkForUpdate } from "../../lib/version-check.js";
import { uninstallProvision, provision } from "../../lib/provision/provision.js";
import { skillIdMap } from "../../lib/skills/skills.js";
import { fetchSkills, skillsMinCliWarning } from "../../lib/skills/skills-cache.js";
import { concatenateRules } from "../../lib/skills/rules.js";
import { writeRepoHarness } from "../../lib/clients/harness.js";
import { startSpinner } from "../../lib/spinner.js";
import { track, provisionedItems } from "../../lib/telemetry.js";
import { VERSION } from "../../version.js";
import type { detectConfiguredTargets } from "../../lib/clients/targets.js";
import { coworkConfigured, installCoworkGlobal } from "../../lib/clients/client-configs.js";
import { c, sym, cmd, box } from "../../lib/colors.js";
import { printProvisionResult, printHarnessResult } from "../ui/render.js";
import { type SyncReport, summarizeProvision } from "../ui/report.js";
import { syncCopy } from "../copy.js";

export * from "./sync-actions.js";

export interface SyncOpts {
  dryRun?: boolean;
  force?: boolean;
  prune?: boolean;
  uninstall?: boolean;
  installDeps?: boolean;
  yes?: boolean;
  reanalyze?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

export type Config = ReturnType<typeof loadProjectConfig> | null;

export type Selection = NonNullable<Config>["selection"];

/** Avisa de versão nova do pacote e oferece atualizar. `true` = atualizou (o sync para aqui). */
export async function offerSelfUpdate(opts: SyncOpts): Promise<boolean> {
  const upd = await checkForUpdate();
  if (upd?.hasUpdate) {
    console.log("");
    console.log(
      box(
        `${c.yellow(sym.warn)} ${c.bold(`nova versão do ${brand.name}`)}  ` +
          `${c.dim(upd.current)} ${c.dim(sym.arrow)} ${c.green(upd.latest)}\n` +
          `${c.dim("atualizar:")} ${cmd(`npm install -g ${upd.name}@latest`)}`,
        { borderColor: "yellow", title: "atualização" },
      ),
    );
    const interactive = Boolean(process.stdout.isTTY);
    const doUpdate =
      !opts.dryRun &&
      (opts.yes === true ||
        (interactive &&
          (await confirm({
            message: syncCopy.update.confirm,
            default: true,
          }))));
    if (doUpdate) {
      console.log(`  ${c.dim(`${sym.gear} rodando…`)}`);
      const res = spawnSyncPortable("npm", ["install", "-g", `${upd.name}@latest`], {
        stdio: "inherit",
      });
      if (res.status === 0) {
        console.log(
          `  ${c.green(`${sym.ok} atualizado pra ${upd.latest}`)} ${c.dim(`— rode \`${brand.name} sync\` de novo.`)}`,
        );
        return true;
      }
      console.log(
        `  ${c.red(`${sym.err} falha ao atualizar`)} ${c.dim("— seguindo com a versão atual.")}`,
      );
    }
  }
  return false;
}

/** Puxa as skills do repo aberto pro cache local; falha dura encerra o processo. */
export async function fetchSkillsPhase(report: SyncReport, opts: SyncOpts): Promise<void> {
  // Puxa a versão mais recente do repo aberto de skills pro cache local
  // (~/.nio/skills). É a fonte que `provision`/`readDependencies` leem.
  if (!opts.dryRun) {
    const sp = startSpinner("Atualizando skills do repo…");
    const fetched = await fetchSkills({ force: true });
    sp.stop();
    const minCliWarn = skillsMinCliWarning();
    if (minCliWarn) {
      report.add({
        id: "min-cli",
        title: "Versão da CLI",
        status: "warn",
        summary: minCliWarn,
        lines: [],
      });
    }
    if (fetched.status === "fetched") {
      report.add({
        id: "fetch",
        title: "Skills",
        status: "ok",
        summary: `atualizadas (${fetched.repo}@${fetched.ref})`,
        lines: [],
      });
    } else if (fetched.status === "cached") {
      report.add({
        id: "fetch",
        title: "Skills",
        status: "warn",
        summary: "usando cache local" + (fetched.error ? " (fetch falhou)" : ""),
        lines: fetched.error ? [`    ${c.dim(fetched.error)}`] : [],
      });
    } else {
      console.error(`  ${c.red(sym.err)} não consegui obter as skills: ${fetched.error}`);
      process.exit(1);
    }
  }
}

/** `--uninstall`: remove o que o nio instalou em cada cliente. */
export function runUninstall(
  targets: ReturnType<typeof detectConfiguredTargets>,
  opts: SyncOpts,
): void {
  for (const target of targets) {
    console.log("");
    console.log(`  ${c.magenta(sym.dot)} ${c.bold(target.label)}`);
    const result = uninstallProvision({
      targetDir: target.targetDir(),
      dryRun: opts.dryRun,
    });
    for (const rel of result.removed) console.log(`  [-] ${rel}`);
    for (const rel of result.kept) console.log(`  [!] ${rel} (modificado localmente — mantido)`);
    const prefix = result.dryRun ? "[dry-run] " : "";
    console.log(
      `${prefix}${result.removed.length} removidos · ${result.kept.length} preservados → ${result.targetDir}`,
    );
  }
}

/** Provisiona cada cliente e registra a seção no relatório. */
export function provisionTargets(
  report: SyncReport,
  targets: ReturnType<typeof detectConfiguredTargets>,
  selection: Selection,
  opts: SyncOpts,
): void {
  const uidByName = skillIdMap();
  for (const target of targets) {
    const result = provision({
      target,
      selection,
      dryRun: opts.dryRun,
      force: opts.force,
      prune: opts.prune,
    });
    const { status, summary } = summarizeProvision(result.files);
    report.addCaptured({ id: `prov-${target.id}`, title: target.label, status, summary }, () =>
      printProvisionResult(result),
    );
    track({
      type: "provision",
      client: target.id,
      sections: selection,
      items: provisionedItems(result.files, uidByName),
      version: VERSION,
    });
  }
}

/** Reafirma o config do Cowork (idempotente). */
export function reportCowork(report: SyncReport, opts: SyncOpts): void {
  if (!opts.dryRun && coworkConfigured()) {
    const result = installCoworkGlobal();
    if (result.status === "updated") {
      report.add({
        id: "cowork",
        title: "Claude Desktop (Cowork)",
        status: "ok",
        summary: "config atualizado — reinicie o app",
        lines: [`    ${c.dim(result.path)}`],
      });
    }
  }
}

/** Harness no repo (rules + AGENTS.md + CLAUDE.md). Idempotente. */
export function reportHarness(report: SyncReport, config: Config, opts: SyncOpts): void {
  if (!opts.dryRun && config) {
    // Overview de projeto (v1) removido — sem fonte de contexto nesse
    // caminho hoje; harness segue só com as rules.
    try {
      const h = writeRepoHarness(process.cwd(), {
        rulesMarkdown: concatenateRules(config.selection ?? { roles: [], stacks: {} }),
        overview: "",
      });
      const changed = [h.rules, h.agents, h.claude].some((a) => a !== "unchanged" && a !== "empty");
      report.addCaptured(
        {
          id: "harness",
          title: "Harness (repo)",
          status: "ok",
          summary: changed ? `rules ${h.rules} · AGENTS ${h.agents}` : "sem mudanças",
        },
        () => printHarnessResult(h),
      );
    } catch (err) {
      report.add({
        id: "harness",
        title: "Harness (repo)",
        status: "warn",
        summary: "pulado",
        lines: [`    ${c.dim((err as Error).message)}`],
      });
    }
  }
}
