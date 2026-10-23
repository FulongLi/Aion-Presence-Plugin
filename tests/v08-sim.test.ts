import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatQuantity, toStored } from "../src/sim/units";
import { findMaterial, MATERIAL_LIBRARY } from "../src/sim/materials";
import { describeFace, facingOf, nearestFace, resolveSelector, type SimGeometry } from "../src/sim/geometry";
import { bind, blocking, validate } from "../src/sim/setup";
import { buildGeo, checkFaceMapping, meshSizing, readMsh, tetQuality } from "../src/sim/gmsh";
import { buildSif, readElmerLog, readScalars, runProblems } from "../src/sim/elmer";
import { decodeFieldBundle, encodeFieldBundle, FIELD_MIME, FieldBundleError } from "../src/sim/field";
import { locate, sectionValues, sliceTets } from "../src/sim/slice";
import { probe, readVtu } from "../src/sim/results";
import { newStudy, parseStudy, type SimulationStudy } from "../src/sim/study";
import { setupBundle } from "../src/sim/bundle";
import { checkSimArguments, SIM_ACTIONS, toSelector } from "../src/host/sim/commands";
import { SimulationService, type CadBridge } from "../src/host/sim/service";
import { elmerCandidates, gmshCandidates } from "../src/host/sim/tools";
import { colorAt, lookupTable, niceTicks } from "../src/cards/apps/simulation/colormaps";
import { SIMULATION_MANIFEST } from "../src/cards/apps/simulation.manifest";
import { defaultCardRegistry, OPENABLE_CARD_APP_IDS } from "../src/cards/registry";
import { checkCommand, checkState, validateManifest } from "../src/cards/manifest";
import { sniffMedia } from "../src/host/media";
import { TOOL_NAMES } from "../src/host/mcp/toolNames";
import { busbarAndTab, boxesGeometry, cubeMsh } from "./fixtures/sim";
import { connectAion, tempHome } from "./helpers";

/**
 * v0.8: the engineering simulation toolchain — unit tests of the Simulation Core and the service, with synthetic
 * geometry and stand-ins for FreeCAD. They prove the logic (units, face selection, validation, solver input, result
 * reading, the card's data); they are never evidence that Gmsh or Elmer solved anything. The real toolchain is tested
 * in tests/v08-sim-real.test.ts (skipped, and said so, when FreeCAD, Gmsh or Elmer is missing).
 */
const copper = findMaterial("copper")!, aluminium = findMaterial("aluminium")!;
const cu = { electricConductivity: copper.electricConductivity, thermalConductivity: copper.thermalConductivity, density: copper.density };
const al = { electricConductivity: aluminium.electricConductivity, thermalConductivity: aluminium.thermalConductivity, density: aluminium.density };

function busbarStudy(analysis: SimulationStudy["analysis"] = "electric", geometry: SimGeometry = busbarAndTab()): SimulationStudy {
  const study = newStudy("sim-test01", "Busbar", analysis, { backend: "freecad", document: geometry.document, revision: geometry.revision, bodies: "visible" });
  study.materials.push({ id: "M1", bodies: ["Busbar"], name: copper.name, source: "library:copper", properties: cu, nominal: true });
  study.materials.push({ id: "M2", bodies: ["Tab"], name: aluminium.name, source: "library:aluminium-6061", properties: al, nominal: true });
  study.boundaries.push({ id: "B1", name: "Terminal +", selector: { side: "left" }, condition: { type: "voltage", voltage: 0.001 } });
  study.boundaries.push({ id: "B2", name: "Ground", selector: { side: "right" }, condition: { type: "ground" } });
  return study;
}

// ── Units and materials ─────────────────────────────────────────────────────────────────────────────────────────────

