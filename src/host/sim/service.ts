import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setupBundle } from "../../sim/bundle";
import { describeFaces, facingOf, geometryKey, isExterior, isFill, resolveBody, resolveSelector, type SimGeometry } from "../../sim/geometry";
import { meshSizing } from "../../sim/gmsh";
import { findMaterial, materialNames, type MaterialProperties } from "../../sim/materials";
import { probe as probeAt, readVtu, type ResultSummary } from "../../sim/results";
import { bind, blocking, validate, type BoundSetup, type Issue } from "../../sim/setup";
import {
  ANALYSIS_LABEL, describeCondition, newStudy, nextId, physicsOf, touch, type Condition, type ConditionType, type SimulationStudy,
} from "../../sim/study";
import { formatQuantity, toStored, type QuantityInput, type QuantityKind } from "../../sim/units";
import { bodyList, toSelector, type FacesArgument, type SimAction } from "./commands";
import { alive, isActive, makeMesh, readStatus, runJob, type JobSpec, type JobStatus, type MeshRecord } from "./job";
import { atomicWrite, readJson, SimStore } from "./store";
import { findSimTools, toolsReport, type SimTools } from "./tools";

/**
 * v0.8: the simulation service — the Aion-independent orchestration of studies (another host, such as AIPE, can drive
 * the same service): it keeps studies in a SimStore, gets the analysis geometry from the CAD backend, binds and checks
 * the setup, and runs jobs (mesh → solve → results) through the external tools. The MCP tool `simulate` is a thin layer
 * over it that also shows what it returns in the Simulation Card.
 *
 * Geometry: a study analyses one CAD document. Before anything that needs the geometry, the service asks the CAD backend
 * for the document's revision; a newer revision is exported again and the study re-bound, and what changed in its
 * regions (re-resolved faces, stale picks) is reported with the result. A closed document's last exported geometry is
 * still used, and the result says so.
 */
