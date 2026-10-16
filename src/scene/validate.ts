import { parseColor } from "../core/colors";
import {
  ANIMATED_PROPERTIES, ANIMATION_TYPES, COORDINATE_SYSTEMS, EASINGS, FIDELITY_LEVELS, INTENT_KINDS, INTERACTION_LEVELS, isSceneId, LENGTH_UNITS, NODE_TYPES,
  PATH_TYPES, POINT_DISTRIBUTIONS, PRESENTATION_MODES, SCENE_IR_LIMITS, SCENE_IR_VERSION, SCENE_LAYOUTS, SURFACES, WAVES,
  type AnimatedProperty, type Keyframe, type KeyValue, type MaterialProps, type NodeType, type PointsSpec, type SceneAnimation, type SceneDocument, type SceneMaterial,
  type SceneNode, type SceneRepeat, type Vec3,
} from "./ir";

/**
 * Strict validation of a Scene IR document, wherever it comes from (Codex through the MCP tools, the hub, the page, the
 * card). It returns a clean copy with only known fields — never the input object — with colours normalized to #rrggbb,
 * or the first problem with its code and where it is, in plain words for the model. Unknown fields, types and names
 * are refused rather than ignored; every number must be finite and within SCENE_IR_LIMITS; every reference (a parent, a
 * material, an orbit's centre, a path) must name something that exists, and the hierarchy must be a tree.
 */
export const SCENE_ERROR_CODES = [
  "invalid-scene", "unsupported-geometry", "unsupported-animation", "resource-limit", "invalid-reference", "unsupported-version",
] as const;
export type SceneErrorCode = typeof SCENE_ERROR_CODES[number];

export type SceneCheck = { ok: true; document: SceneDocument; stats: SceneStats } | { ok: false; code: SceneErrorCode; problem: string };

/** What a scene costs to build (checked against the limits; reported with resources). */
export interface SceneStats { nodes: number; instances: number; triangles: number; particles: number; animations: number; bytes: number }

export class SceneProblem extends Error {
  constructor(readonly code: SceneErrorCode, message: string) { super(message); }
}
const fail = (message: string, code: SceneErrorCode = "invalid-scene"): never => { throw new SceneProblem(code, message); };
const L = SCENE_IR_LIMITS;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function only(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}: unknown field "${key.slice(0, 32)}"`);
}
export function num(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${where} must be a number from ${min} to ${max}`);
  return value as number;
}
const int = (value: unknown, where: string, min: number, max: number) => {
  const n = num(value, where, min, max);
  if (!Number.isInteger(n)) fail(`${where} must be a whole number`);
  return n;
};
const bool = (value: unknown, where: string) => { if (typeof value !== "boolean") fail(`${where} must be true or false`); return value as boolean; };
export function text(value: unknown, where: string, max: number): string {
  if (typeof value !== "string") fail(`${where} must be text`);
  const clean = (value as string).replace(/\s+/g, " ").trim();
  if (!clean || Array.from(clean).length > max || CONTROL.test(clean)) fail(`${where} must be one line of at most ${max} characters`);
  return clean;
}
const size = (value: unknown, where: string) => num(value, where, L.size.min, L.size.max);
export function vec3(value: unknown, where: string, min: number = -L.coordinate, max: number = L.coordinate): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${where} must be [x, y, z]`);
  return (value as unknown[]).map((v, i) => num(v, `${where}[${i}]`, min, max)) as Vec3;
}
const sizeVec = (value: unknown, where: string) => vec3(value, where, L.size.min, L.size.max);
const oneOf = <T extends string>(value: unknown, list: readonly T[], where: string): T => {
  if (typeof value !== "string" || !list.includes(value as T)) fail(`${where} must be one of ${list.join(", ")}`);
  return value as T;
};
export function color(value: unknown, where: string): string {
  const parsed = parseColor(value);
  if (!parsed) fail(`${where} must be a colour (#rrggbb or a name such as "blue")`);
  return parsed!.hex;
}
const id = (value: unknown, where: string) => { if (!isSceneId(value)) fail(`${where} must be an id (lowercase letters, digits, "-", "_", ".")`); return value as string; };
function points(value: unknown, where: string, min = 2): Vec3[] {
  if (!Array.isArray(value) || value.length < min || value.length > L.points) fail(`${where} must list ${min} to ${L.points} points`);
  return (value as unknown[]).map((point, i) => vec3(point, `${where}[${i}]`));
}