test("v0.8 units: explicit conversion to SI, bare numbers are SI (mm for lengths), unknown units refused", () => {
  const v = (kind: Parameters<typeof toStored>[0], input: Parameters<typeof toStored>[1]) => { const r = toStored(kind, input); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  assert.equal(v("voltage", "1 mV"), 1e-3);
  assert.equal(v("voltage", 10), 10);
  assert.equal(v("current", "2 kA"), 2000);
  assert.ok(Math.abs(v("temperature", "25 °C") - 298.15) < 1e-9);
  assert.ok(Math.abs(v("temperature", "77 °F") - 298.15) < 1e-9);
  assert.equal(v("temperature", 300), 300, "a bare temperature is kelvin");
  assert.equal(v("conductivity", "58 MS/m"), 5.8e7);
  assert.equal(v("conductivity", "5 mS/m"), 5e-3, "milli and mega differ by case");
  assert.ok(Math.abs(v("resistivity", "1.72 uohm*cm") - 1.72e-8) < 1e-20);
  assert.ok(Math.abs(v("resistivity", "1.72 µΩ·cm") - 1.72e-8) < 1e-20);
  assert.equal(v("heatTransfer", "10 W/(m2*K)"), 10);
  assert.equal(v("heatTransfer", "10 W/m²K"), 10);
  assert.equal(v("heatFlux", "2 W/cm2"), 2e4);
  assert.equal(v("powerDensity", "1 W/cm3"), 1e6);
  assert.equal(v("power", { value: 500, unit: "mW" }), 0.5);
  assert.equal(v("length", "2 cm"), 20);
  const bad = toStored("voltage", "10 furlongs");
  assert.equal(bad.ok, false);
  assert.match((bad as { problem: string }).problem, /unknown voltage unit "furlongs" \(accepted: V, mV, kV\)/);
  assert.equal(toStored("voltage", "ten volts").ok, false);
  assert.equal(formatQuantity(4.1379e-5, "Ω"), "41.38 µΩ");
  assert.equal(formatQuantity(3.9e6, "A/m²"), "3.9 MA/m²");
});

test("v0.8 materials: nominal library values with their basis; insulators carry no conductivity; aliases resolve", () => {
  assert.equal(copper.electricConductivity, 5.8e7, "100 % IACS");
  assert.equal(findMaterial("Cu")?.id, "copper");
  assert.equal(findMaterial("铜")?.id, "copper");
  assert.equal(findMaterial("aluminum")?.id, "aluminium-6061");
  assert.equal(findMaterial("unobtainium"), null);
  for (const m of MATERIAL_LIBRARY) {
    assert.ok(m.basis.length > 4, `${m.id} states its basis`);
    assert.ok(m.thermalConductivity! > 0, m.id);
  }
  for (const id of ["fr4", "alumina", "thermal-pad"]) assert.equal(findMaterial(id)!.electricConductivity, undefined, `${id} is an insulator`);
});

// ── Geometry and face selection ─────────────────────────────────────────────────────────────────────────────────────

test("v0.8 faces: the interface between touching bodies is shared and internal; sides pick the outermost faces only", () => {
  const g = busbarAndTab();
  assert.equal(g.faces.length, 11, "6 + 6 − 1 shared face");
  const shared = g.faces.filter(f => f.solids.length === 2);
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].center, [100, 5, 2.5]);
  const left = resolveSelector(g, { side: "left" });
  assert.ok(left.ok);
  assert.deepEqual(left.faces.map(i => g.faces[i - 1].center), [[0, 5, 2.5]]);
  const right = resolveSelector(g, { side: "right" });
  assert.ok(right.ok && right.faces.length === 1 && g.faces[right.faces[0] - 1].center[0] === 120);
  const busbarRight = resolveSelector(g, { side: "right", body: "Busbar" });
  assert.equal(busbarRight.ok, false, "the busbar's right end is the internal interface");
  const top = resolveSelector(g, { facing: "top" });
  assert.ok(top.ok && top.faces.length === 2, "facing: every flat face facing up");
  const internal = resolveSelector(g, { faces: [shared[0].index] });
  assert.equal(internal.ok, false);
  assert.match((internal as { problem: string }).problem, /interface between two solids/);
  assert.equal(resolveSelector(g, { faces: [99] }).ok, false);
  assert.equal(resolveSelector(g, { side: "left", body: "Nothing" }).ok, false);
  const rest = resolveSelector(g, { remaining: true }, new Set(left.ok ? left.faces : []));
  assert.ok(rest.ok && rest.faces.length === 9, "10 exterior faces minus the taken one");
  assert.equal(facingOf(g.faces[0]), "left");
  assert.match(describeFace(g, 1), /left-facing plane of Busbar, 50 mm²/);
});

test("v0.8 faces: a point picks the nearest face; a point on an edge is refused as ambiguous (never guessed)", () => {
  const g = busbarAndTab();
  const at = nearestFace(g, [0, 5, 2.5]);
  assert.ok(at.ok && g.faces[at.faces[0] - 1].center[0] === 0);
  const edge = nearestFace(g, [0, 0, 2.5]);
  assert.equal(edge.ok, false);
  assert.match((edge as { problem: string }).problem, /on the edge between faces/);
  assert.equal(nearestFace(g, [500, 500, 500]).ok, false, "far from every face");
});

// ── Binding and validation ──────────────────────────────────────────────────────────────────────────────────────────

test("v0.8 validation: a complete electrical study is ready; defaults (insulated faces, nominal data) are listed, not hidden", () => {
  const g = busbarAndTab(), study = busbarStudy();
  const setup = bind(study, g);
  const issues = validate(study, g, setup);
  assert.deepEqual(blocking(issues), []);
  assert.ok(issues.some(i => i.code === "default-insulated" && /8 exterior faces/.test(i.message)));
  assert.ok(issues.some(i => i.code === "material-nominal"));
  assert.equal(setup.faces.get(1)?.electric?.condition.type, "voltage");
});

test("v0.8 validation: missing materials, no potential difference, floating conductors and no heat sink are blocking", () => {
  const g = busbarAndTab();
  const noMaterial = busbarStudy();
  noMaterial.materials = noMaterial.materials.slice(0, 1);
  assert.ok(blocking(validate(noMaterial, g, bind(noMaterial, g))).some(i => i.code === "material-missing" && /Tab/.test(i.message)));
  const same = busbarStudy();
  same.boundaries[0].condition = { type: "ground" };
  assert.ok(blocking(validate(same, g, bind(same, g))).some(i => i.code === "electric-no-difference"));
  const none = busbarStudy();
  none.boundaries = [];
  assert.ok(blocking(validate(none, g, bind(none, g))).some(i => i.code === "electric-no-terminals"));
  // Two separate bodies, only one with terminals: the other floats.
  const apart = boxesGeometry([{ body: "A", min: [0, 0, 0], max: [10, 10, 10] }, { body: "B", min: [20, 0, 0], max: [30, 10, 10] }]);
  const floating = newStudy("sim-test02", "Apart", "electric", { backend: "freecad", document: apart.document, revision: 1, bodies: "visible" });
  floating.materials.push({ id: "M1", bodies: ["A", "B"], name: "Copper", source: "library:copper", properties: cu, nominal: true });
  floating.boundaries.push({ id: "B1", name: "T", selector: { side: "left" }, condition: { type: "voltage", voltage: 1 } }, { id: "B2", name: "G", selector: { side: "right", body: "A" }, condition: { type: "ground" } });
  assert.ok(blocking(validate(floating, apart, bind(floating, apart))).some(i => i.code === "floating-conductor" && /^B conducts/.test(i.message)));
  const thermal = busbarStudy("electrothermal");
  assert.ok(blocking(validate(thermal, g, bind(thermal, g))).some(i => i.code === "thermal-no-sink"));
  thermal.boundaries.push({ id: "B3", name: "Air", selector: { remaining: true }, condition: { type: "convection", h: 10, ambient: 298.15 } });
  assert.deepEqual(blocking(validate(thermal, g, bind(thermal, g))), []);
  const currents = busbarStudy();
  currents.boundaries[0].condition = { type: "current", current: 100 };
  currents.boundaries.push({ id: "B3", name: "Extra", selector: { facing: "top" }, condition: { type: "voltage", voltage: 1 } });
  assert.ok(blocking(validate(currents, g, bind(currents, g))).some(i => i.code === "current-with-voltage"));
});

