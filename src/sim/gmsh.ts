import { diagonal, type SimGeometry, type Vec3 } from "./geometry";
import type { MeshConfig, MeshSize } from "./study";

/**
 * v0.8 Simulation Core: meshing with Gmsh — the input Gmsh is given and what is read back from it.
 *
 * The geometry arrives as the CAD backend's BREP (millimetres). Gmsh imports it with OpenCASCADE, with every healing
 * option off so that solids and faces keep the CAD numbering, scales it to metres (`Geometry.OCCScaling`, so the mesh
 * and everything after it is SI), puts every solid and every face in its own physical group (S<i>, F<i>), and writes
 * a first- or second-order tetrahedral mesh (MSH 2.2). A mesh therefore does not depend on the boundary conditions:
 * changing a load or a terminal never needs a new mesh. After meshing, the number, area and centroid of every face's
 * triangles are compared with the CAD face of the same number; a mismatch stops the run (the conditions would land on
 * the wrong faces).
 *
 * Sizes are meshing settings, not accuracy guarantees. The presets derive a characteristic length from the model's
 * size and its thinnest solid; `max_mm`, `min_mm`, `curvature` and local refinement override them.
 */
export const MESH_PRESETS: Record<MeshSize, { perDiagonal: number; perThickness: number; curvature: number }> = {
  coarse: { perDiagonal: 12, perThickness: 1, curvature: 8 },
  normal: { perDiagonal: 25, perThickness: 2, curvature: 12 },
  fine: { perDiagonal: 50, perThickness: 3, curvature: 20 },
  very_fine: { perDiagonal: 100, perThickness: 5, curvature: 32 },
};

export interface MeshSizing { max_mm: number; min_mm: number; curvature: number; estimatedElements: number }

/** A regular tetrahedron of edge h has volume h³/(6√2); Delaunay meshes run about 1.5× that count. */
const TET_FACTOR = 1.5 * 6 * Math.SQRT2;

export function meshSizing(geometry: SimGeometry, config: MeshConfig): MeshSizing {
  const preset = MESH_PRESETS[config.size];
  const diag = diagonal(geometry.bbox);
  const thinnest = Math.min(...geometry.solids.map(s => Math.min(...[0, 1, 2].map(k => s.bbox.max[k] - s.bbox.min[k])).valueOf()));
  const auto = Math.min(diag / preset.perDiagonal, thinnest / preset.perThickness);
  const max = config.max_mm ?? auto;
  const min = config.min_mm ?? Math.min(max, auto) / 20;
  const volume = geometry.solids.reduce((sum, s) => sum + s.volume_mm3, 0);
  let estimate = volume * TET_FACTOR / max ** 3;
  for (const r of config.refine) estimate += Math.min(volume, (r.size_mm * 6) ** 3) * TET_FACTOR / r.size_mm ** 3 * 0.25;
  return { max_mm: max, min_mm: Math.min(min, max), curvature: config.curvature ?? preset.curvature, estimatedElements: estimate };
}

export interface GeoInput {
  brepFile: string;
  mshFile: string;
  solids: number;
  faces: number;
  sizing: MeshSizing;
  order: 1 | 2;
  /** Local refinement: faces (by number) or solids, each with a size (mm). */
  refine: { faces?: number[]; solids?: number[]; size_mm: number }[];
  threads?: number;
}