// ── Materials ──────────────────────────────────────────────────────────────────────────────────────────────────────
const MATERIAL_FIELDS = ["color", "opacity", "emissive", "emissiveIntensity", "metalness", "roughness", "wireframe", "unlit", "dashed"] as const;
export function materialProps(value: unknown, where: string, extra: readonly string[] = []): MaterialProps {
  if (!isRecord(value)) fail(`${where} must be an object`);
  const m = value as Record<string, unknown>;
  only(m, [...MATERIAL_FIELDS, ...extra], where);
  const out: MaterialProps = {};
  if (m.color !== undefined) out.color = color(m.color, `${where}.color`);
  if (m.opacity !== undefined) out.opacity = num(m.opacity, `${where}.opacity`, 0, 1);
  if (m.emissive !== undefined) out.emissive = color(m.emissive, `${where}.emissive`);
  if (m.emissiveIntensity !== undefined) out.emissiveIntensity = num(m.emissiveIntensity, `${where}.emissiveIntensity`, 0, 10);
  if (m.metalness !== undefined) out.metalness = num(m.metalness, `${where}.metalness`, 0, 1);
  if (m.roughness !== undefined) out.roughness = num(m.roughness, `${where}.roughness`, 0, 1);
  for (const flag of ["wireframe", "unlit", "dashed"] as const) if (m[flag] !== undefined) out[flag] = bool(m[flag], `${where}.${flag}`);
  return out;
}
function material(value: unknown, index: number): SceneMaterial {
  const where = `materials[${index}]`;
  const props = materialProps(value, where, ["id", "name"]);
  const m = value as Record<string, unknown>;
  return { id: id(m.id, `${where}.id`), ...(m.name !== undefined ? { name: text(m.name, `${where}.name`, L.text) } : {}), ...props };
}

// ── Nodes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const COMMON = ["id", "type", "name", "parent", "position", "rotation", "scale", "material", "visible", "selectable", "label", "annotation", "metadata", "repeat"] as const;
export const NODE_FIELDS: Record<NodeType, { required: readonly string[]; optional: readonly string[] }> = {
  group: { required: [], optional: [] },
  sphere: { required: ["radius"], optional: [] },
  box: { required: ["size"], optional: [] },
  cylinder: { required: ["radius", "height"], optional: ["radiusTop"] },
  cone: { required: ["radius", "height"], optional: [] },
  torus: { required: ["radius", "tube"], optional: ["arc"] },
  plane: { required: ["width", "depth"], optional: [] },
  ring: { required: ["inner", "outer"], optional: [] },
  circle: { required: ["radius"], optional: [] },
  line: { required: ["from", "to"], optional: [] },
  polyline: { required: ["points"], optional: ["closed"] },
  curve: { required: ["points"], optional: ["closed"] },
  tube: { required: ["points", "radius"], optional: ["closed"] },
  helix: { required: ["radius", "height", "turns"], optional: ["tube"] },
  arrow: { required: ["from", "to"], optional: ["radius"] },
  gear: { required: ["radius", "teeth", "thickness"], optional: ["inner"] },
  points: { required: ["particles"], optional: [] },
  text: { required: ["text"], optional: ["textSize"] },
  parametric: { required: ["surface", "width", "depth"], optional: ["amplitude", "frequency", "resolution"] },
  mesh: { required: ["positions"], optional: ["indices"] },
};

function repeat(value: unknown, where: string): SceneRepeat {
  if (!isRecord(value)) fail(`${where} must be an object`);
  const r = value as Record<string, unknown>;
  only(r, ["count", "offset", "rotation", "scale"], where);
  const out: SceneRepeat = { count: int(r.count, `${where}.count`, 2, L.repeat) };
  if (r.offset !== undefined) out.offset = vec3(r.offset, `${where}.offset`);
  if (r.rotation !== undefined) out.rotation = vec3(r.rotation, `${where}.rotation`, -360, 360);
  if (r.scale !== undefined) out.scale = num(r.scale, `${where}.scale`, 0.25, 4);
  return out;
}

function particles(value: unknown, where: string): PointsSpec {
  if (!isRecord(value)) fail(`${where} must be an object`);
  const p = value as Record<string, unknown>;
  only(p, ["distribution", "count", "radius", "inner", "size", "from", "to", "path", "pointSize", "seed"], where);
  const distribution = oneOf(p.distribution, POINT_DISTRIBUTIONS, `${where}.distribution`);
  const out: PointsSpec = { distribution, count: int(p.count, `${where}.count`, 1, L.particlesPerNode) };
  if (p.radius !== undefined) out.radius = size(p.radius, `${where}.radius`);
  if (p.inner !== undefined) out.inner = num(p.inner, `${where}.inner`, 0, L.size.max);
  if (p.size !== undefined) out.size = sizeVec(p.size, `${where}.size`);
  if (p.from !== undefined) out.from = vec3(p.from, `${where}.from`);
  if (p.to !== undefined) out.to = vec3(p.to, `${where}.to`);
  if (p.path !== undefined) out.path = id(p.path, `${where}.path`);
  if (p.pointSize !== undefined) out.pointSize = num(p.pointSize, `${where}.pointSize`, 0.5, 32);
  if (p.seed !== undefined) out.seed = int(p.seed, `${where}.seed`, 0, 2 ** 31 - 1);
  const needs: Record<typeof distribution, string[]> = {
    sphere: ["radius"], shell: ["radius"], disc: ["radius"], spiral: ["radius"], ring: ["radius"], box: ["size"], grid: ["size"], line: ["from", "to"], path: ["path"],
  };
  for (const key of needs[distribution]) if (out[key as keyof PointsSpec] === undefined) fail(`${where}: a ${distribution} distribution needs ${key}`);
  if (distribution === "ring" && out.inner !== undefined && out.inner >= out.radius!) fail(`${where}.inner must be smaller than radius`);
  return out;
}

