/**
 * The heritage oval: a vertical ellipse inscribed in a 3:4 frame, as in Victorian oval portraits, pocket-watch
 * portraits and photographic lockets. Pure geometry in a normalized frame (x, y in [-1, 1], y up), so the
 * particle sampler, the card and the tests share one definition.
 */
export const HERITAGE_OVAL = {
  /** Frame width / height. */
  aspect: 3 / 4,
  /** The photograph fades over this share of the radius, ending exactly on the outline. */
  feather: 0.13,
  /** Share of the portrait's particles that draw the silver outline. */
  outline: 0.1,
  /** Of the outline, the share on a faint second ring just outside it (a locket's bevel). */
  bevel: 0.22,
  /** Radius of that second ring (1 is the outline). */
  bevelRadius: 1.035,
} as const;

/** Elliptical radius of a point in the normalized frame: 0 at the centre, 1 on the oval. */
export const ovalRadius = (x: number, y: number) => Math.hypot(x, y);

/**
 * How much of the photograph stays at a point: 1 well inside, easing to 0 on the oval (smoothstep over the
 * last `feather` of the radius), 0 outside. Never cuts hard, so the edge reads as particles thinning out.
 */
export function ovalMask(x: number, y: number, feather: number = HERITAGE_OVAL.feather): number {
  const r = ovalRadius(x, y);
  if (r >= 1) return 0;
  const t = Math.max(0, Math.min(1, (1 - r) / Math.max(1e-3, feather)));
  return t * t * (3 - 2 * t);
}

/** The point at angle `t` (radians, anticlockwise from the right) on the oval of elliptical radius `r`. */
export const ovalPoint = (t: number, r = 1): [number, number] => [Math.cos(t) * r, Math.sin(t) * r];
