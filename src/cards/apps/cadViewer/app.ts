import type { Group, Mesh, MeshStandardMaterial } from "three";
import {
  Box3, Color, DirectionalLight, EdgesGeometry, GridHelper, HemisphereLight, LineBasicMaterial, LineSegments, LoadingManager, PMREMGenerator,
  TextureLoader, Vector3, type Material, type Object3D,
} from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { ViewerEngine, isShown, releaseMaterial } from "../../runtime/engine";
import { button, el, toggle, type CardApp, type CardContext, type CommandResult } from "../../runtime/app";
import { cleanCardText, isObjectId, type CardTreeNode, type CardValue } from "../../values";
import type { CardAssetInfo } from "../../protocol";

/**
 * The CAD viewer card (v0.4.5): a glTF/GLB model viewer with an engineering feel — orbit, zoom, pan, standard views,
 * fit, selection with highlight and metadata, a component hierarchy with visibility, isolate and restore.
 *
 * It is a viewer, not a CAD kernel: it never edits geometry. A model arrives as bytes from Aion (already validated and
 * self-contained); the loader is set up so that nothing is fetched — any request other than the model's own embedded
 * images is refused. Component ids are stable: a node's `extras.aionId` when the model declares one, otherwise the path
 * of its names ("assembly/core").
 */
type View = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom" | "custom";
const DIRECTIONS: Record<Exclude<View, "custom">, Vector3> = {
  iso: new Vector3(1, 0.75, 1.15), front: new Vector3(0, 0, 1), back: new Vector3(0, 0, -1), left: new Vector3(-1, 0, 0), right: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 0.0001), bottom: new Vector3(0, -1, 0.0001),
};
const STATE_TREE_LIMIT = 400;
const EDGE_TRIANGLE_LIMIT = 600_000;

interface Component { id: string; name: string; object: Object3D; depth: number; meshes: Mesh[]; parent: Component | null; children: Component[] }

