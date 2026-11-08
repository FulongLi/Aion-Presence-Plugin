import { DEFAULT_MATERIAL, type ModelGeometry } from "./geometry";

/**
 * STL (binary or ASCII) → ModelGeometry (v0.9): triangles only, no colour (the model takes Aion's silver, or a neutral grey
 * in original colours). STL files are usually Z-up (3D printing); the manifest's `orientation.up` says so. Bounded.
 */
export const STL_LIMITS = { bytes: 96 * 1024 * 1024, triangles: 3_000_000 };

export class StlError extends Error { constructor(readonly detail: string) { super("model-invalid"); this.name = "StlError"; } }

export function readStl(bytes: Uint8Array, limits = STL_LIMITS): ModelGeometry {
  if (bytes.length > limits.bytes) throw new StlError("The STL file is too large.");
  if (bytes.length < 15) throw new StlError("The STL file is empty.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryCount = bytes.length >= 84 ? view.getUint32(80, true) : -1;
  let positions: Float32Array;
  if (binaryCount >= 0 && 84 + binaryCount * 50 === bytes.length) {
    if (binaryCount > limits.triangles) throw new StlError("The STL has too many triangles.");
    positions = new Float32Array(binaryCount * 9);
    for (let i = 0; i < binaryCount; i++) {
      for (let k = 0; k < 9; k++) positions[i * 9 + k] = view.getFloat32(84 + i * 50 + 12 + k * 4, true);
    }
  } else {
    const text = new TextDecoder("utf-8").decode(bytes);
    if (!/^\s*solid/i.test(text)) throw new StlError("Not an STL file (neither binary nor ASCII).");
    const values: number[] = [];
    for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
      values.push(Number(match[1]), Number(match[2]), Number(match[3]));
      if (values.length / 9 > limits.triangles) throw new StlError("The STL has too many triangles.");
    }
    if (values.length % 9) throw new StlError("The STL has an incomplete facet.");
    positions = Float32Array.from(values);
  }
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new StlError("The STL contains a coordinate that is not a finite number.");
  if (!positions.length) throw new StlError("The STL contains no triangles.");
  return {
    format: "stl", materials: [{ ...DEFAULT_MATERIAL }], images: [], animations: [], skins: 0, warnings: [],
    primitives: [{ positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i), uvs: [], material: 0, node: 0 }],
  };
}
