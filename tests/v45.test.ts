import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_LIMITS, checkCommand, checkConfig, checkState, validateManifest, type CardAppManifest } from "../src/cards/manifest";
import { CardRegistry, defaultCardRegistry, BUILTIN_CARD_APPS } from "../src/cards/registry";
import { checkValue } from "../src/cards/values";
import { CARD_PROTOCOL_VERSION, messageBytes, newInstanceId, parseFromCard, parseToCard, RateLimiter } from "../src/cards/protocol";
import { Lifecycle, nextLifecycle } from "../src/cards/lifecycle";
import { applyCardReport, checkCardReport, openCard, queueCardCommand } from "../src/cards/state";
import { AssetError, packGltf, readGlb, selfContainedGlb, validateGlb, writeGlb } from "../src/cards/assets/gltf";
import { loadModel } from "../src/host/cardAssets";
import { EARTH_MOON_MANIFEST } from "../src/cards/apps/earthMoon.manifest";
import { CAD_VIEWER_MANIFEST } from "../src/cards/apps/cadViewer.manifest";
import { ASTRONOMY, MOON_RADIUS, TRUE_DISTANCE, moonPosition, nearSideFacesEarth, orbitAngle, earthRotation, orbitNormal } from "../src/cards/apps/earthMoon/model";
import { decodeLandMask } from "../src/cards/apps/earthMoon/textures";
import { ParentBridge } from "../src/surface/cards/bridge";
import { PresenceStore } from "../src/core/store";
import { routePresentation } from "../src/core/presentationRouter";
import { PresenceHub } from "../src/host/hub/hub";
import { hubCommandSchema } from "../src/host/hub/protocol";
import type { PresentationContent } from "../src/core/presentation";
import { ASSETS_DIR, connectAion, tempHome, PAGE } from "./helpers";

const REPO = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const INSTANCE = "cabcdefgh12345678";
const envelope = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ v: CARD_PROTOCOL_VERSION, instance: INSTANCE, type, payload, ...extra });
const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");
const interactive = (app = "earth-moon", instance = INSTANCE, extra: Partial<Extract<PresentationContent, { kind: "interactive" }>> = {}): PresentationContent =>
  ({ kind: "interactive", app, instance, title: "Card", layout: "expanded", config: {}, ...extra });

// ── Registry and manifests ─────────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 registry: the built-in applications register; unknown ids are not there; ids are unique", () => {
  const registry = defaultCardRegistry();
  assert.deepEqual(registry.ids(), ["earth-moon", "cad-viewer", "generative-scene", "route-explorer"]); // v0.5 adds the generated scene, v0.6 the Route Explorer
  assert.equal(registry.get("browser"), undefined);
  assert.throws(() => registry.register(EARTH_MOON_MANIFEST), /card-app-duplicate/);
  // A future application is a manifest: no change to the engine.
  const future: CardAppManifest = { ...structuredClone(CAD_VIEWER_MANIFEST), id: "waveform-viewer", name: "Waveform viewer", entry: "waveform-viewer" };
  assert.equal(new CardRegistry().register(future).id, "waveform-viewer");
});

