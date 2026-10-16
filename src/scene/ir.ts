/**
 * The Aion Scene IR (v0.5): one renderer-independent description of a visual scene, shared by Codex, the host, the
 * particle body and the interactive card. Codex writes it as data; Aion validates it (validate.ts), changes it only by
 * validated patches (patch.ts), keeps its history (history.ts), routes it (router.ts) and renders it with an adapter:
 * the particle body (particleAdapter.ts) or the Three.js scene compiler inside the sandboxed card
 * (src/cards/apps/generativeScene). Nothing in a scene is code, a URL, a shader or markup: only numbers within bounds,
 * names from fixed lists, colours and short display text.
 *
 * Conventions (explicit in every document's `units` and `coordinateSystem`):
 *   - right-handed, y up, z toward the default viewer; positions in `units.length` (default "unit");
 *   - rotations are Euler angles in degrees, applied in X, Y, Z order; times in seconds;
 *   - a node's transform is relative to its parent (`parent`: another node's id); nodes are a flat list, so a patch can
 *     address any of them by its stable id.
 */
export const SCENE_IR_VERSION = 1 as const;

export type Vec3 = [number, number, number];

export const LENGTH_UNITS = ["unit", "mm", "cm", "m", "km", "au"] as const;
export type LengthUnit = typeof LENGTH_UNITS[number];
export const COORDINATE_SYSTEMS = ["right-handed-y-up"] as const;

/** What kind of request produced the scene: the router reads it (with the scene's own evidence). */
export const INTENT_KINDS = ["abstract", "concrete", "structural", "scientific", "engineering"] as const;
export type IntentKind = typeof INTENT_KINDS[number];
/** How exact the result must be. `measured`: real data the user relies on; `illustrative`: a conceptual picture. */
export const FIDELITY_LEVELS = ["symbolic", "illustrative", "approximate", "measured"] as const;
export type Fidelity = typeof FIDELITY_LEVELS[number];
/** What the user will do with it: look, turn and zoom, select and inspect, or keep editing it. */
export const INTERACTION_LEVELS = ["none", "view", "inspect", "edit"] as const;
export type InteractionLevel = typeof INTERACTION_LEVELS[number];

export interface SceneIntent {
  kind: IntentKind;
  /** One line: what the user asked to see. */
  summary?: string;
  fidelity?: Fidelity;
  interaction?: InteractionLevel;
}

export const NODE_TYPES = [
  "group", "sphere", "box", "cylinder", "cone", "torus", "plane", "ring", "circle", "line", "polyline", "curve", "tube", "helix", "arrow", "gear",
  "points", "text", "parametric", "mesh",
] as const;
export type NodeType = typeof NODE_TYPES[number];

export const POINT_DISTRIBUTIONS = ["sphere", "shell", "box", "disc", "ring", "line", "path", "grid", "spiral"] as const;
export type PointDistribution = typeof POINT_DISTRIBUTIONS[number];

/** Parametric surfaces from a fixed catalog (no expressions are ever evaluated). Built in the x–z plane, height on y. */
export const SURFACES = ["wave", "ripple", "saddle", "paraboloid", "sinc", "gaussian"] as const;
export type SurfaceKind = typeof SURFACES[number];

/** A colour: #rrggbb (names such as "blue" are accepted on input and normalized to hex). */
export type SceneColor = string;

export interface MaterialProps {
  color?: SceneColor;
  /** 0 (invisible) … 1 (opaque). */
  opacity?: number;
  emissive?: SceneColor;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  wireframe?: boolean;
  /** Lit by nothing: its colour exactly (lines, labels, glowing bodies). */
  unlit?: boolean;
  /** Lines only: dashed. */
  dashed?: boolean;
}

export interface SceneMaterial extends MaterialProps { id: string; name?: string }

/**
 * Repeats a node's own geometry `count` times, each copy offset, turned and scaled by one more step than the last (its
 * children are attached once, to the first copy).
 */
export interface SceneRepeat { count: number; offset?: Vec3; rotation?: Vec3; scale?: number }

export interface PointsSpec {
  distribution: PointDistribution;
  count: number;
  /** sphere, shell, disc, spiral: the radius; ring: the outer radius. */
  radius?: number;
  /** ring: the inner radius. */
  inner?: number;
  /** box, grid: the extent. */
  size?: Vec3;
  /** line: its two ends. */
  from?: Vec3;
  to?: Vec3;
  /** path: the node (a polyline, curve, tube, circle or helix) the points lie along. */
  path?: string;
  /** Particle size in pixels. */
  pointSize?: number;
  seed?: number;
}

