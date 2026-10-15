import { CARD_LIMITS } from "../manifest";

/**
 * glTF 2.0 assets for interactive cards (v0.4.5): the policy every model passes before a card may see it. Aion accepts a
 * binary glTF (GLB) that is complete in itself — every buffer and image inside it — so a card never fetches anything:
 *
 *   - no external URIs: a .gltf with relative files is packed into one GLB on the host (packGltf), from its own folder
 *     only; http(s), absolute and parent-directory references are refused, never downloaded;
 *   - images PNG or JPEG within the texture size limit; no extension that needs a decoder Aion does not ship
 *     (Draco, meshopt, KTX2), with a clear error instead of a silent failure;
 *   - bounded counts (nodes, meshes, materials, accessors, textures, triangles) and consistent buffer ranges, and a node
 *     graph without cycles, so a malformed or hostile file cannot hang or exhaust the viewer.
 *
 * Pure (no Node or DOM): the host validates before storing, the tests exercise every rule.
 */
export const GLTF_LIMITS = {
  bytes: CARD_LIMITS.assetBytes,
  nodes: 10_000,
  meshes: 4_000,
  materials: 512,
  accessors: 20_000,
  textures: CARD_LIMITS.textures,
  textureSize: CARD_LIMITS.textureSize,
  triangles: CARD_LIMITS.triangles,
  depth: 64,
} as const;

export type GltfLimits = { [K in keyof typeof GLTF_LIMITS]: number };

/** Extensions a model may require (the viewer's loader implements them without any extra decoder). */
export const SUPPORTED_REQUIRED_EXTENSIONS = [
  "KHR_materials_emissive_strength", "KHR_materials_unlit", "KHR_texture_transform", "KHR_mesh_quantization", "KHR_materials_ior",
  "KHR_materials_specular", "KHR_materials_transmission", "KHR_materials_clearcoat", "KHR_materials_volume", "KHR_materials_sheen", "KHR_materials_iridescence",
] as const;
/** Extensions that would need code Aion does not ship. */
const DECODER_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu", "EXT_texture_webp", "EXT_texture_avif"];

export const GLB_MIME = "model/gltf-binary";

export class AssetError extends Error {
  constructor(code: string, readonly detail: string) { super(code); this.name = "AssetError"; }
}

export interface GltfInfo {
  triangles: number; nodes: number; meshes: number; materials: number; textures: number; images: number;
  /** Named nodes (for logs and tool results), at most 12. */
  names: string[];
  generator?: string;
}

interface GltfJson {
  asset?: { version?: string; generator?: string };
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  buffers?: { uri?: string; byteLength?: number }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }[];
  accessors?: { bufferView?: number; byteOffset?: number; count?: number; componentType?: number; type?: string; sparse?: unknown }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  textures?: { source?: number }[];
  materials?: unknown[];
  meshes?: { name?: string; primitives?: { attributes?: Record<string, number>; indices?: number; mode?: number }[] }[];
  nodes?: { name?: string; mesh?: number; children?: number[] }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  [key: string]: unknown;
}

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+)?(;base64)?,(.*)$/is;

function fail(code: string, detail: string): never { throw new AssetError(code, detail); }
const isIndex = (value: unknown, length: number) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;

/** Splits a GLB into its JSON and binary chunk (or throws AssetError). */
export function readGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  if (bytes.byteLength < 20) fail("model-invalid", "The file is too short to be a GLB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) fail("model-invalid", "Not a binary glTF (GLB) file.");
  if (view.getUint32(4, true) !== 2) fail("model-unsupported", "Only glTF 2.0 is supported.");
  const length = view.getUint32(8, true);
  if (length !== bytes.byteLength) fail("model-invalid", "The GLB length does not match the file (truncated or padded).");
  let offset = 12, json: GltfJson | null = null, bin: Uint8Array | null = null;
  while (offset < length) {
    if (offset + 8 > length) fail("model-invalid", "A GLB chunk header is truncated.");
    const chunkLength = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    const start = offset + 8, end = start + chunkLength;
    if (end > length) fail("model-invalid", "A GLB chunk runs past the end of the file.");
    if (type === CHUNK_JSON) {
      if (json) fail("model-invalid", "The GLB has two JSON chunks.");
      try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end))) as GltfJson; } catch { fail("model-invalid", "The GLB's JSON chunk is not valid JSON."); }
    } else if (type === CHUNK_BIN) {
      if (bin) fail("model-invalid", "The GLB has two binary chunks.");
      bin = bytes.subarray(start, end);
    }
    offset = end;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("model-invalid", "The GLB has no JSON chunk.");
  return { json: json!, bin };
}

