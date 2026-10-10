import type { Node } from "three/webgpu";
import { cos, float, sin, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "./uniforms";

/**
 * Per-particle morph weight. A stable hash of the rest position staggers departure and arrival
 * slightly, so a Visual Action reads as the same body reorganising rather than every grain moving
 * in lockstep. Compute and material evaluate the identical expression from the same rest buffer.
 */
export function morphWeight(rest: Node, u: PhysicsUniforms) {
  const hash = sin(rest.dot(vec3(12.9898, 78.233, 37.719))).mul(43758.5453).fract();
  const w = u.morph.mul(1.3).sub(hash.mul(0.3)).clamp(0, 1);
  return w.mul(w).mul(float(3).sub(w.mul(2)));
}

/**
 * The formed visual's rest shape, turned about the view axis by `formedAngle` (the target's own spin
 * accumulated by the runtime; 0, and so unchanged, for every target that does not spin). Compute and
 * material use the identical expression.
 */
export function formedTarget(target: Node, u: PhysicsUniforms) {
  const c = cos(u.formedAngle), s = sin(u.formedAngle);
  const x = target.x.mul(c).sub(target.y.mul(s)), y = target.x.mul(s).add(target.y.mul(c)), z = target.z;
  // A 3D object's view: turned about its vertical axis (yaw), then tilted toward the viewer (pitch), then zoomed.
  // All three are 0, 0 and 1 for every flat visual, which leaves it unchanged.
  const cy = cos(u.formedYaw), sy = sin(u.formedYaw), cp = cos(u.formedPitch), sp = sin(u.formedPitch);
  const x2 = x.mul(cy).add(z.mul(sy)), z2 = z.mul(cy).sub(x.mul(sy));
  return vec3(x2, y.mul(cp).sub(z2.mul(sp)), y.mul(sp).add(z2.mul(cp))).mul(u.formedZoom);
}

/** The CPU reference of formedTarget (canvas fallback and tests). */
export function formedPoint(x: number, y: number, z: number, view: { angle: number; yaw: number; pitch: number; zoom: number }): [number, number, number] {
  const c = Math.cos(view.angle), s = Math.sin(view.angle);
  const x1 = x * c - y * s, y1 = x * s + y * c;
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const x2 = x1 * cy + z * sy, z2 = z * cy - x1 * sy;
  return [x2 * view.zoom, (y1 * cp - z2 * sp) * view.zoom, (y1 * sp + z2 * cp) * view.zoom];
}

/**
 * Per-particle weight of the persistent figure body (0: sphere, 1: figure), staggered by a second stable
 * hash so the body re-forms grain by grain rather than in lockstep. Compute and material share it.
 */
export function bodyWeight(rest: Node, u: PhysicsUniforms) {
  const hash = sin(rest.dot(vec3(41.3, 17.9, 63.1))).mul(24634.6345).fract();
  const w = u.bodyMorph.mul(1.35).sub(hash.mul(0.35)).clamp(0, 1);
  return w.mul(w).mul(float(3).sub(w.mul(2)));
}

/** Per-particle weight of the eyes body (0: none, 1: eyes), staggered by its own stable hash. */
export function eyesWeight(rest: Node, u: PhysicsUniforms) {
  const hash = sin(rest.dot(vec3(23.7, 59.3, 11.9))).mul(31871.2297).fract();
  const w = u.eyesMorph.mul(1.35).sub(hash.mul(0.35)).clamp(0, 1);
  return w.mul(w).mul(float(3).sub(w.mul(2)));
}