function node(value: unknown, index: number): SceneNode {
  const where = `objects[${index}]`;
  if (!isRecord(value)) fail(`${where} must be an object`);
  const o = value as Record<string, unknown>;
  if (typeof o.type !== "string" || !(NODE_TYPES as readonly string[]).includes(o.type)) {
    fail(`${where}.type "${String(o.type).slice(0, 24)}" is not a geometry Aion builds (${NODE_TYPES.join(", ")})`, "unsupported-geometry");
  }
  const type = o.type as NodeType;
  const fields = NODE_FIELDS[type];
  only(o, [...COMMON, ...fields.required, ...fields.optional], `${where} (${type})`);
  for (const key of fields.required) if (o[key] === undefined) fail(`${where}: a ${type} needs ${key}`);
  const n: SceneNode = { id: id(o.id, `${where}.id`), type };
  const at = `${where} "${n.id}"`;
  if (o.name !== undefined) n.name = text(o.name, `${at}.name`, L.text);
  if (o.parent !== undefined) n.parent = id(o.parent, `${at}.parent`);
  if (o.position !== undefined) n.position = vec3(o.position, `${at}.position`);
  if (o.rotation !== undefined) n.rotation = vec3(o.rotation, `${at}.rotation`, -3600, 3600);
  if (o.scale !== undefined) n.scale = typeof o.scale === "number" ? num(o.scale, `${at}.scale`, 1e-4, 1e4) : vec3(o.scale, `${at}.scale`, 1e-4, 1e4);
  if (o.material !== undefined) n.material = typeof o.material === "string" ? id(o.material, `${at}.material`) : materialProps(o.material, `${at}.material`);
  if (o.visible !== undefined) n.visible = bool(o.visible, `${at}.visible`);
  if (o.selectable !== undefined) n.selectable = bool(o.selectable, `${at}.selectable`);
  if (o.label !== undefined) n.label = text(o.label, `${at}.label`, L.text);
  if (o.annotation !== undefined) n.annotation = text(o.annotation, `${at}.annotation`, L.annotation);
  if (o.metadata !== undefined) {
    if (!isRecord(o.metadata) || Object.keys(o.metadata).length > L.metadata) fail(`${at}.metadata must be an object of at most ${L.metadata} values`);
    const meta: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(o.metadata as Record<string, unknown>)) {
      if (!/^[\p{L}][\p{L}\p{N} ._()-]{0,39}$/u.test(key)) fail(`${at}.metadata: "${key.slice(0, 40)}" is not a valid name`);
      meta[key] = typeof item === "number" ? num(item, `${at}.metadata.${key}`, -1e15, 1e15) : typeof item === "boolean" ? item : text(item, `${at}.metadata.${key}`, L.metadataText);
    }
    n.metadata = meta;
  }
  if (o.repeat !== undefined) n.repeat = repeat(o.repeat, `${at}.repeat`);
  // Geometry.
  if (o.radius !== undefined) n.radius = type === "arrow" ? num(o.radius, `${at}.radius`, L.size.min, L.size.max) : size(o.radius, `${at}.radius`);
  if (o.radiusTop !== undefined) n.radiusTop = num(o.radiusTop, `${at}.radiusTop`, 0, L.size.max);
  if (o.height !== undefined) n.height = size(o.height, `${at}.height`);
  if (o.size !== undefined) n.size = sizeVec(o.size, `${at}.size`);
  if (o.tube !== undefined) n.tube = num(o.tube, `${at}.tube`, 0, L.size.max);
  if (o.arc !== undefined) n.arc = num(o.arc, `${at}.arc`, 1, 360);
  if (o.inner !== undefined) n.inner = num(o.inner, `${at}.inner`, 0, L.size.max);
  if (o.outer !== undefined) n.outer = size(o.outer, `${at}.outer`);
  if (o.width !== undefined) n.width = size(o.width, `${at}.width`);
  if (o.depth !== undefined) n.depth = size(o.depth, `${at}.depth`);
  if (o.from !== undefined) n.from = vec3(o.from, `${at}.from`);
  if (o.to !== undefined) n.to = vec3(o.to, `${at}.to`);
  if (o.points !== undefined) n.points = points(o.points, `${at}.points`);
  if (o.closed !== undefined) n.closed = bool(o.closed, `${at}.closed`);
  if (o.turns !== undefined) n.turns = num(o.turns, `${at}.turns`, 0.1, 200);
  if (o.teeth !== undefined) n.teeth = int(o.teeth, `${at}.teeth`, L.teeth.min, L.teeth.max);
  if (o.thickness !== undefined) n.thickness = size(o.thickness, `${at}.thickness`);
  if (o.text !== undefined) n.text = text(o.text, `${at}.text`, L.text);
  if (o.textSize !== undefined) n.textSize = size(o.textSize, `${at}.textSize`);
  if (o.surface !== undefined) n.surface = oneOf(o.surface, SURFACES, `${at}.surface`);
  if (o.amplitude !== undefined) n.amplitude = num(o.amplitude, `${at}.amplitude`, -L.size.max, L.size.max);
  if (o.frequency !== undefined) n.frequency = num(o.frequency, `${at}.frequency`, 0.01, 100);
  if (o.resolution !== undefined) n.resolution = int(o.resolution, `${at}.resolution`, L.resolution.min, L.resolution.max);
  if (o.positions !== undefined) {
    if (!Array.isArray(o.positions) || o.positions.length < 9 || o.positions.length % 3 || o.positions.length > L.meshVertices * 3) fail(`${at}.positions must be 3 to ${L.meshVertices} x, y, z triples`, "resource-limit");
    n.positions = (o.positions as unknown[]).map((v, i) => num(v, `${at}.positions[${i}]`, -L.coordinate, L.coordinate));
  }
  if (o.indices !== undefined) {
    const vertices = (n.positions?.length ?? 0) / 3;
    if (!Array.isArray(o.indices) || o.indices.length % 3 || o.indices.length > L.meshIndices) fail(`${at}.indices must be triangles (at most ${L.meshIndices} indices)`, "resource-limit");
    n.indices = (o.indices as unknown[]).map((v, i) => int(v, `${at}.indices[${i}]`, 0, vertices - 1));
  }
  if (o.particles !== undefined) n.particles = particles(o.particles, `${at}.particles`);
  // Shape sanity.
  if (type === "ring" && n.inner! >= n.outer!) fail(`${at}: inner must be smaller than outer`);
  if (type === "torus" && n.tube! >= n.radius!) fail(`${at}: tube must be smaller than radius`);
  if (type === "gear" && n.inner !== undefined && n.inner >= n.radius! * 0.8) fail(`${at}: inner must be well inside the radius`);
  if ((type === "line" || type === "arrow") && n.from!.every((v, i) => v === n.to![i])) fail(`${at}: from and to must differ`);
  if (type === "mesh" && n.indices === undefined && n.positions!.length % 9) fail(`${at}: without indices, positions must be whole triangles`);
  return n;
}

