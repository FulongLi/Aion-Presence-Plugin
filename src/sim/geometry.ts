/**
 * v0.8 Simulation Core: the analysis geometry and how boundary regions are found on it.
 *
 * The CAD backend (FreeCAD) reports the geometry a study analyses: its solids (each from a CAD body) and every face of
 * the conformal analysis shape, numbered as the mesher will number them (OpenCASCADE's order, verified after meshing),
 * with the feature that produced it, its surface type, area, centroid and (for planes) outward normal, plus a
 * tessellation for picking. Lengths are the CAD document's millimetres.
 *
 * A boundary condition never stores "face 6" on its own: it stores a *selector* — how the user identified the region
 * ("the left end of the busbar", "the walls of Hole2", "the face I clicked") — and the faces it resolved to, with their
 * geometric signatures. When the geometry changes, semantic selectors are resolved again (the left end is still the left
 * end) and the changes reported; a face picked by number or by a point must still match its signature, or the assignment
 * is reported as stale and is not applied (never silently moved to a different face).
 */
export type Vec3 = [number, number, number];
export interface Box { min: Vec3; max: Vec3 }

export const SIDES = ["left", "right", "front", "back", "bottom", "top"] as const;
export type Side = typeof SIDES[number];
/** The outward direction of each side (FreeCAD's axes, Z up): left −X, right +X, front −Y, back +Y, bottom −Z, top +Z. */
export const SIDE_NORMAL: Record<Side, Vec3> = { left: [-1, 0, 0], right: [1, 0, 0], front: [0, -1, 0], back: [0, 1, 0], bottom: [0, 0, -1], top: [0, 0, 1] };

export const SURFACE_TYPES = ["plane", "cylinder", "cone", "sphere", "torus", "bspline", "other"] as const;
export type SurfaceType = typeof SURFACE_TYPES[number];

export interface SimSolid { index: number; body: string; bodyLabel: string; volume_mm3: number; bbox: Box; center: Vec3 }
export interface SimFace {
  index: number;
  /** The solids this face bounds: one for an exterior face, two for an interface between solids. */
  solids: number[];
  body: string;
  bodyLabel: string;
  /** The CAD feature that produced the face (a primitive, a hole, a pocket, a fillet…), by its CAD id. */
  feature: string;
  featureLabel: string;
  surface: SurfaceType;
  area_mm2: number;
  center: Vec3;
  /** Planar faces: the unit normal pointing out of solids[0]. */
  normal?: Vec3;
  /** Cylinders, cones: the axis direction and radius. */
  axis?: Vec3;
  radius?: number;
  bbox: Box;
}
export interface SimBody { id: string; label: string; solids: number[]; bbox: Box }

export interface SimGeometry {
  format: "aion.sim.geometry/1";
  backend: string;
  document: string;
  documentName: string;
  revision: number;
  units: "mm";
  bodies: SimBody[];
  solids: SimSolid[];
  faces: SimFace[];
  bbox: Box;
  /** Surface triangles for picking and the setup view: per face, positions (mm) and indices. */
  surface?: { faces: { index: number; positions: number[]; indices: number[] }[] };
}

export type FaceSelector =
  | { side: Side; body?: string }
  | { facing: Side; body?: string }
  | { feature: string }
  | { faces: number[] }
  | { at: Vec3; body?: string }
  | { exterior: true; body?: string }
  | { remaining: true; body?: string };

export interface FaceSignature { index: number; surface: SurfaceType; area_mm2: number; center: Vec3; normal?: Vec3 }

export const isExterior = (face: SimFace) => face.solids.length === 1;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const diagonal = (box: Box) => len(sub(box.max, box.min));

/** The direction a planar face faces, if it is within 5° of an axis. */
export function facingOf(face: SimFace): Side | null {
  if (face.surface !== "plane" || !face.normal) return null;
  for (const side of SIDES) if (dot(face.normal, SIDE_NORMAL[side]) > Math.cos(5 * Math.PI / 180)) return side;
  return null;
}