test("v0.8 validation: two conditions of one kind on a face conflict; 'remaining' always yields to specific ones", () => {
  const g = busbarAndTab(), study = busbarStudy("thermal");
  study.boundaries = [
    { id: "B1", name: "Air", selector: { exterior: true }, condition: { type: "convection", h: 10, ambient: 298 } },
    { id: "B2", name: "Clamp", selector: { side: "left" }, condition: { type: "temperature", temperature: 313 } },
  ];
  const setup = bind(study, g);
  assert.deepEqual(blocking(setup.issues), []);
  assert.equal(setup.faces.get(1)?.thermal?.condition.type, "temperature", "the specific condition wins on its face");
  study.boundaries.push({ id: "B3", name: "Hot", selector: { faces: [1] }, condition: { type: "temperature", temperature: 400 } });
  assert.ok(bind(study, g).issues.some(i => i.code === "boundary-conflict"));
});

test("v0.8 geometry changes: sides are found again (and the change reported); a face picked by number that changed is stale, not moved", () => {
  const before = busbarAndTab(1), study = busbarStudy();
  // Face 3 is the busbar's front face (100 × 5 mm): it changes when the bar gets thicker. (Its bottom, face 5, would not.)
  study.boundaries.push({ id: "B3", name: "Picked", selector: { faces: [3] }, condition: { type: "insulated" } });
  bind(study, before);
  assert.equal(study.boundaries[2].resolved?.revision, 1);
  // The busbar grows from 5 mm to 8 mm thick (a new CAD revision): every face changes.
  const after = boxesGeometry([{ body: "Busbar", min: [0, 0, 0], max: [100, 10, 8] }, { body: "Tab", min: [100, 0, 0], max: [120, 10, 8] }], 2);
  const setup = bind(study, after);
  assert.ok(setup.changes.some(c => /Terminal \+: re-resolved on revision 2 — faces 1 → 1, area 50 → 80 mm²/.test(c)), setup.changes.join(" | "));
  const stale = setup.issues.find(i => i.code === "boundary-stale");
  assert.ok(stale && /Picked/.test(stale.message) && /not applied/.test(stale.message), stale?.message);
  assert.ok(study.boundaries[2].stale);
  assert.ok(blocking(validate(study, after, setup)).some(i => i.code === "boundary-stale"));
  // A pick that still matches (the same face, renumbered or not) carries over.
  const study2 = busbarStudy();
  study2.boundaries.push({ id: "B3", name: "Picked", selector: { faces: [1] }, condition: { type: "insulated" } });
  bind(study2, before);
  const moved = boxesGeometry([{ body: "Busbar", min: [0, 0, 0], max: [100, 10, 5] }, { body: "Tab", min: [100, 0, 0], max: [130, 10, 5] }], 2);
  assert.equal(bind(study2, moved).issues.filter(i => i.code === "boundary-stale").length, 0, "the left end did not change");
});

test("v0.8 study: a stored study is schema-checked (unknown fields, bad units refused)", () => {
  const study = busbarStudy();
  assert.ok(parseStudy(JSON.parse(JSON.stringify(study))).ok);
  assert.equal(parseStudy({ ...study, extra: 1 }).ok, false);
  assert.equal(parseStudy({ ...study, boundaries: [{ ...study.boundaries[0], condition: { type: "temperature", temperature: -5 } }] }).ok, false);
  assert.equal(parseStudy({ ...study, analysis: "transient" }).ok, false);
});

// ── Meshing input and output ───────────────────────────────────────────────────────────────────────────────────────

test("v0.8 Gmsh input: healing off, scaled to metres, a physical group per solid and face, sizes and refinement", () => {
  const g = busbarAndTab(), study = busbarStudy();
  const sizing = meshSizing(g, study.mesh);
  assert.ok(sizing.max_mm > 0 && sizing.max_mm <= 2.5, `normal: two elements through the 5 mm thickness (${sizing.max_mm})`);
  const fine = meshSizing(g, { ...study.mesh, size: "fine" });
  assert.ok(fine.max_mm < sizing.max_mm && fine.estimatedElements > sizing.estimatedElements);
  const geo = buildGeo({ brepFile: "geometry.brep", mshFile: "mesh.msh", solids: 2, faces: 11, sizing, order: 1, refine: [{ faces: [1, 2], size_mm: 0.5 }, { solids: [2], size_mm: 1 }] });
  for (const line of ["Geometry.OCCFixSmallFaces = 0;", "Geometry.OCCSewFaces = 0;", "Geometry.OCCScaling = 0.001;", 'Merge "geometry.brep";', 'Physical Volume("S2", 2) = {2};',
    'Physical Surface("F11", 11) = {11};', "Mesh.MshFileVersion = 2.2;", "Field[1].SurfacesList = {1, 2};", "Field[3].VolumesList = {2};", "Background Field = 4;", 'Save "mesh.msh";']) {
    assert.ok(geo.includes(line), line);
  }
  assert.throws(() => buildGeo({ brepFile: "../../etc/passwd", mshFile: "mesh.msh", solids: 1, faces: 1, sizing, order: 1, refine: [] }), /unsafe/);
});

