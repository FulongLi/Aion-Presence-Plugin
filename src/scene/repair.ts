import { ANIMATION_TYPES, NODE_TYPES, type NodeType, type SceneAnimation } from "./ir";

/**
 * Repair guidance for generated scenes (v0.5.1). Codex writes Scene IR from natural language; when a document is
 * refused, the refusal should say exactly what to change, so the next attempt is the last one. This module only words
 * hints — it never changes a document: a near-miss field name ("colour" on a node), a geometry or motion Aion does not
 * have under that name ("cube", "rotate"), the fields a type needs, and the ids that do exist. Validation itself stays
 * strict (validate.ts); nothing here substitutes one scene for another.
 */

/** Edit distance (small strings only: field names, type names and ids). */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m + n;
  let previous = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[n];
}

/** The candidates closest to `value` (case-insensitive), nearest first; only plausible ones. */
export function closest(value: string, candidates: readonly string[], max = 3): string[] {
  const v = value.toLowerCase();
  const limit = Math.max(1, Math.min(3, Math.floor(v.length / 3)));
  return candidates
    .map(c => ({ c, d: c.toLowerCase().startsWith(v) || v.startsWith(c.toLowerCase()) ? Math.min(1, distance(v, c.toLowerCase())) : distance(v, c.toLowerCase()) }))
    .filter(x => x.d <= limit)
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .slice(0, max)
    .map(x => x.c);
}

/** Names that are not Scene IR geometry, and what to use instead. */
const GEOMETRY_ALIASES: Record<string, string> = {
  cube: "box (size [x, y, z])", cuboid: "box", block: "box", brick: "box", rectangle: "box (or plane for a flat one)", slab: "box",
  ball: "sphere", orb: "sphere", planet: "sphere", globe: "sphere", dot: "sphere (small radius)",
  disk: "cylinder with a small height", disc: "cylinder with a small height", coin: "cylinder with a small height",
  pipe: "cylinder (straight) or tube (along points)", rod: "cylinder", shaft: "cylinder", pillar: "cylinder", column: "cylinder", wire: "tube (along points) or polyline",
  capsule: "a group of a cylinder and two spheres", pyramid: "cone (round base) or mesh (a square base)", prism: "mesh, or cylinder",
  spring: "helix with tube", coil: "helix with tube (a winding)", winding: "helix with tube", spiral: "helix, or points with distribution spiral",
  donut: "torus", doughnut: "torus", loop: "torus or circle", knot: "tube along points (closed)", torusknot: "tube along points (closed)",
  label: "text", sprite: "text", caption: "text", text3d: "text",
  vector: "arrow", arrowhelper: "arrow",
  surface: "parametric (surface: wave, ripple, saddle, paraboloid, sinc or gaussian)", heightfield: "parametric", terrain: "parametric", wave: "parametric with surface wave", ripple: "parametric with surface ripple",
  particle: "points", particles: "points", pointcloud: "points", cloud: "points", stars: "points (or environment.stars)",
  triangle: "mesh", polygon: "mesh (or polyline closed)", custom: "mesh", geometry: "a type from the list",
  spline: "curve", bezier: "curve", path: "curve or polyline", segment: "line",
  ground: "plane", floor: "plane", quad: "plane",
  assembly: "group", empty: "group", node: "group", container: "group", object: "group",
  cog: "gear", sprocket: "gear", gearwheel: "gear",
  light: "a sphere with an emissive material, plus environment.lightSource", camera: "the document's camera field",
};

