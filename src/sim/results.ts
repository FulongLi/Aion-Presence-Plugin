import type { SimGeometry, Vec3 } from "./geometry";
import type { BoundSetup } from "./setup";
import { needsPhysics, type Analysis, type SimulationStudy } from "./study";

/**
 * v0.8 Simulation Core: reading Elmer's results and turning them into engineering numbers.
 *
 * The VTU Elmer writes (ASCII, one piece) holds the nodes (metres), the tetrahedra (geometry id = solid) and the
 * boundary triangles (geometry id = CAD face), and the nodal fields the solvers computed. Everything reported is
 * computed from those values, with its method stated:
 *
 *   terminal current     Σ of Elmer's nodal reaction currents (Potential Loads) over the terminal's nodes
 *   Joule loss           Elmer's integral (RES: Total Joule Heating), cross-checked by Σ σ|∇φ|²·V over the tetrahedra
 *                        (with a terminal current, Elmer's unscaled values are scaled by its Current Control factor)
 *   resistance           ΔV / I for a two-level (two-terminal) problem; Elmer's ΔV²/P beside it
 *   heat through a face  −Σ Elmer's nodal reaction heat (Temperature Loads) over its nodes — fixed-temperature,
 *                        convective and flux faces alike (each node counted once)
 *   heat balance         generated (σ|∇φ|² + sources) + prescribed inflow vs the heat rejected through the boundaries
 *   extrema              the nodal maximum / minimum and the node where it occurs
 *
 * Interior values between nodes are interpolated linearly inside the tetrahedron that contains the point (the shape
 * functions of the linear elements); that is what `probe` reports, and it says so.
 */
export interface FieldMesh {
  nodes: Float64Array;
  tets: Uint32Array;
  tetSolid: Int32Array;
  tris: Uint32Array;
  triFace: Int32Array;
  fields: Record<string, { components: number; values: Float64Array }>;
}

/** Reads Elmer's ASCII VTU. Throws with a plain message on anything unexpected. */
export function readVtu(text: string): FieldMesh {
  const piece = /<Piece\s+NumberOfPoints="(\d+)"\s+NumberOfCells="(\d+)"/.exec(text);
  if (!piece) throw new Error("the result file has no unstructured piece");
  const points = Number(piece[1]), cells = Number(piece[2]);
  const arrays: { section: string; name: string; components: number; values: string }[] = [];
  const sectionAt = (index: number) => {
    let best = "", at = -1;
    for (const s of ["<PointData", "<CellData", "<Points", "<Cells"]) {
      const i = text.lastIndexOf(s, index);
      if (i > at) { at = i; best = s.slice(1); }
    }
    return best;
  };
  const re = /<DataArray([^>]*)>([\s\S]*?)<\/DataArray>/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    const attrs = m[1];
    if (!/format="ascii"/i.test(attrs)) throw new Error("the result file is not ASCII (Aion asks Elmer for ASCII output)");
    arrays.push({ section: sectionAt(m.index), name: /Name="([^"]*)"/.exec(attrs)?.[1] ?? "", components: Number(/NumberOfComponents="(\d+)"/.exec(attrs)?.[1] ?? 1), values: m[2] });
  }
  const numbers = (s: string) => {
    const parts = s.trim().split(/\s+/);
    const out = new Float64Array(parts.length);
    for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
    return out;
  };
  const get = (section: string, name: string) => arrays.find(a => a.section === section && a.name === name);
  const pts = arrays.find(a => a.section === "Points");
  const conn = get("Cells", "connectivity"), offs = get("Cells", "offsets"), types = get("Cells", "types"), ids = get("CellData", "GeometryIds");
  if (!pts || !conn || !offs || !types) throw new Error("the result file lacks points or cells");
  if (!ids) throw new Error("the result file lacks geometry ids");
  const nodes = numbers(pts.values);
  if (nodes.length !== points * 3) throw new Error("the result file's points do not match its header");
  const c = numbers(conn.values), o = numbers(offs.values), t = numbers(types.values), g = numbers(ids.values);
  if (o.length !== cells || t.length !== cells || g.length !== cells) throw new Error("the result file's cells do not match its header");
  const tets: number[] = [], tetSolid: number[] = [], tris: number[] = [], triFace: number[] = [];
  let start = 0;
  for (let i = 0; i < cells; i++) {
    const end = o[i];
    if (t[i] === 10 && end - start === 4) { for (let k = start; k < end; k++) tets.push(c[k]); tetSolid.push(g[i]); }
    else if (t[i] === 5 && end - start === 3) { for (let k = start; k < end; k++) tris.push(c[k]); triFace.push(g[i]); }
    else if (t[i] === 24 || t[i] === 22) throw new Error("the result file has quadratic cells; Aion asks Elmer for linear output elements");
    start = end;
  }
  for (const v of [...tets, ...tris]) if (!(v >= 0 && v < points)) throw new Error("a result cell refers to a node that does not exist");
  const fields: FieldMesh["fields"] = {};
  for (const a of arrays) {
    if (a.section !== "PointData") continue;
    const values = numbers(a.values);
    if (values.length !== points * a.components) throw new Error(`the result field "${a.name}" has the wrong number of values`);
    fields[a.name] = { components: a.components, values };
  }
  return { nodes, tets: Uint32Array.from(tets), tetSolid: Int32Array.from(tetSolid), tris: Uint32Array.from(tris), triFace: Int32Array.from(triFace), fields };
}

