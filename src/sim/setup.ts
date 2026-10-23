import {
  describeFaces, diagonal, isExterior, isFill, isSemantic, resolveBody, resolveSelector, sameFace, signatureOf,
  type FaceSignature, type SimGeometry,
} from "./geometry";
import type { MaterialProperties } from "./materials";
import { describeCondition, needsPhysics, physicsOf, type BoundaryAssignment, type Condition, type Physics, type SimulationStudy } from "./study";

/**
 * v0.8 Simulation Core: binding a study to a geometry revision, and checking it before anything is solved.
 *
 * `bind` resolves every material, boundary and source against the geometry (selectors → faces, body references →
 * solids) and records what it found on the study (with face signatures). When the geometry changed since the last
 * binding, semantic selectors are resolved again and the change is reported; faces picked by number or point must
 * still match their signatures, or the assignment is marked stale and left out (reported as a blocking error).
 *
 * `validate` turns the bound setup into issues: errors block a solve (missing materials, contradictory or missing
 * conditions, floating conductors, a body with no heat sink…), warnings are reported but do not, and `info` lists the
 * defaults that apply (insulated / adiabatic faces, nominal material data) so the user can review them. Nothing here
 * chooses an engineering assumption silently.
 */
export type Severity = "error" | "warning" | "info";
export interface Issue { severity: Severity; code: string; message: string; item?: string }

export interface BoundSolid { index: number; label: string; material?: { id: string; name: string; properties: MaterialProperties; nominal: boolean }; source?: number }
export interface BoundFace { index: number; electric?: { boundary: string; condition: Condition }; thermal?: { boundary: string; condition: Condition } }
export interface BoundSetup {
  geometryRevision: number;
  solids: BoundSolid[];
  faces: Map<number, BoundFace>;
  /** W/m³ per solid (user sources; Joule heating is the solver's). */
  sources: Map<number, number>;
  issues: Issue[];
  /** What changed in the regions since the previous binding (re-resolved, remapped, stale). */
  changes: string[];
}

