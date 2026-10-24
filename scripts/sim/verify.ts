import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFreecad, FreecadBackend } from "../../src/host/cad/freecad";
import { freecadBridge } from "../../src/host/sim/freecadBridge";
import { SimulationService, type SimReply } from "../../src/host/sim/service";
import { findSimTools, toolsReport } from "../../src/host/sim/tools";
import type { ResultSummary } from "../../src/sim/results";
import { PLUGIN_ROOT, REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run sim:verify`: the simulation toolchain against the FreeCAD, Gmsh and Elmer installed on this machine (v0.8),
 * through the simulation service's public actions — the measured, scripted companion of tests/v08-sim-real.test.ts.
 * Every model is generated here (nothing prebuilt) and compared with an analytic reference:
 *
 *   1. a copper busbar (100 × 10 × 5 mm, 1 mV) at every mesh size: resistance vs L/(σA), elements, stage timings,
 *      the card bundle's size
 *   2. the same busbar electro-thermal (10 mV, ends at 40 °C, convection 10 W/(m²·K) to 25 °C): mid-length rise vs the
 *      1-D fin solution, heat balance
 *   3. a stepped conductor (60 × 10 × 5 then 60 × 5 × 5 mm) at every mesh size: resistance converging from below
 *
 * Output: .e2e/sim/report.json and a table on the console.
 */
const OUT = join(REPO_ROOT, ".e2e", "sim");
mkdirSync(OUT, { recursive: true });
const tools = await findSimTools();
const report = toolsReport(tools);
if (!findFreecad() || !report.ready) { console.log(`sim:verify: ${findFreecad() ? report.lines.join(" ") : "FreeCAD is not installed"}; nothing to verify.`); process.exit(1); }
console.log(report.lines.join("\n"));
const home = mkdtempSync(join(tmpdir(), "aion-sim-verify-"));
const cad = new FreecadBackend({ script: join(PLUGIN_ROOT, "cad", "aion_freecad_worker.py"), env: { AION_CAD_WORKSPACE: join(home, "cad"), AION_SIM_WORKSPACE: join(home, "sim") } });
const sim = new SimulationService({ root: join(home, "sim"), cad: freecadBridge(cad) });
let study: string | undefined;
const failures: string[] = [];
const call = async (action: Parameters<SimulationService["handle"]>[0], args: Record<string, unknown> = {}): Promise<SimReply> => {
  const reply = await sim.handle(action, args, { study });
  if (reply.study) study = reply.study.id;
  if (!reply.ok) { failures.push(`${action}: ${reply.message}`); console.log(`  ✗ ${action}: ${reply.message}`); }
  return reply;
};
const cadCall = async (op: string, args: Record<string, unknown>) => { const r = await cad.call(op, args); if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`); };
const SIZES = ["coarse", "normal", "fine", "very_fine"] as const;
const rows: Record<string, unknown>[] = [];
const fmt = (v: number, d = 5) => Number(v.toPrecision(d));

