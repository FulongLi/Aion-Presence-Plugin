import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ROOT, REPO_ROOT, RUNTIME_FILES } from "./lib/pluginPackage";

/**
 * `npm run runtime:check`: the committed runtime (what a Git install runs) must be exactly what the sources
 * build. Builds into a temporary directory and compares byte for byte; run `npm run build` and commit if not.
 */
const out = mkdtempSync(join(tmpdir(), "aion-runtime-"));
try {
  execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "build.ts"), "--out", out], { stdio: "ignore", cwd: REPO_ROOT });
  const committed = readdirSync(join(PLUGIN_ROOT, "runtime")).sort(), built = readdirSync(out).sort();
  const stale = RUNTIME_FILES.map(file => file.replace("runtime/", "")).filter(file => {
    try { return !readFileSync(join(out, file)).equals(readFileSync(join(PLUGIN_ROOT, "runtime", file))); } catch { return true; }
  });
  const extra = committed.filter(file => !built.includes(file));
  if (stale.length || extra.length) {
    console.error(`✗ the committed runtime is out of date: ${[...stale, ...extra.map(file => `${file} (not built)`)].join(", ")}\n  run npm run build and commit plugins/aion-presence/runtime/`);
    process.exit(1);
  }
  console.log(`✓ the committed runtime matches the sources (${built.join(", ")})`);
} finally { rmSync(out, { recursive: true, force: true }); }
