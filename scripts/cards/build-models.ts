import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { BufferGeometry } from "three";
import { BoxGeometry, CatmullRomCurve3, CylinderGeometry, ExtrudeGeometry, Matrix4, Path, Shape, TubeGeometry, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { validateGlb, writeGlb } from "../../src/cards/assets/gltf";
import { PLUGIN_ROOT, REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run cards:models`: builds the CAD viewer's models from code (v0.4.5), so they are reproducible and free of any
 * third-party licence.
 *
 *   plugins/aion-presence/assets/cards/transformer.glb    the bundled demonstration: a single-phase EI transformer
 *   tests/fixtures/cards/bracket.gltf (+ .bin, .png)      a second, unrelated model as a .gltf with external files and a
 *                                                         texture, to verify importing and packing another model
 *
 * Units are metres (glTF's own); the transformer declares `extras.units: "m"`. Every part carries a stable
 * `extras.aionId` and descriptive metadata. Its values are nominal demonstration values (said so in the model itself),
 * not a datasheet.
 */
interface PartSpec { name: string; aionId?: string; geometry?: BufferGeometry; material?: number; extras?: Record<string, unknown>; children?: PartSpec[] }
interface MaterialSpec { name: string; color: [number, number, number]; metallic: number; roughness: number; texture?: number }

const mm = 0.001;

/** Packs parts into glTF JSON + one binary buffer. */
function assemble(root: PartSpec, materials: MaterialSpec[], images: { png: Uint8Array }[] = []) {
  const json: Record<string, unknown[]> & { asset: object; scene: number; scenes: object[] } = {
    asset: { version: "2.0", generator: "Aion Presence scripts/cards/build-models.ts" }, scene: 0, scenes: [], nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], buffers: [],
  } as never;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const view = (data: Uint8Array, target?: number) => {
    const offset = length;
    chunks.push(data); length += data.byteLength;
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, ...(target ? { target } : {}) });
    return json.bufferViews.length - 1;
  };
  for (const m of materials) {
    json.materials.push({ name: m.name, pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metallic, roughnessFactor: m.roughness, ...(m.texture !== undefined ? { baseColorTexture: { index: m.texture } } : {}) } });
  }
  if (images.length) {
    json.images = images.map(image => ({ bufferView: view(image.png), mimeType: "image/png" }));
    json.textures = images.map((_, i) => ({ source: i, sampler: 0 }));
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  }
  const mesh = (geometry: BufferGeometry, material: number, name: string) => {
    const g = geometry.index ? geometry : geometry;
    const position = g.getAttribute("position"), normal = g.getAttribute("normal"), uv = g.getAttribute("uv");
    const pos = new Float32Array(position.array), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const attributes: Record<string, number> = {};
    json.accessors.push({ bufferView: view(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: position.count, type: "VEC3", min, max });
    attributes.POSITION = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(new Uint8Array(new Float32Array(normal.array).buffer), 34962), componentType: 5126, count: normal.count, type: "VEC3" });
    attributes.NORMAL = json.accessors.length - 1;
    if (uv && materials[material].texture !== undefined) {
      json.accessors.push({ bufferView: view(new Uint8Array(new Float32Array(uv.array).buffer), 34962), componentType: 5126, count: uv.count, type: "VEC2" });
      attributes.TEXCOORD_0 = json.accessors.length - 1;
    }
    const primitive: Record<string, unknown> = { attributes, material };
    if (g.index) {
      const big = position.count > 65535;
      const indices = big ? new Uint32Array(g.index.array) : new Uint16Array(g.index.array);
      json.accessors.push({ bufferView: view(new Uint8Array(indices.buffer), 34963), componentType: big ? 5125 : 5123, count: indices.length, type: "SCALAR" });
      primitive.indices = json.accessors.length - 1;
    }
    json.meshes.push({ name, primitives: [primitive] });
    return json.meshes.length - 1;
  };
  const node = (part: PartSpec): number => {
    const index = json.nodes.length;
    json.nodes.push({});
    const children = (part.children ?? []).map(node);
    const extras = { ...(part.aionId ? { aionId: part.aionId } : {}), ...part.extras };
    json.nodes[index] = {
      name: part.name, ...(part.geometry ? { mesh: mesh(part.geometry, part.material ?? 0, part.name) } : {}), ...(children.length ? { children } : {}),
      ...(Object.keys(extras).length ? { extras } : {}),
    };
    return index;
  };
  json.scenes.push({ nodes: [node(root)] });
  json.buffers.push({ byteLength: length });
  const bin = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bin.set(chunk, at); at += chunk.byteLength; }
  return { json, bin };
}

/** A rectangle with rounded corners, centred, as a Shape (or a hole Path). */
function roundedRect<T extends Shape | Path>(target: T, w: number, h: number, r: number): T {
  const x = -w / 2, y = -h / 2;
  target.moveTo(x + r, y);
  target.lineTo(x + w - r, y); target.quadraticCurveTo(x + w, y, x + w, y + r);
  target.lineTo(x + w, y + h - r); target.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  target.lineTo(x + r, y + h); target.quadraticCurveTo(x, y + h, x, y + h - r);
  target.lineTo(x, y + r); target.quadraticCurveTo(x, y, x + r, y);
  return target;
}

/** A winding: a rounded-rectangular coil around the centre leg (vertical, along y). */
function coil(inner: number, outer: number, y0: number, y1: number) {
  const shape = roundedRect(new Shape(), outer * 2, outer * 2, outer * 0.45);
  shape.holes.push(roundedRect(new Path(), inner * 2, inner * 2, inner * 0.35));
  const geometry = new ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: true, bevelThickness: 0.6 * mm, bevelSize: 0.6 * mm, bevelSegments: 2, curveSegments: 10 });
  geometry.applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2));
  geometry.translate(0, y0, 0);
  return geometry;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new BoxGeometry(w, h, d).translate(x, y, z);
const merged = (...parts: BufferGeometry[]) => {
  const flat = parts.map(part => (part.index ? part.toNonIndexed() : part));
  for (const part of flat) part.deleteAttribute("uv");
  return mergeGeometries(flat)!;
};

// ── The transformer (dimensions in mm) ───────────────────────────────────────────────────────────────────────────
// EI core: 96 wide, 80 high, a 32 mm stack; centre leg 32, outer legs 16, windows 16 × 48.
const W = 96 * mm, D = 32 * mm, LEG = 16 * mm, CENTRE = 32 * mm, YOKE = 16 * mm, WINDOW_H = 48 * mm;
const core = merged(
  box(W, YOKE, D, 0, YOKE / 2, 0), // E: bottom yoke
  box(LEG, WINDOW_H, D, -(W - LEG) / 2, YOKE + WINDOW_H / 2, 0), box(LEG, WINDOW_H, D, (W - LEG) / 2, YOKE + WINDOW_H / 2, 0), // outer legs
  box(CENTRE, WINDOW_H, D, 0, YOKE + WINDOW_H / 2, 0), // centre leg
  box(W, YOKE - 0.4 * mm, D, 0, YOKE + WINDOW_H + 0.2 * mm + (YOKE - 0.4 * mm) / 2, 0), // I: top yoke (a fine air gap)
);
// Bobbin: a tube around the centre leg with two flanges.
const bobbin = (() => {
  const tube = new Shape();
  roundedRect(tube, 36 * mm, 36 * mm, 2 * mm);
  tube.holes.push(roundedRect(new Path(), 33 * mm, 33 * mm, 1 * mm));
  const sleeve = new ExtrudeGeometry(tube, { depth: WINDOW_H - 1 * mm, bevelEnabled: false, curveSegments: 4 }).applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2)).translate(0, YOKE + 0.5 * mm, 0);
  const flange = (y: number) => {
    const plate = roundedRect(new Shape(), 62 * mm, 66 * mm, 3 * mm);
    plate.holes.push(roundedRect(new Path(), 33 * mm, 33 * mm, 1 * mm));
    return new ExtrudeGeometry(plate, { depth: 1.5 * mm, bevelEnabled: false, curveSegments: 4 }).applyMatrix4(new Matrix4().makeRotationX(-Math.PI / 2)).translate(0, y, 0);
  };
  return merged(sleeve, flange(YOKE + 0.5 * mm), flange(YOKE + WINDOW_H - 2 * mm));
})();
const primary = coil(18.5 * mm, 23 * mm, YOKE + 2.6 * mm, YOKE + WINDOW_H - 2.6 * mm);
const secondary = coil(23.8 * mm, 28.6 * mm, YOKE + 4 * mm, YOKE + WINDOW_H - 4 * mm);
// Mounting brackets: angle pieces along the front and back of each yoke; the bottom one has feet.
const T = 1.5 * mm;
const bracket = (bottom: boolean) => {
  const y = bottom ? YOKE / 2 : YOKE + WINDOW_H + YOKE / 2;
  const parts = [box(W + 4 * mm, YOKE, T, 0, y, D / 2 + T / 2), box(W + 4 * mm, YOKE, T, 0, y, -D / 2 - T / 2)];
  if (bottom) parts.push(box(W + 40 * mm, T, D + 2 * T, 0, T / 2 - 0.2 * mm, 0), box(14 * mm, T, D + 22 * mm, -(W + 26 * mm) / 2, T / 2 - 0.2 * mm, 0), box(14 * mm, T, D + 22 * mm, (W + 26 * mm) / 2, T / 2 - 0.2 * mm, 0));
  else parts.push(box(W + 4 * mm, T, D + 2 * T, 0, YOKE * 2 + WINDOW_H + T / 2, 0));
  return merged(...parts);
};
// Terminal block on the front of the bottom bracket, with four brass screw terminals.
const BLOCK_Z = D / 2 + T + 7 * mm;
const block = box(56 * mm, 10 * mm, 12 * mm, 0, T + 5 * mm, BLOCK_Z);
const terminalX = [-21, -7, 7, 21].map(x => x * mm);
const terminal = (x: number) => merged(new CylinderGeometry(2.6 * mm, 2.6 * mm, 3 * mm, 24).translate(x, T + 11.5 * mm, BLOCK_Z), new CylinderGeometry(1.2 * mm, 1.2 * mm, 4 * mm, 16).translate(x, T + 14 * mm, BLOCK_Z));
// Leads from each winding down to its terminals.
const lead = (from: [number, number, number], x: number, radius: number) => new TubeGeometry(new CatmullRomCurve3([
  new Vector3(...from), new Vector3(from[0], from[1] - 6 * mm, from[2] + 6 * mm), new Vector3(x, T + 22 * mm, BLOCK_Z), new Vector3(x, T + 15.5 * mm, BLOCK_Z),
]), 40, radius, 10, false);
const primaryLeads = merged(lead([-14 * mm, YOKE + 6 * mm, 23 * mm], terminalX[0], 0.55 * mm), lead([14 * mm, YOKE + 6 * mm, 23 * mm], terminalX[1], 0.55 * mm));
const secondaryLeads = merged(lead([-6 * mm, YOKE + 7 * mm, 28.6 * mm], terminalX[2], 0.9 * mm), lead([6 * mm, YOKE + 7 * mm, 28.6 * mm], terminalX[3], 0.9 * mm));

const NOMINAL = "Nominal demonstration value";
const transformer: PartSpec = {
  name: "Transformer Assembly", aionId: "assembly",
  extras: {
    title: "Single-phase EI transformer (demonstration)", units: "m",
    description: "Illustrative assembly bundled with Aion Presence to demonstrate the CAD viewer; values are nominal, not a datasheet.",
    source: "Generated by scripts/cards/build-models.ts",
  },
  children: [
    {
      name: "Magnetic Core", aionId: "assembly/core", geometry: core, material: 0,
      extras: { label: "Magnetic Core", partNumber: "DEMO-CORE-EI96", construction: "EI laminations, interleaved", material: "Silicon steel laminations", laminationThickness: "0.35 mm", stackDepth: "32 mm", function: "Carries the magnetic flux that links both windings", dataStatus: NOMINAL },
    },
    {
      name: "Bobbin", aionId: "assembly/bobbin", geometry: bobbin, material: 3,
      extras: { label: "Bobbin", material: "Glass-filled polyamide", function: "Insulating former that carries both windings on the centre leg", dataStatus: NOMINAL },
    },
    {
      name: "Windings", aionId: "assembly/windings", extras: { label: "Windings", function: "The two coils around the centre leg" },
      children: [
        {
          name: "Primary Winding", aionId: "assembly/winding-primary", geometry: primary, material: 1,
          extras: { label: "Primary Winding", conductor: "Enamelled copper wire", turns: 230, wireDiameter: "0.45 mm", position: "Inner winding", function: "Input winding: magnetises the core", dataStatus: NOMINAL },
          children: [{ name: "Primary Leads", aionId: "assembly/winding-primary/leads", geometry: primaryLeads, material: 1, extras: { label: "Primary Leads", function: "Connect the primary winding to terminals P1 and P2" } }],
        },
        {
          name: "Secondary Winding", aionId: "assembly/winding-secondary", geometry: secondary, material: 2,
          extras: { label: "Secondary Winding", conductor: "Enamelled copper wire", turns: 24, wireDiameter: "1.2 mm", position: "Outer winding", function: "Output winding: delivers the transformed voltage", dataStatus: NOMINAL },
          children: [{ name: "Secondary Leads", aionId: "assembly/winding-secondary/leads", geometry: secondaryLeads, material: 2, extras: { label: "Secondary Leads", function: "Connect the secondary winding to terminals S1 and S2" } }],
        },
      ],
    },
    {
      name: "Mounting Frame", aionId: "assembly/frame", extras: { label: "Mounting Frame", material: "Zinc-plated steel", function: "Clamps the laminations and mounts the transformer" },
      children: [
        { name: "Top Bracket", aionId: "assembly/frame/top", geometry: bracket(false), material: 4, extras: { label: "Top Bracket", material: "Zinc-plated steel", thickness: "1.5 mm", dataStatus: NOMINAL } },
        { name: "Bottom Bracket", aionId: "assembly/frame/bottom", geometry: bracket(true), material: 4, extras: { label: "Bottom Bracket", material: "Zinc-plated steel", thickness: "1.5 mm", mounting: "Two feet with slots", dataStatus: NOMINAL } },
      ],
    },
    {
      name: "Terminals", aionId: "assembly/terminals", extras: { label: "Terminals", function: "Screw terminals for the primary (P1, P2) and secondary (S1, S2)" },
      children: [
        { name: "Terminal Block", aionId: "assembly/terminals/block", geometry: block, material: 5, extras: { label: "Terminal Block", material: "Polyamide", dataStatus: NOMINAL } },
        ...["P1", "P2", "S1", "S2"].map((label, i) => ({
          name: `Terminal ${label}`, aionId: `assembly/terminals/${label.toLowerCase()}`, geometry: terminal(terminalX[i]), material: 6,
          extras: { label: `Terminal ${label}`, connects: i < 2 ? "Primary winding" : "Secondary winding", material: "Brass screw terminal", dataStatus: NOMINAL },
        })),
      ],
    },
  ],
};
const transformerMaterials: MaterialSpec[] = [
  { name: "Silicon steel", color: [0.22, 0.24, 0.27], metallic: 0.65, roughness: 0.42 },
  { name: "Copper (primary)", color: [0.85, 0.45, 0.24], metallic: 1, roughness: 0.3 },
  { name: "Copper enamel (secondary)", color: [0.55, 0.17, 0.09], metallic: 0.75, roughness: 0.36 },
  { name: "Polyamide (black)", color: [0.035, 0.038, 0.045], metallic: 0, roughness: 0.62 },
  { name: "Zinc-plated steel", color: [0.62, 0.64, 0.67], metallic: 0.85, roughness: 0.32 },
  { name: "Polyamide (terminal)", color: [0.12, 0.3, 0.2], metallic: 0, roughness: 0.55 },
  { name: "Brass", color: [0.78, 0.6, 0.28], metallic: 1, roughness: 0.28 },
];

const out = assemble(transformer, transformerMaterials);
const glb = writeGlb(out.json, out.bin);
const info = validateGlb(glb);
const file = join(PLUGIN_ROOT, "assets/cards/transformer.glb");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, glb);
console.log(`transformer.glb: ${(glb.byteLength / 1024).toFixed(0)} KB, ${info.nodes} nodes, ${info.meshes} meshes, ${info.triangles.toLocaleString("en")} triangles`);

// ── A second model: a bracket with a texture, as .gltf + .bin + .png (external files) ─────────────────────────────
/** A small PNG (RGB, no compression tricks): a brushed-metal checker for the bracket's texture. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (data: Uint8Array) => { let c = 0xffffffff; for (const b of data) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13), hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height); header[8] = 8; header[9] = 2;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((sum, p) => sum + p.length, 0), result = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { result.set(p, at); at += p.length; }
  return result;
}
const texture = png(64, 64, (x, y) => { const v = 150 + ((x >> 3) + (y >> 3)) % 2 * 40 + (Math.sin(y * 0.9) * 6); return [v, v + 4, v + 10]; });
const plate = new BoxGeometry(80 * mm, 6 * mm, 50 * mm);
const upright = new BoxGeometry(6 * mm, 60 * mm, 50 * mm).translate(-37 * mm, 33 * mm, 0);
const gusset = new BoxGeometry(30 * mm, 4 * mm, 40 * mm).applyMatrix4(new Matrix4().makeRotationZ(-Math.PI / 4)).translate(-22 * mm, 18 * mm, 0);
const bolts = [-20, 20].map(z => new CylinderGeometry(4 * mm, 4 * mm, 10 * mm, 24).translate(20 * mm, 5 * mm, z * mm));
const bracketModel: PartSpec = {
  name: "Angle Bracket", extras: { units: "m", title: "Angle bracket (test model)" },
  children: [
    { name: "Base Plate", geometry: plate, material: 0, extras: { material: "Aluminium 6061", thickness: "6 mm" } },
    { name: "Upright", geometry: upright, material: 0, extras: { material: "Aluminium 6061" } },
    { name: "Gusset", geometry: gusset, material: 0 },
    { name: "Bolts", children: bolts.map((g, i) => ({ name: `Bolt ${i + 1}`, geometry: g, material: 1, extras: { size: "M8" } })) },
  ],
};
const bracketOut = assemble(bracketModel, [
  { name: "Brushed aluminium", color: [1, 1, 1], metallic: 0.8, roughness: 0.4, texture: 0 },
  { name: "Steel", color: [0.45, 0.47, 0.5], metallic: 0.9, roughness: 0.35 },
]);
// External files: the buffer and the image beside the .gltf.
const json = bracketOut.json as unknown as Record<string, unknown> & { buffers: { uri?: string; byteLength: number }[]; images?: unknown[]; bufferViews: unknown[]; textures?: unknown[]; samplers?: unknown[] };
json.buffers[0].uri = "bracket.bin";
json.images = [{ uri: "bracket-texture.png" }];
json.textures = [{ source: 0, sampler: 0 }];
json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
const fixtures = join(REPO_ROOT, "tests/fixtures/cards");
mkdirSync(fixtures, { recursive: true });
writeFileSync(join(fixtures, "bracket.gltf"), JSON.stringify(json, null, 1));
writeFileSync(join(fixtures, "bracket.bin"), bracketOut.bin);
writeFileSync(join(fixtures, "bracket-texture.png"), texture);
console.log(`bracket.gltf + bracket.bin (${(bracketOut.bin.byteLength / 1024).toFixed(0)} KB) + bracket-texture.png: a ${bracketModel.children!.length}-part test model`);