test("v0.4.5 manifests: undeclared capabilities, permissions, limits above Aion's ceilings and universal command names are refused", () => {
  const base = structuredClone(EARTH_MOON_MANIFEST) as unknown as Record<string, unknown>;
  const bad = (patch: Record<string, unknown>) => validateManifest({ ...structuredClone(base), ...patch });
  assert.equal(validateManifest(base).ok, true);
  for (const [patch, problem] of [
    [{ capabilities: ["webgl", "network"] }, /network is not one Aion grants/],
    [{ capabilities: ["webgl", "filesystem"] }, /filesystem/],
    [{ permissions: ["pointer", "camera-access"] }, /camera-access/],
    [{ resources: { ...EARTH_MOON_MANIFEST.resources, maxAssetBytes: CARD_LIMITS.assetBytes + 1 } }, /exceeds Aion's limit/],
    [{ resources: { ...EARTH_MOON_MANIFEST.resources, assets: ["model"] } }, /needs the model-assets capability/],
    [{ commands: { ...EARTH_MOON_MANIFEST.commands, close: { value: { type: "none" }, description: "x" } } }, /universal/],
    [{ commands: { run: { value: { type: "code" }, description: "Run code" } } }, /needs a value type/],
    [{ state: { "bad key": { type: "boolean" } } }, /not a valid name/],
    [{ entry: "../../evil" }, /entry/],
    [{ script: "alert(1)" }, /unknown field script/],
    [{ cleanup: { onClose: "keep", onHidden: "suspend" } }, /cleanup/],
    [{ display: { ...EARTH_MOON_MANIFEST.display, defaultLayout: "popup" } }, /defaultLayout/],
  ] as const) {
    const checked = bad(patch as Record<string, unknown>);
    assert.equal(checked.ok, false, JSON.stringify(patch));
    if (!checked.ok) assert.ok(checked.problems.some(p => problem.test(p)), `${JSON.stringify(patch)} → ${checked.problems.join("; ")}`);
  }
  assert.equal(validateManifest({ ...structuredClone(base), hybrid: { not: "a scene" } }, () => false).ok, false, "the body form must be a valid scene");
});

test("v0.4.5 values, settings, commands and state are checked against the manifest's declared types", () => {
  assert.deepEqual(checkValue({ type: "number", min: 0, max: 10 }, 5), { ok: true, value: 5 });
  assert.equal(checkValue({ type: "number", min: 0, max: 10 }, 11).ok, false);
  assert.equal(checkValue({ type: "enum", values: ["a"] }, "<script>").ok, false);
  assert.equal(checkValue({ type: "id" }, "assembly/core").ok, true);
  assert.equal(checkValue({ type: "id" }, "javascript:alert(1)").ok, false);
  assert.equal(checkValue({ type: "text", max: 10 }, "a\u0000b").ok, false);
  assert.equal(checkValue({ type: "tree", max: 2 }, [{ id: "a", name: "A", depth: 0, visible: true, onclick: "x" }]).ok, false);
  assert.equal(checkConfig(EARTH_MOON_MANIFEST, { focus: "moon", speed: 2 }).ok, true);
  assert.equal(checkConfig(EARTH_MOON_MANIFEST, { focus: "<img src=x onerror=alert(1)>" }).ok, false);
  assert.equal(checkConfig(EARTH_MOON_MANIFEST, { html: "<b>" }).ok, false);
  assert.deepEqual(checkCommand(EARTH_MOON_MANIFEST, "pause", undefined), { ok: true, universal: true });
  assert.equal(checkCommand(EARTH_MOON_MANIFEST, "set-time-speed", 10).ok, true);
  assert.equal(checkCommand(EARTH_MOON_MANIFEST, "set-time-speed", 1e9).ok, false);
  assert.equal(checkCommand(EARTH_MOON_MANIFEST, "eval", "1+1").ok, false);
  assert.equal(checkCommand(CAD_VIEWER_MANIFEST, "hide", "assembly/windings").ok, true);
  assert.equal(checkState(CAD_VIEWER_MANIFEST, { selected: "assembly/core", secret: 1 }).ok, false);
});

// ── The bridge protocol ────────────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 bridge: messages are versioned, owned by one instance, declared, bounded and plain JSON", () => {
  const ok = parseFromCard(envelope("READY", { app: "earth-moon", version: EARTH_MOON_MANIFEST.version }), INSTANCE, EARTH_MOON_MANIFEST);
  assert.equal(ok.ok, true);
  const refuse = (raw: unknown, manifest: CardAppManifest = EARTH_MOON_MANIFEST) => { const r = parseFromCard(raw, INSTANCE, manifest); assert.equal(r.ok, false, JSON.stringify(raw)?.slice(0, 80)); return r.ok ? "" : r.problem; };
  assert.match(refuse({ ...envelope("READY", { app: "earth-moon", version: "1.0.0" }), instance: "cother0000000000" }), /stale instance/);
  assert.match(refuse({ ...envelope("READY", {}), v: 2 }), /version/);
  assert.match(refuse(envelope("RUN_SCRIPT", { code: "alert(1)" })), /unknown message type/);
  assert.match(refuse(envelope("STATE_CHANGED", { state: { secret: true } })), /undeclared state/);
  assert.match(refuse(envelope("STATE_CHANGED", { state: { day: "x".repeat(CARD_LIMITS.messageBytes) } })), /too large/);
  assert.match(refuse(envelope("ERROR", { code: "x", message: () => 1, fatal: true })), /plain JSON/);
  assert.match(refuse(envelope("INTERACTION", { kind: "keylogger" })), /unknown interaction/);
  assert.match(refuse(envelope("SELECTION_CHANGED", { objectId: "earth", properties: { "<img>": "x" } })), /property name/);
  assert.match(refuse(envelope("RESULT", { ok: true })), /must answer a request/);
  assert.match(refuse("not an object"), /not an object/);
  assert.match(refuse({ ...envelope("READY", {}), extra: 1 }), /unknown envelope fields/);
  // A capability the manifest does not declare: its messages are refused.
  const noSelection = { ...EARTH_MOON_MANIFEST, capabilities: EARTH_MOON_MANIFEST.capabilities.filter(c => c !== "selection") } as CardAppManifest;
  assert.match(refuse(envelope("SELECTION_CHANGED", { objectId: "earth" }), noSelection), /needs the selection capability/);
  assert.equal(messageBytes({ a: new ArrayBuffer(4) }), Infinity, "binary data never travels from a card");
  // Aion → card is validated too: no assets for an application without model-assets, no universal commands as commands.
  const data = new ArrayBuffer(8);
  assert.equal(parseToCard(envelope("LOAD_ASSET", { asset: { id: "m1", name: "a.glb", kind: "model", bytes: 8, sha256: "a".repeat(64) }, data }), INSTANCE, EARTH_MOON_MANIFEST).ok, false);
  assert.equal(parseToCard(envelope("LOAD_ASSET", { asset: { id: "m1", name: "a.glb", kind: "model", bytes: 9, sha256: "a".repeat(64) }, data }), INSTANCE, CAD_VIEWER_MANIFEST).ok, false, "bytes must match");
  assert.equal(parseToCard(envelope("LOAD_ASSET", { asset: { id: "m1", name: "a.glb", kind: "model", bytes: 8, sha256: "a".repeat(64) }, data }), INSTANCE, CAD_VIEWER_MANIFEST).ok, true);
  assert.equal(parseToCard(envelope("EXECUTE_COMMAND", { command: "pause" }), INSTANCE, EARTH_MOON_MANIFEST).ok, false);
  assert.equal(parseToCard(envelope("EXECUTE_COMMAND", { command: "focus", value: "moon" }), INSTANCE, EARTH_MOON_MANIFEST).ok, true);
  assert.match(newInstanceId(), /^c[a-z0-9]{16}$/);
});

