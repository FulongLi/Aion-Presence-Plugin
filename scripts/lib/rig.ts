/**
 * A small rigged-character builder (v0.9.1, development tooling): bones in a hierarchy, skinned parts built from Three.js
 * geometries (up to four bone influences per vertex), morph targets (POSITION deltas), and animation clips sampled from a
 * function of time, written as one self-contained glTF 2.0 GLB with a skin, inverse bind matrices, node TRS animation and
 * morph-weight animation. Used for Aion's own test characters and regression fixtures; any glTF viewer opens the result.
 *
 * Clips loop: the clip function must be periodic (its value at the duration equals its value at 0); the last key repeats
 * the first, so a glTF player and Aion's baker both loop seamlessly.
 */
import { CapsuleGeometry, CatmullRomCurve3, Euler, Quaternion, TubeGeometry, Vector3, type BufferGeometry } from "three";
import { writeGlb } from "../../src/cards/assets/gltf";

export type V3 = [number, number, number];
export type Influence = [bone: number, weight: number][];
export interface BonePose { /** Local translation added to the rest offset. */ t?: V3; /** Euler degrees (XYZ). */ r?: V3; s?: V3 }
export interface ClipFrame { bones: Record<number, BonePose>; morphs?: Record<string, number> }

interface Part { positions: Float32Array; indices: Uint32Array; joints: Uint16Array; weights: Float32Array; material: number; morphs: Float32Array[]; colors?: Float32Array }

const srgbToLinear = (value: number) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

export class RigBuilder {
  readonly bones: { name: string; parent: number; head: V3 }[] = [];
  private readonly materials: { name: string; color: V3 }[] = [];
  private readonly parts: Part[] = [];
  private readonly morphNames: string[] = [];
  private readonly clips: { name: string; duration: number; keys: number; frame: (t: number) => ClipFrame }[] = [];