/** Geometry parameters; which apply depends on the node's type (validate.ts lists them per type). */
export interface GeometryParams {
  radius?: number;
  /** cylinder: the top radius (0: a cone). */
  radiusTop?: number;
  height?: number;
  size?: Vec3;
  /** torus: the tube radius; helix: a tube radius (0 or absent: a thin line). */
  tube?: number;
  /** torus: the arc in degrees. */
  arc?: number;
  inner?: number;
  outer?: number;
  width?: number;
  depth?: number;
  from?: Vec3;
  to?: Vec3;
  points?: Vec3[];
  closed?: boolean;
  turns?: number;
  teeth?: number;
  thickness?: number;
  /** text: what it says. */
  text?: string;
  /** text: its height in scene units. */
  textSize?: number;
  surface?: SurfaceKind;
  amplitude?: number;
  frequency?: number;
  resolution?: number;
  /** mesh: flat x, y, z triples. */
  positions?: number[];
  /** mesh: flat triangle indices (absent: consecutive triples). */
  indices?: number[];
  particles?: PointsSpec;
}

export interface SceneNode extends GeometryParams {
  /** Stable id: lowercase letters, digits, "-", "_" and "." (a patch, a selection and an animation name it). */
  id: string;
  type: NodeType;
  name?: string;
  parent?: string;
  position?: Vec3;
  rotation?: Vec3;
  scale?: number | Vec3;
  /** A shared material's id, or the node's own material. */
  material?: string | MaterialProps;
  visible?: boolean;
  /** Whether a click selects it (default true, except lines, labels and point clouds). */
  selectable?: boolean;
  /** A short label drawn beside it. */
  label?: string;
  /** A note shown when it is selected (and reported to Codex). */
  annotation?: string;
  /** Facts about it, shown when it is selected and reported to Codex: a few short values. */
  metadata?: Record<string, string | number | boolean>;
  repeat?: SceneRepeat;
}

export const ANIMATION_TYPES = ["spin", "orbit", "oscillate", "keyframes", "path", "flow", "track", "couple"] as const;
export type AnimationType = typeof ANIMATION_TYPES[number];
export const ANIMATED_PROPERTIES = ["position", "rotation", "scale", "color", "opacity", "emissive", "visible"] as const;
export type AnimatedProperty = typeof ANIMATED_PROPERTIES[number];
export const EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out", "step"] as const;
export type Easing = typeof EASINGS[number];
export const WAVES = ["sine", "square", "triangle", "saw"] as const;
export type Wave = typeof WAVES[number];

export type KeyValue = number | Vec3 | SceneColor | boolean;
export interface Keyframe { t: number; value: KeyValue }

/**
 * A declarative animation of one node. Several may act on one node; they compose in document order (orbit and path
 * place it, spin and track turn it, oscillate and keyframes add to or set a property, couple drives one spin by another).
 */
export interface SceneAnimation {
  id: string;
  target: string;
  type: AnimationType;
  /** spin, orbit, oscillate: the axis (default y). */
  axis?: Vec3;
  /** spin: degrees per second. */
  speed?: number;
  /** orbit: the node it circles (sharing the target's parent) or a point; default the parent's origin. */
  center?: string | Vec3;
  /** orbit: the distance (default: the target's own distance from the centre). */
  radius?: number;
  /** orbit, oscillate: seconds per cycle. */
  period?: number;
  /** orbit, oscillate: the starting angle in degrees (a phase relationship between objects). */
  phase?: number;
  /** orbit: 0 (a circle) … 0.95. */
  eccentricity?: number;
  /** orbit: the orbit's tilt in degrees. */
  inclination?: number;
  clockwise?: boolean;
  /** oscillate, keyframes: what changes. */
  property?: AnimatedProperty;
  /** oscillate: the size of the swing (units, degrees, a scale or opacity fraction, or emissive intensity). */
  amplitude?: number;
  wave?: Wave;
  /** keyframes: times (seconds from the animation's start) and values. */
  keys?: Keyframe[];
  easing?: Easing;
  /** path, flow: the node (a polyline, curve, tube, circle or helix) it follows. */
  path?: string;
  /** path: seconds for one traversal. */
  duration?: number;
  /** path: turn to face along the path. */
  orient?: boolean;
  /** flow: units per second along the path. */
  rate?: number;
  /** track: the node it keeps facing (sharing the target's parent). */
  lookAt?: string;
  /** couple: the spin animation that drives this one, and the ratio (a gear train: negative turns the other way). */
  source?: string;
  ratio?: number;
  /** Seconds on the timeline before it starts. */
  start?: number;
  /** Times it plays ("loop": forever; default: loop for periodic motion, once for keyframes and paths). */
  repeat?: number | "loop";
  /** Plays forward, then backward. */
  yoyo?: boolean;
  /** Its own speed multiplier. */
  timeScale?: number;
  /** Stopped where it is (the rest of the scene keeps moving). */
  paused?: boolean;
}