try {
  // 1. Busbar, every mesh size.
  await cadCall("create_document", { name: "Busbar" });
  await cadCall("add_primitive", { kind: "box", length: 100, width: 10, height: 5, name: "Busbar" });
  await call("create", { analysis: "electric", name: "Busbar DC" });
  await call("set_material", { bodies: "Busbar", material: "copper" });
  await call("set_boundary", { faces: "left", type: "voltage", voltage: "1 mV" });
  await call("set_boundary", { faces: "right", type: "ground" });
  const R = 0.1 / (5.8e7 * 5e-5);
  console.log("\n1. Copper busbar 100 × 10 × 5 mm, 1 mV — R vs L/(σA) = " + R.toExponential(6) + " Ω");
  for (const size of SIZES) {
    await call("set_mesh", { size });
    const run = await call("run", { wait_s: 50 });
    const s = run.data as unknown as ResultSummary & { seconds?: Record<string, number>; run: number };
    if (!s.electric) continue;
    const error = Math.abs(s.electric.resistance_ohm! - R) / R;
    const bundle = statSync(join(home, "sim", "studies", study!, "runs", String(s.run).padStart(4, "0"), "field.afr")).size;
    rows.push({ case: "busbar", size, tetrahedra: s.mesh.tetrahedra, nodes: s.mesh.nodes, resistance_ohm: s.electric.resistance_ohm, error, seconds: s.seconds, bundle_bytes: bundle, quality_min: fmt(s.mesh.quality.min, 3) });
    console.log(`  ${size.padEnd(9)} ${String(s.mesh.tetrahedra).padStart(8)} tets  R ${s.electric.resistance_ohm!.toExponential(6)} Ω  error ${(error * 100).toExponential(2)} %  mesh ${s.seconds?.mesh?.toFixed(2)} s, solve ${s.seconds?.solve?.toFixed(2)} s, process ${s.seconds?.process?.toFixed(2)} s, bundle ${(bundle / 1024).toFixed(0)} KB`);
    if (error > 0.002) failures.push(`busbar ${size}: R error ${error}`);
  }

  // 2. Electro-thermal.
  await call("set_physics", { analysis: "electrothermal" });
  await call("set_boundary", { faces: "left", type: "voltage", voltage: "10 mV" }); // replaces the 1 mV terminal (same faces)
  await call("set_boundary", { faces: "remaining", type: "convection", h: "10 W/(m2*K)", ambient: "25 °C" });
  await call("set_boundary", { faces: "left", type: "temperature", temperature: "40 °C" });
  await call("set_boundary", { faces: "right", type: "temperature", temperature: "40 °C" });
  await call("set_mesh", { size: "fine" });
  const et = (await call("run", { wait_s: 50 })).data as unknown as ResultSummary & { seconds?: Record<string, number> };
  const P = 5.8e7 * 5e-5 * 0.01 ** 2 / 0.1, q = P / 5e-6, m2 = 10 * 0.03 / (390 * 5e-5), thetaP = q / (390 * m2);
  const fin = thetaP + (15 - thetaP) / Math.cosh(Math.sqrt(m2) * 0.05) - 15;
  if (et.thermal) {
    const rise = et.thermal.max_K - 313.15;
    console.log(`\n2. Electro-thermal busbar (10 mV, ends 40 °C, h 10 W/(m²·K) to 25 °C): rise ${rise.toFixed(4)} K vs fin ${fin.toFixed(4)} K (${(Math.abs(rise - fin) / fin * 100).toFixed(2)} %), P ${et.electric!.joule_W.toPrecision(5)} W vs ${P.toPrecision(5)} W, balance ${et.thermal.balance.relativeError.toExponential(2)}`);
    rows.push({ case: "electrothermal", rise_K: rise, fin_K: fin, joule_W: et.electric!.joule_W, balance: et.thermal.balance.relativeError, seconds: et.seconds, tetrahedra: et.mesh.tetrahedra });
    if (Math.abs(rise - fin) / fin > 0.02) failures.push("electro-thermal rise off by more than 2 %");
  }

  // 3. Stepped conductor, every mesh size.
  study = undefined;
  await cadCall("create_document", { name: "Stepped" });
  await cadCall("add_primitive", { kind: "box", length: 60, width: 10, height: 5, name: "Wide" });
  await cadCall("add_primitive", { kind: "box", length: 60, width: 5, height: 5, at: [60, 2.5, 0], name: "Narrow" });
  await call("create", { analysis: "electric", name: "Stepped" });
  await call("set_material", { bodies: "all", material: "copper" });
  await call("set_boundary", { faces: "left", type: "voltage", voltage: "1 mV" });
  await call("set_boundary", { faces: "right", type: "ground" });
  const R1d = 0.06 / (5.8e7 * 5e-5) + 0.06 / (5.8e7 * 2.5e-5);
  console.log(`\n3. Stepped conductor — 1-D series value ${R1d.toExponential(6)} Ω (a lower bound: the constriction adds resistance)`);
  let previous = 0;
  for (const size of SIZES) {
    await call("set_mesh", { size });
    const s = (await call("run", { wait_s: 50 })).data as unknown as ResultSummary & { seconds?: Record<string, number> };
    if (!s.electric) continue;
    const r = s.electric.resistance_ohm!;
    console.log(`  ${size.padEnd(9)} ${String(s.mesh.tetrahedra).padStart(8)} tets  R ${r.toExponential(6)} Ω  (+${((r / R1d - 1) * 100).toFixed(3)} % over 1-D)  solve ${s.seconds?.solve?.toFixed(2)} s`);
    rows.push({ case: "stepped", size, tetrahedra: s.mesh.tetrahedra, resistance_ohm: r, over1d: r / R1d - 1, seconds: s.seconds });
    if (r < R1d) failures.push(`stepped ${size}: below the 1-D bound`);
    if (previous && r < previous * (1 - 1e-6)) failures.push(`stepped ${size}: R fell with refinement`);
    previous = r;
  }
  // 4. A large mesh: solver time and what the card receives (the interior is dropped beyond the card's size limit).
  study = undefined;
  await cadCall("create_document", { name: "Large" });
  await cadCall("add_primitive", { kind: "box", length: 100, width: 40, height: 10, name: "Plate" });
  await cadCall("add_holes", { target: "Plate", diameter: 8, corners: 10 });
  await call("create", { analysis: "electrothermal", name: "Large plate" });
  await call("set_material", { bodies: "Plate", material: "copper" });
  await call("set_boundary", { faces: "left", type: "current", current: "500 A" });
  await call("set_boundary", { faces: "right", type: "ground" });
  await call("set_boundary", { faces: "remaining", type: "convection", h: "15 W/(m2*K)", ambient: "25 °C" });
  await call("set_mesh", { max_mm: 0.9 });
  const big = await call("run", { wait_s: 50 });
  const b = big.data as unknown as ResultSummary & { seconds?: Record<string, number>; run: number };
  if (b.mesh) {
    const bytes = statSync(join(home, "sim", "studies", study!, "runs", String(b.run).padStart(4, "0"), "field.afr")).size;
    console.log(`\n4. Large plate (100 × 40 × 10 mm, four holes), electro-thermal: ${b.mesh.tetrahedra} tets, ${b.mesh.nodes} nodes — mesh ${b.seconds?.mesh?.toFixed(1)} s, convert ${b.seconds?.convert?.toFixed(1)} s, solve ${b.seconds?.solve?.toFixed(1)} s, process ${b.seconds?.process?.toFixed(1)} s; card bundle ${(bytes / 1048576).toFixed(1)} MB${b.notes.some(n => /interior elements exceed/.test(n)) ? " (interior dropped: too large for the card)" : " (interior included)"}; balance ${b.thermal?.balance.relativeError.toExponential(2)}`);
    rows.push({ case: "large", tetrahedra: b.mesh.tetrahedra, nodes: b.mesh.nodes, seconds: b.seconds, bundle_bytes: bytes, notes: b.notes });
  }
} finally {
  cad.stop();
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), gmsh: tools.gmsh?.version, elmer: tools.elmerSolver?.version, rows, failures }, null, 1));
}
console.log(`\n${failures.length ? `✗ ${failures.length} problem(s): ${failures.join("; ")}` : "✓ every case within its reference"} — report: ${join(OUT, "report.json")}`);
process.exitCode = failures.length ? 1 : 0;