// ── Animations ─────────────────────────────────────────────────────────────────────────────────────────────────────
const ANIMATION_COMMON = ["id", "target", "type", "start", "repeat", "yoyo", "timeScale", "paused"] as const;
export const ANIMATION_FIELDS: Record<SceneAnimation["type"], { required: readonly string[]; optional: readonly string[] }> = {
  spin: { required: ["speed"], optional: ["axis"] },
  orbit: { required: ["period"], optional: ["center", "radius", "axis", "phase", "eccentricity", "inclination", "clockwise"] },
  oscillate: { required: ["property", "amplitude", "period"], optional: ["axis", "phase", "wave"] },
  keyframes: { required: ["property", "keys"], optional: ["easing"] },
  path: { required: ["path", "duration"], optional: ["orient", "easing"] },
  flow: { required: ["path", "rate"], optional: [] },
  track: { required: ["lookAt"], optional: [] },
  couple: { required: ["source", "ratio"], optional: [] },
};

function keyValue(property: AnimatedProperty, value: unknown, where: string): KeyValue {
  switch (property) {
    case "position": return vec3(value, where);
    case "rotation": return vec3(value, where, -36_000, 36_000);
    case "scale": return typeof value === "number" ? num(value, where, 0, 1e4) : vec3(value, where, 0, 1e4);
    case "color": case "emissive": return color(value, where);
    case "opacity": return num(value, where, 0, 1);
    case "visible": return bool(value, where);
  }
}