/** The pixel size of a PNG or JPEG, from its header; null when it is neither. */
export function imageDimensions(data: Uint8Array): { mime: string; width: number; height: number } | null {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i++; continue; }
      const marker = data[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const size = (data[i + 2] << 8) | data[i + 3];
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { mime: "image/jpeg", height: (data[i + 5] << 8) | data[i + 6], width: (data[i + 7] << 8) | data[i + 8] };
      }
      i += 2 + size;
    }
    return { mime: "image/jpeg", width: 0, height: 0 };
  }
  return null;
}

function decodeDataUri(uri: string): { mime: string | undefined; data: Uint8Array } {
  const match = DATA_URI.exec(uri);
  if (!match) fail("model-invalid", "A data: URI in the model is malformed.");
  const [, mime, base64, body] = match!;
  if (!base64) fail("model-unsupported", "Only base64 data: URIs are supported in models.");
  try {
    const binary = atob(body.replace(/\s+/g, ""));
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return { mime, data };
  } catch { return fail("model-invalid", "A data: URI in the model is not valid base64."); }
}

/**
 * Checks a GLB against the policy. Returns what it contains, or throws AssetError with a short code (model-invalid,
 * model-unsupported, model-too-large, external-dependency, unsupported-extension) and a readable detail.
 */