// ── Fields the card shows (Elmer's names → what they are) ───────────────────────────────────────────────────────────
export interface FieldDef { id: string; elmer: string; name: string; unit: string; kind: "scalar" | "vector"; source: string; physics: "electric" | "thermal" }
export const FIELD_DEFS: FieldDef[] = [
  { id: "potential", elmer: "potential", name: "Electric potential", unit: "V", kind: "scalar", source: "Elmer StatCurrentSolve (nodal solution)", physics: "electric" },
  { id: "electric_field", elmer: "electric field", name: "Electric field", unit: "V/m", kind: "vector", source: "Elmer StatCurrentSolve (−∇φ projected to nodes)", physics: "electric" },
  { id: "current_density", elmer: "volume current", name: "Current density", unit: "A/m²", kind: "vector", source: "Elmer StatCurrentSolve (−σ∇φ projected to nodes)", physics: "electric" },
  { id: "joule_heating", elmer: "joule heating", name: "Joule heat density", unit: "W/m³", kind: "scalar", source: "Elmer StatCurrentSolve (σ|∇φ|² projected to nodes)", physics: "electric" },
  { id: "temperature", elmer: "temperature", name: "Temperature", unit: "K", kind: "scalar", source: "Elmer HeatSolve (nodal solution)", physics: "thermal" },
  { id: "heat_flux", elmer: "temperature flux", name: "Heat flux", unit: "W/m²", kind: "vector", source: "Elmer FluxSolver (−k∇T projected to nodes)", physics: "thermal" },
];

export interface FieldInfo {
  id: string; name: string; unit: string; kind: "scalar" | "vector"; source: string; location: "nodal";
  /** Of the value (scalars) or the magnitude (vectors). */
  min: number; max: number; minAt: Vec3; maxAt: Vec3;
}

export interface ResultSummary {
  format: "aion.sim.result/1";
  study: string;
  run: number;
  analysis: Analysis;
  studyRevision: number;
  geometry: { document: string; revision: number };
  meshId: string;
  created: string;
  mesh: { nodes: number; tetrahedra: number; triangles: number; order: 1 | 2; quality: { min: number; mean: number }; max_mm: number };
  fields: FieldInfo[];
  electric?: {
    terminals: { boundary: string; name: string; faces: number[]; potential_V: number; current_A: number }[];
    currentImbalance: number;
    joule_W: number;
    jouleCheck_W: number;
    voltage_V?: number;
    current_A?: number;
    resistance_ohm?: number;
    resistanceElmer_ohm?: number;
    viCheck_W?: number;
  };
  thermal?: {
    max_K: number; min_K: number; maxAt: Vec3; minAt: Vec3;
    generated: { joule_W: number; sources_W: number; inflow_W: number };
    boundaries: { boundary: string; name: string; type: string; heatOut_W: number }[];
    balance: { in_W: number; out_W: number; relativeError: number };
  };
  solver: { name: string; version?: string; seconds?: number; solvers: { name: string; linearIterations?: number; finalResidual?: number; resultNorm?: number }[]; warnings: string[] };
  notes: string[];
}

const v3 = (a: Float64Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
/** Metres → millimetres, to 0.1 µm (no round-off noise such as −2.4e−16 mm). */
const mm = (p: Vec3): Vec3 => p.map(x => Math.round(x * 1e7) / 1e4 + 0) as Vec3;

/** Per-node values of a field (vectors: their magnitude). */
export function scalarValues(field: { components: number; values: Float64Array }): Float64Array {
  if (field.components === 1) return field.values;
  const n = field.values.length / field.components;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < field.components; k++) s += field.values[i * field.components + k] ** 2;
    out[i] = Math.sqrt(s);
  }
  return out;
}

