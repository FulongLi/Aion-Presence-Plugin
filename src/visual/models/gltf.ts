import { readGlb } from "../../cards/assets/gltf";
import {
  compose, DEFAULT_MATERIAL, identity, linearToSrgb, multiply, type Mat4, type ModelAnimationInfo, type ModelGeometry, type ModelImage,
  type ModelMaterial, type ModelPrimitive, type TextureRef,
} from "./geometry";

/**
 * glTF 2.0 (GLB) → ModelGeometry (v0.9). The bytes must already have passed the card asset policy (validateGlb on a
 * self-contained GLB: every buffer and image inside its binary chunk, bounded counts, ranges checked); this reader adds
 * what geometry needs: accessors with strides, normalization and sparse values, triangle lists, strips and fans, the node
 * hierarchy (matrix or TRS), materials (metallic-roughness base colour, the spec-gloss diffuse of older exports, alpha
 * modes, KHR_texture_transform), vertex colours, morph targets (v0.9.1: POSITION deltas weighted by the node's, the
 * mesh's or the animation's weights) and skins evaluated in a pose — the rest pose, or any animation at any time — so a
 * rigged or blend-shaped character stands as it should and its genuine animation can be sampled (see animation.ts).
 */
interface Json {
  scene?: number; scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; skin?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; weights?: number[]; name?: string }[];
  meshes?: { weights?: number[]; primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number; targets?: Record<string, number>[] }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; count: number; componentType: number; type: string; normalized?: boolean;
    sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } } }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { name?: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: TextureInfo };
    extensions?: { KHR_materials_pbrSpecularGlossiness?: { diffuseFactor?: number[]; diffuseTexture?: TextureInfo } } }[];
  textures?: { source?: number; sampler?: number }[];
  samplers?: { wrapS?: number; wrapT?: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: { name?: string; channels: { sampler: number; target: { node?: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
}
interface TextureInfo { index: number; texCoord?: number; extensions?: { KHR_texture_transform?: { offset?: number[]; scale?: number[]; rotation?: number; texCoord?: number } } }

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export class GltfError extends Error {
  constructor(code: string, readonly detail: string) { super(code); this.name = "GltfError"; }
}
const fail = (detail: string): never => { throw new GltfError("model-invalid", detail); };

export interface Pose { animation: number; time: number }

export class GltfModel {
  private readonly json: Json;
  private readonly bin: Uint8Array;
  private readonly cache = new Map<number, Float32Array>();
  readonly warnings: string[] = [];
  readonly animations: ModelAnimationInfo[];

  constructor(bytes: Uint8Array) {
    const { json, bin } = readGlb(bytes);
    this.json = json as unknown as Json;
    this.bin = bin ?? new Uint8Array(0);
    this.animations = (this.json.animations ?? []).map((animation, index) => {
      let duration = 0;
      for (const sampler of animation.samplers ?? []) {
        const input = this.accessor(sampler.input);
        if (input.length) duration = Math.max(duration, input[input.length - 1]);
      }
      return { name: (typeof animation.name === "string" && animation.name.trim() ? animation.name.trim() : `animation ${index + 1}`).slice(0, 60), duration, channels: animation.channels?.length ?? 0 };
    });
  }

  /** Bones across the model's skins (distinct joints), and the most morph targets any primitive has. */
  get joints(): number { return new Set((this.json.skins ?? []).flatMap(skin => skin.joints ?? [])).size; }
  get morphTargets(): number { return Math.max(0, ...(this.json.meshes ?? []).flatMap(mesh => mesh.primitives.map(p => p.targets?.length ?? 0))); }

  /** An accessor's values as floats (normalized integers mapped to −1…1 or 0…1), sparse values applied. Cached. */
  accessor(index: number): Float32Array {
    const cached = this.cache.get(index);
    if (cached) return cached;
    const accessor = this.json.accessors?.[index];
    if (!accessor) fail(`accessor ${index} is missing.`);
    const components = COMPONENTS[accessor!.type], size = BYTES[accessor!.componentType];
    if (!components || !size) fail(`accessor ${index} has an unknown type.`);
    const out = new Float32Array(accessor!.count * components);
    const read = (viewIndex: number, byteOffset: number, count: number, componentType: number, perElement: number, normalized: boolean, target: Float32Array) => {
      const view = this.json.bufferViews?.[viewIndex];
      if (!view) fail(`bufferView ${viewIndex} is missing.`);
      const elementBytes = BYTES[componentType] * perElement;
      const stride = view!.byteStride ?? elementBytes;
      const start = (view!.byteOffset ?? 0) + byteOffset;
      if (start + stride * (count - 1) + elementBytes > this.bin.byteLength) fail(`accessor ${index} reads past the binary data.`);
      const data = new DataView(this.bin.buffer, this.bin.byteOffset, this.bin.byteLength);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < perElement; c++) {
          const at = start + i * stride + c * BYTES[componentType];
          let value: number;
          switch (componentType) {
            case 5120: value = data.getInt8(at); if (normalized) value = Math.max(value / 127, -1); break;
            case 5121: value = data.getUint8(at); if (normalized) value /= 255; break;
            case 5122: value = data.getInt16(at, true); if (normalized) value = Math.max(value / 32767, -1); break;
            case 5123: value = data.getUint16(at, true); if (normalized) value /= 65535; break;
            case 5125: value = data.getUint32(at, true); break;
            default: value = data.getFloat32(at, true);
          }
          target[i * perElement + c] = value;
        }
      }
    };
    if (accessor!.bufferView !== undefined) read(accessor!.bufferView, accessor!.byteOffset ?? 0, accessor!.count, accessor!.componentType, components, accessor!.normalized === true, out);
    const sparse = accessor!.sparse;
    if (sparse) {
      const indices = new Float32Array(sparse.count), values = new Float32Array(sparse.count * components);
      read(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.count, sparse.indices.componentType, 1, false, indices);
      read(sparse.values.bufferView, sparse.values.byteOffset ?? 0, sparse.count, accessor!.componentType, components, accessor!.normalized === true, values);
      for (let i = 0; i < sparse.count; i++) {
        const at = indices[i];
        if (!(at >= 0 && at < accessor!.count)) fail(`accessor ${index} has a sparse index out of range.`);
        out.set(values.subarray(i * components, (i + 1) * components), at * components);
      }
    }
    for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) fail(`accessor ${index} contains a value that is not a finite number.`);
    this.cache.set(index, out);
    return out;
  }

  private texture(info: TextureInfo | undefined): TextureRef | undefined {
    if (!info || !Number.isInteger(info.index)) return undefined;
    const texture = this.json.textures?.[info.index];
    if (texture?.source === undefined) return undefined;
    const sampler = texture.sampler !== undefined ? this.json.samplers?.[texture.sampler] : undefined;
    const transform = info.extensions?.KHR_texture_transform;
    const ref: TextureRef = { image: texture.source, texCoord: transform?.texCoord ?? info.texCoord ?? 0, wrapS: sampler?.wrapS ?? 10497, wrapT: sampler?.wrapT ?? 10497 };
    if (transform) {
      ref.transform = {
        offset: [transform.offset?.[0] ?? 0, transform.offset?.[1] ?? 0], scale: [transform.scale?.[0] ?? 1, transform.scale?.[1] ?? 1], rotation: transform.rotation ?? 0,
      };
    }
    return ref;
  }

  materials(): ModelMaterial[] {
    return (this.json.materials ?? []).map((material, index) => {
      const pbr = material.pbrMetallicRoughness, gloss = material.extensions?.KHR_materials_pbrSpecularGlossiness;
      const factor = gloss?.diffuseFactor ?? pbr?.baseColorFactor ?? [1, 1, 1, 1];
      const texture = this.texture(gloss?.diffuseTexture ?? pbr?.baseColorTexture);
      const alphaMode = material.alphaMode === "MASK" || material.alphaMode === "BLEND" ? material.alphaMode : "OPAQUE";
      return {
        name: (typeof material.name === "string" && material.name ? material.name : `material ${index + 1}`).slice(0, 60),
        color: [linearToSrgb(factor[0] ?? 1), linearToSrgb(factor[1] ?? 1), linearToSrgb(factor[2] ?? 1), Math.max(0, Math.min(1, factor[3] ?? 1))],
        ...(texture ? { texture } : {}), alphaMode,
      };
    });
  }

  images(): ModelImage[] {
    return (this.json.images ?? []).map(image => {
      const view = image.bufferView !== undefined ? this.json.bufferViews?.[image.bufferView] : undefined;
      if (!view) return { mime: "application/octet-stream", data: new Uint8Array(0) };
      const start = view.byteOffset ?? 0;
      const data = this.bin.subarray(start, start + view.byteLength);
      const mime = data[0] === 0x89 && data[1] === 0x50 ? "image/png" : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : image.mimeType ?? "application/octet-stream";
      return { mime, data };
    });
  }

  /** Morph weights per node in a pose: the animation's, else the node's, else the mesh's (else none). */
  private morphWeights(pose?: Pose): (number[] | null)[] {
    const nodes = this.json.nodes ?? [];
    const out = nodes.map(node => {
      const mesh = node.mesh !== undefined ? this.json.meshes?.[node.mesh] : undefined;
      const count = Math.max(0, ...(mesh?.primitives ?? []).map(p => p.targets?.length ?? 0));
      if (!count) return null;
      const base = node.weights ?? mesh?.weights ?? [];
      return Array.from({ length: count }, (_, k) => Number.isFinite(base[k]) ? base[k] : 0);
    });
    const animation = pose ? this.json.animations?.[pose.animation] : undefined;
    for (const channel of animation?.channels ?? []) {
      const node = channel.target?.node;
      if (node === undefined || channel.target.path !== "weights" || !out[node]) continue;
      const sampler = animation!.samplers[channel.sampler];
      if (!sampler) continue;
      const value = sampleChannel(this.accessor(sampler.input), this.accessor(sampler.output), out[node]!.length, sampler.interpolation ?? "LINEAR", pose!.time, false);
      if (value) out[node] = value;
    }
    return out;
  }

  /** Each node's local matrix in a pose (the rest pose, or an animation sampled at a time). */
  private locals(pose?: Pose): Mat4[] {
    const nodes = this.json.nodes ?? [];
    const trs = nodes.map(node => ({
      t: [...(node.translation ?? [0, 0, 0])], r: [...(node.rotation ?? [0, 0, 0, 1])], s: [...(node.scale ?? [1, 1, 1])],
    }));
    const animation = pose ? this.json.animations?.[pose.animation] : undefined;
    if (animation) {
      for (const channel of animation.channels ?? []) {
        const node = channel.target?.node;
        if (node === undefined || !trs[node]) continue;
        const path = channel.target.path;
        if (path !== "translation" && path !== "rotation" && path !== "scale") continue;
        const sampler = animation.samplers[channel.sampler];
        if (!sampler) continue;
        const value = sampleChannel(this.accessor(sampler.input), this.accessor(sampler.output), path === "rotation" ? 4 : 3, sampler.interpolation ?? "LINEAR", pose!.time, path === "rotation");
        if (value) {
          if (path === "translation") trs[node].t = value; else if (path === "rotation") trs[node].r = value; else trs[node].s = value;
        }
      }
    }
    return nodes.map((node, index) => {
      // A node animated by TRS ignores its matrix; otherwise a matrix, when given, is its transform.
      if (node.matrix && node.matrix.length === 16 && !animation?.channels.some(c => c.target?.node === index)) return Float64Array.from(node.matrix);
      return compose(trs[index].t, trs[index].r, trs[index].s);
    });
  }

  /** World matrices of every node (and which nodes the default scene shows). */
  private worlds(pose?: Pose): { world: (Mat4 | null)[]; shown: number[] } {
    const nodes = this.json.nodes ?? [], locals = this.locals(pose);
    const world: (Mat4 | null)[] = nodes.map(() => null);
    const scene = this.json.scenes?.[this.json.scene ?? 0];
    const childOf = new Set(nodes.flatMap(node => node.children ?? []));
    const roots = scene?.nodes ?? nodes.map((_, index) => index).filter(index => !childOf.has(index));
    const shown: number[] = [];
    const visit = (index: number, parent: Mat4) => {
      if (world[index]) return;
      world[index] = multiply(parent, locals[index]);
      shown.push(index);
      for (const child of nodes[index].children ?? []) visit(child, world[index]!);
    };
    for (const root of roots) visit(root, identity());
    // Joints outside the shown scene still need world matrices for skinning.
    nodes.forEach((_, index) => { if (!world[index]) visit(index, identity()); });
    return { world, shown };
  }

  /** The model's geometry in a pose (default: the rest pose). */
  geometry(pose?: Pose): ModelGeometry {
    const nodes = this.json.nodes ?? [], meshes = this.json.meshes ?? [];
    const { world, shown } = this.worlds(pose);
    const morphs = this.morphWeights(pose);
    const warnings = [...this.warnings];
    const primitives: ModelPrimitive[] = [];
    const skinMatrices = (this.json.skins ?? []).map(skin => {
      const inverse = skin.inverseBindMatrices !== undefined ? this.accessor(skin.inverseBindMatrices) : null;
      return skin.joints.map((joint, j) => {
        const jointWorld = world[joint] ?? identity();
        return inverse ? multiply(jointWorld, Float64Array.from(inverse.subarray(j * 16, j * 16 + 16))) : jointWorld;
      });
    });
    for (const nodeIndex of shown) {
      const node = nodes[nodeIndex];
      if (node.mesh === undefined) continue;
      const mesh = meshes[node.mesh];
      for (const primitive of mesh?.primitives ?? []) {
        const mode = primitive.mode ?? 4;
        if (mode !== 4 && mode !== 5 && mode !== 6) { if (!warnings.includes("points-or-lines")) warnings.push("points-or-lines"); continue; }
        let source = this.accessor(primitive.attributes.POSITION);
        const vertexCount = source.length / 3;
        // Morph targets: the base positions plus each target's deltas times its weight (before skinning, as glTF says).
        const weights = morphs[nodeIndex];
        if (weights && primitive.targets?.length && weights.some(w => w !== 0)) {
          const morphed = Float32Array.from(source);
          primitive.targets.forEach((target, k) => {
            const w = weights[k] ?? 0;
            if (!w || target.POSITION === undefined) return;
            const delta = this.accessor(target.POSITION);
            if (delta.length !== morphed.length) return;
            for (let i = 0; i < morphed.length; i++) morphed[i] += delta[i] * w;
          });
          source = morphed;
        }
        let positions: Float32Array;
        const skinned = node.skin !== undefined && primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined && skinMatrices[node.skin];
        if (skinned) {
          // glTF: a skinned mesh's own node transform is ignored; its joints place it.
          positions = skin(source, this.accessor(primitive.attributes.JOINTS_0), this.accessor(primitive.attributes.WEIGHTS_0), skinMatrices[node.skin!]);
        } else positions = transform(source, world[nodeIndex]!);
        let indices: Uint32Array;
        if (primitive.indices !== undefined) {
          const raw = this.accessor(primitive.indices);
          indices = new Uint32Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            if (!(raw[i] >= 0 && raw[i] < vertexCount)) fail(`mesh ${node.mesh} has an index out of range.`);
            indices[i] = raw[i];
          }
        } else indices = Uint32Array.from({ length: vertexCount }, (_, i) => i);
        if (mode === 5) indices = strip(indices); else if (mode === 6) indices = fan(indices);
        else if (indices.length % 3) indices = indices.subarray(0, indices.length - (indices.length % 3));
        const uvs = [0, 1].map(set => primitive.attributes[`TEXCOORD_${set}`] !== undefined ? this.accessor(primitive.attributes[`TEXCOORD_${set}`]) : undefined);
        let colors: Float32Array | undefined;
        if (primitive.attributes.COLOR_0 !== undefined) {
          const raw = this.accessor(primitive.attributes.COLOR_0), width = raw.length / vertexCount;
          if (width === 3 || width === 4) {
            colors = new Float32Array(vertexCount * 4);
            for (let i = 0; i < vertexCount; i++) {
              colors[i * 4] = linearToSrgb(raw[i * width]); colors[i * 4 + 1] = linearToSrgb(raw[i * width + 1]); colors[i * 4 + 2] = linearToSrgb(raw[i * width + 2]);
              colors[i * 4 + 3] = width === 4 ? raw[i * width + 3] : 1;
            }
          }
        }
        const material = primitive.material !== undefined && this.json.materials?.[primitive.material] ? primitive.material : -1;
        primitives.push({ positions, indices, uvs, ...(colors ? { colors } : {}), material, node: nodeIndex });
      }
    }
    const materials = this.materials();
    // Primitives without a material use the glTF default (white) — appended as the last material.
    if (primitives.some(p => p.material < 0)) {
      materials.push({ ...DEFAULT_MATERIAL, color: [1, 1, 1, 1] });
      for (const p of primitives) if (p.material < 0) p.material = materials.length - 1;
    }
    return { format: "glb", primitives, materials, images: this.images(), animations: this.animations, skins: this.json.skins?.length ?? 0, warnings };
  }
}