/** Names that are not Scene IR animations, and what to use instead. */
const ANIMATION_ALIASES: Record<string, string> = {
  rotate: "spin (speed in degrees per second)", rotation: "spin", turn: "spin", spinning: "spin", rotating: "spin",
  revolve: "orbit (period, center)", revolution: "orbit", circle: "orbit", orbiting: "orbit",
  pulse: "oscillate (property scale or emissive)", bounce: "oscillate (property position)", bob: "oscillate (property position)", float: "oscillate (property position)",
  breathe: "oscillate (property scale)", blink: "oscillate (property opacity) or keyframes on visible", flash: "oscillate (property emissive)", vibrate: "oscillate (property position)", swing: "oscillate (property rotation)", sway: "oscillate (property rotation)", wave: "oscillate",
  move: "keyframes (property position) or path", translate: "keyframes (property position)", tween: "keyframes", animate: "keyframes", fade: "keyframes (property opacity)",
  follow: "path (along a curve, polyline, tube, circle or helix)", along: "path", trajectory: "path",
  stream: "flow (a points object along a path)", current: "flow (a points object along a path)",
  lookat: "track (lookAt)", face: "track", aim: "track",
  mesh: "couple (source: a spin, ratio)", drive: "couple", gear: "couple (source: a spin, ratio)", link: "couple",
};

/** Fields that belong somewhere else in the document, wherever they are misplaced. */
const FIELD_ALIASES: Record<string, string> = {
  color: "material: { \"color\": … } (or a shared material's id)", colour: "material: { \"color\": … }",
  emissive: "material: { \"emissive\": … }", emissiveIntensity: "material: { \"emissiveIntensity\": … }", opacity: "material: { \"opacity\": … }",
  metalness: "material: { \"metalness\": … }", roughness: "material: { \"roughness\": … }", wireframe: "material: { \"wireframe\": true }", transparent: "material: { \"opacity\": 0.5 }",
  children: "a flat list: give each child \"parent\": \"<this id>\"", nodes: "objects", items: "objects", components: "objects",
  animation: "the document's animations list ({ \"id\", \"target\", \"type\", … })", animations: "the document's animations list", spin: "an animation { \"type\": \"spin\", \"target\": … }",
  rotationSpeed: "an animation { \"type\": \"spin\", \"speed\": … }", speed: "an animation (spin speed, or timeline.speed)", orbit: "an animation { \"type\": \"orbit\", … }",
  pos: "position", location: "position", translation: "position", offset: "position (or repeat.offset)", center: "position",
  rot: "rotation (Euler degrees [x, y, z])", orientation: "rotation (Euler degrees [x, y, z])", angle: "rotation (Euler degrees [x, y, z])",
  diameter: "radius (half the diameter)", r: "radius", length: "height (cylinder, cone, helix) or from/to (line, arrow)",
  radiusBottom: "radius (radiusTop is the top)", segments: "nothing: segment counts are fixed", detail: "nothing: segment counts are fixed",
  start: "from (line, arrow)", end: "to (line, arrow)", vertices: "positions (mesh) or points (polyline, curve, tube)", faces: "indices (mesh)",
  count: "particles: { \"distribution\": …, \"count\": … } (points) or repeat: { \"count\": … }", tooltip: "annotation", description: "annotation", info: "metadata",
  title: "name (objects) or the document's title", text: "a text object's text, or label", labelText: "label", caption: "label",
  hidden: "visible: false", show: "visible", interactive: "selectable", clickable: "selectable",
  lookAt: "camera.target (the camera) or a track animation (an object)", fov: "camera.fov", near: "nothing: the camera's range is automatic",
  intensity: "environment.ambient (the scene) or material.emissiveIntensity (an object)", shadows: "environment.shadows", style: "environment.style",
  duration: "period (orbit, oscillate) or duration (path)", loop: "repeat: \"loop\"", delay: "start (seconds)",
};

/** A short hint for an unknown field in a part of the document whose allowed fields are `allowed`. */
export function fieldHint(key: string, allowed: readonly string[]): string {
  const near = closest(key, allowed, 2);
  const moved = FIELD_ALIASES[key] ?? FIELD_ALIASES[key.toLowerCase()];
  if (near.length && (!moved || distance(key.toLowerCase(), near[0].toLowerCase()) <= 1)) return `did you mean "${near[0]}"?`;
  if (moved) return `use ${moved}`;
  return `allowed here: ${allowed.join(", ")}`;
}

