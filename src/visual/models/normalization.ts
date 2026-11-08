import { eulerDegrees, identity, multiply, transformPoints, type Mat4, type ModelGeometry, type Vec3 } from "./geometry";

/**
 * Orientation, centre and scale (v0.9). Every model reaches the stage the same way: its up axis turned to +Y, its front
 * toward the viewer (+Z), centred on its bounding box and scaled so its farthest point lies at `extent` — whatever units
 * and conventions it was authored in. glTF is Y-up by definition; STL and many OBJ files are Z-up, which a manifest says.
 */
export const UP_AXES = ["y", "z", "-z", "x", "-x", "-y"] as const;
export type UpAxis = typeof UP_AXES[number];

export interface Orientation {
  /** The model's own up axis (default y). */
  up?: UpAxis;
  /** Turn about the vertical axis after `up`, degrees (positive: anticlockwise seen from above), so the front faces +Z. */
  yaw?: number;
  /** Any further rotation (degrees about X, Y, Z), applied last. */
  rotate?: Vec3;
}

const UP_ROTATION: Record<UpAxis, Vec3> = { y: [0, 0, 0], z: [-90, 0, 0], "-z": [90, 0, 0], x: [0, 0, 90], "-x": [0, 0, -90], "-y": [180, 0, 0] };

export function orientationMatrix(orientation: Orientation = {}): Mat4 {
  let m = eulerDegrees(UP_ROTATION[orientation.up ?? "y"] ?? [0, 0, 0]);
  if (orientation.yaw) m = multiply(eulerDegrees([0, orientation.yaw, 0]), m);
  if (orientation.rotate) m = multiply(eulerDegrees(orientation.rotate), m);
  return m;
}

export interface Bounds { min: Vec3; max: Vec3; centre: Vec3; radius: number }

export function geometryBounds(geometry: ModelGeometry): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of geometry.primitives) {
    for (let i = 0; i < p.indices.length; i++) {
      const at = p.indices[i] * 3;
      for (let k = 0; k < 3; k++) { const v = p.positions[at + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    }
  }
  const centre = [0, 1, 2].map(k => (min[k] + max[k]) / 2) as Vec3;
  let radius = 0;
  for (const p of geometry.primitives) {
    for (let i = 0; i < p.indices.length; i++) {
      const at = p.indices[i] * 3;
      radius = Math.max(radius, Math.hypot(p.positions[at] - centre[0], p.positions[at + 1] - centre[1], p.positions[at + 2] - centre[2]));
    }
  }
  return { min, max, centre, radius };
}

/**
 * The geometry turned, centred and scaled onto the stage, and the matrix that did it (the same matrix places every frame
 * of an animation, so a moving character keeps its size). Throws "model-empty" for a model with no extent.
 */
export function normalizeGeometry(geometry: ModelGeometry, orientation: Orientation | undefined, extent: number): { geometry: ModelGeometry; matrix: Mat4 } {
  const turn = orientationMatrix(orientation);
  const turned: ModelGeometry = { ...geometry, primitives: geometry.primitives.map(p => ({ ...p, positions: transformPoints(p.positions, turn) })) };
  const bounds = geometryBounds(turned);
  if (!(bounds.radius > 0) || !Number.isFinite(bounds.radius)) throw new Error("model-empty");
  const scale = extent / bounds.radius;
  const place = identity();
  place[0] = place[5] = place[10] = scale;
  place[12] = -bounds.centre[0] * scale; place[13] = -bounds.centre[1] * scale; place[14] = -bounds.centre[2] * scale;
  const matrix = multiply(place, turn);
  return { geometry: { ...geometry, primitives: geometry.primitives.map(p => ({ ...p, positions: transformPoints(p.positions, matrix) })) }, matrix };
}
