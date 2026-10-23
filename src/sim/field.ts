/**
 * v0.8 Simulation Core: the field-result bundle — how a simulation result (or a study's setup) travels to the
 * Simulation Card. Elmer's VTU stays on disk as the full numerical record (open it in ParaView); the card receives this
 * compact, validated container instead: the mesh nodes (metres), the boundary triangles (each tagged with its CAD
 * face), the tetrahedra (for sections and interior probes), and the solver's nodal fields as float32, with a JSON header
 * that names every field, its unit, its source and its range. No decorative or synthetic values: a field that is not in
 * the solver's output is not in the bundle, and the card says so.
 *
 *   bytes 0–7   "AIONFLD1"
 *   bytes 8–11  header length H (little-endian u32, ≤ 512 KiB)
 *   12…12+H     header (UTF-8 JSON), then zero padding to a multiple of 4
 *   …           blocks, each 4-byte aligned, as the header lists them
 *
 * `decodeFieldBundle` checks everything (sizes, offsets, index ranges, finite values) and is used by the hub (before it
 * stores the bytes) and by the card (before it draws them). Plain TypeScript, no dependencies: it runs in Node and in the
 * card's sandbox.
 */
export const FIELD_MAGIC = "AIONFLD1";
export const FIELD_MIME = "application/vnd.aion.field";
export const FIELD_LIMITS = { bytes: 16 * 1024 * 1024, header: 512 * 1024, nodes: 2_000_000, triangles: 2_000_000, tetrahedra: 3_000_000, fields: 16, faces: 20_000 };

export type BlockType = "f32" | "u32" | "u8";
export interface BlockInfo { id: string; type: BlockType; count: number; offset: number }
export interface BundleField {
  id: string; name: string; unit: string; kind: "scalar" | "vector"; source: string; location: "nodal";
  min: number; max: number; minAt: [number, number, number]; maxAt: [number, number, number];
  block: string;
  /** A u8 block marking the nodes where the field is defined (electric fields in an electro-thermal model). */
  mask?: string;
  /** How to show it (temperature in °C: unit "°C", offset −273.15). */
  display?: { unit: string; offset: number };
}
export interface BundleFace { index: number; label: string; body: string; condition?: string; color?: string; group?: string; area_mm2?: number }
export interface FieldBundleHeader {
  format: "aion.field/1";
  mode: "setup" | "results";
  title: string;
  study: { id: string; name: string; analysis: string; revision: number; run?: number };
  geometry: { document: string; revision: number };
  units: { length: "m" };
  counts: { nodes: number; triangles: number; tetrahedra: number };
  faces: BundleFace[];
  solids: { index: number; label: string; material?: string }[];
  fields: BundleField[];
  blocks: BlockInfo[];
  summary: string[];
  omitted: string[];
  /** The boundary conditions and their colours (the setup view's legend). */
  conditions?: { name: string; color: string; text: string }[];
}

export interface FieldBundle {
  header: FieldBundleHeader;
  nodes: Float32Array;
  tris: Uint32Array;
  triFace: Uint32Array;
  tets: Uint32Array | null;
  tetSolid: Uint32Array | null;
  blocks: Record<string, Float32Array | Uint32Array | Uint8Array>;
}

const SIZE: Record<BlockType, number> = { f32: 4, u32: 4, u8: 1 };

export function encodeFieldBundle(header: Omit<FieldBundleHeader, "blocks">, blocks: { id: string; data: Float32Array | Uint32Array | Uint8Array }[]): Uint8Array {
  const infos: BlockInfo[] = [];
  let offset = 0;
  for (const b of blocks) {
    const type: BlockType = b.data instanceof Float32Array ? "f32" : b.data instanceof Uint32Array ? "u32" : "u8";
    infos.push({ id: b.id, type, count: b.data.length, offset });
    offset += align(b.data.byteLength);
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...header, blocks: infos }));
  if (json.byteLength > FIELD_LIMITS.header) throw new Error("the field bundle header is too large");
  const start = align(12 + json.byteLength);
  const out = new Uint8Array(start + offset);
  out.set(new TextEncoder().encode(FIELD_MAGIC), 0);
  new DataView(out.buffer).setUint32(8, json.byteLength, true);
  out.set(json, 12);
  blocks.forEach((b, i) => out.set(new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength), start + infos[i].offset));
  return out;
}

