import type { Node } from "three/webgpu";
import { abs, cos, float, max, min, pow, sin, smoothstep, vec3 } from "three/tsl";
import { EYE_GEOMETRY } from "../../core/eyes/layout";
import type { PhysicsUniforms } from "./uniforms";

/**
 * Aion Eyes' rest position for one grain, from its binding (see core/eyes/layout.ts) and the eyes' live shape the
 * animator uploads each frame (four vec4 per eye in `u.eyes`: frame, lids, shape, light). Compute and material
 * evaluate the identical expression; `eyesPoint()` is its CPU reference. The edge and the fill share one formula and
 * differ only in their radius and light, so there are no divergent branches.
 */
export function eyesRest(bind: Node, local: Node, u: PhysicsUniforms) {
  const packed = bind.x.add(0.5).floor();
  const kind = packed.mod(8);
  const base = packed.div(8).floor().mod(2).mul(4).toInt();
  const frame = u.eyes.element(base), lids = u.eyes.element(base.add(1)), shape = u.eyes.element(base.add(2)), light = u.eyes.element(base.add(3));
  const phi = bind.y, radius = bind.z, tone = bind.w;
  const edgeK = float(1).sub(kind.abs().min(1)), fillK = float(1).sub(edgeK);
  const n = max(float(1.6), shape.x);
  // The point in shape space: a direction and a share of the outline's reach in it (a fill grain breathes slightly).
  const cp = cos(phi), sp = sin(phi);
  const reach = pow(pow(max(abs(cp), 1e-6), n).add(pow(max(abs(sp), 1e-6), n)), float(-1).div(n));
  const r = radius.mul(float(1).add(sin(u.clock.mul(1.1).add(local.y)).mul(0.012).mul(light.z).mul(fillK)));
  const su = cp.mul(reach).mul(r), sv = sp.mul(reach).mul(r);
  // The lids: the visible band at su, and the shape squashed into it.
  const vmax = max(max(float(0.05), abs(sv)), pow(max(float(0), float(1).sub(pow(max(min(float(1), abs(su)), 1e-6), n))), float(1).div(n)));
  const top0 = min(vmax, float(1).sub(lids.x.mul(2)).sub(lids.z.mul(su)));
  const bottom = min(max(vmax.negate(), float(-1).add(lids.y.mul(2)).add(lids.w.mul(float(1).sub(su.mul(su))))), top0.sub(0.05));
  const top = max(top0, vmax.negate().add(0.05));
  const squash = bottom.add(sv.add(vmax).div(vmax.mul(2)).mul(top.sub(bottom)));
  const closed = float(1).sub(smoothstep(0.15, 0.75, top.sub(bottom).div(vmax.mul(2))));
  // Into the world: sized, bent into an arc (the ends stay, the middle lifts), tilted about the eye's centre.
  const lx = su.mul(frame.z), ly = squash.mul(frame.w).add(shape.y.mul(float(1).sub(min(float(1), su.mul(su)))));
  const c = cos(shape.z), s = sin(shape.z);
  const depth = max(float(0), float(1).sub(su.mul(su)).sub(squash.mul(squash))).mul(EYE_GEOMETRY.depth).add(local.x);
  const position = vec3(frame.x.add(lx.mul(c)).sub(ly.mul(s)), frame.y.add(lx.mul(s)).add(ly.mul(c)), depth);
  // The fill is lit a little from above (friendly, not glassy); the edge glows a little more as the lids close.
  const fillLight = light.y.mul(float(0.93).add(sv.mul(0.09)));
  const lit = tone.mul(shape.w).mul(edgeK.mul(light.x).mul(float(1).add(closed.mul(0.2))).add(fillK.mul(fillLight)));
  // Fill grains are larger than edge grains: a dense, luminous body inside a crisp line, at every quality tier.
  const grain = edgeK.mul(EYE_GEOMETRY.edgeGrain).add(fillK.mul(EYE_GEOMETRY.fillGrain));
  return { position, tone: lit.clamp(0, 1), grain };
}
