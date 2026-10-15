import { parseColor } from "../core/colors";
import type { Easing, Keyframe, MaterialProps, SceneAnimation, SceneDocument, SceneNode, Vec3, Wave } from "./ir";
import { add, apply, IDENTITY, mul, normalize, nodeTransform, quatAxisAngle, quatFromEuler, quatFromTo, quatLookAlong, quatMul, rotate, scaleVec, sub, unapply, type Quat, type Transform } from "./math";
import { pathPoints, pointAt, samplePath, type SampledPath } from "./paths";

/**
 * The procedural animation engine (v0.5), renderer-independent. Animations are declarative data (ir.ts); this module
 * turns a document and a time into poses: for every animated node its position, orientation, scale and material
 * values, and for flowing point clouds their particle positions. It is pure — the same document and the same clocks
 * always give the same poses — so it is frame-rate independent by construction (a pose depends on time, never on how
 * many frames were drawn) and is tested without a browser.
 *
 * Time: one timeline (SceneTimeline) with a playback speed; each animation has its own clock that runs with it, so one
 * animation can be stopped where it is (`paused`) while the rest moves on; seeking sets every running clock.
 *
 * This is illustrative motion. Orbits are geometric (constant angular rate, or an ellipse at constant angular rate), not
 * gravitational integration; nothing here is a physical simulation.
 */
export interface NodePose {
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  visible?: boolean;
}

/** One clock per animation, driven by a shared timeline. */
export class SceneTimeline {
  /** Seconds of timeline time since the start (scaled by speed). */
  time = 0;
  speed = 1;
  playing = true;
  private readonly clocks = new Map<string, number>();

  /** Starts clocks for new animations (at 0: a newly added motion begins at its start), drops removed ones. */
  sync(animations: readonly SceneAnimation[]) {
    const ids = new Set(animations.map(a => a.id));
    for (const id of this.clocks.keys()) if (!ids.has(id)) this.clocks.delete(id);
    for (const a of animations) if (!this.clocks.has(a.id)) this.clocks.set(a.id, 0);
  }

  /** Advances by `dt` real seconds: every running clock moves by dt × speed; stopped ones stay. */
  advance(dt: number, animations: readonly SceneAnimation[]) {
    if (!this.playing || dt <= 0) return;
    const step = dt * this.speed;
    this.time += step;
    for (const a of animations) if (!a.paused) this.clocks.set(a.id, (this.clocks.get(a.id) ?? 0) + step);
  }

  /** Jumps the timeline (and every running clock) to `seconds`. Stopped animations stay where they are. */
  seek(seconds: number, animations: readonly SceneAnimation[]) {
    this.time = Math.max(0, seconds);
    for (const a of animations) if (!a.paused) this.clocks.set(a.id, this.time);
  }

  reset() { this.time = 0; for (const id of this.clocks.keys()) this.clocks.set(id, 0); }

  clock(id: string) { return this.clocks.get(id) ?? 0; }
}

const ease = (t: number, easing: Easing = "linear") => {
  switch (easing) {
    case "linear": return t;
    case "ease-in": return t * t * t;
    case "ease-out": return 1 - (1 - t) ** 3;
    case "ease-in-out": return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    case "step": return t < 1 ? 0 : 1;
  }
};

/** A waveform in −1…1 at `degrees` of its cycle. */
export function wave(degrees: number, shape: Wave = "sine") {
  const cycle = ((degrees / 360) % 1 + 1) % 1;
  switch (shape) {
    case "sine": return Math.sin(cycle * Math.PI * 2);
    case "square": return cycle < 0.5 ? 1 : -1;
    case "triangle": return cycle < 0.25 ? cycle * 4 : cycle < 0.75 ? 2 - cycle * 4 : cycle * 4 - 4;
    case "saw": return cycle * 2 - 1;
  }
}

/** Local time of an animation (seconds since it started, at its own time scale; 0 before it starts). */
export const localTime = (a: SceneAnimation, clock: number) => Math.max(0, (clock - (a.start ?? 0)) * (a.timeScale ?? 1));

/** Progress 0…1 through a finite animation of `duration` seconds, with repeats and yoyo. */
export function progress(a: SceneAnimation, u: number, duration: number): number {
  if (duration <= 0) return 1;
  const repeats = a.repeat === "loop" ? Infinity : a.repeat ?? 1;
  const cycles = u / duration;
  if (cycles >= repeats) return a.yoyo && repeats % 2 === 0 ? 0 : 1;
  const whole = Math.floor(cycles), part = cycles - whole;
  return a.yoyo && whole % 2 === 1 ? 1 - part : part;
}

/** Periodic motion stops after `repeat` cycles when it has a number (its cycle length: `period`). */
const periodicTime = (a: SceneAnimation, u: number, period: number) => a.repeat === undefined || a.repeat === "loop" ? u : Math.min(u, a.repeat * period);

