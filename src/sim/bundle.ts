import { encodeFieldBundle, FIELD_LIMITS, type BundleFace, type BundleField } from "./field";
import { describeFace, type SimGeometry } from "./geometry";
import type { FieldMesh, ResultSummary } from "./results";
import { FIELD_DEFS } from "./results";
import type { BoundSetup } from "./setup";
import { describeCondition, needsPhysics, type Condition, type SimulationStudy } from "./study";
import { formatQuantity } from "./units";

/**
 * v0.8 Simulation Core: building the bundles the Simulation Card shows — the setup (the geometry with every face's
 * conditions, for picking faces) and a result (the solver's fields on the mesh). See field.ts for the format.
 */
const CONDITION_COLOR: Record<Condition["type"], string> = {
  voltage: "#e4572e", current: "#f08a24", ground: "#2e86de", insulated: "#9aa4ae",
  temperature: "#8e44ad", convection: "#17becf", heat_flux: "#f4a300", heat_flow: "#f4a300", adiabatic: "#9aa4ae",
};

function faceTable(study: SimulationStudy, geometry: SimGeometry, setup: BoundSetup | null): BundleFace[] {
  return geometry.faces.map(f => {
    const bound = setup?.faces.get(f.index);
    const parts: string[] = [], groups: string[] = [];
    let color: string | undefined;
    for (const physics of ["electric", "thermal"] as const) {
      const entry = bound?.[physics];
      if (!entry || !needsPhysics(study.analysis, physics)) continue;
      const b = study.boundaries.find(x => x.id === entry.boundary);
      parts.push(`${b?.name ?? entry.boundary}: ${describeCondition(entry.condition)}`);
      groups.push(b?.name ?? entry.boundary);
      color ??= CONDITION_COLOR[entry.condition.type];
    }
    return {
      index: f.index, label: describeFace(geometry, f.index).slice(0, 120), body: f.bodyLabel.slice(0, 80), area_mm2: f.area_mm2,
      ...(parts.length ? { condition: parts.join("; ").slice(0, 160), group: groups.join(", ").slice(0, 80) } : {}), ...(color ? { color } : {}),
    };
  });
}

/** Each boundary condition in use, with the colour its faces have. */
function conditionLegend(study: SimulationStudy, setup: BoundSetup | null): { name: string; color: string; text: string }[] {
  const used = new Set([...(setup?.faces.values() ?? [])].flatMap(f => [f.electric?.boundary, f.thermal?.boundary]).filter(Boolean) as string[]);
  return study.boundaries.filter(b => used.has(b.id) && needsPhysics(study.analysis, b.condition.type === "voltage" || b.condition.type === "ground" || b.condition.type === "current" || b.condition.type === "insulated" ? "electric" : "thermal"))
    .slice(0, 128).map(b => ({ name: b.name.slice(0, 80), color: CONDITION_COLOR[b.condition.type], text: describeCondition(b.condition).slice(0, 160) }));
}

function solidTable(geometry: SimGeometry, setup: BoundSetup | null) {
  return geometry.solids.map(s => {
    const material = setup?.solids.find(x => x.index === s.index)?.material?.name;
    return { index: s.index, label: `${s.bodyLabel}${geometry.solids.filter(x => x.body === s.body).length > 1 ? ` (solid ${s.index})` : ""}`.slice(0, 120), ...(material ? { material: material.slice(0, 80) } : {}) };
  });
}

/** The setup view: the CAD surface (per face), coloured by the conditions assigned to each face. */
export function setupBundle(study: SimulationStudy, geometry: SimGeometry, setup: BoundSetup | null, summary: string[] = []): Uint8Array {
  if (!geometry.surface) throw new Error("the geometry has no surface tessellation");
  let vertices = 0, triangles = 0;
  for (const f of geometry.surface.faces) { vertices += f.positions.length / 3; triangles += f.indices.length / 3; }
  const nodes = new Float32Array(vertices * 3), tris = new Uint32Array(triangles * 3), triFace = new Uint32Array(triangles);
  let v = 0, t = 0;
  for (const f of geometry.surface.faces) {
    for (let i = 0; i < f.positions.length; i++) nodes[v * 3 + i] = f.positions[i] * 1e-3;
    for (let i = 0; i < f.indices.length; i += 3) {
      tris[t * 3] = f.indices[i] + v; tris[t * 3 + 1] = f.indices[i + 1] + v; tris[t * 3 + 2] = f.indices[i + 2] + v;
      triFace[t++] = f.index;
    }
    v += f.positions.length / 3;
  }
  return encodeFieldBundle({
    format: "aion.field/1", mode: "setup", title: `${study.name} — setup`.slice(0, 120),
    study: { id: study.id, name: study.name.slice(0, 80), analysis: study.analysis, revision: study.revision },
    geometry: { document: geometry.document, revision: geometry.revision }, units: { length: "m" },
    counts: { nodes: vertices, triangles, tetrahedra: 0 }, faces: faceTable(study, geometry, setup), solids: solidTable(geometry, setup),
    fields: [], summary: summary.slice(0, 40).map(s => s.slice(0, 300)), omitted: [], conditions: conditionLegend(study, setup),
  }, [{ id: "nodes", data: nodes }, { id: "tris", data: tris }, { id: "triFace", data: triFace }]);
}