test("v0.8 mesh reading: counts, volume, shape quality and the face check against the CAD faces", () => {
  const stats = readMsh(cubeMsh());
  assert.equal(stats.nodes, 8);
  assert.equal(stats.tetrahedra, 6);
  assert.equal(stats.triangles, 12);
  assert.ok(Math.abs(stats.volume_mm3[1] - 1) < 1e-9, "the 1 mm cube");
  assert.ok(stats.quality.min > 0.5 && stats.quality.min <= 1);
  assert.ok(Math.abs(tetQuality([0, 0, 0], [1, 0, 0], [0.5, Math.sqrt(3) / 2, 0], [0.5, Math.sqrt(3) / 6, Math.sqrt(2 / 3)]).gamma - 1) < 1e-9, "a regular tetrahedron has quality 1");
  const cube = boxesGeometry([{ body: "Cube", min: [0, 0, 0], max: [1, 1, 1] }]);
  assert.deepEqual(checkFaceMapping(stats, cube), []);
  // The same mesh against a geometry whose faces are numbered differently is caught.
  const swapped = structuredClone(cube);
  [swapped.faces[0].center, swapped.faces[1].center] = [swapped.faces[1].center, swapped.faces[0].center];
  assert.ok(checkFaceMapping(stats, swapped).some(p => /centroid/.test(p)));
  assert.throws(() => readMsh("$MeshFormat\n4.1 0 8\n$EndMeshFormat\n"), /not ASCII MSH 2.2/);
});

// ── Solver input and output ────────────────────────────────────────────────────────────────────────────────────────

test("v0.8 Elmer input: generated from the study — solvers per analysis, one boundary per CAD face with its geometry id", () => {
  const g = busbarAndTab();
  const electric = busbarStudy();
  const sif = buildSif(electric, g, bind(electric, g), { meshDir: "../../meshes/m-1", meshName: "elmer", resultsDir: "results", order: 1 });
  assert.match(sif, /Mesh DB "\.\.\/\.\.\/meshes\/m-1" "elmer"/);
  assert.match(sif, /Procedure = "StatCurrentSolveVec" "StatCurrentSolver"/);
  assert.doesNotMatch(sif, /HeatSolve/);
  assert.match(sif, /Electric Conductivity = 58000000\n/);
  assert.match(sif, /Boundary Condition 1\n {2}Name = "F1"\n {2}Target Boundaries\(1\) = 1\n {2}Geometry Id = Integer 1\n {2}Potential = 0\.001\nEnd/);
  assert.match(sif, /Boundary Condition 2\n {2}Name = "F2"\n {2}Target Boundaries\(1\) = 2\n {2}Geometry Id = Integer 2\nEnd/, "an unassigned face: natural (insulated)");
  assert.equal((sif.match(/^Boundary Condition \d+$/gm) ?? []).length, 11);
  assert.match(sif, /Linear System Abort Not Converged = True/);
  const current = busbarStudy();
  current.boundaries[0].condition = { type: "current", current: 100 };
  const sifCurrent = buildSif(current, g, bind(current, g), { meshDir: "m", meshName: "elmer", resultsDir: "results", order: 1 });
  assert.match(sifCurrent, /Current Control = Real 100/);
  assert.match(sifCurrent, /Boundary Condition 1\n[\s\S]*?Potential = 1\n/);
  const et = busbarStudy("electrothermal");
  et.materials[1] = { ...et.materials[1], properties: { thermalConductivity: 0.3 }, name: "FR-4" };
  et.boundaries.push({ id: "B3", name: "Air", selector: { remaining: true }, condition: { type: "convection", h: 10, ambient: 298.15 } },
    { id: "B4", name: "Heater", selector: { side: "right" }, condition: { type: "heat_flow", power: 0.5 } });
  et.sources.push({ id: "Q1", bodies: ["Busbar"], density: 1000 });
  const sifEt = buildSif(et, g, bind(et, g), { meshDir: "m", meshName: "elmer", resultsDir: "results", order: 2 });
  assert.match(sifEt, /Equation 2\n {2}Name = "Heat only"/, "the insulator conducts heat only");
  assert.match(sifEt, /Joule Heat = True\n {2}Volumetric Heat Source = 1000/);
  assert.match(sifEt, /Heat Transfer Coefficient = 10\n {2}External Temperature = 298\.15/);
  assert.match(sifEt, /Heat Flux = 10000\n/, "0.5 W over 50 mm² is 10 kW/m²");
  assert.match(sifEt, /Save Linear Elements = True/);
  assert.match(sifEt, /Procedure = "FluxSolver" "FluxSolver"/);
  const noInsulator = busbarStudy("electrothermal");
  assert.doesNotMatch(buildSif(noInsulator, g, bind(noInsulator, g), { meshDir: "m", meshName: "elmer", resultsDir: "results", order: 1 }), /Equation 2/, "Elmer warns about an unused equation");
  assert.throws(() => buildSif(electric, g, bind(electric, g), { meshDir: "m\" \"x", meshName: "elmer", resultsDir: "results", order: 1 }), /unsafe path/);
});