/** A hint for a geometry type Aion does not build. */
export function geometryHint(type: unknown): string {
  const name = String(type).toLowerCase().replace(/[\s_-]/g, "");
  const alias = GEOMETRY_ALIASES[name];
  if (alias) return `use ${alias}`;
  const near = closest(name, NODE_TYPES, 2);
  return near.length ? `did you mean "${near[0]}"?` : `types: ${NODE_TYPES.join(", ")}`;
}

/** A hint for an animation type Aion does not run. */
export function animationHint(type: unknown): string {
  const name = String(type).toLowerCase().replace(/[\s_-]/g, "");
  const alias = ANIMATION_ALIASES[name];
  if (alias) return `use ${alias}`;
  const near = closest(name, ANIMATION_TYPES, 2);
  return near.length ? `did you mean "${near[0]}"?` : `types: ${ANIMATION_TYPES.join(", ")}`;
}

/** A minimal valid example of each geometry's own fields (what "a cylinder needs radius" should look like). */
export const GEOMETRY_EXAMPLES: Record<NodeType, string> = {
  group: "{ \"id\": \"assembly\", \"type\": \"group\" }",
  sphere: "\"radius\": 1", box: "\"size\": [2, 1, 1]", cylinder: "\"radius\": 0.5, \"height\": 2", cone: "\"radius\": 0.5, \"height\": 1",
  torus: "\"radius\": 1, \"tube\": 0.1", plane: "\"width\": 4, \"depth\": 4", ring: "\"inner\": 1, \"outer\": 1.4", circle: "\"radius\": 3",
  line: "\"from\": [0, 0, 0], \"to\": [1, 0, 0]", polyline: "\"points\": [[0, 0, 0], [1, 0, 0], [1, 1, 0]]", curve: "\"points\": [[0, 0, 0], [1, 1, 0], [2, 0, 0]]",
  tube: "\"points\": [[0, 0, 0], [1, 1, 0], [2, 0, 0]], \"radius\": 0.05", helix: "\"radius\": 0.5, \"height\": 2, \"turns\": 8, \"tube\": 0.04",
  arrow: "\"from\": [0, 0, 0], \"to\": [0, 1, 0]", gear: "\"radius\": 1, \"teeth\": 20, \"thickness\": 0.2",
  points: "\"particles\": { \"distribution\": \"sphere\", \"count\": 2000, \"radius\": 2 }", text: "\"text\": \"Label\", \"textSize\": 0.4",
  parametric: "\"surface\": \"ripple\", \"width\": 8, \"depth\": 8, \"amplitude\": 0.6", mesh: "\"positions\": [0, 0, 0, 1, 0, 0, 0, 1, 0]",
};

/** A minimal valid example of each animation's own fields. */
export const ANIMATION_EXAMPLES: Record<SceneAnimation["type"], string> = {
  spin: "\"speed\": 45", orbit: "\"center\": \"sun\", \"radius\": 5, \"period\": 10", oscillate: "\"property\": \"position\", \"axis\": [0, 1, 0], \"amplitude\": 0.3, \"period\": 2",
  keyframes: "\"property\": \"position\", \"keys\": [{ \"t\": 0, \"value\": [0, 0, 0] }, { \"t\": 2, \"value\": [2, 0, 0] }]", path: "\"path\": \"track\", \"duration\": 6",
  flow: "\"path\": \"wire\", \"rate\": 1.5", track: "\"lookAt\": \"sun\"", couple: "\"source\": \"spin-gear-a\", \"ratio\": -2",
};

/** A hint for a reference to an id that does not exist: the nearest ids, or a few that do exist. */
export function referenceHint(value: string, ids: readonly string[]): string {
  const near = closest(value, ids, 3);
  if (near.length) return `did you mean ${near.map(id => `"${id}"`).join(" or ")}?`;
  if (!ids.length) return "nothing of that kind exists yet";
  return `existing: ${ids.slice(0, 10).map(id => `"${id}"`).join(", ")}${ids.length > 10 ? ` (+${ids.length - 10})` : ""}`;
}

/** A hint for an id that is not a valid id: what it would be as one. */
export function idHint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const fixed = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return fixed && fixed !== value ? `ids are lowercase: "${fixed}"` : undefined;
}