export interface SceneCamera {
  position?: Vec3;
  target?: Vec3;
  fov?: number;
  /** Frame these nodes (default: everything). */
  frame?: string[];
}

export interface SceneEnvironment {
  background?: SceneColor;
  /** Ambient light 0…2. */
  ambient?: number;
  /** A directional key light (default on). */
  light?: boolean;
  /** A node that also lights the scene (a sun). */
  lightSource?: string;
  grid?: boolean;
  axes?: boolean;
  stars?: boolean;
}

export interface SceneTimeline {
  /** Default playback speed (1 = real time). */
  speed?: number;
  /** Starts playing at once (default true). */
  autoplay?: boolean;
}

export const PRESENTATION_MODES = ["auto", "body", "card", "hybrid"] as const;
export type PresentationMode = typeof PRESENTATION_MODES[number];
export const SCENE_LAYOUTS = ["compact", "expanded", "fullscreen"] as const;

export interface ScenePresentation {
  mode?: PresentationMode;
  layout?: typeof SCENE_LAYOUTS[number];
  /** Labels on (default true). */
  labels?: boolean;
}

export interface SceneDocument {
  version: typeof SCENE_IR_VERSION;
  sceneId: string;
  title: string;
  intent?: SceneIntent;
  units?: { length: LengthUnit; time: "s"; angle: "deg" };
  coordinateSystem?: typeof COORDINATE_SYSTEMS[number];
  /** What the user must know about it: scale approximations, "illustrative, not computed". Always shown. */
  disclosure?: string[];
  /** Capabilities it needs beyond what its content implies (see capabilities.ts), e.g. "compute:magnetic-field". */
  requirements?: string[];
  objects: SceneNode[];
  materials?: SceneMaterial[];
  animations?: SceneAnimation[];
  camera?: SceneCamera;
  environment?: SceneEnvironment;
  timeline?: SceneTimeline;
  presentation?: ScenePresentation;
}

/**
 * The bounds every scene respects: geometry stays bounded, compilation fast, the bridge message small. A scene that
 * exceeds one is refused with the limit it exceeded (resource-limit), never truncated silently.
 */
export const SCENE_IR_LIMITS = {
  bytes: 48 * 1024,
  title: 80,
  text: 80,
  annotation: 240,
  disclosures: 6,
  disclosure: 200,
  requirements: 24,
  nodes: 256,
  /** Nodes after repeats. */
  instances: 2_000,
  repeat: 128,
  materials: 64,
  animations: 128,
  keys: 64,
  points: 256,
  meshVertices: 2_048,
  meshIndices: 12_288,
  /** Point-cloud particles across the whole scene. */
  particles: 60_000,
  particlesPerNode: 20_000,
  metadata: 16,
  metadataText: 120,
  depth: 16,
  coordinate: 100_000,
  size: { min: 1e-4, max: 100_000 },
  /** Estimated triangles across the whole compiled scene. */
  triangles: 600_000,
  period: { min: 0.05, max: 1e7 },
  /** Degrees per second. */
  spin: 36_000,
  time: 1e7,
  resolution: { min: 4, max: 256 },
  teeth: { min: 6, max: 120 },
} as const;

/** Ids: stable, lowercase, readable ("earth", "orbit-mars", "coil.a"). Matches the Card Bridge's object ids. */
export const SCENE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const isSceneId = (value: unknown): value is string => typeof value === "string" && SCENE_ID.test(value);

/** In a patch: the object the user has selected in the card (resolved on the host before anything is applied). */
export const SELECTED = "$selected";

/** Node types that draw lines or points rather than surfaces (not selectable by default). */
export const LINE_TYPES: readonly NodeType[] = ["line", "polyline", "curve", "circle", "points", "text"];
/** Node types that define a path an animation or a point cloud can follow. */
export const PATH_TYPES: readonly NodeType[] = ["line", "polyline", "curve", "tube", "circle", "helix"];
