import type { SimGeometry } from "./geometry";
import type { BoundSetup } from "./setup";
import { needsPhysics, type SimulationStudy } from "./study";

/**
 * v0.8 Simulation Core: the Elmer FEM solver input (SIF) for a validated study, and what is read back from Elmer's log.
 *
 * Generated, never hand-written, from the bound setup; every keyword is one Elmer 26.2 documents and uses in its own
 * test cases (fem/tests: StatCurrentVec, ThermalActuator, ComponentResistance):
 *
 *   Static Current  StatCurrentSolveVec — potential φ, −σ∇φ (Volume Current), −∇φ (Electric Field), σ|∇φ|² (Joule
 *                   Heating), nodal reaction currents (Potential Loads); a terminal current via Current Control.
 *   Heat Equation   HeatSolve — temperature, with "Joule Heat = True" (σ|∇φ|² evaluated from the potential at each
 *                   integration point) and "Volumetric Heat Source" (W/m³); nodal reaction heat (Temperature Loads).
 *   Heat Flux       FluxSolver — −k∇T projected to the nodes (Temperature Flux).
 *   SaveScalars     extrema and Elmer's own integrals (RES: Total Joule Heating, RES: Effective Resistance).
 *   ResultOutput    VTU (ASCII) with geometry ids: bodies are solids, boundaries are CAD faces.
 *
 * The mesh is in metres and every value SI. Each CAD face gets its own Elmer boundary condition (with its face number
 * as "Geometry Id", so every result triangle names its CAD face); a face without a condition has Elmer's natural
 * condition: electrically insulated, thermally adiabatic. Electrical insulators (no conductivity) take part in the heat
 * equation only.
 */
export interface SifOptions { meshDir: string; meshName: string; resultsDir: string; order: 1 | 2 }

const PATH_OK = /^[A-Za-z0-9_./-]{1,200}$/;

