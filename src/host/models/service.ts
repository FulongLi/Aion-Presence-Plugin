import { creditLine, type ModelColors, type ModelDetail, type ModelManifest } from "../../visual/models/manifest";
import type { RegistryEntry } from "../../visual/models/registry";
import type { ModelLibrary} from "./library";
import { ModelLibraryError, type ConvertedModel } from "./library";

/**
 * `show_model` (v0.9) without the MCP plumbing: resolving what the user asked for in the library, and the words Codex
 * gets back. Honest by construction: a model that is only catalogued is never replaced by something else — Aion says
 * what exists, where it comes from, what its licence and rights are, and how the user may import it.
 */
export interface ModelRequest {
  model?: string; action?: "show" | "find" | "import" | "remove"; file?: string; colors?: ModelColors; animation?: string; detail?: ModelDetail;
}
/** What is on show now (from the hub), so "in silver", "make it walk" and "another one" need no name. */
export interface CurrentModel { model: string; colors: ModelColors; animation?: string; playing?: boolean; media: { id: string } }

export type ModelOutcome =
  | { kind: "show"; converted: ConvertedModel; colors: ModelColors; playing: boolean; message: string }
  | { kind: "text"; message: string }
  | { kind: "error"; message: string };

const describeRights = (m: ModelManifest) => {
  const ip = m.rights.underlyingIp === "third-party" ? `a fan-made model of a third-party design${m.rights.ipOwner ? ` (${m.rights.ipOwner})` : ""}`
    : m.rights.underlyingIp === "original" ? "an original design" : m.rights.underlyingIp === "public-domain" ? "a public-domain subject" : "rights of the design unknown";
  return `${m.licence.label}; ${ip}`;
};
const availabilityWords = { local: "installed (your import)", redistributable: "bundled", catalogued: "catalogued only (no file)" } as const;

export function entryLine(entry: RegistryEntry): string {
  const m = entry.manifest;
  const restricted = m.rights.extractedGameAsset && m.rights.extractedGameAsset !== "no" ? " · RESTRICTED (suspected game rip: never imported)" : "";
  return `${m.id}: ${m.name} — ${availabilityWords[m.availability]}${entry.installed ? "" : m.availability !== "catalogued" ? " (file missing)" : ""}; `
    + `"${m.source.title}" by ${m.source.author}${m.source.url ? ` (${m.source.site}, ${m.source.url})` : ""}; ${describeRights(m)}${restricted}`;
}

export class ModelService {
  constructor(readonly library: ModelLibrary) {}

  async handle(request: ModelRequest, current: CurrentModel | null): Promise<ModelOutcome> {
    const action = request.action ?? (request.file ? "import" : "show");
    try {
      if (action === "find") return await this.find(request.model ?? "");
      if (action === "remove") {
        if (!request.model) return { kind: "error", message: "invalid-arguments: name the imported model to remove (its id)." };
        const registry = await this.library.registry();
        const id = registry.get(request.model)?.manifest.id ?? registry.resolve(request.model).model?.manifest.id;
        const removed = id ? await this.library.remove(id) : false;
        return removed ? { kind: "text", message: `Removed ${id} from this machine's model library (its file and cached particles).` }
          : { kind: "error", message: `model-not-removable: ${request.model} is not one of the user's imported models (bundled models and catalogue entries stay).` };
      }
      if (action === "import") {
        if (!request.file) return { kind: "error", message: "invalid-arguments: import needs file, the absolute path of a model the user downloaded (.glb, .gltf, .obj or .stl)." };
        const registry = await this.library.registry();
        const catalogue = request.model && registry.get(request.model) && !registry.get(request.model)!.installed ? request.model : undefined;
        const imported = await this.library.importFile(request.file, catalogue ? { catalogue } : { name: request.model });
        const shown = await this.show({ ...request, model: imported.manifest.id }, null);
        if (shown.kind !== "show") return shown;
        const info = imported.info;
        return {
          ...shown,
          message: `${imported.duplicate ? "Already in the library" : "Imported"}: ${imported.manifest.name} (${imported.manifest.id}; ${info.triangles.toLocaleString("en")} triangles, ${info.textures} textures`
            + `${info.animations.length ? `, animations: ${info.animations.join(", ")}` : ""}). It stays on this machine only. ${shown.message}`,
        };
      }
      return await this.show(request, current);
    } catch (error) {
      if (error instanceof ModelLibraryError) return { kind: "error", message: `${error.message}: ${error.detail}` };
      if (error instanceof Error && /^[a-z][a-z-]{2,40}$/.test(error.message)) return { kind: "error", message: `${error.message}: the model could not be converted.` };
      throw error;
    }
  }

