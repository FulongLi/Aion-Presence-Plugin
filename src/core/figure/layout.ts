import { ANCHOR, BONES, FIGURE_SCALE, FIGURE_SLOTS, LIMB_SLOT, LIMBS, PROPORTIONS, TIPS } from "./skeleton";

/**
 * The Particle Figure as particles: every grain of the body is bound to the skeleton, so a pose only
 * moves 15 anchors and the grains follow on the GPU. It is procedural (no model, bitmap or avatar asset)
 * and drawn in the same language as the sphere and the clock: dense, precise particle strokes for the
 * bones, a clean ring of light for the head and small luminous beads at the joints (Figure 2.0). A thin glow
 * hugs the strokes; nothing drifts around the body.
 *
 * A binding is two vec4 per particle:
 *   bind  = (packed anchors a, b, c, d and kind, s, t, tone)
 *   local = (offset along the bone, offset across it, depth, phase)   (world units)
 *
 * Position = bilinear(a, b, c, d; s, t) + local offset in the frame of a → b. A bone uses c = b, d = a
 * (so t is irrelevant); a joint uses one anchor four times; the head ring hangs off neck → head with s = 1,
 * so tilting the head turns the ring. Every particle picks its component from one fixed random sequence,
 * so every quality tier (a prefix) shows the whole figure.
 *
 * The veil, halo and dust kinds of the first figure remain valid bindings (their share is 0): the GPU and the
 * CPU reference still evaluate them, so nothing downstream depends on which components a layout uses.
 */
export const FIGURE_KINDS = { bone: 0, ring: 1, joint: 2, veil: 3, aura: 4, halo: 5, dust: 6, limb: 7 } as const;
export type FigureKind = keyof typeof FIGURE_KINDS;

export interface FigureLayout { count: number; bind: Float32Array; local: Float32Array }

/**
 * Share of all particles per component. Figure 3.0 (v0.4.4) spends them on continuous limb curves (torso, arms and
 * legs, each one curve through its anchors), the head ring, small soft ends at the hands and feet, and a thin glow along
 * the limbs; the joint beads of Figure 2.0 are gone (their share went to the curves). v0.3 gave 42 % to background dust.
 */
export const FIGURE_SHARES: Record<FigureKind, number> = { limb: 0.79, ring: 0.15, joint: 0.03, aura: 0.03, bone: 0, veil: 0, halo: 0, dust: 0 };

export const packAnchors = (a: number, b: number, c: number, d: number, kind: number) => a + b * 16 + c * 256 + d * 4096 + kind * 65536;
export function unpackAnchors(packed: number) {
  const p = Math.round(packed);
  return { a: p % 16, b: Math.floor(p / 16) % 16, c: Math.floor(p / 256) % 16, d: Math.floor(p / 4096) % 16, kind: Math.floor(p / 65536) };
}

const random = (initial: number) => { let seed = initial; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };

/**
 * A stroke: one even line per bone, `width` its Gaussian cross-section (normalized σ, the same across and in
 * depth, so it reads as a fine tube from any angle), with a slow `flow` of grains along it (zero at the joints).
 * `drift` is the tiny positional life every grain keeps (world units); `loose` adds a little for grains away from
 * their bone (the glow).
 */
export const figureStroke = { width: 0.0042, flow: 0.018, flowSpeed: 0.45, drift: 0.0012, loose: 0.06 };

/**
 * A limb's curve (v0.4.4): through its four anchors p0…p3, span `segment` (0, 1, 2) at `u` (0…1). Each span is a cubic
 * Hermite curve whose tangents at the anchors are the average of the neighbouring directions, scaled to the span's own
 * length: the curve passes through every anchor with a continuous direction (no corner), never overshoots a short span
 * (shoulder, hip), and straightens exactly when the limb is straight. Returns the point and the tangent. The GPU
 * (render/physics/figure.ts) evaluates the identical expression.
 */