const align = (n: number) => (n + 3) & ~3;

export class FieldBundleError extends Error {}
const fail = (message: string): never => { throw new FieldBundleError(message); };

export function isFieldBundle(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && new TextDecoder().decode(bytes.subarray(0, 8)) === FIELD_MAGIC;
}

/** Decodes and validates a bundle; throws FieldBundleError with a plain reason. The arrays are views on `bytes`. */
export function decodeFieldBundle(bytes: Uint8Array): FieldBundle {
  if (bytes.byteLength > FIELD_LIMITS.bytes) fail(`the result is larger than ${FIELD_LIMITS.bytes / 1024 / 1024} MB`);
  if (!isFieldBundle(bytes)) fail("not an Aion field result");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(8, true);
  if (length > FIELD_LIMITS.header || 12 + length > bytes.byteLength) fail("the result header is too large or truncated");
  let header: FieldBundleHeader;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))); } catch { return fail("the result header is not JSON"); }
  checkHeader(header);
  const start = align(12 + length);
  if ((bytes.byteOffset + start) % 4 !== 0) {
    // Typed views need alignment: copy once if the buffer itself is misaligned.
    return decodeFieldBundle(bytes.slice());
  }
  const blocks: FieldBundle["blocks"] = {};
  for (const b of header.blocks) {
    if (b.offset % 4 !== 0) fail(`block ${b.id} is not aligned`);
    const end = start + b.offset + b.count * SIZE[b.type];
    if (end > bytes.byteLength) fail(`block ${b.id} runs past the end of the result`);
    const at = bytes.byteOffset + start + b.offset;
    blocks[b.id] = b.type === "f32" ? new Float32Array(bytes.buffer, at, b.count) : b.type === "u32" ? new Uint32Array(bytes.buffer, at, b.count) : new Uint8Array(bytes.buffer, at, b.count);
  }
  const { nodes: n, triangles: t, tetrahedra: m } = header.counts;
  const need = (id: string, type: BlockType, count: number) => {
    const b = header.blocks.find(x => x.id === id);
    if (!b) return fail(`the result lacks its ${id} block`);
    if (b.type !== type || b.count !== count) fail(`block ${id} has the wrong type or size`);
    return blocks[id];
  };
  const nodes = need("nodes", "f32", n * 3) as Float32Array;
  const tris = need("tris", "u32", t * 3) as Uint32Array;
  const triFace = need("triFace", "u32", t) as Uint32Array;
  const tets = m ? need("tets", "u32", m * 4) as Uint32Array : null;
  const tetSolid = m ? need("tetSolid", "u32", m) as Uint32Array : null;
  for (const v of nodes) if (!Number.isFinite(v)) fail("a node coordinate is not a number");
  for (const v of tris) if (v >= n) fail("a triangle refers to a node that does not exist");
  if (tets) for (const v of tets) if (v >= n) fail("a tetrahedron refers to a node that does not exist");
  const faceIds = new Set(header.faces.map(f => f.index));
  for (const f of triFace) if (!faceIds.has(f)) fail("a triangle names a face the result does not describe");
  if (tetSolid) { const solidIds = new Set(header.solids.map(s => s.index)); for (const s of tetSolid) if (!solidIds.has(s)) fail("a tetrahedron names a solid the result does not describe"); }
  for (const f of header.fields) {
    const values = need(f.block, "f32", n * (f.kind === "vector" ? 3 : 1)) as Float32Array;
    for (const v of values) if (!Number.isFinite(v)) fail(`field ${f.id} contains values that are not numbers`);
    if (f.mask) need(f.mask, "u8", n);
  }
  return { header, nodes, tris, triFace, tets, tetSolid, blocks };
}

