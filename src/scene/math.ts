import type { SceneNode, Vec3 } from "./ir";

/**
 * Small, dependency-free transform math for the Scene IR (v0.5): the animation evaluator, the particle adapter and the
 * tests use it without Three.js, and it follows Three.js's conventions exactly (Euler XYZ in degrees, quaternions
 * [x, y, z, w]) so the card and the body agree on where everything is.
 */
export type Quat = [number, number, number, number];

export const RAD = Math.PI / 180;
export const IDENTITY: Quat = [0, 0, 0, 1];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const mulv = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => { const l = length(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 1, 0]; };
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Euler angles in degrees, XYZ order (as Three.js's Euler "XYZ"). */
export function quatFromEuler(e: Vec3): Quat {
  const [x, y, z] = e.map(v => v * RAD / 2);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

export function quatAxisAngle(axis: Vec3, degrees: number): Quat {
  const a = normalize(axis), h = degrees * RAD / 2, s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

export const quatConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function rotate(v: Vec3, q: Quat): Vec3 {
  const [x, y, z] = v, [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

/** The rotation that turns unit vector `from` onto unit vector `to`. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const f = normalize(from), t = normalize(to);
  const r = dot(f, t) + 1;
  if (r < 1e-8) {
    const axis = Math.abs(f[0]) > Math.abs(f[2]) ? [-f[1], f[0], 0] as Vec3 : [0, -f[2], f[1]] as Vec3;
    return quatAxisAngle(axis, 180);
  }
  const c = cross(f, t), l = Math.hypot(c[0], c[1], c[2], r);
  return [c[0] / l, c[1] / l, c[2] / l, r / l];
}

/** An orientation whose +z faces `direction` and whose +y stays as near to up as it can (Three.js's Object3D.lookAt). */
export function quatLookAlong(direction: Vec3, up: Vec3 = [0, 1, 0]): Quat {
  const z = normalize(direction);
  let x = cross(up, z);
  if (length(x) < 1e-6) x = cross([0, 0, 1], z);
  x = normalize(x);
  const y = cross(z, x);
  // Rotation matrix (columns x, y, z) to quaternion.
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
  if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

export const scaleVec = (scale: SceneNode["scale"]): Vec3 => scale === undefined ? [1, 1, 1] : typeof scale === "number" ? [scale, scale, scale] : [...scale] as Vec3;

/** A transform (translation, rotation, scale) and how points pass through it. */
export interface Transform { position: Vec3; quaternion: Quat; scale: Vec3 }
export const IDENTITY_TRANSFORM: Transform = { position: [0, 0, 0], quaternion: IDENTITY, scale: [1, 1, 1] };
export const nodeTransform = (n: Pick<SceneNode, "position" | "rotation" | "scale">): Transform => ({
  position: n.position ?? [0, 0, 0], quaternion: n.rotation ? quatFromEuler(n.rotation) : IDENTITY, scale: scaleVec(n.scale),
});
export const apply = (t: Transform, p: Vec3): Vec3 => add(rotate(mulv(p, t.scale), t.quaternion), t.position);
export function unapply(t: Transform, p: Vec3): Vec3 {
  const local = rotate(sub(p, t.position), quatConj(t.quaternion));
  return [local[0] / (t.scale[0] || 1), local[1] / (t.scale[1] || 1), local[2] / (t.scale[2] || 1)];
}
/** parent ∘ child. Exact for uniform scales (the common case); non-uniform scale under rotation is approximated. */
export function compose(parent: Transform, child: Transform): Transform {
  return { position: apply(parent, child.position), quaternion: quatMul(parent.quaternion, child.quaternion), scale: mulv(parent.scale, child.scale) };
}

/** Euler angles in degrees, XYZ order, of a quaternion (as Three.js's Euler.setFromQuaternion with "XYZ"). */
export function eulerFromQuat(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - w * z), m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - w * x), m32 = 2 * (y * z + w * x), m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  const deg = (v: number) => Math.round(v / RAD * 1e6) / 1e6;
  if (Math.abs(m13) < 0.9999999) return [deg(Math.atan2(-m23, m33)), deg(ey), deg(Math.atan2(-m12, m11))];
  return [deg(Math.atan2(m32, m22)), deg(ey), 0];
}