function animation(value: unknown, index: number): SceneAnimation {
  const where = `animations[${index}]`;
  if (!isRecord(value)) fail(`${where} must be an object`);
  const a = value as Record<string, unknown>;
  if (typeof a.type !== "string" || !(ANIMATION_TYPES as readonly string[]).includes(a.type)) {
    fail(`${where}.type "${String(a.type).slice(0, 24)}" is not an animation Aion runs (${ANIMATION_TYPES.join(", ")})`, "unsupported-animation");
  }
  const type = a.type as SceneAnimation["type"];
  const fields = ANIMATION_FIELDS[type];
  only(a, [...ANIMATION_COMMON, ...fields.required, ...fields.optional], `${where} (${type})`);
  for (const key of fields.required) if (a[key] === undefined) fail(`${where}: a ${type} animation needs ${key}`);
  const out: SceneAnimation = { id: id(a.id, `${where}.id`), target: id(a.target, `${where}.target`), type };
  const at = `${where} "${out.id}"`;
  if (a.axis !== undefined) {
    out.axis = vec3(a.axis, `${at}.axis`, -1, 1);
    if (out.axis.every(v => v === 0)) fail(`${at}.axis must not be zero`);
  }
  if (a.speed !== undefined) out.speed = num(a.speed, `${at}.speed`, -L.spin, L.spin);
  if (a.center !== undefined) out.center = typeof a.center === "string" ? id(a.center, `${at}.center`) : vec3(a.center, `${at}.center`);
  if (a.radius !== undefined) out.radius = size(a.radius, `${at}.radius`);
  if (a.period !== undefined) out.period = num(a.period, `${at}.period`, L.period.min, L.period.max);
  if (a.phase !== undefined) out.phase = num(a.phase, `${at}.phase`, -3600, 3600);
  if (a.eccentricity !== undefined) out.eccentricity = num(a.eccentricity, `${at}.eccentricity`, 0, 0.95);
  if (a.inclination !== undefined) out.inclination = num(a.inclination, `${at}.inclination`, -180, 180);
  if (a.clockwise !== undefined) out.clockwise = bool(a.clockwise, `${at}.clockwise`);
  if (a.property !== undefined) {
    out.property = oneOf(a.property, ANIMATED_PROPERTIES, `${at}.property`);
    if (type === "oscillate" && !["position", "rotation", "scale", "opacity", "emissive"].includes(out.property)) fail(`${at}: oscillate changes position, rotation, scale, opacity or emissive`, "unsupported-animation");
  }
  if (a.amplitude !== undefined) out.amplitude = num(a.amplitude, `${at}.amplitude`, -L.coordinate, L.coordinate);
  if (a.wave !== undefined) out.wave = oneOf(a.wave, WAVES, `${at}.wave`);
  if (a.keys !== undefined) {
    if (!Array.isArray(a.keys) || a.keys.length < 1 || a.keys.length > L.keys) fail(`${at}.keys must list 1 to ${L.keys} keyframes`);
    let last = -Infinity;
    out.keys = (a.keys as unknown[]).map((key, i): Keyframe => {
      if (!isRecord(key)) fail(`${at}.keys[${i}] must be {t, value}`);
      only(key as Record<string, unknown>, ["t", "value"], `${at}.keys[${i}]`);
      const t = num((key as Record<string, unknown>).t, `${at}.keys[${i}].t`, 0, L.time);
      if (t < last) fail(`${at}.keys must be in time order`);
      last = t;
      return { t, value: keyValue(out.property!, (key as Record<string, unknown>).value, `${at}.keys[${i}].value`) };
    });
  }
  if (a.easing !== undefined) out.easing = oneOf(a.easing, EASINGS, `${at}.easing`);
  if (a.path !== undefined) out.path = id(a.path, `${at}.path`);
  if (a.duration !== undefined) out.duration = num(a.duration, `${at}.duration`, L.period.min, L.period.max);
  if (a.orient !== undefined) out.orient = bool(a.orient, `${at}.orient`);
  if (a.rate !== undefined) out.rate = num(a.rate, `${at}.rate`, -L.coordinate, L.coordinate);
  if (a.lookAt !== undefined) out.lookAt = id(a.lookAt, `${at}.lookAt`);
  if (a.source !== undefined) out.source = id(a.source, `${at}.source`);
  if (a.ratio !== undefined) out.ratio = num(a.ratio, `${at}.ratio`, -100, 100);
  if (a.start !== undefined) out.start = num(a.start, `${at}.start`, 0, L.time);
  if (a.repeat !== undefined) out.repeat = a.repeat === "loop" ? "loop" : int(a.repeat, `${at}.repeat`, 1, 1_000_000);
  if (a.yoyo !== undefined) out.yoyo = bool(a.yoyo, `${at}.yoyo`);
  if (a.timeScale !== undefined) out.timeScale = num(a.timeScale, `${at}.timeScale`, 0.001, 1000);
  if (a.paused !== undefined) out.paused = bool(a.paused, `${at}.paused`);
  return out;
}

