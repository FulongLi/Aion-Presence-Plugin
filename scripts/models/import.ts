/**
 * Imports a model file the user downloaded into their own model library (v0.9), as `show_model` action import does:
 * validated, converted once, kept on this machine only.
 *
 *   npm run models:import -- --file ~/Downloads/model.glb [--catalogue <catalogue id>] [--name "Name"] [--home <dir>]
 */
import { resolve } from "node:path";
import { ModelLibrary } from "../../src/host/models/library";
import { PLUGIN_ROOT } from "../lib/pluginPackage";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const file = option("file");
if (!file) { console.error("usage: npm run models:import -- --file <path> [--catalogue <id>] [--name <name>] [--home <dir>]"); process.exit(2); }
const library = new ModelLibrary({ assetsDir: `${PLUGIN_ROOT}/assets`, ...(option("home") ? { home: resolve(option("home")!) } : {}) });
const catalogue = option("catalogue"), name = option("name");
const result = await library.importFile(resolve(file), catalogue ? { catalogue } : { name });
console.log(`${result.duplicate ? "already in the library" : "imported"}: ${result.manifest.id} (${result.manifest.name}) — ${result.info.triangles} triangles, ${result.info.textures} textures${result.info.animations.length ? `, clips ${result.info.animations.join(", ")}` : ""}`);
console.log(`library: ${library.root}`);
