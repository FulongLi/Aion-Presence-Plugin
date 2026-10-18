import {
  AxesHelper, Box3, BoxHelper, BufferGeometry, Color, Euler, Float32BufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, PointLight, Points, PointsMaterial, Quaternion, Vector3,
  type Material, type Object3D,
} from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { isShown, ViewerEngine } from "../../runtime/engine";
import { button, el, toggle, type CardApp, type CardContext, type CommandResult } from "../../runtime/app";
import type { CardValue } from "../../values";
import { PoseEvaluator, SceneTimeline, type NodePose } from "../../../scene/animation";
import type { SceneAnimation, SceneDocument, Vec3 } from "../../../scene/ir";
import { resolveStyle } from "../../../scene/style";
import { CompileError, SceneCompiler, type Entry } from "./compiler";
import { SceneStage } from "./staging";

/**
 * The generative scene card (v0.5): a general-purpose Three.js runtime for Scene IR documents. It renders whatever
 * validated scene Aion hands it (LOAD_SCENE), applies each new revision as the smallest change (SceneCompiler), runs
 * the scene's animations on one frame-rate-independent timeline (src/scene/animation.ts), and lets the user turn, zoom,
 * pan, select and inspect any object — the selection is reported to Aion so Codex can act on "this object".
 *
 * v0.5.1: scenes are staged by a visual style (staging.ts: studio reflections, three-point light, soft shadows, a
 * ground); the camera keeps new content in view; labels avoid each other; the selected object is tinted and outlined and
 * its inspector shows its transform, material and motion. The transform tool (Move, Rotate, Scale) lets the user change
 * the selected object by hand — but the card never edits the scene itself: a finished drag is proposed to the hub as an
 * edit (EDIT), which validates it as a scene patch against this revision; the object shows its new place only when the
 * new revision arrives, and returns to where it was if the change is refused. Undo and redo work the same way.
 *
 * It never executes anything from the scene: geometry, materials and motion are built from validated numbers and fixed
 * names only. Every disclosure the scene carries (scale, illustrative) is always on screen.
 */
type View = "iso" | "top" | "front" | "side" | "scene" | "custom";
type Tool = "none" | "move" | "rotate" | "scale";
const SPEEDS = [0, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 50];
const VIEW_DIRECTIONS: Record<Exclude<View, "scene" | "custom">, Vector3> = {
  iso: new Vector3(1, 0.75, 1.25), top: new Vector3(0.0001, 1, 0.0001), front: new Vector3(0, 0.12, 1), side: new Vector3(1, 0.12, 0),
};
const TOOL_MODES: Record<Exclude<Tool, "none">, "translate" | "rotate" | "scale"> = { move: "translate", rotate: "rotate", scale: "scale" };
/** Seconds a proposed edit holds the object where the user left it while the hub answers. */
const EDIT_HOLD_SECONDS = 4;
const round = (v: number, digits = 4) => { const k = 10 ** digits; return Math.round(v * k) / k; };