  /** A bone whose rest position (its head) is `head` in model space; `parent` null for a root. */
  bone(name: string, parent: number | null, head: V3): number {
    this.bones.push({ name, parent: parent ?? -1, head });
    return this.bones.length - 1;
  }
  material(name: string, hex: string): number {
    this.materials.push({ name, color: [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as V3 });
    return this.materials.length - 1;
  }
  /** Declares a morph target by name (before the parts that deform with it). */
  morph(name: string) { if (!this.morphNames.includes(name)) this.morphNames.push(name); }

  /**
   * A skinned part: `geometry` (already placed in model space), its material, each vertex's bone influences, and its
   * displacement under each morph target (none: it does not deform with that target).
   */
  part(geometry: BufferGeometry, material: number, skin: (p: Vector3) => Influence, morphs: Record<string, (p: Vector3) => V3> = {}, color?: (p: Vector3) => V3) {
    const positions = new Float32Array(geometry.attributes.position.array as ArrayLike<number>);
    const count = positions.length / 3;
    const indices = geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : Uint32Array.from({ length: count }, (_, i) => i);
    const joints = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
    const colors = color ? new Float32Array(count * 4) : undefined;
    const morphData = this.morphNames.map(() => new Float32Array(count * 3));
    const p = new Vector3();
    for (let i = 0; i < count; i++) {
      p.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const influence = skin(p).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = influence.reduce((sum, [, w]) => sum + w, 0) || 1;
      influence.forEach(([bone, w], k) => { joints[i * 4 + k] = bone; weights[i * 4 + k] = w / total; });
      if (!influence.length) weights[i * 4] = 1;
      this.morphNames.forEach((name, m) => { const f = morphs[name]; if (f) morphData[m].set(f(p.clone()), i * 3); });
      if (colors && color) colors.set([...color(p.clone()).map(srgbToLinear), 1], i * 4);
    }
    this.parts.push({ positions, indices, joints, weights, material, morphs: morphData, ...(colors ? { colors } : {}) });
    geometry.dispose();
  }

  /** A looping clip sampled at `keys` + 1 evenly spaced times (the last repeats the first). */
  clip(name: string, duration: number, keys: number, frame: (t: number) => ClipFrame) { this.clips.push({ name, duration, keys, frame }); }

  toGlb(): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const bufferViews: Record<string, number>[] = [];
    const accessors: Record<string, unknown>[] = [];
    const view = (data: ArrayBufferView) => {
      const pad = (4 - (length % 4)) % 4;
      if (pad) { chunks.push(new Uint8Array(pad)); length += pad; }
      bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength });
      chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); length += data.byteLength;
      return bufferViews.length - 1;
    };
    const accessor = (data: Float32Array | Uint16Array | Uint32Array, type: string, components: number, bounds = false) => {
      const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125;
      const a: Record<string, unknown> = { bufferView: view(data), componentType, count: data.length / components, type };
      if (bounds) {
        const min = Array(components).fill(Infinity), max = Array(components).fill(-Infinity);
        for (let i = 0; i < data.length; i++) { const k = i % components; min[k] = Math.min(min[k], data[i]); max[k] = Math.max(max[k], data[i]); }
        a.min = min; a.max = max;
      }
      accessors.push(a);
      return accessors.length - 1;
    };
    const primitives = this.parts.map(part => ({
      attributes: {
        POSITION: accessor(part.positions, "VEC3", 3, true), JOINTS_0: accessor(part.joints, "VEC4", 4), WEIGHTS_0: accessor(part.weights, "VEC4", 4),
        ...(part.colors ? { COLOR_0: accessor(part.colors, "VEC4", 4) } : {}),
      },
      indices: accessor(part.indices, "SCALAR", 1), material: part.material, mode: 4,
      ...(this.morphNames.length ? { targets: part.morphs.map(delta => ({ POSITION: accessor(delta, "VEC3", 3, true) })) } : {}),
    }));
    const b = this.bones;
    const local = (i: number): V3 => { const p = b[i].parent; return p < 0 ? [...b[i].head] : [0, 1, 2].map(k => b[i].head[k] - b[p].head[k]) as V3; };
    const nodes: Record<string, unknown>[] = b.map((bone, i) => ({
      name: bone.name, translation: local(i), ...(b.some(c => c.parent === i) ? { children: b.map((c, j) => c.parent === i ? j : -1).filter(j => j >= 0) } : {}),
    }));
    const meshNode = nodes.length;
    nodes.push({ name: "body", mesh: 0, skin: 0 });
    const inverse = new Float32Array(b.length * 16);
    b.forEach((bone, i) => { inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.head[0], -bone.head[1], -bone.head[2], 1], i * 16); });
    const animations = this.clips.map(clip => {
      const times = Float32Array.from({ length: clip.keys + 1 }, (_, k) => k / clip.keys * clip.duration);
      const frames = Array.from(times, t => clip.frame(t % clip.duration === 0 && t > 0 ? 0 : t));
      const input = accessor(times, "SCALAR", 1, true);
      const samplers: Record<string, unknown>[] = [], channels: Record<string, unknown>[] = [];
      const add = (node: number, path: string, output: Float32Array, components: number) => {
        samplers.push({ input, output: accessor(output, components === 1 ? "SCALAR" : `VEC${components}`, components), interpolation: "LINEAR" });
        channels.push({ sampler: samplers.length - 1, target: { node, path } });
      };
      b.forEach((_, i) => {
        if (!frames.some(f => f.bones[i])) return;
        const rest = local(i);
        add(i, "translation", Float32Array.from(frames.flatMap(f => rest.map((v, k) => v + (f.bones[i]?.t?.[k] ?? 0)))), 3);
        add(i, "rotation", Float32Array.from(frames.flatMap(f => {
          const r = f.bones[i]?.r ?? [0, 0, 0];
          const q = new Quaternion().setFromEuler(new Euler(...r.map(d => d * Math.PI / 180) as V3, "XYZ"));
          return [q.x, q.y, q.z, q.w];
        })), 4);
        add(i, "scale", Float32Array.from(frames.flatMap(f => f.bones[i]?.s ?? [1, 1, 1])), 3);
      });
      if (this.morphNames.length) {
        const weights = Float32Array.from(frames.flatMap(f => this.morphNames.map(name => f.morphs?.[name] ?? 0)));
        samplers.push({ input, output: accessor(weights, "SCALAR", 1), interpolation: "LINEAR" });
        channels.push({ sampler: samplers.length - 1, target: { node: meshNode, path: "weights" } });
      }
      return { name: clip.name, samplers, channels };
    });
    const skin = { joints: b.map((_, i) => i), inverseBindMatrices: accessor(inverse, "MAT4", 16), skeleton: 0 };
    const bin = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { bin.set(chunk, at); at += chunk.byteLength; }
    const roots = b.map((bone, i) => bone.parent < 0 ? i : -1).filter(i => i >= 0);
    const json = {
      asset: { version: "2.0", generator: "Aion Presence rig builder" },
      scene: 0, scenes: [{ nodes: [...roots, meshNode] }], nodes, skins: [skin],
      meshes: [{ primitives, ...(this.morphNames.length ? { weights: this.morphNames.map(() => 0), extras: { targetNames: this.morphNames } } : {}) }],
      materials: this.materials.map(m => ({ name: m.name, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...m.color.map(srgbToLinear), 1], metallicFactor: 0, roughnessFactor: 0.8 } })),
      accessors, bufferViews, buffers: [{ byteLength: length }], ...(animations.length ? { animations } : {}),
    };
    return writeGlb(json, bin);
  }
}