/** A result: the solver's nodal fields on the mesh, within the card's size limit (interior cells first to go). */
export function resultBundle(study: SimulationStudy, geometry: SimGeometry, setup: BoundSetup, mesh: FieldMesh, summary: ResultSummary): { bytes: Uint8Array; omitted: string[] } {
  const n = mesh.nodes.length / 3, tris = mesh.triFace.length, tets = mesh.tetSolid.length;
  const nodes = Float32Array.from(mesh.nodes);
  const blocks: { id: string; data: Float32Array | Uint32Array | Uint8Array }[] = [
    { id: "nodes", data: nodes }, { id: "tris", data: Uint32Array.from(mesh.tris) }, { id: "triFace", data: Uint32Array.from(mesh.triFace) },
  ];
  // Electric fields are defined on conductors only.
  const conducts = (s: number) => Boolean(setup.solids.find(x => x.index === s)?.material?.properties.electricConductivity);
  let mask: Uint8Array | null = null;
  if (study.analysis === "electrothermal" && setup.solids.some(s => !conducts(s.index))) {
    mask = new Uint8Array(n);
    for (let t = 0; t < tets; t++) if (conducts(mesh.tetSolid[t])) for (let k = 0; k < 4; k++) mask[mesh.tets[t * 4 + k]] = 1;
  }
  const fields: BundleField[] = [];
  const fieldBlocks: { id: string; data: Float32Array }[] = [];
  for (const info of summary.fields) {
    const def = FIELD_DEFS.find(d => d.id === info.id)!;
    const source = mesh.fields[def.elmer];
    if (!source) continue;
    const data = new Float32Array(n * (def.kind === "vector" ? 3 : 1));
    for (let i = 0; i < n; i++) for (let k = 0; k < source.components && k < 3; k++) data[i * (def.kind === "vector" ? 3 : 1) + k] = source.values[i * source.components + k];
    fields.push({ ...info, block: `f:${info.id}`, ...(def.physics === "electric" && mask ? { mask: "mask:electric" } : {}), ...(info.id === "temperature" ? { display: { unit: "°C", offset: -273.15 } } : {}) });
    fieldBlocks.push({ id: `f:${info.id}`, data });
  }
  const omitted: string[] = [];
  const base = blocks.reduce((s, b) => s + b.data.byteLength, 0) + fieldBlocks.reduce((s, b) => s + b.data.byteLength, 0) + (mask ? n : 0) + 64 * 1024;
  const interior = tets * 20;
  const includeTets = base + interior <= FIELD_LIMITS.bytes - 256 * 1024 && tets <= FIELD_LIMITS.tetrahedra;
  if (base > FIELD_LIMITS.bytes - 256 * 1024) throw new Error(`the result (${n.toLocaleString("en")} nodes) is too large for the card; its numbers are still available, and the VTU file can be opened in ParaView`);
  if (includeTets) blocks.push({ id: "tets", data: Uint32Array.from(mesh.tets) }, { id: "tetSolid", data: Uint32Array.from(mesh.tetSolid) });
  else omitted.push(`The mesh's ${tets.toLocaleString("en")} interior elements exceed the card's size limit: sections and interior probes are not available in the card (surface fields and Codex's probes are).`);
  blocks.push(...fieldBlocks);
  if (mask) blocks.push({ id: "mask:electric", data: mask });
  const lines = summaryLines(summary);
  const bytes = encodeFieldBundle({
    format: "aion.field/1", mode: "results", title: `${study.name} — run ${summary.run}`.slice(0, 120),
    study: { id: study.id, name: study.name.slice(0, 80), analysis: study.analysis, revision: summary.studyRevision, run: summary.run },
    geometry: { document: geometry.document, revision: geometry.revision }, units: { length: "m" },
    counts: { nodes: n, triangles: tris, tetrahedra: includeTets ? tets : 0 }, faces: faceTable(study, geometry, setup), solids: solidTable(geometry, setup),
    fields, summary: lines, omitted,
  }, blocks);
  return { bytes, omitted };
}

/** The headline numbers as short lines (the card's info panel; Codex gets the structured summary). */
export function summaryLines(s: ResultSummary): string[] {
  const out: string[] = [];
  const e = s.electric, t = s.thermal;
  if (e) {
    if (e.voltage_V !== undefined) out.push(`Voltage ${formatQuantity(e.voltage_V, "V")}, current ${formatQuantity(e.current_A ?? 0, "A")}`);
    if (e.resistance_ohm !== undefined) out.push(`Resistance ${formatQuantity(e.resistance_ohm, "Ω")}`);
    out.push(`Joule loss ${formatQuantity(e.joule_W, "W")}`);
    for (const term of e.terminals.slice(0, 6)) out.push(`${term.name}: ${formatQuantity(term.potential_V, "V")}, ${formatQuantity(term.current_A, "A")}`);
  }
  if (t) {
    out.push(`Temperature ${(t.min_K - 273.15).toFixed(2)} … ${(t.max_K - 273.15).toFixed(2)} °C`);
    out.push(`Heat balance: in ${formatQuantity(t.balance.in_W, "W")}, out ${formatQuantity(t.balance.out_W, "W")} (${(t.balance.relativeError * 100).toPrecision(2)} %)`);
  }
  out.push(`Mesh ${s.mesh.nodes.toLocaleString("en")} nodes, ${s.mesh.tetrahedra.toLocaleString("en")} tetrahedra (order ${s.mesh.order})`);
  out.push(`${s.solver.name}${s.solver.version ? ` ${s.solver.version}` : ""}${s.solver.seconds !== undefined ? `, ${s.solver.seconds.toFixed(1)} s` : ""}`);
  return out.map(l => l.slice(0, 300));
}