export function bind(study: SimulationStudy, geometry: SimGeometry): BoundSetup {
  const issues: Issue[] = [];
  const changes: string[] = [];
  const size = diagonal(geometry.bbox);
  const solids: BoundSolid[] = geometry.solids.map(s => ({ index: s.index, label: `${s.bodyLabel}${geometry.bodies.find(b => b.id === s.body)!.solids.length > 1 ? ` (solid ${s.index})` : ""}` }));

  // Materials: each solid gets at most one.
  for (const m of study.materials) {
    for (const ref of m.bodies) {
      const body = resolveBody(geometry, ref);
      if (!body.ok) { issues.push({ severity: "error", code: "material-body", message: `Material ${m.name}: ${body.problem}.`, item: m.id }); continue; }
      for (const index of body.solids) {
        const solid = solids.find(s => s.index === index)!;
        if (solid.material && solid.material.id !== m.id) {
          issues.push({ severity: "error", code: "material-conflict", message: `${solid.label} has two materials (${solid.material.name} and ${m.name}); remove one.`, item: m.id });
        }
        solid.material = { id: m.id, name: m.name, properties: m.properties, nominal: m.nominal };
      }
    }
  }

  // Boundaries: resolve (or check) faces; non-semantic selectors must still match.
  const faces = new Map<number, BoundFace>();
  const taken: Record<Physics, Set<number>> = { electric: new Set(), thermal: new Set() };
  // Specific selectors first; "exterior"/"remaining" then fill the faces left over.
  const ordered = [...study.boundaries].sort((a, b) => Number(isFill(a.selector)) - Number(isFill(b.selector)));
  for (const b of ordered) {
    const physics = physicsOf(b.condition.type);
    const resolution = resolveBoundary(b, geometry, taken[physics], size, changes);
    if (!resolution.ok) {
      b.stale = resolution.stale;
      issues.push({ severity: "error", code: resolution.stale ? "boundary-stale" : "boundary-unresolved", message: `${b.name}: ${resolution.problem}`, item: b.id });
      continue;
    }
    delete b.stale;
    b.resolved = { revision: geometry.revision, faces: resolution.faces, signatures: resolution.faces.map(i => signatureOf(geometry.faces.find(f => f.index === i)!)) };
    for (const index of resolution.faces) {
      const face = faces.get(index) ?? { index };
      const existing = face[physics];
      if (existing && existing.boundary !== b.id) {
        issues.push({ severity: "error", code: "boundary-conflict", message: `Face ${index} has two ${physics} conditions: ${existing.boundary} (${describeCondition(existing.condition)}) and ${b.id} ${b.name} (${describeCondition(b.condition)}). Remove or narrow one.`, item: b.id });
        continue;
      }
      face[physics] = { boundary: b.id, condition: b.condition };
      faces.set(index, face);
      taken[physics].add(index);
    }
  }

  // Sources (W/m³ per solid; a total power is spread over the bodies' volume).
  const sources = new Map<number, number>();
  for (const s of study.sources) {
    const indices = new Set<number>();
    for (const ref of s.bodies) {
      const body = resolveBody(geometry, ref);
      if (!body.ok) issues.push({ severity: "error", code: "source-body", message: `Heat source ${s.id}: ${body.problem}.`, item: s.id });
      else body.solids.forEach(i => indices.add(i));
    }
    if (!indices.size) continue;
    const volume_m3 = [...indices].reduce((sum, i) => sum + geometry.solids.find(x => x.index === i)!.volume_mm3 * 1e-9, 0);
    const density = s.density ?? (s.power !== undefined && volume_m3 > 0 ? s.power / volume_m3 : 0);
    for (const i of indices) sources.set(i, (sources.get(i) ?? 0) + density);
  }
  for (const [index, density] of sources) solids.find(s => s.index === index)!.source = density;
  return { geometryRevision: geometry.revision, solids, faces, sources, issues, changes };
}

type Bound = { ok: true; faces: number[] } | { ok: false; problem: string; stale?: string };

function resolveBoundary(b: BoundaryAssignment, geometry: SimGeometry, taken: Set<number>, size: number, changes: string[]): Bound {
  const previous = b.resolved;
  const now = resolveSelector(geometry, b.selector, taken);
  if (isSemantic(b.selector) || !previous) {
    if (!now.ok) return { ok: false, problem: now.problem };
    if (previous && previous.revision !== geometry.revision) {
      const before = previous.signatures.reduce((sum, s) => sum + s.area_mm2, 0);
      const after = now.faces.reduce((sum, i) => sum + geometry.faces.find(f => f.index === i)!.area_mm2, 0);
      const same = previous.faces.join() === now.faces.join() && Math.abs(before - after) <= 1e-4 * Math.max(before, after);
      if (!same) changes.push(`${b.name}: re-resolved on revision ${geometry.revision} — faces ${previous.faces.join(", ")} → ${now.faces.join(", ")}, area ${fmt(before)} → ${fmt(after)} mm².`);
    }
    return { ok: true, faces: now.faces };
  }
  if (previous.revision === geometry.revision) return { ok: true, faces: previous.faces };
  // Picked by number or point: each face must still be the same face (it may have moved to another number).
  const mapped: number[] = [];
  const lost: FaceSignature[] = [];
  for (const sig of previous.signatures) {
    const match = geometry.faces.find(f => isExterior(f) && sameFace(sig, signatureOf(f), size));
    if (match) mapped.push(match.index);
    else lost.push(sig);
  }
  if (lost.length) {
    const what = lost.map(s => `face ${s.index} (${s.surface}, ${fmt(s.area_mm2)} mm² at [${s.center.map(fmt).join(", ")}] mm)`).join(", ");
    const stale = `the geometry changed (revision ${previous.revision} → ${geometry.revision}) and ${what} no longer exists as it was; this condition is not applied — assign it again${now.ok ? ` (the selector now finds ${describeFaces(geometry, now.faces, 3)})` : ""}.`;
    return { ok: false, problem: stale, stale };
  }
  if (mapped.join() !== previous.faces.join()) changes.push(`${b.name}: the same faces are now numbered ${mapped.join(", ")} (were ${previous.faces.join(", ")}).`);
  return { ok: true, faces: mapped };
}