export function createGenerativeScene(ctx: CardContext): CardApp {
  const engine = new ViewerEngine(ctx.stage, { reducedMotion: ctx.reducedMotion, near: 0.001, far: 1e6, fov: 42 });
  const { scene, camera } = engine;
  const accent = new Color(ctx.theme.accent);
  const compiler = new SceneCompiler({ maxTriangles: ctx.limits.maxTriangles, animatedOpacity: id => animatedOpacity.has(id) });
  scene.add(compiler.root);
  const stage = new SceneStage(engine);
  const timeline = new SceneTimeline();
  let animatedOpacity = new Set<string>();
  let evaluator: PoseEvaluator | null = null;
  let doc: SceneDocument | null = null;
  const s = {
    revision: 0, labels: ctx.config.labels !== false, view: "iso" as View, selected: null as string | null, suspended: false, running: ctx.config.paused !== true,
    speedSet: false, lastTimeline: "", lastCamera: "", lastEnvironment: "", reportedTime: -1, changes: "", buildMs: 0,
    tool: "none" as Tool, history: { undo: 0, redo: 0 }, framed: null as { center: Vector3; radius: number } | null,
    /** The object being dragged now, and one whose proposed edit is waiting for the hub's answer. */
    dragging: null as string | null, held: null as { id: string; base: number; until: number; what: string } | null,
    /** An undo or redo the user asked for here, until its revision arrives. */
    stepping: null as { what: string; base: number } | null,
  };
  let edits = 0;
  const editRequest = () => `u${Date.now().toString(36)}${(++edits).toString(36)}`;

  // ── Environment: stars, axes, a light-giving object (the style's lights and ground are the stage's) ────────────────
  let helpers: { axes?: AxesHelper; stars?: Points; light?: PointLight } = {};
  const clearHelpers = () => {
    for (const helper of [helpers.axes, helpers.stars]) if (helper) { helper.removeFromParent(); helper.geometry.dispose(); (helper.material as Material).dispose(); }
    helpers.light?.removeFromParent();
    helpers.light?.dispose();
    helpers = {};
  };
  const document_ = document.documentElement;
  const sceneBox = () => new Box3().setFromObject(compiler.root);
  const sceneRadius = () => { const box = sceneBox(); return box.isEmpty() ? 5 : Math.max(0.5, box.getSize(new Vector3()).length() / 2); };
  const applyEnvironment = (document: SceneDocument) => {
    const env = document.environment ?? {};
    const style = resolveStyle(document);
    const source = env.lightSource ? compiler.entries.get(env.lightSource) : undefined;
    stage.apply(style, sweptBox(), !!source, compiler.triangles);
    stage.shadowFlags(compiler.root);
    document_.dataset.tone = style.tone;
    const signature = JSON.stringify(env) + (env.lightSource ? JSON.stringify(document.objects.find(n => n.id === env.lightSource)?.material ?? null) : "");
    if (signature === s.lastEnvironment && (!env.lightSource || helpers.light?.parent === source?.holder)) return;
    s.lastEnvironment = signature;
    clearHelpers();
    const r = sceneRadius();
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
    if (source) {
      const values = compiler.materialValues(source.node);
      helpers.light = new PointLight(values.emissive ?? values.color ?? "#fff4e0", 3.2, 0, 0);
      source.holder.add(helpers.light);
    }
  };

  // ── Overlay: labels, disclosure, inspector, controls (text only) ───────────────────────────────────────────────
  const labelLayer = el("div", { className: "labels" });
  const labels = new Map<string, HTMLElement>();
  /** Each label's measured size (its text does not change while it exists; a new text is a new measurement). */
  const labelSizes = new WeakMap<HTMLElement, { w: number; h: number }>();
  const badge = el("div", { className: "badge" });
  const info = el("div", { className: "panel info" });
  info.hidden = true;
  info.setAttribute("aria-live", "polite");
  const empty = el("div", { className: "empty", text: "Waiting for a scene…" });
  const toast = el("div", { className: "toast" });
  toast.hidden = true;
  toast.setAttribute("role", "status");
  const clock = el("span", { className: "readout" });
  clock.setAttribute("aria-live", "off");
  const seek = el("input", { className: "seek", label: "Timeline position" }) as HTMLInputElement;
  seek.type = "range"; seek.min = "0"; seek.max = "60"; seek.step = "0.1"; seek.value = "0";
  seek.addEventListener("input", () => { if (!doc) return; timeline.seek(Number(seek.value), doc.animations ?? []); frame(0); changed(); });
  const labelsToggle = toggle("Labels", "Show labels", () => s.labels, on => { s.labels = on; syncLabels(); changed(); });
  const undoButton = button("↶", "Undo the last change", () => proposeHistory("undo"));
  const redoButton = button("↷", "Redo", () => proposeHistory("redo"));
  const timeGroup = el("div", { className: "group" }, [
    button("−", "Slower", () => setSpeed(step(-1))), clock, button("+", "Faster", () => setSpeed(step(1))), seek,
    button("⟲", "Back to the start", () => { if (doc) { timeline.reset(); frame(0); changed(); } }),
  ]);
  const bar = el("div", { className: "bar" }, [
    timeGroup,
    el("div", { className: "group" }, [button("Fit", "Frame the whole scene", () => setView("iso")), button("Top", "View from above", () => setView("top")), labelsToggle]),
    el("div", { className: "group" }, [undoButton, redoButton]),
  ]);
  ctx.ui.append(labelLayer, badge, info, empty, toast, bar);

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, seconds = 3.5) => {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, seconds * 1000);
  };

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
      if (label.textContent !== n.label) { label.textContent = n.label!; labelSizes.delete(label); }
    }
  };
  const boundsOf = (entry: Entry) => new Box3().setFromObject(entry.holder);
  /**
   * Labels beside their objects without covering each other: the selected object's first, then the largest on screen;
   * each takes the first free place below, above, right or left of its object, and is hidden when none is free (never
   * stacked unreadably). Reads first (positions; sizes measured once per text), then writes.
   */
  const project = () => {
    if (!s.labels) return;
    const width = ctx.stage.clientWidth, height = ctx.stage.clientHeight;
    type Candidate = { label: HTMLElement; id: string; x: number; top: number; bottom: number; left: number; right: number; w: number; h: number; size: number };
    const candidates: Candidate[] = [];
    for (const [id, label] of labels) {
      const entry = compiler.entries.get(id);
      if (!entry || !isShownEntry(entry)) { label.hidden = true; continue; }
      const box = boundsOf(entry);
      const centre = box.isEmpty() ? entry.holder.getWorldPosition(new Vector3()) : box.getCenter(new Vector3());
      const at = engine.screenOf(centre);
      if (!at) { label.hidden = true; continue; }
      let size = labelSizes.get(label);
      if (!size) { label.hidden = false; size = { w: label.offsetWidth || 40, h: label.offsetHeight || 16 }; if (label.offsetWidth) labelSizes.set(label, size); }
      // The object's extent on screen (from its bounding box's corners), so a label sits beside it, not on it.
      let top = at.y * height, bottom = top, left = at.x * width, right = left;
      if (!box.isEmpty()) for (let i = 0; i < 8; i++) {
        const p = engine.screenOf(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
        if (!p) continue;
        top = Math.min(top, p.y * height); bottom = Math.max(bottom, p.y * height); left = Math.min(left, p.x * width); right = Math.max(right, p.x * width);
      }
      const clampSpan = (lo: number, hi: number, c: number, limit: number) => [Math.max(c - limit, lo), Math.min(c + limit, hi)];
      [top, bottom] = clampSpan(top, bottom, at.y * height, 90); [left, right] = clampSpan(left, right, at.x * width, 120);
      candidates.push({ label, id, x: at.x * width, top, bottom, left, right, w: size.w, h: size.h, size: (bottom - top) * (right - left) });
    }
    candidates.sort((a, b) => (b.id === s.selected ? 1 : 0) - (a.id === s.selected ? 1 : 0) || b.size - a.size);
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const free = (r: { x0: number; x1: number; y0: number; y1: number }) => r.x0 >= 2 && r.x1 <= width - 2 && r.y0 >= 2 && r.y1 <= height - 46 && !placed.some(p => p.x0 < r.x1 && r.x0 < p.x1 && p.y0 < r.y1 && r.y0 < p.y1);
    for (const c of candidates) {
      const gap = 5, mid = (c.top + c.bottom) / 2;
      const spots = [
        { x: c.x - c.w / 2, y: c.bottom + gap }, { x: c.x - c.w / 2, y: c.top - gap - c.h },
        { x: c.right + gap, y: mid - c.h / 2 }, { x: c.left - gap - c.w, y: mid - c.h / 2 },
        { x: c.x - c.w / 2, y: c.bottom + gap + c.h + 2 },
      ];
      const spot = spots.find(p => free({ x0: p.x, x1: p.x + c.w, y0: p.y, y1: p.y + c.h })) ?? (c.id === s.selected ? spots[0] : null);
      c.label.classList.toggle("selected", c.id === s.selected);
      c.label.hidden = !spot || placed.length >= 120;
      if (!spot || c.label.hidden) continue;
      placed.push({ x0: spot.x - 2, x1: spot.x + c.w + 2, y0: spot.y - 1, y1: spot.y + c.h + 1 });
      c.label.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px)`;
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
  /**
   * Points on what is actually drawn (vertices sampled from every visible drawable, at most about 4,000 in all), so a
   * view frames the shapes themselves rather than the corners of their bounding box (a ring seen at an angle, a sphere).
   */
  const shapePoints = (ids?: string[], budget = 4000): Vector3[] => {
    const roots = ids?.length ? ids.map(id => compiler.entries.get(id)?.holder).filter(Boolean) as Object3D[] : [compiler.root];
    const drawables: { object: Object3D; positions: ArrayLike<number>; count: number; instances: number }[] = [];
    for (const root of roots) root.traverse(object => {
      if (!isShown(object)) return;
      const position = (object as { geometry?: BufferGeometry }).geometry?.getAttribute?.("position");
      if (position && position.count) drawables.push({ object, positions: position.array as ArrayLike<number>, count: position.count, instances: object instanceof InstancedMesh ? object.count : 1 });
      else if (object.type === "Sprite") drawables.push({ object, positions: [-0.5, -0.5, 0, 0.5, 0.5, 0], count: 2, instances: 1 });
    });
    const total = drawables.reduce((sum, d) => sum + d.count * Math.min(d.instances, 32), 0);
    const stride = Math.max(1, Math.ceil(total / budget));
    const points: Vector3[] = [], m = new Matrix4(), p = new Vector3();
    for (const d of drawables) {
      d.object.updateWorldMatrix(true, false);
      const copies = Math.min(d.instances, 32);
      for (let c = 0; c < copies; c++) {
        if (d.object instanceof InstancedMesh) { d.object.getMatrixAt(Math.floor(c * d.instances / copies), m); m.premultiply(d.object.matrixWorld); } else m.copy(d.object.matrixWorld);
        for (let i = 0; i < d.count; i += stride) points.push(p.set(d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]).applyMatrix4(m).clone());
      }
    }
    return points;
  };
  /**
   * The scene through its motion: `visit` runs at eight moments of the longest cycle (up to a minute), with every animated
   * object posed there, then the scene returns to the present pose. Staging (the ground) and framing use it, so a swinging
   * surface or an orbiting body stays above the ground and in view the whole time. Objects being dragged are left alone.
   */
  const sweep = (visit: () => void) => {
    const animations = doc?.animations ?? [];
    if (!doc || !evaluator || !animations.length) { visit(); return; }
    const cycle = Math.min(60, Math.max(1, ...animations.map(a => a.period ?? a.duration ?? a.keys?.at(-1)?.t ?? 0)));
    for (let i = 0; i < 8; i++) {
      const t = cycle * i / 8;
      for (const [id, pose] of evaluator.evaluate(() => t)) {
        const entry = compiler.entries.get(id);
        if (!entry || id === s.dragging || id === s.held?.id) continue;
        entry.holder.position.set(...pose.position); entry.holder.quaternion.set(...pose.quaternion); entry.holder.scale.set(...pose.scale);
      }
      compiler.root.updateMatrixWorld(true);
      visit();
    }
    frame(0);
  };
  const sweptBox = () => { const box = new Box3(); sweep(() => box.union(sceneBox())); return box; };
  const sweptPoints = (ids?: string[]) => { const points: Vector3[] = []; sweep(() => points.push(...shapePoints(ids, doc?.animations?.length ? 600 : 4000))); return points; };
  /** The distance from `target` along `direction` at which every point of `points` is inside the view (with a margin). */
  const fitDistance = (box: Box3, target: Vector3, direction: Vector3, points?: Vector3[]) => {
    const corners: Vector3[] = points?.length ? points : [];
    if (!corners.length) for (let i = 0; i < 8; i++) corners.push(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const probe = camera.clone();
    const dir = direction.clone().normalize();
    const radius = Math.max(1e-3, box.getSize(new Vector3()).length() / 2);
    let lo = radius * 0.05, hi = radius * 60;
    const q = new Vector3();
    const fits = (distance: number) => {
      probe.position.copy(target).addScaledVector(dir, distance);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      probe.matrixWorldInverse.copy(probe.matrixWorld).invert();
      return corners.every(c => { q.copy(c).project(probe); return q.z < 1 && Math.abs(q.x) <= 0.84 && Math.abs(q.y) <= 0.76; });
    };
    for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return hi;
  };
  /** Near and far planes that follow the scene's size (no clipping of a tiny part, no z-fighting in a large scene). */
  const fitClipping = (radius: number) => {
    camera.near = Math.max(1e-5, radius / 800);
    camera.far = Math.max(radius * 400, 10);
    camera.updateProjectionMatrix();
  };
  const setView = (view: View, seconds = 1.2) => {
    if (view === "custom") return;
    s.view = view;
    camera.fov = doc?.camera?.fov ?? 42;
    const whole = frameBox();
    const radius = Math.max(0.5, whole.getSize(new Vector3()).length() / 2);
    fitClipping(radius);
    if (view === "scene" && doc?.camera?.position) {
      // The scene's own viewpoint, moved back along its direction if it is too close to show everything it frames.
      const position = new Vector3(...doc.camera.position), target = new Vector3(...(doc.camera.target ?? [0, 0, 0]));
      const direction = position.clone().sub(target);
      const needed = fitDistance(frameBox(doc.camera.frame), target, direction.lengthSq() ? direction : VIEW_DIRECTIONS.iso, sweptPoints(doc.camera.frame));
      if (direction.length() < needed) position.copy(target).add(direction.normalize().multiplyScalar(needed));
      engine.flyTo(position, target, seconds);
    } else {
      const direction = view === "scene" ? VIEW_DIRECTIONS.iso : VIEW_DIRECTIONS[view];
      const ids = view === "scene" ? doc?.camera?.frame : undefined, box = frameBox(ids), target = box.getCenter(new Vector3());
      engine.flyTo(target.clone().addScaledVector(direction.clone().normalize(), fitDistance(box, target, direction, sweptPoints(ids))), target, seconds);
    }
    s.framed = { center: whole.getCenter(new Vector3()), radius };
    engine.controls.maxDistance = radius * 30;
    engine.controls.minDistance = radius * 0.002;
    changed();
  };
  /**
   * After a revision that changed the scene's extent: a framed view is framed again; the user's own view keeps its angle
   * and only moves back as far as needed for everything to be in view (never closer, never turned).
   */
  const keepInView = () => {
    const box = frameBox(), radius = Math.max(0.5, box.getSize(new Vector3()).length() / 2), center = box.getCenter(new Vector3());
    const before = s.framed;
    const moved = !before || radius > before.radius * 1.25 || radius < before.radius * 0.7 || center.distanceTo(before.center) > before.radius * 0.3;
    if (!moved) return;
    if (s.view !== "custom") { setView(s.view, 0.9); return; }
    fitClipping(radius);
    const target = engine.controls.target.clone(), direction = camera.position.clone().sub(target);
    const needed = fitDistance(box, target, direction.lengthSq() ? direction : VIEW_DIRECTIONS.iso, sweptPoints());
    if (direction.length() < needed) engine.flyTo(target.clone().add(direction.normalize().multiplyScalar(needed)), target, 0.9);
    s.framed = { center, radius };
    engine.controls.maxDistance = Math.max(engine.controls.maxDistance, radius * 30);
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
  const clearHighlight = () => {
    if (highlight) { highlight.removeFromParent(); highlight.geometry.dispose(); (highlight.material as Material).dispose(); highlight = null; }
    const previous = tinted;
    tinted = null;
    if (previous) compiler.resetMaterial(previous);
  };
  /** The selected object's own surface, tinted toward the accent (restored from the document on deselection). */
  let tinted: Entry | null = null;
  const tint = () => {
    const m = tinted?.material;
    if (!(m instanceof MeshStandardMaterial)) return;
    m.emissive.lerp(accent, 0.32);
    m.emissiveIntensity = Math.max(m.emissiveIntensity, 0.9);
  };
  const selectable = (object: Object3D | null): Entry | null => {
    for (let o = object; o; o = o.parent) {
      const id = o.userData?.sceneId as string | undefined;
      const entry = id ? compiler.entries.get(id) : undefined;
      if (entry && o === entry.holder) return entry.holder.userData.selectable === false ? null : entry;
    }
    return null;
  };
  const units = () => doc?.units?.length && doc.units.length !== "unit" ? ` ${doc.units.length}` : "";
  const vec = (v: readonly number[], digits = 3) => v.map(x => round(x, digits)).join(", ");
  /** What drives an object's motion, in words (its inspector, and Codex's report of the selection). */
  const motionOf = (id: string) => (doc?.animations ?? []).filter(a => a.target === id).map(a => {
    const what = a.type === "spin" ? `spin ${a.speed}°/s` : a.type === "orbit" ? `orbit${typeof a.center === "string" ? ` around ${a.center}` : ""}, ${a.period} s` : a.type === "oscillate" ? `${a.property} swing, ${a.period} s`
      : a.type === "couple" ? `driven by ${a.source} ×${a.ratio}` : a.type === "path" ? `along ${a.path}, ${a.duration} s` : a.type === "flow" ? `flow along ${a.path}` : a.type === "track" ? `faces ${a.lookAt}` : `${a.property} keyframes`;
    return `${what}${a.paused ? " (stopped)" : ""}`;
  });
  const describe = (entry: Entry) => {
    const n = entry.node, values = compiler.materialValues(n);
    const world = entry.holder.getWorldPosition(new Vector3());
    const parent = n.parent ? doc?.objects.find(o => o.id === n.parent) : undefined;
    const properties: Record<string, string | number | boolean> = { Type: n.type };
    if (parent) properties.Parent = parent.name ?? parent.id;
    properties.Position = vec([world.x, world.y, world.z]);
    if (n.rotation) properties.Rotation = `${vec(n.rotation, 1)} °`;
    if (n.scale !== undefined) properties.Scale = typeof n.scale === "number" ? round(n.scale, 3) : vec(n.scale);
    if (values.color) properties.Colour = values.color;
    if (values.preset) properties.Material = values.preset;
    const motion = motionOf(n.id);
    if (motion.length) properties.Motion = motion.join("; ").slice(0, 200);
    if (n.annotation) properties.Note = n.annotation.slice(0, 200);
    for (const [k, v] of Object.entries(n.metadata ?? {})) if (Object.keys(properties).length < 24) properties[k] = v;
    return properties;
  };
  const section = (title: string, rows: [string, string][]) => rows.length
    ? [el("div", { className: "section", text: title }), el("dl", {}, rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]))]
    : [];
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const inspector = (entry: Entry) => {
    const n = entry.node, values = compiler.materialValues(n);
    const world = entry.holder.getWorldPosition(new Vector3());
    const parent = n.parent ? doc?.objects.find(o => o.id === n.parent) : undefined;
    const swatch = el("span", { className: "swatch" });
    if (values.color) swatch.style.background = values.color;
    toolButtons.clear();
    const tools = (["move", "rotate", "scale"] as const).map(tool => {
      const b = button(tool === "move" ? "Move" : tool === "rotate" ? "Rotate" : "Scale", `${tool === "move" ? "Move" : tool === "rotate" ? "Rotate" : "Resize"} this object by hand (${tool === "move" ? "W" : tool === "rotate" ? "E" : "R"})`, () => setTool(s.tool === tool ? "none" : tool));
      b.setAttribute("aria-pressed", String(s.tool === tool));
      toolButtons.set(tool, b);
      return b;
    });
    info.replaceChildren(
      el("div", { className: "title", text: n.name ?? n.label ?? n.id }), el("div", { className: "kind", text: `${n.type} · ${n.id}${parent ? ` · in ${parent.name ?? parent.id}` : ""}` }),
      ...(n.annotation ? [el("p", { className: "note", text: n.annotation })] : []),
      ...section("Transform", [
        ["Position", `${vec(n.position ?? [0, 0, 0])}${units()}`], ...(parent ? [["World", `${vec([world.x, world.y, world.z])}${units()}`] as [string, string]] : []),
        ...(n.rotation ? [["Rotation", `${vec(n.rotation, 1)}°`] as [string, string]] : []),
        ...(n.scale !== undefined ? [["Scale", typeof n.scale === "number" ? String(round(n.scale, 3)) : vec(n.scale)] as [string, string]] : []),
      ]),
      ...(values.color || values.preset ? [el("div", { className: "section", text: "Material" }), el("div", { className: "material" }, [swatch, el("span", { text: [values.preset, values.color].filter(Boolean).join(" · ") })])] : []),
      ...section("Motion", motionOf(n.id).map((m, i) => [i ? "" : "Runs", m])),
      ...section("Facts", Object.entries(n.metadata ?? {}).map(([k, v]) => [k, String(v)])),
      el("div", { className: "row" }, [button("Focus", "Fly to this object", () => focusOn(n.id)), ...tools, button("Clear", "Select nothing", () => select(null))]),
    );
  };
  const select = (id: string | null): CommandResult => {
    const entry = id ? compiler.entries.get(id) : undefined;
    if (id && !entry) return { ok: false, problem: `no object "${id}"` };
    const same = !!entry && s.selected === entry.node.id;
    s.selected = entry ? entry.node.id : null;
    clearHighlight();
    info.hidden = !entry;
    if (!entry) { info.replaceChildren(); setTool("none"); ctx.emit.selection({ objectId: null }); changed(); return { ok: true }; }
    highlight = new BoxHelper(entry.holder, accent);
    (highlight.material as Material).depthTest = false;
    (highlight.material as Material).transparent = true;
    (highlight.material as Material & { opacity: number }).opacity = 0.75;
    highlight.renderOrder = 10;
    scene.add(highlight);
    tinted = entry;
    tint();
    inspector(entry);
    if (!same) setTool("none"); else if (s.tool !== "none") transform.attach(entry.holder);
    const n = entry.node, properties = describe(entry);
    const box = boundsOf(entry), at = engine.screenOf(box.isEmpty() ? entry.holder.getWorldPosition(new Vector3()) : box.getCenter(new Vector3()));
    ctx.emit.selection({ objectId: n.id, name: (n.name ?? n.label ?? n.id).slice(0, 80), kind: n.type, properties, ...(at ? { screen: at } : {}) });
    engine.requestRender();
    changed();
    return { ok: true };
  };

  // ── Direct manipulation: proposed to the hub as an edit, shown only once it is a new revision ──────────────────
  const transform = new TransformControls(camera, engine.canvas);
  transform.setSize(0.8);
  const gizmo = transform.getHelper();
  scene.add(gizmo);
  transform.addEventListener("change", () => engine.requestRender());
  const start = { position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3() };
  /** Why a tool cannot change an object, from what moves it (its animations would undo the change every frame). */
  const blocked = (tool: Tool, id: string): string | null => {
    const moving = (doc?.animations ?? []).filter(a => a.target === id);
    const sets = (a: SceneAnimation, property: string) => a.type === "keyframes" && a.property === property;
    if (tool === "move" && moving.some(a => a.type === "orbit" || a.type === "path" || sets(a, "position"))) return "it moves along its orbit or path: change the motion instead";
    if (tool === "rotate" && moving.some(a => a.type === "track" || sets(a, "rotation"))) return "its motion sets how it is turned";
    if (tool === "scale" && moving.some(a => sets(a, "scale"))) return "its motion sets its size";
    return null;
  };
  const setTool = (tool: Tool) => {
    const entry = s.selected ? compiler.entries.get(s.selected) : undefined;
    if (tool !== "none" && entry) {
      const why = blocked(tool, entry.node.id);
      if (why) { say(`Cannot ${tool} ${entry.node.name ?? entry.node.id} by hand: ${why}.`); tool = "none"; }
    }
    s.tool = tool !== "none" && entry ? tool : "none";
    if (s.tool === "none") transform.detach();
    else { transform.setMode(TOOL_MODES[s.tool]); transform.setSpace(s.tool === "move" ? "world" : "local"); transform.attach(entry!.holder); }
    for (const [name, b] of toolButtons) b.setAttribute("aria-pressed", String(name === s.tool));
    engine.requestRender();
    changed();
  };
  transform.addEventListener("dragging-changed", event => {
    const dragging = (event as unknown as { value: boolean }).value;
    engine.controls.enabled = !dragging;
    const entry = s.selected ? compiler.entries.get(s.selected) : undefined;
    if (!entry) return;
    if (dragging) {
      s.dragging = entry.node.id;
      start.position.copy(entry.holder.position); start.quaternion.copy(entry.holder.quaternion); start.scale.copy(entry.holder.scale);
      ctx.emit.interaction("pointer-down");
      return;
    }
    s.dragging = null;
    ctx.emit.interaction("pointer-up");
    proposeTransform(entry);
  });
  /** The finished drag as a document transform (in the parent's frame), proposed against the revision on show. */
  const proposeTransform = (entry: Entry) => {
    const n = entry.node, h = entry.holder;
    const edit: { position?: Vec3; rotation?: Vec3; scale?: number | Vec3 } = {};
    if (s.tool === "move") {
      const d = h.position.clone().sub(start.position);
      if (d.lengthSq() < 1e-12) return;
      const p = n.position ?? [0, 0, 0];
      edit.position = [round(p[0] + d.x), round(p[1] + d.y), round(p[2] + d.z)];
    } else if (s.tool === "rotate") {
      const delta = h.quaternion.clone().multiply(start.quaternion.clone().invert());
      if (Math.abs(delta.w) > 1 - 1e-9) return;
      const base = new Quaternion().setFromEuler(new Euler(...(n.rotation ?? [0, 0, 0]).map(v => v * Math.PI / 180) as Vec3, "XYZ"));
      // The drag's turn, in the object's own frame, after its document rotation.
      const next = base.clone().multiply(start.quaternion.clone().invert().multiply(h.quaternion));
      const e = new Euler().setFromQuaternion(next, "XYZ");
      edit.rotation = [e.x, e.y, e.z].map(v => round(v * 180 / Math.PI, 2)) as Vec3;
    } else if (s.tool === "scale") {
      const ratio = [h.scale.x / start.scale.x, h.scale.y / start.scale.y, h.scale.z / start.scale.z];
      if (ratio.every(r => Math.abs(r - 1) < 1e-6)) return;
      const current = n.scale === undefined ? [1, 1, 1] : typeof n.scale === "number" ? [n.scale, n.scale, n.scale] : n.scale;
      const next = current.map((v, i) => Math.max(1e-4, Math.min(1e4, round(v * ratio[i])))) as Vec3;
      edit.scale = next.every(v => v === next[0]) ? next[0] : next;
    } else return;
    const what = s.tool === "move" ? "Moved" : s.tool === "rotate" ? "Turned" : "Resized";
    s.held = { id: n.id, base: s.revision, until: performance.now() + EDIT_HOLD_SECONDS * 1000, what: `${what} ${n.name ?? n.label ?? n.id}` };
    say(`${s.held.what}: applying…`, EDIT_HOLD_SECONDS + 1);
    ctx.emit.edit({ request: editRequest(), base: s.revision, action: "transform", id: n.id, ...edit });
  };
  const proposeHistory = (action: "undo" | "redo") => {
    if (!doc || !s.revision) return;
    if ((action === "undo" ? s.history.undo : s.history.redo) <= 0) { say(action === "undo" ? "Nothing to undo." : "Nothing to redo."); return; }
    say(action === "undo" ? "Undoing…" : "Redoing…", EDIT_HOLD_SECONDS);
    s.stepping = { what: action === "undo" ? "Undone" : "Redone", base: s.revision };
    ctx.emit.edit({ request: editRequest(), base: s.revision, action });
  };
  const syncHistory = () => {
    undoButton.disabled = s.history.undo <= 0;
    redoButton.disabled = s.history.redo <= 0;
  };
  syncHistory();

  let down: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => { down = transform.axis ? null : { x: event.clientX, y: event.clientY }; };
  const onUp = (event: PointerEvent) => {
    if (!down || s.dragging || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) { down = null; return; }
    down = null;
    const hit = engine.pick(event.clientX, event.clientY, [compiler.root]);
    const entry = selectable(hit?.object ?? null);
    select(entry ? entry.node.id : null);
  };
  engine.canvas.addEventListener("pointerdown", onDown);
  engine.canvas.addEventListener("pointerup", onUp);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { if (s.tool !== "none") { setTool("none"); return; } ctx.emit.interaction("escape"); return; }
    if (!s.selected || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement | null)?.tagName === "INPUT") return;
    const tool = ({ w: "move", e: "rotate", r: "scale" } as Record<string, Tool>)[event.key.toLowerCase()];
    if (tool) setTool(s.tool === tool ? "none" : tool);
  };
  addEventListener("keydown", onKey);
  engine.addDisposer(() => {
    engine.canvas.removeEventListener("pointerdown", onDown); engine.canvas.removeEventListener("pointerup", onUp); removeEventListener("keydown", onKey);
    clearTimeout(toastTimer);
    transform.detach(); gizmo.removeFromParent(); transform.dispose();
    clearHelpers(); clearHighlight(); compiler.dispose();
  });

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
    // A proposed edit the hub has not answered in time was not applied: the object returns to the document.
    if (s.held && performance.now() > s.held.until) { const held = compiler.entries.get(s.held.id); say(`${s.held.what}: not applied.`); s.held = null; if (held) compiler.resetTransform(held); }
    const poses = evaluator.evaluate(id => timeline.clock(id));
    for (const [id, pose] of poses) {
      if (id === s.dragging || id === s.held?.id) continue;
      const entry = compiler.entries.get(id);
      if (entry) { applyPose(entry, pose); if (entry === tinted && (pose.emissive || pose.emissiveIntensity !== undefined)) tint(); }
    }
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
  const loadScene = (revision: number, document: SceneDocument, history?: { undo: number; redo: number }): CommandResult => {
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
    if (history) s.history = history;
    syncHistory();
    s.changes = `${built.created.length} created, ${built.updated.length} updated, ${built.rebuilt.length} rebuilt, ${built.removed.length} removed`;
    // The user's own edit is now the document (or a newer revision replaced it): the object follows the document again.
    if (s.held && revision > s.held.base) { say(`${s.held.what} · revision ${revision}`); s.held = null; }
    if (s.stepping && revision > s.stepping.base) { say(`${s.stepping.what} · revision ${revision}`); s.stepping = null; }
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
    // The user's own view is kept across revisions; only a first scene, or a new scene camera, moves it — and a scene
    // that grew or moved is kept in view.
    if (first || cameraSignature !== s.lastCamera) { s.lastCamera = cameraSignature; setView(document.camera?.position ? "scene" : "iso", first ? 0 : 1.2); }
    else keepInView();
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
    const staged = stage.describe();
    ctx.emit.state({
      revision: s.revision, ...(doc ? { title: doc.title.slice(0, 80) } : {}), objects: compiler.entries.size, animations: doc?.animations?.length ?? 0,
      playing: s.running, time: Math.round(timeline.time * 100) / 100, speed: timeline.speed,
      view: s.view, labels: s.labels, triangles: compiler.triangles, ...(s.changes ? { changes: s.changes, buildMs: s.buildMs } : {}),
      ...(staged.style ? { style: staged.style, shadows: staged.shadows! } : {}), tool: s.tool,
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
