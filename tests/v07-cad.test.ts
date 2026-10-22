import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCadArguments, CAD_ACTIONS } from "../src/host/cad/commands";
import { findFreecad, freecadCandidates, FreecadBackend, type CadPreview, type WorkerResponse } from "../src/host/cad/freecad";
import { previewGlb } from "../src/host/cad/preview";
import { readGlb, validateGlb } from "../src/cards/assets/gltf";
import { CAD_VIEWER_MANIFEST } from "../src/cards/apps/cadViewer.manifest";
import { checkCommand, checkState } from "../src/cards/manifest";
import { cadModelInput } from "../src/host/schemas";
import { TOOL_NAMES } from "../src/host/mcp/toolNames";
import { connectAion } from "./helpers";

/**
 * v0.7 Task 2: the FreeCAD backend. Three kinds of test, kept apart (docs/FREECAD.md):
 *   - unit: the command schema, discovery, the preview GLB;
 *   - mocked backend: the cad_model tool with a stand-in worker (selection, errors, never a fabricated success);
 *   - real FreeCAD: scenarios A–G against the installed FreeCAD (skipped, and said so, when it is not installed).
 * A mocked test is never evidence that FreeCAD works; the real ones are.
 */
const WORKER = join(import.meta.dirname, "..", "plugins", "aion-presence", "cad", "aion_freecad_worker.py");
type Out = { isError?: boolean; content: { text: string }[]; structuredContent?: { cad?: Record<string, unknown>; message: string; presentation: { kind: string } | null } };
const out = (value: unknown) => value as Out;

// ── Unit ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("v0.7 CAD commands: each action's arguments are validated (mm, ranges, required pairs), unknown ones refused", () => {
  assert.ok(CAD_ACTIONS.includes("add_holes") && CAD_ACTIONS.includes("undo") && CAD_ACTIONS.includes("open_in_freecad"));
  assert.equal(checkCadArguments("add_primitive", { kind: "box", length: 120, width: 80, height: 40, name: "Enclosure" }).ok, true);
  assert.equal(checkCadArguments("add_primitive", { kind: "box", length: -1, width: 80, height: 40 }).ok, false, "a negative length");
  assert.equal(checkCadArguments("add_primitive", { kind: "cylinder", radius: 3, diameter: 6, height: 4 }).ok, false, "radius or diameter, not both");
  assert.equal(checkCadArguments("add_holes", { target: "Enclosure", diameter: 6, corners: 8 }).ok, true);
  assert.equal(checkCadArguments("add_holes", { target: "Enclosure", diameter: 6 }).ok, false, "corners or positions");
  assert.equal(checkCadArguments("set_parameter", { component: "Hole2", parameter: "Inset X", delta: 5 }).ok, true);
  assert.equal(checkCadArguments("set_parameter", { component: "Hole2", parameter: "Inset X" }).ok, false, "value or delta");
  assert.equal(checkCadArguments("save", { path: "relative/file.FCStd" }).ok, false, "an absolute .FCStd path");
  assert.equal(checkCadArguments("save", { path: "/tmp/x.step" }).ok, false);
  const extra = checkCadArguments("add_primitive", { kind: "sphere", radius: 2, code: "import os" });
  assert.equal(extra.ok, false, "nothing beyond the schema (no code, no unknown keys)");
  assert.equal(cadModelInput.safeParse({ action: "run_python", args: {} }).success, false, "only the listed actions");
  assert.ok(TOOL_NAMES.includes("cad_model"));
});

