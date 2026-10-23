import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findFreecad, FreecadBackend } from "../src/host/cad/freecad";
import { freecadBridge } from "../src/host/sim/freecadBridge";
import { SimulationService, type SimReply } from "../src/host/sim/service";
import { findSimTools } from "../src/host/sim/tools";
import { decodeFieldBundle } from "../src/sim/field";
import type { ResultSummary } from "../src/sim/results";
import { tempHome } from "./helpers";

/**
 * v0.8: the engineering simulation toolchain against the REAL programs — FreeCAD (geometry), Gmsh (mesh), Elmer
 * (solve) — on models generated during the test through the same public interfaces a user's request goes through
 * (the FreeCAD worker's operations and the simulation service's actions; nothing precomputed, no fixed mesh or solver
 * file). Each case is checked against an analytic reference. Skipped, and said so, when a program is missing.
 *
 *   A  copper busbar, 1 mV: resistance L/(σA), loss V²/R, current conservation, Joule cross-check
 *   B  heat: a volumetric source (ΔT = qL²/8k), a heat flux (ΔT = qL/k, its sign), electro-thermal (1-D fin solution)
 *   C  generality: copper + aluminium in series (exact), a stepped conductor (bounded, mesh-converging)
 *   D  a CAD change (5 → 8 mm thick) re-run through the same study: R × 5/8, compared
 *   E  persistence: a new service (a new MCP server) reads, shows and compares results without solving again
 *   F  the detached job runner (runtime/aion-sim.mjs) and a run that outlives its tool call
 */
const WORKER = join(import.meta.dirname, "..", "plugins", "aion-presence", "cad", "aion_freecad_worker.py");
const RUNNER = join(import.meta.dirname, "..", "plugins", "aion-presence", "runtime", "aion-sim.mjs");
const tools = await findSimTools();
const missing = [!findFreecad() && "FreeCAD", !tools.gmsh && "Gmsh", !tools.elmerSolver && "Elmer"].filter(Boolean);
const skip = missing.length ? `${missing.join(", ")} not installed` : false;
if (skip) console.log(`# v0.8 real-toolchain tests skipped: ${skip}`);

const SIGMA_CU = 5.8e7, SIGMA_AL = 2.5e7, K_CU = 390;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

function harness(runner?: string) {
  const home = tempHome();
  const cad = new FreecadBackend({ script: WORKER, env: { AION_CAD_WORKSPACE: join(home, "cad"), AION_SIM_WORKSPACE: join(home, "sim") } });
  const sim = new SimulationService({ root: join(home, "sim"), cad: freecadBridge(cad), ...(runner ? { runner } : {}) });
  let study: string | undefined;
  const call = async (action: Parameters<SimulationService["handle"]>[0], args: Record<string, unknown> = {}): Promise<SimReply> => {
    const reply = await sim.handle(action, args, { study });
    if (reply.study) study = reply.study.id;
    return reply;
  };
  const must = async (action: Parameters<SimulationService["handle"]>[0], args: Record<string, unknown> = {}) => {
    const reply = await call(action, args);
    assert.ok(reply.ok, `${action}: ${reply.message}`);
    return reply;
  };
  const cadMust = async (op: string, args: Record<string, unknown>) => {
    const r = await cad.call(op, args);
    assert.ok(r.ok, `${op}: ${JSON.stringify(!r.ok && r.error)}`);
    return r;
  };
  return { home, cad, sim, call, must, cadMust, get study() { return study; } };
}

const summaryOf = (reply: SimReply) => reply.data as unknown as ResultSummary & { run: number };

