#!/usr/bin/env node
/**
 * Installs Aion Presence into Codex in one step. Plain Node (built-ins only): no `npm install`, no build — the
 * plugin's runtime is committed.
 *
 *   node scripts/install.mjs              register this checkout as the "spirit-connect" marketplace and install
 *   node scripts/install.mjs --github     register GitHub (FulongLi/Aion-Presence-Plugin) instead, so Codex keeps
 *                                         its own snapshot and this checkout can be deleted
 *   options: --ref <git ref>  --source <owner/repo | git URL | path>  --codex <path to codex>  --json
 *            --dry-run (check everything, change nothing)  --help
 *
 * It removes a v0.1 development install (aion-presence@aion-presence-dev) first, verifies the result with
 * Codex itself (plugin enabled, MCP server listed), and prints only what the user must still do: restart Codex
 * once, and trust the hooks. It never edits Codex's configuration beyond what `codex plugin` does, and never
 * asks for or stores a credential.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE = "spirit-connect";
const PLUGIN = `aion-presence@${MARKETPLACE}`;
const LEGACY = { marketplace: "aion-presence-dev", plugin: "aion-presence@aion-presence-dev" };
const GITHUB = "FulongLi/Aion-Presence-Plugin";
const RUNTIME = ["runtime/aion-mcp.mjs", "runtime/aion-hook.mjs", "runtime/presence.html"];

const args = process.argv.slice(2);
const KNOWN = new Set(["--github", "--ref", "--source", "--codex", "--json", "--dry-run", "--help", "-h"]);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Install Aion Presence into Codex.

  node scripts/install.mjs [--github] [--ref <ref>] [--source <owner/repo|git URL|path>] [--codex <path>] [--json] [--dry-run]

  (default)   install from this checkout
  --github    install from ${"FulongLi/Aion-Presence-Plugin"} on GitHub (Codex keeps its own snapshot)
  --dry-run   check Node, Codex and the source; change nothing`);
  process.exit(0);
}
const unknown = args.filter((arg, i) => arg.startsWith("-") && !KNOWN.has(arg) && !["--ref", "--source", "--codex"].includes(args[i - 1]));
if (unknown.length) { console.error(`✗ Unknown option ${unknown.join(", ")} (see --help). Nothing was changed.`); process.exit(2); }
const dryRun = args.includes("--dry-run");
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const json = args.includes("--json");
const say = text => { if (!json) console.log(text); };
const fail = (code, text) => {
  if (json) console.log(JSON.stringify({ ok: false, error: code, message: text }));
  else console.error(`✗ ${text}`);
  process.exit(1);
};

// 1. Node and Codex.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) fail("node-too-old", `Aion Presence needs Node 22 or newer (found ${process.versions.node}).`);

function findCodex() {
  const candidates = [option("--codex"), process.env.CODEX_BIN, "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex"];
  for (const candidate of candidates) {
    if (!candidate || (candidate.includes("/") && !existsSync(candidate))) continue;
    try { execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 20_000 }); return candidate; } catch { /* next */ }
  }
  return null;
}
const codex = findCodex();
if (!codex) fail("codex-not-found", "No Codex CLI was found. Install Codex (or the ChatGPT desktop app), or pass --codex <path>.");
const cx = (...rest) => execFileSync(codex, rest, { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
const quiet = (...rest) => { try { cx(...rest); return true; } catch { return false; } };
const version = cx("--version").trim();
try { cx("plugin", "marketplace", "add", "--help"); } catch { fail("codex-without-plugins", `${version} does not support plugins; update Codex.`); }
say(`✓ ${version} (${codex})`);

// 2. The source: GitHub, or this checkout (whose runtime is committed).
const github = args.includes("--github");
const source = option("--source") ?? (github ? GITHUB : REPO);
const local = !github && !option("--source");
if (local) {
  const missing = RUNTIME.filter(file => !existsSync(join(REPO, "plugins", "aion-presence", file)));
  if (missing.length) fail("runtime-missing", `This checkout has no built runtime (${missing.join(", ")}). Run npm install && npm run build, or use --github.`);
}

if (dryRun) {
  const plan = [`remove ${LEGACY.plugin} and ${PLUGIN} if installed`, `codex plugin marketplace add ${source}${option("--ref") ? ` --ref ${option("--ref")}` : ""}`, `codex plugin add ${PLUGIN}`];
  if (json) console.log(JSON.stringify({ ok: true, dryRun: true, codex: version, source, plan }));
  else say(`✓ ready to install (dry run, nothing changed):\n${plan.map(step => `  · ${step}`).join("\n")}`);
  process.exit(0);
}

// 3. Install: remove a v0.1 development install and any previous registration, then add and install.
quiet("plugin", "remove", LEGACY.plugin);
quiet("plugin", "marketplace", "remove", LEGACY.marketplace);
quiet("plugin", "remove", PLUGIN);
quiet("plugin", "marketplace", "remove", MARKETPLACE);
const ref = option("--ref");
try {
  cx("plugin", "marketplace", "add", source, ...(ref ? ["--ref", ref] : []));
  cx("plugin", "add", PLUGIN);
} catch (error) {
  fail("install-failed", `Codex could not install ${PLUGIN} from ${source}: ${String(error.stderr || error.message).trim().split("\n")[0]}`);
}

// 4. Verify with Codex itself.
const installed = JSON.parse(cx("plugin", "list", "--json")).installed?.find(item => item.pluginId === PLUGIN);
if (!installed?.installed || !installed.enabled) fail("not-enabled", `${PLUGIN} did not end up installed and enabled.`);
const server = JSON.parse(cx("mcp", "list", "--json")).find(item => item.name === "aion-presence");
if (!server?.enabled) fail("mcp-missing", "Codex does not list the aion-presence MCP server.");
if (/OPENAI|API_KEY/.test(JSON.stringify(server.transport?.env ?? {}))) fail("unexpected-credential", "The MCP server environment unexpectedly holds a key.");

const restart = "Restart Codex once to load Aion.";
const hooks = "When Codex asks, trust Aion's hooks: they only reflect states such as reading, editing, testing and building.";
if (json) {
  console.log(JSON.stringify({ ok: true, plugin: PLUGIN, version: installed.version, source, codex: version, next: [restart, hooks, "Then say: Open Aion."] }));
} else {
  say(`✓ ${PLUGIN} ${installed.version} is installed and enabled (from ${local ? "this checkout" : source})`);
  say("✓ Codex lists the aion-presence MCP server; no API key is involved");
  say(`\n${restart}\n${hooks}\nAion opens by itself the first time; afterwards just say "Open Aion".`);
}