test("v0.4.5 bridge: request/response correlation, timeouts, stale replies, and a flooding card is cut off", async () => {
  const channel = new MessageChannel();
  const received: string[] = [], dropped: string[] = [];
  let flooded = false;
  const bridge = new ParentBridge(channel.port1, INSTANCE, EARTH_MOON_MANIFEST, {
    message: message => received.push(message.type), dropped: problem => dropped.push(problem), flooded: () => { flooded = true; },
  });
  const card = channel.port2;
  card.onmessage = event => {
    const message = event.data as { id?: string; type: string };
    if (message.type === "RESET" && message.id) card.postMessage(envelope("RESULT", { ok: true }, { re: message.id }));
  };
  card.start();
  assert.deepEqual(await bridge.request("RESET", {}), { ok: true }, "the answer is matched to its request");
  const slow = await bridge.request("PAUSE", { reason: "codex" }, { seconds: 0.2 });
  assert.equal(slow.ok, false, "a request that is not answered times out");
  card.postMessage(envelope("RESULT", { ok: true }, { re: "rnotasked" }));
  card.postMessage({ ...envelope("STATE_CHANGED", { state: { day: 1 } }), instance: "cstale0000000000" });
  card.postMessage(envelope("STATE_CHANGED", { state: { day: 1 } }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(received.includes("STATE_CHANGED"));
  assert.ok(dropped.some(p => /answers no request/.test(p)) && dropped.some(p => /stale instance/.test(p)), dropped.join("; "));
  // A flood: far beyond the rate; the bridge closes itself instead of passing it on.
  for (let i = 0; i < CARD_LIMITS.messageBurst + CARD_LIMITS.floodDrops + 50; i++) card.postMessage(envelope("INTERACTION", { kind: "wheel" }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(flooded, true);
  assert.equal(bridge.open, false);
  assert.ok(bridge.stats.received <= CARD_LIMITS.messageBurst + 10, `received ${bridge.stats.received}`);
  card.close();
});

test("v0.4.5 rate limiter: a burst, then a steady rate", () => {
  let now = 0;
  const limiter = new RateLimiter(5, 10, () => now);
  assert.equal(Array.from({ length: 8 }, () => limiter.take()).filter(Boolean).length, 5);
  now += 500;
  assert.equal(Array.from({ length: 8 }, () => limiter.take()).filter(Boolean).length, 5);
  assert.equal(limiter.dropped, 6);
});

// ── Lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 lifecycle: every transition is explicit; suspend remembers pause; disposed is final", () => {
  const seen: string[] = [];
  const lifecycle = new Lifecycle(state => seen.push(state));
  for (const event of ["launch", "ready", "activate", "pause", "suspend", "wake", "resume", "reload", "ready", "activate", "fail", "retry", "ready", "dispose", "disposed"] as const) {
    assert.equal(lifecycle.send(event), true, event);
  }
  assert.deepEqual(seen, ["loading", "ready", "active", "paused", "suspended", "paused", "active", "loading", "ready", "active", "error", "loading", "ready", "disposing", "disposed"]);
  assert.equal(lifecycle.send("launch"), false, "a disposed card never comes back");
  assert.equal(nextLifecycle("loading", "pause"), null);
  assert.equal(nextLifecycle("error", "activate"), null, "an error needs a retry");
});

// ── Card state in the hub ──────────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 card state: reports about another instance are refused; state merges; commands are numbered and bounded", () => {
  const card = openCard({ instance: INSTANCE, app: "cad-viewer", title: "T", layout: "expanded", asset: null, config: {}, now: 1 });
  assert.equal(checkCardReport({ window: "abcdefgh", instance: "cobsolete0000000" }, card, CAD_VIEWER_MANIFEST).ok, false);
  assert.equal((checkCardReport({ window: "abcdefgh", instance: "cobsolete0000000" }, card, CAD_VIEWER_MANIFEST) as { stale?: boolean }).stale, true);
  assert.equal(checkCardReport({ window: "abcdefgh", instance: INSTANCE, state: { secret: 1 } }, card, CAD_VIEWER_MANIFEST).ok, false);
  assert.equal(checkCardReport({ window: "abcdefgh", instance: INSTANCE, acks: [{ seq: 5, ok: true }] }, card, CAD_VIEWER_MANIFEST).ok, false, "an acknowledgement of a command never sent");
  let next = card;
  for (let i = 0; i < CARD_LIMITS.commandQueue + 4; i++) next = queueCardCommand(next, "fit", undefined, i).card;
  assert.equal(next.commands.length, CARD_LIMITS.commandQueue);
  assert.equal(next.nextSeq, CARD_LIMITS.commandQueue + 5);
  const report = checkCardReport({ window: "abcdefgh", instance: INSTANCE, lifecycle: "active", state: { selected: "assembly/core" }, selection: { objectId: "assembly/core", name: "Magnetic Core" }, acks: [{ seq: 3, ok: true }] }, next, CAD_VIEWER_MANIFEST);
  assert.equal(report.ok, true);
  if (report.ok) {
    const merged = applyCardReport(next, report.report, 2);
    assert.equal(merged.lifecycle, "active");
    assert.equal(merged.selection?.name, "Magnetic Core");
    assert.deepEqual(merged.acks, [{ seq: 3, ok: true }]);
  }
});

