/**
 * The model library's neutral geometry (v0.9): what every importer (glTF/GLB, OBJ, STL) produces and the particle sampler
 * reads. World-space triangles grouped into primitives, each with its material, optional texture coordinates and vertex
 * colours; the materials; the textures as encoded images (decoded by the host only when colours are sampled). Pure data:
 * no Three.js, no DOM, no Node.
 */
export type Vec3 = [number, number, number];
export type Mat4 = Float64Array;

export interface ModelImage { mime: string; data: Uint8Array }

/** How a texture is read: which image, which UV set, wrap modes (glTF codes) and an optional KHR_texture_transform. */
export interface TextureRef {
  image: number;
  texCoord: number;
  wrapS: number;
  wrapT: number;
  transform?: { offset: [number, number]; scale: [number, number]; rotation: number };
}

export interface ModelMaterial {
  name: string;
  /** sRGB-encoded base colour, 0…1 (glTF's linear factor converted), and alpha. */
  color: [number, number, number, number];
  texture?: TextureRef;
  /** Fully transparent or masked-out surfaces are sampled less (they are not what the model looks like). */
  alphaMode: "OPAQUE" | "MASK" | "BLEND";
}

export interface ModelPrimitive {
  /** World-space vertex positions (3 floats each), after node transforms and (rest-pose) skinning. */
  positions: Float32Array;
  /** Triangle vertex indices (3 per triangle). */
  indices: Uint32Array;
  /** Texture coordinates by set (TEXCOORD_0, TEXCOORD_1), 2 floats per vertex. */
  uvs: (Float32Array | undefined)[];
  /** Vertex colours, sRGB 0…1, 4 floats per vertex (COLOR_0 converted). */
  colors?: Float32Array;
  material: number;
  /** The node it came from (for logs and animation). */
  node: number;
}

export interface ModelAnimationInfo { name: string; duration: number; channels: number }

export interface ModelGeometry {
  format: "glb" | "obj" | "stl";
  primitives: ModelPrimitive[];
  materials: ModelMaterial[];
  images: ModelImage[];
  animations: ModelAnimationInfo[];
  skins: number;
  /** Things the reader could not use (a points primitive, an unsupported texture) — reported, never fatal. */
  warnings: string[];
}

export const DEFAULT_MATERIAL: ModelMaterial = { name: "default", color: [0.82, 0.84, 0.88, 1], alphaMode: "OPAQUE" };

export const linearToSrgb = (value: number) => {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};

export function identity(): Mat4 { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }

/** a × b (column-major, as glTF stores matrices). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Translation × rotation (unit quaternion x, y, z, w) × scale. */
export function compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Mat4 {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const m = new Float64Array(16);
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

/** Rotation about X, Y, Z (degrees, applied in that order) as a matrix. */
export function eulerDegrees(rotation: Vec3): Mat4 {
  const [ax, ay, az] = rotation.map(value => value * Math.PI / 180);
  const rx = identity(), ry = identity(), rz = identity();
  rx[5] = Math.cos(ax); rx[6] = Math.sin(ax); rx[9] = -Math.sin(ax); rx[10] = Math.cos(ax);
  ry[0] = Math.cos(ay); ry[2] = -Math.sin(ay); ry[8] = Math.sin(ay); ry[10] = Math.cos(ay);
  rz[0] = Math.cos(az); rz[1] = Math.sin(az); rz[4] = -Math.sin(az); rz[5] = Math.cos(az);
  return multiply(rz, multiply(ry, rx));
}

export function transformPoints(positions: Float32Array, m: Mat4): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export function triangleCount(geometry: ModelGeometry) { return geometry.primitives.reduce((sum, p) => sum + p.indices.length / 3, 0); }