// ── Costs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Triangles a node builds (one instance), as the scene compiler builds it. */
export function nodeTriangles(n: SceneNode): number {
  switch (n.type) {
    case "sphere": return 48 * 32 * 2;
    case "box": return 12;
    case "cylinder": case "cone": return 64 * 4;
    case "torus": return 96 * 24 * 2;
    case "plane": return 2;
    case "ring": return 256;
    // Tubes: about 24 segments per given point (12 samples each, doubled), 12 around.
    case "tube": return Math.max(2, n.points!.length) * 24 * 12 * 2;
    case "helix": return n.tube ? Math.ceil(n.turns! * 64) * 2 * 12 * 2 : 0;
    case "arrow": return 24 * 6;
    case "gear": return n.teeth! * 4 * 8 + 128;
    case "parametric": { const r = n.resolution ?? 64; return r * r * 2; }
    case "mesh": return (n.indices?.length ?? n.positions!.length / 3) / 3;
    case "text": return 2;
    default: return 0;
  }
}

// ── The document ───────────────────────────────────────────────────────────────────────────────────────────────────
const DOCUMENT_FIELDS = ["version", "sceneId", "title", "intent", "units", "coordinateSystem", "disclosure", "requirements", "objects", "materials", "animations", "camera", "environment", "timeline", "presentation"];
const REQUIREMENT = /^(geometry|animation|feature|compute|physics|asset|render):[a-z0-9-]{1,40}$/;

/** The serialized size of a document (what crosses the hub and the Card Bridge). */
export const documentBytes = (value: unknown) => { try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return Infinity; } };

