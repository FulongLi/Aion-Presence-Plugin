/**
 * A 3D scene Aion can become: a small composition of procedural primitives, described as data. Codex writes the
 * data; Aion validates it (validate.ts), builds the geometry itself (geometry.ts) and samples it into particles
 * (sample.ts). Nothing in a scene is code, a URL or an asset: only numbers within bounds and names from fixed lists.
 *
 * Units are arbitrary (a scene is centred and scaled to the stage); y is up, z toward the viewer. Angles are in
 * degrees. A ring lies flat in the horizontal (x–z) plane, like a planet's rings; everything else is built upright.
 */
export type Vec3 = [number, number, number];

export const SCENE_PRIMITIVES = ["box", "sphere", "pyramid", "cylinder", "cone", "torus", "ring", "line", "tube", "curve", "helix"] as const;
export type ScenePrimitive = typeof SCENE_PRIMITIVES[number];

/** How an object is drawn in particles: its surfaces, its edges and outlines, or both (the default by type). */
export const SCENE_DETAILS = ["surface", "edges", "both"] as const;
export type SceneDetail = typeof SCENE_DETAILS[number];

/** Repeats an object `count` times, each copy offset, turned and scaled by one more step than the last. */
export interface SceneRepeat { count: number; offset?: Vec3; rotation?: Vec3; scale?: number }

export interface SceneObjectBase {
  position?: Vec3;
  /** Euler angles in degrees, applied in X, Y, Z order. */
  rotation?: Vec3;
  /** Uniform or per-axis scale. */
  scale?: number | Vec3;
  /** Brightness of its particles, 0.2…1 (default 0.85). */
  tone?: number;
  /** Relative share of particles (default 1, by size). */
  weight?: number;
  detail?: SceneDetail;
  repeat?: SceneRepeat;
}

export type SceneObject = SceneObjectBase & (
  | { type: "box"; size: Vec3 }
  | { type: "sphere"; radius: number }
  /** A pyramid with `sides` (3–8, default 4) on a regular base of width `base`. */
  | { type: "pyramid"; base: number; height: number; sides?: number }
  | { type: "cylinder"; radius: number; height: number; radiusTop?: number }
  | { type: "cone"; radius: number; height: number }
  /** A ring torus: `radius` to the tube's centre, `tube` its thickness radius. Upright (in the x–y plane). */
  | { type: "torus"; radius: number; tube: number }
  /** A flat annulus in the x–z plane. */
  | { type: "ring"; inner: number; outer: number }
  | { type: "line"; from: Vec3; to: Vec3 }
  /** A smooth tube through points. */
  | { type: "tube"; points: Vec3[]; radius: number; closed?: boolean }
  /** A thin smooth curve through points. */
  | { type: "curve"; points: Vec3[]; closed?: boolean }
  /** A helix about the y axis: `turns` turns over `height`, starting at `phase` degrees. */
  | { type: "helix"; radius: number; height: number; turns: number; phase?: number }
);

export interface Scene3D {
  /** What it shows, e.g. "Egyptian pyramid". */
  title: string;
  objects: SceneObject[];
  /** slow (default): turns slowly about its vertical axis; none: holds still. */
  rotation?: "slow" | "none";
  /** Viewing elevation in degrees (default 15): positive looks down on it. */
  tilt?: number;
}

/** The bounds every scene must respect (geometry stays small, deterministic and fast to sample). */
export const SCENE_LIMITS = {
  title: 60,
  objects: 24,
  /** Objects after repeats. */
  instances: 256,
  repeat: 64,
  points: 64,
  /** Largest coordinate or offset (absolute). */
  coordinate: 10,
  /** Sizes and radii. */
  size: { min: 0.005, max: 10 },
  /** Triangles across the whole built scene. */
  triangles: 80_000,
  /** Serialized size of a scene (bytes). */
  payload: 16_384,
} as const;