function extrema(mesh: FieldMesh, values: Float64Array, used: Uint8Array) {
  let min = Infinity, max = -Infinity, iMin = 0, iMax = 0;
  for (let i = 0; i < values.length; i++) {
    if (!used[i]) continue;
    if (values[i] < min) { min = values[i]; iMin = i; }
    if (values[i] > max) { max = values[i]; iMax = i; }
  }
  return { min, max, minAt: mm(v3(mesh.nodes, iMin)), maxAt: mm(v3(mesh.nodes, iMax)) };
}

/** Nodes of the triangles on the given faces. */
export function faceNodes(mesh: FieldMesh, faces: Set<number>): Set<number> {
  const out = new Set<number>();
  for (let t = 0; t < mesh.triFace.length; t++) if (faces.has(mesh.triFace[t])) for (let k = 0; k < 3; k++) out.add(mesh.tris[t * 3 + k]);
  return out;
}

function tetGradient(mesh: FieldMesh, t: number, phi: Float64Array): { grad: Vec3; volume: number } {
  const n = [0, 1, 2, 3].map(k => mesh.tets[t * 4 + k]);
  const p = n.map(i => v3(mesh.nodes, i));
  const e = [1, 2, 3].map(k => [p[k][0] - p[0][0], p[k][1] - p[0][1], p[k][2] - p[0][2]]);
  const d = [phi[n[1]] - phi[n[0]], phi[n[2]] - phi[n[0]], phi[n[3]] - phi[n[0]]];
  const det = e[0][0] * (e[1][1] * e[2][2] - e[1][2] * e[2][1]) - e[0][1] * (e[1][0] * e[2][2] - e[1][2] * e[2][0]) + e[0][2] * (e[1][0] * e[2][1] - e[1][1] * e[2][0]);
  if (det === 0) return { grad: [0, 0, 0], volume: 0 };
  // Solve E g = d (rows of E are the edge vectors) by Cramer's rule.
  const solve = (k: number) => {
    const m = e.map((row, r) => row.map((x, c) => (c === k ? d[r] : x)));
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) / det;
  };
  return { grad: [solve(0), solve(1), solve(2)], volume: Math.abs(det) / 6 };
}

const triArea = (a: Vec3, b: Vec3, c: Vec3) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
};

export interface SummaryInput {
  study: SimulationStudy; geometry: SimGeometry; setup: BoundSetup; mesh: FieldMesh; run: number; meshId: string;
  meshInfo: { nodes: number; tetrahedra: number; triangles: number; order: 1 | 2; quality: { min: number; mean: number }; max_mm: number };
  scalars: Record<string, number>;
  solver: ResultSummary["solver"];
  created?: string;
}

