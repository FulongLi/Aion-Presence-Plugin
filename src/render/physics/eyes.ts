import type { Node } from "three/webgpu";
import { abs, cos, float, max, min, mix, pow, sign, sin, smoothstep, vec3 } from "three/tsl";
import { EYE_GEOMETRY } from "../../core/eyes/layout";
import type { PhysicsUniforms } from "./uniforms";

/**
 * Aion Eyes' rest position for one grain, from its binding (see core/eyes/layout.ts) and the eyes' live shape the
 * animator uploads each frame (four vec4 per eye in `u.eyes`). Compute and material evaluate the identical
 * expression; `eyesPoint()` is its CPU reference. Every component's formula is evaluated and the grain's own is
 * selected by weight (no divergent branches).
 */
export function eyesRest(bind: Node, local: Node, u: PhysicsUniforms) {
  const packed = bind.x.add(0.5).floor();
  const kind = packed.mod(8);
  const base = packed.div(8).floor().mod(2).mul(4).toInt();
  const frame = u.eyes.element(base), lids = u.eyes.element(base.add(1)), look = u.eyes.element(base.add(2)), brow = u.eyes.element(base.add(3));
  const a = bind.y, b = bind.z, tone = bind.w;
  const n = EYE_GEOMETRY.n;
  const is = (k: number) => float(1).sub(kind.sub(k).abs().min(1));
  const rimK = is(0), fillK = is(1), irisK = is(2), glintK = is(3), browK = is(4);
  const roundK = irisK.add(glintK), contourK = rimK.add(browK);
  // On the contour (the rim, and the brow where it rests on the rim's top).
  const angle = mix(a, float(Math.PI / 2).sub(a.mul(0.95)), browK);
  const c = cos(angle), s = sin(angle);
  const cu = sign(c).mul(pow(abs(c), 2 / n)), cv = sign(s).mul(pow(abs(s), 2 / n));
  const contourU = cu.mul(float(1).add(b.mul(rimK)));
  const contourV = cv.mul(float(1).add(mix(b, b.mul(0.4), browK)));
  // The iris and glint, around the gaze, kept inside the lens.
  const shimmer = float(1).add(sin(u.clock.mul(1.3).add(local.y)).mul(0.01).mul(irisK));
  const ox = mix(a, cos(a).mul(b).mul(shimmer), irisK), oy = mix(b, sin(a).mul(b).mul(shimmer), irisK);
  const ru0 = look.x.add(ox.mul(look.z).div(frame.z)), rv0 = look.y.add(oy.mul(look.z).div(frame.w));
  const reach = pow(pow(abs(ru0), n).add(pow(abs(rv0), n)), 1 / n);
  const pull = min(float(1), float(0.94).div(max(reach, 1e-4)));
  const su = contourU.mul(contourK).add(ru0.mul(pull).mul(roundK)).add(a.mul(fillK));
  const sv = contourV.mul(contourK).add(rv0.mul(pull).mul(roundK)).add(b.mul(fillK));
  // The lids: the visible band at su, and the shape squashed into it.
  const vmax = max(float(0.05), pow(max(float(0), float(1).sub(pow(min(float(1), abs(su)), n))), 1 / n));
  const top0 = min(vmax, float(1).sub(lids.x.mul(2)).sub(lids.z.mul(su)));
  const bottom = min(max(vmax.negate(), float(-1).add(lids.y.mul(2)).add(lids.w.mul(float(1).sub(su.mul(su))))), top0.sub(0.05));
  const top = max(top0, vmax.negate().add(0.05));
  const squash = bottom.add(sv.clamp(vmax.negate(), vmax).add(vmax).div(vmax.mul(2)).mul(top.sub(bottom)));
  const closed = float(1).sub(smoothstep(0.1, 0.7, top.sub(bottom).div(vmax.mul(2))));
  const bulge = max(float(0), float(1).sub(su.mul(su)).sub(squash.mul(squash))).mul(EYE_GEOMETRY.bulge);
  const depth = glintK.mul(0.05).add(irisK.mul(0.03));
  const eyed = vec3(frame.x.add(su.mul(frame.z)), frame.y.add(squash.mul(frame.w)), bulge.add(depth).add(local.x));
  const lit = tone.mul(glintK.mul(look.w).add(rimK.mul(float(1).add(closed.mul(0.25)))).add(float(1).sub(glintK).sub(rimK)));
  // A brow lifted out of the rim into an arc above the eye.
  const amount = smoothstep(0, 1, brow.w).mul(browK);
  const liftV = float(1.2).add(brow.x).add(brow.z.mul(float(1).sub(a.mul(a))).mul(0.25)).sub(brow.y.mul(a)).add(b);
  const lifted = vec3(frame.x.add(a.mul(0.82).mul(frame.z)), frame.y.add(liftV.mul(frame.w)), local.x.add(EYE_GEOMETRY.bulge * 0.3));
  const position = mix(eyed, lifted, amount);
  const light = mix(lit, tone.mul(float(0.55).add(smoothstep(0, 1, brow.w).mul(0.45))), browK).min(1);
  return { position, tone: light };
}
