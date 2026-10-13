/**
 * Aion Eyes as particles (v0.4.1, the cartoon design): two simple, luminous shapes — no iris, no pupil, no glint, no
 * brow. Each eye is one soft rounded form filled with silver-white grains and drawn with a crisp bright edge, and it
 * expresses everything by its outline: how wide and tall it is, how round, where the lids cut it, how far it bends
 * into an arc (a happy "^", a sleepy "‿"), and how it tilts. Procedural (no image), in Aion's particle language.
 *
 * Every grain is bound to one eye and one place in the eye's polar shape space: a direction φ and a radius r, as a
 * share of the distance from the centre to the superellipse |u|^n + |v|^n = 1 in that direction (r ≈ 1 on the edge,
 * 0…1 inside). Because the fill is bound by direction and share rather than by position, it stays inside the outline
 * whatever the roundness, its density changes only smoothly as the shape deforms, and every particle keeps its
 * place: one continuous body, never grains popping in or out. The live shape comes
 * from per-eye parameters the animator uploads each frame (EyeParams, see expression.ts). The GPU
 * (render/physics/eyes.ts) and this CPU reference (`eyesPoint`) evaluate the identical expression.
 *
 * A binding is two vec4 per particle:
 *   bind  = (kind + 8 × eye, φ, r, tone)      eye 0 is on the viewer's left, 1 on the right
 *   local = (depth jitter, phase, 0, 0)
 */
export const EYE_KINDS = { edge: 0, fill: 1 } as const;
export type EyeKind = keyof typeof EYE_KINDS;

/** Share of all particles per component (summing to 1): a crisp outline and a solid, glowing body. */
export const EYE_SHARES: Record<EyeKind, number> = { edge: 0.3, fill: 0.7 };

/** The eyes at rest. World units, except `n` (superellipse exponent) and the radii (shares of the outline). */
export const EYE_GEOMETRY = {
  /** 2 is an ellipse, 4 a rounded square: a little above 3 is the friendly rounded-rectangle of animated robot eyes. */
  n: 3.2,
  /** Centre of each eye from the middle, and height of the eye line. */
  spacing: 0.64,
  centreY: 0.05,
  halfWidth: 0.33,
  halfHeight: 0.5,
  /** The edge's cross-section (shape units). */
  edgeWidth: 0.014,
  /** The fill stops just inside the edge, so the outline reads as a line. */
  fillRadius: 0.955,
  /** A shallow bulge toward the viewer (the eyes are graphic, not eyeballs). */
  depth: 0.05,
  /** Grain size relative to the sphere's: a fine edge, and fill grains large enough to read as one luminous body. */
  edgeGrain: 0.72,
  fillGrain: 1.18,
};

export interface EyesLayout { count: number; bind: Float32Array; local: Float32Array }

const random = (initial: number) => { let seed = initial; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };

/** Distance from the centre to the superellipse of exponent `n` in direction `phi` (shape units). */
export const reach = (phi: number, n = EYE_GEOMETRY.n) => Math.pow(Math.pow(Math.abs(Math.cos(phi)), n) + Math.pow(Math.abs(Math.sin(phi)), n), -1 / n);

/** The superellipse contour point in direction `phi` (shape units). */
export function contour(phi: number, n = EYE_GEOMETRY.n): [number, number] {
  const r = reach(phi, n);
  return [Math.cos(phi) * r, Math.sin(phi) * r];
}

/** Inverse-CDF sampling over a tabulated weight on [0, 2π). */
function sampler(weight: (t: number) => number, steps = 512) {
  const cdf = [0];
  for (let i = 1; i <= steps; i++) cdf.push(cdf[i - 1] + weight(((i - 0.5) / steps) * Math.PI * 2));
  return (share: number) => {
    const goal = share * cdf[steps];
    let lo = 1, hi = steps;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < goal) lo = mid + 1; else hi = mid; }
    const f = (goal - cdf[lo - 1]) / Math.max(1e-12, cdf[lo] - cdf[lo - 1]);
    return ((lo - 1 + f) / steps) * Math.PI * 2;
  };
}