test("v0.8 Elmer output: errors are found even when ElmerSolver exits 0 (it does, after refusing its input)", () => {
  const refused = ["ERROR:: LoadInputFile: Unknown specifier:[1]", "ERROR:: LoadInputFile:         section:  [boundary condition 1]", "MAIN: *** Elmer Solver: ALL DONE ***"].join("\n");
  const run = readElmerLog(refused);
  assert.equal(run.finished, true);
  assert.equal(run.errors.length, 2);
  assert.ok(runProblems(run).length > 0, "never a result");
  const ok = readElmerLog([
    "MAIN: Version: 26.2-unknown (Rev: a19504a, Compiled: 2026-10-23)", "      25 0.1234E-07", "      50 0.6087E-10",
    "StatCurrentSolver:  Result Norm:   1.4601073300000000", "ComputeChange: SS (ITER=1) (NRM,RELC): ( 1.46  2.0000000 ) :: static current",
    "WARNING:: LoadInputFile: > Equation 2 < not used in any Body!", "SOLVER TOTAL TIME(CPU,REAL):         0.18        1.35", "MAIN: *** Elmer Solver: ALL DONE ***"].join("\n"));
  assert.deepEqual(runProblems(ok), []);
  assert.equal(ok.version, "26.2", "a source build's \"-unknown\" suffix is dropped");
  const solver = ok.solvers.find(x => x.name === "StatCurrentSolver")!;
  assert.deepEqual([solver.resultNorm, solver.linearIterations, solver.finalResidual], [1.46010733, 50, 6.087e-11]);
  assert.equal(ok.solvers.find(x => x.name === "static current")?.change, 2, "ComputeChange names the variable");
  assert.deepEqual(ok.time, { cpu: 0.18, real: 1.35 });
  assert.ok(runProblems(readElmerLog("MAIN: Version: 26.2")).includes("ElmerSolver did not reach the end of the run"));
  assert.ok(runProblems(readElmerLog("X:  Result Norm:   NaN\nMAIN: *** Elmer Solver: ALL DONE ***")).some(p => /not a number/.test(p)));
  const scalars = readScalars("Variables in columns of matrix:\n   1: max: temperature\n   2: res: total joule heating\n", "  2.93E+002   2.4166E-002\n");
  assert.deepEqual(scalars, { "max: temperature": 293, "res: total joule heating": 0.024166 });
});

test("v0.8 results: Elmer's ASCII VTU is read strictly; a probe interpolates linearly inside the containing element", () => {
  // The cube's six tetrahedra and two boundary triangles, with T = 300 + 1000 x (x in metres).
  const msh = readVtuFixture();
  const mesh = readVtu(msh);
  assert.equal(mesh.tets.length / 4, 6);
  assert.equal(mesh.tris.length / 3, 2);
  assert.deepEqual([...mesh.triFace], [1, 1]);
  const p = probe(mesh, [0.25, 0.5, 0.5]);
  assert.equal(p.inside, true);
  assert.ok(Math.abs((p.values.temperature as number) - 300.25) < 1e-9, "exact for a linear field");
  const outside = probe(mesh, [5, 5, 5]);
  assert.equal(outside.inside, false);
  assert.match(outside.method, /nearest node/);
  assert.throws(() => readVtu(msh.replace(/format="ascii"/g, 'format="binary"')), /not ASCII/);
  assert.throws(() => readVtu(msh.replace("NumberOfPoints=\"8\"", "NumberOfPoints=\"9\"")), /do not match/);
});

function readVtuFixture(): string {
  const p: number[][] = [];
  for (let i = 0; i < 8; i++) p.push([(i & 1) * 0.001, ((i >> 1) & 1) * 0.001, ((i >> 2) & 1) * 0.001]);
  const tets = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];
  const tris = [[0, 2, 6], [0, 6, 4]];
  const conn = [...tets.flat(), ...tris.flat()];
  const offsets = [...tets.map((_, i) => (i + 1) * 4), ...tris.map((_, i) => 24 + (i + 1) * 3)];
  const types = [...tets.map(() => 10), ...tris.map(() => 5)];
  const ids = [...tets.map(() => 1), ...tris.map(() => 1)];
  const arr = (attrs: string, values: number[]) => `<DataArray ${attrs} format="ascii">\n${values.join(" ")}\n</DataArray>`;
  return `<?xml version="1.0"?>\n<VTKFile type="UnstructuredGrid"><UnstructuredGrid><Piece NumberOfPoints="8" NumberOfCells="8">
<PointData>${arr('type="Float64" Name="temperature" NumberOfComponents="1"', p.map(q => 300 + 1000 * q[0]))}</PointData>
<CellData>${arr('type="Int32" Name="GeometryIds"', ids)}</CellData>
<Points>${arr('type="Float64" NumberOfComponents="3"', p.flat())}</Points>
<Cells>${arr('type="Int32" Name="connectivity"', conn)}${arr('type="Int32" Name="offsets"', offsets)}${arr('type="Int32" Name="types"', types)}</Cells>
</Piece></UnstructuredGrid></VTKFile>`;
}

// ── The card's data ─────────────────────────────────────────────────────────────────────────────────────────────────