test("v0.7 FreeCAD discovery: AION_FREECAD first (a bundle or freecadcmd), then the standard places, then PATH", () => {
  const mac = freecadCandidates({ AION_FREECAD: "/Opt/FreeCAD.app", PATH: "/usr/bin" }, "darwin");
  assert.deepEqual(mac[0], { command: "/Opt/FreeCAD.app/Contents/Resources/bin/freecadcmd", source: "env" });
  assert.ok(mac.some(c => c.command === "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd" && c.source === "standard"));
  assert.equal(mac.at(-1)?.source, "path");
  const linux = freecadCandidates({ PATH: "/opt/bin" }, "linux");
  assert.ok(linux.some(c => c.command === "/usr/bin/freecadcmd") && linux.some(c => c.command === "/opt/bin/freecadcmd"));
  assert.equal(findFreecad({ AION_FREECAD: "/nowhere/freecadcmd", PATH: "" }, "linux")?.command ?? null, existsSync("/usr/bin/freecadcmd") ? "/usr/bin/freecadcmd" : null);
});

const float = (values: number[]) => Buffer.from(new Float32Array(values).buffer).toString("base64");
const uint = (values: number[]) => Buffer.from(new Uint32Array(values).buffer).toString("base64");

test("v0.7 preview: a valid self-contained GLB — FreeCAD's ids, units in metres, Y up, a node per feature", () => {
  // One square face (z = 40 mm) owned by the box, one triangle owned by a hole.
  const preview: CadPreview = {
    triangles: 3,
    nodes: [{
      id: "Enclosure_Drilled", label: "Enclosure", role: "drilled", type: "Cut", metadata: { Volume: "475476 mm³" },
      children: [
        { id: "Enclosure", label: "Enclosure body", role: "primitive", type: "Box", color: "#9aa4ae", metadata: { Length: "150 mm" },
          positions: float([0, 0, 40, 150, 0, 40, 150, 80, 40, 0, 80, 40]), indices: uint([0, 1, 2, 0, 2, 3]), triangles: 2 },
        { id: "Hole2", label: "Hole 2", role: "hole", type: "Cylinder", color: "#b9915e", metadata: { Diameter: "6 mm" },
          positions: float([10, 10, 0, 12, 10, 0, 10, 12, 0]), indices: uint([0, 1, 2]), triangles: 1 },
      ],
    }],
  };
  const glb = previewGlb(preview, { title: "Enclosure · rev 4", documentId: "cad1", revision: 4, backend: "FreeCAD 1.1.4", path: "/tmp/enclosure.FCStd" });
  const info = validateGlb(glb);
  assert.equal(info.triangles, 3);
  const { json } = readGlb(glb) as unknown as { json: { nodes: { name: string; extras: Record<string, unknown>; children?: number[] }[]; accessors: { min?: number[]; max?: number[] }[] } };
  assert.equal(json.nodes[0].extras.units, "m");
  assert.equal(json.nodes[0].extras.revision, 4);
  assert.equal(json.nodes[0].extras.document, "cad1");
  assert.deepEqual(json.nodes.slice(1).map(n => n.extras.aionId), ["Enclosure_Drilled", "Enclosure", "Hole2"]);
  // 150 mm along X, 80 mm along FreeCAD Y (→ glTF −Z), 40 mm up (FreeCAD Z → glTF Y).
  const box = json.accessors[0];
  assert.deepEqual(box.max!.map(v => Math.round(v * 1000)), [150, 40, 0]);
  assert.deepEqual(box.min!.map(v => Math.round(v * 1000)), [0, 40, -80]);
});

test("v0.7 CAD viewer 1.1.0: reports the document and revision it shows, and accepts the backend's status", () => {
  assert.equal(CAD_VIEWER_MANIFEST.version, "1.1.0");
  assert.equal(checkState(CAD_VIEWER_MANIFEST, { document: "cad1", revision: 7, lost: "Hole3" }).ok, true);
  assert.equal(checkCommand(CAD_VIEWER_MANIFEST, "status", "FreeCAD is recomputing…").ok, true);
  assert.equal(checkCommand(CAD_VIEWER_MANIFEST, "status", "x".repeat(81)).ok, false);
});

// ── Mocked backend ────────────────────────────────────────────────────────────────────────────────────────────────

