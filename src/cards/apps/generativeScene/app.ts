import {
  AmbientLight, AxesHelper, Box3, BoxHelper, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, GridHelper, PointLight, Points, PointsMaterial, Vector3,
  type Material, type Object3D,
} from "three";
import { ViewerEngine } from "../../runtime/engine";
import { button, el, toggle, type CardApp, type CardContext, type CommandResult } from "../../runtime/app";
import type { CardValue } from "../../values";
import { PoseEvaluator, SceneTimeline, type NodePose } from "../../../scene/animation";
import type { SceneDocument } from "../../../scene/ir";
import { CompileError, SceneCompiler, type Entry } from "./compiler";

/**
 * The generative scene card (v0.5): a general-purpose Three.js runtime for Scene IR documents. It renders whatever
 * validated scene Aion hands it (LOAD_SCENE), applies each new revision as the smallest change (SceneCompiler), runs
 * the scene's animations on one frame-rate-independent timeline (src/scene/animation.ts), and lets the user turn, zoom,
 * pan, select and inspect any object — the selection is reported to Aion so Codex can act on "this object".
 *
 * It never executes anything from the scene: geometry, materials and motion are built from validated numbers and fixed
 * names only. Every disclosure the scene carries (scale, illustrative) is always on screen.
 */
type View = "iso" | "top" | "front" | "side" | "scene" | "custom";
const SPEEDS = [0, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 50];
const VIEW_DIRECTIONS: Record<Exclude<View, "scene" | "custom">, Vector3> = {
  iso: new Vector3(1, 0.75, 1.25), top: new Vector3(0.0001, 1, 0.0001), front: new Vector3(0, 0.12, 1), side: new Vector3(1, 0.12, 0),
};