/** Smooth weights between two bones along a coordinate (a soft joint): below `from` all `a`, above `to` all `b`. */
export function blend(value: number, from: number, to: number, a: number, b: number): Influence {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  const s = t * t * (3 - 2 * t);
  return [[a, 1 - s], [b, s]];
}
export const placed = <T extends BufferGeometry>(geometry: T, at: V3, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): T => {
  geometry.scale(...scale);
  geometry.rotateX(rotation[0] * Math.PI / 180); geometry.rotateY(rotation[1] * Math.PI / 180); geometry.rotateZ(rotation[2] * Math.PI / 180);
  geometry.translate(...at);
  return geometry;
};
/** A tube along `points` whose radius goes from r0 to r1 (closed with small caps by its last rings). */
export function taperedTube(points: V3[], r0: number, r1: number, segments = 48, radial = 14): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map(p => new Vector3(...p)));
  const tube = new TubeGeometry(curve, segments, 1, radial, false);
  const position = tube.attributes.position;
  for (let ring = 0; ring <= segments; ring++) {
    const u = ring / segments, centre = curve.getPointAt(u);
    // Rounded ends: the radius closes over the last few rings.
    const end = Math.min(1, Math.min(u, 1 - u) * segments / 3);
    const radius = (r0 + (r1 - r0) * u) * (u > 0.5 ? Math.sqrt(Math.max(0.05, end)) : 1);
    for (let k = 0; k <= radial; k++) {
      const i = ring * (radial + 1) + k;
      const v = new Vector3().fromBufferAttribute(position, i).sub(centre).multiplyScalar(radius).add(centre);
      position.setXYZ(i, v.x, v.y, v.z);
    }
  }
  return tube;
}

/** A capsule of radius r from a to b. */
export function capsuleBetween(a: V3, b: V3, r: number): BufferGeometry {
  const from = new Vector3(...a), to = new Vector3(...b), dir = to.clone().sub(from);
  const capsule = new CapsuleGeometry(r, Math.max(0.001, dir.length()), 8, 16);
  capsule.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize()));
  capsule.translate(...from.clone().add(to).multiplyScalar(0.5).toArray() as V3);
  return capsule;
}

/** Bone weight along a segment a → b: `parent` near a, `self` in the middle, `child` near b (soft joints at both ends). */
export function segmentSkin(p: Vector3, a: V3, b: V3, self: number, parent: number | null, child: number | null, soft = 0.22): Influence {
  const A = new Vector3(...a), B = new Vector3(...b), d = B.clone().sub(A);
  const t = Math.max(0, Math.min(1, p.clone().sub(A).dot(d) / d.lengthSq()));
  const out: Influence = [[self, 1]];
  if (parent !== null && t < soft) { const w = 0.5 * (1 - t / soft); out[0][1] -= w; out.push([parent, w]); }
  if (child !== null && t > 1 - soft) { const w = 0.5 * ((t - (1 - soft)) / soft); out[0][1] -= w; out.push([child, w]); }
  return out;
}

/** Periodic smooth interpolation through (time, value) keys over `duration` (Catmull-Rom; wraps around). */
export function periodic(keys: [number, number][], duration: number): (t: number) => number {
  const sorted = [...keys].sort((a, b) => a[0] - b[0]);
  return (time: number) => {
    const t = ((time % duration) + duration) % duration;
    let i = sorted.findIndex(([k]) => k > t) - 1;
    if (i < -1) i = sorted.length - 1;
    if (i === -1) i = sorted.length - 1;
    const at = (j: number) => { const n = sorted.length, k = ((j % n) + n) % n; const wrap = Math.floor(j / n) * duration; return [sorted[k][0] + wrap, sorted[k][1]]; };
    const [t1, v1] = at(i), [t2, v2] = at(i + 1), [, v0] = at(i - 1), [, v3] = at(i + 2);
    const span = (t2 < t1 ? t2 + duration : t2) - t1;
    const s = span > 0 ? (((t - t1) % duration) + duration) % duration / span : 0;
    const s2 = s * s, s3 = s2 * s;
    return 0.5 * (2 * v1 + (-v0 + v2) * s + (2 * v0 - 5 * v1 + 4 * v2 - v3) * s2 + (-v0 + 3 * v1 - 3 * v2 + v3) * s3);
  };
}

