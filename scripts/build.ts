import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * Builds the plugin runtime into plugins/aion-presence/runtime/ — self-contained, because Codex copies the
 * plugin root into its cache and runs it without this repository's node_modules:
 *
 *   presence.html   the Presence surface: page, styles and script in one file (MCP Apps resource + companion)
 *   aion-mcp.mjs    the MCP server and presence hub (Node, every dependency bundled)
 *   aion-hook.mjs   the lifecycle hook command (Node builtins only)
 *
 * `--watch` rebuilds on change (npm run dev).
 */
const RUNTIME = join(PLUGIN_ROOT, "runtime");
const watch = process.argv.includes("--watch");
const src = (path: string) => join(REPO_ROOT, "src", path);

const common: BuildOptions = { bundle: true, minify: !watch, legalComments: "none", logLevel: "warning", sourcemap: false, absWorkingDir: REPO_ROOT };

/** Inlines the surface bundle and styles into the single-file page after every build. */
const inlinePage: Plugin = {
  name: "inline-page",
  setup(context) {
    context.onEnd(result => {
      if (result.errors.length || !result.outputFiles) return;
      const script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
      const styles = readFileSync(src("surface/styles.css"), "utf8");
      const page = readFileSync(src("surface/index.html"), "utf8")
        .replace("/*__STYLES__*/", () => styles)
        // A literal "</script" inside the bundle would end the inline script early.
        .replace("/*__SCRIPT__*/", () => script.replace(/<\/script/gi, "<\\/script"));
      writeFileSync(join(RUNTIME, "presence.html"), page);
      report("presence.html");
    });
  },
};

function report(file: string) {
  const size = statSync(join(RUNTIME, file)).size;
  console.log(`  ${relative(REPO_ROOT, join(RUNTIME, file))}  ${(size / 1024).toFixed(0)} KB`);
}

const targets: BuildOptions[] = [
  {
    ...common, entryPoints: [src("surface/main.ts")], outfile: join(RUNTIME, "presence.js"), write: false,
    platform: "browser", format: "iife", target: ["chrome120", "safari17", "firefox121"], plugins: [inlinePage],
  },
  {
    ...common, entryPoints: [src("host/mcp/main.ts")], outfile: join(RUNTIME, "aion-mcp.mjs"),
    platform: "node", format: "esm", target: "node22",
    banner: { js: "import { createRequire as __aionRequire } from 'node:module'; const require = __aionRequire(import.meta.url);" },
  },
  {
    ...common, entryPoints: [src("host/hooks/main.ts")], outfile: join(RUNTIME, "aion-hook.mjs"),
    platform: "node", format: "esm", target: "node22",
  },
];

if (!watch) rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });
console.log(watch ? "Building the Aion Presence runtime (watching)…" : "Building the Aion Presence runtime…");
if (watch) {
  const { context } = await import("esbuild");
  for (const target of targets) await (await context(target)).watch();
} else {
  await Promise.all(targets.map(target => build(target)));
  report("aion-mcp.mjs");
  report("aion-hook.mjs");
}