export function createGenerativeScene(ctx: CardContext): CardApp {
  const engine = new ViewerEngine(ctx.stage, { reducedMotion: ctx.reducedMotion, near: 0.001, far: 1e6, fov: 42 });
  const { scene, camera } = engine;
  const accent = new Color(ctx.theme.accent);
  const compiler = new SceneCompiler({ maxTriangles: ctx.limits.maxTriangles, animatedOpacity: id => animatedOpacity.has(id) });
  scene.add(compiler.root);
  const timeline = new SceneTimeline();
  let animatedOpacity = new Set<string>();
  let evaluator: PoseEvaluator | null = null;
  let doc: SceneDocument | null = null;
  const s = {
    revision: 0, labels: ctx.config.labels !== false, view: "iso" as View, selected: null as string | null, suspended: false, running: ctx.config.paused !== true,
    speedSet: false, lastTimeline: "", lastCamera: "", lastEnvironment: "", reportedTime: -1, changes: "", buildMs: 0,
  };

  // ── Environment: lights, background, helpers ───────────────────────────────────────────────────────────────────
  scene.background = new Color("#05070b");
  const ambient = new AmbientLight("#b8c4d4", 0.35);
  const key = new DirectionalLight("#ffffff", 2.2);
  key.position.set(5, 8, 6);
  scene.add(ambient, key);
  let helpers: { grid?: GridHelper; axes?: AxesHelper; stars?: Points; light?: PointLight } = {};
  const clearHelpers = () => {
    for (const helper of [helpers.grid, helpers.axes, helpers.stars]) if (helper) { helper.removeFromParent(); helper.geometry.dispose(); (helper.material as Material).dispose(); }
    helpers.light?.removeFromParent();
    helpers.light?.dispose();
    helpers = {};
  };
  const sceneRadius = () => { const box = new Box3().setFromObject(compiler.root); return box.isEmpty() ? 5 : Math.max(0.5, box.getSize(new Vector3()).length() / 2); };
  const applyEnvironment = (document: SceneDocument) => {
    const env = document.environment ?? {};
    scene.background = new Color(env.background ?? "#05070b");
    ambient.intensity = env.ambient ?? 0.35;
    key.visible = env.light !== false;
    const signature = JSON.stringify(env) + (env.lightSource ? JSON.stringify(document.objects.find(n => n.id === env.lightSource)?.material ?? null) : "");
    if (signature === s.lastEnvironment && (!env.lightSource || helpers.light?.parent === compiler.entries.get(env.lightSource)?.holder)) return;
    s.lastEnvironment = signature;
    clearHelpers();
    const r = sceneRadius();
    if (env.grid) { helpers.grid = new GridHelper(r * 2.4, 24, "#3a4552", "#1f2731"); scene.add(helpers.grid); }
    if (env.axes) { helpers.axes = new AxesHelper(r * 0.6); scene.add(helpers.axes); }
    if (env.stars) {
      let seed = 11;
      const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const points: number[] = [];
      for (let i = 0; i < 1800; i++) { const z = rand() * 2 - 1, t = rand() * Math.PI * 2, q = Math.sqrt(1 - z * z); points.push(q * Math.cos(t) * r * 40, z * r * 40, q * Math.sin(t) * r * 40); }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
      helpers.stars = new Points(geometry, new PointsMaterial({ color: "#c8d2de", size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.7 }));
      scene.add(helpers.stars);
    }
    const source = env.lightSource ? compiler.entries.get(env.lightSource) : undefined;
    if (source) {
      const values = compiler.materialValues(source.node);
      helpers.light = new PointLight(values.emissive ?? values.color ?? "#fff4e0", 3.2, 0, 0);
      source.holder.add(helpers.light);
      key.intensity = 0.35;
    } else key.intensity = 2.2;
  };

  // ── Overlay: labels, disclosure, inspector, controls (text only) ───────────────────────────────────────────────
  const labelLayer = el("div", { className: "labels" });
  const labels = new Map<string, HTMLElement>();
  /** Each label's measured width (its text does not change while it exists; a new text is a new measurement). */
  const labelWidths = new WeakMap<HTMLElement, number>();
  const badge = el("div", { className: "badge" });
  const info = el("div", { className: "panel info" });
  info.hidden = true;
  info.setAttribute("aria-live", "polite");
  const empty = el("div", { className: "empty", text: "Waiting for a scene…" });
  const clock = el("span", { className: "readout" });
  clock.setAttribute("aria-live", "off");
  const seek = el("input", { className: "seek", label: "Timeline position" }) as HTMLInputElement;
  seek.type = "range"; seek.min = "0"; seek.max = "60"; seek.step = "0.1"; seek.value = "0";
  seek.addEventListener("input", () => { if (!doc) return; timeline.seek(Number(seek.value), doc.animations ?? []); frame(0); changed(); });
  const labelsToggle = toggle("Labels", "Show labels", () => s.labels, on => { s.labels = on; syncLabels(); changed(); });
  const timeGroup = el("div", { className: "group" }, [
    button("−", "Slower", () => setSpeed(step(-1))), clock, button("+", "Faster", () => setSpeed(step(1))), seek,
    button("⟲", "Back to the start", () => { if (doc) { timeline.reset(); frame(0); changed(); } }),
  ]);
  const bar = el("div", { className: "bar" }, [
    timeGroup,
    el("div", { className: "group" }, [button("Fit", "Frame the whole scene", () => setView("iso")), button("Top", "View from above", () => setView("top")), labelsToggle]),
  ]);
  ctx.ui.append(labelLayer, badge, info, empty, bar);

  const step = (direction: number) => {
    const at = SPEEDS.findIndex(v => v >= timeline.speed - 1e-9);
    const index = at < 0 ? SPEEDS.length - 1 : at;
    return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS[index] === timeline.speed || direction < 0 ? index + direction : index))];
  };
  const setSpeed = (speed: number) => { timeline.speed = Math.max(0, Math.min(50, speed)); s.speedSet = true; changed(); };

  const syncLabels = () => {
    labelLayer.hidden = !s.labels;
    labelsToggle.sync();
    const wanted = new Set<string>();
    if (doc && s.labels) for (const n of doc.objects) if (n.label && labels.size + wanted.size < 200) wanted.add(n.id);
    for (const [id, label] of labels) if (!wanted.has(id)) { label.remove(); labels.delete(id); }
    for (const id of wanted) {
      const n = doc!.objects.find(o => o.id === id)!;
      let label = labels.get(id);
      if (!label) { label = el("div", { className: "label" }); labels.set(id, label); labelLayer.append(label); }
      if (label.textContent !== n.label) { label.textContent = n.label!; labelWidths.delete(label); }
    }
  };
  const boundsOf = (entry: Entry) => new Box3().setFromObject(entry.holder);
  const project = () => {
    if (!s.labels) return;
    const width = ctx.stage.clientWidth, height = ctx.stage.clientHeight;
    // Reads first (positions; widths measured once per text), then writes: no layout is forced between them.
    const placed: { x0: number; x1: number; y: number }[] = [];
    const moves: { label: HTMLElement; at: { x: number; y: number } | null; half: number }[] = [];
    for (const [id, label] of labels) {
      const entry = compiler.entries.get(id);
      if (!entry || !isShownEntry(entry)) { moves.push({ label, at: null, half: 0 }); continue; }
      const box = boundsOf(entry), point = box.isEmpty() ? entry.holder.getWorldPosition(new Vector3()) : new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
      let width = labelWidths.get(label);
      if (width === undefined && !label.hidden) { width = label.offsetWidth; if (width) labelWidths.set(label, width); }
      moves.push({ label, at: engine.screenOf(point), half: (width || 40) / 2 + 3 });
    }
    // Labels that would overlap step down a line (at most three), so neighbours stay readable.
    for (const { label, at, half } of moves) {
      label.hidden = !at;
      if (!at) continue;
      const x = at.x * width;
      let y = at.y * height + 6;
      for (let step = 0; step < 3 && placed.length < 96 && placed.some(p => Math.abs(p.y - y) < 13 && p.x0 < x + half && x - half < p.x1); step++) y += 14;
      placed.push({ x0: x - half, x1: x + half, y });
      label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 0)`;
    }
  };
  const isShownEntry = (entry: Entry) => { for (let o: typeof entry.holder | null = entry.holder; o; o = o.parent as typeof entry.holder | null) if (!o.visible) return false; return true; };

  const disclose = () => {
    const notes = [...(doc?.disclosure ?? [])];
    if (doc?.intent?.fidelity === "illustrative" && !notes.some(n => /illustrat/i.test(n))) notes.push("Illustrative visualization.");
    badge.textContent = notes.join(" · ");
    badge.hidden = !notes.length;
  };

  // ── Camera ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const frameBox = (ids?: string[]) => {
    const box = new Box3();
    const entries = ids?.length ? ids.map(id => compiler.entries.get(id)).filter(Boolean) as Entry[] : [];
    if (entries.length) for (const e of entries) box.union(boundsOf(e)); else box.setFromObject(compiler.root);
    return box.isEmpty() ? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)) : box;
  };
  /** The distance from `target` along `direction` at which every corner of `box` is inside the view (with a margin). */
  const fitDistance = (box: Box3, target: Vector3, direction: Vector3) => {
    const corners: Vector3[] = [];
    for (let i = 0; i < 8; i++) corners.push(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const probe = camera.clone();
    const dir = direction.clone().normalize();
    const radius = Math.max(1e-3, box.getSize(new Vector3()).length() / 2);
    let lo = radius * 0.05, hi = radius * 60;
    const fits = (distance: number) => {
      probe.position.copy(target).addScaledVector(dir, distance);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      return corners.every(c => { const p = c.clone().project(probe); return p.z < 1 && Math.abs(p.x) <= 0.86 && Math.abs(p.y) <= 0.8; });
    };
    for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return hi;
  };
  const setView = (view: View, seconds = 1.2) => {
    if (view === "custom") return;
    s.view = view;
    camera.fov = doc?.camera?.fov ?? 42;
    camera.updateProjectionMatrix();
    if (view === "scene" && doc?.camera?.position) {
      // The scene's own viewpoint, moved back along its direction if it is too close to show everything it frames.
      const position = new Vector3(...doc.camera.position), target = new Vector3(...(doc.camera.target ?? [0, 0, 0]));
      const direction = position.clone().sub(target);
      const needed = fitDistance(frameBox(doc.camera.frame), target, direction.lengthSq() ? direction : VIEW_DIRECTIONS.iso);
      if (direction.length() < needed) position.copy(target).add(direction.normalize().multiplyScalar(needed));
      engine.flyTo(position, target, seconds);
    } else {
      const direction = view === "scene" ? VIEW_DIRECTIONS.iso : VIEW_DIRECTIONS[view];
      const box = frameBox(view === "scene" ? doc?.camera?.frame : undefined), target = box.getCenter(new Vector3());
      engine.flyTo(target.clone().addScaledVector(direction.clone().normalize(), fitDistance(box, target, direction)), target, seconds);
    }
    const radius = sceneRadius();
    engine.controls.maxDistance = radius * 30;
    engine.controls.minDistance = radius * 0.002;
    changed();
  };
  const focusOn = (id: string): CommandResult => {
    const entry = compiler.entries.get(id);
    if (!entry) return { ok: false, problem: `no object "${id}"` };
    const box = boundsOf(entry);
    const direction = camera.position.clone().sub(engine.controls.target).normalize();
    const framing = engine.framing(box.isEmpty() ? new Box3().setFromCenterAndSize(entry.holder.getWorldPosition(new Vector3()), new Vector3(1, 1, 1)) : box, direction.lengthSq() ? direction : VIEW_DIRECTIONS.iso, 2.2);
    engine.flyTo(framing.position, framing.target, 1.2);
    s.view = "custom";
    changed();
    return { ok: true };
  };
  engine.controls.addEventListener("start", () => { if (s.view !== "custom") { s.view = "custom"; changed(); } ctx.emit.interaction("pointer-down"); });
  engine.controls.addEventListener("end", () => ctx.emit.interaction("pointer-up"));

  // ── Selection ──────────────────────────────────────────────────────────────────────────────────────────────────
  let highlight: BoxHelper | null = null;
  const clearHighlight = () => { if (highlight) { highlight.removeFromParent(); highlight.geometry.dispose(); (highlight.material as Material).dispose(); highlight = null; } };
  const selectable = (object: Object3D | null): Entry | null => {
    for (let o = object; o; o = o.parent) {
      const id = o.userData?.sceneId as string | undefined;
      const entry = id ? compiler.entries.get(id) : undefined;
      if (entry && o === entry.holder) return entry.holder.userData.selectable === false ? null : entry;
    }
    return null;
  };
  const describe = (entry: Entry) => {
    const n = entry.node, values = compiler.materialValues(n);
    const world = entry.holder.getWorldPosition(new Vector3());
    const parent = n.parent ? doc?.objects.find(o => o.id === n.parent) : undefined;
    const properties: Record<string, string | number | boolean> = { Type: n.type };
    if (parent) properties.Parent = parent.name ?? parent.id;
    properties.Position = [world.x, world.y, world.z].map(v => Math.round(v * 1000) / 1000).join(", ");
    if (values.color) properties.Colour = values.color;
    if (n.annotation) properties.Note = n.annotation.slice(0, 200);
    for (const [k, v] of Object.entries(n.metadata ?? {})) if (Object.keys(properties).length < 24) properties[k] = v;
    return properties;
  };
  const select = (id: string | null): CommandResult => {
    const entry = id ? compiler.entries.get(id) : undefined;
    if (id && !entry) return { ok: false, problem: `no object "${id}"` };
    s.selected = entry ? entry.node.id : null;
    clearHighlight();
    info.replaceChildren();
    info.hidden = !entry;
    if (!entry) { ctx.emit.selection({ objectId: null }); changed(); return { ok: true }; }
    highlight = new BoxHelper(entry.holder, accent);
    (highlight.material as Material).depthTest = false;
    highlight.renderOrder = 10;
    scene.add(highlight);
    const n = entry.node, properties = describe(entry);
    info.append(
      el("div", { className: "title", text: n.name ?? n.label ?? n.id }), el("div", { className: "kind", text: `${n.type} · ${n.id}` }),
      ...(n.annotation ? [el("p", { className: "note", text: n.annotation })] : []),
      el("dl", {}, Object.entries(properties).filter(([k]) => k !== "Note" && k !== "Type").flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })])),
      el("div", { className: "row" }, [button("Focus", "Fly to this object", () => focusOn(n.id)), button("Clear", "Select nothing", () => select(null))]),
    );
    const box = boundsOf(entry), at = engine.screenOf(box.isEmpty() ? entry.holder.getWorldPosition(new Vector3()) : box.getCenter(new Vector3()));
    ctx.emit.selection({ objectId: n.id, name: (n.name ?? n.label ?? n.id).slice(0, 80), kind: n.type, properties, ...(at ? { screen: at } : {}) });
    engine.requestRender();
    changed();
    return { ok: true };
  };
  let down: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const onUp = (event: PointerEvent) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) { down = null; return; }
    down = null;
    const hit = engine.pick(event.clientX, event.clientY, [compiler.root]);
    const entry = selectable(hit?.object ?? null);
    select(entry ? entry.node.id : null);
  };
  engine.canvas.addEventListener("pointerdown", onDown);
  engine.canvas.addEventListener("pointerup", onUp);
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") ctx.emit.interaction("escape"); };
  addEventListener("keydown", onKey);
  engine.addDisposer(() => { engine.canvas.removeEventListener("pointerdown", onDown); engine.canvas.removeEventListener("pointerup", onUp); removeEventListener("keydown", onKey); clearHelpers(); clearHighlight(); compiler.dispose(); });

  // ── Animation ──────────────────────────────────────────────────────────────────────────────────────────────────
  const applyPose = (entry: Entry, pose: NodePose) => {
    entry.holder.position.set(...pose.position);
    entry.holder.quaternion.set(...pose.quaternion);
    entry.holder.scale.set(...pose.scale);
    const m = entry.material as (Material & { color?: Color; emissive?: Color; emissiveIntensity?: number }) | null;
    if (m) {
      if (pose.color && m.color) m.color.set(pose.color);
      if (pose.emissive && m.emissive) m.emissive.set(pose.emissive);
      if (pose.emissiveIntensity !== undefined && m.emissive) m.emissiveIntensity = pose.emissiveIntensity;
      if (pose.opacity !== undefined) m.opacity = pose.opacity;
    }
    if (pose.visible !== undefined) entry.holder.visible = pose.visible && entry.node.visible !== false;
  };
  const flows = () => (doc?.animations ?? []).filter(a => a.type === "flow");
  /** Applies the timeline's current time to the scene (dt: real seconds since the last frame). */
  const frame = (dt: number) => {
    if (!doc || !evaluator) return;
    const animations = doc.animations ?? [];
    if (s.running && !s.suspended) timeline.advance(dt, animations);
    const poses = evaluator.evaluate(id => timeline.clock(id));
    for (const [id, pose] of poses) { const entry = compiler.entries.get(id); if (entry) applyPose(entry, pose); }
    for (const a of flows()) {
      const entry = compiler.entries.get(a.target), points = entry?.geometry;
      const count = entry?.node.particles?.count ?? 0;
      if (!points || !count) continue;
      const attribute = points.getAttribute("position") as Float32BufferAttribute;
      attribute.array.set(evaluator.flowPositions(a, count));
      attribute.needsUpdate = true;
    }
    highlight?.update();
    const total = Math.max(60, ...animations.map(a => (a.start ?? 0) + (a.period ?? a.duration ?? (a.keys ? a.keys[a.keys.length - 1].t : 0))));
    seek.max = String(Math.ceil(total));
    if (document.activeElement !== seek) seek.value = String(Math.min(total, timeline.time));
    clock.textContent = `${timeline.time.toFixed(1)} s · ${timeline.speed}×`;
    if (Math.abs(timeline.time - s.reportedTime) >= 0.5) { s.reportedTime = timeline.time; changed(false); }
  };
  engine.onFrame(dt => { frame(dt); project(); });
  const continuous = () => engine.setContinuous(!!doc?.animations?.length && s.running && !s.suspended && timeline.speed > 0);

  // ── Loading a scene (a new revision) ───────────────────────────────────────────────────────────────────────────
  const loadScene = (revision: number, document: SceneDocument): CommandResult => {
    if (revision <= s.revision) return { ok: true };
    const animations = document.animations ?? [];
    const previousOpacity = animatedOpacity;
    animatedOpacity = new Set(animations.filter(a => a.property === "opacity").map(a => a.target));
    const started = performance.now();
    let built;
    try {
      built = compiler.apply(document);
    } catch (error) {
      animatedOpacity = previousOpacity;
      const code = error instanceof CompileError ? error.code : "scene-compile-failed";
      const message = error instanceof Error ? error.message : "the scene could not be built";
      ctx.emit.error(code, `The scene could not be built: ${message}`.slice(0, 200), false);
      return { ok: false, problem: `${code}: ${message}`.slice(0, 200) };
    }
    const first = doc === null;
    doc = document;
    s.revision = revision;
    s.changes = `${built.created.length} created, ${built.updated.length} updated, ${built.rebuilt.length} rebuilt, ${built.removed.length} removed`;
    evaluator = new PoseEvaluator(document);
    timeline.sync(animations);
    const timelineSignature = JSON.stringify(document.timeline ?? {});
    if (first || timelineSignature !== s.lastTimeline) {
      s.lastTimeline = timelineSignature;
      if (!s.speedSet) timeline.speed = (document.timeline?.speed ?? 1) * (ctx.reducedMotion ? 0.25 : 1);
      if (first && document.timeline?.autoplay === false) s.running = false;
    }
    if (s.selected && !compiler.entries.has(s.selected)) select(null);
    else if (s.selected) select(s.selected);
    applyEnvironment(document);
    syncLabels();
    disclose();
    empty.hidden = true;
    frame(0);
    const cameraSignature = JSON.stringify(document.camera ?? null);
    // The user's own view is kept across revisions; only a first scene, or a new scene camera, moves it.
    if (first || cameraSignature !== s.lastCamera) { s.lastCamera = cameraSignature; setView(document.camera?.position ? "scene" : "iso", first ? 0 : 1.2); }
    continuous();
    engine.requestRender();
    s.buildMs = Math.round((performance.now() - started) * 10) / 10;
    changed();
    return { ok: true };
  };

  // ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────
  let pending: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    pending = null;
    ctx.emit.state({
      revision: s.revision, ...(doc ? { title: doc.title.slice(0, 80) } : {}), objects: compiler.entries.size, animations: doc?.animations?.length ?? 0,
      playing: s.running, time: Math.round(timeline.time * 100) / 100, speed: timeline.speed,
      view: s.view, labels: s.labels, triangles: compiler.triangles, ...(s.changes ? { changes: s.changes, buildMs: s.buildMs } : {}),
    });
  };
  function changed(refresh = true) {
    if (refresh) { continuous(); engine.requestRender(); }
    pending ??= setTimeout(report, 120);
  }

  const commands: Record<string, (value: CardValue | undefined) => CommandResult> = {
    select: value => select(value as string),
    "clear-selection": () => select(null),
    focus: value => focusOn(value as string),
    "reset-camera": () => { setView(doc?.camera?.position ? "scene" : "iso"); return { ok: true }; },
    "set-view": value => { setView(value as View); return { ok: true }; },
    "set-speed": value => { setSpeed(value as number); return { ok: true }; },
    seek: value => { if (!doc) return { ok: false, problem: "no scene yet" }; timeline.seek(value as number, doc.animations ?? []); frame(0); changed(); return { ok: true }; },
    "show-labels": value => { s.labels = value as boolean; syncLabels(); changed(); return { ok: true }; },
  };

  return {
    start() {
      ctx.emit.loading("Preparing the scene", 0.5);
      setView("iso", 0);
      ctx.emit.loading("Ready", 1);
      changed();
    },
    loadScene,
    command(name, value) {
      const run = commands[name];
      return run ? run(value) : { ok: false, problem: `unknown command ${name}` };
    },
    flush() { if (pending) { clearTimeout(pending); report(); } },
    setState(state) {
      if (typeof state.labels === "boolean") s.labels = state.labels;
      if (typeof state.speed === "number") { timeline.speed = state.speed; s.speedSet = true; }
      if (typeof state.playing === "boolean") s.running = state.playing;
    },
    setCamera(view, focus) {
      if (focus) return focusOn(focus);
      if (view && ["iso", "top", "front", "side", "scene"].includes(view)) { setView(view as View); return { ok: true }; }
      return { ok: false, problem: "unknown view" };
    },
    pause() { s.running = false; changed(); },
    resume() { s.running = true; changed(); },
    suspend(on) { s.suspended = on; engine.setSuspended(on); if (!on) changed(); },
    reset() {
      timeline.reset();
      s.speedSet = false;
      timeline.speed = (doc?.timeline?.speed ?? 1) * (ctx.reducedMotion ? 0.25 : 1);
      frame(0);
      setView(doc?.camera?.position ? "scene" : "iso", 1);
      changed();
    },
    resize() { engine.resize(); },
    status: () => engine.status(),
    dispose() {
      if (pending) clearTimeout(pending);
      labelLayer.replaceChildren();
      const left = engine.dispose();
      return { ...left, urls: 0 };
    },
  };
}

