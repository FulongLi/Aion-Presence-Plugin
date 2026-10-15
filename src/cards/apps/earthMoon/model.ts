/**
 * The Earth–Moon motion model (v0.4.5). Pure: the card draws it, the tests check it.
 *
 * A simplified, clearly approximate model — not an ephemeris:
 *   - circular lunar orbit at the mean distance, inclined 5.145° to the ecliptic, with a fixed line of nodes
 *     (the real orbit is elliptical, e ≈ 0.055, and its nodes precess every 18.6 years);
 *   - Earth turns once per sidereal day about an axis tilted 23.44°, fixed in space (precession ignored);
 *   - the Moon turns once per sidereal month about the normal of its orbit (synchronous rotation; libration and the
 *     Moon's own 1.54° axial tilt are ignored), so the same hemisphere always faces Earth;
 *   - sunlight comes from a direction that turns once a sidereal year.
 *
 * Simulation time is in days and independent of the display scale: `educational` compresses the distance so both bodies
 * are visible (sizes stay in true proportion), `true-distance` uses the real distance in Earth radii.
 *
 * Frame: y is ecliptic north; angles increase counter-clockwise seen from the north (x toward −z), which is the sense of
 * Earth's rotation and of the Moon's orbit. Lengths are in Earth radii.
 */
export const ASTRONOMY = {
  earthDiameterKm: 12_742,
  moonDiameterKm: 3_474.8,
  earthMoonDistanceKm: 384_400,
  siderealMonthDays: 27.321661,
  synodicMonthDays: 29.530589,
  siderealDayHours: 23.9345,
  siderealYearDays: 365.25636,
  earthAxialTiltDegrees: 23.44,
  lunarInclinationDegrees: 5.145,
} as const;

export const EARTH_RADIUS = 1;
export const MOON_RADIUS = ASTRONOMY.moonDiameterKm / ASTRONOMY.earthDiameterKm; // 0.2727 Earth radii
export const TRUE_DISTANCE = ASTRONOMY.earthMoonDistanceKm / (ASTRONOMY.earthDiameterKm / 2); // 60.34 Earth radii
export const EDUCATIONAL_DISTANCE = 12;

export type DisplayScale = "educational" | "true-distance";
export const distanceFor = (scale: DisplayScale) => scale === "true-distance" ? TRUE_DISTANCE : EDUCATIONAL_DISTANCE;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const wrap = (radians: number) => ((radians % TAU) + TAU) % TAU;

/** The Moon's angle along its orbit (radians, from the ascending node), `day` days after the start. */
export const orbitAngle = (day: number) => wrap(TAU * day / ASTRONOMY.siderealMonthDays);
/** Earth's rotation angle (radians) about its axis. */
export const earthRotation = (day: number) => wrap(TAU * day * 24 / ASTRONOMY.siderealDayHours);
/**
 * The Moon's rotation angle (radians) about its orbit normal. Synchronous: its near side (local +x) points at Earth,
 * i.e. half a turn from its direction along the orbit. `rotating: false` is the hypothetical Moon that does not turn.
 */
export const moonRotation = (day: number, rotating = true) => wrap((rotating ? orbitAngle(day) : 0) + Math.PI);
/** The direction sunlight comes from (radians in the ecliptic plane). */
export const sunAngle = (day: number) => wrap(TAU * day / ASTRONOMY.siderealYearDays);

export type Vec3 = [number, number, number];

/** The Moon's position (Earth at the origin) for a display distance. */
export function moonPosition(day: number, distance: number): Vec3 {
  const a = orbitAngle(day), i = ASTRONOMY.lunarInclinationDegrees * DEG;
  // In the orbit's plane, then tilted about the line of nodes (the x axis).
  const x = distance * Math.cos(a), z = -distance * Math.sin(a);
  return [x, -z * Math.sin(i), z * Math.cos(i)];
}

/** The unit normal of the Moon's orbital plane. */
export function orbitNormal(): Vec3 {
  const i = ASTRONOMY.lunarInclinationDegrees * DEG;
  return [0, Math.cos(i), Math.sin(i)];
}

/** Earth's rotation axis (unit vector, north). */
export function earthAxis(): Vec3 {
  const t = ASTRONOMY.earthAxialTiltDegrees * DEG;
  return [Math.sin(t), Math.cos(t), 0];
}

/** Where the Moon's near-side marker (local +x after its rotation) points, as a unit vector in the orbital plane. */
export function nearSideDirection(day: number, rotating = true): Vec3 {
  const r = moonRotation(day, rotating), i = ASTRONOMY.lunarInclinationDegrees * DEG;
  const x = Math.cos(r), z = -Math.sin(r);
  return [x, -Math.sin(i) * z, z * Math.cos(i)];
}

/** Whether the near side faces Earth (within `toleranceDegrees`). */
export function nearSideFacesEarth(day: number, rotating = true, toleranceDegrees = 1): boolean {
  const p = moonPosition(day, 1), n = nearSideDirection(day, rotating);
  const toEarth = p.map(v => -v) as Vec3;
  const length = Math.hypot(...toEarth);
  const cos = (toEarth[0] * n[0] + toEarth[1] * n[1] + toEarth[2] * n[2]) / length;
  return cos >= Math.cos(toleranceDegrees * DEG);
}

/** Degrees, 0…360, for state reports. */
export const degrees = (radians: number) => Math.round(wrap(radians) / DEG * 10) / 10 % 360;

/** The facts the card shows when Earth or the Moon is selected (approximate, documented values). */
export const BODY_FACTS = {
  earth: {
    name: "Earth", kind: "Planet",
    properties: {
      "Diameter": "≈ 12,742 km",
      "Rotation period": "≈ 23.93 h (sidereal day)",
      "Axial tilt": "≈ 23.44°",
      "Distance to the Moon": "≈ 384,400 km (mean)",
    },
  },
  moon: {
    name: "Moon", kind: "Natural satellite",
    properties: {
      "Diameter": "≈ 3,475 km",
      "Orbital period": "≈ 27.32 days (sidereal)",
      "Rotation period": "≈ 27.32 days (synchronous)",
      "Orbital inclination": "≈ 5.14° to the ecliptic",
      "Mean distance": "≈ 384,400 km",
    },
  },
} as const;