export function summarize(input: SummaryInput): ResultSummary {
  const { study, setup, mesh } = input;
  const electric = needsPhysics(study.analysis, "electric");
  const thermal = needsPhysics(study.analysis, "thermal");
  const nodeCount = mesh.nodes.length / 3;
  const notes: string[] = [];
  // Nodes of each solid (a field is only meaningful where its equation was solved).
  const conductorNodes = new Uint8Array(nodeCount), allNodes = new Uint8Array(nodeCount);
  const conducts = (s: number) => Boolean(setup.solids.find(x => x.index === s)?.material?.properties.electricConductivity);
  for (let t = 0; t < mesh.tetSolid.length; t++) for (let k = 0; k < 4; k++) {
    const i = mesh.tets[t * 4 + k];
    allNodes[i] = 1;
    if (conducts(mesh.tetSolid[t])) conductorNodes[i] = 1;
  }
  const fields: FieldInfo[] = [];
  for (const def of FIELD_DEFS) {
    const field = mesh.fields[def.elmer];
    if (!field || (def.physics === "electric" && !electric) || (def.physics === "thermal" && !thermal)) continue;
    const values = scalarValues(field);
    for (const v of values) if (!Number.isFinite(v)) throw new Error(`the solver's ${def.name.toLowerCase()} contains values that are not numbers`);
    fields.push({ id: def.id, name: def.name, unit: def.unit, kind: def.kind, source: def.source, location: "nodal", ...extrema(mesh, values, def.physics === "electric" ? conductorNodes : allNodes) });
  }
  const summary: ResultSummary = {
    format: "aion.sim.result/1", study: study.id, run: input.run, analysis: study.analysis, studyRevision: study.revision,
    geometry: { document: input.geometry.document, revision: input.geometry.revision }, meshId: input.meshId, created: input.created ?? new Date().toISOString(),
    mesh: input.meshInfo, fields, solver: input.solver, notes,
  };

  if (electric) {
    const phi = mesh.fields.potential?.values, loads = mesh.fields["potential loads"]?.values;
    if (!phi || !loads) throw new Error("the electrical result lacks the potential or its reaction currents");
    // Current Control: Elmer solves for 1 V, then scales the potential; its reaction currents and its Joule total are
    // those of the unscaled solution (verified with Elmer 26.2), so they are scaled here (currents linearly, power
    // quadratically).
    const scaling = input.scalars["res: currentsolver scaling"] ?? 1;
    const groups = new Map<string, { name: string; faces: number[] }>();
    for (const f of setup.faces.values()) {
      const c = f.electric?.condition;
      if (!c || !["voltage", "ground", "current"].includes(c.type)) continue;
      const b = study.boundaries.find(x => x.id === f.electric!.boundary)!;
      const g = groups.get(b.id) ?? { name: b.name, faces: [] };
      g.faces.push(f.index);
      groups.set(b.id, g);
    }
    const terminals = [...groups].map(([boundary, g]) => {
      const nodes = faceNodes(mesh, new Set(g.faces));
      let current = 0, potential = 0;
      for (const n of nodes) { current += loads[n] * scaling; potential += phi[n]; }
      return { boundary, name: g.name, faces: g.faces, potential_V: nodes.size ? potential / nodes.size : NaN, current_A: current };
    });
    const maxCurrent = Math.max(...terminals.map(t => Math.abs(t.current_A)), 1e-300);
    const imbalance = Math.abs(terminals.reduce((s, t) => s + t.current_A, 0)) / maxCurrent;
    // Joule loss: σ|∇φ|² over the conducting tetrahedra.
    let check = 0;
    for (let t = 0; t < mesh.tetSolid.length; t++) {
      const sigma = setup.solids.find(x => x.index === mesh.tetSolid[t])?.material?.properties.electricConductivity;
      if (!sigma) continue;
      const { grad, volume } = tetGradient(mesh, t, phi);
      check += sigma * (grad[0] ** 2 + grad[1] ** 2 + grad[2] ** 2) * volume;
    }
    const joule = input.scalars["res: total joule heating"] !== undefined ? input.scalars["res: total joule heating"] * scaling ** 2 : check;
    const e: NonNullable<ResultSummary["electric"]> = { terminals, currentImbalance: imbalance, joule_W: joule, jouleCheck_W: check };
    const levels = [...new Set(terminals.map(t => Number(t.potential_V.toPrecision(9))))];
    if (levels.length === 2) {
      const high = Math.max(...levels), low = Math.min(...levels);
      const current = terminals.filter(t => Number(t.potential_V.toPrecision(9)) === high).reduce((s, t) => s + t.current_A, 0);
      e.voltage_V = high - low;
      e.current_A = current;
      if (current !== 0) e.resistance_ohm = e.voltage_V / current;
      if (input.scalars["res: effective resistance"] !== undefined) e.resistanceElmer_ohm = input.scalars["res: effective resistance"];
      e.viCheck_W = e.voltage_V * current;
    } else notes.push(`${levels.length} distinct terminal potentials: no single two-terminal resistance is defined; each terminal's current is reported.`);
    if (imbalance > 1e-3) notes.push(`The terminal currents do not sum to zero (imbalance ${(imbalance * 100).toPrecision(2)} % of the largest): check the solver tolerance or refine the mesh.`);
    if (joule > 0 && Math.abs(check - joule) / joule > 0.02) notes.push(`Joule loss: Elmer's integral ${joule.toPrecision(5)} W and Aion's ${check.toPrecision(5)} W differ by more than 2 %.`);
    const jd = mesh.fields["volume current"];
    if (jd) {
      const mags = scalarValues(jd);
      let sum = 0, count = 0, max = 0;
      for (let i = 0; i < mags.length; i++) if (conductorNodes[i]) { sum += mags[i]; count++; max = Math.max(max, mags[i]); }
      if (count && max > 25 * (sum / count)) notes.push("The current density peaks far above its average at a few nodes — typically a sharp re-entrant edge, where the exact field is singular: that peak value depends on the mesh; compare a finer mesh before relying on it.");
    }
    summary.electric = e;
  }

  if (thermal) {
    const T = mesh.fields.temperature?.values, loads = mesh.fields["temperature loads"]?.values;
    if (!T || !loads) throw new Error("the thermal result lacks the temperature or its reaction heat");
    const temp = fields.find(f => f.id === "temperature")!;
    const boundaries: NonNullable<ResultSummary["thermal"]>["boundaries"] = [];
    let inflow = 0;
    const byBoundary = new Map<string, number[]>();
    for (const f of setup.faces.values()) if (f.thermal) byBoundary.set(f.thermal.boundary, [...(byBoundary.get(f.thermal.boundary) ?? []), f.index]);
    // Heat leaving through each boundary: −Σ Elmer's nodal reaction heat (Temperature Loads, computed from the bulk
    // system, so it holds the heat crossing fixed-temperature, convective and flux faces alike), each node counted once:
    // first by fixed-temperature boundaries (their rows are the Dirichlet ones), then the others.
    const claimed = new Set<number>();
    const order = [...byBoundary].sort(([a], [b]) => Number(study.boundaries.find(x => x.id === b)?.condition.type === "temperature") - Number(study.boundaries.find(x => x.id === a)?.condition.type === "temperature"));
    for (const [id, faces] of order) {
      const b = study.boundaries.find(x => x.id === id)!;
      const c = b.condition;
      if (!["temperature", "convection", "heat_flux", "heat_flow"].includes(c.type)) continue;
      let out = 0;
      for (const n of faceNodes(mesh, new Set(faces))) {
        if (claimed.has(n)) continue;
        claimed.add(n);
        out -= loads[n];
      }
      if (c.type === "heat_flux" || c.type === "heat_flow") {
        const set = new Set(faces);
        let area = 0;
        for (let t = 0; t < mesh.triFace.length; t++) if (set.has(mesh.triFace[t])) {
          const n = [0, 1, 2].map(k => mesh.tris[t * 3 + k]);
          area += triArea(v3(mesh.nodes, n[0]), v3(mesh.nodes, n[1]), v3(mesh.nodes, n[2]));
        }
        inflow += c.type === "heat_flux" ? c.flux * area : c.power;
      }
      boundaries.push({ boundary: id, name: b.name, type: c.type, heatOut_W: out });
    }
    // Sources over the meshed volumes.
    const volume = new Map<number, number>();
    for (let t = 0; t < mesh.tetSolid.length; t++) {
      const n = [0, 1, 2, 3].map(k => mesh.tets[t * 4 + k]);
      const p = n.map(i => v3(mesh.nodes, i));
      const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]], d = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
      const vol = Math.abs(a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
      volume.set(mesh.tetSolid[t], (volume.get(mesh.tetSolid[t]) ?? 0) + vol);
    }
    let sources = 0;
    for (const [solid, q] of setup.sources) sources += q * (volume.get(solid) ?? 0);
    // The balance: heat generated (Joule loss integrated from the electrical solution, σ|∇φ|², and the user's sources) and
    // prescribed inflow against the net heat the thermal solution rejects through its boundaries.
    const joule = study.analysis === "electrothermal" ? (summary.electric?.jouleCheck_W ?? 0) : 0;
    const totalIn = joule + sources + inflow;
    const totalOut = boundaries.filter(b => b.type !== "heat_flux" && b.type !== "heat_flow").reduce((s, b) => s + b.heatOut_W, 0);
    const relativeError = Math.max(Math.abs(totalIn), Math.abs(totalOut)) > 0 ? Math.abs(totalIn - totalOut) / Math.max(Math.abs(totalIn), Math.abs(totalOut)) : 0;
    summary.thermal = {
      max_K: temp.max, min_K: temp.min, maxAt: temp.maxAt, minAt: temp.minAt,
      generated: { joule_W: joule, sources_W: sources, inflow_W: inflow }, boundaries,
      balance: { in_W: totalIn, out_W: totalOut, relativeError },
    };
    if (relativeError > 0.02) notes.push(`The heat balance closes to ${(relativeError * 100).toPrecision(2)} % only: refine the mesh near the cooled faces.`);
  }
  return summary;
}