export function limbCurve(p: readonly (readonly number[])[], segment: number, u: number): { point: [number, number, number]; tangent: [number, number, number] } {
  const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a: readonly number[]) => { const l = len(a) + 1e-6; return [a[0] / l, a[1] / l, a[2] / l]; };
  const d = [unit(sub(p[1], p[0])), unit(sub(p[2], p[1])), unit(sub(p[3], p[2]))];
  // Directions at the anchors: the first and last follow their span; inner ones average the two spans around them.
  const at = (k: number) => k === 0 ? d[0] : k === 3 ? d[2] : unit([d[k - 1][0] + d[k][0], d[k - 1][1] + d[k][1], d[k - 1][2] + d[k][2]]);
  // A strongly bent joint keeps a tighter turn (shorter tangents there): flexible, never rubbery.
  const tight = (k: number) => k === 0 || k === 3 ? 1 : 1 - 0.55 * (1 - (d[k - 1][0] * d[k][0] + d[k - 1][1] * d[k][1] + d[k - 1][2] * d[k][2])) / 2;
  const k = Math.max(0, Math.min(2, Math.floor(segment)));
  const a = p[k], b = p[k + 1], L = len(sub(b, a));
  const ma = at(k).map(v => v * L * tight(k)), mb = at(k + 1).map(v => v * L * tight(k + 1));
  const t = Math.max(0, Math.min(1, u)), t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const g00 = 6 * t2 - 6 * t, g10 = 3 * t2 - 4 * t + 1, g01 = -6 * t2 + 6 * t, g11 = 3 * t2 - 2 * t;
  const point = [0, 1, 2].map(i => h00 * a[i] + h10 * ma[i] + h01 * b[i] + h11 * mb[i]) as [number, number, number];
  const tangent = [0, 1, 2].map(i => g00 * a[i] + g10 * ma[i] + g01 * b[i] + g11 * mb[i]) as [number, number, number];
  return { point, tangent };
}

/** Where a fraction `s` of a limb's neutral length falls: its span and the position within it. */
export function limbSpan(lengths: readonly number[], s: number): { segment: number; u: number } {
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let at = Math.max(0, Math.min(1, s)) * total;
  for (let k = 0; k < 3; k++) {
    if (lengths[k] > 0 && (at <= lengths[k] || k === 2 || lengths[k + 1] === 0)) return { segment: k, u: Math.min(0.9999, at / lengths[k]) };
    at -= lengths[k];
  }
  return { segment: 2, u: 0.9999 };
}

/** How thick a limb is along it: a little fuller at the root, finer toward the hand or foot. */
export const limbTaper = (s: number) => 1.18 - 0.36 * s;

