import { CONTROL } from "../validate";
import { SCENE_DETAILS, SCENE_LIMITS, SCENE_PRIMITIVES, type Scene3D, type SceneObject, type SceneRepeat, type Vec3 } from "./types";

/**
 * Strict validation of a 3D scene, wherever it comes from (the MCP tool, the hub, a preset). It returns a clean copy
 * with only the known fields — never the input object — or the first problem in plain words for the model. Every
 * number must be finite and within SCENE_LIMITS; unknown fields, types and names are rejected rather than ignored.
 */
export type SceneCheck = { ok: true; scene: Scene3D } | { ok: false; problem: string };

class Problem extends Error {}
const fail = (message: string): never => { throw new Problem(message); };
const L = SCENE_LIMITS;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function only(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}: unknown field "${key.slice(0, 24)}"`);
}
function number(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${where} must be a number from ${min} to ${max}`);
  return value as number;
}
const size = (value: unknown, where: string) => number(value, where, L.size.min, L.size.max);
function vec3(value: unknown, where: string, min: number = -L.coordinate, max: number = L.coordinate): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${where} must be [x, y, z]`);
  return (value as unknown[]).map((v, i) => number(v, `${where}[${i}]`, min, max)) as Vec3;
}
function points(value: unknown, where: string): Vec3[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > L.points) fail(`${where} must list 2 to ${L.points} points`);
  return (value as unknown[]).map((point, i) => vec3(point, `${where}[${i}]`));
}

const COMMON = ["type", "position", "rotation", "scale", "tone", "weight", "detail", "repeat"] as const;
const FIELDS: Record<SceneObject["type"], readonly string[]> = {
  box: ["size"], sphere: ["radius"], pyramid: ["base", "height", "sides"], cylinder: ["radius", "height", "radiusTop"], cone: ["radius", "height"],
  torus: ["radius", "tube"], ring: ["inner", "outer"], line: ["from", "to"], tube: ["points", "radius", "closed"], curve: ["points", "closed"],
  helix: ["radius", "height", "turns", "phase"],
};

function repeat(value: unknown, where: string): SceneRepeat {
  if (!isRecord(value)) fail(`${where} must be an object`);
  const r = value as Record<string, unknown>;
  only(r, ["count", "offset", "rotation", "scale"], where);
  const out: SceneRepeat = { count: Math.round(number(r.count, `${where}.count`, 2, L.repeat)) };
  if (r.offset !== undefined) out.offset = vec3(r.offset, `${where}.offset`, -L.coordinate / 2, L.coordinate / 2);
  if (r.rotation !== undefined) out.rotation = vec3(r.rotation, `${where}.rotation`, -360, 360);
  if (r.scale !== undefined) out.scale = number(r.scale, `${where}.scale`, 0.5, 2);
  return out;
}

function object(value: unknown, index: number): SceneObject {
  const where = `objects[${index}]`;
  if (!isRecord(value)) fail(`${where} must be an object`);
  const o = value as Record<string, unknown>;
  if (typeof o.type !== "string" || !(SCENE_PRIMITIVES as readonly string[]).includes(o.type)) fail(`${where}.type must be one of ${SCENE_PRIMITIVES.join(", ")}`);
  const type = o.type as SceneObject["type"];
  only(o, [...COMMON, ...FIELDS[type]], where);
  const base: Record<string, unknown> = { type };
  if (o.position !== undefined) base.position = vec3(o.position, `${where}.position`);
  if (o.rotation !== undefined) base.rotation = vec3(o.rotation, `${where}.rotation`, -720, 720);
  if (o.scale !== undefined) base.scale = typeof o.scale === "number" ? number(o.scale, `${where}.scale`, 0.05, 10) : vec3(o.scale, `${where}.scale`, 0.05, 10);
  if (o.tone !== undefined) base.tone = number(o.tone, `${where}.tone`, 0.2, 1);
  if (o.weight !== undefined) base.weight = number(o.weight, `${where}.weight`, 0.05, 10);
  if (o.detail !== undefined) {
    if (typeof o.detail !== "string" || !(SCENE_DETAILS as readonly string[]).includes(o.detail)) fail(`${where}.detail must be surface, edges or both`);
    base.detail = o.detail;
  }
  if (o.repeat !== undefined) base.repeat = repeat(o.repeat, `${where}.repeat`);
  const at = (field: string) => `${where}.${field}`;
  switch (type) {
    case "box": base.size = vec3(o.size, at("size"), L.size.min, L.size.max); break;
    case "sphere": base.radius = size(o.radius, at("radius")); break;
    case "pyramid":
      base.base = size(o.base, at("base")); base.height = size(o.height, at("height"));
      if (o.sides !== undefined) base.sides = Math.round(number(o.sides, at("sides"), 3, 8));
      break;
    case "cylinder":
      base.radius = size(o.radius, at("radius")); base.height = size(o.height, at("height"));
      if (o.radiusTop !== undefined) base.radiusTop = number(o.radiusTop, at("radiusTop"), 0, L.size.max);
      break;
    case "cone": base.radius = size(o.radius, at("radius")); base.height = size(o.height, at("height")); break;
    case "torus":
      base.radius = size(o.radius, at("radius")); base.tube = size(o.tube, at("tube"));
      if ((base.tube as number) >= (base.radius as number)) fail(`${where}.tube must be smaller than its radius`);
      break;
    case "ring":
      base.inner = number(o.inner, at("inner"), 0, L.size.max); base.outer = size(o.outer, at("outer"));
      if ((base.inner as number) >= (base.outer as number)) fail(`${where}.inner must be smaller than outer`);
      break;
    case "line": base.from = vec3(o.from, at("from")); base.to = vec3(o.to, at("to")); break;
    case "tube":
      base.points = points(o.points, at("points")); base.radius = size(o.radius, at("radius"));
      if (o.closed !== undefined) { if (typeof o.closed !== "boolean") fail(`${where}.closed must be true or false`); base.closed = o.closed; }
      break;
    case "curve":
      base.points = points(o.points, at("points"));
      if (o.closed !== undefined) { if (typeof o.closed !== "boolean") fail(`${where}.closed must be true or false`); base.closed = o.closed; }
      break;
    case "helix":
      base.radius = size(o.radius, at("radius")); base.height = size(o.height, at("height"));
      base.turns = number(o.turns, at("turns"), 0.25, 24);
      if (o.phase !== undefined) base.phase = number(o.phase, at("phase"), -360, 360);
      break;
  }
  return base as unknown as SceneObject;
}

/** Triangles each primitive is built with (geometry.ts uses fixed detail), for the scene's complexity bound. */
export const PRIMITIVE_TRIANGLES: Record<SceneObject["type"], (object: SceneObject) => number> = {
  box: () => 12, sphere: () => 48 * 24 * 2, pyramid: o => ((o as { sides?: number }).sides ?? 4) * 2, cylinder: () => 48 * 4, cone: () => 48 * 2,
  torus: () => 24 * 96 * 2, ring: () => 96 * 2 * 2, tube: () => 160 * 12 * 2, line: () => 0, curve: () => 0, helix: () => 0,
};
export const sceneTriangles = (scene: Scene3D) =>
  scene.objects.reduce((sum, object) => sum + PRIMITIVE_TRIANGLES[object.type](object) * (object.repeat?.count ?? 1), 0);

/** Checks a scene. A clean copy when valid; otherwise the first problem, worded for the model. */
export function checkScene(input: unknown): SceneCheck {
  try {
    let serialized: string;
    try { serialized = JSON.stringify(input); } catch { return { ok: false, problem: "the scene must be plain JSON data" }; }
    if (serialized === undefined || serialized.length > L.payload) return { ok: false, problem: `the scene must be at most ${L.payload} bytes of JSON` };
    if (!isRecord(input)) fail("the scene must be an object");
    const s = input as Record<string, unknown>;
    only(s, ["title", "objects", "rotation", "tilt"], "scene");
    if (typeof s.title !== "string" || !s.title.trim() || Array.from(s.title).length > L.title || CONTROL.test(s.title) || /[<>]/.test(s.title)) {
      fail(`scene.title must be 1–${L.title} characters of plain text`);
    }
    if (!Array.isArray(s.objects) || s.objects.length < 1 || s.objects.length > L.objects) fail(`scene.objects must list 1 to ${L.objects} objects`);
    const objects = (s.objects as unknown[]).map(object);
    const instances = objects.reduce((sum, item) => sum + (item.repeat?.count ?? 1), 0);
    if (instances > L.instances) fail(`the scene has ${instances} objects after repeats; at most ${L.instances}`);
    const scene: Scene3D = { title: (s.title as string).replace(/\s+/g, " ").trim(), objects };
    const triangles = sceneTriangles(scene);
    if (triangles > L.triangles) fail(`the scene is too detailed (${triangles} triangles; at most ${L.triangles}): use fewer repeated spheres, tori or tubes`);
    if (s.rotation !== undefined) {
      if (s.rotation !== "slow" && s.rotation !== "none") fail("scene.rotation must be slow or none");
      scene.rotation = s.rotation as "slow" | "none";
    }
    if (s.tilt !== undefined) scene.tilt = number(s.tilt, "scene.tilt", -60, 60);
    return { ok: true, scene };
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.message };
    return { ok: false, problem: "the scene could not be read" };
  }
}

/** A scene that must be valid (presets, re-validation); throws "scene-invalid" otherwise. */
export function validScene(input: unknown): Scene3D {
  const check = checkScene(input);
  if (!check.ok) throw new Error("scene-invalid");
  return check.scene;
}