  private async find(query: string): Promise<ModelOutcome> {
    const registry = await this.library.registry();
    const matches = registry.search(query, query ? 12 : 40);
    const all = registry.all();
    const installed = all.filter(entry => entry.installed);
    const head = `Model library: ${installed.length} installed (${installed.map(e => e.manifest.name).join(", ") || "none"}), ${all.length - installed.length} catalogued references.`;
    if (!matches.length) return { kind: "text", message: `${head} Nothing matches "${query}".` };
    const lines = (query ? matches : matches.filter(m => m.entry.installed).concat(matches.filter(m => !m.entry.installed).slice(0, 8))).map(m => `- ${entryLine(m.entry)}`);
    return { kind: "text", message: `${head}\n${query ? `Matches for "${query}":` : "Installed first:"}\n${lines.join("\n")}` };
  }

  private async show(request: ModelRequest, current: CurrentModel | null): Promise<ModelOutcome> {
    const registry = await this.library.registry();
    let entry: RegistryEntry | null = null;
    if (!request.model) {
      if (!current) {
        const installed = registry.all().filter(e => e.installed).map(e => e.manifest.name);
        return { kind: "error", message: `invalid-arguments: name a model. Installed: ${installed.join(", ") || "none"}.` };
      }
      entry = registry.get(current.model) ?? null;
    } else if (/^(another|next|other|different)(\s+(one|model|character))?$/i.test(request.model.trim())) {
      // "Show me another character": the next installed model after the one on show.
      const installed = registry.all().filter(e => e.installed).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
      const characters = installed.filter(e => e.manifest.category === "character" || e.manifest.category === "creature" || e.manifest.category === "animal");
      const pool = characters.length > 1 ? characters : installed;
      const at = pool.findIndex(e => e.manifest.id === current?.model);
      entry = pool[(at + 1) % Math.max(1, pool.length)] ?? null;
    } else {
      const found = registry.get(request.model);
      if (found?.installed) entry = found;
      else {
        const resolved = registry.resolve(request.model);
        entry = resolved.model;
        if (!entry) {
          if (resolved.references.length || found) {
            const references = (found ? [found, ...resolved.references.filter(r => r !== found)] : resolved.references).slice(0, 3);
            const usable = references.filter(r => !r.manifest.rights.extractedGameAsset || r.manifest.rights.extractedGameAsset === "no");
            return {
              kind: "error",
              message: `model-not-installed: "${request.model}" is catalogued but no model of it is installed, so Aion will not show a substitute. `
                + `References (${resolved.references.length || 1}):\n${references.map(r => `- ${entryLine(r)}`).join("\n")}\n`
                + `Aion never downloads models. If the user wants it, they may download one from its source under its licence (a fan model of a franchise character is for their own private use; its design belongs to the rights holder) `
                + `and import it: show_model action import, file (absolute path), model ${usable[0]?.manifest.id ?? "<catalogue id>"}.`,
            };
          }
          const installed = registry.all().filter(e => e.installed).map(e => e.manifest.name);
          return { kind: "error", message: `model-unknown: the library has no model of "${request.model}". Installed: ${installed.join(", ") || "none"}. The user can import a model file they have (action import). Do not show something else instead.` };
        }
      }
    }
    if (!entry) return { kind: "error", message: "model-unknown: no installed model to show." };
    const manifest = entry.manifest;
    const detail = request.detail ?? manifest.particle?.detail ?? "high";
    const stop = request.animation !== undefined && /^(stop|none|still|off)$/i.test(request.animation);
    const same = current?.model === manifest.id;
    const clip = stop ? undefined : request.animation ?? (same && !request.detail ? current?.animation : undefined);
    const colors = request.colors ?? (same ? current!.colors : manifest.particle?.colors ?? "original");
    const converted = await this.library.particles(manifest.id, detail, clip);
    const playing = Boolean(converted.animation) && !stop;
    const clips = converted.info.animations;
    const facts = [
      `${converted.count.toLocaleString("en")} particles`, converted.cached ? `loaded in ${converted.ms} ms (cached)` : `converted in ${converted.ms} ms`,
      clips.length ? `its own animations: ${clips.join(", ")}` : "no animation of its own (it can only be turned: set_scene_view)",
    ];
    const playingWords = playing ? `, playing "${converted.animation!.name}"` : "";
    return {
      kind: "show", converted, colors, playing,
      message: `Formed ${manifest.name} (${colors === "original" ? "original colours" : "Aion silver"}${playingWords}) — ${facts.join("; ")}. Credit: ${creditLine(manifest)}.`,
    };
  }
}