/** The Gmsh script for one mesh. File names are plain names in the job directory (never paths from a request). */
export function buildGeo(input: GeoInput): string {
  const m = (mm: number) => (mm * 1e-3).toPrecision(6);
  const name = (file: string) => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(file)) throw new Error(`unsafe file name ${file}`);
    return file;
  };
  const lines = [
    "// Aion Presence — generated Gmsh input (v0.8). Do not edit: Aion writes a new one for every mesh.",
    'SetFactory("OpenCASCADE");',
    "Geometry.OCCFixDegenerated = 0;",
    "Geometry.OCCFixSmallEdges = 0;",
    "Geometry.OCCFixSmallFaces = 0;",
    "Geometry.OCCSewFaces = 0;",
    "Geometry.OCCMakeSolids = 0;",
    "Geometry.OCCScaling = 0.001; // CAD millimetres → metres",
    `Merge "${name(input.brepFile)}";`,
  ];
  for (let i = 1; i <= input.solids; i++) lines.push(`Physical Volume("S${i}", ${i}) = {${i}};`);
  for (let i = 1; i <= input.faces; i++) lines.push(`Physical Surface("F${i}", ${i}) = {${i}};`);
  lines.push(
    `Mesh.MeshSizeMax = ${m(input.sizing.max_mm)};`,
    `Mesh.MeshSizeMin = ${m(input.sizing.min_mm)};`,
    `Mesh.MeshSizeFromCurvature = ${Math.round(input.sizing.curvature)};`,
    "Mesh.Algorithm = 6;",
    "Mesh.Algorithm3D = 1;",
    "Mesh.Optimize = 1;",
    `Mesh.ElementOrder = ${input.order};`,
    "Mesh.SecondOrderLinear = 0;",
    "Mesh.MshFileVersion = 2.2;",
    "Mesh.Binary = 0;",
    "Mesh.SaveAll = 0;",
    // One thread: Gmsh's parallel 3-D meshing is not deterministic, and the same input should give the same mesh.
    `General.NumThreads = ${Math.max(1, Math.min(8, input.threads ?? 1))};`,
  );
  if (input.refine.length) {
    const fields: number[] = [];
    let id = 1;
    for (const r of input.refine) {
      if (r.faces?.length) {
        lines.push(`Field[${id}] = Distance;`, `Field[${id}].SurfacesList = {${r.faces.join(", ")}};`, `Field[${id}].Sampling = 30;`);
        lines.push(`Field[${id + 1}] = Threshold;`, `Field[${id + 1}].InField = ${id};`, `Field[${id + 1}].SizeMin = ${m(r.size_mm)};`,
          `Field[${id + 1}].SizeMax = ${m(input.sizing.max_mm)};`, `Field[${id + 1}].DistMin = ${m(r.size_mm)};`, `Field[${id + 1}].DistMax = ${m(r.size_mm * 8)};`);
        fields.push(id + 1);
        id += 2;
      }
      if (r.solids?.length) {
        lines.push(`Field[${id}] = Constant;`, `Field[${id}].VolumesList = {${r.solids.join(", ")}};`, `Field[${id}].VIn = ${m(r.size_mm)};`, `Field[${id}].VOut = ${m(input.sizing.max_mm)};`);
        fields.push(id);
        id += 1;
      }
    }
    lines.push(`Field[${id}] = Min;`, `Field[${id}].FieldsList = {${fields.join(", ")}};`, `Background Field = ${id};`);
  }
  lines.push("Mesh 3;", `Save "${name(input.mshFile)}";`, "");
  return lines.join("\n");
}

// ── Reading the mesh back ───────────────────────────────────────────────────────────────────────────────────────────
export interface MeshStats {
  nodes: number;
  tetrahedra: number;
  triangles: number;
  order: 1 | 2;
  /** Elements per solid and triangles per face (physical groups). */
  perSolid: Record<number, number>;
  perFace: Record<number, { triangles: number; area_mm2: number; center: Vec3 }>;
  volume_mm3: Record<number, number>;
  /** Tetrahedron shape quality γ = 3·r_in/R_circ (1: regular; 0: flat), of the corner nodes. */
  quality: { min: number; mean: number; below01: number; below03: number };
  minEdge_mm: number;
  maxEdge_mm: number;
}

const ELEMENT_NODES: Record<number, number> = { 1: 2, 2: 3, 4: 4, 8: 3, 9: 6, 11: 10, 15: 1 };