const hex = (value: string) => parseColor(value)?.hex ?? "#ffffff";
const rgb = (value: string) => [1, 3, 5].map(i => parseInt(hex(value).slice(i, i + 2), 16) / 255) as Vec3;
const toHex = (c: Vec3) => `#${c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;

function keyframeValue(keys: Keyframe[], t: number, easing: Easing | undefined): Keyframe["value"] {
  if (t <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.value;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const k = ease((t - a.t) / (b.t - a.t || 1), easing);
  if (typeof a.value === "boolean" || typeof b.value === "boolean") return k < 1 ? a.value : b.value;
  if (typeof a.value === "number" && typeof b.value === "number") return a.value + (b.value - a.value) * k;
  if (typeof a.value === "string" && typeof b.value === "string") { const ca = rgb(a.value), cb = rgb(b.value); return toHex([0, 1, 2].map(j => ca[j] + (cb[j] - ca[j]) * k) as Vec3); }
  const va = typeof a.value === "number" ? [a.value, a.value, a.value] as Vec3 : a.value as Vec3, vb = typeof b.value === "number" ? [b.value, b.value, b.value] as Vec3 : b.value as Vec3;
  return [0, 1, 2].map(j => va[j] + (vb[j] - va[j]) * k) as Vec3;
}

/** The node's own material values (a shared material merged under its own), for animations that change them. */
export function materialOf(doc: SceneDocument, node: SceneNode): MaterialProps {
  if (node.material === undefined) return {};
  if (typeof node.material === "string") { const shared = doc.materials?.find(m => m.id === node.material); if (!shared) return {}; const { id: _id, name: _name, ...props } = shared; return props; }
  return node.material;
}

/**
 * Evaluates every animated node of a document at the clocks' current times. Poses are in each node's parent frame.
 * Nodes without animations are not included (they keep their document transform).
 */
export class PoseEvaluator {
  private readonly nodes: Map<string, SceneNode>;
  private readonly byTarget = new Map<string, SceneAnimation[]>();
  private readonly paths = new Map<string, SampledPath>();
  private readonly spins: Map<string, SceneAnimation>;
  private poses = new Map<string, NodePose>();
  private evaluating = new Set<string>();
  private clock: (id: string) => number = () => 0;

  constructor(private readonly doc: SceneDocument) {
    this.nodes = new Map(doc.objects.map(n => [n.id, n]));
    for (const a of doc.animations ?? []) this.byTarget.set(a.target, [...(this.byTarget.get(a.target) ?? []), a]);
    this.spins = new Map((doc.animations ?? []).map(a => [a.id, a]));
  }

  /** Ids of every node with at least one animation. */
  get animated(): string[] { return [...this.byTarget.keys()]; }

  /** All animated nodes' poses at the given clocks. */
  evaluate(clock: (id: string) => number): Map<string, NodePose> {
    this.clock = clock;
    this.poses = new Map();
    for (const id of this.byTarget.keys()) this.pose(id);
    return this.poses;
  }

  /** The path a path-like node stands for, in its parent's frame (as it is posed now). */
  pathOf(id: string): SampledPath | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const local = this.localPath(id);
    if (!local) return null;
    const transform = this.transformOf(node);
    return samplePath(local.points.map(p => apply(transform, p)), local.closed);
  }

  private localPath(id: string) {
    let cached = this.paths.get(id);
    if (!cached) {
      const node = this.nodes.get(id), points = node ? pathPoints(node) : null;
      if (!points) return null;
      cached = samplePath(points.points, points.closed);
      this.paths.set(id, cached);
    }
    return cached;
  }

  private transformOf(node: SceneNode): Transform {
    const pose = this.byTarget.has(node.id) ? this.pose(node.id) : null;
    return pose ? { position: pose.position, quaternion: pose.quaternion, scale: pose.scale } : nodeTransform(node);
  }

  /** The angle (degrees) a spin, or a coupling of spins, has turned at its clock. */
  spinAngle(a: SceneAnimation, depth = 0): number {
    if (depth > 32) return 0;
    if (a.type === "spin") return (a.speed ?? 0) * periodicTime(a, localTime(a, this.clock(a.id)), 360 / Math.max(1e-6, Math.abs(a.speed ?? 1)));
    if (a.type === "couple") { const source = this.spins.get(a.source!); return source ? (a.ratio ?? 1) * this.spinAngle(source, depth + 1) : 0; }
    return 0;
  }

  private pose(id: string): NodePose {
    const done = this.poses.get(id);
    if (done) return done;
    const node = this.nodes.get(id)!;
    const base = nodeTransform(node);
    // A cycle cannot pass validation; if it ever did, the node simply keeps its document transform.
    if (this.evaluating.has(id)) return { ...base };
    this.evaluating.add(id);
    const pose: NodePose = { position: [...base.position] as Vec3, quaternion: [...base.quaternion] as Quat, scale: [...base.scale] as Vec3 };
    const material = materialOf(this.doc, node);
    for (const a of this.byTarget.get(id) ?? []) this.applyAnimation(a, base, pose, material);
    this.evaluating.delete(id);
    this.poses.set(id, pose);
    return pose;
  }

  private applyAnimation(a: SceneAnimation, base: Transform, pose: NodePose, material: MaterialProps) {
    const u = localTime(a, this.clock(a.id));
    const axis = normalize(a.axis ?? [0, 1, 0]);
    switch (a.type) {
      case "spin": case "couple": {
        const turnAxis = a.type === "couple" && !a.axis ? normalize(this.spins.get(a.source!)?.axis ?? [0, 1, 0]) : axis;
        pose.quaternion = quatMul(pose.quaternion, quatAxisAngle(turnAxis, this.spinAngle(a)));
        break;
      }
      case "orbit": {
        const center: Vec3 = typeof a.center === "string" ? this.pose(a.center).position : a.center ?? [0, 0, 0];
        const centerBase: Vec3 = typeof a.center === "string" ? nodeTransform(this.nodes.get(a.center)!).position : a.center ?? [0, 0, 0];
        const radius = a.radius ?? (Math.hypot(...sub(base.position, centerBase)) || 1);
        const period = a.period ?? 10;
        const theta = ((a.phase ?? 0) + 360 * periodicTime(a, u, period) / period * (a.clockwise ? -1 : 1)) * Math.PI / 180;
        const e = a.eccentricity ?? 0;
        const r = e > 0 ? radius * (1 - e * e) / (1 + e * Math.cos(theta)) : radius;
        let offset: Vec3 = [r * Math.cos(theta), 0, -r * Math.sin(theta)];
        if (a.inclination) offset = rotate(offset, quatAxisAngle([1, 0, 0], a.inclination));
        offset = rotate(offset, quatFromTo([0, 1, 0], axis));
        pose.position = add(center, offset);
        break;
      }
      case "oscillate": {
        const period = a.period ?? 1;
        const w = wave((a.phase ?? 0) + 360 * periodicTime(a, u, period) / period, a.wave);
        const amplitude = a.amplitude ?? 0;
        switch (a.property) {
          case "position": pose.position = add(pose.position, mul(axis, amplitude * w)); break;
          case "rotation": pose.quaternion = quatMul(pose.quaternion, quatAxisAngle(axis, amplitude * w)); break;
          case "scale": pose.scale = mul(pose.scale, Math.max(0, 1 + amplitude * w)); break;
          case "opacity": pose.opacity = Math.max(0, Math.min(1, (pose.opacity ?? material.opacity ?? 1) + amplitude * w)); break;
          case "emissive": pose.emissiveIntensity = Math.max(0, (pose.emissiveIntensity ?? material.emissiveIntensity ?? 0) + amplitude * (w + 1) / 2); break;
          default: break;
        }
        break;
      }
      case "keyframes": {
        const keys = a.keys!;
        const duration = keys[keys.length - 1].t;
        const t = duration > 0 ? progress(a, u, duration) * duration : 0;
        const value = keyframeValue(keys, t, a.easing);
        switch (a.property) {
          case "position": pose.position = value as Vec3; break;
          case "rotation": pose.quaternion = quatFromEuler(value as Vec3); break;
          case "scale": pose.scale = typeof value === "number" ? [value, value, value] : value as Vec3; break;
          case "color": pose.color = value as string; break;
          case "emissive": pose.emissive = value as string; if (pose.emissiveIntensity === undefined && material.emissiveIntensity === undefined) pose.emissiveIntensity = 1; break;
          case "opacity": pose.opacity = value as number; break;
          case "visible": pose.visible = value as boolean; break;
          default: break;
        }
        break;
      }
      case "path": {
        const path = this.pathOf(a.path!);
        if (!path) break;
        const s = ease(progress(a, u, a.duration ?? 1), a.easing);
        const at = pointAt(path, s);
        pose.position = at.position;
        if (a.orient) pose.quaternion = quatLookAlong(at.tangent);
        break;
      }
      case "track": {
        const target = this.pose(a.lookAt!).position;
        const direction = sub(target, pose.position);
        if (Math.hypot(...direction) > 1e-9) pose.quaternion = quatLookAlong(direction);
        break;
      }
      case "flow": break; // Particle positions: see flowPositions.
    }
  }

  /**
   * Where a flowing point cloud's particles are now, in the cloud's own frame: `count` particles evenly spaced along the
   * path, moving at `rate` units per second (they wrap around a closed path and restart an open one).
   */
  flowPositions(a: SceneAnimation, count: number): Float32Array {
    const out = new Float32Array(count * 3);
    const path = this.pathOf(a.path!);
    const cloud = this.nodes.get(a.target);
    if (!path || !cloud || path.total <= 0) return out;
    const frame = this.transformOf(cloud);
    const shift = (a.rate ?? 1) * localTime(a, this.clock(a.id)) / path.total;
    for (let i = 0; i < count; i++) {
      const at = pointAt({ ...path, closed: true }, i / count + shift);
      const local = unapply(frame, at.position);
      out[i * 3] = local[0]; out[i * 3 + 1] = local[1]; out[i * 3 + 2] = local[2];
    }
    return out;
  }
}

/** The base pose of a node (its document transform), for nodes no animation touches. */
export const basePose = (node: SceneNode): NodePose => { const t = nodeTransform(node); return { position: t.position, quaternion: t.quaternion, scale: scaleVec(node.scale) }; };
export { IDENTITY };
