import { writeGlb } from "../../cards/assets/gltf";
import type { CadPreview, CadPreviewPart } from "./freecad";

/**
 * v0.7: the FreeCAD preview as a GLB for the CAD viewer. The worker sends each visible solid's faces, tessellated and
 * grouped by the feature that made them (the enclosure's own faces, each hole's wall, a fillet's rounds); this builds a
 * glTF 2.0 binary from them:
 *
 *   root (the document: title, units "m", backend, revision)
 *     └─ a visible solid (the result of its features; its own faces, if any)
 *          └─ a feature (its faces) — extras.aionId is FreeCAD's object name, stable across recomputes
 *
 * Coordinates: FreeCAD's millimetres, Z up → glTF's metres, Y up (x, z, −y). Normals are smooth within a face and sharp
 * between faces (each face's vertices are its own), as CAD shading expects. The bytes then pass the same validation as
 * any model (`loadModel`'s policy) before a card sees them. This is a picture of the FreeCAD model, never its source.
 */
export interface PreviewMeta { title: string; documentId: string; revision: number; backend: string; path: string | null }

const decode = (b64: string, kind: "f" | "I") => {
  const bytes = Buffer.from(b64, "base64");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return kind === "f" ? new Float32Array(copy.buffer) : new Uint32Array(copy.buffer);
};

const hexColor = (hex: string): [number, number, number] => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0x9aa4ae;
  // glTF colours are linear.
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
};

type Extras = Record<string, string | number | boolean>;

export function previewGlb(preview: CadPreview, meta: PreviewMeta): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const json = {
    asset: { version: "2.0", generator: `Aion Presence FreeCAD bridge (${meta.backend})` },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [] as Record<string, unknown>[], meshes: [] as Record<string, unknown>[], accessors: [] as Record<string, unknown>[],
    bufferViews: [] as Record<string, unknown>[], materials: [] as Record<string, unknown>[], buffers: [] as Record<string, unknown>[],
  };
  const view = (data: Uint8Array, target: number) => {
    const offset = length;
    chunks.push(data); length += data.byteLength;
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    return json.bufferViews.length - 1;
  };
  const materials = new Map<string, number>();
  const material = (color: string, name: string) => {
    const key = `${color}|${name}`;
    if (!materials.has(key)) {
      json.materials.push({ name, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...hexColor(color), 1], metallicFactor: 0.3, roughnessFactor: 0.48 } });
      materials.set(key, json.materials.length - 1);
    }
    return materials.get(key)!;
  };
  const mesh = (part: CadPreviewPart) => {
    const source = decode(part.positions, "f") as Float32Array, indices = decode(part.indices, "I") as Uint32Array;
    const count = source.length / 3;
    const pos = new Float32Array(source.length), normals = new Float32Array(source.length);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      const x = source[i * 3] / 1000, y = source[i * 3 + 2] / 1000, z = -source[i * 3 + 1] / 1000;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    }
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { normals[k] += nx; normals[k + 1] += ny; normals[k + 2] += nz; }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    }
    json.accessors.push({ bufferView: view(new Uint8Array(pos.buffer), 34962), componentType: 5126, count, type: "VEC3", min, max });
    const position = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(new Uint8Array(normals.buffer), 34962), componentType: 5126, count, type: "VEC3" });
    const normal = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), 34963), componentType: 5125, count: indices.length, type: "SCALAR" });
    const index = json.accessors.length - 1;
    const named = typeof part.metadata.Material === "string" ? String(part.metadata.Material) : `FreeCAD ${part.role}`;
    json.meshes.push({ name: part.label, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index, material: material(part.color, named), mode: 4 }] });
    return json.meshes.length - 1;
  };
  const extras = (id: string, label: string, metadata: Extras): Extras => ({ aionId: id, label, ...metadata });

  json.nodes.push({
    name: meta.title, children: [],
    extras: {
      // A stable id and name for the document itself (the title carries the revision and changes).
      aionId: meta.documentId, label: meta.title.replace(/ · rev \d+$/, ""),
      title: meta.title, units: "m", backend: meta.backend, document: meta.documentId, revision: meta.revision,
      ...(meta.path ? { file: meta.path.split(/[\\/]/).pop()! } : {}),
      dataStatus: "Tessellated from the FreeCAD document; parameters live in FreeCAD.",
    },
  });
  const root = json.nodes[0] as { children: number[] };
  for (const node of preview.nodes) {
    // The solid's own faces (a part whose id is the solid's) go on the solid's node, so ids stay unique.
    const own = node.children.find(part => part.id === node.id);
    const index = json.nodes.length;
    json.nodes.push({ name: node.label, extras: extras(node.id, node.label, node.metadata), ...(own ? { mesh: mesh(own) } : {}) });
    root.children.push(index);
    const children: number[] = [];
    for (const part of node.children) {
      if (part === own) continue;
      children.push(json.nodes.length);
      json.nodes.push({ name: part.label, mesh: mesh(part), extras: extras(part.id, part.label, part.metadata) });
    }
    if (children.length) (json.nodes[index] as { children?: number[] }).children = children;
  }
  if (!root.children.length) delete (root as { children?: number[] }).children;
  const bin = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bin.set(chunk, at); at += chunk.byteLength; }
  json.buffers.push({ byteLength: length });
  if (!json.meshes.length) { delete (json as { meshes?: unknown }).meshes; delete (json as { accessors?: unknown }).accessors; delete (json as { bufferViews?: unknown }).bufferViews; delete (json as { materials?: unknown }).materials; delete (json as { buffers?: unknown }).buffers; }
  return writeGlb(json, json.meshes?.length ? bin : null);
}
