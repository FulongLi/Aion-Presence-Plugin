/**
 * Aion Eyes as particles: two eyes, each a soft lens of light — a fine bright rim, a faint glassy fill, an iris
 * ring around a dark pupil with a small glint, and a brow that rests on the rim until an expression lifts it out.
 * Procedural (no image), in Aion's silver-white particle language.
 *
 * Each grain is bound to one eye and one component in shape space, where the eye is the superellipse
 * |u|^n + |v|^n ≤ 1. The live shape comes from per-eye parameters (EyeParams, see expression.ts) the animator
 * uploads every frame: the lids clip and squash the shape (a blink is the eye flattening to a line, a smile is
 * its lower edge rising into a crescent), the pupil moves with the gaze, the brow lifts and tilts. The GPU
 * (render/physics/eyes.ts) and this CPU reference (`eyesPoint`) evaluate the identical expression.
 *
 * A binding is two vec4 per particle:
 *   bind  = (kind + 8 × eye, a, b, tone)      eye 0 is on the viewer's left, 1 on the right
 *   local = (depth jitter, phase, 0, 0)
 *   rim:   a = angle on the contour, b = offset across it (shape units)
 *   fill:  a, b = u, v inside the shape
 *   iris:  a = angle, b = radius as a share of the iris radius
 *   glint: a, b = offset from the pupil centre (shares of the iris radius)
 *   brow:  a = position along the brow (−1…1), b = offset across it
 */
export const EYE_KINDS = { rim: 0, fill: 1, iris: 2, glint: 3, brow: 4 } as const;
export type EyeKind = keyof typeof EYE_KINDS;

/** Share of all particles per component (summing to 1); the iris carries the gaze, so it gets the most. */
export const EYE_SHARES: Record<EyeKind, number> = { rim: 0.27, fill: 0.11, iris: 0.44, glint: 0.06, brow: 0.12 };

/** The eye shape and the iris. World units, except `n` (superellipse exponent) and `pupil` (share of the iris). */
export const EYE_GEOMETRY = {
  /** 2 is an ellipse; a little more gives the lens a calm, slightly squared softness. */
  n: 2.6,
  /** Centre of each eye from the middle, and height of the eye line. */
  spacing: 0.66,
  centreY: 0.06,
  halfWidth: 0.43,
  halfHeight: 0.56,
  /** Iris radius (world) at rest; the pupil is the dark inner share of it. */
  iris: 0.2,
  pupil: 0.42,
  /** The rim's cross-section (shape units) and the brow's. */
  rimWidth: 0.012,
  browWidth: 0.02,
  /** How far the lens bulges toward the viewer at its centre. */
  bulge: 0.12,
};

export interface EyesLayout { count: number; bind: Float32Array; local: Float32Array }

const random = (initial: number) => { let seed = initial; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };

/** The superellipse contour point at angle `t` (shape units). */
export function contour(t: number, n = EYE_GEOMETRY.n): [number, number] {
  const c = Math.cos(t), s = Math.sin(t);
  return [Math.sign(c) * Math.pow(Math.abs(c), 2 / n), Math.sign(s) * Math.pow(Math.abs(s), 2 / n)];
}