/** Reads an ASCII MSH 2.2 file (Gmsh's own output) into statistics. Lengths are reported in mm (the mesh is metres). */
export function readMsh(text: string): MeshStats {
  const lines = text.split(/\r?\n/);
  const at = (section: string) => {
    const i = lines.indexOf(section);
    if (i < 0) throw new Error(`the mesh file has no ${section} section`);
    return i;
  };
  const fmt = lines[at("$MeshFormat") + 1]?.trim().split(/\s+/);
  if (!fmt || fmt[0] !== "2.2" || fmt[1] !== "0") throw new Error("the mesh file is not ASCII MSH 2.2");
  const n0 = at("$Nodes");
  const nodeCount = Number(lines[n0 + 1]);
  const ids = new Map<number, number>();
  const xyz = new Float64Array(nodeCount * 3);
  for (let i = 0; i < nodeCount; i++) {
    const p = lines[n0 + 2 + i].trim().split(/\s+/);
    ids.set(Number(p[0]), i);
    xyz[i * 3] = Number(p[1]); xyz[i * 3 + 1] = Number(p[2]); xyz[i * 3 + 2] = Number(p[3]);
  }
  const e0 = at("$Elements");
  const count = Number(lines[e0 + 1]);
  const perSolid: Record<number, number> = {};
  const perFace: MeshStats["perFace"] = {};
  const volume: Record<number, number> = {};
  let tets = 0, tris = 0, order: 1 | 2 = 1, qMin = Infinity, qSum = 0, below01 = 0, below03 = 0, minEdge = Infinity, maxEdge = 0;
  const v = (k: number): Vec3 => [xyz[k * 3], xyz[k * 3 + 1], xyz[k * 3 + 2]];
  for (let i = 0; i < count; i++) {
    const p = lines[e0 + 2 + i].trim().split(/\s+/).map(Number);
    const type = p[1], tags = p[2], phys = p[3];
    const nodes = p.slice(3 + tags).map(id => ids.get(id)!);
    if (nodes.length !== ELEMENT_NODES[type]) continue;
    if (type === 4 || type === 11) {
      if (type === 11) order = 2;
      tets++;
      perSolid[phys] = (perSolid[phys] ?? 0) + 1;
      const [a, b, c, d] = nodes.slice(0, 4).map(v);
      const q = tetQuality(a, b, c, d);
      volume[phys] = (volume[phys] ?? 0) + q.volume * 1e9;
      qMin = Math.min(qMin, q.gamma); qSum += q.gamma;
      if (q.gamma < 0.1) below01++;
      if (q.gamma < 0.3) below03++;
      minEdge = Math.min(minEdge, q.minEdge); maxEdge = Math.max(maxEdge, q.maxEdge);
    } else if (type === 2 || type === 9) {
      tris++;
      const [a, b, c] = nodes.slice(0, 3).map(v);
      const area = triangleArea(a, b, c);
      const f = perFace[phys] ?? { triangles: 0, area_mm2: 0, center: [0, 0, 0] as Vec3 };
      f.triangles++;
      f.area_mm2 += area * 1e6;
      for (let k = 0; k < 3; k++) f.center[k] += area * 1e6 * (a[k] + b[k] + c[k]) / 3 * 1e3;
      perFace[phys] = f;
    }
  }
  for (const f of Object.values(perFace)) if (f.area_mm2 > 0) f.center = f.center.map(c => c / f.area_mm2) as Vec3;
  return {
    nodes: nodeCount, tetrahedra: tets, triangles: tris, order, perSolid, perFace, volume_mm3: volume,
    quality: { min: tets ? qMin : 0, mean: tets ? qSum / tets : 0, below01, below03 }, minEdge_mm: minEdge * 1e3, maxEdge_mm: maxEdge * 1e3,
  };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const triangleArea = (a: Vec3, b: Vec3, c: Vec3) => norm(cross(sub(b, a), sub(c, a))) / 2;

/** Volume, edge lengths and γ = 3·r_in/R_circ of a tetrahedron. */
export function tetQuality(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { volume: number; gamma: number; minEdge: number; maxEdge: number } {
  const ab = sub(b, a), ac = sub(c, a), ad = sub(d, a);
  const volume = Math.abs(dot(ab, cross(ac, ad))) / 6;
  const area = triangleArea(a, b, c) + triangleArea(a, b, d) + triangleArea(a, c, d) + triangleArea(b, c, d);
  const rIn = area > 0 ? 3 * volume / area : 0;
  // Circumradius: |a²(b×c) + b²(c×a) + c²(a×b)| / (12 V) with edges from a.
  const l1 = dot(ab, ab), l2 = dot(ac, ac), l3 = dot(ad, ad);
  const t = [cross(ac, ad), cross(ad, ab), cross(ab, ac)];
  const num: Vec3 = [0, 1, 2].map(k => l1 * t[0][k] + l2 * t[1][k] + l3 * t[2][k]) as Vec3;
  const rCirc = volume > 0 ? norm(num) / (12 * volume) : Infinity;
  const edges = [ab, ac, ad, sub(c, b), sub(d, b), sub(d, c)].map(norm);
  return { volume, gamma: Number.isFinite(rCirc) && rCirc > 0 ? Math.min(1, 3 * rIn / rCirc) : 0, minEdge: Math.min(...edges), maxEdge: Math.max(...edges) };
}

/** Compares each meshed face with the CAD face of the same number: problems mean the numbering cannot be trusted. */
export function checkFaceMapping(stats: MeshStats, geometry: SimGeometry): string[] {
  const problems: string[] = [];
  const size = diagonal(geometry.bbox);
  for (const face of geometry.faces) {
    const meshed = stats.perFace[face.index];
    if (!meshed) { problems.push(`face ${face.index} has no triangles in the mesh`); continue; }
    // Curved faces are faceted: their meshed area is a little smaller.
    const tol = face.surface === "plane" ? 0.005 : 0.05;
    const rel = Math.abs(meshed.area_mm2 - face.area_mm2) / Math.max(face.area_mm2, 1e-12);
    if (rel > tol) problems.push(`face ${face.index}: meshed area ${meshed.area_mm2.toPrecision(5)} mm² vs CAD ${face.area_mm2.toPrecision(5)} mm²`);
    const moved = norm(sub(meshed.center, face.center));
    if (face.surface === "plane" && moved > Math.max(1e-3, size * 0.005)) problems.push(`face ${face.index}: meshed centroid ${moved.toPrecision(3)} mm from the CAD face's`);
  }
  const extra = Object.keys(stats.perFace).map(Number).filter(i => !geometry.faces.some(f => f.index === i));
  if (extra.length) problems.push(`the mesh has faces the CAD geometry does not (${extra.slice(0, 5).join(", ")})`);
  for (const solid of geometry.solids) {
    const vol = stats.volume_mm3[solid.index];
    if (!vol) problems.push(`solid ${solid.index} has no elements`);
    else if (Math.abs(vol - solid.volume_mm3) / solid.volume_mm3 > 0.03) problems.push(`solid ${solid.index}: meshed volume ${vol.toPrecision(5)} mm³ vs CAD ${solid.volume_mm3.toPrecision(5)} mm³`);
  }
  return problems;
}