test("v0.8 field bundle: encoded, decoded and validated (indices, finite values, sizes); the hub accepts it by its bytes", () => {
  const header = {
    format: "aion.field/1" as const, mode: "results" as const, title: "Test", study: { id: "sim-test01", name: "Busbar", analysis: "electric", revision: 3, run: 1 },
    geometry: { document: "cad-test01", revision: 1 }, units: { length: "m" as const }, counts: { nodes: 4, triangles: 1, tetrahedra: 1 },
    faces: [{ index: 1, label: "face 1", body: "B" }], solids: [{ index: 1, label: "B" }],
    fields: [{ id: "potential", name: "Electric potential", unit: "V", kind: "scalar" as const, source: "test", location: "nodal" as const, min: 0, max: 1, minAt: [0, 0, 0] as [number, number, number], maxAt: [1, 0, 0] as [number, number, number], block: "f:potential" }],
    summary: ["R = 1 Ω"], omitted: [],
  };
  const blocks = (over: Partial<Record<string, Float32Array | Uint32Array>> = {}) => [
    { id: "nodes", data: over.nodes ?? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]) }, { id: "tris", data: over.tris ?? new Uint32Array([0, 1, 2]) },
    { id: "triFace", data: new Uint32Array([1]) }, { id: "tets", data: new Uint32Array([0, 1, 2, 3]) }, { id: "tetSolid", data: new Uint32Array([1]) },
    { id: "f:potential", data: over.potential ?? new Float32Array([0, 1, 0, 0]) },
  ];
  const bytes = encodeFieldBundle(header, blocks());
  const decoded = decodeFieldBundle(bytes);
  assert.equal(decoded.header.study.run, 1);
  assert.deepEqual([...decoded.blocks["f:potential"]], [0, 1, 0, 0]);
  assert.equal(sniffMedia(Buffer.from(bytes)), FIELD_MIME);
  assert.throws(() => decodeFieldBundle(encodeFieldBundle(header, blocks({ tris: new Uint32Array([0, 1, 9]) }))), FieldBundleError, "a node that does not exist");
  assert.throws(() => decodeFieldBundle(encodeFieldBundle(header, blocks({ potential: new Float32Array([0, NaN, 0, 0]) }))), /not numbers/);
  assert.throws(() => decodeFieldBundle(bytes.slice(0, bytes.length - 8)), /past the end/);
  const bad = bytes.slice(); bad[0] = 0x58;
  assert.equal(sniffMedia(Buffer.from(bad)), null, "anything else is refused");
  assert.throws(() => decodeFieldBundle(encodeFieldBundle({ ...header, units: { length: "mm" as never } }, blocks())), /metres/);
});

test("v0.8 setup bundle: the CAD surface per face, coloured by its conditions", () => {
  const g = busbarAndTab(), study = busbarStudy();
  const decoded = decodeFieldBundle(setupBundle(study, g, bind(study, g)));
  assert.equal(decoded.header.mode, "setup");
  assert.equal(decoded.header.counts.triangles, 22);
  const left = decoded.header.faces.find(f => f.index === 1)!;
  assert.match(left.condition!, /Terminal \+: potential 0\.001 V/);
  assert.equal(left.color, "#e4572e");
  assert.equal(decoded.header.faces.find(f => f.index === 3)!.color, undefined, "unassigned faces stay neutral");
  assert.deepEqual(decoded.header.conditions, [
    { name: "Terminal +", color: "#e4572e", text: "potential 0.001 V" }, { name: "Ground", color: "#2e86de", text: "ground (0 V)" },
  ], "the legend gives each condition its own colour");
});

test("v0.8 sections: marching tetrahedra cut the mesh exactly; values interpolate along the cut edges", () => {
  const mesh = readVtu(readVtuFixture());
  const nodes = Float32Array.from(mesh.nodes), tets = Uint32Array.from(mesh.tets);
  const section = sliceTets(nodes, tets, null, [1, 0, 0], 0.0004);
  let area = 0;
  for (let t = 0; t < section.triangles; t++) {
    const v = [0, 1, 2].map(k => [0, 1, 2].map(c => section.positions[(t * 3 + k) * 3 + c]));
    const e1 = [0, 1, 2].map(c => v[1][c] - v[0][c]), e2 = [0, 1, 2].map(c => v[2][c] - v[0][c]);
    area += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
  }
  assert.ok(Math.abs(area - 1e-6) < 1e-12, `the cut through the 1 mm cube is 1 mm² (${area})`);
  const t = sectionValues(section, mesh.fields.temperature.values);
  for (const value of t) assert.ok(Math.abs(value - 300.4) < 1e-4, "T = 300 + 1000·0.0004 everywhere on the cut");
  assert.equal(sliceTets(nodes, tets, null, [1, 0, 0], 0.005).triangles, 0, "a plane outside the mesh cuts nothing");
  const at = locate(nodes, tets, [0.0001, 0.0002, 0.0009]);
  assert.ok(at && Math.abs(at.weights.reduce((s, w) => s + w, 0) - 1) < 1e-9);
  assert.equal(locate(nodes, tets, [0.002, 0, 0]), null);
});