test("v0.8 real A: a copper busbar at 1 mV — resistance and loss match L/(σA) and V²/R; current is conserved", { skip }, async () => {
  const h = harness();
  try {
    await h.cadMust("create_document", { name: "Busbar A" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Busbar" });
    await h.must("create", { analysis: "electric", name: "Busbar DC" });
    await h.must("set_material", { bodies: "Busbar", material: "copper" });
    await h.must("set_boundary", { faces: "left", type: "voltage", voltage: "1 mV", name: "Terminal +" });
    await h.must("set_boundary", { faces: "right", type: "ground" });
    const run = await h.must("run", { wait_s: 50 });
    const s = summaryOf(run);
    const R = 0.1 / (SIGMA_CU * 5e-5), P = 1e-6 / R;
    assert.ok(rel(s.electric!.resistance_ohm!, R) < 0.002, `R ${s.electric!.resistance_ohm} vs ${R}`);
    assert.ok(rel(s.electric!.resistanceElmer_ohm!, R) < 0.002);
    assert.ok(rel(s.electric!.joule_W, P) < 0.002, `P ${s.electric!.joule_W} vs ${P}`);
    assert.ok(rel(s.electric!.jouleCheck_W, s.electric!.joule_W) < 1e-3, "Aion's σ|∇φ|² integral agrees with Elmer's");
    assert.ok(rel(s.electric!.viCheck_W!, s.electric!.joule_W) < 1e-3, "V·I = P");
    assert.ok(s.electric!.currentImbalance < 1e-6, `current conservation ${s.electric!.currentImbalance}`);
    const j = s.fields.find(f => f.id === "current_density")!;
    assert.ok(rel(j.max, 1e-3 / 0.1 * SIGMA_CU) < 0.01, "uniform J = σV/L");
    assert.ok(run.show && run.show.mode === "results");
    const bundle = decodeFieldBundle(run.show.bytes);
    assert.deepEqual(bundle.header.fields.map(f => f.id).sort(), ["current_density", "electric_field", "joule_heating", "potential"]);
    assert.ok(bundle.tets && bundle.header.counts.tetrahedra === s.mesh.tetrahedra);
    assert.ok(existsSync((run.data.files as { vtu: string }).vtu), "the VTU stays on disk");
    console.log(`# A: R = ${s.electric!.resistance_ohm} Ω (analytic ${R}), P = ${s.electric!.joule_W} W, ${s.mesh.tetrahedra} tetrahedra, Elmer ${s.solver.seconds} s`);
  } finally { h.cad.stop(); }
});

test("v0.8 real B1: a volumetric heat source between two fixed temperatures — ΔT = qL²/(8k), all the heat leaves at the ends", { skip }, async () => {
  const h = harness();
  try {
    await h.cadMust("create_document", { name: "Bar B1" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Bar" });
    await h.must("create", { analysis: "thermal" });
    await h.must("set_material", { bodies: "Bar", material: "copper" });
    await h.must("set_source", { bodies: "Bar", power_density: "1e6 W/m3" });
    await h.must("set_boundary", { faces: "left", type: "temperature", temperature: "300 K" });
    await h.must("set_boundary", { faces: "right", type: "temperature", temperature: 300 });
    await h.must("set_mesh", { size: "fine" });
    const s = summaryOf(await h.must("run", { wait_s: 50 }));
    const rise = 1e6 * 0.1 ** 2 / (8 * K_CU);
    assert.ok(rel(s.thermal!.max_K - 300, rise) < 0.02, `ΔT ${s.thermal!.max_K - 300} K vs ${rise} K`);
    assert.ok(Math.abs(s.thermal!.maxAt[0] - 50) < 5, "the hottest point is mid-length");
    assert.ok(rel(s.thermal!.generated.sources_W, 5) < 1e-3, "q·V = 5 W");
    assert.ok(s.thermal!.balance.relativeError < 1e-3, `balance ${s.thermal!.balance.relativeError}`);
    for (const b of s.thermal!.boundaries) assert.ok(rel(b.heatOut_W, 2.5) < 0.01, `${b.name}: ${b.heatOut_W} W`);
    console.log(`# B1: ΔT = ${(s.thermal!.max_K - 300).toFixed(4)} K (analytic ${rise.toFixed(4)})`);
  } finally { h.cad.stop(); }
});

test("v0.8 real B2: a heat flux into one end — ΔT = qL/k (Elmer's flux enters the body), the same heat leaves the other end", { skip }, async () => {
  const h = harness();
  try {
    await h.cadMust("create_document", { name: "Bar B2" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Bar" });
    await h.must("create", { analysis: "thermal" });
    await h.must("set_material", { bodies: "Bar", material: "copper" });
    await h.must("set_boundary", { faces: "left", type: "heat_flux", flux: "10 W/cm2" });
    await h.must("set_boundary", { faces: "right", type: "temperature", temperature: 300 });
    const s = summaryOf(await h.must("run", { wait_s: 50 }));
    const rise = 1e5 * 0.1 / K_CU;
    assert.ok(rel(s.thermal!.max_K - 300, rise) < 0.005, `ΔT ${s.thermal!.max_K - 300} K vs ${rise} K`);
    assert.ok(s.thermal!.maxAt[0] < 1, "hottest at the heated end");
    const right = s.thermal!.boundaries.find(b => b.type === "temperature")!;
    assert.ok(rel(right.heatOut_W, 5) < 0.005, `5 W leaves at the fixed end (${right.heatOut_W})`);
    assert.ok(rel(s.thermal!.generated.inflow_W, 5) < 1e-3);
    assert.ok(s.thermal!.balance.relativeError < 1e-3);
  } finally { h.cad.stop(); }
});

test("v0.8 real B3: electro-thermal — the solver's Joule heat is the thermal source; temperatures match the 1-D fin solution", { skip }, async () => {
  const h = harness();
  try {
    await h.cadMust("create_document", { name: "Busbar B3" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Busbar" });
    await h.must("create", { analysis: "electrothermal" });
    await h.must("set_material", { bodies: "Busbar", material: "copper" });
    await h.must("set_boundary", { faces: "left", type: "voltage", voltage: "10 mV" });
    await h.must("set_boundary", { faces: "right", type: "ground" });
    await h.must("set_boundary", { faces: "remaining", type: "convection", h: "10 W/(m2*K)", ambient: "25 °C" });
    await h.must("set_boundary", { faces: "left", type: "temperature", temperature: "40 °C" });
    await h.must("set_boundary", { faces: "right", type: "temperature", temperature: "40 °C" });
    await h.must("set_mesh", { size: "fine" });
    const run = await h.must("run", { wait_s: 50 });
    const s = summaryOf(run);
    const P = SIGMA_CU * 5e-5 * 0.01 ** 2 / 0.1;
    assert.ok(rel(s.electric!.joule_W, P) < 0.002, `P ${s.electric!.joule_W} vs ${P}`);
    assert.ok(rel(s.thermal!.generated.joule_W, s.electric!.joule_W) < 1e-3, "the electrical loss is the thermal source");
    assert.ok(s.thermal!.balance.relativeError < 1e-3, `balance ${s.thermal!.balance.relativeError}`);
    // 1-D fin with uniform generation q, convection on the sides (perimeter 30 mm), both ends at 40 °C, air at 25 °C.
    const q = P / 5e-6, m2 = 10 * 0.03 / (K_CU * 5e-5), thetaP = q / (K_CU * m2), thetaEnd = 15;
    const thetaMid = thetaP + (thetaEnd - thetaP) / Math.cosh(Math.sqrt(m2) * 0.05);
    const rise = thetaMid - thetaEnd;
    assert.ok(rel(s.thermal!.max_K - 313.15, rise) < 0.02, `mid-length rise ${s.thermal!.max_K - 313.15} K vs ${rise} K`);
    const bundle = decodeFieldBundle(run.show!.bytes);
    assert.deepEqual(bundle.header.fields.map(f => f.id).sort(), ["current_density", "electric_field", "heat_flux", "joule_heating", "potential", "temperature"]);
    assert.deepEqual(bundle.header.fields.find(f => f.id === "temperature")!.display, { unit: "°C", offset: -273.15 });
    console.log(`# B3: rise ${(s.thermal!.max_K - 313.15).toFixed(4)} K (fin ${rise.toFixed(4)}), balance ${s.thermal!.balance.relativeError.toExponential(2)}`);
  } finally { h.cad.stop(); }
});

test("v0.8 real C: generality — copper + aluminium in series is exact; a stepped conductor is bounded and converges with the mesh", { skip }, async () => {
  const h = harness();
  try {
    await h.cadMust("create_document", { name: "Series C" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Copper" });
    await h.cadMust("add_primitive", { kind: "box", length: 20, width: 10, height: 5, at: [100, 0, 0], name: "Aluminium" });
    await h.must("create", { analysis: "electric" });
    await h.must("set_material", { bodies: "Copper", material: "copper" });
    await h.must("set_material", { bodies: "Aluminium", material: "aluminium" });
    await h.must("set_boundary", { faces: "left", type: "current", current: "100 A" });
    await h.must("set_boundary", { faces: "right", type: "ground" });
    const series = summaryOf(await h.must("run", { wait_s: 50 }));
    const R = 0.1 / (SIGMA_CU * 5e-5) + 0.02 / (SIGMA_AL * 5e-5);
    assert.ok(rel(series.electric!.current_A!, 100) < 1e-4, `the requested 100 A (${series.electric!.current_A})`);
    assert.ok(rel(series.electric!.resistance_ohm!, R) < 0.003, `R ${series.electric!.resistance_ohm} vs ${R}`);
    assert.ok(rel(series.electric!.joule_W, 100 ** 2 * R) < 0.003, "P = I²R (Elmer's total, scaled by its current control)");

    // A stepped conductor: 60 × 10 × 5 then 60 × 5 × 5 (the narrow end meets part of the wide end: a conformal fragment).
    await h.cadMust("create_document", { name: "Stepped C" });
    await h.cadMust("add_primitive", { kind: "box", length: 60, width: 10, height: 5, name: "Wide" });
    await h.cadMust("add_primitive", { kind: "box", length: 60, width: 5, height: 5, at: [60, 2.5, 0], name: "Narrow" });
    const stepped = await h.must("create", { analysis: "electric" });
    const faces = (stepped.data.geometry as { faces: { interface?: boolean }[] }).faces;
    assert.ok(faces.length >= 11, "the wide end is split into the contact and its exposed rest");
    await h.must("set_material", { bodies: "all", material: "copper" });
    await h.must("set_boundary", { faces: "left", type: "voltage", voltage: "1 mV" });
    await h.must("set_boundary", { faces: "right", type: "ground" });
    const normal = summaryOf(await h.must("run", { wait_s: 50 }));
    await h.must("set_mesh", { size: "fine" });
    const fine = summaryOf(await h.must("run", { wait_s: 50 }));
    const series1d = 0.06 / (SIGMA_CU * 5e-5) + 0.06 / (SIGMA_CU * 2.5e-5);
    for (const s of [normal, fine]) {
      assert.ok(s.electric!.resistance_ohm! > series1d && s.electric!.resistance_ohm! < 1.1 * series1d, `R ${s.electric!.resistance_ohm} within (1, 1.1)× the 1-D ${series1d}`);
      assert.ok(s.electric!.currentImbalance < 1e-5);
    }
    assert.ok(fine.mesh.tetrahedra > 2 * normal.mesh.tetrahedra, "finer means more elements");
    assert.ok(rel(fine.electric!.resistance_ohm!, normal.electric!.resistance_ohm!) < 0.01, `mesh change ${rel(fine.electric!.resistance_ohm!, normal.electric!.resistance_ohm!)}`);
    // With prescribed voltages, conforming FEM over-estimates the stored energy (P_h ≥ P), so R_h = V²/P_h approaches
    // the exact resistance from below: refining can only raise it.
    assert.ok(fine.electric!.resistance_ohm! >= normal.electric!.resistance_ohm! * (1 - 1e-6), `R rises with refinement (${normal.electric!.resistance_ohm} → ${fine.electric!.resistance_ohm})`);
    const peakNote = fine.notes.some(n => /re-entrant edge/.test(n));
    console.log(`# C: series R ${series.electric!.resistance_ohm} (exact ${R}); stepped R ${normal.electric!.resistance_ohm} → ${fine.electric!.resistance_ohm} (1-D ${series1d}); singular-peak note: ${peakNote}`);
  } finally { h.cad.stop(); }
});

test("v0.8 real D+E: a CAD change re-runs through the same study (R × 5/8); a new service reads, shows and compares without solving", { skip }, async () => {
  const h = harness();
  try {
    await h.cadMust("create_document", { name: "Busbar D" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Busbar" });
    await h.must("create", { analysis: "electric" });
    await h.must("set_material", { bodies: "Busbar", material: "copper" });
    await h.must("set_boundary", { faces: "left", type: "voltage", voltage: "1 mV" });
    await h.must("set_boundary", { faces: "right", type: "ground" });
    const first = summaryOf(await h.must("run", { wait_s: 50 }));
    await h.cadMust("set_parameter", { component: "Busbar", parameter: "Height", value: 8 });
    const second = await h.must("run", { wait_s: 50 });
    assert.match(second.message, /The CAD model changed \(revision \d+ → \d+\)/);
    assert.match(second.message, /re-resolved on revision \d+ — faces .*area 50 → 80 mm²/);
    const s2 = summaryOf(second);
    assert.ok(rel(s2.electric!.resistance_ohm!, first.electric!.resistance_ohm! * 5 / 8) < 0.003, "R ∝ 1/thickness");
    const compared = await h.must("compare", {});
    const row = (compared.data.rows as { quantity: string; change_percent: number }[]).find(r => r.quantity === "resistance_ohm")!;
    assert.ok(Math.abs(row.change_percent + 37.5) < 0.5, `${row.change_percent} %`);
    assert.ok((compared.data.differences as string[]).some(d => /geometry revision/.test(d)));
    // A new process (a new MCP server for the next Codex turn): the same study and results, no solve.
    const fresh = new SimulationService({ root: join(h.home, "sim"), cad: null });
    const results = await fresh.handle("results", {}, { study: h.study });
    assert.ok(results.ok, results.message);
    assert.equal((results.data as { run: number }).run, 2);
    const shown = await fresh.handle("show", { run: 1, field: "potential" }, { study: h.study });
    assert.ok(shown.ok && shown.show?.mode === "results" && shown.show.run === 1);
    assert.deepEqual(shown.card, [{ command: "set-field", value: "potential" }]);
    assert.match(shown.message, /setup has changed since/, "an older run is labelled as such");
    const bundle = decodeFieldBundle(shown.show!.bytes);
    const phi = bundle.header.fields.find(f => f.id === "potential")!;
    assert.ok(Math.abs(phi.max - 1e-3) < 1e-9 && Math.abs(phi.min) < 1e-12, "the stored field is the solver's");
    const probe = await fresh.handle("results", { probe: [50, 5, 4] }, { study: h.study });
    assert.ok(probe.ok);
    const value = (probe.data.probe as { values: { potential: number }; inside: boolean });
    assert.ok(value.inside && Math.abs(value.values.potential - 0.5e-3) < 1e-6, "mid-length potential 0.5 mV (interpolated)");
  } finally { h.cad.stop(); }
});

test("v0.8 real F: the detached runner solves in its own process; a run that outlives its tool call is picked up later", { skip: skip || (!existsSync(RUNNER) && "runtime not built") }, async () => {
  const h = harness(RUNNER);
  try {
    await h.cadMust("create_document", { name: "Busbar F" });
    await h.cadMust("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Busbar" });
    await h.must("create", { analysis: "electric" });
    await h.must("set_material", { bodies: "Busbar", material: "copper" });
    await h.must("set_boundary", { faces: "left", type: "voltage", voltage: "1 mV" });
    await h.must("set_boundary", { faces: "right", type: "ground" });
    const started = await h.must("run", { wait_s: 0 });
    assert.match(started.message, /still going|solved/);
    let results: SimReply | null = null;
    for (let i = 0; i < 150 && !(results?.ok); i++) {
      await new Promise(r => setTimeout(r, 200));
      results = await h.call("results");
    }
    assert.ok(results?.ok, results?.message);
    const status = JSON.parse(readFileSync(join(h.home, "sim", "studies", h.study!, "runs", "0001", "status.json"), "utf8"));
    assert.equal(status.state, "done");
    assert.notEqual(status.pid, process.pid, "solved by the runner's own process");
  } finally { h.cad.stop(); }
});
