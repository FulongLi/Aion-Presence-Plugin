import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetError, packGltf, selfContainedGlb, validateGlb, GLTF_LIMITS, type GltfInfo } from "../../cards/assets/gltf";
import { GltfModel } from "../../visual/models/gltf";
import { readObj, parseMtl } from "../../visual/models/obj";
import { readStl } from "../../visual/models/stl";
import { geometryToGlb } from "../../visual/models/writeGltf";
import { sampleModel, type SampleReport } from "../../visual/models/sampler";
import { bakeAnimation } from "../../visual/models/animation";
import { encodeBundle } from "../../visual/models/bundle";
import type { ModelImage } from "../../visual/models/geometry";
import {
  CATALOGUE_SCHEMA, DETAIL_COUNTS, MODEL_SCHEMA, modelCatalogue, validateManifest, type ModelDetail, type ModelManifest,
} from "../../visual/models/manifest";
import { ModelRegistry, normalizeName, type RegistryEntry } from "../../visual/models/registry";
import { presenceHome } from "../paths";
import { colourImages, decodeTextures } from "./textures";

/**
 * Aion's model library on this machine (v0.9). Three places, never mixed:
 *
 *   - the plugin's own `assets/models/`: bundled redistributable models (`library.json` + GLB files) and reference
 *     catalogues (`catalogue/*.json`: sources only, no files) — read-only, shipped with the plugin;
 *   - the user's library in the plugin data directory (`models/library.json`, `models/files/`): models the user downloaded
 *     themselves and imported — local only, never uploaded, never redistributed;
 *   - the particle cache (`models/cache/`): converted particle bundles, keyed by the model file's hash, the detail level,
 *     the clip and the converter version, so a model is converted once and loads instantly after.
 *
 * Aion never downloads a model: an import is always a file the user names. Every file is checked before it is accepted
 * (type by content, size, the glTF policy: self-contained, bounded, no decoder extensions) and converted once, so a
 * malformed model fails at import with a readable reason instead of reaching the renderer.
 */
export const LIBRARY_SCHEMA = "aion.model-library/1";
/** v2 (0.9.1): bundles are quantized over the extent of every frame (v1 clamped animated frames to the rest pose's). */
export const CONVERTER_VERSION = 2;
export const MODEL_LIBRARY_LIMITS = { ...GLTF_LIMITS, bytes: 96 * 1024 * 1024, textureSize: 8192, triangles: 3_000_000 };
/** A baked clip may add at most this much to a bundle (the hub's media store keeps items under 8 MB). */
const CLIP_BYTES = 6 * 1024 * 1024;
export const IMPORT_TYPES = [".glb", ".gltf", ".obj", ".stl"] as const;

export class ModelLibraryError extends Error {
  constructor(code: string, readonly detail: string) { super(code); this.name = "ModelLibraryError"; }
}
const fail = (code: string, detail: string): never => { throw new ModelLibraryError(code, detail); };

interface LibraryRecord { manifest: ModelManifest; file: string; sha256: string; bytes: number; imported: string; info: ModelInfo }
export interface ModelInfo { triangles: number; meshes: number; textures: number; animations: string[]; warnings: string[]; joints?: number; morphTargets?: number }
interface LibraryFile { schema: typeof LIBRARY_SCHEMA; entries: LibraryRecord[] }

export interface Provenance {
  /** A catalogue entry this file is (its source, author and licence are copied). */
  catalogue?: string;
  name?: string;
  source?: { url?: string; author?: string; licence?: string };
  /** v0.9.1: who owns the depicted design, when the user knows (a franchise character is third-party). */
  rights?: { underlyingIp: "original" | "third-party" | "public-domain" | "unknown"; ipOwner?: string; notes?: string };
  category?: ModelManifest["category"];
}

export interface ConvertedModel {
  /** The cache key (model file hash, detail, clip, converter version): equal keys are equal bundles. */
  key: string;
  bundle: Uint8Array; manifest: ModelManifest; count: number; cached: boolean; ms: number;
  animation?: { name: string; frames: number; fps: number };
  report?: SampleReport; info: ModelInfo;
}