export function createEyesLayout(count: number, seed = 0x0e1e5): EyesLayout {
  const bind = new Float32Array(count * 4), local = new Float32Array(count * 4);
  const next = random(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const shares = Object.entries(EYE_SHARES) as [EyeKind, number][];
  const { n } = EYE_GEOMETRY;
  // Arc-length weighting along the contour, so the rim is evenly dense where it curves and where it runs straight.
  const steps = 256, arc: number[] = [0];
  for (let i = 1; i <= steps; i++) {
    const [x0, y0] = contour(((i - 1) / steps) * Math.PI * 2), [x1, y1] = contour((i / steps) * Math.PI * 2);
    arc.push(arc[i - 1] + Math.hypot((x1 - x0) * EYE_GEOMETRY.halfWidth, (y1 - y0) * EYE_GEOMETRY.halfHeight));
  }
  const angleAt = (share: number) => {
    const goal = share * arc[steps];
    let i = 1; while (i < steps && arc[i] < goal) i++;
    const f = (goal - arc[i - 1]) / Math.max(1e-9, arc[i] - arc[i - 1]);
    return ((i - 1 + f) / steps) * Math.PI * 2;
  };
  for (let i = 0; i < count; i++) {
    let r = next(), kind: EyeKind = "iris";
    for (const [name, share] of shares) { r -= share; if (r <= 0) { kind = name; break; } }
    const eye = next() < 0.5 ? 0 : 1;
    let a = 0, b = 0, tone = 1;
    switch (kind) {
      case "rim": a = angleAt(next()); b = gaussian() * EYE_GEOMETRY.rimWidth; tone = 0.78 + next() * 0.18; break;
      case "fill": {
        // Uniform inside the superellipse (rejection), faint, a little denser toward the middle.
        let u = 0, v = 0;
        do { u = next() * 2 - 1; v = next() * 2 - 1; } while (Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), n) > 0.9 || next() > 1 - 0.4 * Math.hypot(u, v));
        a = u; b = v; tone = 0.1 + next() * 0.1; break;
      }
      case "iris": {
        // An annulus from the pupil's edge to the iris rim, densest at both edges (a crisp ring), with fine radial texture.
        const edge = next();
        const radius = edge < 0.32 ? 1 + gaussian() * 0.025 : edge < 0.5 ? EYE_GEOMETRY.pupil + Math.abs(gaussian()) * 0.03 : EYE_GEOMETRY.pupil + next() * (1 - EYE_GEOMETRY.pupil);
        a = next() * Math.PI * 2; b = Math.max(EYE_GEOMETRY.pupil, Math.min(1.05, radius));
        tone = edge < 0.32 ? 0.95 : edge < 0.5 ? 0.85 : 0.5 + 0.3 * Math.pow(Math.sin(a * 9 + i), 2);
        break;
      }
      case "glint": {
        // The spark of life: a bright point up and to the left in the pupil, and a smaller one opposite.
        const main = next() < 0.78;
        const spread = main ? 0.09 : 0.05;
        a = (main ? -0.28 : 0.2) + gaussian() * spread; b = (main ? 0.3 : -0.22) + gaussian() * spread; tone = 1; break;
      }
      case "brow": a = next() * 2 - 1; b = gaussian() * EYE_GEOMETRY.browWidth; tone = 0.62 + next() * 0.2; break;
    }
    bind[i * 4] = EYE_KINDS[kind] + 8 * eye; bind[i * 4 + 1] = a; bind[i * 4 + 2] = b; bind[i * 4 + 3] = Math.max(0, Math.min(1, tone));
    local[i * 4] = gaussian() * 0.01; local[i * 4 + 1] = next() * Math.PI * 2;
  }
  return { count, bind, local };
}

/**
 * The live parameters of the two eyes, 16 floats per eye (uploaded as four vec4 each; see expression.ts for how
 * they are chosen):
 *   0 centre x, 1 centre y, 2 half width, 3 half height      (world)
 *   4 upper lid closure, 5 lower lid closure, 6 upper lid slope across the eye, 7 lower lid curve (a smile)
 *   8 gaze u, 9 gaze v (shape units), 10 iris radius (world), 11 glint
 *   12 brow lift (0: resting on the rim), 13 brow slope, 14 brow arch, 15 brow amount (0…1, out of the rim)
 */
export const EYE_PARAMS = 16;

const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Where the lids leave the eye at horizontal position `u`: the visible band [bottom, top] in shape units. The upper
 * lid comes down (and slopes), the lower lid comes up (and curves up in the middle for a smile); they never cross.
 */
export function lidBand(u: number, p: ArrayLike<number>, o: number, n = EYE_GEOMETRY.n): [number, number, number] {
  const vmax = Math.max(0.05, Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(u)), n)), 1 / n));
  const top = Math.min(vmax, 1 - 2 * p[o + 4] - p[o + 6] * u);
  const bottom = Math.min(Math.max(-vmax, -1 + 2 * p[o + 5] + p[o + 7] * (1 - u * u)), top - 0.05);
  return [vmax, Math.max(top, -vmax + 0.05), bottom];
}