export function validateScene(input: unknown): SceneCheck {
  try {
    const bytes = documentBytes(input);
    if (bytes > L.bytes) fail(`the scene is ${Math.round(bytes / 1024)} KB; at most ${L.bytes / 1024} KB (use repeat, points or fewer objects)`, "resource-limit");
    if (!isRecord(input)) fail("a scene must be an object");
    const d = input as Record<string, unknown>;
    only(d, DOCUMENT_FIELDS, "scene");
    if (d.version !== SCENE_IR_VERSION) fail(`version must be ${SCENE_IR_VERSION} (this Aion reads Scene IR version ${SCENE_IR_VERSION})`, "unsupported-version");
    const doc: SceneDocument = { version: SCENE_IR_VERSION, sceneId: id(d.sceneId, "sceneId"), title: text(d.title, "title", L.title), objects: [] };
    if (d.intent !== undefined) {
      if (!isRecord(d.intent)) fail("intent must be an object");
      const i = d.intent as Record<string, unknown>;
      only(i, ["kind", "summary", "fidelity", "interaction"], "intent");
      doc.intent = { kind: oneOf(i.kind, INTENT_KINDS, "intent.kind") };
      if (i.summary !== undefined) doc.intent.summary = text(i.summary, "intent.summary", 160);
      if (i.fidelity !== undefined) doc.intent.fidelity = oneOf(i.fidelity, FIDELITY_LEVELS, "intent.fidelity");
      if (i.interaction !== undefined) doc.intent.interaction = oneOf(i.interaction, INTERACTION_LEVELS, "intent.interaction");
    }
    if (d.units !== undefined) {
      if (!isRecord(d.units)) fail("units must be an object");
      const u = d.units as Record<string, unknown>;
      only(u, ["length", "time", "angle"], "units");
      if (u.time !== undefined && u.time !== "s") fail("units.time must be \"s\"");
      if (u.angle !== undefined && u.angle !== "deg") fail("units.angle must be \"deg\"");
      doc.units = { length: oneOf(u.length ?? "unit", LENGTH_UNITS, "units.length"), time: "s", angle: "deg" };
    }
    if (d.coordinateSystem !== undefined) doc.coordinateSystem = oneOf(d.coordinateSystem, COORDINATE_SYSTEMS, "coordinateSystem");
    if (d.disclosure !== undefined) {
      if (!Array.isArray(d.disclosure) || d.disclosure.length > L.disclosures) fail(`disclosure must list at most ${L.disclosures} notes`);
      doc.disclosure = (d.disclosure as unknown[]).map((note, i) => text(note, `disclosure[${i}]`, L.disclosure));
    }
    if (d.requirements !== undefined) {
      if (!Array.isArray(d.requirements) || d.requirements.length > L.requirements) fail(`requirements must list at most ${L.requirements} capabilities`);
      doc.requirements = (d.requirements as unknown[]).map((r, i) => {
        if (typeof r !== "string" || !REQUIREMENT.test(r)) fail(`requirements[${i}] must be like "compute:magnetic-field" (geometry|animation|feature|compute|physics|asset|render)`);
        return r as string;
      });
    }
    // Materials.
    if (d.materials !== undefined) {
      if (!Array.isArray(d.materials) || d.materials.length > L.materials) fail(`materials must list at most ${L.materials}`, "resource-limit");
      doc.materials = (d.materials as unknown[]).map(material);
      const seen = new Set<string>();
      for (const m of doc.materials) { if (seen.has(m.id)) fail(`materials: "${m.id}" is defined twice`); seen.add(m.id); }
    }
    // Nodes.
    if (!Array.isArray(d.objects)) fail("objects must be a list");
    if ((d.objects as unknown[]).length > L.nodes) fail(`at most ${L.nodes} objects (use repeat or points for many similar ones)`, "resource-limit");
    doc.objects = (d.objects as unknown[]).map(node);
    checkGraph(doc);
    // Animations.
    if (d.animations !== undefined) {
      if (!Array.isArray(d.animations) || d.animations.length > L.animations) fail(`animations must list at most ${L.animations}`, "resource-limit");
      doc.animations = (d.animations as unknown[]).map(animation);
      checkAnimations(doc);
    }
    if (d.camera !== undefined) {
      if (!isRecord(d.camera)) fail("camera must be an object");
      const c = d.camera as Record<string, unknown>;
      only(c, ["position", "target", "fov", "frame"], "camera");
      doc.camera = {};
      if (c.position !== undefined) doc.camera.position = vec3(c.position, "camera.position");
      if (c.target !== undefined) doc.camera.target = vec3(c.target, "camera.target");
      if (c.fov !== undefined) doc.camera.fov = num(c.fov, "camera.fov", 10, 120);
      if (c.frame !== undefined) {
        if (!Array.isArray(c.frame) || c.frame.length > 32) fail("camera.frame must list at most 32 ids");
        doc.camera.frame = (c.frame as unknown[]).map((f, i) => ref(doc, id(f, `camera.frame[${i}]`), `camera.frame[${i}]`));
      }
    }
    if (d.environment !== undefined) {
      if (!isRecord(d.environment)) fail("environment must be an object");
      const e = d.environment as Record<string, unknown>;
      only(e, ["background", "ambient", "light", "lightSource", "grid", "axes", "stars"], "environment");
      doc.environment = {};
      if (e.background !== undefined) doc.environment.background = color(e.background, "environment.background");
      if (e.ambient !== undefined) doc.environment.ambient = num(e.ambient, "environment.ambient", 0, 2);
      if (e.lightSource !== undefined) doc.environment.lightSource = ref(doc, id(e.lightSource, "environment.lightSource"), "environment.lightSource");
      for (const flag of ["light", "grid", "axes", "stars"] as const) if (e[flag] !== undefined) doc.environment[flag] = bool(e[flag], `environment.${flag}`);
    }
    if (d.timeline !== undefined) {
      if (!isRecord(d.timeline)) fail("timeline must be an object");
      const t = d.timeline as Record<string, unknown>;
      only(t, ["speed", "autoplay"], "timeline");
      doc.timeline = {};
      if (t.speed !== undefined) doc.timeline.speed = num(t.speed, "timeline.speed", 0, 1000);
      if (t.autoplay !== undefined) doc.timeline.autoplay = bool(t.autoplay, "timeline.autoplay");
    }
    if (d.presentation !== undefined) {
      if (!isRecord(d.presentation)) fail("presentation must be an object");
      const p = d.presentation as Record<string, unknown>;
      only(p, ["mode", "layout", "labels"], "presentation");
      doc.presentation = {};
      if (p.mode !== undefined) doc.presentation.mode = oneOf(p.mode, PRESENTATION_MODES, "presentation.mode");
      if (p.layout !== undefined) doc.presentation.layout = oneOf(p.layout, SCENE_LAYOUTS, "presentation.layout");
      if (p.labels !== undefined) doc.presentation.labels = bool(p.labels, "presentation.labels");
    }
    const stats = sceneStats(doc);
    if (stats.instances > L.instances) fail(`the scene has ${stats.instances} objects after repeats; at most ${L.instances}`, "resource-limit");
    if (stats.triangles > L.triangles) fail(`the scene would build about ${stats.triangles.toLocaleString("en")} triangles; at most ${L.triangles.toLocaleString("en")}`, "resource-limit");
    if (stats.particles > L.particles) fail(`the scene has ${stats.particles} particles; at most ${L.particles}`, "resource-limit");
    return { ok: true, document: doc, stats: { ...stats, bytes: documentBytes(doc) } };
  } catch (error) {
    if (error instanceof SceneProblem) return { ok: false, code: error.code, problem: error.message };
    return { ok: false, code: "invalid-scene", problem: "the scene could not be read" };
  }
}

function ref(doc: SceneDocument, value: string, where: string) {
  if (!doc.objects.some(n => n.id === value)) fail(`${where}: no object "${value}"`, "invalid-reference");
  return value;
}