export function buildSif(study: SimulationStudy, geometry: SimGeometry, setup: BoundSetup, options: SifOptions): string {
  const electric = needsPhysics(study.analysis, "electric");
  const thermal = needsPhysics(study.analysis, "thermal");
  const num = (v: number) => {
    if (!Number.isFinite(v)) throw new Error(`non-finite value in the solver input: ${v}`);
    return v.toPrecision(12).replace(/\.?0+e/, "e").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  };
  const text = (s: string) => `"${s.replace(/["\n\r]/g, " ").slice(0, 60)}"`;
  const out: string[] = [];
  const section = (title: string, body: string[]) => { out.push(title, ...body.map(line => `  ${line}`), "End", ""); };
  const linear = (method: string) => study.solver.linear === "direct"
    ? ["Linear System Solver = Direct", "Linear System Direct Method = UMFPACK"]
    : ["Linear System Solver = Iterative", `Linear System Iterative Method = ${method}`, "Linear System Preconditioning = ILU1",
      `Linear System Max Iterations = ${study.solver.maxIterations}`, `Linear System Convergence Tolerance = ${num(study.solver.tolerance)}`,
      "Linear System Abort Not Converged = True", "Linear System Residual Output = 25"];

  out.push("! Aion Presence — generated Elmer input (v0.8). Do not edit: Aion writes a new one for every run.",
    `! Study ${study.id} revision ${study.revision}: ${study.analysis}; geometry ${geometry.document} revision ${geometry.revision}.`, "",
    'Check Keywords "Warn"', "");
  for (const p of [options.meshDir, options.meshName, options.resultsDir]) if (!PATH_OK.test(p)) throw new Error(`unsafe path in the solver input: ${p}`);
  section("Header", [`Mesh DB "${options.meshDir}" "${options.meshName}"`, `Results Directory "${options.resultsDir}"`]);
  section("Simulation", ["Max Output Level = 5", "Coordinate System = Cartesian 3D", "Simulation Type = Steady State",
    "Steady State Max Iterations = 1", "Output Intervals(1) = 1"]);

  // Solvers, numbered in execution order.
  const solvers: { id: string; body: string[] }[] = [];
  if (electric) {
    const current = [...setup.faces.values()].map(f => f.electric?.condition).find(c => c?.type === "current");
    solvers.push({ id: "electric", body: [
      'Equation = "Static Current"', 'Procedure = "StatCurrentSolveVec" "StatCurrentSolver"', "Variable = Potential",
      "Calculate Volume Current = True", "Calculate Electric Field = True", "Calculate Joule Heating = True", "Calculate Loads = True",
      ...(current?.type === "current" ? [`Current Control = Real ${num(current.current)}`] : []),
      ...linear("BiCGStab"), "Nonlinear System Max Iterations = 1", "Steady State Convergence Tolerance = 1.0e-6",
    ] });
  }
  if (thermal) {
    solvers.push({ id: "heat", body: [
      'Equation = "Heat Equation"', 'Procedure = "HeatSolve" "HeatSolver"', "Variable = Temperature", "Calculate Loads = True",
      ...linear("BiCGStab"), "Nonlinear System Max Iterations = 1", "Steady State Convergence Tolerance = 1.0e-6",
    ] });
    solvers.push({ id: "flux", body: [
      'Equation = "Heat Flux"', 'Procedure = "FluxSolver" "FluxSolver"', "Calculate Flux = True", "Flux Variable = Temperature",
      'Flux Coefficient = "Heat Conductivity"', ...linear("CG").filter(l => !l.startsWith("Linear System Abort")),
    ] });
  }
  const scalars: string[] = [];
  if (electric) scalars.push("Potential:max", "Potential:min");
  if (thermal) scalars.push("Temperature:max", "Temperature:min");
  solvers.push({ id: "scalars", body: ["Exec Solver = After All", 'Equation = "Save Scalars"', 'Procedure = "SaveData" "SaveScalars"', 'Filename = "scalars.dat"',
    ...scalars.flatMap((s, i) => { const [variable, op] = s.split(":"); return [`Variable ${i + 1} = ${variable}`, `Operator ${i + 1} = ${op}`]; })] });
  solvers.push({ id: "output", body: ["Exec Solver = After All", 'Equation = "Result Output"', 'Procedure = "ResultOutputSolve" "ResultOutputSolver"',
    'Output File Name = "result"', 'Output Format = "vtu"', "Ascii Output = True", "Save Geometry Ids = True",
    ...(options.order === 2 ? ["Save Linear Elements = True"] : [])] });
  const number = (id: string) => solvers.findIndex(s => s.id === id) + 1;

  // Equations: conductors (every physics) and, in electro-thermal studies, insulators (heat only).
  const conductorSolvers = [electric && "electric", thermal && "heat", thermal && "flux"].filter(Boolean).map(id => number(id as string));
  const insulatorSolvers = thermal ? [number("heat"), number("flux")] : [];
  section("Equation 1", [`Name = "Conductor"`, `Active Solvers(${conductorSolvers.length}) = ${conductorSolvers.join(" ")}`]);
  const insulators = study.analysis === "electrothermal" && setup.solids.some(s => !s.material?.properties.electricConductivity);
  if (insulators) section("Equation 2", [`Name = "Heat only"`, `Active Solvers(${insulatorSolvers.length}) = ${insulatorSolvers.join(" ")}`]);

  // Materials (one per assignment in use).
  const materials = new Map<string, number>();
  for (const s of setup.solids) {
    if (!s.material || materials.has(s.material.id)) continue;
    const p = s.material.properties;
    const n = materials.size + 1;
    materials.set(s.material.id, n);
    section(`Material ${n}`, [`Name = ${text(s.material.name)}`,
      ...(electric && p.electricConductivity ? [`Electric Conductivity = ${num(p.electricConductivity)}`] : []),
      ...(thermal && p.thermalConductivity ? [`Heat Conductivity = ${num(p.thermalConductivity)}`] : []),
      ...(p.density ? [`Density = ${num(p.density)}`] : [])]);
  }

  // Body forces: Joule heat in conductors (electro-thermal) and user heat sources.
  let forces = 0;
  const bodyForce = new Map<number, number>();
  for (const s of setup.solids) {
    const joule = study.analysis === "electrothermal" && Boolean(s.material?.properties.electricConductivity);
    const source = thermal ? setup.sources.get(s.index) : undefined;
    if (!joule && !source) continue;
    forces++;
    bodyForce.set(s.index, forces);
    section(`Body Force ${forces}`, [...(joule ? ["Joule Heat = True"] : []), ...(source ? [`Volumetric Heat Source = ${num(source)}`] : [])]);
  }

  if (thermal) section("Initial Condition 1", [`Temperature = ${num(study.solver.referenceTemperature)}`]);

  for (const s of setup.solids) {
    const conductor = Boolean(s.material?.properties.electricConductivity);
    const equation = study.analysis === "electrothermal" && !conductor ? 2 : 1;
    section(`Body ${s.index}`, [`Name = ${text(`S${s.index} ${s.label}`)}`, `Target Bodies(1) = ${s.index}`, `Equation = ${equation}`,
      `Material = ${materials.get(s.material!.id)}`, ...(bodyForce.has(s.index) ? [`Body Force = ${bodyForce.get(s.index)}`] : []),
      ...(thermal ? ["Initial Condition = 1"] : [])]);
  }

  // One boundary condition per CAD face (its number is its geometry id in the results).
  const areas = new Map<string, number>();
  for (const f of setup.faces.values()) {
    const c = f.thermal?.condition;
    if (c?.type === "heat_flow") areas.set(f.thermal!.boundary, (areas.get(f.thermal!.boundary) ?? 0) + geometry.faces.find(x => x.index === f.index)!.area_mm2 * 1e-6);
  }
  for (const face of geometry.faces) {
    const bound = setup.faces.get(face.index);
    const lines = [`Name = "F${face.index}"`, `Target Boundaries(1) = ${face.index}`, `Geometry Id = Integer ${face.index}`];
    const e = electric ? bound?.electric?.condition : undefined;
    if (e?.type === "voltage") lines.push(`Potential = ${num(e.voltage)}`);
    if (e?.type === "ground") lines.push("Potential = 0");
    if (e?.type === "current") lines.push("Potential = 1");
    const t = thermal ? bound?.thermal?.condition : undefined;
    if (t?.type === "temperature") lines.push(`Temperature = ${num(t.temperature)}`);
    if (t?.type === "convection") lines.push(`Heat Transfer Coefficient = ${num(t.h)}`, `External Temperature = ${num(t.ambient)}`);
    if (t?.type === "heat_flux") lines.push(`Heat Flux = ${num(t.flux)}`);
    if (t?.type === "heat_flow") lines.push(`Heat Flux = ${num(t.power / areas.get(bound!.thermal!.boundary)!)}`);
    section(`Boundary Condition ${face.index}`, lines);
  }

  solvers.forEach((s, i) => section(`Solver ${i + 1}`, s.body));
  return out.join("\n");
}