export interface CadBridge {
  /** The CAD documents the backend knows, with their current revisions (null: the backend is unavailable). */
  documents(): Promise<{ id: string; name: string; revision: number }[] | null>;
  /** Exports the analysis geometry of a document into a directory of the simulation workspace. */
  exportGeometry(document: string, bodies: string[] | "visible", dir: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

export interface ServiceOptions {
  root: string;
  cad: CadBridge | null;
  env?: NodeJS.ProcessEnv;
  /** The job runner (runtime/aion-sim.mjs). Absent: jobs run inside this process (tests, development). */
  runner?: string;
  limits?: { maxElements?: number; meshSeconds?: number };
}

export interface SimReply {
  ok: boolean;
  /** For Codex: what happened, in plain words (and what not). */
  message: string;
  data: Record<string, unknown>;
  study?: SimulationStudy;
  /** Something for the Simulation Card. */
  show?: { mode: "setup" | "results"; bytes: Uint8Array; title: string; revision: number; run?: number };
  /** Card commands to follow the show (field, view…). */
  card?: { command: string; value?: string | number | boolean }[];
  progress?: JobStatus;
}

const fail = (message: string, data: Record<string, unknown> = {}): SimReply => ({ ok: false, message, data });

export class SimulationService {
  readonly store: SimStore;
  private readonly maxElements: number;
  private readonly meshSeconds: number;

  constructor(private readonly options: ServiceOptions) {
    this.store = new SimStore(options.root);
    this.maxElements = options.limits?.maxElements ?? 1_500_000;
    this.meshSeconds = options.limits?.meshSeconds ?? 300;
  }

  tools(fresh = false): Promise<SimTools> { return findSimTools(this.options.env ?? process.env, process.platform, fresh); }

  /** One action. `selected` is the face picked in the Simulation Card (for "$selected"); `document` the CAD viewer's document. */
  async handle(action: SimAction, args: Record<string, unknown>, context: { study?: string; selectedFace?: number; document?: string; onProgress?: (status: JobStatus) => void } = {}): Promise<SimReply> {
    switch (action) {
      case "status": return this.status(context.study);
      case "list": return { ok: true, message: `${this.store.list().length} simulation studies.`, data: { studies: this.store.list() } };
      case "create": return this.create(args, context.document);
      default: break;
    }
    const id = context.study ?? this.store.last();
    if (!id) return fail("no-study: there is no simulation study yet. Create one (simulate create, with the analysis) on the CAD model.");
    const existing = this.store.read(id);
    if (!existing) return fail(`no-study: there is no study ${id}. ${this.store.list().length ? `Studies: ${this.store.list().map(s => `${s.id} (${s.name})`).join(", ")}.` : ""}`);
    if (action === "results" || action === "show" || action === "compare") return this.readOnly(action, existing, args);
    return this.store.locked(id, async () => {
      const study = this.store.read(id)!;
      this.store.setLast(study.id);
      const geo = await this.geometry(study, action === "sync");
      if (!geo.ok) return fail(geo.message);
      const { geometry, notes } = geo;
      switch (action) {
        case "open": case "inspect": case "validate": case "sync": return this.describe(study, geometry, notes, action, Boolean(args.faces));
        case "set_physics": return this.setPhysics(study, geometry, args, notes);
        case "set_material": return this.setMaterial(study, geometry, args, notes);
        case "set_boundary": return this.setBoundary(study, geometry, args, context.selectedFace, notes);
        case "set_source": return this.setSource(study, geometry, args, notes);
        case "remove": return this.remove(study, geometry, String(args.id), notes);
        case "set_mesh": return this.setMesh(study, geometry, args, context.selectedFace, notes);
        case "mesh": return this.mesh(study, geometry, notes);
        case "run": return this.run(study, geometry, Number(args.wait_s ?? 40), notes, context.onProgress);
        default: return fail(`unsupported: ${action}`);
      }
    });
  }

  // ── Status, creation, description ─────────────────────────────────────────────────────────────────────────────────
  private async status(studyId?: string): Promise<SimReply> {
    const tools = await this.tools(true);
    const report = toolsReport(tools);
    const id = studyId ?? this.store.last();
    const study = id ? this.store.read(id) : null;
    const active = study ? this.activeRun(study) : null;
    const data = {
      tools: { gmsh: tools.gmsh, elmerSolver: tools.elmerSolver, elmerGrid: tools.elmerGrid, problems: tools.problems },
      supported: SUPPORTED, unsupported: UNSUPPORTED,
      study: study ? { id: study.id, name: study.name, analysis: study.analysis, revision: study.revision, runs: study.results.length } : null,
      ...(active ? { running: { run: active.run, state: active.status.state, message: active.status.message } } : {}),
      studies: this.store.list().slice(0, 8),
    };
    return { ok: true, message: `${report.ready ? "The simulation tools are ready" : `Missing: ${report.missing.join(", ")}`}. ${report.lines.join(" ")}`, data };
  }

  private async create(args: Record<string, unknown>, viewerDocument?: string): Promise<SimReply> {
    if (!this.options.cad) return fail("backend-unavailable: the CAD backend (FreeCAD) is not available, so there is no geometry to analyse.");
    const documents = await this.options.cad.documents();
    if (!documents) return fail("backend-unavailable: FreeCAD is not available, so there is no geometry to analyse. Install FreeCAD 1.0 or newer.");
    const document = (args.document as string | undefined) ?? viewerDocument ?? documents[0]?.id;
    const doc = documents.find(d => d.id === document);
    if (!doc) return fail(`no-geometry: ${document ? `there is no open CAD document ${document}` : "no CAD document is open"} — model the part first (cad_model) or open a .FCStd. Open: ${documents.map(d => `${d.id} (${d.name})`).join(", ") || "none"}.`);
    const id = this.store.newId();
    const bodies = (args.bodies as string[] | undefined) ?? "visible";
    const dir = this.store.geometryDir(id, doc.revision);
    const exported = await this.options.cad.exportGeometry(doc.id, bodies, dir);
    if (!exported.ok) { rmSync(this.store.studyDir(id), { recursive: true, force: true }); return fail(`${exported.code}: ${exported.message}`); }
    const geometry = this.store.readGeometry(id, doc.revision)!;
    const analysis = args.analysis as SimulationStudy["analysis"];
    const study = newStudy(id, (args.name as string | undefined) ?? `${doc.name} — ${analysis}`, analysis, { backend: "freecad", document: doc.id, documentName: doc.name, revision: geometry.revision, bodies });
    this.store.write(study);
    return this.describe(study, geometry, [], "create", false);
  }

  /** The study's geometry for the CAD document's current revision (exported again if the document changed). */
  private async geometry(study: SimulationStudy, force = false): Promise<{ ok: true; geometry: SimGeometry; notes: string[] } | { ok: false; message: string }> {
    const notes: string[] = [];
    const stored = this.store.readGeometry(study.id, study.geometry.revision);
    const documents = this.options.cad ? await this.options.cad.documents() : null;
    const doc = documents?.find(d => d.id === study.geometry.document);
    if (!doc || (doc.revision === study.geometry.revision && stored && !force)) {
      if (!stored) return { ok: false, message: `no-geometry: the study's geometry (document ${study.geometry.document}, revision ${study.geometry.revision}) is missing and the document is not open in FreeCAD.` };
      if (!doc) notes.push(`The CAD document ${study.geometry.documentName ?? study.geometry.document} is not open, so the geometry of revision ${study.geometry.revision} is used as it was exported.`);
      return { ok: true, geometry: stored, notes };
    }
    const dir = this.store.geometryDir(study.id, doc.revision);
    const exported = await this.options.cad!.exportGeometry(doc.id, study.geometry.bodies, dir);
    if (!exported.ok) {
      if (!stored) return { ok: false, message: `${exported.code}: ${exported.message}` };
      notes.push(`The CAD model changed (revision ${doc.revision}) but its geometry could not be exported (${exported.message}); the previous revision ${study.geometry.revision} is used.`);
      return { ok: true, geometry: stored, notes };
    }
    const geometry = this.store.readGeometry(study.id, doc.revision)!;
    if (doc.revision !== study.geometry.revision) {
      notes.push(`The CAD model changed (revision ${study.geometry.revision} → ${doc.revision}); the study now analyses revision ${doc.revision}.`);
      study.geometry.revision = doc.revision;
      const setup = bind(study, geometry);
      notes.push(...setup.changes);
      for (const b of study.boundaries) if (b.stale) notes.push(`Stale — ${b.name}: ${b.stale}`);
      touch(study, `Geometry: revision ${doc.revision}`);
      this.store.write(study);
    }
    return { ok: true, geometry, notes };
  }

  private check(study: SimulationStudy, geometry: SimGeometry): { setup: BoundSetup; issues: Issue[] } {
    const setup = bind(study, geometry);
    const estimate = meshSizing(geometry, study.mesh).estimatedElements;
    return { setup, issues: validate(study, geometry, setup, { elements: estimate }, { maxElements: this.maxElements }) };
  }

  private describe(study: SimulationStudy, geometry: SimGeometry, notes: string[], action: string, allFaces: boolean): SimReply {
    const { setup, issues } = this.check(study, geometry);
    this.store.write(study);
    const errors = blocking(issues);
    const faces = geometry.faces.filter(f => allFaces || action === "create" || isExterior(f)).slice(0, allFaces ? 2000 : 80).map(f => ({
      id: f.index, ...(isExterior(f) ? {} : { interface: true }), body: f.bodyLabel, feature: f.featureLabel, surface: f.surface, ...(facingOf(f) ? { facing: facingOf(f) } : {}),
      area_mm2: round(f.area_mm2), center_mm: f.center.map(round), ...(f.radius ? { radius_mm: round(f.radius) } : {}),
      ...(setup.faces.get(f.index)?.electric ? { electric: setup.faces.get(f.index)!.electric!.boundary } : {}),
      ...(setup.faces.get(f.index)?.thermal ? { thermal: setup.faces.get(f.index)!.thermal!.boundary } : {}),
    }));
    const data = {
      study: studyData(study, setup), geometry: { document: geometry.document, name: geometry.documentName, revision: geometry.revision, bodies: geometry.bodies.map(b => ({ id: b.id, label: b.label, solids: b.solids })),
        solids: geometry.solids.map(s => ({ id: s.index, body: s.bodyLabel, volume_mm3: round(s.volume_mm3), material: setup.solids.find(x => x.index === s.index)?.material?.name ?? null })),
        faces, ...(faces.length < geometry.faces.length ? { faces_shown: faces.length, faces_total: geometry.faces.length } : {}) },
      validation: { ready: errors.length === 0, errors: errors.map(e => e.message), warnings: issues.filter(i => i.severity === "warning").map(i => i.message), defaults: issues.filter(i => i.severity === "info").map(i => i.message) },
      ...(notes.length ? { changes: notes } : {}),
    };
    const head = action === "create" ? `Created study ${study.id} "${study.name}": ${ANALYSIS_LABEL[study.analysis]} on ${geometry.documentName} (revision ${geometry.revision}), ${geometry.solids.length} solid${geometry.solids.length > 1 ? "s" : ""}, ${geometry.faces.length} faces.`
      : `Study ${study.id} "${study.name}" (revision ${study.revision}, geometry revision ${geometry.revision}).`;
    const ready = errors.length ? ` Not ready to solve: ${errors.map(e => e.message).join(" ")}` : " Ready to solve.";
    return { ok: true, message: `${head}${notes.length ? ` ${notes.join(" ")}` : ""}${ready}`, data, study, show: this.setupView(study, geometry, setup) };
  }

  private setupView(study: SimulationStudy, geometry: SimGeometry, setup: BoundSetup): SimReply["show"] {
    try {
      return { mode: "setup", bytes: setupBundle(study, geometry, setup, [`${ANALYSIS_LABEL[study.analysis]}`, `Geometry ${geometry.documentName}, revision ${geometry.revision}`]), title: study.name, revision: study.revision };
    } catch { return undefined; }
  }

  // ── Changing the setup ──────────────────────────────────────────────────────────────────────────────────────────────
  private saved(study: SimulationStudy, geometry: SimGeometry, description: string, notes: string[], extra: Record<string, unknown> = {}): SimReply {
    touch(study, description);
    const { setup, issues } = this.check(study, geometry);
    this.store.write(study);
    const errors = blocking(issues);
    return {
      ok: true, message: `${description}.${notes.length ? ` ${notes.join(" ")}` : ""}${errors.length ? ` Still needed before solving: ${errors.map(e => e.message).join(" ")}` : " The study is ready to solve."}`,
      data: { study: studyData(study, setup), validation: { ready: !errors.length, errors: errors.map(e => e.message), warnings: issues.filter(i => i.severity === "warning").map(i => i.message) }, ...extra, ...(notes.length ? { changes: notes } : {}) },
      study, show: this.setupView(study, geometry, setup),
    };
  }

  private setPhysics(study: SimulationStudy, geometry: SimGeometry, args: Record<string, unknown>, notes: string[]): SimReply {
    const said: string[] = [];
    if (args.analysis) { study.analysis = args.analysis as SimulationStudy["analysis"]; said.push(`analysis: ${ANALYSIS_LABEL[study.analysis]}`); }
    if (args.reference_temperature !== undefined) {
      const t = convert("temperature", args.reference_temperature as QuantityInput, "reference_temperature");
      if (!t.ok) return fail(`invalid-arguments: ${t.problem}. Nothing was changed.`);
      study.solver.referenceTemperature = t.value;
      said.push(`reference temperature ${t.value} K`);
    }
    if (args.linear) { study.solver.linear = args.linear as "iterative" | "direct"; said.push(`linear solver ${study.solver.linear}`); }
    if (args.tolerance) { study.solver.tolerance = args.tolerance as number; said.push(`tolerance ${study.solver.tolerance}`); }
    if (args.timeout_s) { study.solver.timeoutSeconds = args.timeout_s as number; said.push(`time limit ${study.solver.timeoutSeconds} s`); }
    return this.saved(study, geometry, `Physics: ${said.join(", ")}`, notes);
  }

  private setMaterial(study: SimulationStudy, geometry: SimGeometry, args: Record<string, unknown>, notes: string[]): SimReply {
    const refs = expandBodies(geometry, bodyList(args.bodies));
    for (const r of refs) { const b = resolveBody(geometry, r); if (!b.ok) return fail(`invalid-body: ${b.problem}. Nothing was changed.`); }
    let properties: MaterialProperties = {};
    let name = args.name as string | undefined;
    let source = "user", nominal = false;
    const inputs: Record<string, string> = {};
    if (args.material) {
      const m = findMaterial(String(args.material));
      if (!m) return fail(`unknown-material: "${args.material}" is not in Aion's library (${materialNames()}). Give its properties instead (conductivity, thermal_conductivity), from the data sheet. Nothing was changed.`);
      properties = { electricConductivity: m.electricConductivity, thermalConductivity: m.thermalConductivity, density: m.density };
      name ??= m.name;
      source = `library:${m.id}`;
      nominal = true;
      inputs.material = `${m.name} (${m.basis})`;
    }
    for (const [key, kind, prop] of [["conductivity", "conductivity", "electricConductivity"], ["thermal_conductivity", "thermalConductivity", "thermalConductivity"], ["density", "density", "density"]] as const) {
      if (args[key] === undefined) continue;
      const v = convert(kind, args[key] as QuantityInput, key);
      if (!v.ok) return fail(`invalid-arguments: ${v.problem}. Nothing was changed.`);
      if (!(v.value > 0)) return fail(`invalid-arguments: ${key} must be positive. Nothing was changed.`);
      properties[prop] = v.value;
      inputs[key] = v.input;
      if (source.startsWith("library:")) source += "+override";
    }
    if (args.resistivity !== undefined) {
      const v = convert("resistivity", args.resistivity as QuantityInput, "resistivity");
      if (!v.ok || !(v.value > 0)) return fail(`invalid-arguments: ${v.ok ? "resistivity must be positive" : v.problem}. Nothing was changed.`);
      properties.electricConductivity = 1 / v.value;
      inputs.resistivity = v.input;
    }
    if (args.insulator === true) { delete properties.electricConductivity; inputs.insulator = "electrical insulator"; }
    name ??= "User material";
    // A body takes its newest material: it leaves any earlier assignment.
    for (const m of study.materials) m.bodies = m.bodies.filter(b => !refs.some(r => sameBody(geometry, r, b)));
    study.materials = study.materials.filter(m => m.bodies.length);
    const id = nextId(study, "M");
    study.materials.push({ id, bodies: refs, name, source, properties, inputs, nominal });
    const props = [properties.electricConductivity ? `σ = ${formatQuantity(properties.electricConductivity, "S/m")}` : "electrical insulator", properties.thermalConductivity ? `k = ${properties.thermalConductivity} W/(m·K)` : null].filter(Boolean).join(", ");
    return this.saved(study, geometry, `Material ${id}: ${name} (${props}${nominal ? ", nominal 20 °C values" : ""}) on ${refs.join(", ")}`, notes, { material: { id, name, properties, source } });
  }

  private setBoundary(study: SimulationStudy, geometry: SimGeometry, args: Record<string, unknown>, selectedFace: number | undefined, notes: string[]): SimReply {
    const faces = args.faces as FacesArgument;
    let picked = false;
    let selector;
    if (faces === "$selected") {
      if (!selectedFace) return fail("no-selection: no face is selected in the Simulation Card. Ask the user to click the face, or name it (side, feature or face number from inspect). Nothing was changed.");
      selector = { faces: [selectedFace] };
      picked = true;
    } else selector = toSelector(faces);
    const type = args.type as ConditionType;
    const condition = buildCondition(type, args);
    if (!condition.ok) return fail(`invalid-arguments: ${condition.problem}. Nothing was changed.`);
    const physics = physicsOf(type);
    const others = new Set(study.boundaries.filter(b => physicsOf(b.condition.type) === physics && b.resolved && b.id !== args.replace && !isFill(b.selector)).flatMap(b => b.resolved!.faces));
    const resolution = resolveSelector(geometry, selector, others);
    if (!resolution.ok) return fail(`unresolved-faces: ${resolution.problem}. Nothing was changed — ask the user which face is meant if it is unclear.`);
    // Overlaps with earlier conditions of the same physics: "exterior"/"remaining" always yield (no change needed); a
    // newer specific assignment takes faces picked by number from an older one; a partial overlap with an older
    // selector ("left", a feature) is refused rather than guessed.
    const plan: { boundary: string; keep: number[] | null; overlap: number[] }[] = [];
    if (!isFill(selector)) {
      for (const b of study.boundaries) {
        if (b.id === args.replace || physicsOf(b.condition.type) !== physics || !b.resolved || isFill(b.selector)) continue;
        const overlap = b.resolved.faces.filter(f => resolution.faces.includes(f));
        if (!overlap.length) continue;
        const keep = b.resolved.faces.filter(f => !resolution.faces.includes(f));
        if (keep.length && !("faces" in b.selector)) {
          return fail(`conflict: face ${overlap.join(", ")} already ${overlap.length > 1 ? "have" : "has"} ${b.id} ${b.name} (${describeCondition(b.condition)}), whose selector also covers face ${keep.join(", ")}. Remove ${b.id} first, or name the faces explicitly. Nothing was changed.`);
        }
        plan.push({ boundary: b.id, keep: keep.length ? keep : null, overlap });
      }
    }
    if (args.replace && !study.boundaries.some(b => b.id === args.replace)) return fail(`unknown-id: there is no boundary ${args.replace}. Nothing was changed.`);
    const replaced: string[] = [];
    for (const step of plan) {
      const b = study.boundaries.find(x => x.id === step.boundary)!;
      if (step.keep) { b.selector = { faces: step.keep }; replaced.push(`${b.id} ${b.name} on face ${step.overlap.join(", ")}`); }
      else replaced.push(`${b.id} ${b.name}`);
    }
    study.boundaries = study.boundaries.filter(b => b.id !== args.replace && !plan.some(step => step.boundary === b.id && !step.keep));
    const id = nextId(study, "B");
    const name = (args.name as string | undefined) ?? defaultName(type, study);
    study.boundaries.push({ id, name, selector, condition: condition.condition, inputs: condition.inputs, ...(picked ? { picked: true } : {}) });
    const where = describeFaces(geometry, resolution.faces, 4);
    const overlap = replaced.length ? ` It replaces ${replaced.join(", ")} on those faces.` : "";
    return this.saved(study, geometry, `${id} ${name}: ${describeCondition(condition.condition)} on ${where}${overlap}`, notes, { boundary: { id, name, faces: resolution.faces, condition: condition.condition } });
  }

  private setSource(study: SimulationStudy, geometry: SimGeometry, args: Record<string, unknown>, notes: string[]): SimReply {
    const refs = expandBodies(geometry, bodyList(args.bodies));
    for (const r of refs) { const b = resolveBody(geometry, r); if (!b.ok) return fail(`invalid-body: ${b.problem}. Nothing was changed.`); }
    const id = nextId(study, "Q");
    if (args.power_density !== undefined) {
      const v = convert("powerDensity", args.power_density as QuantityInput, "power_density");
      if (!v.ok) return fail(`invalid-arguments: ${v.problem}. Nothing was changed.`);
      study.sources.push({ id, bodies: refs, density: v.value, inputs: { power_density: v.input } });
      return this.saved(study, geometry, `${id}: heat source ${formatQuantity(v.value, "W/m³")} in ${refs.join(", ")}`, notes);
    }
    const v = convert("power", args.power as QuantityInput, "power");
    if (!v.ok) return fail(`invalid-arguments: ${v.problem}. Nothing was changed.`);
    study.sources.push({ id, bodies: refs, power: v.value, inputs: { power: v.input } });
    return this.saved(study, geometry, `${id}: heat source ${formatQuantity(v.value, "W")} spread uniformly over ${refs.join(", ")}`, notes);
  }

  private remove(study: SimulationStudy, geometry: SimGeometry, id: string, notes: string[]): SimReply {
    const lists = [["materials", study.materials], ["boundaries", study.boundaries], ["sources", study.sources], ["refinements", study.mesh.refine]] as const;
    for (const [, list] of lists) {
      const index = (list as { id: string }[]).findIndex(x => x.id === id);
      if (index >= 0) { (list as { id: string }[]).splice(index, 1); return this.saved(study, geometry, `Removed ${id}`, notes); }
    }
    return fail(`unknown-id: there is no material, boundary, source or refinement ${id}. Nothing was changed.`);
  }

  private setMesh(study: SimulationStudy, geometry: SimGeometry, args: Record<string, unknown>, selectedFace: number | undefined, notes: string[]): SimReply {
    const said: string[] = [];
    if (args.auto) { delete study.mesh.max_mm; delete study.mesh.min_mm; delete study.mesh.curvature; said.push("sizes from the preset"); }
    if (args.size) { study.mesh.size = args.size as SimulationStudy["mesh"]["size"]; delete study.mesh.max_mm; said.push(`size ${study.mesh.size}`); }
    if (args.max_mm) { study.mesh.max_mm = args.max_mm as number; said.push(`max ${study.mesh.max_mm} mm`); }
    if (args.min_mm) { study.mesh.min_mm = args.min_mm as number; said.push(`min ${study.mesh.min_mm} mm`); }
    if (args.curvature) { study.mesh.curvature = args.curvature as number; said.push(`${study.mesh.curvature} elements per circle`); }
    if (args.order) { study.mesh.order = args.order as 1 | 2; said.push(`order ${study.mesh.order}`); }
    if (args.clear_refinement) { study.mesh.refine = []; said.push("no local refinement"); }
    if (args.refine) {
      const r = args.refine as { faces?: FacesArgument; bodies?: unknown; size_mm: number };
      let selector;
      if (r.faces !== undefined) {
        if (r.faces === "$selected") { if (!selectedFace) return fail("no-selection: no face is selected in the Simulation Card. Nothing was changed."); selector = { faces: [selectedFace] }; }
        else selector = toSelector(r.faces);
        const res = resolveSelector(geometry, selector);
        if (!res.ok) return fail(`unresolved-faces: ${res.problem}. Nothing was changed.`);
      }
      const bodies = r.bodies !== undefined ? expandBodies(geometry, bodyList(r.bodies)) : undefined;
      for (const b of bodies ?? []) { const x = resolveBody(geometry, b); if (!x.ok) return fail(`invalid-body: ${x.problem}. Nothing was changed.`); }
      const id = nextId(study, "R");
      study.mesh.refine.push({ id, ...(selector ? { selector } : {}), ...(bodies ? { bodies } : {}), size_mm: r.size_mm });
      said.push(`${id}: ${r.size_mm} mm locally`);
    }
    const sizing = meshSizing(geometry, study.mesh);
    return this.saved(study, geometry, `Mesh: ${said.join(", ")}`, notes, { mesh: { ...study.mesh, sizing: { max_mm: round(sizing.max_mm), min_mm: round(sizing.min_mm), curvature: sizing.curvature, estimated_elements: Math.round(sizing.estimatedElements) } } });
  }

  // ── Meshing and running ─────────────────────────────────────────────────────────────────────────────────────────────
  private jobInputs(study: SimulationStudy, geometry: SimGeometry) {
    const sizing = meshSizing(geometry, study.mesh);
    const refine = study.mesh.refine.map(r => {
      const faces = r.selector ? (() => { const res = resolveSelector(geometry, r.selector!); return res.ok ? res.faces : []; })() : undefined;
      const solids = r.bodies ? r.bodies.flatMap(b => { const x = resolveBody(geometry, b); return x.ok ? x.solids : []; }) : undefined;
      return { ...(faces?.length ? { faces } : {}), ...(solids?.length ? { solids } : {}), size_mm: r.size_mm };
    }).filter(r => r.faces || r.solids);
    const meshId = `m-${createHash("sha256").update(JSON.stringify([geometryKey(geometry), sizing, study.mesh.order, refine])).digest("hex").slice(0, 12)}`;
    return { sizing, refine, meshId };
  }

  private async toolPaths(): Promise<{ ok: true; tools: JobSpec["tools"] } | { ok: false; reply: SimReply }> {
    const tools = await this.tools();
    const report = toolsReport(tools);
    if (!report.ready) return { ok: false, reply: fail(`backend-unavailable: ${report.lines.filter(l => !/^(Gmsh|Elmer) \d/.test(l)).join(" ")} Nothing was solved.`, { missing: report.missing }) };
    return { ok: true, tools: { gmsh: tools.gmsh!.path, gmshVersion: tools.gmsh!.version, elmerSolver: tools.elmerSolver!.path, elmerGrid: tools.elmerGrid!.path, elmerVersion: tools.elmerSolver!.version, elmerHome: tools.elmerHome } };
  }

  private async mesh(study: SimulationStudy, geometry: SimGeometry, notes: string[]): Promise<SimReply> {
    const tools = await this.toolPaths();
    if (!tools.ok) return tools.reply;
    const { sizing, refine, meshId } = this.jobInputs(study, geometry);
    if (sizing.estimatedElements > this.maxElements) return fail(`mesh-too-large: about ${Math.round(sizing.estimatedElements).toLocaleString("en")} elements expected (limit ${this.maxElements.toLocaleString("en")}). Use a coarser size.`);
    const geometryDir = this.store.geometryDir(study.id, geometry.revision);
    const made = await makeMesh({ meshDir: this.store.meshDir(study.id, meshId), meshId, brepFile: join(geometryDir, "geometry.brep"), sizing, refine, tools: tools.tools, limits: { meshSeconds: this.meshSeconds, maxElements: this.maxElements }, study }, geometry);
    if (!made.ok) return fail(`mesh-failed: ${made.message}`, { details: made.details, log: made.log });
    return { ok: true, message: `${made.reused ? "The same mesh exists" : `Gmsh ${tools.tools.gmshVersion} meshed it in ${made.seconds.mesh.toFixed(1)} s`}: ${meshText(made.mesh)}${notes.length ? ` ${notes.join(" ")}` : ""}`, data: { mesh: meshData(made.mesh), reused: made.reused } };
  }

  private activeRun(study: SimulationStudy): { run: number; dir: string; status: JobStatus } | null {
    const runs = join(this.store.studyDir(study.id), "runs");
    if (!existsSync(runs)) return null;
    const last = Math.max(0, ...study.results.map(r => r.run));
    for (let run = last + 1; run <= last + 3; run++) {
      const dir = this.store.runDir(study.id, run);
      const status = readStatus(dir);
      if (status && isActive(status) && alive(status.pid)) return { run, dir, status };
    }
    return null;
  }

  private async run(study: SimulationStudy, geometry: SimGeometry, waitSeconds: number, notes: string[], onProgress?: (status: JobStatus) => void): Promise<SimReply> {
    const active = this.activeRun(study);
    if (active) return { ok: true, message: `Run ${active.run} is still going (${active.status.message}). Ask for results when it is done.`, data: { run: active.run, status: active.status }, progress: active.status };
    const { setup, issues } = this.check(study, geometry);
    const errors = blocking(issues);
    if (errors.length) return { ...fail(`not-ready: the study cannot be solved yet — ${errors.map(e => e.message).join(" ")} Nothing was solved.`, { errors: errors.map(e => e.message) }), study, show: this.setupView(study, geometry, setup) };
    const tools = await this.toolPaths();
    if (!tools.ok) return tools.reply;
    const { sizing, refine, meshId } = this.jobInputs(study, geometry);
    const run = Math.max(0, ...study.results.map(r => r.run), ...existingRuns(this.store, study.id)) + 1;
    const runDir = this.store.runDir(study.id, run);
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const geometryDir = this.store.geometryDir(study.id, geometry.revision);
    const spec: JobSpec = {
      format: "aion.sim.job/1", study, run, geometryFile: join(geometryDir, "geometry.json"), brepFile: join(geometryDir, "geometry.brep"),
      meshId, meshDir: this.store.meshDir(study.id, meshId), runDir, sizing, refine, tools: tools.tools,
      limits: { meshSeconds: this.meshSeconds, maxElements: this.maxElements },
    };
    atomicWrite(join(runDir, "job.json"), JSON.stringify(spec));
    atomicWrite(join(runDir, "status.json"), JSON.stringify({ state: "queued", message: "Queued.", started: new Date().toISOString(), updated: new Date().toISOString() } satisfies JobStatus));
    let inline: Promise<JobStatus> | null = null;
    if (this.options.runner && existsSync(this.options.runner)) {
      const child = spawn(process.execPath, [this.options.runner, "job", runDir], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...this.options.env } });
      child.unref();
    } else inline = runJob(spec);
    // Wait (bounded) for the job, reporting its stages.
    const until = Date.now() + Math.max(0, waitSeconds) * 1000;
    let last = "";
    let status: JobStatus | null = null;
    for (;;) {
      status = readStatus(runDir);
      if (status && status.message !== last) { last = status.message; onProgress?.(status); }
      if (status && !isActive(status)) break;
      if (Date.now() > until && !inline) break;
      if (inline && Date.now() > until) { status = await inline; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!status || isActive(status)) {
      return { ok: true, message: `Run ${run} started and is still going after ${waitSeconds} s (${status?.message ?? "starting"}). It continues in the background: ask for the results (simulate results) in a moment.${notes.length ? ` ${notes.join(" ")}` : ""}`, data: { run, status }, progress: status ?? undefined };
    }
    const reply = this.finish(study, run, status);
    if (notes.length) reply.message = `${notes.join(" ")} ${reply.message}`;
    return reply;
  }

  /** Records a finished run on the study (once) and returns its result. */
  private finish(study: SimulationStudy, run: number, status: JobStatus): SimReply {
    const runDir = this.store.runDir(study.id, run);
    const spec = readJson<JobSpec>(join(runDir, "job.json"));
    if (status.state === "failed") {
      if (!study.results.some(r => r.run === run)) {
        study.results.push({ run, studyRevision: spec?.study.revision ?? study.revision, geometryRevision: spec?.study.geometry.revision ?? study.geometry.revision, meshId: spec?.meshId ?? "", created: status.updated, status: "failed", headline: {}, problem: status.message.slice(0, 300) });
        this.store.write(study);
      }
      const e = status.error;
      return fail(`solve-failed: run ${run} failed at the ${e?.stage ?? "?"} stage — ${status.message}${e?.details?.length ? ` (${e.details.slice(0, 4).join("; ")})` : ""}. No result was produced; say so plainly.`, { run, error: e });
    }
    const summary = readJson<ResultSummary & { headline: Record<string, number> }>(join(runDir, "summary.json"));
    if (!summary) return fail(`solve-failed: run ${run} finished but its summary is missing.`);
    if (!study.results.some(r => r.run === run)) {
      study.results.push({ run, studyRevision: summary.studyRevision, geometryRevision: summary.geometry.revision, meshId: summary.meshId, created: summary.created, status: "solved", headline: summary.headline });
      this.store.write(study);
      this.store.prune(study.id);
    }
    return this.resultReply(study, run, summary, status);
  }

  private resultReply(study: SimulationStudy, run: number, summary: ResultSummary & { headline?: Record<string, number> }, status?: JobStatus | null, field?: string): SimReply {
    const runDir = this.store.runDir(study.id, run);
    const bundlePath = join(runDir, "field.afr");
    const bytes = existsSync(bundlePath) ? new Uint8Array(readFileSync(bundlePath)) : null;
    const stale = summary.studyRevision !== study.revision ? ` This result is from study revision ${summary.studyRevision}; the setup has changed since (revision ${study.revision}) — run again for the current setup.` : "";
    const fields = summary.fields.map(f => ({ id: f.id, name: f.name, unit: f.unit, min: f.min, max: f.max, min_at_mm: f.minAt, max_at_mm: f.maxAt, location: "nodal" }));
    const data = {
      run, study: study.id, studyRevision: summary.studyRevision, geometry: summary.geometry, mesh: summary.mesh, meshId: summary.meshId,
      electric: summary.electric, thermal: summary.thermal, fields, notes: summary.notes, solver: summary.solver,
      ...(status?.seconds ? { seconds: status.seconds, meshReused: status.meshReused } : {}),
      files: { vtu: join(runDir, "results", "result_t0001.vtu"), sif: join(runDir, "case.sif"), log: join(runDir, "solver.log") },
    };
    const card = field ? [{ command: "set-field", value: field }] : undefined;
    return {
      ok: true, message: `Run ${run} solved (Elmer ${summary.solver.version ?? ""}, ${summary.mesh.tetrahedra.toLocaleString("en")} elements): ${headlineText(summary)}.${summary.notes.length ? ` Notes: ${summary.notes.join(" ")}` : ""}${stale} Report only these computed values, with their units; field values are nodal.`,
      data, study, ...(bytes ? { show: { mode: "results" as const, bytes, title: `${study.name} — run ${run}`, revision: summary.studyRevision, run } } : {}), ...(card ? { card } : {}),
    };
  }

  private readOnly(action: SimAction, study: SimulationStudy, args: Record<string, unknown>): SimReply {
    // A run that finished after its tool call returned is recorded now.
    const active = this.activeRun(study);
    for (const run of existingRuns(this.store, study.id)) {
      if (study.results.some(r => r.run === run)) continue;
      const status = readStatus(this.store.runDir(study.id, run));
      if (status && !isActive(status)) this.finish(study, run, status);
    }
    if (action === "compare") return this.compare(study, args.runs as [number, number] | undefined);
    const solved = study.results.filter(r => r.status === "solved");
    if (action === "show" && args.setup) {
      const geometry = this.store.readGeometry(study.id, study.geometry.revision);
      if (!geometry) return fail("no-geometry: the study's geometry is missing.");
      return this.describe(study, geometry, [], "inspect", false);
    }
    const run = (args.run as number | undefined) ?? solved[solved.length - 1]?.run;
    if (!run) {
      if (active) return { ok: true, message: `Run ${active.run} is still going (${active.status.message}).`, data: { run: active.run, status: active.status }, progress: active.status };
      const failed = study.results[study.results.length - 1];
      return fail(`no-results: the study has no solved run yet${failed?.status === "failed" ? ` (run ${failed.run} failed: ${failed.problem})` : ""}. Run it first.`);
    }
    const record = study.results.find(r => r.run === run);
    if (!record) return fail(`no-results: there is no run ${run} (runs: ${study.results.map(r => `${r.run} ${r.status}`).join(", ") || "none"}).`);
    if (record.status === "failed") return fail(`no-results: run ${run} failed: ${record.problem}`);
    const runDir = this.store.runDir(study.id, run);
    const summary = readJson<ResultSummary & { headline: Record<string, number> }>(join(runDir, "summary.json"));
    if (!summary) return fail(`no-results: the summary of run ${run} is missing.`);
    if (action === "results" && args.probe) {
      const vtu = join(runDir, "results", "result_t0001.vtu");
      if (!existsSync(vtu)) return fail(`no-results: run ${run}'s result file was pruned (only the last runs keep theirs); run it again to probe.`);
      const p = probeAt(readVtu(readFileSync(vtu, "utf8")), args.probe as [number, number, number]);
      const values = Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => Number(x.toPrecision(5))) : Number(v.toPrecision(5))]));
      return { ok: true, message: `At [${p.point_mm.join(", ")}] mm (run ${run}): ${p.inside ? `inside solid ${p.solid}` : "outside the solids"} — ${p.method}.`, data: { run, probe: { ...p, values } } };
    }
    const reply = this.resultReply(study, run, summary, null, args.field as string | undefined);
    if (action === "results") delete reply.show;
    return reply;
  }

  private compare(study: SimulationStudy, runs?: [number, number]): SimReply {
    const solved = study.results.filter(r => r.status === "solved");
    const [a, b] = runs ?? [solved[solved.length - 2]?.run, solved[solved.length - 1]?.run];
    const ra = solved.find(r => r.run === a), rb = solved.find(r => r.run === b);
    if (!ra || !rb) return fail(`no-results: comparing needs two solved runs (solved: ${solved.map(r => r.run).join(", ") || "none"}).`);
    const keys = [...new Set([...Object.keys(ra.headline), ...Object.keys(rb.headline)])];
    const rows = keys.map(k => {
      const x = ra.headline[k], y = rb.headline[k];
      return { quantity: k, [`run_${a}`]: x, [`run_${b}`]: y, ...(x !== undefined && y !== undefined && x !== 0 ? { change_percent: Number((((y - x) / Math.abs(x)) * 100).toPrecision(4)) } : {}) };
    });
    const sa = readJson<JobSpec>(join(this.store.runDir(study.id, a), "job.json"))?.study, sb = readJson<JobSpec>(join(this.store.runDir(study.id, b), "job.json"))?.study;
    const differences: string[] = [];
    if (ra.geometryRevision !== rb.geometryRevision) differences.push(`geometry revision ${ra.geometryRevision} → ${rb.geometryRevision}`);
    if (ra.meshId !== rb.meshId) differences.push("a different mesh");
    if (sa && sb) {
      if (JSON.stringify(sa.materials.map(m => [m.bodies, m.properties])) !== JSON.stringify(sb.materials.map(m => [m.bodies, m.properties]))) differences.push("materials changed");
      if (JSON.stringify(sa.boundaries.map(x => [x.selector, x.condition])) !== JSON.stringify(sb.boundaries.map(x => [x.selector, x.condition]))) differences.push("boundary conditions changed");
      if (JSON.stringify(sa.sources) !== JSON.stringify(sb.sources)) differences.push("heat sources changed");
      if (JSON.stringify(sa.mesh) !== JSON.stringify(sb.mesh)) differences.push(`mesh settings ${sa.mesh.size} → ${sb.mesh.size}`);
    }
    return { ok: true, message: `Run ${a} vs run ${b}: ${differences.join(", ") || "same setup"}.`, data: { runs: [a, b], differences, rows } };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const SUPPORTED = [
  "stationary current conduction (DC): potential, electric field, current density, Joule heat; voltage, ground or one current terminal; resistance, terminal currents, losses",
  "steady-state heat conduction: fixed temperature, convection, heat flux / heat flow, volumetric heat sources; temperature, heat flux, heat balance",
  "electro-thermal: Joule heat from the electrical solution as the thermal source (sequential, one-way)",
  "constant, isotropic material properties; several touching bodies with different materials; electrical insulators in electro-thermal studies",
];
export const UNSUPPORTED = [
  "transient (time-dependent) analysis", "temperature-dependent or anisotropic properties", "two-way (iterative) electro-thermal coupling",
  "AC, eddy currents, skin and proximity effect, magnetic fields", "radiation", "fluid flow / CFD", "contact resistance between bodies", "structural / thermal stress",
];

const round = (v: number) => Number(v.toPrecision(5));

function convert(kind: QuantityKind, value: QuantityInput, key: string) {
  const v = toStored(kind, value);
  return v.ok ? v : { ok: false as const, problem: `${key}: ${v.problem}` };
}

function buildCondition(type: ConditionType, args: Record<string, unknown>): { ok: true; condition: Condition; inputs: Record<string, string> } | { ok: false; problem: string } {
  const inputs: Record<string, string> = {};
  const need = (key: string, kind: QuantityKind): number | string => {
    if (args[key] === undefined) return `a ${type} condition needs ${key}`;
    const v = convert(kind, args[key] as QuantityInput, key);
    if (!v.ok) return v.problem;
    inputs[key] = v.input;
    return v.value;
  };
  const extra = ["voltage", "current", "temperature", "h", "ambient", "flux", "power"].filter(k => args[k] !== undefined);
  const allowed: Record<ConditionType, string[]> = { voltage: ["voltage"], ground: [], current: ["current"], insulated: [], temperature: ["temperature"], convection: ["h", "ambient"], heat_flux: ["flux"], heat_flow: ["power"], adiabatic: [] };
  const wrong = extra.filter(k => !allowed[type].includes(k));
  if (wrong.length) return { ok: false, problem: `${wrong.join(", ")} ${wrong.length > 1 ? "do" : "does"} not belong to a ${type} condition (it takes ${allowed[type].join(", ") || "no value"})` };
  const values: Record<string, number> = {};
  for (const [key, kind] of ({ voltage: [["voltage", "voltage"]], current: [["current", "current"]], temperature: [["temperature", "temperature"]], convection: [["h", "heatTransfer"], ["ambient", "temperature"]], heat_flux: [["flux", "heatFlux"]], heat_flow: [["power", "power"]] } as Record<string, [string, QuantityKind][]>)[type] ?? []) {
    const v = need(key, kind);
    if (typeof v === "string") return { ok: false, problem: v };
    values[key] = v;
  }
  let condition: Condition;
  switch (type) {
    case "voltage": condition = { type, voltage: values.voltage }; break;
    case "current": if (values.current === 0) return { ok: false, problem: "a terminal current must not be 0" }; condition = { type, current: values.current }; break;
    case "temperature": if (!(values.temperature > 0)) return { ok: false, problem: "temperature must be above 0 K" }; condition = { type, temperature: values.temperature }; break;
    case "convection": if (!(values.h > 0) || !(values.ambient > 0)) return { ok: false, problem: "h must be positive and ambient above 0 K" }; condition = { type, h: values.h, ambient: values.ambient }; break;
    case "heat_flux": condition = { type, flux: values.flux }; break;
    case "heat_flow": condition = { type, power: values.power }; break;
    default: condition = { type } as Condition;
  }
  return { ok: true, condition, inputs };
}

function defaultName(type: ConditionType, study: SimulationStudy): string {
  const names: Record<ConditionType, string> = { voltage: "Terminal", ground: "Ground", current: "Current terminal", insulated: "Insulated", temperature: "Fixed temperature", convection: "Convection", heat_flux: "Heat flux", heat_flow: "Heat input", adiabatic: "Adiabatic" };
  const base = names[type];
  const used = study.boundaries.filter(b => b.name.startsWith(base)).length;
  return used ? `${base} ${used + 1}` : base;
}

function expandBodies(geometry: SimGeometry, refs: string[]): string[] {
  return refs.includes("all") ? geometry.bodies.map(b => b.id) : refs;
}

function sameBody(geometry: SimGeometry, a: string, b: string): boolean {
  const x = resolveBody(geometry, a), y = resolveBody(geometry, b);
  return x.ok && y.ok && x.solids.join() === y.solids.join();
}

function existingRuns(store: SimStore, id: string): number[] {
  const dir = join(store.studyDir(id), "runs");
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir).filter(n => /^\d{4}$/.test(n)).map(Number); } catch { return []; }
}