const today = () => new Date().toISOString().slice(0, 10);
const slug = (value: string) => normalizeName(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "model";

export class ModelLibrary {
  readonly root: string;
  private registryCache: ModelRegistry | null = null;
  private user: LibraryFile | null = null;
  private bundled: { manifest: ModelManifest; path: string }[] = [];
  private readonly memory = new Map<string, Uint8Array>();
  readonly catalogueProblems: string[] = [];

  constructor(private readonly options: { home?: string; assetsDir?: string } = {}) {
    this.root = join(options.home ?? presenceHome(), "models");
  }

  private get assets() { return this.options.assetsDir ? join(this.options.assetsDir, "models") : null; }

  /** Reads the bundled catalogues and the user's library (once; again after an import or removal). */
  async registry(): Promise<ModelRegistry> {
    if (this.registryCache) return this.registryCache;
    const registry = new ModelRegistry();
    this.bundled = [];
    const assets = this.assets;
    if (assets && existsSync(assets)) {
      const files = [join(assets, "library.json"), ...(existsSync(join(assets, "catalogue")) ? (await readdir(join(assets, "catalogue"))).filter(f => f.endsWith(".json")).sort().map(f => join(assets, "catalogue", f)) : [])];
      for (const file of files) {
        if (!existsSync(file)) continue;
        const parsed = modelCatalogue.safeParse(JSON.parse(await readFile(file, "utf8")));
        if (!parsed.success) { this.catalogueProblems.push(`${basename(file)}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`); continue; }
        for (const manifest of parsed.data.entries) {
          const path = manifest.file ? join(assets, manifest.file) : null;
          const installed = Boolean(path && manifest.availability === "redistributable" && existsSync(path));
          if (installed) this.bundled.push({ manifest, path: path! });
          registry.add({ manifest, installed });
        }
      }
    }
    for (const record of (await this.userLibrary()).entries) registry.add({ manifest: record.manifest, installed: existsSync(join(this.root, record.file)) });
    this.registryCache = registry;
    return registry;
  }

  private async userLibrary(): Promise<LibraryFile> {
    if (this.user) return this.user;
    const path = join(this.root, "library.json");
    let entries: LibraryRecord[] = [];
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as LibraryFile;
        if (raw?.schema === LIBRARY_SCHEMA && Array.isArray(raw.entries)) {
          entries = raw.entries.filter(record => validateManifest(record?.manifest).ok && typeof record.file === "string" && /^files\/[a-z0-9-]+\.glb$/.test(record.file));
        }
      } catch { /* an unreadable library is treated as empty, never overwritten silently: imports write a fresh file */ }
    }
    this.user = { schema: LIBRARY_SCHEMA, entries };
    return this.user;
  }

  private async saveUser() {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, "library.json"), temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.user, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    this.registryCache = null;
  }

  /** The model file of an installed entry (a validated, self-contained GLB). */
  async modelBytes(id: string): Promise<Uint8Array> {
    await this.registry();
    const bundled = this.bundled.find(entry => entry.manifest.id === id);
    if (bundled) return new Uint8Array(await readFile(bundled.path));
    const record = (await this.userLibrary()).entries.find(entry => entry.manifest.id === id);
    if (!record) fail("model-not-installed", `No installed model has the id ${id}.`);
    return new Uint8Array(await readFile(join(this.root, record!.file)));
  }

  /**
   * Imports a model file the user named (an absolute path or file:// URL): .glb, .gltf (with its files from its own folder),
   * .obj (+ .mtl and textures from its folder) or .stl. The file is validated and converted once before it is accepted.
   */
  async importFile(source: string, provenance: Provenance = {}): Promise<{ manifest: ModelManifest; info: ModelInfo; duplicate: boolean }> {
    const value = source.trim();
    if (/^https?:\/\//i.test(value)) fail("remote-model-not-supported", "Aion does not download models. Download the file yourself (respecting its licence) and give its absolute path.");
    let path = value;
    if (/^file:\/\//i.test(value)) { try { path = fileURLToPath(value); } catch { fail("model-invalid", "The file:// URL is not valid."); } }
    if (!isAbsolute(path)) fail("model-path-not-absolute", "Give the absolute path of the model file.");
    const ext = extname(path).toLowerCase();
    if (ext === ".fbx" || ext === ".blend" || ext === ".dae" || ext === ".3ds" || ext === ".usdz") {
      fail("model-type", `${ext} files need converting first: export the model as glTF binary (.glb), e.g. in Blender (File → Export → glTF 2.0), then import the .glb.`);
    }
    if (!(IMPORT_TYPES as readonly string[]).includes(ext)) fail("model-type", "Supported model files: .glb, .gltf, .obj (with its .mtl) and .stl.");
    let real: string;
    try { real = await realpath(path); } catch { return fail("model-not-found", "The model file does not exist."); }
    const info = await stat(real);
    if (!info.isFile()) fail("model-not-found", "The path is not a file.");
    if (info.size > MODEL_LIBRARY_LIMITS.bytes) fail("model-too-large", `Model files are limited to ${MODEL_LIBRARY_LIMITS.bytes / 1024 / 1024} MB.`);
    const folder = dirname(real);
    let total = info.size;
    const sibling = async (relative: string) => {
      let file: string;
      try { file = await realpath(join(folder, relative)); } catch { return fail("model-dependency-missing", `The model refers to ${relative.slice(0, 80)}, which is not beside it.`); }
      if (!file.startsWith(folder + sep)) fail("external-dependency", `The model refers to ${relative.slice(0, 80)} outside its folder.`);
      const data = await readFile(file);
      total += data.byteLength;
      if (total > MODEL_LIBRARY_LIMITS.bytes) fail("model-too-large", `Models are limited to ${MODEL_LIBRARY_LIMITS.bytes / 1024 / 1024} MB with their files.`);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    };
    const raw = await readFile(real);
    let glb: Uint8Array;
    try {
      if (ext === ".glb") glb = await selfContainedGlb(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      else if (ext === ".gltf") glb = await packGltf(raw.toString("utf8"), sibling);
      else if (ext === ".stl") glb = geometryToGlb(readStl(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), basename(real));
      else {
        const text = raw.toString("utf8");
        const mtlName = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
        const materials = mtlName ? parseMtl(new TextDecoder().decode(await sibling(mtlName).catch(() => new Uint8Array()))) : [];
        const textures = new Map<string, ModelImage>();
        for (const material of materials) {
          if (!material.map || textures.has(material.map)) continue;
          const data = await sibling(material.map).catch(() => null);
          if (data && ((data[0] === 0x89 && data[1] === 0x50) || (data[0] === 0xff && data[1] === 0xd8))) textures.set(material.map, { mime: data[0] === 0x89 ? "image/png" : "image/jpeg", data });
        }
        glb = geometryToGlb(readObj(text, materials, textures), basename(real));
      }
    } catch (error) {
      if (error instanceof ModelLibraryError) throw error;
      if (error instanceof AssetError) fail(error.message, error.detail);
      fail("model-invalid", error instanceof Error && "detail" in error ? String((error as { detail: unknown }).detail) : "The model file could not be read.");
    }
    const gltf = this.check(glb!);
    const sha256 = createHash("sha256").update(glb!).digest("hex");
    const library = await this.userLibrary();
    const existing = library.entries.find(record => record.sha256 === sha256);
    if (existing) return { manifest: existing.manifest, info: existing.info, duplicate: true };
    const registry = await this.registry();
    const catalogued = provenance.catalogue ? registry.get(provenance.catalogue)?.manifest : undefined;
    if (provenance.catalogue && !catalogued) fail("catalogue-unknown", `No catalogue entry has the id ${provenance.catalogue}.`);
    if (catalogued?.rights.extractedGameAsset && catalogued.rights.extractedGameAsset !== "no") {
      fail("model-not-permitted", "This catalogue reference is restricted: it appears to be extracted from a commercial game, and Aion does not import it.");
    }
    const name = (provenance.name ?? catalogued?.name ?? basename(real).replace(/\.[^.]+$/, "")).trim().slice(0, 80) || "Model";
    let id = catalogued?.id ?? `my-${slug(name)}`;
    for (let n = 2; library.entries.some(record => record.manifest.id === id) || (!catalogued && registry.get(id)); n++) id = `${catalogued?.id ?? `my-${slug(name)}`}-${n}`.slice(0, 64);
    const manifest: ModelManifest = catalogued
      ? { ...catalogued, id, availability: "local", download: { ...catalogued.download, status: "downloaded" }, checked: today(), file: undefined }
      : {
        schema: MODEL_SCHEMA, id, name, category: provenance.category ?? "other",
        source: {
          site: "local file", ...(provenance.source?.url && /^https:\/\//.test(provenance.source.url) ? { url: provenance.source.url.slice(0, 400) } : {}),
          title: name, author: provenance.source?.author?.slice(0, 80) || "unknown", formats: [ext.slice(1)],
        },
        licence: {
          id: /^[A-Za-z0-9.+-]{2,40}$/.test(provenance.source?.licence ?? "") ? provenance.source!.licence! : "unknown", label: provenance.source?.licence?.slice(0, 80) || "unknown (the user's own file)",
          modification: "unknown", redistribution: "unknown", commercial: "unknown",
        },
        rights: {
          underlyingIp: provenance.rights?.underlyingIp ?? "unknown", ...(provenance.rights?.ipOwner ? { ipOwner: provenance.rights.ipOwner.slice(0, 120) } : {}),
          redistributionVerified: false, notes: (provenance.rights?.notes ?? "Imported by the user from a local file; kept on this machine only.").slice(0, 400),
        },
        availability: "local", download: { available: false, method: "manual", requiresAccount: false, status: "downloaded" }, checked: today(),
      };
    delete (manifest as { file?: string }).file;
    manifest.stats = { triangles: gltf.info.triangles, textures: gltf.info.textures, animations: gltf.animations.length };
    const checked = validateManifest(manifest);
    if (!checked.ok) return fail("manifest-invalid", checked.problem);
    // Convert once now: a model that cannot become particles is refused here, not when it is first shown.
    const modelInfo = this.describe(gltf);
    this.convertGlb(glb!, checked.manifest, "high");
    const file = `files/${id}.glb`;
    await mkdir(join(this.root, "files"), { recursive: true });
    await writeFile(join(this.root, file), glb!, { mode: 0o600 });
    library.entries.push({ manifest: checked.manifest, file, sha256, bytes: glb!.byteLength, imported: new Date().toISOString(), info: modelInfo });
    await this.saveUser();
    return { manifest: checked.manifest, info: modelInfo, duplicate: false };
  }

  /** Removes an imported model, its file and its cached particles. Bundled models and catalogue entries stay. */
  async remove(id: string): Promise<boolean> {
    const library = await this.userLibrary();
    const index = library.entries.findIndex(record => record.manifest.id === id);
    if (index < 0) return false;
    const [record] = library.entries.splice(index, 1);
    await rm(join(this.root, record.file), { force: true });
    if (existsSync(join(this.root, "cache"))) {
      for (const file of await readdir(join(this.root, "cache"))) if (file.startsWith(`${record.sha256.slice(0, 16)}-`)) await rm(join(this.root, "cache", file), { force: true });
    }
    for (const key of [...this.memory.keys()]) if (key.startsWith(record.sha256.slice(0, 16))) this.memory.delete(key);
    await this.saveUser();
    return true;
  }

  /** Validates a GLB against the library's policy and opens it. */
  private check(glb: Uint8Array): { model: GltfModel; info: GltfInfo; animations: string[] } {
    let info: GltfInfo;
    try { info = validateGlb(glb, MODEL_LIBRARY_LIMITS); } catch (error) {
      if (error instanceof AssetError) return fail(error.message, error.detail);
      throw error;
    }
    const model = new GltfModel(glb);
    return { model, info, animations: model.animations.map(a => a.name) };
  }

  private readonly described = new Map<string, ModelInfo>();
  private describe(gltf: { model: GltfModel; info: GltfInfo; animations: string[] }, key?: string): ModelInfo {
    const known = key ? this.described.get(key) : undefined;
    if (known) return known;
    const geometry = gltf.model.geometry();
    const info = {
      triangles: gltf.info.triangles, meshes: gltf.info.meshes, textures: gltf.info.images, animations: gltf.animations, warnings: geometry.warnings.slice(0, 8),
      joints: gltf.model.joints, morphTargets: gltf.model.morphTargets,
    };
    if (key) this.described.set(key, info);
    return info;
  }

  private convertGlb(glb: Uint8Array, manifest: ModelManifest, detail: ModelDetail, animation?: string) {
    const gltf = this.check(glb);
    const geometry = gltf.model.geometry();
    const warnings = [...geometry.warnings];
    const textures = decodeTextures(geometry.images, warnings, colourImages(geometry.materials));
    const exclude = (manifest.particle?.exclude ?? []).map(value => value.toLowerCase());
    const { particles, surface, report } = sampleModel(geometry, {
      count: DETAIL_COUNTS[detail], textures,
      orientation: manifest.particle?.orientation ? { ...manifest.particle.orientation, rotate: manifest.particle.orientation.rotate as [number, number, number] | undefined } : undefined,
      exclude: exclude.length ? material => exclude.some(word => material.name.toLowerCase().includes(word)) : undefined,
    });
    let clip: { name: string; frames: Float32Array[]; fps: number } | null = null;
    if (animation !== undefined) {
      const index = gltf.model.animations.findIndex(a => normalizeName(a.name) === normalizeName(animation));
      if (index < 0) fail("animation-unknown", gltf.animations.length ? `This model's animations: ${gltf.animations.join(", ")}.` : "This model has no animation of its own.");
      const baked = bakeAnimation(gltf.model, surface, { animation: index, maxFrames: Math.max(2, Math.floor(CLIP_BYTES / (particles.count * 6))) });
      clip = { name: gltf.model.animations[index].name, frames: baked.frames, fps: baked.fps };
    }
    const bundle = encodeBundle({ ...particles, frames: clip?.frames ?? [], fps: clip?.fps ?? 0 });
    return { bundle, count: particles.count, report, info: { ...this.describe(gltf), warnings: warnings.slice(0, 8) }, ...(clip ? { animation: { name: clip.name, frames: clip.frames.length, fps: clip.fps } } : {}) };
  }

  /** The particle bundle of an installed model (cached on disk and in memory). */
  async particles(id: string, detail: ModelDetail = "high", animation?: string): Promise<ConvertedModel> {
    const registry = await this.registry();
    const entry = registry.get(id);
    if (!entry?.installed) fail("model-not-installed", `The model ${id} is not installed.`);
    const started = performance.now();
    const glb = await this.modelBytes(id);
    const sha = createHash("sha256").update(glb).digest("hex").slice(0, 16);
    const clipKey = animation ? `-${slug(animation)}` : "";
    const key = `${sha}-${detail}${clipKey}-v${CONVERTER_VERSION}`;
    const info = this.described.get(sha) ?? this.describe(this.check(glb), sha);
    const memory = this.memory.get(key);
    const cachePath = join(this.root, "cache", `${key}.aipm`);
    const finish = (bundle: Uint8Array, cached: boolean, extra: Partial<ConvertedModel> = {}): ConvertedModel => {
      this.memory.set(key, bundle);
      while (this.memory.size > 4) this.memory.delete(this.memory.keys().next().value!);
      const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
      const frames = view.getUint16(6, true);
      return {
        key, bundle, manifest: entry!.manifest, count: view.getUint32(8, true), cached, ms: Math.round(performance.now() - started), info,
        ...(animation && frames ? { animation: { name: animation, frames, fps: view.getFloat32(16, true) } } : {}), ...extra,
      };
    };
    if (memory) return finish(memory, true);
    if (existsSync(cachePath)) {
      const bytes = new Uint8Array(await readFile(cachePath));
      if (bytes.length > 20) return finish(bytes, true);
    }
    const converted = this.convertGlb(glb, entry!.manifest, detail, animation);
    await mkdir(join(this.root, "cache"), { recursive: true });
    await writeFile(cachePath, converted.bundle, { mode: 0o600 });
    return finish(converted.bundle, false, { report: converted.report, info: converted.info, ...(converted.animation ? { animation: converted.animation } : {}) });
  }

  /** Writes a catalogue file (scripts: discovery and the bundled library). */
  static catalogueText(title: string, entries: ModelManifest[], description?: string): string {
    const catalogue = { schema: CATALOGUE_SCHEMA, title, ...(description ? { description } : {}), generated: today(), entries };
    const parsed = modelCatalogue.safeParse(catalogue);
    if (!parsed.success) throw new Error(`catalogue-invalid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    return `${JSON.stringify(catalogue, null, 2)}\n`;
  }
}

export type { RegistryEntry };