// ── Elmer's log ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ElmerRun {
  finished: boolean;
  errors: string[];
  warnings: string[];
  solvers: { name: string; resultNorm?: number; change?: number; linearIterations?: number; finalResidual?: number }[];
  time?: { cpu: number; real: number };
  version?: string;
}

/** Reads ElmerSolver's output: errors, warnings, per-solver norms and linear iterations, the total time. */
export function readElmerLog(log: string): ElmerRun {
  const run: ElmerRun = { finished: /ALL DONE/.test(log), errors: [], warnings: [], solvers: [] };
  let iterations: number | undefined, residual: number | undefined;
  const solver = (name: string) => {
    let s = run.solvers.find(x => x.name === name);
    if (!s) { s = { name }; run.solvers.push(s); }
    return s;
  };
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("ERROR::")) { if (run.errors.length < 20) run.errors.push(line.slice(7).trim()); continue; }
    if (line.startsWith("WARNING::")) { if (run.warnings.length < 40 && !run.warnings.includes(line.slice(9).trim())) run.warnings.push(line.slice(9).trim()); continue; }
    const residualLine = /^(\d+)\s+([-+]?\d*\.?\d+(?:[EeDd][-+]?\d+)?)$/.exec(line);
    if (residualLine) { iterations = Number(residualLine[1]); residual = Number(residualLine[2].replace(/[Dd]/, "E")); continue; }
    const norm = /^([A-Za-z][\w ]*?):\s+Result Norm:\s+(\S+)/.exec(line);
    if (norm) {
      const s = solver(norm[1]);
      s.resultNorm = Number(norm[2]);
      if (iterations !== undefined) { s.linearIterations = iterations; s.finalResidual = residual; }
      iterations = residual = undefined;
      continue;
    }
    const change = /^ComputeChange: SS \(ITER=\d+\) \(NRM,RELC\): \(\s*(\S+)\s+(\S+)\s*\) :: (.+)$/.exec(line);
    if (change) { solver(change[3].trim()).change = Number(change[2]); continue; }
    const time = /SOLVER TOTAL TIME\(CPU,REAL\):\s+(\S+)\s+(\S+)/.exec(line);
    if (time) run.time = { cpu: Number(time[1]), real: Number(time[2]) };
    const version = /^MAIN: Version:\s+(\S+)/.exec(line);
    if (version) run.version = version[1].replace(/-unknown$/, "");
  }
  return run;
}

/** Problems in a run that mean its result must not be used (a zero exit code alone proves nothing). */
export function runProblems(run: ElmerRun): string[] {
  const problems = [...run.errors];
  if (!run.finished) problems.push("ElmerSolver did not reach the end of the run");
  for (const s of run.solvers) {
    if (s.resultNorm !== undefined && !Number.isFinite(s.resultNorm)) problems.push(`${s.name}: the solution norm is not a number`);
  }
  for (const w of run.warnings) if (/unlisted keyword|unknown specifier/i.test(w)) problems.push(`solver input: ${w}`);
  return problems;
}

/** SaveScalars output: names from the .names file, values from the data file. */
export function readScalars(names: string, values: string): Record<string, number> {
  const labels = names.split(/\r?\n/).map(l => /^\s*\d+:\s*(.+)$/.exec(l)?.[1]?.trim()).filter((l): l is string => Boolean(l));
  const numbers = values.trim().split(/\s+/).map(Number);
  const out: Record<string, number> = {};
  labels.forEach((label, i) => { if (Number.isFinite(numbers[i])) out[label] = numbers[i]; });
  return out;
}
