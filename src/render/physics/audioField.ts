import type { Node } from "three/webgpu";
import { acos, atan, float, int, mix, sin, vec3 } from "three/tsl";
import { RING_BANDS } from "../ring";
import type { PhysicsUniforms } from "./uniforms";

/**
 * The sphere moved by sound on the GPU: the TSL twin of sphereAudioOffset (render/ring.ts). A displacement target the
 * spring follows, so motion stays smooth whatever the audio does.
 */
export function sphereAudioField(rest: Node, u: PhysicsUniforms) {
  const normal = rest.div(rest.length().add(0.0001));
  const g = u.audioGain.mul(u.sphereAudio);
  const position = float(1).sub(acos(normal.y.clamp(-1, 1)).div(Math.PI));
  const p = position.clamp(0, 1).mul(RING_BANDS - 1);
  const i0 = p.floor().toInt(), i1 = i0.add(int(1)).min(int(RING_BANDS - 1));
  const band = mix(u.audioBands.element(i0), u.audioBands.element(i1), p.fract());
  const longitude = atan(normal.z, normal.x);
  const waves = band.mul(0.07).mul(sin(longitude.mul(7).add(u.clock.mul(2.2)).add(position.mul(5))).mul(0.4).add(0.6));
  const ripple = sin(rest.x.mul(0.3).add(rest.y).add(rest.z.mul(0.2)).mul(4).sub(u.clock.mul(5))).mul(u.audioMid).mul(0.025);
  const radial = u.audioLevel.mul(0.05).add(u.audioBeat.mul(0.06)).add(waves).add(ripple).mul(g);
  const shiver = u.audioTreble.mul(0.02).mul(g);
  const tangent = vec3(sin(u.clock.mul(17).add(rest.y.mul(9))), sin(u.clock.mul(19).add(rest.z.mul(9))), sin(u.clock.mul(13).add(rest.x.mul(9)))).mul(shiver);
  return normal.mul(radial).add(tangent);
}
