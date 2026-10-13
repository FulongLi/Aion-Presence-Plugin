import type { Node } from "three/webgpu";
import { abs, atan, cos, float, fract, int, mix, pow, sin, step, vec3 } from "three/tsl";
import { RING_BANDS, RING_HASHES, RING_STAGGER } from "../ring";
import type { PhysicsUniforms } from "./uniforms";

/**
 * The circular audio spectrum on the GPU: the TSL twin of render/ring.ts (same hashes, same expression), evaluated in
 * compute (the rest the spring follows) and in the material (where the grain is drawn and how bright it is).
 */
const hash = (rest: Node, [a, b, c, k]: readonly number[]) => sin(rest.dot(vec3(a, b, c))).mul(k).fract();

export function ringRest(rest: Node, u: PhysicsUniforms) {
  const [h0, h1, h2, h3] = RING_HASHES.map(values => hash(rest, values));
  const g = u.audioGain;
  const coreScale = u.ringCoreScale.mul(float(1).add(u.audioBass.mul(0.08).mul(g)).add(u.audioBeat.mul(0.05).mul(g)));
  const core = rest.mul(coreScale);
  const theta = atan(rest.y, rest.x).add(u.clock.mul(u.ringFlow).mul(h1.mul(0.6).add(0.4)));
  // 0 at the bottom (bass) … 1 at the top (treble), mirrored left and right.
  const a = fract(theta.add(Math.PI / 2).div(Math.PI * 2).add(0.5)).mul(Math.PI * 2).sub(Math.PI);
  const p = abs(a).div(Math.PI).clamp(0, 1).mul(RING_BANDS - 1);
  const i0 = p.floor().toInt(), i1 = i0.add(int(1)).min(int(RING_BANDS - 1));
  const value = mix(u.audioBands.element(i0), u.audioBands.element(i1), p.fract());
  const row = pow(h2, 1.6);
  const base = u.ringRadius.mul(float(1).add(u.audioBass.mul(0.07).mul(g))).add(u.audioBeat.mul(0.05).mul(g));
  const wave = sin(theta.mul(6).sub(u.clock.mul(3))).mul(u.audioMid).mul(0.05).mul(g);
  const shimmer = sin(u.clock.mul(23).add(h3.mul(60))).mul(u.audioTreble).mul(0.025).mul(g).mul(row);
  const radius = base.add(row.mul(value.mul(u.ringHeight).mul(g).min(1.1))).add(h3.sub(0.5).mul(0.05)).add(wave).add(shimmer);
  const ring = vec3(cos(theta).mul(radius), sin(theta).mul(radius), h1.sub(0.5).mul(0.16).add(sin(theta.mul(3).add(u.clock.mul(0.7))).mul(0.04)));
  // 1 for the grains that stay as the core (h0 below the core share), as in ringPoint.
  const isCore = float(1).sub(step(u.ringCore, h0));
  return { position: mix(ring, core, isCore), energy: mix(value.mul(row.mul(0.6).add(0.4)), u.audioBass.mul(0.5), isCore), core: isCore };
}

/** Per-grain weight of the ring layer (0: the body, 1: the ring), staggered by its own stable hash. */
export function ringWeight(rest: Node, u: PhysicsUniforms) {
  const h = hash(rest, RING_STAGGER);
  const w = u.ringMorph.mul(1.35).sub(h.mul(0.35)).clamp(0, 1);
  return w.mul(w).mul(float(3).sub(w.mul(2)));
}