/**
 * Two-bone leg IK in the sagittal (y–z) plane: the hip, the wanted ankle, the bone lengths, and the rest angles (0 =
 * straight down, positive = forward) → each bone's local rotation about X in degrees (thigh, shin, foot flat).
 */
export function legIk(hip: [number, number], ankle: [number, number], l1: number, l2: number, rest: { thigh: number; shin: number }) {
  const dy = ankle[0] - hip[0], dz = ankle[1] - hip[1];
  const reach = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, Math.hypot(dy, dz)));
  const toAnkle = Math.atan2(dz, -dy);
  const inner = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach))));
  const thigh = toAnkle + inner; // knee bends forward
  const kneeY = hip[0] - Math.cos(thigh) * l1, kneeZ = hip[1] + Math.sin(thigh) * l1;
  const shin = Math.atan2(ankle[1] - kneeZ, -(ankle[0] - kneeY));
  const deg = 180 / Math.PI;
  return { thigh: -(thigh - rest.thigh) * deg, shin: -((shin - thigh) - (rest.shin - rest.thigh)) * deg, foot: (shin - rest.shin) * deg };
}

export { Vector3 };

/**
 * A soft-bodied bounce (v0.9.1), as a looping clip: rest → anticipation (squash) → launch (stretch) → airborne → landing
 * (a deeper squash) → recovery (a small rebound) → rest. The body deforms through two morph targets declared by
 * `bounceMorphs` (squash and stretch about the ground point); `crown` (the bone carrying the appendages) rides the top
 * of the deforming body; appendages trail the motion with a lag (rotations about X, splaying outward on landing).
 */
export const BOUNCE_SECONDS = 1.6;
export const bounceMorphs = {
  squash: (p: Vector3): V3 => [0.16 * p.x, -0.28 * p.y, 0.16 * p.z],
  stretch: (p: Vector3): V3 => [-0.08 * p.x, 0.18 * p.y, -0.08 * p.z],
};
export function softBounce(o: { root: number; crown?: { bone: number; height: number }; appendages?: { bone: number; side: number; gain?: number }[]; height?: number }): (t: number) => ClipFrame {
  const D = BOUNCE_SECONDS, h = o.height ?? 1.0, takeoff = 0.36, landing = 1.04;
  const squash = periodic([[0, 0], [0.14, 0.08], [0.29, 0.45], [0.37, 0.06], [0.5, 0], [0.98, 0], [1.08, 0.78], [1.17, 0.5], [1.28, 0.02], [1.45, 0], [1.6, 0]], D);
  const stretch = periodic([[0, 0], [0.3, 0], [0.42, 0.36], [0.6, 0.1], [0.76, 0], [0.96, 0.14], [1.04, 0.02], [1.2, 0], [1.33, 0.13], [1.48, 0], [1.6, 0]], D);
  const swing = periodic([[0, 0], [0.28, 8], [0.45, -28], [0.72, -6], [0.95, 14], [1.1, 32], [1.24, -14], [1.4, 6], [1.6, 0]], D);
  const splay = periodic([[0, 0], [0.4, -4], [0.75, 4], [1.0, 2], [1.1, 14], [1.3, -4], [1.6, 0]], D);
  return t => {
    const s = (t - takeoff) / (landing - takeoff);
    const y = s > 0 && s < 1 ? 4 * h * s * (1 - s) : 0;
    const sq = Math.max(0, squash(t)), st = Math.max(0, stretch(t));
    const bones: Record<number, BonePose> = { [o.root]: { t: [0, y, 0] } };
    if (o.crown) bones[o.crown.bone] = { t: [0, o.crown.height * (-0.28 * sq + 0.18 * st), 0] };
    for (const a of o.appendages ?? []) bones[a.bone] = { r: [swing(t) * (a.gain ?? 1), 0, splay(t) * a.side * (a.gain ?? 1)] };
    return { bones, morphs: { squash: sq, stretch: st } };
  };
}
