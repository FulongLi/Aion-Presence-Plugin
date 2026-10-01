import { execFileSync } from "node:child_process";
import { REPO_ROOT, validatePluginPackage } from "./lib/pluginPackage";
import { findCodex, LEGACY_MARKETPLACE, LEGACY_PLUGIN_ID, MARKETPLACE_NAME, PLUGIN_ID } from "./lib/codex";

/**
 * `npm run setup` (development): build from source, validate, and optionally install this checkout. Users do not
 * need it: the runtime is committed, so `node scripts/install.mjs` (or a Git install) installs without a build.
 *   1. checks Node ≥ 22;
 *   2. builds the runtime and validates the plugin package;
 *   3. prints the Codex commands — or, with `npm run setup -- --install`, runs them: registers this
 *      repository as a local marketplace and installs Aion Presence into your Codex configuration.
 * Re-run with --install after changing the plugin to refresh Codex's installed copy.
 */
const install = process.argv.includes("--install");
const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "inherit", cwd: REPO_ROOT });

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) { console.error(`Aion Presence needs Node 22 or newer (found ${process.versions.node}).`); process.exit(1); }
console.log(`✓ Node ${process.versions.node}`);

run(process.execPath, ["--import", "tsx", "scripts/build.ts"]);
const errors = validatePluginPackage({ requireRuntime: true }).filter(issue => issue.level === "error");
if (errors.length) { for (const issue of errors) console.error(`✗ ${issue.where}: ${issue.message}`); process.exit(1); }
console.log("✓ plugin package and runtime are valid");

const codex = findCodex();
const name = codex ?? "codex";
const steps = [
  [name, "plugin", "marketplace", "add", REPO_ROOT],
  [name, "plugin", "add", PLUGIN_ID],
];
if (!install) {
  console.log(`\nNext, register this repository with Codex and install Aion Presence:\n`);
  for (const step of steps) console.log(`  ${step.map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(" ")}`);
  console.log(`\n(or run: npm run setup -- --install)${codex ? "" : "\nNo Codex CLI was found; install Codex or set CODEX_BIN."}`);
  console.log("\nThen restart Codex, trust the Aion Presence hooks when Codex asks (or with /hooks), and say \"Open Aion\".");
  process.exit(0);
}
if (!codex) { console.error("No Codex CLI was found; install Codex or set CODEX_BIN."); process.exit(1); }
for (const args of [["plugin", "remove", LEGACY_PLUGIN_ID], ["plugin", "marketplace", "remove", LEGACY_MARKETPLACE], ["plugin", "remove", PLUGIN_ID], ["plugin", "marketplace", "remove", MARKETPLACE_NAME]]) {
  try { execFileSync(codex, args, { stdio: "ignore" }); } catch { /* not installed or registered */ }
}
for (const [command, ...args] of steps) run(command, args);
console.log("\n✓ Aion Presence is installed. Restart Codex, trust its hooks when asked (or with /hooks), and say \"Open Aion\".");