/** Solids a body reference names: a CAD id or label (case-insensitive), or "S3" for solid 3. */
export function resolveBody(geometry: SimGeometry, ref: string): { ok: true; solids: number[]; label: string } | { ok: false; problem: string } {
  const key = ref.trim().toLowerCase();
  const solid = /^s(\d+)$/.exec(key);
  if (solid) {
    const s = geometry.solids.find(x => x.index === Number(solid[1]));
    return s ? { ok: true, solids: [s.index], label: `${s.bodyLabel} (solid ${s.index})` } : { ok: false, problem: `there is no solid ${ref} (solids 1–${geometry.solids.length})` };
  }
  const body = geometry.bodies.find(b => b.id.toLowerCase() === key) ?? geometry.bodies.find(b => b.label.toLowerCase() === key);
  if (body) return { ok: true, solids: body.solids, label: body.label };
  return { ok: false, problem: `no body "${ref}" in the analysis (bodies: ${geometry.bodies.map(b => b.label === b.id ? b.id : `${b.label} (${b.id})`).join(", ")})` };
}

export type Resolution = { ok: true; faces: number[]; note?: string } | { ok: false; problem: string };

/**
 * The faces a selector names. `taken` (for `remaining`) are faces already used by other boundaries of the same physics.
 * Only exterior faces can carry a boundary condition; an interface between two solids is internal.
 */
export function resolveSelector(geometry: SimGeometry, selector: FaceSelector, taken: Set<number> = new Set()): Resolution {
  let solids: Set<number> | null = null;
  if ("body" in selector && selector.body) {
    const body = resolveBody(geometry, selector.body);
    if (!body.ok) return body;
    solids = new Set(body.solids);
  }
  const inScope = (face: SimFace) => isExterior(face) && (!solids || face.solids.some(s => solids!.has(s)));
  const extent = (box: Box) => box;
  if ("side" in selector || "facing" in selector) {
    const side = "side" in selector ? selector.side : selector.facing;
    const candidates = geometry.faces.filter(face => inScope(face) && facingOf(face) === side);
    if (!candidates.length) return { ok: false, problem: `no flat exterior face faces ${side}${"body" in selector && selector.body ? ` on ${selector.body}` : ""}` };
    if ("facing" in selector) return { ok: true, faces: candidates.map(f => f.index) };
    // `side`: only the outermost faces in that direction (the end of a bar, not a step part-way along it).
    const n = SIDE_NORMAL[side];
    const box = solids ? boundsOf(geometry.solids.filter(s => solids!.has(s.index)).map(s => s.bbox)) : extent(geometry.bbox);
    const extreme = Math.max(...[box.min, box.max].map(p => dot(p, n)));
    const tol = Math.max(1e-3, diagonal(box) * 1e-4);
    const faces = candidates.filter(f => Math.abs(dot(f.center, n) - extreme) <= tol);
    if (!faces.length) {
      return { ok: false, problem: `no flat face lies at the ${side} extreme${"body" in selector && selector.body ? ` of ${selector.body}` : ""}; the faces facing ${side} are ${describeFaces(geometry, candidates.map(f => f.index))} (use facing or faces)` };
    }
    return { ok: true, faces: faces.map(f => f.index) };
  }
  if ("feature" in selector) {
    const key = selector.feature.trim().toLowerCase();
    const faces = geometry.faces.filter(f => isExterior(f) && (f.feature.toLowerCase() === key || f.featureLabel.toLowerCase() === key));
    if (!faces.length) {
      const features = [...new Set(geometry.faces.map(f => f.featureLabel === f.feature ? f.feature : `${f.featureLabel} (${f.feature})`))];
      return { ok: false, problem: `no exterior faces from a feature "${selector.feature}" (features: ${features.slice(0, 20).join(", ")})` };
    }
    return { ok: true, faces: faces.map(f => f.index) };
  }
  if ("faces" in selector) {
    const missing = selector.faces.filter(i => !geometry.faces.some(f => f.index === i));
    if (missing.length) return { ok: false, problem: `there is no face ${missing.join(", ")} (faces 1–${geometry.faces.length})` };
    const internal = selector.faces.filter(i => !isExterior(geometry.faces.find(f => f.index === i)!));
    if (internal.length) return { ok: false, problem: `face ${internal.join(", ")} is an interface between two solids (internal), so it cannot carry a boundary condition` };
    return { ok: true, faces: [...new Set(selector.faces)].sort((a, b) => a - b) };
  }
  if ("at" in selector) return nearestFace(geometry, selector.at, solids);
  if ("exterior" in selector || "remaining" in selector) {
    const faces = geometry.faces.filter(f => inScope(f) && !taken.has(f.index)).map(f => f.index);
    return faces.length ? { ok: true, faces } : { ok: false, problem: "every exterior face already has a condition of this kind" };
  }
  return { ok: false, problem: "unknown face selector" };
}

function boundsOf(boxes: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
  return { min, max };
}