function studyData(study: SimulationStudy, setup: BoundSetup) {
  return {
    id: study.id, name: study.name, revision: study.revision, analysis: study.analysis,
    geometry: { document: study.geometry.document, revision: study.geometry.revision, bodies: study.geometry.bodies },
    materials: study.materials.map(m => ({ id: m.id, name: m.name, bodies: m.bodies, ...m.properties, source: m.source, nominal: m.nominal })),
    boundaries: study.boundaries.map(b => ({ id: b.id, name: b.name, condition: describeCondition(b.condition), faces: b.resolved?.faces ?? [], selector: b.selector, ...(b.stale ? { stale: b.stale } : {}), ...(b.picked ? { picked: true } : {}) })),
    sources: study.sources.map(s => ({ id: s.id, bodies: s.bodies, ...(s.density !== undefined ? { power_density_W_per_m3: s.density } : {}), ...(s.power !== undefined ? { power_W: s.power } : {}) })),
    mesh: study.mesh, solver: study.solver,
    runs: study.results.slice(-6).map(r => ({ run: r.run, status: r.status, studyRevision: r.studyRevision, ...(r.problem ? { problem: r.problem } : {}), ...r.headline })),
    unassigned_solids: setup.solids.filter(s => !s.material).map(s => s.label),
  };
}