test("v0.4.5 presentation: an interactive card is a card (hybrid only with a body form), stays until closed, and its state lives with it", () => {
  assert.deepEqual(routePresentation({ content: interactive() }), { route: "card", reason: "interactive", preference: "auto" });
  assert.equal(routePresentation({ content: interactive(), preference: "hybrid" }).route, "card", "no body form: a card");
  assert.equal(routePresentation({ content: interactive("earth-moon", INSTANCE, { bodyScene: EARTH_MOON_MANIFEST.hybrid as never }), preference: "hybrid" }).route, "hybrid");
  assert.equal(routePresentation({ content: interactive(), preference: "body" }).route, "card", "an application is never particles alone");
  let scheduled = 0;
  const store = new PresenceStore({ now: () => 1000, schedule: () => { scheduled++; return () => {}; } });
  const shown = store.present(interactive());
  assert.equal(shown.hold, 0, "until closed or replaced");
  assert.equal(scheduled, 0, "no expiry is scheduled");
  assert.equal(store.snapshot().card?.instance, INSTANCE);
  assert.equal(store.snapshot().card?.lifecycle, "loading");
  store.shorten(15);
  assert.ok(store.snapshot().presentation, "a new prompt does not end it");
  const queued = store.cardCommand("focus", "moon");
  assert.equal(queued.ok && queued.seq, 1);
  assert.equal(store.cardCommand("eval", "x").ok, false);
  assert.equal(store.cardCommand("expand").ok, true);
  assert.equal(store.cardCommand("collapse").ok && store.snapshot().card?.layout, "compact");
  // The same instance again keeps its card (its commands, its state).
  store.present(interactive("earth-moon", INSTANCE, { title: "Again" }));
  assert.equal(store.snapshot().card?.commands.length, 1);
  assert.equal(store.snapshot().card?.title, "Again");
  store.present({ kind: "text", text: "Something else" });
  assert.equal(store.snapshot().card, null, "a replacement ends the card");
  store.present(interactive("earth-moon", "cnewinstance0000"));
  assert.equal(store.cardCommand("close").ok, true);
  assert.equal(store.snapshot().presentation, null);
  assert.equal(store.snapshot().card, null);
});

