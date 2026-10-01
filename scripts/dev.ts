import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PresenceHub } from "../src/host/hub/hub";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run dev`: the whole development stack in one command.
 *   - rebuilds the runtime on every change (esbuild watch);
 *   - runs a presence hub with the companion surface (reload the page to see surface changes);
 *   - `npm run dev -- --demo` also plays a scripted Codex-like workflow against it.
 * The hub keeps its runtime files in .e2e/dev-home, apart from any installed plugin.
 */
const home = process.env.AION_PRESENCE_HOME ?? join(REPO_ROOT, ".e2e", "dev-home");
const page = join(PLUGIN_ROOT, "runtime", "presence.html");

const builder = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "build.ts"), "--watch"], { stdio: "inherit" });
for (let i = 0; i < 100 && !existsSync(page); i++) await new Promise(resolve => setTimeout(resolve, 100));

const hub = new PresenceHub({ home, port: Number(process.env.AION_PRESENCE_PORT) || 47_232, page: () => readFileSync(page, "utf8") });
await hub.start();
hub.apply({ type: "open" });
console.log(`\nAion Presence (development)\n  companion  ${hub.surfaceUrl}\n  debug      ${hub.surfaceUrl}&debug=1\n  canvas     ${hub.surfaceUrl}&renderer=canvas\n`);

if (process.argv.includes("--demo")) {
  const demo = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "demo.ts")], { stdio: "inherit", env: { ...process.env, AION_PRESENCE_HOME: home } });
  demo.on("exit", () => console.log("demo finished; the hub keeps running (Ctrl+C to stop)"));
}

const stop = async () => { builder.kill(); await hub.stop(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
setInterval(() => {}, 1 << 30);
