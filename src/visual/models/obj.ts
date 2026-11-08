import { DEFAULT_MATERIAL, type ModelGeometry, type ModelImage, type ModelMaterial, type ModelPrimitive } from "./geometry";

/**
 * Wavefront OBJ (+ MTL) → ModelGeometry (v0.9): positions (with the common "v x y z r g b" vertex colours), texture
 * coordinates, polygonal faces (fanned into triangles, negative indices allowed), groups by `usemtl`, and the MTL's diffuse
 * colour, dissolve and diffuse map. The host supplies the MTL text and texture bytes from the model's own folder only;
 * this parser never reads files. Bounded by `limits`; malformed numbers or indices are refused.
 */
export const OBJ_LIMITS = { bytes: 96 * 1024 * 1024, vertices: 4_000_000, triangles: 3_000_000 };

export class ObjError extends Error { constructor(readonly detail: string) { super("model-invalid"); this.name = "ObjError"; } }

export interface ObjMaterialSource { name: string; color: [number, number, number]; alpha: number; map?: string }

/** Parses MTL text into named materials (diffuse colour, dissolve, diffuse map file name). */
export function parseMtl(text: string): ObjMaterialSource[] {
  const out: ObjMaterialSource[] = [];
  let current: ObjMaterialSource | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...rest] = line.split(/\s+/);
    const key = keyword.toLowerCase();
    if (key === "newmtl") { current = { name: rest.join(" ").slice(0, 80), color: [0.8, 0.8, 0.8], alpha: 1 }; out.push(current); continue; }
    if (!current) continue;
    if (key === "kd" && rest.length >= 3) {
      const values = rest.slice(0, 3).map(Number);
      if (values.every(Number.isFinite)) current.color = values.map(v => Math.max(0, Math.min(1, v))) as [number, number, number];
    } else if (key === "d" && Number.isFinite(Number(rest[0]))) current.alpha = Math.max(0, Math.min(1, Number(rest[0])));
    else if (key === "tr" && Number.isFinite(Number(rest[0]))) current.alpha = 1 - Math.max(0, Math.min(1, Number(rest[0])));
    else if (key === "map_kd" && rest.length) current.map = rest.filter(part => !part.startsWith("-")).pop()?.slice(0, 200);
  }
  return out.slice(0, 512);
}

/**
 * `materials` from parseMtl; `textures` maps a map file name to its encoded bytes (PNG or JPEG), already read by the host.
 */
export function readObj(text: string, materials: ObjMaterialSource[] = [], textures: Map<string, ModelImage> = new Map(), limits = OBJ_LIMITS): ModelGeometry {
  if (text.length > limits.bytes) throw new ObjError("The OBJ file is too large.");
  const vx: number[] = [], vc: number[] = [], vt: number[] = [];
  let hasColour = false;
  const groups = new Map<string, { corners: number[][] }>();
  let group = groups.get("") ?? { corners: [] };
  groups.set("", group);
  let triangles = 0;
  const index = (value: string, length: number) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n === 0) throw new ObjError("A face has an invalid vertex index.");
    const at = n > 0 ? n - 1 : length + n;
    if (at < 0 || at >= length) throw new ObjError("A face refers to a vertex that does not exist.");
    return at;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case "v": {
        const values = parts.slice(1, 7).map(Number);
        if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) throw new ObjError("A vertex is not three numbers.");
        vx.push(values[0], values[1], values[2]);
        if (values.length >= 6 && values.slice(3, 6).every(Number.isFinite)) { vc.push(...values.slice(3, 6).map(v => Math.max(0, Math.min(1, v > 1 ? v / 255 : v)))); hasColour = true; }
        else vc.push(1, 1, 1);
        if (vx.length / 3 > limits.vertices) throw new ObjError("The OBJ has too many vertices.");
        break;
      }
      case "vt": {
        const u = Number(parts[1]), v = Number(parts[2] ?? 0);
        if (!Number.isFinite(u) || !Number.isFinite(v)) throw new ObjError("A texture coordinate is not a number.");
        vt.push(u, v);
        break;
      }
      case "usemtl": {
        const name = parts.slice(1).join(" ").slice(0, 80);
        group = groups.get(name) ?? { corners: [] };
        groups.set(name, group);
        break;
      }
      case "f": {
        const corners = parts.slice(1).map(token => {
          const [p, t] = token.split("/");
          return [index(p, vx.length / 3), t ? index(t, vt.length / 2) : -1];
        });
        if (corners.length < 3) break;
        for (let i = 1; i + 1 < corners.length; i++) group.corners.push(corners[0], corners[i], corners[i + 1]);
        triangles += corners.length - 2;
        if (triangles > limits.triangles) throw new ObjError("The OBJ has too many triangles.");
        break;
      }
      default: break;
    }
  }
  const modelMaterials: ModelMaterial[] = [];
  const images: ModelImage[] = [];
  const primitives: ModelPrimitive[] = [];
  const warnings: string[] = [];
  for (const [name, { corners }] of groups) {
    if (!corners.length) continue;
    const source = materials.find(material => material.name === name);
    let material: ModelMaterial = { ...DEFAULT_MATERIAL };
    if (source) {
      material = { name: source.name, color: [...source.color, source.alpha], alphaMode: source.alpha < 1 ? "BLEND" : "OPAQUE" };
      if (source.map) {
        const image = textures.get(source.map);
        if (image) { images.push(image); material.texture = { image: images.length - 1, texCoord: 0, wrapS: 10497, wrapT: 10497 }; }
        else warnings.push(`texture-missing:${source.map.slice(0, 60)}`);
      }
    }
    modelMaterials.push(material);
    // Each corner becomes its own vertex (OBJ indexes positions and coordinates separately).
    const positions = new Float32Array(corners.length * 3), uv = new Float32Array(corners.length * 2);
    const colors = hasColour ? new Float32Array(corners.length * 4) : undefined;
    let textured = false;
    corners.forEach(([p, t], i) => {
      positions.set(vx.slice(p * 3, p * 3 + 3), i * 3);
      if (t >= 0) { uv[i * 2] = vt[t * 2]; uv[i * 2 + 1] = 1 - vt[t * 2 + 1]; textured = true; }
      if (colors) colors.set([vc[p * 3], vc[p * 3 + 1], vc[p * 3 + 2], 1], i * 4);
    });
    primitives.push({
      positions, indices: Uint32Array.from({ length: corners.length }, (_, i) => i), uvs: [textured ? uv : undefined], ...(colors ? { colors } : {}),
      material: modelMaterials.length - 1, node: 0,
    });
  }
  if (!primitives.length) throw new ObjError("The OBJ contains no faces.");
  return { format: "obj", primitives, materials: modelMaterials, images, animations: [], skins: 0, warnings };
}