test("v0.4.5 hub protocol: unregistered applications, foreign body forms and invalid settings never pass", () => {
  const present = (content: unknown) => hubCommandSchema.safeParse({ type: "present", content }).success;
  assert.equal(present(interactive()), true);
  assert.equal(present({ ...interactive(), app: "browser" }), false, "an unregistered application");
  assert.equal(present({ ...interactive(), config: { focus: "<script>alert(1)</script>" } }), false);
  assert.equal(present({ ...interactive(), html: "<iframe src=//evil>" }), false, "no free-form fields");
  assert.equal(present({ ...interactive(), bodyScene: { title: "x", objects: [{ type: "sphere", radius: 9 }] } }), false, "only the manifest's own body form");
  assert.equal(present({ ...interactive(), instance: "../../x" }), false);
  assert.equal(present({ ...interactive("earth-moon"), asset: { id: "m0123456789abcdef01", name: "a.glb", bytes: 10, sha256: "a".repeat(64), mime: "model/gltf-binary" } }), false, "earth-moon takes no model");
  assert.equal(hubCommandSchema.safeParse({ type: "card", command: "exec", value: "rm -rf" }).success, false);
  assert.equal(hubCommandSchema.safeParse({ type: "card", command: "focus", value: "moon" }).success, true);
});

test("v0.4.5 hub: card reports need the token, name the current instance, stay small, and are rate-limited", async () => {
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => PAGE, bridge: { locate: () => null } });
  await hub.start();
  try {
    hub.apply({ type: "present", content: interactive("cad-viewer") });
    const token = new URL(hub.surfaceUrl).searchParams.get("token")!;
    // A refused oversized body may also be cut off mid-request (status 0 here): either way it never reaches the card.
    const post = (body: unknown, auth = true) => fetch(`${hub.url}api/card`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { "x-aion-token": token } : {}) }, body: JSON.stringify(body) })
      .catch(() => ({ status: 0 }));
    assert.equal((await post({ window: "abcdefgh", instance: INSTANCE }, false)).status, 403, "a frame without the token cannot report (it never has it)");
    assert.equal((await post({ window: "abcdefgh", instance: "cobsolete0000000" })).status, 409, "an obsolete card is ignored");
    assert.equal((await post({ window: "abcdefgh", instance: INSTANCE, state: { secret: 1 } })).status, 400);
    assert.ok([0, 413].includes((await post({ window: "abcdefgh", instance: INSTANCE, state: { selected: "x".repeat(200_000) } })).status));
    assert.equal((await post({ window: "abcdefgh", instance: INSTANCE, lifecycle: "active", selection: { objectId: "assembly/core", name: "Magnetic Core" } })).status, 204);
    assert.equal(hub.snapshot().card?.selection?.name, "Magnetic Core");
    let limited = 0;
    for (let i = 0; i < 80; i++) if ((await post({ window: "floodwin1", instance: INSTANCE, interacting: i % 2 === 0 })).status === 429) limited++;
    assert.ok(limited > 0, "a flooding window is refused");
    assert.ok((await post({ window: "abcdefgh", instance: INSTANCE, interacting: true })).status === 204, "other windows are unaffected");
  } finally { await hub.stop(); }
});

// ── Assets ───────────────────────────────────────────────────────────────────────────────────────────────────────
const transformer = () => new Uint8Array(readFileSync(join(ASSETS_DIR, "cards", "transformer.glb")));
const glbWith = (mutate: (json: Record<string, unknown>) => void) => { const { json, bin } = readGlb(transformer()); const copy = structuredClone(json) as Record<string, unknown>; mutate(copy); return writeGlb(copy, bin); };
const assetError = (fn: () => unknown, code: RegExp) => assert.throws(fn, (error: unknown) => error instanceof AssetError && code.test(error.message), code.source);

