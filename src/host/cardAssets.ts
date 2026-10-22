import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetError, GLB_MIME, GLTF_LIMITS, packGltf, selfContainedGlb, validateGlb, type GltfInfo } from "../cards/assets/gltf";

/**
 * Models for interactive cards (v0.4.5), read on the host and handed to Aion's hub as validated, self-contained GLB
 * bytes. Sources: a model bundled with the plugin (by name), or a .glb/.gltf file on this machine that the user named
 * (an absolute path). A .gltf's buffers and images are read from its own folder only and packed into the GLB; nothing is
 * ever downloaded, and no path ever reaches a card. Errors are short, model-safe codes with a readable detail.
 */
export const BUNDLED_MODELS = {
  transformer: { file: "cards/transformer.glb", title: "Single-phase transformer (demonstration)" },
} as const;
export type BundledModel = keyof typeof BUNDLED_MODELS;
export const BUNDLED_MODEL_NAMES = Object.keys(BUNDLED_MODELS) as BundledModel[];

export interface LoadedModel { bytes: Buffer; name: string; title: string; sha256: string; mime: typeof GLB_MIME; info: GltfInfo; bundled: boolean }

export { AssetError };

/** Reads, packs and validates a model; throws AssetError. */
export async function loadModel(source: string, assetsDir: string | undefined): Promise<LoadedModel> {
  const value = source.trim();
  const bundled = BUNDLED_MODELS[value.toLowerCase() as BundledModel];
  if (bundled) {
    if (!assetsDir) throw new AssetError("model-unavailable", "The bundled models are not installed.");
    const bytes = await readFile(join(assetsDir, bundled.file));
    return finish(bytes, basename(bundled.file), bundled.title, true);
  }
  if (/^https?:\/\//i.test(value)) throw new AssetError("remote-model-not-supported", "Aion does not download models. Save the file locally and pass its absolute path.");
  let path = value;
  if (/^file:\/\//i.test(value)) {
    try { path = fileURLToPath(value); } catch { throw new AssetError("model-invalid", "The file:// URL is not valid."); }
  }
  if (!isAbsolute(path)) throw new AssetError("model-path-not-absolute", `Pass an absolute path to a .glb or .gltf file, or a bundled model (${BUNDLED_MODEL_NAMES.join(", ")}).`);
  const ext = extname(path).toLowerCase();
  if (ext !== ".glb" && ext !== ".gltf") throw new AssetError("model-type", "Supported model files: .glb and .gltf (glTF 2.0).");
  let real: string;
  try { real = await realpath(path); } catch { throw new AssetError("model-not-found", "The model file does not exist."); }
  const info = await stat(real);
  if (!info.isFile()) throw new AssetError("model-not-found", "The path is not a file.");
  if (info.size > GLTF_LIMITS.bytes) throw new AssetError("model-too-large", `Models are limited to ${GLTF_LIMITS.bytes / 1024 / 1024} MB.`);
  const raw = await readFile(real);
  const name = basename(real);
  if (ext === ".glb") return finish(raw, name, name.replace(/\.glb$/i, ""), false);
  // A .gltf: its relative files come from its own folder (never above it), and are packed into one GLB.
  const folder = dirname(real);
  let total = raw.byteLength;
  const packed = await packGltf(raw.toString("utf8"), async relative => {
    let file: string;
    try { file = await realpath(join(folder, relative)); } catch { throw new AssetError("model-dependency-missing", `The model refers to ${relative.slice(0, 80)}, which does not exist beside it.`); }
    if (!file.startsWith(folder + sep)) throw new AssetError("external-dependency", `The model refers to ${relative.slice(0, 80)} outside its folder.`);
    const data = await readFile(file);
    total += data.byteLength;
    if (total > GLTF_LIMITS.bytes) throw new AssetError("model-too-large", `Models are limited to ${GLTF_LIMITS.bytes / 1024 / 1024} MB with their files.`);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  });
  return finish(Buffer.from(packed), name.replace(/\.gltf$/i, ".glb"), name.replace(/\.gltf$/i, ""), false);
}

/** v0.7: a GLB Aion made itself (the FreeCAD preview): the same validation as a model from a file. Throws AssetError. */
export function modelFromBytes(bytes: Uint8Array, name: string, title: string): Promise<LoadedModel> {
  return finish(bytes, name, title, false);
}

async function finish(bytes: Uint8Array, name: string, title: string, bundled: boolean): Promise<LoadedModel> {
  const contained = await selfContainedGlb(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const info = validateGlb(contained);
  const buffer = Buffer.from(contained.buffer, contained.byteOffset, contained.byteLength);
  return { bytes: buffer, name: name.slice(0, 120), title: title.slice(0, 80) || "Model", sha256: createHash("sha256").update(buffer).digest("hex"), mime: GLB_MIME, info, bundled };
}