/** Ids unique, parents existing, the hierarchy a tree of bounded depth, materials and paths existing. */
function checkGraph(doc: SceneDocument) {
  const byId = new Map<string, SceneNode>();
  for (const n of doc.objects) {
    if (byId.has(n.id)) fail(`objects: "${n.id}" is used twice (ids must be unique)`);
    byId.set(n.id, n);
  }
  const materials = new Set((doc.materials ?? []).map(m => m.id));
  for (const n of doc.objects) {
    if (n.parent !== undefined && !byId.has(n.parent)) fail(`"${n.id}".parent: no object "${n.parent}"`, "invalid-reference");
    if (n.parent === n.id) fail(`"${n.id}" cannot be its own parent`, "invalid-reference");
    if (typeof n.material === "string" && !materials.has(n.material)) fail(`"${n.id}".material: no material "${n.material}"`, "invalid-reference");
    const path = n.particles?.path;
    if (path !== undefined && !PATH_TYPES.includes(byId.get(path)?.type as NodeType)) fail(`"${n.id}".particles.path must name a ${PATH_TYPES.join(", ")} object`, "invalid-reference");
    // Depth and cycles.
    let depth = 0;
    for (let p = n.parent; p !== undefined; p = byId.get(p)?.parent) {
      if (++depth > L.depth) fail(`"${n.id}" is nested more than ${L.depth} deep, or its parents form a cycle`, "invalid-reference");
    }
  }
}

function checkAnimations(doc: SceneDocument) {
  const byId = new Map(doc.objects.map(n => [n.id, n]));
  const animations = new Map<string, SceneAnimation>();
  for (const a of doc.animations ?? []) {
    if (animations.has(a.id)) fail(`animations: "${a.id}" is used twice`);
    animations.set(a.id, a);
  }
  const sameParent = (a: SceneAnimation, other: string, what: string) => {
    const node = byId.get(other);
    if (!node) fail(`animation "${a.id}".${what}: no object "${other}"`, "invalid-reference");
    if (node!.parent !== byId.get(a.target)!.parent) fail(`animation "${a.id}".${what}: "${other}" must share "${a.target}"'s parent`, "invalid-reference");
  };
  for (const a of animations.values()) {
    const target = byId.get(a.target);
    if (!target) fail(`animation "${a.id}".target: no object "${a.target}"`, "invalid-reference");
    if (typeof a.center === "string") { sameParent(a, a.center, "center"); if (a.center === a.target) fail(`animation "${a.id}" cannot orbit itself`, "invalid-reference"); }
    if (a.lookAt !== undefined) { sameParent(a, a.lookAt, "lookAt"); if (a.lookAt === a.target) fail(`animation "${a.id}" cannot face itself`, "invalid-reference"); }
    if (a.path !== undefined) {
      const path = byId.get(a.path);
      if (!path || !PATH_TYPES.includes(path.type)) fail(`animation "${a.id}".path must name a ${PATH_TYPES.join(", ")} object`, "invalid-reference");
      if (a.type === "path" || a.type === "flow") sameParent(a, a.path, "path");
    }
    if (a.type === "flow" && target!.type !== "points") fail(`animation "${a.id}": flow moves a points object's particles`, "unsupported-animation");
    if (a.type === "couple") {
      const source = animations.get(a.source!);
      if (!source || (source.type !== "spin" && source.type !== "couple")) fail(`animation "${a.id}".source must name a spin (or couple) animation`, "invalid-reference");
      // A chain of couplings must end in a spin.
      let steps = 0;
      for (let s = source; s && s.type === "couple"; s = animations.get(s.source!)!) if (++steps > 32 || s === a) fail(`animation "${a.id}": its couplings form a cycle`, "invalid-reference");
    }
  }
  // Orbit centres must not form a cycle (a orbits b orbits a).
  const centre = (nodeId: string) => (doc.animations ?? []).find(a => a.type === "orbit" && a.target === nodeId && typeof a.center === "string")?.center as string | undefined;
  for (const n of doc.objects) {
    let steps = 0;
    for (let c = centre(n.id); c !== undefined; c = centre(c)) if (++steps > L.depth || c === n.id) fail(`"${n.id}": its orbit centres form a cycle`, "invalid-reference");
  }
}

/** How much a scene builds: nodes, instances (a repeat copies the node's own geometry), triangles and particles. */
export function sceneStats(doc: SceneDocument): Omit<SceneStats, "bytes"> {
  let instances = 0, triangles = 0, particles = 0;
  for (const n of doc.objects) {
    const copies = n.repeat?.count ?? 1;
    instances += copies;
    triangles += nodeTriangles(n) * copies;
    particles += (n.particles?.count ?? 0) * copies;
  }
  return { nodes: doc.objects.length, instances, triangles, particles, animations: doc.animations?.length ?? 0 };
}