export function createCadViewer(ctx: CardContext): CardApp {
  const engine = new ViewerEngine(ctx.stage, { reducedMotion: ctx.reducedMotion, near: 0.001, far: 10000, fov: 35 });
  const { scene, camera, renderer } = engine;
  const accent = new Color(ctx.theme.accent);
  scene.background = new Color("#0c0f13");
  const pmrem = new PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const environmentTarget = pmrem.fromScene(environment, 0.04);
  scene.environment = environmentTarget.texture;
  engine.addDisposer(() => { scene.environment = null; environmentTarget.dispose(); });
  environment.traverse(object => { const mesh = object as Mesh; mesh.geometry?.dispose(); if (mesh.material) releaseMaterial(mesh.material as Material); });
  pmrem.dispose();
  scene.environmentIntensity = 0.55;
  const key = new DirectionalLight("#ffffff", 1.6), fill = new DirectionalLight("#b8c7d8", 0.5);
  scene.add(new HemisphereLight("#dfe7ef", "#2a2f36", 0.55), key, fill);
  const grid = new GridHelper(10, 20, "#3a434d", "#232a31");
  (grid.material as Material).transparent = true; (grid.material as Material).opacity = 0.55;
  scene.add(grid);

  let model: Group | null = null, modelName = "";
  let components: Component[] = [], byId = new Map<string, Component>();
  let selected: Component | null = null, isolated: Component | null = null;
  let view: View = (ctx.config.view as View | undefined) ?? "iso";
  let edges = ctx.config.edges === true, triangles = 0, units = "";
  const original = new Map<Mesh, { emissive: Color; intensity: number }>();
  const outline: LineSegments[] = [];
  const edgeLines = new Map<Mesh, LineSegments>();

  // ── Controls (inside the card; text only) ──────────────────────────────────────────────────────────────────────
  const treeList = el("div", { className: "tree-list" });
  treeList.setAttribute("role", "tree");
  const treeTitle = el("div", { className: "title", text: "Model" });
  const treeCount = el("div", { className: "kind" });
  const treePanel = el("div", { className: "panel tree" }, [
    el("div", { className: "panel-head" }, [el("div", {}, [treeTitle, treeCount]), button("Show all", "Show every component", () => { showAll(); })]),
    treeList,
  ]);
  const props = el("div", { className: "panel info" });
  props.hidden = true;
  props.setAttribute("aria-live", "polite");
  const empty = el("div", { className: "empty", text: "Waiting for a model…" });
  const edgesToggle = toggle("Edges", "Show feature edges", () => edges, on => { setEdges(on); });
  const bar = el("div", { className: "bar" }, [
    el("div", { className: "group" }, (["iso", "front", "top", "right"] as const).map(v => button(v === "iso" ? "Iso" : v[0].toUpperCase() + v.slice(1), `${v} view`, () => setView(v)))),
    el("div", { className: "group" }, [button("Fit", "Fit the model to the view", () => fit()), edgesToggle, button("Reset", "Reset the view", () => resetView())]),
  ]);
  ctx.ui.append(treePanel, props, empty, bar);

  // ── Loading ────────────────────────────────────────────────────────────────────────────────────────────────────
  let blocked = 0;
  const manager = new LoadingManager();
  // Nothing outside the model's own embedded images may load (the bytes are already here).
  manager.setURLModifier(url => (url.startsWith("blob:") ? url : (blocked++, "data:,")));
  const loader = new GLTFLoader(manager);
  // Embedded images load as <img> from blob: URLs (the sandbox's policy allows those and nothing else).
  loader.register(parser => { (parser as unknown as { textureLoader: TextureLoader }).textureLoader = new TextureLoader(manager); return { name: "aion_texture_loader" }; });

  const slug = (text: string) => text.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "part";
  const label = (object: Object3D, fallback: string) => cleanCardText(object.userData.label, 80) ?? cleanCardText(object.userData.name, 80) ?? cleanCardText(object.name.replace(/_/g, " "), 80) ?? fallback;

  /** Components: every object that is a glTF node, with stable ids, in depth-first order. */
  const index = (gltf: GLTF) => {
    const out: Component[] = [], ids = new Map<string, Component>();
    const isNode = (object: Object3D) => gltf.parser.associations.get(object as never)?.nodes !== undefined;
    const walk = (object: Object3D, parent: Component | null, depth: number, path: string) => {
      let current = parent, nextDepth = depth, nextPath = path;
      if (isNode(object)) {
        const name = label(object, `${object.type.toLowerCase()} ${out.length + 1}`);
        let id = isObjectId(object.userData.aionId) ? object.userData.aionId as string : `${path ? `${path}/` : ""}${slug(name)}`;
        if (ids.has(id)) { let n = 2; while (ids.has(`${id}#${n}`)) n++; id = `${id}#${n}`; }
        const meshes: Mesh[] = [];
        object.traverse(child => { if ((child as Mesh).isMesh) meshes.push(child as Mesh); });
        const component: Component = { id, name, object, depth, meshes, parent, children: [] };
        parent?.children.push(component);
        out.push(component); ids.set(id, component);
        current = component; nextDepth = depth + 1; nextPath = id;
      }
      for (const child of object.children) walk(child, current, nextDepth, nextPath);
    };
    for (const child of gltf.scene.children) walk(child, null, 0, "");
    return { out, ids };
  };

  const load = async (asset: CardAssetInfo, data: ArrayBuffer) => {
    ctx.emit.loading("Reading model", 0.15);
    blocked = 0;
    const seconds = ctx.limits.maxLoadSeconds;
    const gltf = await Promise.race([
      loader.parseAsync(data, ""),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("model-load-timeout")), seconds * 1000)),
    ]);
    if (blocked) ctx.emit.error("external-request-blocked", `The model tried to load ${blocked} external resource${blocked === 1 ? "" : "s"}; they were blocked.`, false);
    ctx.emit.loading("Building scene", 0.7);
    let count = 0;
    gltf.scene.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      count += mesh.geometry.index ? mesh.geometry.index.count / 3 : (mesh.geometry.attributes.position?.count ?? 0) / 3;
      // Each mesh gets its own materials, so highlighting one never lights another.
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone();
    });
    if (count > ctx.limits.maxTriangles) { ViewerEngine.release(gltf.scene); throw new Error("model-too-large"); }
    unload();
    model = gltf.scene;
    triangles = Math.round(count);
    modelName = cleanCardText(gltf.scene.children[0]?.userData.title, 80) ?? cleanCardText(asset.name.replace(/\.(glb|gltf)$/i, ""), 80) ?? "Model";
    units = cleanCardText(gltf.scene.children[0]?.userData.units, 12) ?? "";
    scene.add(model);
    const indexed = index(gltf);
    components = indexed.out; byId = indexed.ids;
    // Rest the model on the grid, sized to it.
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3()).length() || 1;
    grid.scale.setScalar(size / 6);
    grid.position.set(box.getCenter(new Vector3()).x, box.min.y - size * 0.002, box.getCenter(new Vector3()).z);
    key.position.set(size, size * 1.6, size * 1.2); fill.position.set(-size, size * 0.4, -size * 0.8);
    engine.controls.minDistance = size * 0.02; engine.controls.maxDistance = size * 12;
    camera.near = size / 2000; camera.far = size * 50; camera.updateProjectionMatrix();
    if (edges) buildEdges();
    empty.hidden = true;
    renderTree();
    setView(view === "custom" ? "iso" : view, 0);
    ctx.emit.loading("Ready", 1);
    report();
  };

  const unload = () => {
    clearSelection(false);
    for (const line of edgeLines.values()) { line.geometry.dispose(); line.removeFromParent(); }
    edgeLines.clear();
    if (model) { ViewerEngine.release(model); model.removeFromParent(); }
    model = null; components = []; byId = new Map(); isolated = null; original.clear();
  };

  // ── Selection ──────────────────────────────────────────────────────────────────────────────────────────────────
  const highlight = (component: Component | null) => {
    for (const [mesh, saved] of original) for (const m of materials(mesh)) if ("emissive" in m) { (m as MeshStandardMaterial).emissive.copy(saved.emissive); (m as MeshStandardMaterial).emissiveIntensity = saved.intensity; }
    original.clear();
    for (const line of outline.splice(0)) { line.geometry.dispose(); (line.material as Material).dispose(); line.removeFromParent(); }
    if (!component) return;
    for (const mesh of component.meshes) {
      const first = materials(mesh).find(m => "emissive" in m) as MeshStandardMaterial | undefined;
      if (first) original.set(mesh, { emissive: first.emissive.clone(), intensity: first.emissiveIntensity });
      for (const m of materials(mesh)) if ("emissive" in m) { (m as MeshStandardMaterial).emissive.copy(accent).multiplyScalar(0.32); (m as MeshStandardMaterial).emissiveIntensity = 1; }
      if (triangles <= EDGE_TRIANGLE_LIMIT) {
        const line = new LineSegments(new EdgesGeometry(mesh.geometry, 28), new LineBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false }));
        line.renderOrder = 5;
        mesh.add(line);
        outline.push(line);
      }
    }
  };
  const materials = (mesh: Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

  const properties = (component: Component): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    const add = (key: string, value: unknown) => {
      if (Object.keys(out).length >= 24) return;
      const k = cleanCardText(key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "), 40);
      if (!k || !/^[\p{L}][\p{L}\p{N} ._()-]{0,39}$/u.test(k)) return;
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[k] = value;
      else { const text = cleanCardText(value, 200); if (text) out[k] = text; }
    };
    // What the model itself says about the component (glTF extras)…
    for (const [k, v] of Object.entries(component.object.userData)) if (!["name", "aionId", "label", "title"].includes(k)) add(k[0].toUpperCase() + k.slice(1), v);
    // …and what is measured from its geometry.
    const box = new Box3().setFromObject(component.object), size = box.getSize(new Vector3());
    const fmt = (v: number) => Number(v.toPrecision(3)).toString();
    add("Type", component.children.length ? "Assembly" : "Part");
    if (component.children.length) add("Components", component.children.length);
    const tris = component.meshes.reduce((sum, mesh) => sum + (mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3), 0);
    add("Triangles", Math.round(tris));
    // Metres (glTF's unit, when the model declares it) read better in millimetres at this scale.
    const mm = units === "m" && Math.max(size.x, size.y, size.z) < 2;
    const shown = mm ? size.clone().multiplyScalar(1000) : size;
    if (isFinite(size.x)) add("Bounding size", `${fmt(shown.x)} × ${fmt(shown.y)} × ${fmt(shown.z)}${mm ? " mm" : units ? ` ${units}` : " (model units)"}`);
    const material = component.meshes[0] ? materials(component.meshes[0])[0] : null;
    if (material?.name && !("Material" in out)) add("Material (render)", material.name.replace(/_/g, " "));
    return out;
  };

  const select = (component: Component | null, emit = true) => {
    selected = component;
    highlight(component);
    props.replaceChildren();
    props.hidden = !component;
    if (component) {
      const p = properties(component);
      props.append(
        el("div", { className: "title", text: component.name }), el("div", { className: "kind mono", text: component.id }),
        el("dl", {}, Object.entries(p).flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: typeof v === "number" ? v.toLocaleString("en") : String(v) })])),
        el("div", { className: "row" }, [
          button("Hide", `Hide ${component.name}`, () => setVisible(component, false)),
          button("Isolate", `Show only ${component.name}`, () => isolate(component)),
          button("Focus", `Fit ${component.name} to the view`, () => focus(component)),
        ]),
      );
    }
    for (const row of treeList.querySelectorAll<HTMLElement>("[data-id]")) row.setAttribute("aria-selected", String(row.dataset.id === component?.id));
    if (emit) {
      const center = component ? new Box3().setFromObject(component.object).getCenter(new Vector3()) : null;
      const at = center ? engine.screenOf(center) : null;
      ctx.emit.selection(component ? { objectId: component.id, name: component.name, kind: component.children.length ? "Assembly" : "Part", properties: properties(component), ...(at ? { screen: at } : {}) } : { objectId: null });
      report();
    }
    engine.requestRender();
  };
  const clearSelection = (emit = true) => select(null, emit);

  let down: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const onUp = (event: PointerEvent) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || !model) { down = null; return; }
    down = null;
    const hit = engine.pick(event.clientX, event.clientY, [model]);
    let component: Component | null = null;
    for (let o: Object3D | null = hit?.object ?? null; o && !component; o = o.parent) component = components.find(c => c.object === o) ?? null;
    select(component);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { if (selected) clearSelection(); else ctx.emit.interaction("escape"); }
    if ((event.key === "f" || event.key === "F") && document.activeElement === engine.canvas) fit();
  };
  engine.canvas.addEventListener("pointerdown", onDown);
  engine.canvas.addEventListener("pointerup", onUp);
  addEventListener("keydown", onKey);
  engine.addDisposer(() => { engine.canvas.removeEventListener("pointerdown", onDown); engine.canvas.removeEventListener("pointerup", onUp); removeEventListener("keydown", onKey); });
  engine.controls.addEventListener("start", () => { if (view !== "custom") { view = "custom"; report(); } ctx.emit.interaction("pointer-down"); });
  engine.controls.addEventListener("end", () => ctx.emit.interaction("pointer-up"));

  // ── Visibility ─────────────────────────────────────────────────────────────────────────────────────────────────
  const setVisible = (component: Component, on: boolean) => {
    component.object.visible = on;
    // Showing a part inside a hidden group shows the path to it.
    if (on) for (let p = component.parent; p; p = p.parent) p.object.visible = true;
    if (!on && selected && (selected === component || isInside(selected, component))) clearSelection();
    isolated = null;
    syncTree(); report(); engine.requestRender();
  };
  const isInside = (component: Component, ancestor: Component) => { for (let p = component.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
  const isolate = (target: Component) => {
    for (const c of components) c.object.visible = c === target || isInside(c, target) || isInside(target, c);
    isolated = target;
    syncTree(); report(); engine.requestRender();
  };
  const showAll = () => { for (const c of components) c.object.visible = true; isolated = null; syncTree(); report(); engine.requestRender(); };

  const renderTree = () => {
    treeTitle.textContent = modelName;
    treeCount.textContent = `${components.length} component${components.length === 1 ? "" : "s"} · ${triangles.toLocaleString("en")} triangles`;
    treeList.replaceChildren(...components.slice(0, 2000).map(component => {
      const name = button(component.name, `Select ${component.name}`, () => select(component), "tree-name");
      const eye = button("", `Hide or show ${component.name}`, () => setVisible(component, !component.object.visible), "eye");
      const row = el("div", { className: "tree-row" }, [eye, name]);
      row.dataset.id = component.id;
      row.setAttribute("role", "treeitem");
      row.style.paddingLeft = `${4 + component.depth * 12}px`;
      return row;
    }));
    syncTree();
  };
  const syncTree = () => {
    for (const row of treeList.querySelectorAll<HTMLElement>("[data-id]")) {
      const component = byId.get(row.dataset.id!);
      if (!component) continue;
      const own = component.object.visible, shown = isShown(component.object);
      row.classList.toggle("hidden", !shown);
      const eye = row.querySelector(".eye")!;
      eye.textContent = own ? "●" : "○";
      eye.setAttribute("aria-pressed", String(own));
    }
  };

  // ── Camera ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const visibleBox = (root: Object3D | null) => {
    const box = new Box3();
    root?.traverse(object => { const mesh = object as Mesh; if (mesh.isMesh && isShown(mesh)) box.expandByObject(mesh); });
    return box;
  };
  const setView = (next: Exclude<View, "custom">, seconds = 1) => {
    view = next;
    const box = visibleBox(model);
    if (box.isEmpty()) return;
    const framing = engine.framing(box, DIRECTIONS[next]);
    engine.flyTo(framing.position, framing.target, seconds);
    report();
  };
  const fit = (seconds = 0.9) => {
    const box = visibleBox(model);
    if (box.isEmpty()) return false;
    const direction = camera.position.clone().sub(engine.controls.target);
    const framing = engine.framing(box, direction.lengthSq() ? direction : DIRECTIONS.iso);
    engine.flyTo(framing.position, framing.target, seconds);
    return true;
  };
  const focus = (component: Component) => {
    const box = visibleBox(component.object);
    if (box.isEmpty()) return false;
    const direction = camera.position.clone().sub(engine.controls.target);
    const framing = engine.framing(box, direction.lengthSq() ? direction : DIRECTIONS.iso, 1.6);
    engine.flyTo(framing.position, framing.target, 0.9);
    return true;
  };
  const resetView = () => { setView("iso"); };

  const buildEdges = () => {
    if (!model || triangles > EDGE_TRIANGLE_LIMIT) return false;
    model.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || edgeLines.has(mesh) || outline.includes(mesh as unknown as LineSegments)) return;
      const line = new LineSegments(new EdgesGeometry(mesh.geometry, 30), edgeMaterial);
      edgeLines.set(mesh, line);
      mesh.add(line);
    });
    return true;
  };
  const edgeMaterial = new LineBasicMaterial({ color: "#11161b", transparent: true, opacity: 0.6 });
  engine.addDisposer(() => edgeMaterial.dispose());
  const setEdges = (on: boolean): CommandResult => {
    if (on && model && triangles > EDGE_TRIANGLE_LIMIT) return { ok: false, problem: `edges are drawn for models up to ${EDGE_TRIANGLE_LIMIT.toLocaleString("en")} triangles` };
    edges = on;
    if (on) buildEdges();
    for (const line of edgeLines.values()) line.visible = on;
    edgesToggle.sync();
    report(); engine.requestRender();
    return { ok: true };
  };

  // ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────
  let pending: ReturnType<typeof setTimeout> | null = null;
  const report = () => { pending ??= setTimeout(flush, 80); };
  const flush = () => {
    pending = null;
    const tree: CardTreeNode[] = components.slice(0, STATE_TREE_LIMIT).map(c => ({ id: c.id, name: c.name, depth: Math.min(32, c.depth), visible: isShown(c.object) }));
    const hidden = components.filter(c => !c.object.visible).slice(0, STATE_TREE_LIMIT).map(c => c.id);
    ctx.emit.state({
      ...(modelName ? { model: modelName } : {}), components: tree, componentCount: components.length, truncated: components.length > STATE_TREE_LIMIT,
      hidden, view, edges, triangles, ...(selected ? { selected: selected.id } : {}), ...(isolated ? { isolated: isolated.id } : {}),
    });
  };

  const need = (value: CardValue | undefined): Component | { problem: string } => {
    if (!model) return { problem: "no model is loaded" };
    const id = value as string;
    const found = byId.get(id) ?? components.find(c => c.name.toLowerCase() === id.toLowerCase());
    return found ?? { problem: `no component "${id}" (inspect the card for the component ids)` };
  };
  const withComponent = (value: CardValue | undefined, run: (component: Component) => unknown): CommandResult => {
    const found = need(value);
    if ("problem" in found) return { ok: false, problem: found.problem };
    run(found);
    return { ok: true };
  };

  const commands: Record<string, (value: CardValue | undefined) => CommandResult> = {
    select: value => withComponent(value, component => select(component)),
    "clear-selection": () => { clearSelection(); return { ok: true }; },
    hide: value => withComponent(value, component => setVisible(component, false)),
    show: value => withComponent(value, component => setVisible(component, true)),
    isolate: value => withComponent(value, component => isolate(component)),
    "show-all": () => { showAll(); return { ok: true }; },
    fit: () => (fit() ? { ok: true } : { ok: false, problem: "nothing visible to fit" }),
    focus: value => withComponent(value, component => focus(component)),
    "set-view": value => { if (!model) return { ok: false, problem: "no model is loaded" }; setView(value as Exclude<View, "custom">); return { ok: true }; },
    "reset-camera": () => { resetView(); return { ok: true }; },
    "show-edges": value => setEdges(value as boolean),
  };

  return {
    start() { engine.requestRender(); report(); },
    async loadAsset(asset, data) {
      try { await load(asset, data); } catch (error) {
        const code = error instanceof Error && /^model-[a-z-]+$/.test(error.message) ? error.message : "model-load-failed";
        empty.textContent = model ? "" : "The model could not be loaded.";
        empty.hidden = !!model;
        throw new Error(code);
      }
    },
    command(name, value) {
      const run = commands[name];
      return run ? run(value) : { ok: false, problem: `unknown command ${name}` };
    },
    flush() { if (pending) { clearTimeout(pending); flush(); } },
    setState(state) {
      if (typeof state.edges === "boolean") setEdges(state.edges);
      if (typeof state.selected === "string" && byId.has(state.selected)) select(byId.get(state.selected)!, false);
      if (Array.isArray(state.hidden)) for (const id of state.hidden) { const c = byId.get(id as string); if (c) c.object.visible = false; }
      if (typeof state.isolated === "string" && byId.has(state.isolated)) isolate(byId.get(state.isolated)!);
      syncTree();
    },
    setCamera(next, focusId) {
      if (focusId) { const c = byId.get(focusId); return c && focus(c) ? { ok: true } : { ok: false, problem: "no such component" }; }
      if (next && next in DIRECTIONS) { setView(next as Exclude<View, "custom">); return { ok: true }; }
      return { ok: false, problem: "unknown view" };
    },
    pause() { /* nothing animates: frames are drawn on demand already */ },
    resume() { engine.requestRender(); },
    suspend(on) { engine.setSuspended(on); },
    reset() { showAll(); clearSelection(); setEdges(ctx.config.edges === true); setView((ctx.config.view as Exclude<View, "custom"> | undefined) ?? "iso"); },
    resize() { engine.resize(); },
    status: () => engine.status(),
    dispose() {
      if (pending) clearTimeout(pending);
      unload();
      grid.geometry.dispose(); (grid.material as Material).dispose();
      const left = engine.dispose();
      return { ...left, urls: 0 };
    },
  };
}