function meshData(mesh: MeshRecord) {
  return { id: mesh.id, nodes: mesh.stats.nodes, tetrahedra: mesh.stats.tetrahedra, triangles: mesh.stats.triangles, order: mesh.order, quality: mesh.stats.quality,
    edge_mm: { min: round(mesh.stats.minEdge_mm), max: round(mesh.stats.maxEdge_mm) }, sizing: { max_mm: round(mesh.sizing.max_mm), min_mm: round(mesh.sizing.min_mm), curvature: mesh.sizing.curvature }, gmsh: mesh.gmsh, warnings: mesh.warnings };
}

function meshText(mesh: MeshRecord): string {
  return `${mesh.stats.nodes.toLocaleString("en")} nodes, ${mesh.stats.tetrahedra.toLocaleString("en")} tetrahedra (order ${mesh.order}, max size ${round(mesh.sizing.max_mm)} mm), quality min ${mesh.stats.quality.min.toFixed(2)} / mean ${mesh.stats.quality.mean.toFixed(2)}${mesh.stats.quality.below01 ? `, ${mesh.stats.quality.below01} poor elements` : ""}.`;
}

function headlineText(s: ResultSummary): string {
  const parts: string[] = [];
  const e = s.electric, t = s.thermal;
  if (e) {
    if (e.resistance_ohm !== undefined) parts.push(`R = ${formatQuantity(e.resistance_ohm, "Ω")}`);
    if (e.current_A !== undefined) parts.push(`I = ${formatQuantity(e.current_A, "A")} at ΔV = ${formatQuantity(e.voltage_V!, "V")}`);
    parts.push(`Joule loss ${formatQuantity(e.joule_W, "W")}`);
    const j = s.fields.find(f => f.id === "current_density");
    if (j) parts.push(`peak |J| ${formatQuantity(j.max, "A/m²")} (nodal) at [${j.maxAt.join(", ")}] mm`);
  }
  if (t) parts.push(`T ${(t.min_K - 273.15).toFixed(2)}–${(t.max_K - 273.15).toFixed(2)} °C (max at [${t.maxAt.join(", ")}] mm), heat balance within ${(t.balance.relativeError * 100).toPrecision(2)} %`);
  return parts.join("; ");
}
