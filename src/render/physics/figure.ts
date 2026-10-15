import type { Node } from "three/webgpu";
import { clamp, cos, float, mix, normalize, sin, step, vec3 } from "three/tsl";
import { FIGURE_KINDS, figureStroke } from "../../core/figure/layout";
import { FIGURE_SCALE, LIMB_SLOT } from "../../core/figure/skeleton";
import type { PhysicsUniforms } from "./uniforms";

/**
 * The Particle Figure's rest position for one grain, from its binding (see aion/figure/layout.ts) and the
 * skeleton anchors the pose animator uploads each frame. Compute and material evaluate the identical
 * expression; `figurePoint()` is its CPU reference for tests.
 */
export function figureRest(bind: Node, local: Node, u: PhysicsUniforms) {
  const packed = bind.x.add(0.5).floor();
  const index = (divisor: number) => packed.div(divisor).floor().mod(16).toInt();
  const anchor = (divisor: number) => u.anchors.element(index(divisor)).xyz;
  const a = anchor(1), b = anchor(16), c = anchor(256), d = anchor(4096);
  const kind = packed.div(65536).floor();
  // Grains flow gently along their bone (zero at both ends, so joints and the head ring stay put).
  const s0 = bind.y;
  const s = s0.add(sin(u.clock.mul(figureStroke.flowSpeed).add(local.w)).mul(figureStroke.flow).mul(s0.mul(float(1).sub(s0)).mul(4)));
  const base = mix(mix(a, b, s), mix(d, c, s), bind.z);
  const direction = normalize(b.sub(a).add(vec3(0, 1e-4, 0)));
  const across = vec3(direction.y.negate(), direction.x, 0);
  // The halo about the head turns by the accumulated orbit; nothing else does.
  const halo = float(1).sub(kind.sub(FIGURE_KINDS.halo).abs().min(1));
  const co = cos(u.figureOrbit), si = sin(u.figureOrbit);
  const lx = mix(local.x, local.x.mul(co).sub(local.y.mul(si)), halo);
  const ly = mix(local.y, local.x.mul(si).add(local.y.mul(co)), halo);
  // A trace of positional life; grains away from their bone (the glow) drift a little more.
  const drift = float(figureStroke.drift).add(vec3(local.x, local.y, 0).length().mul(figureStroke.loose));
  const wobble = vec3(
    sin(u.clock.mul(0.7).add(local.w)),
    sin(u.clock.mul(0.53).add(local.w.mul(1.9))),
    sin(u.clock.mul(0.61).add(local.w.mul(2.7))),
  ).mul(drift);
  const position = base.add(direction.mul(lx)).add(across.mul(ly)).add(vec3(0, 0, local.z)).add(wobble);
  // Thinking lifts the halo's light a little; everything else keeps its own tone.
  const tone = bind.w.mul(float(1).add(halo.mul(u.thinking).mul(2.5)));
  // Figure 3.0 (v0.4.4): a limb grain lies on its limb's curve through the four anchors (layout.ts limbCurve).
  const limb = float(1).sub(kind.sub(FIGURE_KINDS.limb).abs().min(1));
  return { position: mix(position, limbRest(a, b, c, d, bind, local, u), limb), tone };
}

/** v0.4.4: the identical expression to limbPoint() in core/figure/layout.ts. */
function limbRest(a: Node, b: Node, c: Node, d: Node, bind: Node, local: Node, u: PhysicsUniforms) {
  const unit = (v: Node) => v.div(v.length().add(1e-6));
  const d0 = unit(b.sub(a)), d1 = unit(c.sub(b)), d2 = unit(d.sub(c));
  const t1 = unit(d0.add(d1)), t2 = unit(d1.add(d2));
  // Tighter turns at strongly bent joints (layout.ts `tight`).
  const k1 = float(1).sub(float(0.55).mul(float(1).sub(d0.dot(d1))).div(2)), k2 = float(1).sub(float(0.55).mul(float(1).sub(d1.dot(d2))).div(2));
  const segment = bind.y.floor(), u0 = bind.y.sub(segment);
  const t = clamp(u0.add(sin(u.clock.mul(figureStroke.flowSpeed).add(local.w)).mul(figureStroke.flow).mul(u0.mul(float(1).sub(u0)).mul(4))), 0, 1);
  // The span: 0 (p0→p1), 1 (p1→p2) or 2 (p2→p3), and the directions at its ends.
  const s1 = step(0.5, segment), s2 = step(1.5, segment);
  const p0 = mix(mix(a, b, s1), c, s2), p1 = mix(mix(b, c, s1), d, s2);
  const m0 = mix(mix(d0, t1.mul(k1), s1), t2.mul(k2), s2), m1 = mix(mix(t1.mul(k1), t2.mul(k2), s1), d2, s2);
  const span = p1.sub(p0).length();
  const t2_ = t.mul(t), t3 = t2_.mul(t);
  const h00 = t3.mul(2).sub(t2_.mul(3)).add(1), h10 = t3.sub(t2_.mul(2)).add(t), h01 = t2_.mul(3).sub(t3.mul(2)), h11 = t3.sub(t2_);
  const g00 = t2_.mul(6).sub(t.mul(6)), g10 = t2_.mul(3).sub(t.mul(4)).add(1), g01 = t.mul(6).sub(t2_.mul(6)), g11 = t2_.mul(3).sub(t.mul(2));
  const point = p0.mul(h00).add(m0.mul(span).mul(h10)).add(p1.mul(h01)).add(m1.mul(span).mul(h11));
  const tangent = p0.mul(g00).add(m0.mul(span).mul(g10)).add(p1.mul(g01)).add(m1.mul(span).mul(g11));
  const across = normalize(vec3(tangent.y.negate(), tangent.x, 0).add(vec3(1e-6, 0, 0)));
  // Secondary motion: the limb's lag offset, most in its middle and none at its ends (hands and feet stay exact).
  const lag = u.anchors.element(bind.z.add(LIMB_SLOT + 0.5).floor().toInt()).xyz;
  const bow = sin(clamp(local.x.div(FIGURE_SCALE), 0, 1).mul(Math.PI));
  const wobble = vec3(
    sin(u.clock.mul(0.7).add(local.w)),
    sin(u.clock.mul(0.53).add(local.w.mul(1.9))),
    sin(u.clock.mul(0.61).add(local.w.mul(2.7))),
  ).mul(figureStroke.drift);
  return point.add(across.mul(local.y)).add(vec3(0, 0, local.z)).add(lag.mul(bow)).add(wobble);
}