function transform(source: Float32Array, m: Mat4): Float32Array {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    const x = source[i], y = source[i + 1], z = source[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/** Linear blend skinning: each vertex is the weighted sum of its joints' (world × inverse bind) transforms. */
function skin(source: Float32Array, joints: Float32Array, weights: Float32Array, matrices: Mat4[]): Float32Array {
  const out = new Float32Array(source.length), count = source.length / 3;
  for (let i = 0; i < count; i++) {
    const x = source[i * 3], y = source[i * 3 + 1], z = source[i * 3 + 2];
    let ox = 0, oy = 0, oz = 0, total = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[i * 4 + k];
      if (!(w > 0)) continue;
      const m = matrices[joints[i * 4 + k]];
      if (!m) continue;
      ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      total += w;
    }
    if (total > 0) { out[i * 3] = ox / total; out[i * 3 + 1] = oy / total; out[i * 3 + 2] = oz / total; }
    else { out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z; }
  }
  return out;
}

function strip(indices: Uint32Array): Uint32Array {
  const out: number[] = [];
  for (let i = 0; i + 2 < indices.length; i++) {
    if (i % 2) out.push(indices[i + 1], indices[i], indices[i + 2]); else out.push(indices[i], indices[i + 1], indices[i + 2]);
  }
  return Uint32Array.from(out);
}
function fan(indices: Uint32Array): Uint32Array {
  const out: number[] = [];
  for (let i = 1; i + 1 < indices.length; i++) out.push(indices[0], indices[i], indices[i + 1]);
  return Uint32Array.from(out);
}

/** One animation channel's value at `time` (clamped to its keys): STEP, LINEAR (slerp for rotations) or CUBICSPLINE. */
export function sampleChannel(input: Float32Array, output: Float32Array, width: number, interpolation: string, time: number, rotation: boolean): number[] | null {
  const keys = input.length;
  if (!keys) return null;
  const cubic = interpolation === "CUBICSPLINE";
  const value = (key: number) => {
    const at = cubic ? (key * 3 + 1) * width : key * width;
    return Array.from(output.subarray(at, at + width));
  };
  if (output.length < keys * width * (cubic ? 3 : 1)) return null;
  if (time <= input[0]) return value(0);
  if (time >= input[keys - 1]) return value(keys - 1);
  let k = 0;
  while (k < keys - 2 && input[k + 1] <= time) k++;
  const t0 = input[k], t1 = input[k + 1], span = t1 - t0, s = span > 0 ? (time - t0) / span : 0;
  if (interpolation === "STEP") return value(k);
  if (cubic) {
    const p0 = value(k), p1 = value(k + 1);
    const m0 = Array.from(output.subarray((k * 3 + 2) * width, (k * 3 + 3) * width)).map(v => v * span);
    const m1 = Array.from(output.subarray(((k + 1) * 3) * width, ((k + 1) * 3 + 1) * width)).map(v => v * span);
    const s2 = s * s, s3 = s2 * s;
    const out = p0.map((_, i) => (2 * s3 - 3 * s2 + 1) * p0[i] + (s3 - 2 * s2 + s) * m0[i] + (-2 * s3 + 3 * s2) * p1[i] + (s3 - s2) * m1[i]);
    return rotation ? normalize(out) : out;
  }
  const a = value(k), b = value(k + 1);
  if (!rotation) return a.map((v, i) => v + (b[i] - v) * s);
  return slerp(a, b, s);
}

function normalize(q: number[]) { const l = Math.hypot(...q) || 1; return q.map(v => v / l); }
function slerp(a: number[], b: number[], t: number): number[] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const target = dot < 0 ? b.map(v => -v) : b;
  dot = Math.abs(dot);
  if (dot > 0.9995) return normalize(a.map((v, i) => v + (target[i] - v) * t));
  const theta = Math.acos(dot), sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin, wb = Math.sin(t * theta) / sin;
  return a.map((v, i) => v * wa + target[i] * wb);
}

/** Convenience: the rest-pose geometry of a validated, self-contained GLB. */
export function readGltfGeometry(bytes: Uint8Array): ModelGeometry { return new GltfModel(bytes).geometry(); }