test("v0.4.5 glTF policy: the bundled transformer passes with every component named; hostile or broken models are refused", () => {
  const info = validateGlb(transformer());
  assert.equal(info.nodes, 17);
  assert.ok(info.triangles > 1000 && info.triangles < 20_000);
  assert.ok(info.names.includes("Magnetic Core") && info.names.includes("Primary Winding"));
  const { json } = readGlb(transformer());
  const ids = (json.nodes as { extras?: { aionId?: string } }[]).map(node => node.extras?.aionId);
  for (const id of ["assembly/core", "assembly/winding-primary", "assembly/winding-secondary", "assembly/windings"]) assert.ok(ids.includes(id), id);
  assetError(() => validateGlb(glbWith(j => { (j.buffers as { uri?: string }[])[0].uri = "https://example.com/payload.bin"; })), /external-dependency/);
  assetError(() => validateGlb(glbWith(j => { j.images = [{ uri: "file:///etc/passwd" }]; })), /external-dependency/);
  assetError(() => validateGlb(glbWith(j => { j.extensionsRequired = ["KHR_draco_mesh_compression"]; })), /unsupported-extension/);
  assetError(() => validateGlb(glbWith(j => { j.extensionsRequired = ["EXT_evil_script"]; })), /unsupported-extension/);
  assetError(() => validateGlb(glbWith(j => { (j.nodes as { children?: number[] }[])[1].children = [0]; })), /model-invalid/);
  assetError(() => validateGlb(glbWith(j => { (j.accessors as { count: number }[])[0].count = 1e7; })), /model-invalid/);
  assetError(() => validateGlb(glbWith(j => { (j.bufferViews as { byteLength: number }[])[0].byteLength = 1e9; })), /model-invalid/);
  assetError(() => validateGlb(transformer(), { bytes: 1000, nodes: 10_000, meshes: 4000, materials: 512, accessors: 20_000, textures: 64, textureSize: 4096, triangles: 2e6, depth: 64 }), /model-too-large/);
  assetError(() => validateGlb(transformer(), { bytes: 16e6, nodes: 10_000, meshes: 4000, materials: 512, accessors: 20_000, textures: 64, textureSize: 4096, triangles: 100, depth: 64 }), /model-too-large/);
  assetError(() => validateGlb(new TextEncoder().encode("<html><script>alert(1)</script></html>")), /model-invalid/);
  const truncated = transformer().slice(0, 4000);
  assetError(() => validateGlb(truncated), /model-invalid/);
  // Metadata is data: a "script" in extras is only ever text (the viewer renders it with textContent).
  assert.doesNotThrow(() => validateGlb(glbWith(j => { (j.nodes as { extras?: object }[])[1].extras = { onload: "<img src=x onerror=alert(1)>" }; })));
});

test("v0.4.5 glTF packing: a .gltf with external files becomes one self-contained GLB; anything outside its folder is refused", async () => {
  const dir = join(REPO, "tests/fixtures/cards");
  const packed = await packGltf(readFileSync(join(dir, "bracket.gltf"), "utf8"), async relative => new Uint8Array(readFileSync(join(dir, relative))));
  const info = validateGlb(packed);
  assert.equal(info.images, 1, "its texture travels inside the GLB");
  const { json } = readGlb(packed);
  assert.ok((json.buffers ?? []).every(buffer => buffer.uri === undefined) && (json.images ?? []).every(image => image.uri === undefined));
  for (const uri of ["../secret.bin", "/etc/passwd", "https://example.com/a.bin", "file:///etc/passwd", "sub/../../x.bin"]) {
    await assert.rejects(packGltf(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri, byteLength: 4 }] }), async () => new Uint8Array(4)), (error: unknown) => error instanceof AssetError && error.message === "external-dependency", uri);
  }
  // Embedded data: URIs move into the binary chunk (the card's sandbox fetches nothing, not even data: URLs).
  const { json: base, bin } = readGlb(transformer());
  const withDataUri = structuredClone(base);
  withDataUri.buffers![0].uri = `data:application/octet-stream;base64,${Buffer.from(bin!).toString("base64")}`;
  const contained = await selfContainedGlb(writeGlb(withDataUri, null));
  assert.equal(readGlb(contained).json.buffers![0].uri, undefined);
  assert.equal(validateGlb(contained).triangles, validateGlb(transformer()).triangles);
});

