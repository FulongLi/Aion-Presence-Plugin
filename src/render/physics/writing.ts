import type { Node } from "three/webgpu";
import { abs, clamp, float, floor, max, mix, step } from "three/tsl";
import type { PhysicsUniforms } from "./uniforms";
import { REVEAL_RAMP, WRITING_GLOW } from "../writing";

/**
 * Writing on the GPU (v0.4.3): the same expressions as render/writing.ts, on each grain's reveal key (a storage buffer
 * written once per target). Compute and material share writingTarget so a grain's rest and its drawn place agree. For
 * every target that is not writing, all keys are −1 and these return the target and a factor of 1, unchanged.
 */
const roles = (key: Node) => {
  const pen = float(1).sub(step(-1.5, key));
  const stroke = step(-0.5, key);
  return { pen, stroke, other: float(1).sub(pen).sub(stroke) };
};

/** Where a grain of the formed target rests: its own place, or (the pen) the tip plus its offset. */
export function writingTarget(target: Node, key: Node, u: PhysicsUniforms) {
  return mix(target, target.add(u.writeTip), roles(key).pen);
}

/** The grain's light factor: ghost → written (the current stroke brighter, just-written grains glowing), the pen's light, 1 otherwise. */
export function writingLight(key: Node, u: PhysicsUniforms) {
  const { pen, stroke, other } = roles(key);
  const ahead = u.writeProgress.sub(key);
  const revealed = max(u.writeComplete, clamp(ahead.div(REVEAL_RAMP), 0, 1));
  const current = float(1).sub(clamp(abs(floor(key).sub(u.writeStroke)), 0, 1));
  const lit = u.writeRest.add(float(1).sub(u.writeRest).mul(current));
  const glow = step(0, ahead).mul(float(1).sub(step(WRITING_GLOW, ahead))).mul(float(1).sub(ahead.div(WRITING_GLOW))).mul(0.45).mul(float(1).sub(u.writeComplete));
  const strokeLight = u.writeGhost.add(lit.add(glow).sub(u.writeGhost).mul(revealed));
  return pen.mul(u.writePen).add(stroke.mul(strokeLight)).add(other);
}

/** The pen's grains vanish with it; every other grain keeps its size. */
export function writingSize(key: Node, u: PhysicsUniforms) {
  return mix(float(1), u.writePen, roles(key).pen);
}
