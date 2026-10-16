import { hexToRgb, luminance } from "../core/colors";
import { SCENE_LIMITS, type Scene3D, type SceneObject } from "../visual/scene3d/types";
import { checkScene } from "../visual/scene3d/validate";
import { PoseEvaluator, materialOf } from "./animation";
import type { SceneDocument, SceneNode, Vec3 } from "./ir";
import { compose, eulerFromQuat, IDENTITY_TRANSFORM, length, mul, nodeTransform, rotate, sub, type Transform } from "./math";
import { pathPoints } from "./paths";

/**
 * The Particle Renderer Adapter (v0.5): a Scene IR document as Aion's particle body can form it — the body's own 3D
 * scene of procedural primitives (src/visual/scene3d), which the body samples into particles. It does not try to be
 * Three.js: the body carries shape and arrangement, not text, exact colours or interaction. What it cannot form is left
 * out and said (`limitations`); `fit` (0…1) is how much of the scene survives, which the router weighs.
 *
 * Positions are taken at the start of the scene's animations (planets at their orbits' starting angles), in world space
 * (the hierarchy flattened), and the whole is scaled to the body's stage.
 */
export interface ParticleAdaptation { scene: Scene3D | null; fit: number; limitations: string[]; omitted: string[] }

const BODY_REACH = 8;

/** World transforms of every node at the scene's start (hierarchy and initial animation poses). */
function worldTransforms(doc: SceneDocument): Map<string, Transform> {
  const poses = new PoseEvaluator(doc).evaluate(() => 0);
  const byId = new Map(doc.objects.map(n => [n.id, n]));
  const world = new Map<string, Transform>();
  const of = (n: SceneNode, depth = 0): Transform => {
    const done = world.get(n.id);
    if (done) return done;
    const pose = poses.get(n.id);
    const local: Transform = pose ? { position: pose.position, quaternion: pose.quaternion, scale: pose.scale } : nodeTransform(n);
    const parent = n.parent && depth < 32 ? byId.get(n.parent) : undefined;
    const t = parent ? compose(of(parent, depth + 1), local) : compose(IDENTITY_TRANSFORM, local);
    world.set(n.id, t);
    return t;
  };
  for (const n of doc.objects) of(n);
  return world;
}

const visibleThrough = (doc: SceneDocument, n: SceneNode) => {
  const byId = new Map(doc.objects.map(o => [o.id, o]));
  for (let o: SceneNode | undefined = n, guard = 0; o && guard < 64; o = o.parent ? byId.get(o.parent) : undefined, guard++) if (o.visible === false) return false;
  return true;
};

/** A characteristic size of a node (for the stage's scale and for keeping the most visible objects). */
function extent(n: SceneNode): number {
  switch (n.type) {
    case "box": return Math.max(...n.size!) / 2;
    case "plane": return Math.max(n.width!, n.depth!) / 2;
    case "ring": return n.outer!;
    case "torus": return n.radius! + n.tube!;
    case "line": case "arrow": return length(sub(n.to!, n.from!)) / 2;
    case "polyline": case "curve": case "tube": return Math.max(...n.points!.map(p => length(p)));
    case "helix": return Math.max(n.radius!, n.height! / 2);
    default: return n.radius ?? (n.height ?? 1) / 2;
  }
}