test("v0.4.5 model sources: bundled by name, a user's file by absolute path, never remote, never outside the model's folder", async () => {
  const bundled = await loadModel("transformer", ASSETS_DIR);
  assert.equal(bundled.bundled, true);
  assert.match(bundled.sha256, /^[a-f0-9]{64}$/);
  const imported = await loadModel(join(REPO, "tests/fixtures/cards/bracket.gltf"), ASSETS_DIR);
  assert.equal(imported.name, "bracket.glb");
  assert.ok(imported.info.nodes >= 6);
  for (const [source, code] of [["https://example.com/model.glb", /remote-model-not-supported/], ["model.glb", /model-path-not-absolute/], ["/tmp/x.obj", /model-type/], ["/nonexistent/model.glb", /model-not-found/]] as const) {
    await assert.rejects(loadModel(source, ASSETS_DIR), (error: unknown) => error instanceof AssetError && code.test(error.message), source);
  }
  // A .gltf whose buffer is a symbolic link out of its folder.
  const dir = mkdtempSync(join(tmpdir(), "aion-model-"));
  mkdirSync(join(dir, "model"));
  writeFileSync(join(dir, "outside.bin"), Buffer.alloc(16));
  symlinkSync(join(dir, "outside.bin"), join(dir, "model", "data.bin"));
  writeFileSync(join(dir, "model", "a.gltf"), JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "data.bin", byteLength: 16 }] }));
  await assert.rejects(loadModel(join(dir, "model", "a.gltf"), ASSETS_DIR), (error: unknown) => error instanceof AssetError && error.message === "external-dependency");
  copyFileSync(join(ASSETS_DIR, "cards", "transformer.glb"), join(dir, "copy.glb"));
  assert.equal((await loadModel(join(dir, "copy.glb"), ASSETS_DIR)).info.nodes, 17, "another valid GLB loads the same way");
});

// ── Earth–Moon model ───────────────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 Earth–Moon model: documented values, synchronous rotation keeps the near side toward Earth, a non-rotating Moon would not", () => {
  assert.equal(ASTRONOMY.earthDiameterKm, 12_742);
  assert.equal(ASTRONOMY.earthMoonDistanceKm, 384_400);
  assert.ok(Math.abs(ASTRONOMY.siderealMonthDays - 27.32) < 0.01);
  assert.ok(Math.abs(MOON_RADIUS - 0.2727) < 0.001);
  assert.ok(Math.abs(TRUE_DISTANCE - 60.34) < 0.05);
  for (let day = 0; day < 60; day += 0.37) assert.ok(nearSideFacesEarth(day, true, 0.5), `day ${day}`);
  const turnedAway = Array.from({ length: 28 }, (_, d) => d).filter(day => !nearSideFacesEarth(day, false, 10));
  assert.ok(turnedAway.length > 20, "without rotation the near side turns away");
  assert.ok(Math.abs(orbitAngle(ASTRONOMY.siderealMonthDays) % (2 * Math.PI)) < 1e-9 || Math.abs(orbitAngle(ASTRONOMY.siderealMonthDays) - 2 * Math.PI) < 1e-9, "one orbit per sidereal month");
  assert.ok(Math.abs(earthRotation(ASTRONOMY.siderealDayHours / 24)) < 1e-6 || Math.abs(earthRotation(ASTRONOMY.siderealDayHours / 24) - 2 * Math.PI) < 1e-6, "one turn per sidereal day");
  const p = moonPosition(5, 12);
  assert.ok(Math.abs(Math.hypot(...p) - 12) < 1e-9, "a circular orbit at the display distance");
  const n = orbitNormal();
  assert.ok(Math.abs(p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) < 1e-9, "in its inclined plane");
  assert.ok(Math.abs(Math.acos(n[1]) * 180 / Math.PI - ASTRONOMY.lunarInclinationDegrees) < 1e-9);
});

test("v0.4.5 Earth's land mask (Natural Earth): known land and ocean points", () => {
  const { width, height, mask } = decodeLandMask();
  const at = (lat: number, lon: number) => mask[Math.floor((90 - lat) / 180 * height) * width + Math.floor((lon + 180) / 360 * width)];
  assert.equal(at(5, 20), 1, "Central Africa");
  assert.equal(at(40, -100), 1, "North America");
  assert.equal(at(-25, 135), 1, "Australia");
  assert.equal(at(0, -30), 0, "Atlantic");
  assert.equal(at(0, -150), 0, "Pacific");
  assert.equal(at(-85, 0), 1, "Antarctica");
});