const fmt = (v: number) => String(Number(v.toPrecision(5)));

/** Connected groups of solids (through shared interface faces), optionally only through solids that pass `include`. */
export function solidGroups(geometry: SimGeometry, include: (index: number) => boolean): number[][] {
  const parent = new Map<number, number>();
  const find = (i: number): number => { while (parent.get(i) !== i) i = parent.get(i)!; return i; };
  for (const s of geometry.solids) if (include(s.index)) parent.set(s.index, s.index);
  for (const f of geometry.faces) {
    if (f.solids.length !== 2 || !parent.has(f.solids[0]) || !parent.has(f.solids[1])) continue;
    parent.set(find(f.solids[0]), find(f.solids[1]));
  }
  const groups = new Map<number, number[]>();
  for (const i of parent.keys()) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return [...groups.values()];
}

export interface ValidationLimits { maxElements: number }

export function validate(study: SimulationStudy, geometry: SimGeometry | null, setup: BoundSetup | null, estimate?: { elements: number }, limits: ValidationLimits = { maxElements: 1_500_000 }): Issue[] {
  const issues: Issue[] = [];
  if (!geometry || !setup) {
    issues.push({ severity: "error", code: "geometry-missing", message: "The study has no geometry yet: model a part (cad_model) or open a FreeCAD document, then create or sync the study." });
    return issues;
  }
  issues.push(...setup.issues);
  if (!geometry.solids.length) issues.push({ severity: "error", code: "geometry-empty", message: "The analysis geometry has no solids (a simulation needs a solid body)." });
  for (const s of geometry.solids) {
    if (!(s.volume_mm3 > 0)) issues.push({ severity: "error", code: "geometry-invalid", message: `Solid ${s.index} (${s.bodyLabel}) has no volume.` });
  }
  const electric = needsPhysics(study.analysis, "electric");
  const thermal = needsPhysics(study.analysis, "thermal");
  const label = (i: number) => setup.solids.find(s => s.index === i)?.label ?? `solid ${i}`;

  // Materials and properties.
  for (const s of setup.solids) {
    if (!s.material) { issues.push({ severity: "error", code: "material-missing", message: `${s.label} has no material: assign one (e.g. copper) or give its properties.` }); continue; }
    const p = s.material.properties;
    if (study.analysis === "electric" && !p.electricConductivity) {
      issues.push({ severity: "error", code: "material-conductivity", message: `${s.label} (${s.material.name}) has no electrical conductivity; a current-conduction study needs every body to conduct — give its conductivity, or leave it out of the study's bodies.` });
    }
    if (thermal && !p.thermalConductivity) issues.push({ severity: "error", code: "material-thermal", message: `${s.label} (${s.material.name}) has no thermal conductivity.` });
    if (s.material.nominal) issues.push({ severity: "info", code: "material-nominal", message: `${s.label}: ${s.material.name} uses nominal 20 °C handbook values (constant).` });
    if (p.electricConductivity && (p.electricConductivity < 1e-12 || p.electricConductivity > 1e9)) issues.push({ severity: "warning", code: "material-range", message: `${s.label}: conductivity ${p.electricConductivity} S/m is outside the usual range of solids.` });
    if (p.thermalConductivity && (p.thermalConductivity < 0.01 || p.thermalConductivity > 3000)) issues.push({ severity: "warning", code: "material-range", message: `${s.label}: thermal conductivity ${p.thermalConductivity} W/(m·K) is outside the usual range of solids.` });
  }
  const conducts = (i: number) => Boolean(setup.solids.find(s => s.index === i)?.material?.properties.electricConductivity);

  const faceList = [...setup.faces.values()];
  const exterior = geometry.faces.filter(isExterior);
  for (const b of study.boundaries) {
    const physics = physicsOf(b.condition.type);
    if (!needsPhysics(study.analysis, physics)) {
      issues.push({ severity: "warning", code: "boundary-unused", message: `${b.name} is a ${physics} condition, which a ${study.analysis} study does not use.`, item: b.id });
    }
  }

  if (electric) {
    const terminals = faceList.filter(f => f.electric && ["voltage", "ground", "current"].includes(f.electric.condition.type));
    for (const f of terminals) {
      const face = geometry.faces.find(x => x.index === f.index)!;
      if (!face.solids.some(conducts)) issues.push({ severity: "error", code: "terminal-insulator", message: `${f.electric!.boundary}: face ${f.index} is on ${label(face.solids[0])}, which does not conduct electricity.`, item: f.electric!.boundary });
    }
    const levels = new Set<string>();
    const current = new Set<string>(), grounds = new Set<string>(), voltages = new Set<string>();
    for (const f of terminals) {
      const c = f.electric!.condition;
      if (c.type === "voltage") { levels.add(String(c.voltage)); voltages.add(f.electric!.boundary); }
      if (c.type === "ground") { levels.add("0"); grounds.add(f.electric!.boundary); }
      if (c.type === "current") current.add(f.electric!.boundary);
    }
    if (!terminals.length) {
      issues.push({ severity: "error", code: "electric-no-terminals", message: "No electrical terminals: apply a voltage (or a current) to one face and ground another." });
    } else if (current.size) {
      if (current.size > 1) issues.push({ severity: "error", code: "current-terminals", message: `Current excitation supports one current terminal and a ground; this study has ${current.size} current terminals. Use voltages for multi-terminal problems.` });
      if (!grounds.size) issues.push({ severity: "error", code: "current-no-ground", message: "A current terminal needs a grounded return terminal." });
      if (voltages.size) issues.push({ severity: "error", code: "current-with-voltage", message: "A current terminal cannot be combined with other voltage terminals (only with ground) in this version." });
    } else if (levels.size < 2) {
      issues.push({ severity: "error", code: "electric-no-difference", message: "Every terminal is at the same potential, so no current would flow: apply a different voltage to one terminal (or ground the other)." });
    }
    // Every conducting group needs a terminal with a fixed potential (else its potential is undefined).
    const dirichlet = new Set(terminals.flatMap(f => geometry.faces.find(x => x.index === f.index)!.solids));
    for (const group of solidGroups(geometry, conducts)) {
      if (!group.some(i => dirichlet.has(i))) {
        issues.push({ severity: "error", code: "floating-conductor", message: `${group.map(label).join(", ")} ${group.length > 1 ? "conduct but touch" : "conducts but touches"} no terminal, so ${group.length > 1 ? "their" : "its"} potential is undefined: add a terminal, or leave ${group.length > 1 ? "them" : "it"} out of the study.` });
      }
    }
    const insulated = exterior.filter(f => !setup.faces.get(f.index)?.electric).length;
    if (insulated) issues.push({ severity: "info", code: "default-insulated", message: `${insulated} exterior face${insulated > 1 ? "s have" : " has"} no electrical condition: insulated (no current leaves).` });
    if (study.analysis === "electrothermal" && setup.solids.some(s => s.material && !s.material.properties.electricConductivity)) {
      issues.push({ severity: "info", code: "thermal-only-bodies", message: `${setup.solids.filter(s => s.material && !s.material.properties.electricConductivity).map(s => s.label).join(", ")}: electrically insulating — heat conduction only.` });
    }
  }

  if (thermal) {
    const sinks = faceList.filter(f => f.thermal && ["temperature", "convection"].includes(f.thermal.condition.type));
    const sinkSolids = new Set(sinks.flatMap(f => geometry.faces.find(x => x.index === f.index)!.solids));
    if (!sinks.length) {
      issues.push({ severity: "error", code: "thermal-no-sink", message: "No fixed temperature or convection anywhere: in a steady state the heat has nowhere to go. Fix a temperature on a face or apply convection (e.g. to the remaining exterior faces)." });
    } else {
      for (const group of solidGroups(geometry, () => true)) {
        if (!group.some(i => sinkSolids.has(i))) issues.push({ severity: "error", code: "thermal-isolated", message: `${group.map(label).join(", ")} ${group.length > 1 ? "have" : "has"} no fixed temperature or convection and touch${group.length > 1 ? "" : "es"} nothing that does: add one.` });
      }
    }
    const loaded = study.analysis === "electrothermal" || setup.sources.size > 0 || faceList.some(f => f.thermal && ["heat_flux", "heat_flow"].includes(f.thermal.condition.type));
    const temps = new Set(faceList.filter(f => f.thermal?.condition.type === "temperature").map(f => String((f.thermal!.condition as { temperature: number }).temperature)));
    const ambients = new Set(faceList.filter(f => f.thermal?.condition.type === "convection").map(f => String((f.thermal!.condition as { ambient: number }).ambient)));
    if (!loaded && new Set([...temps, ...ambients]).size <= 1) {
      issues.push({ severity: "warning", code: "thermal-trivial", message: "No heat source, no heat flux and a single temperature: the result will be a uniform temperature." });
    }
    const adiabatic = exterior.filter(f => !setup.faces.get(f.index)?.thermal).length;
    if (adiabatic) issues.push({ severity: "info", code: "default-adiabatic", message: `${adiabatic} exterior face${adiabatic > 1 ? "s have" : " has"} no thermal condition: adiabatic (no heat leaves).` });
    for (const f of faceList) {
      const c = f.thermal?.condition;
      if (c?.type === "convection" && c.h > 1e5) issues.push({ severity: "warning", code: "convection-high", message: `${f.thermal!.boundary}: h = ${c.h} W/(m²·K) is unusually high (forced water cooling is ~10³–10⁴).`, item: f.thermal!.boundary });
      const t = c?.type === "temperature" ? c.temperature : c?.type === "convection" ? c.ambient : null;
      if (t !== null && t !== undefined && (t < 150 || t > 1500)) issues.push({ severity: "warning", code: "temperature-range", message: `${f.thermal!.boundary}: ${t} K (${(t - 273.15).toFixed(1)} °C) — check the unit (temperatures are kelvin unless "°C" is given).`, item: f.thermal!.boundary });
    }
    issues.push({ severity: "info", code: "default-reference", message: `Initial / reference temperature ${study.solver.referenceTemperature} K (${(study.solver.referenceTemperature - 273.15).toFixed(2)} °C). Material properties are constant (not temperature dependent).` });
  }
  if (study.analysis === "electrothermal") issues.push({ severity: "info", code: "coupling-one-way", message: "Coupling is sequential and one-way: the Joule heat from the electrical solution heats the thermal model; resistivity does not change with temperature." });

  if (estimate && estimate.elements > limits.maxElements) {
    issues.push({ severity: "error", code: "mesh-too-large", message: `The mesh settings would make about ${Math.round(estimate.elements).toLocaleString("en")} elements (limit ${limits.maxElements.toLocaleString("en")}): use a coarser size or local refinement instead.` });
  }
  // De-duplicate identical messages (one face reported by several checks).
  const seen = new Set<string>();
  return issues.filter(i => { const key = `${i.severity}:${i.code}:${i.message}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export const blocking = (issues: Issue[]) => issues.filter(i => i.severity === "error");