test("v0.8 Simulation Card: a valid manifest for field assets, registered but opened only by simulate", () => {
  assert.ok(validateManifest(SIMULATION_MANIFEST).ok);
  assert.ok(defaultCardRegistry().has("simulation"));
  assert.ok(!OPENABLE_CARD_APP_IDS.includes("simulation"), "show_interactive_card cannot open it without a result");
  assert.deepEqual(SIMULATION_MANIFEST.resources.assets, ["field"]);
  assert.equal(checkCommand(SIMULATION_MANIFEST, "section", "x 12.5").ok, true);
  assert.equal(checkCommand(SIMULATION_MANIFEST, "set-colormap", "rainbow").ok, true);
  assert.equal(checkCommand(SIMULATION_MANIFEST, "set-colormap", "neon").ok, false);
  assert.equal(checkState(SIMULATION_MANIFEST, { mode: "results", field: "temperature", fields: ["temperature"], selected: "F12" }).ok, true);
  assert.deepEqual(colorAt("rainbow", 0), [0, 0, 255]);
  assert.deepEqual(colorAt("rainbow", 1), [255, 0, 0]);
  assert.deepEqual(colorAt("rainbow", 0.5), [0, 255, 0]);
  assert.deepEqual(colorAt("viridis", 0), [0x44, 0x01, 0x54]);
  assert.deepEqual(colorAt("jet", 0.5), [128, 255, 128]);
  assert.equal(lookupTable("grayscale")[255 * 4], 255);
  assert.deepEqual(niceTicks(0, 1, 6), [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1]);
  assert.deepEqual(niceTicks(293.1, 313.4, 5), [300, 310]);
  assert.deepEqual(niceTicks(-1, 1, 5), [-1, -0.5, 0, 0.5, 1]);
});

// ── The service and the tool (stand-in CAD, no solver) ──────────────────────────────────────────────────────────────

function fakeCad(geometries: () => SimGeometry): CadBridge & { exports: number } {
  const bridge = {
    exports: 0,
    documents: async () => { const g = geometries(); return [{ id: g.document, name: g.documentName, revision: g.revision }]; },
    exportGeometry: async (_document: string, _bodies: string[] | "visible", dir: string) => {
      bridge.exports++;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "geometry.json"), JSON.stringify(geometries()));
      writeFileSync(join(dir, "geometry.brep"), "not a real brep");
      return { ok: true as const };
    },
  };
  return bridge;
}

test("v0.8 simulate commands: arguments validated per action; faces shorthand; nothing is code", () => {
  assert.ok(SIM_ACTIONS.includes("set_boundary") && SIM_ACTIONS.includes("run") && SIM_ACTIONS.includes("compare"));
  assert.equal(checkSimArguments("create", { analysis: "electric" }).ok, true);
  assert.equal(checkSimArguments("create", { analysis: "transient" }).ok, false, "unsupported analyses are refused");
  assert.equal(checkSimArguments("set_boundary", { faces: "left", type: "voltage", voltage: "10 V" }).ok, true);
  assert.equal(checkSimArguments("set_boundary", { faces: "left", type: "voltage", script: "rm -rf" }).ok, false);
  assert.equal(checkSimArguments("set_material", { bodies: "all" }).ok, false, "a material or its properties");
  assert.equal(checkSimArguments("set_material", { bodies: "all", conductivity: 1, resistivity: 1 }).ok, false);
  assert.equal(checkSimArguments("set_source", { bodies: "all", power: "1 W", power_density: 5 }).ok, false);
  assert.deepEqual(toSelector("left"), { side: "left" });
  assert.deepEqual(toSelector("feature:Hole1"), { feature: "Hole1" });
  assert.deepEqual(toSelector([3, 4]), { faces: [3, 4] });
  assert.deepEqual(toSelector("remaining"), { remaining: true });
  assert.ok(TOOL_NAMES.includes("simulate"));
});