/** Key numbers of a result, for listing and comparing runs. */
export function headline(summary: ResultSummary): Record<string, number> {
  const out: Record<string, number> = {};
  const e = summary.electric, t = summary.thermal;
  if (e) {
    if (e.resistance_ohm !== undefined) out.resistance_ohm = e.resistance_ohm;
    if (e.current_A !== undefined) out.current_A = e.current_A;
    if (e.voltage_V !== undefined) out.voltage_V = e.voltage_V;
    out.joule_W = e.joule_W;
    const j = summary.fields.find(f => f.id === "current_density");
    if (j) out.max_current_density_A_per_m2 = j.max;
  }
  if (t) { out.max_temperature_K = t.max_K; out.min_temperature_K = t.min_K; }
  out.nodes = summary.mesh.nodes;
  out.tetrahedra = summary.mesh.tetrahedra;
  return out;
}

// ── Probing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Probe {
  point_mm: Vec3;
  inside: boolean;
  solid?: number;
  method: string;
  values: Record<string, number | Vec3>;
}

/** The fields at a point (mm): linear interpolation inside the containing tetrahedron, or the nearest node outside. */
export function probe(mesh: FieldMesh, point_mm: Vec3): Probe {
  const p: Vec3 = [point_mm[0] * 1e-3, point_mm[1] * 1e-3, point_mm[2] * 1e-3];
  const tets = mesh.tetSolid.length;
  const eps = 1e-9;
  for (let t = 0; t < tets; t++) {
    const n = [0, 1, 2, 3].map(k => mesh.tets[t * 4 + k]);
    let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
    for (const i of n) {
      const x = mesh.nodes[i * 3], y = mesh.nodes[i * 3 + 1], z = mesh.nodes[i * 3 + 2];
      lo0 = Math.min(lo0, x); hi0 = Math.max(hi0, x); lo1 = Math.min(lo1, y); hi1 = Math.max(hi1, y); lo2 = Math.min(lo2, z); hi2 = Math.max(hi2, z);
    }
    const pad = Math.max(hi0 - lo0, hi1 - lo1, hi2 - lo2) * 1e-9;
    if (p[0] < lo0 - pad || p[0] > hi0 + pad || p[1] < lo1 - pad || p[1] > hi1 + pad || p[2] < lo2 - pad || p[2] > hi2 + pad) continue;
    const w = barycentric(mesh, n, p);
    if (!w || w.some(x => x < -eps)) continue;
    return { point_mm, inside: true, solid: mesh.tetSolid[t], method: "linear interpolation inside the containing tetrahedron", values: sample(mesh, n, w) };
  }
  let best = 0, dist = Infinity;
  for (let i = 0; i < mesh.nodes.length / 3; i++) {
    const d = (mesh.nodes[i * 3] - p[0]) ** 2 + (mesh.nodes[i * 3 + 1] - p[1]) ** 2 + (mesh.nodes[i * 3 + 2] - p[2]) ** 2;
    if (d < dist) { dist = d; best = i; }
  }
  return { point_mm, inside: false, method: `outside the solids: the nearest node, ${(Math.sqrt(dist) * 1e3).toPrecision(3)} mm away, at [${mm(v3(mesh.nodes, best)).join(", ")}] mm`, values: sample(mesh, [best], [1]) };
}