export function validateGlb(bytes: Uint8Array, limits: GltfLimits = GLTF_LIMITS): GltfInfo {
  if (bytes.byteLength > limits.bytes) fail("model-too-large", `Models are limited to ${(limits.bytes / 1024 / 1024).toFixed(0)} MB.`);
  const { json, bin } = readGlb(bytes);
  if (json.asset?.version !== "2.0") fail("model-unsupported", "The model must declare glTF version 2.0.");
  const required = json.extensionsRequired ?? [];
  if (!Array.isArray(required)) fail("model-invalid", "extensionsRequired must be a list.");
  for (const extension of required) {
    if (DECODER_EXTENSIONS.includes(extension)) fail("unsupported-extension", `${extension} needs a decoder Aion does not include; export the model without it.`);
    if (!(SUPPORTED_REQUIRED_EXTENSIONS as readonly string[]).includes(extension)) fail("unsupported-extension", `The model requires ${String(extension).slice(0, 60)}, which the viewer does not support.`);
  }
  const list = <T>(value: T[] | undefined, what: string, max: number): T[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail("model-invalid", `${what} must be a list.`);
    if (value.length > max) fail("model-too-large", `The model has ${value.length} ${what} (at most ${max}).`);
    return value;
  };
  const buffers = list(json.buffers, "buffers", 64);
  const views = list(json.bufferViews, "bufferViews", 50_000);
  const accessors = list(json.accessors, "accessors", limits.accessors);
  const images = list(json.images, "images", limits.textures);
  const textures = list(json.textures, "textures", limits.textures);
  const materials = list(json.materials, "materials", limits.materials);
  const meshes = list(json.meshes, "meshes", limits.meshes);
  const nodes = list(json.nodes, "nodes", limits.nodes);
  const scenes = list(json.scenes, "scenes", 64);

  // Buffers: the GLB's own binary chunk (no uri), or embedded base64 — never a file or a URL.
  const bufferLengths = buffers.map((buffer, index) => {
    if (!buffer || typeof buffer !== "object") fail("model-invalid", `buffer ${index} is not an object.`);
    if (!Number.isInteger(buffer.byteLength) || buffer.byteLength! < 0) fail("model-invalid", `buffer ${index} has no byteLength.`);
    if (buffer.uri === undefined) {
      if (index !== 0 || !bin) fail("model-invalid", `buffer ${index} has no data.`);
      if (buffer.byteLength! > bin!.byteLength) fail("model-invalid", "The binary chunk is shorter than its buffer.");
      return buffer.byteLength!;
    }
    if (typeof buffer.uri !== "string" || !buffer.uri.startsWith("data:")) fail("external-dependency", "The model refers to an external file; Aion accepts only self-contained models (pack it as GLB).");
    const decoded = decodeDataUri(buffer.uri!);
    if (decoded.data.byteLength < buffer.byteLength!) fail("model-invalid", `buffer ${index} is shorter than declared.`);
    return buffer.byteLength!;
  });
  views.forEach((view, index) => {
    if (!view || !isIndex(view.buffer, buffers.length)) fail("model-invalid", `bufferView ${index} names no buffer.`);
    const offset = view.byteOffset ?? 0, length = view.byteLength;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length! < 1 || offset + length! > bufferLengths[view.buffer!]) fail("model-invalid", `bufferView ${index} lies outside its buffer.`);
    if (view.byteStride !== undefined && (!Number.isInteger(view.byteStride) || view.byteStride < 4 || view.byteStride > 252)) fail("model-invalid", `bufferView ${index} has an invalid stride.`);
  });
  accessors.forEach((accessor, index) => {
    const size = COMPONENT_BYTES[accessor?.componentType ?? -1], components = TYPE_COMPONENTS[accessor?.type ?? ""];
    if (!size || !components || !Number.isInteger(accessor.count) || accessor.count! < 1 || accessor.count! > 50_000_000) fail("model-invalid", `accessor ${index} is malformed.`);
    if (accessor.bufferView === undefined) { if (!accessor.sparse) fail("model-invalid", `accessor ${index} has no data.`); return; }
    if (!isIndex(accessor.bufferView, views.length)) fail("model-invalid", `accessor ${index} names no bufferView.`);
    const view = views[accessor.bufferView!], element = size * components, stride = view.byteStride ?? element, offset = accessor.byteOffset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset + stride * (accessor.count! - 1) + element > view.byteLength!) fail("model-invalid", `accessor ${index} reads past its bufferView.`);
  });
  // Images: embedded PNG or JPEG within the size limit.
  images.forEach((image, index) => {
    let data: Uint8Array | null = null;
    if (image?.uri !== undefined) {
      if (typeof image.uri !== "string" || !image.uri.startsWith("data:")) fail("external-dependency", "The model refers to an external image; Aion accepts only self-contained models (pack it as GLB).");
      data = decodeDataUri(image.uri).data;
    } else if (isIndex(image?.bufferView, views.length)) {
      const view = views[image.bufferView!], buffer = view.buffer!;
      if (buffer !== 0 || buffers[0]?.uri !== undefined || !bin) data = null;
      else data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength!);
    } else fail("model-invalid", `image ${index} has no data.`);
    if (data) {
      const found = imageDimensions(data);
      if (!found) fail("model-unsupported", `image ${index} is not PNG or JPEG.`);
      if (found!.width > limits.textureSize || found!.height > limits.textureSize) fail("model-too-large", `image ${index} is ${found!.width}×${found!.height} (at most ${limits.textureSize} px a side).`);
    }
  });
  textures.forEach((texture, index) => { if (texture?.source !== undefined && !isIndex(texture.source, images.length)) fail("model-invalid", `texture ${index} names no image.`); });
  // Meshes: valid accessors; triangles counted per primitive.
  const meshTriangles = meshes.map((mesh, index) => {
    const primitives = mesh?.primitives;
    if (!Array.isArray(primitives) || primitives.length < 1 || primitives.length > 256) fail("model-invalid", `mesh ${index} has no primitives.`);
    let triangles = 0;
    for (const primitive of primitives!) {
      const attributes = primitive?.attributes;
      if (!attributes || typeof attributes !== "object" || !isIndex(attributes.POSITION, accessors.length)) fail("model-invalid", `mesh ${index} has a primitive without positions.`);
      for (const value of Object.values(attributes)) if (!isIndex(value, accessors.length)) fail("model-invalid", `mesh ${index} names a missing accessor.`);
      if (primitive.indices !== undefined && !isIndex(primitive.indices, accessors.length)) fail("model-invalid", `mesh ${index} names missing indices.`);
      const count = accessors[primitive.indices ?? attributes.POSITION].count!;
      const mode = primitive.mode ?? 4;
      triangles += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
    }
    return triangles;
  });
  // Nodes: in range, a tree (no cycles, no node with two parents), bounded depth; triangles per instance.
  const parent = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, index) => {
    if (!node || typeof node !== "object") fail("model-invalid", `node ${index} is not an object.`);
    if (node.mesh !== undefined && !isIndex(node.mesh, meshes.length)) fail("model-invalid", `node ${index} names a missing mesh.`);
    for (const child of node.children ?? []) {
      if (!isIndex(child, nodes.length) || child === index) fail("model-invalid", `node ${index} has an invalid child.`);
      if (parent[child] !== -1) fail("model-invalid", `node ${child} has two parents.`);
      parent[child] = index;
    }
  });
  let triangles = 0;
  const visit = (index: number, depth: number, seen: Set<number>) => {
    if (depth > limits.depth) fail("model-too-large", `The node hierarchy is deeper than ${limits.depth}.`);
    if (seen.has(index)) fail("model-invalid", "The node hierarchy has a cycle.");
    seen.add(index);
    const node = nodes[index];
    if (node.mesh !== undefined) triangles += meshTriangles[node.mesh];
    for (const child of node.children ?? []) visit(child, depth + 1, seen);
  };
  const roots = nodes.map((_, index) => index).filter(index => parent[index] === -1);
  if (nodes.length && !roots.length) fail("model-invalid", "The node hierarchy has a cycle.");
  const seen = new Set<number>();
  for (const root of roots) visit(root, 0, seen);
  if (seen.size !== nodes.length) fail("model-invalid", "The node hierarchy has a cycle.");
  scenes.forEach((scene, index) => { for (const node of scene?.nodes ?? []) if (!isIndex(node, nodes.length)) fail("model-invalid", `scene ${index} names a missing node.`); });
  if (json.scene !== undefined && !isIndex(json.scene, scenes.length)) fail("model-invalid", "The default scene does not exist.");
  if (triangles > limits.triangles) fail("model-too-large", `The model has ${triangles.toLocaleString("en")} triangles (at most ${limits.triangles.toLocaleString("en")}).`);
  if (!meshes.length) fail("model-invalid", "The model contains no geometry.");
  const names = nodes.map(node => typeof node.name === "string" ? node.name.slice(0, 60) : "").filter(Boolean).slice(0, 12);
  return {
    triangles, nodes: nodes.length, meshes: meshes.length, materials: materials.length, textures: textures.length, images: images.length, names,
    ...(typeof json.asset?.generator === "string" ? { generator: json.asset.generator.slice(0, 80) } : {}),
  };
}

