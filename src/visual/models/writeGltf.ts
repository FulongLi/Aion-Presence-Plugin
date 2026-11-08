import { writeGlb } from "../../cards/assets/gltf";
import type { ModelGeometry } from "./geometry";

/**
 * ModelGeometry → a self-contained GLB (v0.9). The library keeps every model as one GLB, whatever it was imported from
 * (OBJ, STL), so one validated reader converts them all and the CAD viewer card can preview any of them. Positions,
 * indices, the first UV set, vertex colours, materials (base colour, alpha mode, base colour texture) and embedded images.
 */
const srgbToLinear = (value: number) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

export function geometryToGlb(geometry: ModelGeometry, name = "model"): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const append = (data: Uint8Array, target?: number) => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    chunks.push(data); length += data.byteLength;
    return bufferViews.length - 1;
  };
  const floats = (values: Float32Array, type: string, components: number, bounds = false) => {
    const view = append(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 34962);
    const accessor: Record<string, unknown> = { bufferView: view, componentType: 5126, count: values.length / components, type };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < values.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], values[i + k]); max[k] = Math.max(max[k], values[i + k]); }
      accessor.min = min; accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  const images = geometry.images.map(image => ({ bufferView: append(image.data), mimeType: image.mime }));
  const textures: { source: number }[] = [];
  const materials = geometry.materials.map(material => {
    let baseColorTexture: { index: number } | undefined;
    if (material.texture && images[material.texture.image]) { textures.push({ source: material.texture.image }); baseColorTexture = { index: textures.length - 1 }; }
    return {
      name: material.name, alphaMode: material.alphaMode, doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [srgbToLinear(material.color[0]), srgbToLinear(material.color[1]), srgbToLinear(material.color[2]), material.color[3]],
        metallicFactor: 0, roughnessFactor: 0.8, ...(baseColorTexture ? { baseColorTexture } : {}),
      },
    };
  });
  const meshes = geometry.primitives.map(p => {
    const attributes: Record<string, number> = { POSITION: floats(p.positions, "VEC3", 3, true) };
    if (p.uvs[0]) attributes.TEXCOORD_0 = floats(p.uvs[0], "VEC2", 2);
    if (p.colors) attributes.COLOR_0 = floats(p.colors.map((value, i) => i % 4 === 3 ? value : srgbToLinear(value)), "VEC4", 4);
    const indices = new Uint32Array(p.indices);
    accessors.push({ bufferView: append(new Uint8Array(indices.buffer), 34963), componentType: 5125, count: indices.length, type: "SCALAR" });
    return { primitives: [{ attributes, indices: accessors.length - 1, material: p.material, mode: 4 }] };
  });
  const bin = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bin.set(chunk, at); at += chunk.byteLength; }
  const json = {
    asset: { version: "2.0", generator: "Aion Presence model library" },
    scene: 0, scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((_, i) => ({ mesh: i, name: `${name}-${i + 1}`.slice(0, 60) })),
    meshes, materials, accessors, bufferViews, buffers: [{ byteLength: length }],
    ...(images.length ? { images, textures } : {}),
  };
  return writeGlb(json, bin);
}