function barycentric(mesh: FieldMesh, n: number[], p: Vec3): number[] | null {
  const a = v3(mesh.nodes, n[0]), b = v3(mesh.nodes, n[1]), c = v3(mesh.nodes, n[2]), d = v3(mesh.nodes, n[3]);
  const m = [[b[0] - a[0], c[0] - a[0], d[0] - a[0]], [b[1] - a[1], c[1] - a[1], d[1] - a[1]], [b[2] - a[2], c[2] - a[2], d[2] - a[2]]];
  const r = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const det3 = (q: number[][]) => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const det = det3(m);
  if (det === 0) return null;
  const solve = (k: number) => det3(m.map((row, i) => row.map((x, j) => (j === k ? r[i] : x)))) / det;
  const w1 = solve(0), w2 = solve(1), w3 = solve(2);
  return [1 - w1 - w2 - w3, w1, w2, w3];
}

function sample(mesh: FieldMesh, nodes: number[], weights: number[]): Record<string, number | Vec3> {
  const out: Record<string, number | Vec3> = {};
  for (const def of FIELD_DEFS) {
    const f = mesh.fields[def.elmer];
    if (!f) continue;
    if (f.components === 1) out[def.id] = nodes.reduce((s, n, k) => s + weights[k] * f.values[n], 0);
    else {
      const v = [0, 1, 2].map(c => nodes.reduce((s, n, k) => s + weights[k] * f.values[n * f.components + c], 0)) as Vec3;
      out[def.id] = v;
      out[`${def.id}_magnitude`] = Math.hypot(...v);
    }
  }
  return out;
}