/**
 * Packs a .gltf (JSON) into one self-contained GLB. `resolve` returns the bytes of a relative file — the host allows only
 * files in the model's own folder; anything else must throw. data: URIs are embedded; every other URI is refused.
 */
export async function packGltf(text: string, resolve: (relative: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  let json: GltfJson;
  try { json = JSON.parse(text) as GltfJson; } catch { return fail("model-invalid", "The .gltf file is not valid JSON."); }
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("model-invalid", "The .gltf file is not a glTF document.");
  const load = async (uri: unknown, what: string): Promise<{ mime?: string; data: Uint8Array }> => {
    if (typeof uri !== "string" || !uri) return fail("model-invalid", `A ${what} has an empty URI.`);
    if (uri.startsWith("data:")) return decodeDataUri(uri);
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/") || uri.startsWith("\\") || uri.startsWith("//")) {
      return fail("external-dependency", `The model refers to ${uri.slice(0, 80)}; Aion never downloads or reads files outside the model's folder.`);
    }
    let path: string;
    try { path = decodeURIComponent(uri); } catch { return fail("model-invalid", `A ${what} URI is malformed.`); }
    if (path.split(/[\\/]/).some(part => part === ".." || part === "") || path.includes("\0")) return fail("external-dependency", `The model refers to ${uri.slice(0, 80)} outside its folder.`);
    return { data: await resolve(path) };
  };
  const chunks: Uint8Array[] = [];
  let length = 0;
  const append = (data: Uint8Array) => {
    const offset = length;
    chunks.push(data);
    length += data.byteLength;
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    return offset;
  };
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  const offsets: number[] = [];
  for (const [index, buffer] of buffers.entries()) {
    const loaded = await load(buffer?.uri, `buffer ${index}`);
    if (!Number.isInteger(buffer.byteLength) || loaded.data.byteLength < buffer.byteLength!) fail("model-invalid", `buffer ${index} is shorter than declared.`);
    offsets.push(append(loaded.data.subarray(0, buffer.byteLength)));
  }
  const views = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  for (const view of views) {
    if (!view || !isIndex(view.buffer, buffers.length)) fail("model-invalid", "A bufferView names no buffer.");
    view.byteOffset = (view.byteOffset ?? 0) + offsets[view.buffer!];
    view.buffer = 0;
  }
  for (const [index, image] of (Array.isArray(json.images) ? json.images : []).entries()) {
    if (image?.uri === undefined) continue;
    const loaded = await load(image.uri, `image ${index}`);
    const found = imageDimensions(loaded.data);
    if (!found) fail("model-unsupported", `image ${index} is not PNG or JPEG.`);
    views.push({ buffer: 0, byteOffset: append(loaded.data), byteLength: loaded.data.byteLength });
    image.bufferView = views.length - 1;
    image.mimeType = found!.mime;
    delete image.uri;
  }
  json.bufferViews = views;
  json.buffers = length ? [{ byteLength: length }] : [];
  if (length > GLTF_LIMITS.bytes) fail("model-too-large", `Models are limited to ${(GLTF_LIMITS.bytes / 1024 / 1024).toFixed(0)} MB.`);
  const bin = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bin.set(chunk, at); at += chunk.byteLength; }
  return writeGlb(json, bin);
}