export function toParticleScene(doc: SceneDocument): ParticleAdaptation {
  const world = worldTransforms(doc);
  const limitations = new Set<string>(), omitted: string[] = [];
  type Candidate = { object: SceneObject; importance: number; id: string };
  const candidates: Candidate[] = [];
  let total = 0, kept = 0;
  // The stage: everything that will be formed fits within ±BODY_REACH.
  let reach = 0;
  for (const n of doc.objects) {
    if (n.type === "group" || !visibleThrough(doc, n)) continue;
    const t = world.get(n.id)!;
    reach = Math.max(reach, length(t.position) + extent(n) * Math.max(...t.scale));
  }
  const k = reach > 0 ? BODY_REACH / reach : 1;
  const clampSize = (value: number) => { const v = value * k; if (v < SCENE_LIMITS.size.min) limitations.add("some objects are too small to form at this scale and are enlarged"); return Math.min(SCENE_LIMITS.size.max, Math.max(SCENE_LIMITS.size.min, v)); };
  const point = (t: Transform, p: Vec3): Vec3 => { const w = mul(rotate([p[0] * t.scale[0], p[1] * t.scale[1], p[2] * t.scale[2]], t.quaternion), 1); return [w[0] + t.position[0], w[1] + t.position[1], w[2] + t.position[2]].map(v => Math.max(-10, Math.min(10, v * k))) as Vec3; };

  for (const n of doc.objects) {
    if (n.type === "group") continue;
    if (!visibleThrough(doc, n)) continue;
    total += n.type === "text" ? 0.5 : 1;
    const t = world.get(n.id)!;
    const s = Math.cbrt(Math.abs(t.scale[0] * t.scale[1] * t.scale[2])) || 1;
    const residual = t.scale.map(v => v / s) as Vec3;
    const uniform = residual.every(v => Math.abs(v - 1) < 1e-3);
    const material = materialOf(doc, n);
    const glow = !!material.emissive || (material.emissiveIntensity ?? 0) > 0;
    const tone = Math.max(0.2, Math.min(1, glow ? 1 : 0.45 + 0.55 * Math.sqrt(luminance(hexToRgb(material.color ?? "#d0d8e0"))) * (material.opacity ?? 1)));
    const common = {
      position: t.position.map(v => Math.max(-10, Math.min(10, v * k))) as Vec3,
      rotation: eulerFromQuat(t.quaternion).map(v => Math.max(-720, Math.min(720, v))) as Vec3,
      ...(uniform ? {} : { scale: residual.map(v => Math.max(0.05, Math.min(10, v))) as Vec3 }),
      tone: Math.round(tone * 100) / 100,
      ...(n.repeat && !n.parent ? { repeat: { count: Math.min(64, n.repeat.count), ...(n.repeat.offset ? { offset: n.repeat.offset.map(v => Math.max(-5, Math.min(5, v * k * s))) as Vec3 } : {}), ...(n.repeat.rotation ? { rotation: n.repeat.rotation } : {}), ...(n.repeat.scale ? { scale: Math.max(0.5, Math.min(2, n.repeat.scale)) } : {}) } } : {}),
    };
    if (n.repeat && n.parent) limitations.add("repeats inside groups are formed once");
    if (n.repeat && n.repeat.count > 64) limitations.add("long repeats are shortened to 64 copies");
    const size = (value: number) => clampSize(value * s);
    let object: SceneObject | null = null;
    switch (n.type) {
      case "sphere": object = { type: "sphere", radius: size(n.radius!), ...common }; break;
      case "box": object = { type: "box", size: n.size!.map(v => size(v)) as Vec3, ...common }; break;
      case "cylinder": object = { type: "cylinder", radius: size(n.radius!), height: size(n.height!), ...(n.radiusTop !== undefined ? { radiusTop: Math.min(SCENE_LIMITS.size.max, n.radiusTop * s * k) } : {}), ...common }; break;
      case "cone": object = { type: "cone", radius: size(n.radius!), height: size(n.height!), ...common }; break;
      case "torus": { const radius = size(n.radius!), tube = Math.min(size(n.tube!), radius * 0.9); object = { type: "torus", radius, tube, ...common }; if (n.arc && n.arc < 360) limitations.add("partial tori are formed whole"); break; }
      case "ring": { const outer = size(n.outer!), inner = Math.min(outer * 0.99, n.inner! * s * k); object = { type: "ring", inner, outer, ...common }; break; }
      case "plane": object = { type: "box", size: [size(n.width!), clampSize(0.002), size(n.depth!)], ...common, detail: "edges" }; break;
      case "gear": object = { type: "cylinder", radius: size(n.radius!), height: size(n.thickness!), ...common }; limitations.add("gear teeth are formed as plain discs"); break;
      case "helix": object = { type: "helix", radius: size(n.radius!), height: size(n.height!), turns: Math.max(0.25, Math.min(24, n.turns!)), ...common }; break;
      case "line": case "arrow": object = { type: "line", from: point(t, n.from!), to: point(t, n.to!), tone: common.tone }; if (n.type === "arrow") limitations.add("arrow heads are not formed"); break;
      case "circle": case "polyline": case "curve": case "tube": {
        const path = pathPoints(n)!;
        const step = Math.max(1, Math.ceil(path.points.length / 40));
        const points = path.points.filter((_, i) => i % step === 0).slice(0, SCENE_LIMITS.points).map(p => point(t, p));
        if (points.length >= 2) object = n.type === "tube" ? { type: "tube", points, radius: size(n.radius!), closed: path.closed, tone: common.tone } : { type: "curve", points, closed: path.closed, tone: common.tone, detail: "edges" };
        break;
      }
      case "points": limitations.add("point clouds are not formed (the body is particles already)"); break;
      case "text": limitations.add("text and labels are not formed in particles"); break;
      case "parametric": case "mesh": limitations.add(`${n.type} surfaces are not formed in particles`); break;
    }
    if (!object) { omitted.push(n.id); continue; }
    if (n.label) limitations.add("text and labels are not formed in particles");
    candidates.push({ object, id: n.id, importance: extent(n) * s * (glow ? 2 : 1) * (n.type === "circle" || n.type === "line" ? 0.5 : 1) });
    kept += 1;
  }
  if ((doc.animations ?? []).length) limitations.add("motion is not formed: the body holds the scene's starting arrangement and turns slowly");
  // The body forms at most SCENE_LIMITS.objects primitives: the most visible ones.
  candidates.sort((a, b) => b.importance - a.importance);
  const chosen: Candidate[] = [];
  let instances = 0;
  for (const c of candidates) {
    const count = c.object.repeat?.count ?? 1;
    if (chosen.length >= SCENE_LIMITS.objects || instances + count > SCENE_LIMITS.instances) { omitted.push(c.id); kept -= 1; continue; }
    chosen.push(c);
    instances += count;
  }
  if (candidates.length > chosen.length) limitations.add(`only the ${SCENE_LIMITS.objects} most visible objects are formed`);
  // Keep document order among the chosen (stable look).
  const order = new Map(doc.objects.map((n, i) => [n.id, i]));
  chosen.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  if (!chosen.length) return { scene: null, fit: 0, limitations: [...limitations], omitted };
  const title = Array.from(doc.title.replace(/[<>]/g, "")).slice(0, SCENE_LIMITS.title).join("").trim() || "Scene";
  // Numbers to a thousandth (the body's stage is ±10): the particle form stays small.
  const round = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "number" ? Math.round(item * 1000) / 1000 : item));
  const objects = round(chosen.map(c => c.object));
  // Within the body's payload: the least visible objects go first.
  const bytes = (list: SceneObject[]) => JSON.stringify({ title, objects: list, rotation: "slow" }).length;
  const byImportance = [...chosen].sort((a, b) => a.importance - b.importance).map(c => c.id);
  while (objects.length > 1 && bytes(objects) > SCENE_LIMITS.payload) {
    const drop = byImportance.shift()!;
    const at = chosen.findIndex(c => c.id === drop);
    chosen.splice(at, 1); objects.splice(at, 1);
    omitted.push(drop); kept -= 1;
    limitations.add("the scene is too detailed for the body: the least visible objects are left out");
  }
  const scene: Scene3D = { title, objects, rotation: "slow" };
  const fitNow = total > 0 ? Math.max(0, Math.min(1, kept / total)) : 0;
  const checked = checkScene(scene);
  if (!checked.ok) {
    // Should never happen; if the body cannot take it, it shows nothing rather than something wrong.
    return { scene: null, fit: 0, limitations: [...limitations, `the particle form could not be built (${checked.problem})`], omitted };
  }
  return { scene: checked.scene, fit: Math.round(fitNow * 100) / 100, limitations: [...limitations], omitted };
}