/** Control characters (tab and newline excepted). */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function checkHeader(h: FieldBundleHeader) {
  const isNum = (v: unknown, min = -Infinity, max = Infinity) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const isInt = (v: unknown, min: number, max: number) => isNum(v, min, max) && Number.isInteger(v);
  const isText = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !CONTROL.test(v);
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(x => isNum(x));
  if (!h || typeof h !== "object" || h.format !== "aion.field/1") fail("unknown result format");
  if (h.mode !== "setup" && h.mode !== "results") fail("unknown result mode");
  if (!isText(h.title, 120)) fail("bad title");
  if (!h.study || !isText(h.study.id, 40) || !isText(h.study.name, 80) || !isText(h.study.analysis, 20) || !isInt(h.study.revision, 0, 1e9)) fail("bad study");
  if (!h.geometry || !isText(h.geometry.document, 40) || !isInt(h.geometry.revision, 0, 1e9)) fail("bad geometry");
  if (!h.units || h.units.length !== "m") fail("lengths must be metres");
  const c = h.counts;
  if (!c || !isInt(c.nodes, 1, FIELD_LIMITS.nodes) || !isInt(c.triangles, 1, FIELD_LIMITS.triangles) || !isInt(c.tetrahedra, 0, FIELD_LIMITS.tetrahedra)) fail("bad counts");
  if (!Array.isArray(h.faces) || h.faces.length > FIELD_LIMITS.faces || !h.faces.every(f => isInt(f.index, 1, 1e6) && isText(f.label, 120) && isText(f.body, 80)
    && (f.condition === undefined || isText(f.condition, 160)) && (f.color === undefined || /^#[0-9a-f]{6}$/i.test(String(f.color))) && (f.group === undefined || isText(f.group, 80)))) fail("bad faces");
  if (!Array.isArray(h.solids) || h.solids.length > 10_000 || !h.solids.every(s => isInt(s.index, 1, 1e6) && isText(s.label, 120) && (s.material === undefined || isText(s.material, 80)))) fail("bad solids");
  if (!Array.isArray(h.fields) || h.fields.length > FIELD_LIMITS.fields || !h.fields.every(f => isText(f.id, 40) && isText(f.name, 60) && isText(f.unit, 20)
    && (f.kind === "scalar" || f.kind === "vector") && isText(f.source, 160) && f.location === "nodal" && isNum(f.min) && isNum(f.max) && f.max >= f.min
    && vec(f.minAt) && vec(f.maxAt) && isText(f.block, 40) && (f.mask === undefined || isText(f.mask, 40))
    && (f.display === undefined || (isText(f.display.unit, 20) && isNum(f.display.offset))))) fail("bad fields");
  if (!Array.isArray(h.blocks) || h.blocks.length > 64 || !h.blocks.every(b => isText(b.id, 40) && (b.type === "f32" || b.type === "u32" || b.type === "u8") && isInt(b.count, 0, 50_000_000) && isInt(b.offset, 0, FIELD_LIMITS.bytes))) fail("bad blocks");
  if (!Array.isArray(h.summary) || h.summary.length > 40 || !h.summary.every(s => isText(s, 300))) fail("bad summary");
  if (!Array.isArray(h.omitted) || h.omitted.length > 10 || !h.omitted.every(s => isText(s, 300))) fail("bad omissions");
  if (h.conditions !== undefined && (!Array.isArray(h.conditions) || h.conditions.length > 128 || !h.conditions.every(c => isText(c.name, 80) && /^#[0-9a-f]{6}$/i.test(String(c.color)) && isText(c.text, 160)))) fail("bad conditions");
}