/** Writes a GLB from glTF JSON and its binary chunk. */
export function writeGlb(json: object, bin: Uint8Array | null): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (encoded.byteLength % 4)) % 4;
  const binLength = bin ? bin.byteLength + ((4 - (bin.byteLength % 4)) % 4) : 0;
  const total = 12 + 8 + encoded.byteLength + jsonPad + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, encoded.byteLength + jsonPad, true); view.setUint32(16, CHUNK_JSON, true);
  out.set(encoded, 20);
  out.fill(0x20, 20 + encoded.byteLength, 20 + encoded.byteLength + jsonPad);
  if (bin) {
    const at = 20 + encoded.byteLength + jsonPad;
    view.setUint32(at, binLength, true); view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

/**
 * A GLB whose buffers and images are all inside its binary chunk: embedded data: URIs (allowed by the policy) are moved
 * into it, because the card's sandbox may not fetch even data: URLs. Returns the same bytes when nothing needs moving.
 */
export async function selfContainedGlb(bytes: Uint8Array): Promise<Uint8Array> {
  const { json, bin } = readGlb(bytes);
  const embedded = (json.buffers ?? []).some(buffer => buffer?.uri !== undefined) || (json.images ?? []).some(image => image?.uri !== undefined);
  if (!embedded) return bytes;
  const copy = structuredClone(json);
  let binary = "";
  if (bin && copy.buffers?.[0] && copy.buffers[0].uri === undefined) {
    for (let i = 0; i < bin.byteLength; i += 0x8000) binary += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    copy.buffers[0].uri = `data:application/octet-stream;base64,${btoa(binary)}`;
  }
  return packGltf(JSON.stringify(copy), async () => fail("external-dependency", "A GLB cannot refer to other files."));
}
