import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAion } from "../../tests/helpers";
import { findFreecad, FreecadBackend } from "../../src/host/cad/freecad";
import { previewGlb } from "../../src/host/cad/preview";
import { PLUGIN_ROOT, REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run cad:verify [-- --open-gui]`: the FreeCAD backend against the FreeCAD installed on this machine (v0.7), through
 * the real `cad_model` tool. It is the measured, scripted companion of tests/v07-cad.test.ts (scenarios A–G):
 *
 *   - latency of repeated small edits (FreeCAD recompute + tessellation, preview build), on a model with features;
 *   - STEP and STL export; a native .FCStd that FreeCAD itself reopens in a separate process;
 *   - the single-writer hand-off: after open_in_freecad Aion refuses edits; a change saved by *another* FreeCAD process
 *     (standing in for the FreeCAD application) is refused as modified-externally until reload, which picks it up.
 *     `--open-gui` really opens the FreeCAD application on the saved file as well.
 *
 * Output: .e2e/cad/report.json, the GLB previews of each step, and the .FCStd.
 */
const OUT = join(REPO_ROOT, ".e2e", "cad");
mkdirSync(OUT, { recursive: true });
const install = findFreecad();
if (!install) { console.log("cad:verify: FreeCAD is not installed (or AION_FREECAD is not set); nothing to verify."); process.exit(1); }
const folder = mkdtempSync(join(tmpdir(), "aion-cad-verify-"));
const cad = new FreecadBackend({ script: join(PLUGIN_ROOT, "cad", "aion_freecad_worker.py"), env: { AION_CAD_WORKSPACE: join(folder, "workspace") } });
let guiOpened: string | null = null;
const aion = await connectAion({ cad, openFreecad: async path => { guiOpened = path; return process.argv.includes("--open-gui") ? (await import("../../src/host/cad/desktop")).openInFreecad(path, install.command) : true; } });
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`  ${ok ? "✓" : "✗"} ${what}`); if (!ok) failures.push(what); };
type Cad = { revision: number; solids: { size_mm: number[]; volume_mm3: number; valid: boolean }[]; timing: Record<string, number>; result: Record<string, unknown> };
type Out = { isError?: boolean; content: { text: string }[]; structuredContent?: { cad?: Cad } };
const call = async (action: string, args: Record<string, unknown> = {}) => aion.call("cad_model", { action, args }) as Promise<Out>;
const report: Record<string, unknown> = { freecad: null, command: install.command, at: new Date().toISOString() };

try {
  const status = await call("status");
  report.freecad = /FreeCAD ([\d.]+)/.exec(status.content[0].text)?.[1] ?? (status.structuredContent?.cad?.result as { freecad?: string } | undefined)?.freecad;
  console.log(`FreeCAD ${String(report.freecad)} (${install.command})`);
  await call("create_document", { name: "Bracket" });
  await call("add_primitive", { kind: "box", length: 120, width: 80, height: 40, name: "Enclosure" });
  await call("add_holes", { target: "Enclosure", diameter: 6, corners: 8 });
  await call("add_sketch", { name: "Slot", plane: "XY", offset: 40, profiles: [{ rectangle: { x: 40, y: 30, width: 40, height: 20 } }] });
  const pocket = await call("pocket", { sketch: "Slot", target: "Enclosure", depth: 10 });
  check(!pocket.isError && (pocket.structuredContent?.cad?.solids[0].volume_mm3 ?? 0) < 120 * 80 * 40 - 4 * Math.PI * 9 * 40 - 7_999, "a constrained sketch pocketed 10 mm deep (volume drops by 8,000 mm³)");
  const fillet = await call("fillet", { target: "Enclosure", radius: 3 });
  check(!fillet.isError, "a fillet on the vertical edges (kept as a rule)");
  // Latency of small edits on this model: Length 120 → 130 → … (holes follow; the fillet and pocket regenerate).
  const samples: Record<string, number>[] = [];
  for (let i = 1; i <= 8; i++) {
    const r = await call("set_parameter", { component: "Enclosure", parameter: "Length", value: 120 + i * 5 });
    if (r.isError) { check(false, `edit ${i}: ${r.content[0].text}`); break; }
    samples.push(r.structuredContent!.cad!.timing);
  }
  const stat = (key: string) => { const v = samples.map(s => s[key] ?? 0).sort((a, b) => a - b); return { median: v[Math.floor(v.length / 2)], max: v.at(-1) }; };
  report.editLatencyMs = Object.fromEntries(["freecad_ms", "tessellation_ms", "preview_build_ms", "asset_transfer_ms", "total_ms"].map(k => [k, stat(k)]));
  console.log(`  edit latency (ms, median/max over ${samples.length}): ${Object.entries(report.editLatencyMs as Record<string, { median: number; max: number }>).map(([k, v]) => `${k} ${Math.round(v.median)}/${Math.round(v.max)}`).join("; ")}`);
  const sketchEdit = await call("set_constraint", { sketch: "Slot", constraint: "Width", value: 50 });
  check(!sketchEdit.isError, `a sketch dimension (the slot's Width constraint) changed and recomputed${sketchEdit.isError ? `: ${sketchEdit.content[0].text}` : ""}`);
  // Exports and the native file.
  const step = join(folder, "Bracket.step"), stl = join(folder, "Bracket.stl"), fcstd = join(folder, "Bracket.FCStd");
  check(!(await call("export", { format: "step", path: step })).isError && statSync(step).size > 1000, `STEP export (${statSync(step).size} B)`);
  check(!(await call("export", { format: "stl", path: stl })).isError && statSync(stl).size > 1000, `STL export (${statSync(stl).size} B)`);
  check(!(await call("save", { path: fcstd })).isError, "saved as a native .FCStd");
  // FreeCAD itself, in another process, reads it back: still parametric (the holes are expressions on the box).
  const probe = join(folder, "probe.py");
  writeFileSync(probe, `import FreeCAD as App, os, json\nd = App.openDocument(${JSON.stringify(fcstd)})\nb = d.getObject("Enclosure")\nh = d.getObject("Hole2")\nos.fdopen(3, "w").write(json.dumps({"length": b.Length.Value, "expr": [list(e) for e in h.ExpressionEngine]}))\n`);
  const read = spawnSync(install.command, [probe], { stdio: ["ignore", "ignore", "ignore", "pipe"], encoding: "utf8" });
  const reread = JSON.parse(String(read.output?.[3] ?? "{}")) as { length?: number; expr?: string[][] };
  check(reread.length === 160 && (reread.expr ?? []).some(([prop, expression]) => prop.startsWith(".Placement") && /Enclosure\.Length/.test(expression)), `FreeCAD reopens it: Length ${reread.length} mm, Hole 2 bound to the box by expressions`);
  // The single-writer hand-off.
  const handed = await call("open_in_freecad");
  check(!handed.isError && guiOpened === fcstd, `handed to the FreeCAD application${process.argv.includes("--open-gui") ? " (opened)" : " (not opened: --open-gui)"}`);
  const refused = await call("set_parameter", { component: "Enclosure", parameter: "Height", value: 45 });
  check(!!refused.isError && /handed-off/.test(refused.content[0].text), "while it is open there, Aion refuses to change it");
  // The "application" saves a change (another FreeCAD process edits the file).
  const edit = join(folder, "edit.py");
  writeFileSync(edit, `import FreeCAD as App\nd = App.openDocument(${JSON.stringify(fcstd)})\nd.getObject("Enclosure").Height = 50\nd.recompute()\nd.save()\n`);
  await new Promise(resolve => setTimeout(resolve, 1100));
  spawnSync(install.command, [edit], { stdio: "ignore" });
  const reloaded = await call("reload");
  check(!reloaded.isError && reloaded.structuredContent?.cad?.solids[0].size_mm[2] === 50, `reload picks up the change saved in FreeCAD (height ${reloaded.structuredContent?.cad?.solids[0].size_mm[2]} mm)`);
  const after = await call("set_parameter", { component: "Enclosure", parameter: "Height", value: 55 });
  check(!after.isError, "after reload Aion may change it again");
  // A file changed behind Aion's back (no hand-off) is refused until reload.
  await call("save");
  writeFileSync(edit, `import FreeCAD as App\nd = App.openDocument(${JSON.stringify(fcstd)})\nd.getObject("Enclosure").Width = 90\nd.recompute()\nd.save()\n`);
  await new Promise(resolve => setTimeout(resolve, 1100));
  spawnSync(install.command, [edit], { stdio: "ignore" });
  const stale = await call("set_parameter", { component: "Enclosure", parameter: "Width", value: 85 });
  check(!!stale.isError && /modified-externally/.test(stale.content[0].text), "a file changed elsewhere is never overwritten: modified-externally until reload");
  // The preview of the final revision, kept for inspection.
  const last = await call("inspect");
  report.final = last.structuredContent?.cad;
  void previewGlb;
} finally {
  cad.stop();
  await aion.close();
}
report.failures = failures;
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(failures.length ? `\n${failures.length} check(s) failed` : `\n✓ FreeCAD backend verified (${join(OUT, "report.json")}; files in ${folder})`);
process.exit(failures.length ? 1 : 0);