/** A stand-in worker: answers from a script and records what it was asked. Not FreeCAD. */
class FakeCad {
  calls: { op: string; args: Record<string, unknown> }[] = [];
  version = "1.1.4-fake";
  install = null;
  constructor(private readonly answer: (op: string, args: Record<string, unknown>) => WorkerResponse) {}
  async call(op: string, args: Record<string, unknown> = {}) { this.calls.push({ op, args }); return this.answer(op, args); }
  stop() {}
}
const square: CadPreview = { triangles: 2, nodes: [{ id: "Enclosure", label: "Enclosure", role: "primitive", type: "Box", metadata: {}, children: [
  { id: "Enclosure", label: "Enclosure", role: "primitive", type: "Box", color: "#9aa4ae", metadata: {}, positions: float([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), indices: uint([0, 1, 2, 0, 2, 3]), triangles: 2 },
] }] };
const report = (revision: number) => ({ id: "cad1", name: "Enclosure", revision, path: null, saved: false, handed_off: false, solids: [{ id: "Enclosure", label: "Enclosure", valid: true }] });

test("v0.7 cad_model (mocked backend): a confirmed revision opens the CAD viewer with the preview; arguments are checked first", async () => {
  const fake = new FakeCad(op => op === "add_primitive" ? { ok: true, result: { created: "Enclosure" }, document: report(2), preview: square } : { ok: true, result: { document: "cad1" }, document: report(1), preview: { nodes: [], triangles: 0 } });
  const aion = await connectAion({ cad: fake as unknown as FreecadBackend });
  try {
    const refused = out(await aion.call("cad_model", { action: "add_primitive", args: { kind: "box", length: 0, width: 1, height: 1 } }));
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /invalid-arguments/);
    assert.equal(fake.calls.length, 0, "an invalid request never reaches FreeCAD");
    const created = out(await aion.call("cad_model", { action: "create_document", args: { name: "Enclosure" } }));
    assert.match(created.content[0].text, /no visible solid yet/);
    const box = out(await aion.call("cad_model", { action: "add_primitive", args: { kind: "box", length: 120, width: 80, height: 40, name: "Enclosure" } }));
    assert.equal(box.isError, undefined);
    assert.match(box.content[0].text, /revision 2/);
    const state = await aion.link.run(backend => backend.state());
    assert.equal(state.card?.app, "cad-viewer");
    assert.equal(state.card?.asset?.name, "freecad-cad1.glb");
  } finally { await aion.close(); }
});

test("v0.7 cad_model (mocked backend): \"this part\" is the viewer's selection; a refusal says nothing changed and never claims success", async () => {
  const fake = new FakeCad(op => op === "set_parameter"
    ? { ok: false, error: { code: "regeneration-failed", message: "FreeCAD could not regenerate the model: Fillet1 could not be computed." } }
    : { ok: true, result: { created: "Enclosure" }, document: report(2), preview: square });
  const aion = await connectAion({ cad: fake as unknown as FreecadBackend });
  try {
    const none = out(await aion.call("cad_model", { action: "set_parameter", args: { component: "$selected", parameter: "Length", value: 150 } }));
    assert.match(none.content[0].text, /no-selection/);
    await aion.call("cad_model", { action: "add_primitive", args: { kind: "box", length: 120, width: 80, height: 40 } });
    const card = (await aion.link.run(backend => backend.state())).card!;
    const reported = await aion.link.run(backend => backend.cardReport({ window: "windowabc1", instance: card.instance, selection: { objectId: "Enclosure", name: "Enclosure" } }));
    assert.equal(reported.ok, true);
    const failed = out(await aion.call("cad_model", { action: "set_parameter", args: { component: "$selected", parameter: "Length", value: 150 } }));
    assert.equal(fake.calls.at(-1)?.args.component, "Enclosure", "the selection's FreeCAD id was sent");
    assert.equal(fake.calls.at(-1)?.args.document, "cad1", "to the document the viewer shows");
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /regeneration-failed.*previous valid model is unchanged.*never say it worked/s);
  } finally { await aion.close(); }
});