export function createEyesLayout(count: number, seed = 0x0e1e5): EyesLayout {
  const bind = new Float32Array(count * 4), local = new Float32Array(count * 4);
  const next = random(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const { n, halfWidth: w, halfHeight: h } = EYE_GEOMETRY;
  const step = 1e-3;
  // The edge is evenly dense along its length; the fill evenly dense over its area (a sector's area grows with the
  // square of its reach), both measured on the eye at rest.
  const edgeAngle = sampler(t => {
    const [x0, y0] = contour(t - step, n), [x1, y1] = contour(t + step, n);
    return Math.hypot((x1 - x0) * w, (y1 - y0) * h);
  });
  const fillAngle = sampler(t => reach(t, n) ** 2);
  for (let i = 0; i < count; i++) {
    const kind: EyeKind = next() < EYE_SHARES.edge ? "edge" : "fill";
    const eye = next() < 0.5 ? 0 : 1;
    let angle: number, radius: number, tone: number;
    if (kind === "edge") {
      angle = edgeAngle(next()); radius = 1 + gaussian() * EYE_GEOMETRY.edgeWidth; tone = 0.86 + next() * 0.14;
    } else {
      // Uniform over the area: r = √U. A faint gradient keeps the body solid but lets the edge lead.
      angle = fillAngle(next()); radius = Math.sqrt(next()) * EYE_GEOMETRY.fillRadius; tone = 0.48 + 0.14 * radius + next() * 0.22;
    }
    bind[i * 4] = EYE_KINDS[kind] + 8 * eye; bind[i * 4 + 1] = angle; bind[i * 4 + 2] = radius; bind[i * 4 + 3] = Math.max(0, Math.min(1, tone));
    local[i * 4] = gaussian() * 0.006; local[i * 4 + 1] = next() * Math.PI * 2;
  }
  return { count, bind, local };
}

/**
 * The live parameters of the two eyes, 16 floats per eye (uploaded as four vec4 each; expression.ts chooses them):
 *   0 centre x, 1 centre y, 2 half width, 3 half height                                   (world)
 *   4 upper lid closure, 5 lower lid closure (0 open … 0.5 meeting in the middle), 6 upper lid slope across the
 *     eye (signed in u), 7 lower lid curve (the middle rising: a cheek pushing up)
 *   8 roundness n, 9 bend (world: the middle lifts by this much, the ends stay — an arc), 10 tilt (radians),
 *   11 brightness
 *   12 edge light, 13 fill light, 14 shimmer (0…1, the grains' own slow life), 15 reserved
 */
export const EYE_PARAMS = 16;

const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Where the lids leave the eye at horizontal position `u`: the visible band [bottom, top] in shape units, within the
 * eye's own height ±vmax there (at least |v|, so the edge's own width is never clamped). The upper lid comes down
 * (and slopes), the lower lid comes up (and rises in the middle); they never cross. With both lids open the band is
 * the whole height and the shape is unchanged.
 */
export function lidBand(u: number, p: ArrayLike<number>, o: number, v = 0): [number, number, number] {
  const n = Math.max(1.6, p[o + 8]);
  const vmax = Math.max(0.05, Math.abs(v), Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(u)), n)), 1 / n));
  const top = Math.min(vmax, 1 - 2 * p[o + 4] - p[o + 6] * u);
  const bottom = Math.min(Math.max(-vmax, -1 + 2 * p[o + 5] + p[o + 7] * (1 - u * u)), top - 0.05);
  return [vmax, Math.max(top, -vmax + 0.05), bottom];
}

/**
 * CPU reference of the GPU eyes position (render/physics/eyes.ts evaluates the identical expression). `params` are
 * EYE_PARAMS × 2 floats; `clock` gives the grains their slow shimmer.
 */
export function eyesPoint(layout: EyesLayout, index: number, params: ArrayLike<number>, clock = 0): { position: [number, number, number]; tone: number; kind: number; eye: number; grain: number } {
  if (params.length < EYE_PARAMS * 2) throw new Error("invalid-eye-params");
  const i = index * 4;
  const packed = Math.round(layout.bind[i]);
  const kind = packed % 8, eye = Math.floor(packed / 8) % 2;
  const angle = layout.bind[i + 1], radius = layout.bind[i + 2], tone = layout.bind[i + 3];
  const jitter = layout.local[i], phase = layout.local[i + 1];
  const o = eye * EYE_PARAMS, p = params;
  const [cx, cy, hw, hh] = [p[o], p[o + 1], p[o + 2], p[o + 3]];
  const n = Math.max(1.6, p[o + 8]), bend = p[o + 9], tilt = p[o + 10];
  const edge = kind === EYE_KINDS.edge;
  // The point in shape space, a fill grain breathing very slightly in place.
  const [cu, cv] = contour(angle, n);
  const r = radius * (edge ? 1 : 1 + Math.sin(clock * 1.1 + phase) * 0.012 * p[o + 14]);
  const u = cu * r, v = cv * r;
  // The lids: the visible band at u, and the shape squashed into it.
  const [vmax, top, bottom] = lidBand(u, p, o, v);
  const squash = bottom + (v + vmax) / (2 * vmax) * (top - bottom);
  // An edge grain on a lid line glows a little more as the eye closes (the lid is the line you see).
  const closed = 1 - smoothstep(0.15, 0.75, (top - bottom) / (2 * vmax));
  // Into the world: sized, bent into an arc (the ends stay, the middle lifts), tilted about the eye's centre.
  const lx = u * hw, ly = squash * hh + bend * (1 - Math.min(1, u * u));
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const x = cx + lx * c - ly * s, y = cy + lx * s + ly * c;
  const z = EYE_GEOMETRY.depth * Math.max(0, 1 - u * u - squash * squash) + jitter;
  // The fill is lit a little from above (friendly, not glassy); the edge glows a little more as the lids close.
  const light = tone * p[o + 11] * (edge ? p[o + 12] * (1 + closed * 0.2) : p[o + 13] * (0.93 + v * 0.09));
  return { position: [x, y, z], tone: Math.max(0, Math.min(1, light)), kind, eye, grain: edge ? EYE_GEOMETRY.edgeGrain : EYE_GEOMETRY.fillGrain };
}