/** The face nearest a point (mm), by distance to its triangles; refused when two faces are about equally near (an edge). */
export function nearestFace(geometry: SimGeometry, point: Vec3, solids: Set<number> | null = null): Resolution {
  if (!geometry.surface) return { ok: false, problem: "the geometry has no surface tessellation to find a face at a point" };
  const scores: { index: number; d: number }[] = [];
  for (const face of geometry.surface.faces) {
    const meta = geometry.faces.find(f => f.index === face.index);
    if (!meta || !isExterior(meta) || (solids && !meta.solids.some(s => solids.has(s)))) continue;
    let best = Infinity;
    for (let t = 0; t + 2 < face.indices.length; t += 3) {
      const tri = [0, 1, 2].map(k => face.indices[t + k] * 3).map(i => [face.positions[i], face.positions[i + 1], face.positions[i + 2]] as Vec3);
      best = Math.min(best, pointTriangleDistance(point, tri[0], tri[1], tri[2]));
    }
    scores.push({ index: face.index, d: best });
  }
  scores.sort((a, b) => a.d - b.d);
  if (!scores.length) return { ok: false, problem: "no exterior face to pick" };
  const tol = Math.max(1e-3, diagonal(geometry.bbox) * 2e-3);
  if (scores[0].d > diagonal(geometry.bbox) * 0.05) return { ok: false, problem: `no face near [${point.join(", ")}] mm (nearest is face ${scores[0].index}, ${scores[0].d.toFixed(2)} mm away)` };
  if (scores.length > 1 && scores[1].d - scores[0].d < tol) {
    return { ok: false, problem: `[${point.join(", ")}] mm is on the edge between faces ${scores[0].index} and ${scores[1].index}; name one of them` };
  }
  return { ok: true, faces: [scores[0].index] };
}

export function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  // Ericson, Real-Time Collision Detection, 5.1.5 (closest point on a triangle).
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return len(sub(p, [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]])); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return len(sub(p, [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]])); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return len(sub(p, [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]));
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return len(sub(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

export function signatureOf(face: SimFace): FaceSignature {
  return { index: face.index, surface: face.surface, area_mm2: face.area_mm2, center: face.center, ...(face.normal ? { normal: face.normal } : {}) };
}

/** Whether two signatures describe the same face (within a small geometric tolerance of the model's size). */
export function sameFace(a: FaceSignature, b: FaceSignature, size: number): boolean {
  if (a.surface !== b.surface) return false;
  if (Math.abs(a.area_mm2 - b.area_mm2) > Math.max(1e-6, 1e-4 * Math.max(a.area_mm2, b.area_mm2))) return false;
  if (len(sub(a.center, b.center)) > Math.max(1e-4, size * 1e-5)) return false;
  if (a.normal && b.normal && dot(a.normal, b.normal) < 0.9999) return false;
  return true;
}

/**
 * "exterior" and "remaining" fill: every exterior face (of a body) that no other condition of the same kind claims.
 * They are resolved after the specific selectors and always yield to them.
 */
export const isFill = (selector: FaceSelector) => "exterior" in selector || "remaining" in selector;

/** Whether a selector names its faces by what they are (re-resolved after a change) or by number or point (checked). */
export const isSemantic = (selector: FaceSelector) => !("faces" in selector) && !("at" in selector);

export function describeFace(geometry: SimGeometry, index: number): string {
  const f = geometry.faces.find(x => x.index === index);
  if (!f) return `face ${index}`;
  const facing = facingOf(f);
  const where = facing ? `${facing}-facing ${f.surface}` : f.surface;
  return `face ${index} (${where} of ${f.featureLabel}${f.featureLabel !== f.bodyLabel ? ` in ${f.bodyLabel}` : ""}, ${roundTo(f.area_mm2)} mm²)`;
}

export function describeFaces(geometry: SimGeometry, indices: number[], max = 6): string {
  const shown = indices.slice(0, max).map(i => describeFace(geometry, i));
  return shown.join(", ") + (indices.length > max ? ` and ${indices.length - max} more` : "");
}

const roundTo = (value: number) => Number(value.toPrecision(4));

/** A short fingerprint of the geometry's faces (meshes made from the same geometry share it). */
export function geometryKey(geometry: SimGeometry): string {
  let h = 2166136261;
  const text = JSON.stringify([geometry.document, geometry.revision, geometry.solids.map(s => [s.index, Math.round(s.volume_mm3 * 1e3)]), geometry.faces.map(f => [f.index, f.surface, Math.round(f.area_mm2 * 1e3), f.solids])]);
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