test("v0.7 cad_model: without FreeCAD, a clear installation message and nothing else is affected", async () => {
  const cad = new FreecadBackend({ script: WORKER, env: { AION_FREECAD: "/nowhere/freecadcmd", PATH: "", AION_CAD_WORKSPACE: join(tmpdir(), "aion-none") } });
  // Force "not found" even on a machine that has FreeCAD in a standard place.
  (cad as unknown as { launch(): Promise<never> }).launch = () => Promise.reject(Object.assign(new Error("FreeCAD is not installed (or not found). Install FreeCAD 1.0 or newer from https://www.freecad.org/downloads.php"), { code: "backend-unavailable" }));
  const aion = await connectAion({ cad });
  try {
    const result = out(await aion.call("cad_model", { action: "status" }));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /backend-unavailable: FreeCAD is not installed.*freecad\.org/s);
    const other = out(await aion.call("show_clock", {}));
    assert.notEqual(other.isError, true, "the rest of Aion works");
  } finally { await aion.close(); }
});

// ── Real FreeCAD (integration) ────────────────────────────────────────────────────────────────────────────────────

const installed = findFreecad();
const real = { skip: installed ? false : "FreeCAD is not installed here: the real-FreeCAD integration test is skipped (it is not evidence either way)" };

test("v0.7 real FreeCAD: scenarios A–G (create, modify, holes, the selected hole, undo, save and reopen, failure)", real, async () => {
  const folder = mkdtempSync(join(tmpdir(), "aion-freecad-"));
  const workspace = join(folder, "workspace");
  const cad = new FreecadBackend({ script: WORKER, env: { AION_CAD_WORKSPACE: workspace } });
  const aion = await connectAion({ cad });
  const cadOf = (value: Out) => value.structuredContent?.cad as { revision: number; solids: { id: string; volume_mm3: number; size_mm: number[]; valid: boolean }[]; components?: { id: string; label: string; role: string; parameters: Record<string, string> }[]; file?: string; result: Record<string, unknown> };
  const call = async (action: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const value = out(await aion.call("cad_model", { action, args, ...extra }));
    if (value.isError) assert.fail(`${action}: ${value.content[0].text}`);
    return cadOf(value);
  };
  try {
    // A — a real parametric document, 120 × 80 × 40 mm.
    await call("create_document", { name: "Enclosure" });
    let doc = await call("add_primitive", { kind: "box", length: 120, width: 80, height: 40, name: "Enclosure" });
    assert.deepEqual(doc.solids[0].size_mm, [120, 80, 40]);
    assert.equal(doc.solids[0].volume_mm3, 384_000);
    // B — length 150: FreeCAD recomputes, the revision advances.
    const before = doc.revision;
    doc = await call("set_parameter", { component: "Enclosure", parameter: "Length", value: 150 });
    assert.ok(doc.revision > before);
    assert.deepEqual(doc.solids[0].size_mm, [150, 80, 40]);
    // C — four 6 mm through holes near the corners: real cuts (volume drops by 4 × π·3²·40).
    doc = await call("add_holes", { target: "Enclosure", diameter: 6, corners: 8 });
    const drilled = 150 * 80 * 40 - 4 * Math.PI * 9 * 40;
    assert.ok(Math.abs(doc.solids[0].volume_mm3 - drilled) < 1, `${doc.solids[0].volume_mm3} ≈ ${drilled}`);
    assert.equal(doc.solids[0].valid, true);
    // The holes follow the box: lengthening it keeps them 8 mm from the corners (FreeCAD expressions).
    doc = await call("set_parameter", { component: "Enclosure", parameter: "Length", value: 160 });
    assert.deepEqual(doc.solids[0].size_mm, [160, 80, 40]);
    // D — the user selects Hole 2 in the viewer and says "move this hole 5 mm inward".
    const card = (await aion.link.run(backend => backend.state())).card!;
    assert.equal(card.app, "cad-viewer");
    await aion.link.run(backend => backend.cardReport({ window: "windowabc1", instance: card.instance, selection: { objectId: "Hole2", name: "Hole 2" } }));
    doc = await call("set_parameter", { component: "$selected", parameter: "Inset", delta: 5 });
    const inspected = await call("inspect");
    const holes = inspected.components!.filter(c => c.role === "hole");
    assert.equal(holes.length, 4);
    assert.deepEqual([holes.find(h => h.id === "Hole2")!.parameters["Inset X"], holes.find(h => h.id === "Hole2")!.parameters["Inset Y"]], ["13 mm", "13 mm"], "both insets, one change");
    assert.ok(holes.filter(h => h.id !== "Hole2").every(h => h.parameters["Inset X"] === "8 mm"), "the other holes are untouched");
    // E — undo: the whole move is undone (both insets back to 8), as a new revision in a coherent history.
    const undone = await call("undo");
    assert.ok(undone.revision > doc.revision);
    const afterUndo = (await call("inspect")).components!.find(c => c.id === "Hole2")!;
    assert.deepEqual([afterUndo.parameters["Inset X"], afterUndo.parameters["Inset Y"]], ["8 mm", "8 mm"]);
    // G — an impossible change: refused, the model as it was.
    const impossible = out(await aion.call("cad_model", { action: "add_holes", args: { target: "Enclosure", diameter: 6, positions: [[900, 900]] } }));
    assert.equal(impossible.isError, true);
    assert.match(impossible.content[0].text, /outside.*Nothing was changed/s);
    const unchanged = await call("inspect");
    assert.equal(unchanged.revision, undone.revision, "no revision for a refused change");
    // F — save as a native .FCStd, close, reopen: still parametric and editable.
    const path = join(folder, "Enclosure.FCStd");
    await call("save", { path });
    assert.ok(statSync(path).size > 1000);
    const overwrite = out(await aion.call("cad_model", { action: "save", args: { path: join(folder, "Enclosure.FCStd") } }));
    assert.notEqual(overwrite.isError, true, "saving again to its own file is allowed");
    await call("close");
    const reopened = await call("open_document", { path });
    assert.deepEqual(reopened.solids[0].size_mm, [160, 80, 40]);
    const again = await call("set_parameter", { component: "Enclosure", parameter: "Height", value: 50 });
    assert.deepEqual(again.solids[0].size_mm, [160, 80, 50]);
    assert.ok(Math.abs(again.solids[0].volume_mm3 - (160 * 80 * 50 - 4 * Math.PI * 9 * 50)) < 1, "the holes still go through: the expressions survived saving");
    // A new worker (Codex starts a new MCP server for a new turn or after a restart) carries on: same document, same
    // revision, and undo restores the previous FreeCAD state.
    cad.stop();
    const later = new FreecadBackend({ script: WORKER, env: { AION_CAD_WORKSPACE: workspace } });
    const resumed = await later.call("set_parameter", { component: "Enclosure", parameter: "Width", value: 90 });
    assert.equal(resumed.ok, true, JSON.stringify(!resumed.ok && resumed.error));
    assert.ok(resumed.ok && resumed.document!.revision === again.revision + 1 && resumed.document!.solids[0].size_mm![1] === 90, "the next worker continues the same document");
    const back = await later.call("undo");
    assert.ok(back.ok && back.document!.solids[0].size_mm![1] === 80, "and undoes across workers (a saved FreeCAD state)");
    later.stop();
    // Never overwrite another file silently.
    const other = out(await aion.call("cad_model", { action: "save", args: { path: join(folder, "Enclosure.FCStd").replace("Enclosure.FCStd", "Other.FCStd") } }));
    assert.notEqual(other.isError, true);
    const clash = out(await aion.call("cad_model", { action: "save", args: { path } }));
    assert.equal(clash.isError, true, "the first file is now another document's: refused");
    assert.match(clash.content[0].text, /file-exists/);
  } finally {
    cad.stop();
    await aion.close();
  }
});
