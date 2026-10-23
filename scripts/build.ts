import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * Builds the plugin runtime into plugins/aion-presence/runtime/ — self-contained, because Codex copies the
 * plugin root into its cache and runs it without this repository's node_modules. The runtime is committed, so
 * a Git install (`codex plugin marketplace add FulongLi/Aion-Presence-Plugin`) needs no build; CI checks that the
 * committed runtime is exactly what the sources build (npm run runtime:check).
 *
 *   presence.html   the Presence surface: page, styles and script in one file (MCP Apps resource + companion). It
 *                   carries the interactive card runtime (v0.4.5) as a string: a separate bundle that only ever runs inside
 *                   a sandboxed frame (src/cards/runtime), never in the page itself.
 *   aion-mcp.mjs    the MCP server and presence hub (Node, every dependency bundled)
 *   aion-sim.mjs    v0.8: the simulation job runner (started detached by the MCP server for each run)
 *   aion-hook.mjs   the lifecycle hook command (Node builtins only)
 *
 * `--watch` rebuilds on change (npm run dev).
 */
const outIndex = process.argv.indexOf("--out");
const RUNTIME = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : join(PLUGIN_ROOT, "runtime");
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

/** The card runtime: its own bundle (Three.js WebGL, the applications), inlined into its own sandboxed document. */
async function cardRuntime(): Promise<{ html: string; inputs: string[] }> {
  const result = await build({
    ...common, entryPoints: [src("cards/runtime/main.ts")], write: false, metafile: true,
    platform: "browser", format: "iife", target: ["chrome120", "safari17", "firefox121"],
  });
  const script = result.outputFiles[0].text;
  const html = readFileSync(src("cards/runtime/index.html"), "utf8")
    .replace("/*__STYLES__*/", () => readFileSync(src("cards/runtime/styles.css"), "utf8"))
    .replace("/*__SCRIPT__*/", () => script.replace(/<\/script/gi, "<\\/script"));
  return { html, inputs: Object.keys(result.metafile.inputs).map(input => resolve(REPO_ROOT, input)) };
}

/** `import CARD_RUNTIME from "aion:card-runtime"`: the card runtime's document, as a string. */
const cardRuntimeModule: Plugin = {
  name: "aion-card-runtime",
  setup(context) {
    context.onResolve({ filter: /^aion:card-runtime$/ }, args => ({ path: args.path, namespace: "aion-card-runtime" }));
    context.onLoad({ filter: /.*/, namespace: "aion-card-runtime" }, async () => {
      const runtime = await cardRuntime();
      console.log(`  card runtime  ${(runtime.html.length / 1024).toFixed(0)} KB (sandboxed)`);
      return { contents: `export default ${JSON.stringify(runtime.html)};`, loader: "js", watchFiles: [...runtime.inputs, src("cards/runtime/index.html"), src("cards/runtime/styles.css")] };
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
    platform: "browser", format: "iife", target: ["chrome120", "safari17", "firefox121"], plugins: [cardRuntimeModule, inlinePage],
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
  {
    ...common, entryPoints: [src("host/sim/main.ts")], outfile: join(RUNTIME, "aion-sim.mjs"),
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
  report("aion-sim.mjs");
}