export function createFigureLayout(count: number, seed = 0xa10f): FigureLayout {
  const bind = new Float32Array(count * 4), local = new Float32Array(count * 4);
  const next = random(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const S = FIGURE_SCALE, R = PROPORTIONS.headRadius;
  // Bones weighted by their neutral length, so the line density is even along the whole body.
  const neutralLength: Record<string, number> = {
    "neck-spine": PROPORTIONS.torso, "neck-shoulderLeft": PROPORTIONS.shoulderWidth, "neck-shoulderRight": PROPORTIONS.shoulderWidth,
    "spine-hipLeft": PROPORTIONS.hipWidth, "spine-hipRight": PROPORTIONS.hipWidth,
  };
  const boneWeights = BONES.map(([a, b, density]) => (neutralLength[`${a}-${b}`]
    ?? (a.startsWith("shoulder") ? PROPORTIONS.upperArm : a.startsWith("elbow") ? PROPORTIONS.forearm : a.startsWith("hip") ? PROPORTIONS.thigh : PROPORTIONS.shin)) * density);
  const boneTotal = boneWeights.reduce((sum, value) => sum + value, 0);
  // Hand and foot ends weighted by their area; limbs by their neutral length (an even line density along the body).
  const jointWeights = TIPS.map(tip => tip[1] * tip[1]);
  const jointTotal = jointWeights.reduce((sum, value) => sum + value, 0);
  const limbWeights = LIMBS.map(limb => limb.lengths.reduce((sum, value) => sum + value, 0));
  const limbTotal = limbWeights.reduce((sum, value) => sum + value, 0);
  const limbIndex = (limb: typeof LIMBS[number]) => LIMBS.indexOf(limb);
  /** A grain on a limb curve: its chain, span + position, limb index, and offsets across and in depth (tapered). */
  const onLimb = (i: number, kind: FigureKind, tone: number, spread: number) => {
    const limb = pickFrom(LIMBS, limbWeights, limbTotal);
    const s = next();
    const { segment, u } = limbSpan(limb.lengths, s);
    const taper = limbTaper(s);
    put(i, limb.chain.map(name => ANCHOR[name]) as [number, number, number, number], kind, segment + u, limbIndex(limb), tone,
      s, gaussian() * spread * taper, gaussian() * spread * taper);
  };
  const shares = Object.entries(FIGURE_SHARES).filter(([, share]) => share > 0) as [FigureKind, number][];
  const pickFrom = <T,>(items: readonly T[], weights: readonly number[], total: number) => {
    let r = next() * total;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  };
  const put = (i: number, anchors: [number, number, number, number], kind: FigureKind, s: number, t: number, tone: number,
    along: number, across: number, depth: number) => {
    bind[i * 4] = packAnchors(...anchors, FIGURE_KINDS[kind]);
    bind[i * 4 + 1] = s; bind[i * 4 + 2] = t; bind[i * 4 + 3] = Math.max(0, Math.min(1, tone));
    local[i * 4] = along * S; local[i * 4 + 1] = across * S; local[i * 4 + 2] = depth * S; local[i * 4 + 3] = next() * Math.PI * 2;
  };
  for (let i = 0; i < count; i++) {
    let r = next(), kind: FigureKind = shares[shares.length - 1][0];
    for (const [name, share] of shares) { r -= share; if (r <= 0) { kind = name; break; } }
    switch (kind) {
      case "bone": {
        const [from, to, , tone] = pickFrom(BONES, boneWeights, boneTotal);
        const a = ANCHOR[from], b = ANCHOR[to];
        // Grains run the whole length, joint to joint, so connected bones meet without a gap.
        put(i, [a, b, b, a], kind, next(), 0, tone * (0.86 + next() * 0.2),
          0, gaussian() * figureStroke.width, gaussian() * figureStroke.width);
        break;
      }
      case "ring": {
        // The head: one clean ring of light, the same line weight as the body.
        const angle = next() * Math.PI * 2;
        const radius = R + gaussian() * figureStroke.width;
        put(i, [ANCHOR.neck, ANCHOR.head, ANCHOR.head, ANCHOR.neck], kind, 1, 0, 0.82 + next() * 0.16,
          Math.cos(angle) * radius, Math.sin(angle) * radius, gaussian() * figureStroke.width);
        break;
      }
      case "limb":
        onLimb(i, kind, 0.8 * (0.86 + next() * 0.2), figureStroke.width);
        break;
      case "joint": {
        // A hand's or foot's end: a small, soft, evenly filled disc in the limbs' own light (no bright bead).
        const [name, radius, tone] = pickFrom(TIPS, jointWeights, jointTotal);
        const a = ANCHOR[name];
        const angle = next() * Math.PI * 2, rr = Math.sqrt(next()) * radius;
        put(i, [a, a, a, a], kind, 0, 0, tone * (0.9 + next() * 0.1), Math.cos(angle) * rr, Math.sin(angle) * rr, gaussian() * radius * 0.4);
        break;
      }
      case "aura":
        // A thin, dim glow hugging the limbs (never a cloud around the body).
        onLimb(i, "limb", 0.1 + next() * 0.1, 0.008 + next() * 0.01);
        break;
      case "veil": {
        const across = 0.5 + (next() + next() + next() - 1.5) * 0.4;
        put(i, [ANCHOR.shoulderRight, ANCHOR.shoulderLeft, ANCHOR.hipLeft, ANCHOR.hipRight], kind, across, 0.05 + next() * 0.9,
          0.06, gaussian() * 0.012, gaussian() * 0.012, gaussian() * 0.025);
        break;
      }
      case "halo": {
        const angle = next() * Math.PI * 2, radius = R * (1.45 + next() * 0.9);
        put(i, [ANCHOR.neck, ANCHOR.head, ANCHOR.head, ANCHOR.neck], kind, 1, 0, 0.05 + next() * 0.08,
          Math.cos(angle) * radius, Math.sin(angle) * radius, gaussian() * 0.03);
        break;
      }
      default: {
        const along = Math.max(-1.1, Math.min(1.1, gaussian() * 0.55)), across = Math.max(-0.9, Math.min(0.9, gaussian() * 0.35));
        const s = ANCHOR.spine;
        put(i, [s, s, s, s], kind, 0, 0, 0.006 + 0.06 * Math.pow(next(), 6), along, across, -0.2 - next() * 0.6);
      }
    }
  }
  return { count, bind, local };
}

/** Per-frame figure inputs besides the anchors (the GPU reads the same values from uniforms). */
export interface FigureFrame { clock: number; orbit: number; thinking: number }

/**
 * CPU reference of the GPU figure position (particle/physics/figure.ts evaluates the identical
 * expression). `anchors` are world-space vec4s in ANCHORS order.
 */
export function figurePoint(layout: FigureLayout, index: number, anchors: Float32Array, frame: FigureFrame = { clock: 0, orbit: 0, thinking: 0 }) {
  if (anchors.length < FIGURE_SLOTS * 4) throw new Error("invalid-anchors");
  const b = index * 4;
  const { a, b: ib, c, d, kind } = unpackAnchors(layout.bind[b]);
  const anchor = (k: number) => [anchors[k * 4], anchors[k * 4 + 1], anchors[k * 4 + 2]];
  const [A, B, C, D] = [anchor(a), anchor(ib), anchor(c), anchor(d)];
  const s0 = layout.bind[b + 1], t = layout.bind[b + 2];
  const [lx0, ly0, lz, phase] = [layout.local[b], layout.local[b + 1], layout.local[b + 2], layout.local[b + 3]];
  const s = s0 + Math.sin(frame.clock * figureStroke.flowSpeed + phase) * figureStroke.flow * s0 * (1 - s0) * 4;
  const base = [0, 1, 2].map(k => { const top = A[k] + (B[k] - A[k]) * s, bottom = D[k] + (C[k] - D[k]) * s; return top + (bottom - top) * t; });
  const dx = B[0] - A[0], dy = B[1] - A[1] + 1e-4, dz = B[2] - A[2];
  const length = Math.hypot(dx, dy, dz);
  const dir = [dx / length, dy / length, dz / length], perp = [-dir[1], dir[0], 0];
  const halo = kind === FIGURE_KINDS.halo ? 1 : 0;
  const co = Math.cos(frame.orbit), si = Math.sin(frame.orbit);
  const lx = lx0 + (lx0 * co - ly0 * si - lx0) * halo, ly = ly0 + (lx0 * si + ly0 * co - ly0) * halo;
  const drift = figureStroke.drift + Math.hypot(lx0, ly0) * figureStroke.loose;
  const wobble = [Math.sin(frame.clock * 0.7 + phase), Math.sin(frame.clock * 0.53 + phase * 1.9), Math.sin(frame.clock * 0.61 + phase * 2.7)];
  const position = [0, 1, 2].map(k => base[k] + dir[k] * lx + perp[k] * ly + (k === 2 ? lz : 0) + wobble[k] * drift) as [number, number, number];
  const tone = layout.bind[b + 3] * (1 + halo * frame.thinking * 2.5);
  if (kind === FIGURE_KINDS.limb) return { position: limbPoint(layout, index, anchors, frame.clock, [A, B, C, D]), tone, kind };
  return { position, tone, kind };
}

/** A limb grain's place (v0.4.4): on its limb's curve, offset across it and in depth, plus the limb's secondary motion. */
function limbPoint(layout: FigureLayout, index: number, anchors: Float32Array, clock: number, chain: number[][]): [number, number, number] {
  const b = index * 4;
  const packed = layout.bind[b + 1], limb = Math.round(layout.bind[b + 2]);
  const [s, across, depth, phase] = [layout.local[b] / FIGURE_SCALE, layout.local[b + 1], layout.local[b + 2], layout.local[b + 3]];
  const segment = Math.floor(packed), u0 = packed - segment;
  // A gentle flow along the limb, zero at the anchors, so the curve stays exactly in place.
  const u = u0 + Math.sin(clock * figureStroke.flowSpeed + phase) * figureStroke.flow * u0 * (1 - u0) * 4;
  const { point, tangent } = limbCurve(chain, segment, u);
  const tl = Math.hypot(tangent[0], tangent[1]) + 1e-6;
  const perp = [-tangent[1] / tl, tangent[0] / tl, 0];
  const lag = [0, 1, 2].map(k => anchors[(LIMB_SLOT + limb) * 4 + k]);
  const bow = Math.sin(Math.PI * Math.max(0, Math.min(1, s)));
  const wobble = [Math.sin(clock * 0.7 + phase), Math.sin(clock * 0.53 + phase * 1.9), Math.sin(clock * 0.61 + phase * 2.7)];
  return [0, 1, 2].map(k => point[k] + perp[k] * across + (k === 2 ? depth : 0) + lag[k] * bow + wobble[k] * figureStroke.drift) as [number, number, number];
}
