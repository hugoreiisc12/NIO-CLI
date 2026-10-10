import { brand } from "../../brand.js";
import { confirm } from "../../lib/prompts.js";
import { loadSession } from "../../lib/auth/cli-session-store.js";
import { SessionManager } from "../../app/session-manager.js";
import { readDependencies } from "../../lib/skills/skills.js";
import { collectRuleSkills } from "../../lib/skills/rules.js";
import { patternsExist, runPatternsAnalysis } from "../../lib/skills/patterns.js";
import { offerShellCompletion } from "../flows/completion.js";
import { c, sym, cmd, sectionTitle } from "../../lib/colors.js";
import { offerDependencyInstall, offerRuleSkills } from "../flows/dependencies.js";
import type { Config, Selection, SyncOpts } from "./sync-phases.js";

/**
 * Se a sessão ativa foi criada com uma recipe (`config.extra.recipe`), o `sync`
 * acabou de baixar uma versão possivelmente nova dela — oferece re-materializar
 * (Sprint 5.4). Best-effort: sem login / banco fora / sem recipe → silencioso.
 */
async function offerRecipeRematerialize(opts: {
  interactive: boolean;
  assumeYes?: boolean;
}): Promise<void> {
  try {
    const stored = await loadSession();
    if (!stored) return;
    const manager = new SessionManager();
    const active = await manager.findActive(stored.userId);
    const slug = (active?.config.extra as { recipe?: string } | undefined)?.recipe;
    if (!active || !slug) return;

    console.log("");
    console.log(sectionTitle("Recipe da sessão ativa", `"${slug}" — pode ter mudado no repo`));
    const approved =
      opts.assumeYes === true ||
      (opts.interactive &&
        (await confirm({
          message: `Re-materializar a sessão "${active.name}" com a recipe atualizada?`,
          default: false,
        })));
    if (!approved) {
      console.log(`  ${c.dim("pulado — depois:")} ${cmd(`${brand.name} env materialize`)}`);
      return;
    }
    const built = await manager.materialize(stored.userId);
    console.log(
      `  ${c.green(sym.ok)} ${active.name} re-materializada (${built.config.mcps?.length ?? 0} MCPs).`,
    );
    for (const w of built.recipeWarnings)
      console.log(`  ${c.yellow(sym.warn)} recipe: ${w} ignorado.`);
  } catch (err) {
    console.log(`  ${c.dim(`recipe da sessão ativa não checada: ${(err as Error).message}`)}`);
  }
}

/** Fase de ações: ofertas [y/N] (patterns, deps, skills, recipe, completion). */
export async function offerActions(
  config: Config,
  selection: Selection,
  opts: SyncOpts,
): Promise<void> {
  // ---- Fase de ações: ofertas [y/N] (patterns, deps, completion) ----
  console.log("");
  console.log(sectionTitle("Ações", "instalações e ajustes"));

  // Patterns (IA): auto no 1º sync (com [y/N]) ou via --reanalyze; skip-if-exists.
  if (!opts.dryRun && config) {
    const cwd = process.cwd();
    if (opts.reanalyze || !patternsExist(cwd)) {
      const interactive = Boolean(process.stdout.isTTY);
      let approved = opts.yes === true || opts.reanalyze === true;
      if (!approved && interactive) {
        approved = await confirm({
          message: "Analisar o repo agora e gerar docs/_patterns.md? (roda Qwen via vLLM local)",
          default: true,
        });
      }
      if (approved) {
        console.log(`  ${c.dim(`${sym.gear} analisando patterns…`)}`);
        const out = await runPatternsAnalysis(cwd);
        if (!out.ran) {
          console.log(`  ${c.yellow(sym.warn)} ${c.dim(out.reason ?? "análise não rodou")}`);
        } else {
          console.log(
            out.ok
              ? `  ${c.green(sym.ok)} docs/_patterns.md ${c.dim(`(${out.agent})`)}`
              : `  ${c.red(sym.err)} ${c.dim(`análise falhou (${out.agent})`)}`,
          );
        }
      } else {
        console.log(
          `  ${c.dim("patterns pulado — rode")} ${cmd(`${brand.name} sync --reanalyze`)} ${c.dim("depois.")}`,
        );
      }
    }
  }

  // Oferece instalar as libs externas do pacote. Em --dry-run só lista.
  await offerDependencyInstall(readDependencies(selection), {
    interactive: Boolean(process.stdout.isTTY),
    assumeYes: opts.yes,
    enabled: opts.installDeps !== false && !opts.dryRun,
  });

  // Skills recomendadas (skills.sh) das stacks do nio.json.
  await offerRuleSkills(collectRuleSkills(config?.selection ?? { roles: [], stacks: {} }), {
    interactive: Boolean(process.stdout.isTTY),
    assumeYes: opts.yes,
    enabled: opts.installDeps !== false && !opts.dryRun,
  });

  // Recipe da sessão ativa pode ter mudado no repo → oferece re-materializar (5.4).
  if (!opts.dryRun) {
    await offerRecipeRematerialize({
      interactive: Boolean(process.stdout.isTTY),
      assumeYes: opts.yes,
    });
  }

  // Valida o autocomplete do shell; se faltar, prompta (só interativo).
  if (!opts.dryRun) {
    await offerShellCompletion({
      interactive: Boolean(process.stdout.isTTY),
      assumeYes: opts.yes,
    });
  }
}