/**
 * CPU reference of the GPU eyes position (render/physics/eyes.ts evaluates the identical expression). `params` are
 * EYE_PARAMS × 2 floats; `clock` gives the iris its slow shimmer.
 */
export function eyesPoint(layout: EyesLayout, index: number, params: ArrayLike<number>, clock = 0): { position: [number, number, number]; tone: number; kind: number; eye: number } {
  if (params.length < EYE_PARAMS * 2) throw new Error("invalid-eye-params");
  const i = index * 4;
  const packed = Math.round(layout.bind[i]);
  const kind = packed % 8, eye = Math.floor(packed / 8) % 2;
  const a = layout.bind[i + 1], b = layout.bind[i + 2], tone = layout.bind[i + 3];
  const jitter = layout.local[i], phase = layout.local[i + 1];
  const o = eye * EYE_PARAMS, p = params;
  const [cx, cy, hw, hh] = [p[o], p[o + 1], p[o + 2], p[o + 3]];
  const { n } = EYE_GEOMETRY;
  const brow = kind === EYE_KINDS.brow, round = kind === EYE_KINDS.iris || kind === EYE_KINDS.glint;
  // The point in shape space before the lids. A brow's is where it rests, on the top of the rim.
  let u: number, v: number;
  if (kind === EYE_KINDS.rim || brow) {
    const [cu, cv] = contour(brow ? Math.PI / 2 - a * 0.95 : a, n);
    u = cu * (1 + (brow ? 0 : b)); v = cv * (1 + (brow ? b * 0.4 : b));
  } else if (round) {
    const radius = p[o + 10];
    const shimmer = kind === EYE_KINDS.iris ? 1 + Math.sin(clock * 1.3 + phase) * 0.01 : 1;
    const ox = kind === EYE_KINDS.iris ? Math.cos(a) * b * shimmer : a, oy = kind === EYE_KINDS.iris ? Math.sin(a) * b * shimmer : b;
    u = p[o + 8] + ox * radius / hw; v = p[o + 9] + oy * radius / hh;
    // Kept inside the lens: a grain past the edge is drawn back onto it.
    const reach = Math.pow(Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), n), 1 / n);
    if (reach > 0.94) { u *= 0.94 / reach; v *= 0.94 / reach; }
  } else {
    u = a; v = b;
  }
  const [vmax, top, bottom] = lidBand(u, p, o, n);
  const squash = bottom + (Math.max(-vmax, Math.min(vmax, v)) + vmax) / (2 * vmax) * (top - bottom);
  // A rim grain on the lid line glows a little more as the eye closes (the lid is the line you see).
  const closed = 1 - smoothstep(0.1, 0.7, (top - bottom) / (2 * vmax));
  const bulge = EYE_GEOMETRY.bulge * Math.max(0, 1 - u * u - squash * squash);
  const depth = kind === EYE_KINDS.glint ? 0.05 : kind === EYE_KINDS.iris ? 0.03 : 0;
  let x = cx + u * hw, y = cy + squash * hh, z = bulge + depth + jitter;
  let light = kind === EYE_KINDS.glint ? tone * p[o + 11] : kind === EYE_KINDS.rim ? tone * (1 + closed * 0.25) : tone;
  if (brow) {
    // Lifted out of the rim into an arc above the eye (not clipped by the lids), by `amount`.
    const amount = smoothstep(0, 1, p[o + 15]);
    const liftV = 1.2 + p[o + 12] + p[o + 14] * (1 - a * a) * 0.25 - p[o + 13] * a + b;
    x += (cx + a * 0.82 * hw - x) * amount; y += (cy + liftV * hh - y) * amount; z += (EYE_GEOMETRY.bulge * 0.3 + jitter - z) * amount;
    light = tone * (0.55 + 0.45 * amount);
  }
  return { position: [x, y, z], tone: Math.min(1, light), kind, eye };
}