// ── MCP tools ────────────────────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 MCP: show, control and inspect an interactive card; only registered apps; no code through arguments", async () => {
  const aion = await connectAion();
  try {
    const unknown = await aion.call("show_interactive_card", { app: "browser" });
    assert.equal(unknown.isError, true, "an unregistered application cannot run");
    const injected = await aion.call("show_interactive_card", { app: "earth-moon", settings: { focus: "<script>alert(1)</script>" } });
    assert.equal(injected.isError, true);
    assert.match(text(injected), /invalid-settings/);
    assert.equal((await aion.call("show_interactive_card", { app: "earth-moon", html: "<b>x</b>" })).isError, true, "no free-form fields");
    assert.match(text(await aion.call("control_interactive_card", { action: "pause" })), /no-card/);

    const shown = await aion.call("show_interactive_card", { app: "earth-moon", settings: { teaching: true } });
    assert.equal(shown.isError, undefined);
    assert.match(text(shown), /Opened the Earth–Moon System card\. Aion is not open/);
    const card = (shown.structuredContent as { card: { app: string; instance: string; commands: string[] } }).card;
    assert.equal(card.app, "earth-moon");
    assert.ok(card.commands.includes("focus (system|earth|moon)"));
    assert.match(text(await aion.call("control_interactive_card", { action: "focus", value: "moon" })), /no window is showing the card/);
    assert.match(text(await aion.call("control_interactive_card", { action: "run-script", value: "alert(1)" })), /invalid-command/);
    assert.match(text(await aion.call("control_interactive_card", { action: "set-time-speed", value: 1e6 })), /invalid-command/);
    assert.match(text(await aion.call("control_interactive_card", { action: "fullscreen" })), /fullscreen/);
    assert.match(text(await aion.call("inspect_interactive_card")), /"lifecycle":"loading"/);

    const cad = await aion.call("show_interactive_card", { app: "cad-viewer", model: "transformer" });
    assert.match(text(cad), /Model: transformer\.glb \(17 nodes/);
    const remote = await aion.call("show_interactive_card", { app: "cad-viewer", model: "https://example.com/x.glb" });
    assert.match(text(remote), /remote-model-not-supported/);
    const reused = await aion.call("show_interactive_card", { app: "cad-viewer", model: join(REPO, "tests/fixtures/cards/bracket.gltf") });
    assert.equal((reused.structuredContent as { card: { instance: string } }).card.instance, (cad.structuredContent as { card: { instance: string } }).card.instance, "the open viewer loads the new model");
    assert.match(text(reused), /Updated the CAD Viewer card/);
    assert.match(text(await aion.call("control_interactive_card", { action: "close" })), /Closed/);
    assert.match(text(await aion.call("inspect_interactive_card")), /No interactive card is open/);
  } finally { await aion.close(); }
});

// ── Static security checks ───────────────────────────────────────────────────────────────────────────────────────
test("v0.4.5 isolation: the frame is sandboxed without same-origin, its document forbids network, and no card code runs strings as code", () => {
  const host = read("src/surface/cards/host.ts");
  assert.match(host, /setAttribute\("sandbox", "allow-scripts"\)/);
  assert.doesNotMatch(host, /"sandbox", "[^"]*(?:allow-same-origin|allow-top-navigation|allow-popups|allow-forms)/);
  assert.equal([...host.matchAll(/setAttribute\("sandbox"/g)].length, 1, "one sandbox, set in one place");
  assert.match(host, /setAttribute\("referrerpolicy", "no-referrer"\)/);
  const doc = read("src/cards/runtime/index.html");
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /frame-src 'none'/);
  const sources = ["src/cards/runtime/main.ts", "src/cards/runtime/engine.ts", "src/cards/runtime/app.ts", "src/cards/apps/earthMoon/app.ts", "src/cards/apps/cadViewer/app.ts", "src/surface/cards/host.ts", "src/surface/cards/bridge.ts", "src/cards/protocol.ts"];
  for (const file of sources) {
    const source = read(file);
    for (const pattern of [/\beval\(/, /new Function\(/, /\.innerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\bimportScripts\(/]) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`);
  }
  // The page never listens to window messages from the frame (only its own MessagePort).
  assert.doesNotMatch(host, /addEventListener\("message"/);
  // The token never reaches the frame: nothing about the hub, its URL or the token is in what the frame is given.
  const code = host.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /token|surfaceUrl|location\.search/);
  // The runtime accepts its port once, from its parent only.
  assert.match(read("src/cards/runtime/main.ts"), /if \(bound \|\| event\.source !== parent/);
});

test("v0.4.5: the built-in manifests and the runtime's application modules match", () => {
  const runtime = read("src/cards/runtime/apps.ts");
  for (const app of BUILTIN_CARD_APPS) assert.match(runtime, new RegExp(`"${app.entry}": create`), app.entry);
});