test("v0.8 service: create → materials → boundaries (units converted, newest wins, conflicts refused) → validate; picks need a selection", async () => {
  let geometry = busbarAndTab(1);
  const cad = fakeCad(() => geometry);
  const service = new SimulationService({ root: join(tempHome(), "sim"), cad, env: { AION_GMSH: "/nonexistent/gmsh", AION_ELMER: "/nonexistent", AION_SIM_HOME: "/nonexistent", PATH: "" } });
  const created = await service.handle("create", { analysis: "electrothermal", name: "Busbar" });
  assert.ok(created.ok, created.message);
  assert.match(created.message, /Created study sim-[a-f0-9]{6} "Busbar".*2 solids, 11 faces/);
  assert.equal(created.show?.mode, "setup");
  const steps: [Parameters<SimulationService["handle"]>[0], Record<string, unknown>][] = [
    ["set_material", { bodies: "Busbar", material: "copper" }],
    ["set_material", { bodies: "Tab", material: "brass", thermal_conductivity: "110 W/(m*K)" }],
    ["set_boundary", { faces: "left", type: "current", current: "250 A", name: "Terminal +" }],
    ["set_boundary", { faces: "right", type: "ground" }],
    ["set_boundary", { faces: "remaining", type: "convection", h: "12 W/(m2*K)", ambient: "25 °C" }],
    ["set_boundary", { faces: "left", type: "temperature", temperature: "40 °C", name: "Clamp" }],
  ];
  for (const [action, args] of steps) { const r = await service.handle(action, args); assert.ok(r.ok, `${action}: ${r.message}`); }
  const inspected = await service.handle("validate", {});
  const v = inspected.data.validation as { ready: boolean; errors: string[]; defaults: string[] };
  assert.equal(v.ready, true, v.errors.join(" "));
  const study = inspected.study!;
  assert.equal(study.materials.find(m => m.bodies.includes("Tab"))!.properties.thermalConductivity, 110, "the user's value overrides the library's");
  assert.ok(Math.abs((study.boundaries.find(b => b.condition.type === "convection")!.condition as { ambient: number }).ambient - 298.15) < 1e-9);
  assert.equal(study.boundaries.find(b => b.name === "Terminal +")!.inputs?.current, "250 A");
  // A partial overlap with a semantic selector is refused, not guessed.
  const conflict = await service.handle("set_boundary", { faces: { facing: "front" }, type: "temperature", temperature: 300 });
  assert.ok(conflict.ok, "facing front only overlaps the fill selector, which yields");
  // {facing: "front"} took faces 3 and 8; naming face 3 alone would split it: refused.
  const overlap = await service.handle("set_boundary", { faces: [3], type: "temperature", temperature: 310 });
  assert.equal(overlap.ok, false);
  assert.match(overlap.message, /conflict: face 3 already has .*whose selector also covers face 8/);
  // Faces that cover an earlier assignment completely replace it, and the reply says so.
  const replaced = await service.handle("set_boundary", { faces: [1, 7], type: "temperature", temperature: 310, name: "Both ends" });
  assert.ok(replaced.ok);
  assert.match(replaced.message, /It replaces B\d+ Clamp on those faces/);
  const pick = await service.handle("set_boundary", { faces: "$selected", type: "insulated" });
  assert.equal(pick.ok, false);
  assert.match(pick.message, /no-selection/);
  const picked = await service.handle("set_boundary", { faces: "$selected", type: "voltage", voltage: 1 }, { selectedFace: 3 });
  assert.ok(picked.ok);
  assert.ok(picked.study!.boundaries.some(b => b.picked && "faces" in b.selector && b.selector.faces[0] === 3));
  // Units are checked before anything changes.
  const badUnit = await service.handle("set_boundary", { faces: "top", type: "convection", h: "10 W", ambient: "25 °C" });
  assert.equal(badUnit.ok, false);
  assert.match(badUnit.message, /unknown heatTransfer unit "W"/);
  const unknown = await service.handle("set_material", { bodies: "Busbar", material: "vibranium" });
  assert.match(unknown.message, /unknown-material: .* \(copper, /);
  // The CAD model changes: the next action re-reads the geometry and reports the stale pick.
  geometry = boxesGeometry([{ body: "Busbar", min: [0, 0, 0], max: [100, 10, 8] }, { body: "Tab", min: [100, 0, 0], max: [120, 10, 8] }], 2);
  const after = await service.handle("inspect", {});
  assert.match(after.message, /The CAD model changed \(revision 1 → 2\)/);
  assert.match(after.message, /Terminal \+: re-resolved on revision 2 — faces 1 → 1, area 50 → 80 mm²/, "a side is found again");
  assert.match(after.message, /Stale — Both ends: the geometry changed .* not applied/, "faces picked by number are checked");
  assert.match(after.message, /Stale — Terminal 2: the geometry changed/, "so is a face picked in the card");
  assert.equal((after.data.validation as { ready: boolean }).ready, false);
  // Removing the stale assignments makes it ready again.
  let removed = after;
  for (const b of after.study!.boundaries.filter(x => x.stale)) removed = await service.handle("remove", { id: b.id });
  assert.ok((removed.data.validation as { ready: boolean }).ready, removed.message);
  // No Gmsh or Elmer here: a run says so and solves nothing.
  const run = await service.handle("run", {});
  assert.equal(run.ok, false);
  // (Gmsh may still be found inside FreeCAD's application bundle, which no environment setting hides.)
  assert.match(run.message, /backend-unavailable: .*Elmer FEM is not installed.*Nothing was solved/);
  assert.match((await service.handle("results", {})).message, /no-results/);
});

test("v0.8 simulate tool: listed, its arguments checked before anything runs, refusals never reported as success", async () => {
  const geometry = busbarAndTab(1);
  const service = new SimulationService({ root: join(tempHome(), "sim"), cad: fakeCad(() => geometry), env: { AION_GMSH: "/nonexistent/gmsh", AION_ELMER: "/nonexistent", AION_SIM_HOME: "/nonexistent", PATH: "" } });
  const aion = await connectAion({ sim: service });
  try {
    const { tools } = await aion.client.listTools();
    const tool = tools.find(t => t.name === "simulate")!;
    assert.ok(tool && tool.description!.length < 300 && /Elmer/.test(tool.description!));
    const bad = await aion.call("simulate", { action: "set_boundary", args: { faces: "left", type: "voltage", code: "x" } }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /invalid-arguments: set_boundary/);
    const none = await aion.call("simulate", { action: "inspect" }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /no-study/);
    const created = await aion.call("simulate", { action: "create", args: { analysis: "electric" } }) as { isError?: boolean; content: { text: string }[]; structuredContent?: { simulation: { geometry: { faces: unknown[] } } } };
    assert.ok(!created.isError, created.content[0].text);
    assert.equal(created.structuredContent!.simulation.geometry.faces.length, 11);
    assert.match(created.content[0].text, /Aion is not open, so nothing is on screen/, "no window: it says so instead of claiming the card shows it");
    const run = await aion.call("simulate", { action: "run" }) as { isError?: boolean; content: { text: string }[] };
    assert.equal(run.isError, true);
    assert.match(run.content[0].text, /not-ready: .*has no material/);
    assert.match(run.content[0].text, /never say it worked/);
  } finally { await aion.close(); }
});

test("v0.8 tool discovery: FreeCAD's bundled gmsh and the user-local Elmer build are looked for, explicit settings first", () => {
  const g = gmshCandidates({ AION_GMSH: "/opt/x/gmsh", PATH: "/usr/bin" }, "darwin");
  assert.equal(g[0].path, "/opt/x/gmsh");
  assert.ok(g.some(c => c.source === "PATH"));
  const e = elmerCandidates({ AION_ELMER: "/opt/elmer/bin/ElmerSolver", AION_SIM_HOME: "/h/.aion-sim", PATH: "" }, "darwin");
  assert.equal(e[0].bin, "/opt/elmer/bin");
  assert.equal(e[1].bin, "/h/.aion-sim/elmer/bin");
  assert.ok(e.some(c => c.bin === "/opt/homebrew/bin"));
});
