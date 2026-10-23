import {
  Box3, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture, DoubleSide, EdgesGeometry, InstancedMesh, LineBasicMaterial,
  LineSegments, Matrix4, Mesh, MeshBasicMaterial, NoColorSpace, Plane, Quaternion, Raycaster, RGBAFormat, ShaderMaterial, SphereGeometry, Triangle, Vector2,
  Vector3, type Intersection, type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ViewerEngine } from "../../runtime/engine";
import { button, el, toggle, type CardApp, type CardContext, type CommandResult } from "../../runtime/app";
import type { CardValue } from "../../values";
import { decodeFieldBundle, type BundleField, type FieldBundle } from "../../../sim/field";
import { locate, sliceTets, type Section } from "../../../sim/slice";
import { COLORMAPS, colorAt, lookupTable, niceTicks, type ColormapId } from "./colormaps";

/**
 * The Simulation Card (v0.8): numerical FEM fields, shown as an engineer expects them — and nothing else.
 *
 * It receives a validated field bundle (src/sim/field.ts) from `simulate`: a study's setup (CAD faces coloured by their
 * conditions; click a face to pick it for "$selected") or a solver's result (Elmer's nodal fields on the mesh). The
 * colour of every pixel is looked up from the field value interpolated across the triangle, in the same table the
 * legend draws, with no tone mapping; a field the bundle does not carry is not offered. Sections are computed through
 * the tetrahedra (marching tetrahedra, linear interpolation along the cut edges), so the interior shown is the solver's
 * own field; probes say how a value was obtained (nodal, or interpolated linearly on a surface triangle or inside a
 * tetrahedron). The card never computes a field or runs a solver.
 *
 * Coordinates: the bundle is the CAD model's (metres, Z up); the scene is millimetres, Y up (x, z, −y); everything the
 * card reports is in the CAD model's millimetres.
 */
type View = "iso" | "front" | "back" | "left" | "right" | "top" | "bottom" | "custom";
const DIRECTIONS: Record<Exclude<View, "custom">, Vector3> = {
  iso: new Vector3(1, 0.75, 1.15), front: new Vector3(0, 0, 1), back: new Vector3(0, 0, -1), left: new Vector3(-1, 0, 0), right: new Vector3(1, 0, 0),
  top: new Vector3(0, 1, 0.0001), bottom: new Vector3(0, -1, 0.0001),
};
const MESH_EDGE_LIMIT = 600_000, ARROWS = 1400, BANDS = 12;
const NEUTRAL: [number, number, number] = [0.62, 0.66, 0.7];

const vertexShader = /* glsl */`
  attribute float aValue; attribute float aMask; attribute float aFace; attribute vec3 aColor;
  varying float vValue; varying float vMask; varying float vFace; varying vec3 vColor; varying vec3 vNormal; varying vec3 vView;
  #include <clipping_planes_pars_vertex>
  void main() {
    vValue = aValue; vMask = aMask; vFace = aFace; vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }`;
const fragmentShader = /* glsl */`
  uniform sampler2D uLut; uniform float uMin; uniform float uMax; uniform float uBands; uniform float uMode; uniform float uSelected; uniform vec3 uAccent;
  varying float vValue; varying float vMask; varying float vFace; varying vec3 vColor; varying vec3 vNormal; varying vec3 vView;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    vec3 color;
    if (uMode < 0.5) {
      float t = clamp((vValue - uMin) / max(uMax - uMin, 1e-30), 0.0, 1.0);
      if (uBands > 0.5) t = min((floor(t * uBands) + 0.5) / uBands, 1.0);
      color = vMask < 0.5 ? vec3(0.32) : texture2D(uLut, vec2(t * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).rgb;
    } else color = vColor;
    // The picked face is tinted in the setup view only; over a field it is outlined instead (a tint would change the
    // colour a value has).
    if (uMode > 0.5 && uSelected > 0.0 && abs(vFace - uSelected) < 0.5) color = mix(color, uAccent, 0.5);
    float light = 0.6 + 0.4 * abs(dot(normalize(vNormal), normalize(vView)));
    gl_FragColor = vec4(color * light, 1.0);
  }`;

interface Surface { geometry: BufferGeometry; nodeOf: Uint32Array; faceOf: Float32Array; triFace: Uint32Array }
interface ProbeResult { point: Vector3; text: string; values: Record<string, number>; face?: number; method: string }

export function createSimulationCard(ctx: CardContext): CardApp {
  const engine = new ViewerEngine(ctx.stage, { reducedMotion: ctx.reducedMotion, near: 0.01, far: 100_000, fov: 35 });
  const { scene, camera, renderer } = engine;
  renderer.localClippingEnabled = true;
  scene.background = new Color("#0c0f13");
  const accent = new Color(ctx.theme.accent);
  const raycaster = new Raycaster();

  let bundle: FieldBundle | null = null, mode: "empty" | "setup" | "results" = "empty";
  let surface: Surface | null = null, surfaceMesh: Mesh | null = null, sectionMesh: Mesh | null = null, section: Section | null = null;
  let nodesMm: Float32Array = new Float32Array(0);
  let field: BundleField | null = null, values: Float32Array = new Float32Array(0), magnitudes = new Map<string, Float32Array>();
  let colormap: ColormapId = "rainbow", autoRange = true, range: [number, number] = [0, 1], bands = false;
  let showMesh = false, showEdges = true, showVectors = false, view: View = "iso", selectedFace = 0, loadedKey = "";
  let sectionSpec: { normal: [number, number, number]; d: number; label: string } | null = null, flipped = false;
  let probe: ProbeResult | null = null;
  let featureEdges: LineSegments | null = null, meshEdges: LineSegments | null = null, arrows: InstancedMesh | null = null;
  const clip = new Plane(new Vector3(1, 0, 0), 0);

  const lut = new DataTexture(lookupTable(colormap), 256, 1, RGBAFormat);
  lut.colorSpace = NoColorSpace;
  lut.needsUpdate = true;
  const uniforms = () => ({
    uLut: { value: lut }, uMin: { value: 0 }, uMax: { value: 1 }, uBands: { value: 0 }, uMode: { value: 0 }, uSelected: { value: 0 }, uAccent: { value: new Vector3(accent.r, accent.g, accent.b) },
  });
  const surfaceMaterial = new ShaderMaterial({ uniforms: uniforms(), vertexShader, fragmentShader, clipping: true, side: DoubleSide });
  const sectionMaterial = new ShaderMaterial({ uniforms: uniforms(), vertexShader, fragmentShader, side: DoubleSide });
  const edgeMaterial = new LineBasicMaterial({ color: "#0b0f14", transparent: true, opacity: 0.55 });
  const meshMaterial = new LineBasicMaterial({ color: "#1a2129", transparent: true, opacity: 0.45 });
  // Arrows are white (their length shows the magnitude): coloured like the surface, they would vanish into it.
  const arrowMaterial = new MeshBasicMaterial({ color: "#f4f7fa" });
  arrowMaterial.toneMapped = false;
  const markerMaterial = new MeshBasicMaterial({ color: accent, depthTest: false });
  markerMaterial.toneMapped = false;
  const marker = new Mesh(new SphereGeometry(1, 16, 12), markerMaterial);
  marker.renderOrder = 10;
  marker.visible = false;
  scene.add(marker);
  engine.addDisposer(() => { lut.dispose(); surfaceMaterial.dispose(); sectionMaterial.dispose(); edgeMaterial.dispose(); meshMaterial.dispose(); arrowMaterial.dispose(); markerMaterial.dispose(); marker.geometry.dispose(); });

  // ── Controls ───────────────────────────────────────────────────────────────────────────────────────────────────
  const info = el("div", { className: "panel info sim-info" });
  const legend = el("div", { className: "panel sim-legend" });
  legend.hidden = true;
  const readout = el("div", { className: "panel sim-probe" });
  readout.hidden = true;
  readout.setAttribute("aria-live", "polite");
  const empty = el("div", { className: "empty", text: "Waiting for a simulation…" });
  const progress = el("div", { className: "backend-status" });
  progress.hidden = true;
  const select = (label: string, options: [string, string][], onChange: (value: string) => void) => {
    const s = el("select", { className: "sim-select", label });
    s.append(...options.map(([value, text]) => { const o = el("option", { text }); o.value = value; return o; }));
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };
  const fieldSelect = select("Field", [], value => { setField(value); });
  const mapSelect = select("Colour map", COLORMAPS.map(c => [c, c[0].toUpperCase() + c.slice(1)]), value => { setColormap(value as ColormapId); });
  const minInput = el("input", { className: "sim-range", label: "Range minimum" }), maxInput = el("input", { className: "sim-range", label: "Range maximum" });
  for (const input of [minInput, maxInput]) { input.type = "text"; input.inputMode = "decimal"; input.addEventListener("change", () => { applyManualRange(); }); }
  const autoButton = toggle("Auto", "Automatic range from the field's minimum and maximum", () => autoRange, on => { if (on) setAuto(); else applyManualRange(); });
  const bandsButton = toggle("Bands", "Banded contours", () => bands, on => { setBands(on); });
  const meshButton = toggle("Mesh", "Show the mesh", () => showMesh, on => { setMesh(on); });
  const edgesButton = toggle("Edges", "Show the CAD faces' edges", () => showEdges, on => { setEdges(on); });
  const vectorsButton = toggle("Vectors", "Arrows of the vector field", () => showVectors, on => { setVectors(on); });
  const slider = el("input", { className: "seek", label: "Section position" });
  slider.type = "range"; slider.min = "0"; slider.max = "1000"; slider.value = "500";
  slider.addEventListener("input", () => { if (sectionSpec) moveSection(Number(slider.value) / 1000); });
  const axisButtons = (["x", "y", "z"] as const).map(axis => button(axis.toUpperCase(), `Section across ${axis.toUpperCase()}`, () => { setAxisSection(axis); }));
  const offButton = button("Off", "No section", () => { setSection(null); });
  const flipButton = button("Flip", "Keep the other side of the section", () => { flipped = !flipped; updateClip(); report(); });
  const fieldGroup = el("div", { className: "group wrap" }, [fieldSelect, mapSelect, autoButton, minInput, el("span", { className: "sim-dash", text: "…" }), maxInput, bandsButton]);
  const sectionGroup = el("div", { className: "group" }, [el("span", { className: "sim-label", text: "Section" }), ...axisButtons, slider, flipButton, offButton]);
  const maxButton = button("Max", "Mark the maximum of the shown field", () => { probeExtreme("max"); });
  const minButton = button("Min", "Mark the minimum of the shown field", () => { probeExtreme("min"); });
  const viewGroup = el("div", { className: "group" }, [vectorsButton, meshButton, edgesButton, maxButton, minButton,
    button("Iso", "Isometric view", () => setView("iso")), button("Fit", "Fit the model to the view", () => fit())]);
  const bar = el("div", { className: "bar" }, [fieldGroup, sectionGroup, viewGroup]);
  ctx.ui.append(info, legend, readout, empty, progress, bar);
  const setProgress = (text: string) => { progress.textContent = text; progress.hidden = !text; };

  // ── Display units (SI prefixes; temperature in °C) ─────────────────────────────────────────────────────────────
  const display = (f: BundleField | null) => {
    if (!f) return { scale: 1, offset: 0, unit: "" };
    if (f.display) return { scale: 1, offset: f.display.offset, unit: f.display.unit };
    const m = Math.max(Math.abs(f.min), Math.abs(f.max));
    const prefixes: [number, string][] = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"]];
    const [scale, prefix] = m === 0 ? [1, ""] : prefixes.find(([s]) => m >= s * 0.9999) ?? prefixes[prefixes.length - 1];
    return { scale: 1 / scale, offset: 0, unit: `${prefix}${f.unit}` };
  };
  const shown = (v: number, f = field) => { const d = display(f); return v * d.scale + d.offset; };
  const fmt = (v: number, digits = 4) => {
    if (!Number.isFinite(v)) return String(v);
    const r = Number(v.toPrecision(digits));
    return Math.abs(r) !== 0 && (Math.abs(r) < 1e-3 || Math.abs(r) >= 1e6) ? r.toExponential(digits - 1) : String(r);
  };

  // ── Building the surface ───────────────────────────────────────────────────────────────────────────────────────
  const toScene = (x: number, y: number, z: number) => new Vector3(x, z, -y);
  const toCad = (v: Vector3): [number, number, number] => [v.x, -v.z, v.y].map(c => Math.round(c * 1e4) / 1e4 + 0) as [number, number, number];

  const buildSurface = (b: FieldBundle): Surface => {
    const t = b.triFace.length;
    // Triangles grouped by face; vertices duplicated per face (smooth within a face, sharp between faces).
    const order = Array.from({ length: t }, (_, i) => i).sort((a, c) => b.triFace[a] - b.triFace[c]);
    const nodeOf: number[] = [], faceOf: number[] = [], index = new Uint32Array(t * 3), triFace = new Uint32Array(t);
    let local = new Map<number, number>(), current = -1;
    order.forEach((tri, k) => {
      const face = b.triFace[tri];
      if (face !== current) { local = new Map(); current = face; }
      triFace[k] = face;
      for (let c = 0; c < 3; c++) {
        const node = b.tris[tri * 3 + c];
        let v = local.get(node);
        if (v === undefined) { v = nodeOf.length; nodeOf.push(node); faceOf.push(face); local.set(node, v); }
        index[k * 3 + c] = v;
      }
    });
    const positions = new Float32Array(nodeOf.length * 3);
    nodeOf.forEach((node, v) => { const p = toScene(b.nodes[node * 3] * 1e3, b.nodes[node * 3 + 1] * 1e3, b.nodes[node * 3 + 2] * 1e3); positions.set([p.x, p.y, p.z], v * 3); });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeVertexNormals();
    geometry.setAttribute("aValue", new BufferAttribute(new Float32Array(nodeOf.length), 1));
    geometry.setAttribute("aMask", new BufferAttribute(new Float32Array(nodeOf.length).fill(1), 1));
    geometry.setAttribute("aFace", new BufferAttribute(Float32Array.from(faceOf), 1));
    const colors = new Float32Array(nodeOf.length * 3);
    const faceColor = new Map(b.header.faces.map(f => [f.index, f.color ? new Color(f.color) : null]));
    faceOf.forEach((face, v) => { const c = faceColor.get(face); colors.set(c ? [c.r, c.g, c.b] : NEUTRAL, v * 3); });
    geometry.setAttribute("aColor", new BufferAttribute(colors, 3));
    return { geometry, nodeOf: Uint32Array.from(nodeOf), faceOf: Float32Array.from(faceOf), triFace };
  };

  const unload = () => {
    for (const object of [surfaceMesh, sectionMesh, featureEdges, meshEdges, arrows, outline] as (Object3D | null)[]) {
      if (!object) continue;
      scene.remove(object);
      (object as Mesh).geometry?.dispose();
    }
    surfaceMesh = sectionMesh = featureEdges = meshEdges = arrows = outline = null;
    surface?.geometry.dispose();
    surface = null; section = null; bundle = null; field = null; probe = null;
    magnitudes = new Map();
    marker.visible = false;
    // A probe belongs to the result it read: a new result never shows an old one's numbers.
    readout.replaceChildren();
    readout.hidden = true;
  };

  const load = (data: ArrayBuffer) => {
    const decoded = decodeFieldBundle(new Uint8Array(data));
    const keepCamera = bundle !== null && bundle.header.geometry.document === decoded.header.geometry.document && bundle.header.study.id === decoded.header.study.id;
    const previousField = field?.id, previousSection = sectionSpec;
    unload();
    bundle = decoded;
    mode = decoded.header.mode;
    nodesMm = new Float32Array(decoded.nodes.length);
    for (let i = 0; i < decoded.nodes.length; i++) nodesMm[i] = decoded.nodes[i] * 1e3;
    surface = buildSurface(decoded);
    surfaceMesh = new Mesh(surface.geometry, surfaceMaterial);
    scene.add(surfaceMesh);
    featureEdges = new LineSegments(new EdgesGeometry(surface.geometry, 25), edgeMaterial);
    featureEdges.visible = showEdges;
    scene.add(featureEdges);
    for (const f of decoded.header.fields) if (f.kind === "vector") magnitudes.set(f.id, magnitude(decoded.blocks[f.block] as Float32Array));
    fieldSelect.replaceChildren(...decoded.header.fields.map(f => { const o = el("option", { text: f.name }); o.value = f.id; return o; }));
    fieldGroup.hidden = mode !== "results";
    sectionGroup.hidden = mode !== "results";
    vectorsButton.hidden = meshButton.hidden = maxButton.hidden = minButton.hidden = mode !== "results";
    empty.hidden = true;
    const box = new Box3().setFromBufferAttribute(surface.geometry.getAttribute("position") as BufferAttribute);
    const size = box.getSize(new Vector3()).length() || 1;
    camera.near = size / 2000; camera.far = size * 60; camera.updateProjectionMatrix();
    marker.scale.setScalar(size * 0.009);
    if (mode === "results") {
      const next = decoded.header.fields.find(f => f.id === previousField) ?? decoded.header.fields[0] ?? null;
      setField(next?.id ?? "", false);
      if (previousSection && decoded.tets) setSection(previousSection, false); else sectionSpec = null;
    } else { field = null; surfaceMaterial.uniforms.uMode.value = 1; sectionSpec = null; drawLegend(); }
    if (showMesh) setMesh(true);
    updateClip();
    renderInfo();
    loadedKey = `${mode}:${decoded.header.study.id}:${decoded.header.study.revision}:${decoded.header.study.run ?? 0}`;
    if (selectedFace && !decoded.header.faces.some(f => f.index === selectedFace)) selectFace(0);
    else selectFace(selectedFace, false);
    if (!keepCamera) setView("iso", 0);
    report();
    engine.requestRender();
  };

  const magnitude = (v: Float32Array) => {
    const out = new Float32Array(v.length / 3);
    for (let i = 0; i < out.length; i++) out[i] = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    return out;
  };
  const nodalScalar = (f: BundleField): Float32Array => (f.kind === "vector" ? magnitudes.get(f.id)! : bundle!.blocks[f.block] as Float32Array);

  // ── Fields, colours, range ─────────────────────────────────────────────────────────────────────────────────────
  const setField = (id: string, emit = true): CommandResult => {
    if (!bundle || mode !== "results") return { ok: false, problem: "no result is shown" };
    const f = bundle.header.fields.find(x => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!f) return { ok: false, problem: `this result has no field "${id}" (fields: ${bundle.header.fields.map(x => x.id).join(", ") || "none"})` };
    field = f;
    values = nodalScalar(f);
    fieldSelect.value = f.id;
    const attr = surface!.geometry.getAttribute("aValue") as BufferAttribute, mask = surface!.geometry.getAttribute("aMask") as BufferAttribute;
    const m = f.mask ? bundle.blocks[f.mask] as Uint8Array : null;
    for (let v = 0; v < surface!.nodeOf.length; v++) { attr.setX(v, values[surface!.nodeOf[v]]); mask.setX(v, m ? m[surface!.nodeOf[v]] : 1); }
    attr.needsUpdate = true; mask.needsUpdate = true;
    surfaceMaterial.uniforms.uMode.value = 0;
    if (autoRange || emit) setAuto(false);
    if (f.kind !== "vector" && showVectors) setVectors(false, false);
    vectorsButton.disabled = f.kind !== "vector";
    if (sectionSpec) rebuildSection();
    if (probe) refreshProbe();
    drawLegend();
    if (emit) report();
    engine.requestRender();
    return { ok: true };
  };
  const setAuto = (emit = true) => {
    autoRange = true;
    if (field) range = [field.min, field.max];
    applyRange();
    if (emit) report();
  };
  const applyRange = () => {
    const [lo, hi] = range[1] > range[0] ? range : [range[0] - Math.abs(range[0] || 1) * 1e-6, range[0] + Math.abs(range[0] || 1) * 1e-6];
    for (const m of [surfaceMaterial, sectionMaterial]) { m.uniforms.uMin.value = lo; m.uniforms.uMax.value = hi; m.uniforms.uBands.value = bands ? BANDS : 0; }
    minInput.value = field ? fmt(shown(range[0])) : ""; maxInput.value = field ? fmt(shown(range[1])) : "";
    autoButton.sync();
    if (arrows) buildArrows();
    drawLegend();
    engine.requestRender();
  };
  const applyManualRange = () => {
    const d = display(field);
    const lo = (Number(minInput.value) - d.offset) / d.scale, hi = (Number(maxInput.value) - d.offset) / d.scale;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) { applyRange(); return; }
    autoRange = false;
    range = [lo, hi];
    applyRange();
    report();
  };
  const setColormap = (next: ColormapId): CommandResult => {
    colormap = next;
    mapSelect.value = next;
    lut.image.data!.set(lookupTable(next));
    lut.needsUpdate = true;
    if (arrows) buildArrows();
    drawLegend(); report(); engine.requestRender();
    return { ok: true };
  };
  const setBands = (on: boolean): CommandResult => { bands = on; bandsButton.sync(); applyRange(); report(); return { ok: true }; };

  // ── Legend ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const drawLegend = () => {
    legend.replaceChildren();
    if (!bundle) { legend.hidden = true; return; }
    if (mode === "setup") {
      const conditions = bundle.header.conditions ?? [];
      legend.hidden = false;
      legend.append(el("div", { className: "title", text: "Boundary conditions" }));
      if (!conditions.length) legend.append(el("div", { className: "kind", text: "None assigned yet. Click a face to pick it." }));
      for (const c of conditions) {
        const swatch = el("span", { className: "swatch" });
        swatch.style.background = c.color;
        const row = el("div", { className: "material", title: c.text }, [swatch, el("span", { text: c.name })]);
        legend.append(row);
      }
      if (conditions.length) legend.append(el("div", { className: "kind", text: "A face with two conditions shows its first (electrical) one." }));
      if (selectedFace) {
        const swatch = el("span", { className: "swatch" });
        swatch.style.background = `#${accent.getHexString()}`;
        legend.append(el("div", { className: "material" }, [swatch, el("span", { text: `Picked face (F${selectedFace})` })]));
      }
      const swatch = el("span", { className: "swatch" });
      swatch.style.background = `rgb(${NEUTRAL.map(c => Math.round(c * 255)).join(",")})`;
      legend.append(el("div", { className: "material" }, [swatch, el("span", { text: "No condition (insulated / adiabatic)" })]));
      return;
    }
    if (!field) { legend.hidden = true; return; }
    legend.hidden = false;
    const d = display(field);
    const canvas = document.createElement("canvas");
    canvas.width = 18; canvas.height = 200; canvas.className = "sim-bar";
    const g = canvas.getContext("2d")!;
    for (let y = 0; y < 200; y++) {
      let t = 1 - y / 199;
      if (bands) t = Math.min(1, (Math.floor(t * BANDS) + 0.5) / BANDS);
      const [r, gg, b] = colorAt(colormap, t);
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(0, y, 18, 1);
    }
    const lo = shown(range[0]), hi = shown(range[1]);
    const ticks = niceTicks(Math.min(lo, hi), Math.max(lo, hi), 6);
    const scale = el("div", { className: "sim-scale" }, [canvas]);
    const labels = el("div", { className: "sim-ticks" });
    for (const tick of ticks) {
      const label = el("span", { text: fmt(tick, 3) });
      label.style.top = `${(1 - (tick - lo) / (hi - lo || 1)) * 100}%`;
      labels.append(label);
    }
    scale.append(labels);
    legend.append(
      el("div", { className: "title", text: field.name }), el("div", { className: "kind", text: d.unit ? `[${d.unit}]` : "" }), scale,
      el("dl", {}, [el("dt", { text: "Max" }), el("dd", { text: `${fmt(shown(field.max))} ${d.unit}` }), el("dt", { text: "Min" }), el("dd", { text: `${fmt(shown(field.min))} ${d.unit}` })]),
      el("div", { className: "kind", text: `${autoRange ? "Automatic range" : "Manual range"} · nodal values` }),
      el("div", { className: "kind", text: field.source }),
      ...(field.mask ? [el("div", { className: "kind", text: "Grey: not computed (electrical insulator)." })] : []),
    );
  };

  const renderInfo = () => {
    info.replaceChildren();
    if (!bundle) return;
    const h = bundle.header;
    info.append(el("div", { className: "title", text: h.study.name }), el("div", { className: "kind", text: `${h.mode === "results" ? `Run ${h.study.run} · ` : "Setup · "}${h.study.analysis} · geometry revision ${h.geometry.revision}` }));
    if (h.summary.length) info.append(el("div", { className: "sim-lines" }, h.summary.slice(0, 12).map(line => el("div", { text: line }))));
    for (const note of h.omitted) info.append(el("p", { className: "note", text: note }));
    if (h.mode === "setup") info.append(el("p", { className: "note", text: "Click a face to pick it (Codex can then use it as \"$selected\")." }));
  };

  // ── Edges, mesh, vectors ───────────────────────────────────────────────────────────────────────────────────────
  const setEdges = (on: boolean): CommandResult => { showEdges = on; if (featureEdges) featureEdges.visible = on; edgesButton.sync(); report(); engine.requestRender(); return { ok: true }; };
  const setMesh = (on: boolean): CommandResult => {
    if (on && bundle && bundle.header.counts.triangles > MESH_EDGE_LIMIT) return { ok: false, problem: `the mesh is drawn up to ${MESH_EDGE_LIMIT.toLocaleString("en")} surface triangles` };
    showMesh = on;
    if (on && !meshEdges && bundle && surface) {
      const seen = new Set<number>(), lines: number[] = [];
      const pos = surface.geometry.getAttribute("position") as BufferAttribute, index = surface.geometry.getIndex()!;
      for (let t = 0; t < index.count; t += 3) for (let k = 0; k < 3; k++) {
        const a = index.getX(t + k), b = index.getX(t + (k + 1) % 3);
        const na = surface.nodeOf[a], nb = surface.nodeOf[b];
        const key = Math.min(na, nb) * 4_194_304 + Math.max(na, nb);
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(pos.getX(a), pos.getY(a), pos.getZ(a), pos.getX(b), pos.getY(b), pos.getZ(b));
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(Float32Array.from(lines), 3));
      meshEdges = new LineSegments(g, meshMaterial);
      scene.add(meshEdges);
    }
    if (meshEdges) meshEdges.visible = on;
    meshButton.sync(); report(); engine.requestRender();
    return { ok: true };
  };
  const arrowGeometry = (() => {
    const shaft = new CylinderGeometry(0.035, 0.035, 0.7, 6).translate(0, 0.35, 0);
    const head = new ConeGeometry(0.11, 0.3, 10).translate(0, 0.85, 0);
    const merged = mergeGeometries([shaft, head])!;
    shaft.dispose(); head.dispose();
    return merged;
  })();
  engine.addDisposer(() => arrowGeometry.dispose());
  const buildArrows = () => {
    if (arrows) { scene.remove(arrows); arrows.dispose(); arrows = null; }
    if (!showVectors || !bundle || !field || field.kind !== "vector" || !surface) return;
    const vec = bundle.blocks[field.block] as Float32Array, mags = magnitudes.get(field.id)!;
    const mask = field.mask ? bundle.blocks[field.mask] as Uint8Array : null;
    // Sample points: the section's vertices when there is one (the interior), else the surface's nodes; one per cell.
    const points: { p: Vector3; v: Vector3; m: number }[] = [];
    const box = new Box3().setFromBufferAttribute(surface.geometry.getAttribute("position") as BufferAttribute);
    const cell = box.getSize(new Vector3()).length() / 22;
    const taken = new Set<string>();
    const consider = (p: Vector3, v: Vector3, m: number) => {
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;
      if (taken.has(key) || points.length >= ARROWS || m <= 0) return;
      taken.add(key); points.push({ p, v, m });
    };
    if (section && sectionMesh) {
      for (let i = 0; i < section.weights.length; i += 3) {
        const a = section.nodes[i * 2], b = section.nodes[i * 2 + 1], w = section.weights[i];
        if (mask && (!mask[a] || !mask[b])) continue;
        const v = new Vector3(...[0, 1, 2].map(k => (1 - w) * vec[a * 3 + k] + w * vec[b * 3 + k]) as [number, number, number]);
        consider(toScene(section.positions[i * 3] * 1e3, section.positions[i * 3 + 1] * 1e3, section.positions[i * 3 + 2] * 1e3), toScene(v.x, v.y, v.z), v.length());
      }
    } else {
      const pos = surface.geometry.getAttribute("position") as BufferAttribute;
      for (let v = 0; v < surface.nodeOf.length; v++) {
        const n = surface.nodeOf[v];
        if (mask && !mask[n]) continue;
        const p = new Vector3(pos.getX(v), pos.getY(v), pos.getZ(v));
        if (sectionSpec && clip.distanceToPoint(p) < 0) continue;
        consider(p, toScene(vec[n * 3], vec[n * 3 + 1], vec[n * 3 + 2]), mags[n]);
      }
    }
    if (!points.length) return;
    const max = Math.max(...points.map(x => x.m)) || 1;
    arrows = new InstancedMesh(arrowGeometry, arrowMaterial, points.length);
    const up = new Vector3(0, 1, 0), q = new Quaternion(), s = new Vector3(), m4 = new Matrix4();
    const length = cell * 1.4;
    points.forEach((x, i) => {
      q.setFromUnitVectors(up, x.v.clone().normalize());
      const l = length * (0.35 + 0.65 * x.m / max);
      s.set(l, l, l);
      m4.compose(x.p, q, s);
      arrows!.setMatrixAt(i, m4);
    });
    arrows.instanceMatrix.needsUpdate = true;
    scene.add(arrows);
  };
  const setVectors = (on: boolean, emit = true): CommandResult => {
    if (on && (!field || field.kind !== "vector")) return { ok: false, problem: "the shown field is not a vector field (current_density, electric_field, heat_flux)" };
    showVectors = on;
    vectorsButton.sync();
    buildArrows();
    if (emit) report();
    engine.requestRender();
    return { ok: true };
  };

  // ── Sections ───────────────────────────────────────────────────────────────────────────────────────────────────
  const extent = (normal: [number, number, number]) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < nodesMm.length; i += 3) { const s = nodesMm[i] * normal[0] + nodesMm[i + 1] * normal[1] + nodesMm[i + 2] * normal[2]; lo = Math.min(lo, s); hi = Math.max(hi, s); }
    return [lo, hi] as const;
  };
  const setAxisSection = (axis: "x" | "y" | "z", offset?: number) => {
    const normal: [number, number, number] = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
    const [lo, hi] = extent(normal);
    const d = offset ?? (lo + hi) / 2;
    return setSection({ normal, d, label: `${axis} ${fmt(d)} mm` });
  };
  const setSection = (spec: { normal: [number, number, number]; d: number; label: string } | null, emit = true): CommandResult => {
    if (spec && (!bundle || mode !== "results")) return { ok: false, problem: "sections are shown on results" };
    if (spec && !bundle!.tets) return { ok: false, problem: "this result carries no interior elements (too large for the card), so no section can be drawn" };
    const fresh = Boolean(spec && !sectionSpec);
    sectionSpec = spec;
    if (spec) {
      // A new section removes the half nearer the camera, so its cut face looks at the user (Flip keeps the other).
      if (fresh) {
        const eye = toCad(camera.position);
        flipped = eye[0] * spec.normal[0] + eye[1] * spec.normal[1] + eye[2] * spec.normal[2] < spec.d;
      }
      const [lo, hi] = extent(spec.normal);
      slider.value = String(Math.round(((spec.d - lo) / (hi - lo || 1)) * 1000));
    }
    rebuildSection();
    updateClip();
    if (emit) report();
    return { ok: true };
  };
  const moveSection = (t: number) => {
    if (!sectionSpec) return;
    const [lo, hi] = extent(sectionSpec.normal);
    const d = lo + t * (hi - lo);
    const axis = sectionSpec.normal[0] === 1 ? "x" : sectionSpec.normal[1] === 1 ? "y" : sectionSpec.normal[2] === 1 ? "z" : null;
    sectionSpec = { normal: sectionSpec.normal, d, label: axis ? `${axis} ${fmt(d)} mm` : `normal ${sectionSpec.normal.map(v => fmt(v, 3)).join(",")} at ${fmt(d)} mm` };
    scheduleSection();
  };
  let sectionFrame = 0;
  const scheduleSection = () => {
    if (sectionFrame) return;
    sectionFrame = requestAnimationFrame(() => { sectionFrame = 0; rebuildSection(); updateClip(); report(); });
  };
  const rebuildSection = () => {
    if (sectionMesh) { scene.remove(sectionMesh); sectionMesh.geometry.dispose(); sectionMesh = null; }
    section = null;
    if (!sectionSpec || !bundle?.tets || !field) { if (showVectors) buildArrows(); engine.requestRender(); return; }
    const n = sectionSpec.normal, len = Math.hypot(...n);
    section = sliceTets(bundle.nodes, bundle.tets, bundle.tetSolid, [n[0] / len, n[1] / len, n[2] / len], sectionSpec.d * 1e-3 / len);
    if (section.triangles) {
      const count = section.weights.length;
      const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), vals = new Float32Array(count), masks = new Float32Array(count).fill(1);
      const m = field.mask ? bundle.blocks[field.mask] as Uint8Array : null;
      const sn = toScene(n[0] / len, n[1] / len, n[2] / len);
      for (let v = 0; v < count; v++) {
        const p = toScene(section.positions[v * 3] * 1e3, section.positions[v * 3 + 1] * 1e3, section.positions[v * 3 + 2] * 1e3);
        positions.set([p.x, p.y, p.z], v * 3);
        normals.set([sn.x, sn.y, sn.z], v * 3);
        const a = section.nodes[v * 2], b = section.nodes[v * 2 + 1], w = section.weights[v];
        vals[v] = (1 - w) * values[a] + w * values[b];
        if (m && (!m[a] || !m[b])) masks[v] = 0;
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(positions, 3));
      g.setAttribute("normal", new BufferAttribute(normals, 3));
      g.setAttribute("aValue", new BufferAttribute(vals, 1));
      g.setAttribute("aMask", new BufferAttribute(masks, 1));
      g.setAttribute("aFace", new BufferAttribute(new Float32Array(count).fill(-1), 1));
      g.setAttribute("aColor", new BufferAttribute(new Float32Array(count * 3).fill(0.5), 3));
      sectionMesh = new Mesh(g, sectionMaterial);
      scene.add(sectionMesh);
    }
    if (showVectors) buildArrows();
    engine.requestRender();
  };
  const updateClip = () => {
    const on = Boolean(sectionSpec);
    if (on) {
      const n = sectionSpec!.normal, len = Math.hypot(...n);
      const sn = toScene(n[0] / len, n[1] / len, n[2] / len);
      const d = sectionSpec!.d / len;
      // Keep n·p ≤ d (the far side of the cut is removed), or the other side when flipped.
      if (flipped) clip.set(sn, -d); else clip.set(sn.clone().negate(), d);
    }
    const planes = on ? [clip] : [];
    surfaceMaterial.clippingPlanes = planes; edgeMaterial.clippingPlanes = planes; meshMaterial.clippingPlanes = planes; arrowMaterial.clippingPlanes = section ? [] : planes;
    for (const m of [surfaceMaterial, edgeMaterial, meshMaterial, arrowMaterial]) m.needsUpdate = true;
    engine.requestRender();
  };

  // ── Probes and picking ─────────────────────────────────────────────────────────────────────────────────────────
  const valuesAt = (nodes: number[], weights: number[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const f of bundle!.header.fields) {
      const data = nodalScalar(f), m = f.mask ? bundle!.blocks[f.mask] as Uint8Array : null;
      if (m && nodes.some(n => !m[n])) continue;
      out[f.id] = nodes.reduce((s, n, k) => s + weights[k] * data[n], 0);
    }
    return out;
  };
  const describeProbe = (point: Vector3, vals: Record<string, number>, method: string, face?: number): ProbeResult => {
    const cad = toCad(point).map(v => fmt(v, 4)).join(", ");
    const main = field && vals[field.id] !== undefined ? `${field.name} ${fmt(shown(vals[field.id]))} ${display(field).unit}` : "";
    return { point, values: vals, method, ...(face ? { face } : {}), text: `${main}${main ? " " : ""}at [${cad}] mm (${method})`.slice(0, 300) };
  };
  const showProbe = (result: ProbeResult | null) => {
    probe = result;
    marker.visible = Boolean(result);
    readout.replaceChildren();
    readout.hidden = !result;
    if (result) {
      marker.position.copy(result.point);
      readout.append(el("div", { className: "title", text: "Probe" }), el("div", { className: "kind mono", text: `[${toCad(result.point).map(v => fmt(v, 4)).join(", ")}] mm` }),
        el("dl", {}, bundle!.header.fields.flatMap(f => (result.values[f.id] === undefined ? [] : [el("dt", { text: f.name }), el("dd", { text: `${fmt(shown(result.values[f.id], f))} ${display(f).unit}` })]))),
        el("div", { className: "kind", text: result.method }),
        ...(result.face ? [el("div", { className: "kind", text: bundle!.header.faces.find(f => f.index === result.face)?.label ?? `face ${result.face}` })] : []),
        el("div", { className: "row" }, [button("Clear", "Remove the probe", () => { showProbe(null); report(); })]));
    }
    report(); engine.requestRender();
  };
  const refreshProbe = () => { if (probe) showProbe(describeProbe(probe.point, probe.values, probe.method, probe.face)); };
  const probeExtreme = (which: "max" | "min"): CommandResult => {
    if (!bundle || !field) return { ok: false, problem: "no field is shown" };
    const at = which === "max" ? field.maxAt : field.minAt;
    const p = toScene(at[0], at[1], at[2]);
    // The extreme is a nodal value: read every field at that node.
    let node = 0, best = Infinity;
    for (let i = 0; i < nodesMm.length / 3; i++) { const d = (nodesMm[i * 3] - at[0]) ** 2 + (nodesMm[i * 3 + 1] - at[1]) ** 2 + (nodesMm[i * 3 + 2] - at[2]) ** 2; if (d < best) { best = d; node = i; } }
    showProbe(describeProbe(p, valuesAt([node], [1]), `nodal ${which === "max" ? "maximum" : "minimum"} of ${field.name.toLowerCase()}`));
    return { ok: true };
  };
  const probePoint = (cad: [number, number, number]): CommandResult => {
    if (!bundle || mode !== "results") return { ok: false, problem: "no result is shown" };
    if (!bundle.tets) return { ok: false, problem: "this result carries no interior elements, so the card cannot probe inside (simulate results with probe can)" };
    const found = locate(nodesMm, bundle.tets, cad);
    if (!found) return { ok: false, problem: `[${cad.join(", ")}] mm is outside the solids` };
    showProbe(describeProbe(toScene(...cad), valuesAt(found.nodes, found.weights), "linear interpolation inside the containing tetrahedron"));
    return { ok: true };
  };

  const pickAt = (clientX: number, clientY: number): Intersection | null => {
    const rect = engine.canvas.getBoundingClientRect();
    raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    const targets = [surfaceMesh, sectionMesh].filter(Boolean) as Mesh[];
    for (const hit of raycaster.intersectObjects(targets, false)) {
      if (hit.object === surfaceMesh && sectionSpec && clip.distanceToPoint(hit.point) < 0) continue;
      return hit;
    }
    return null;
  };
  const onPick = (hit: Intersection) => {
    if (!bundle || !surface) return;
    const tri = hit.face!;
    const geometry = (hit.object as Mesh).geometry;
    const pos = geometry.getAttribute("position") as BufferAttribute;
    const A = new Vector3().fromBufferAttribute(pos, tri.a), B = new Vector3().fromBufferAttribute(pos, tri.b), C = new Vector3().fromBufferAttribute(pos, tri.c);
    const bary = Triangle.getBarycoord(hit.point, A, B, C, new Vector3());
    if (!bary) return;
    if (hit.object === surfaceMesh) {
      const face = surface.faceOf[tri.a];
      selectFace(face);
      if (mode === "results") showProbe(describeProbe(hit.point.clone(), valuesAt([surface.nodeOf[tri.a], surface.nodeOf[tri.b], surface.nodeOf[tri.c]], [bary.x, bary.y, bary.z]), "linear interpolation on the surface triangle", face));
    } else if (section) {
      const nodes: number[] = [], weights: number[] = [];
      [tri.a, tri.b, tri.c].forEach((v, k) => {
        const w = section!.weights[v], bk = [bary.x, bary.y, bary.z][k];
        nodes.push(section!.nodes[v * 2], section!.nodes[v * 2 + 1]);
        weights.push(bk * (1 - w), bk * w);
      });
      showProbe(describeProbe(hit.point.clone(), valuesAt(nodes, weights), "linear interpolation inside the tetrahedron (section)"));
    }
  };
  let outline: LineSegments | null = null;
  const outlineMaterial = new LineBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.95 });
  engine.addDisposer(() => outlineMaterial.dispose());
  /** The picked face's boundary (edges used by one of its triangles only), drawn over everything. */
  const drawOutline = (face: number) => {
    if (outline) { scene.remove(outline); outline.geometry.dispose(); outline = null; }
    if (!face || !surface) return;
    const index = surface.geometry.getIndex()!, pos = surface.geometry.getAttribute("position") as BufferAttribute;
    const count = new Map<string, [number, number]>();
    for (let t = 0; t < index.count; t += 3) {
      if (surface.faceOf[index.getX(t)] !== face) continue;
      for (let k = 0; k < 3; k++) {
        const a = index.getX(t + k), b = index.getX(t + (k + 1) % 3);
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (count.has(key)) count.delete(key); else count.set(key, [a, b]);
      }
    }
    const lines: number[] = [];
    for (const [a, b] of count.values()) lines.push(pos.getX(a), pos.getY(a), pos.getZ(a), pos.getX(b), pos.getY(b), pos.getZ(b));
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(Float32Array.from(lines), 3));
    outline = new LineSegments(g, outlineMaterial);
    outline.renderOrder = 6;
    scene.add(outline);
  };
  const selectFace = (face: number, emit = true) => {
    selectedFace = face;
    surfaceMaterial.uniforms.uSelected.value = face;
    drawOutline(mode === "results" ? face : 0);
    if (mode === "setup") drawLegend();
    if (emit && bundle) {
      const f = bundle.header.faces.find(x => x.index === face);
      ctx.emit.selection(f ? {
        objectId: `F${face}`, name: `Face ${face}`, kind: "Face",
        properties: { Body: f.body, Description: f.label, ...(f.area_mm2 !== undefined ? { "Area (mm²)": Number(f.area_mm2.toPrecision(5)) } : {}), ...(f.condition ? { Conditions: f.condition } : { Conditions: "none (insulated / adiabatic)" }) },
      } : { objectId: null });
    }
    report(); engine.requestRender();
  };

  let down: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const onUp = (event: PointerEvent) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || !bundle) { down = null; return; }
    down = null;
    const hit = pickAt(event.clientX, event.clientY);
    if (hit) onPick(hit); else { selectFace(0); if (probe) showProbe(null); }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { if (selectedFace || probe) { selectFace(0); showProbe(null); } else ctx.emit.interaction("escape"); }
    if ((event.key === "f" || event.key === "F") && document.activeElement === engine.canvas) fit();
  };
  engine.canvas.addEventListener("pointerdown", onDown);
  engine.canvas.addEventListener("pointerup", onUp);
  addEventListener("keydown", onKey);
  engine.addDisposer(() => { engine.canvas.removeEventListener("pointerdown", onDown); engine.canvas.removeEventListener("pointerup", onUp); removeEventListener("keydown", onKey); if (sectionFrame) cancelAnimationFrame(sectionFrame); });
  engine.controls.addEventListener("start", () => { if (view !== "custom") { view = "custom"; report(); } ctx.emit.interaction("pointer-down"); });
  engine.controls.addEventListener("end", () => ctx.emit.interaction("pointer-up"));

  // ── Camera ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const modelBox = () => (surface ? new Box3().setFromBufferAttribute(surface.geometry.getAttribute("position") as BufferAttribute) : new Box3());
  const setView = (next: Exclude<View, "custom">, seconds = 1) => {
    view = next;
    const box = modelBox();
    if (box.isEmpty()) return;
    const framing = engine.framing(box, DIRECTIONS[next]);
    engine.flyTo(framing.position, framing.target, seconds);
    report();
  };
  const fit = () => {
    const box = modelBox();
    if (box.isEmpty()) return false;
    const direction = camera.position.clone().sub(engine.controls.target);
    const framing = engine.framing(box, direction.lengthSq() ? direction : DIRECTIONS.iso);
    engine.flyTo(framing.position, framing.target, 0.9);
    return true;
  };

  // ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────
  let pending: ReturnType<typeof setTimeout> | null = null;
  const report = () => { pending ??= setTimeout(flush, 80); };
  const flush = () => {
    pending = null;
    const d = display(field);
    ctx.emit.state({
      mode, ...(loadedKey ? { loaded: loadedKey } : {}), ...(bundle ? { study: bundle.header.study.id, run: bundle.header.study.run ?? 0, triangles: bundle.header.counts.triangles, interior: Boolean(bundle.tets) } : {}),
      ...(field ? { field: field.id, unit: d.unit, range: `${fmt(shown(range[0]))} … ${fmt(shown(range[1]))} ${d.unit}`.trim() } : {}),
      fields: bundle ? bundle.header.fields.map(f => f.id) : [], colormap, autoRange, bands, mesh: showMesh, edges: showEdges, vectors: showVectors,
      section: sectionSpec ? `${sectionSpec.label}${flipped ? " (flipped)" : ""}` : "off", ...(probe ? { probe: probe.text } : {}),
      ...(selectedFace ? { selected: `F${selectedFace}` } : {}), view,
    });
  };

  const parsePoint = (text: string): [number, number, number] | null => {
    const parts = text.split(/[\s,;]+/).filter(Boolean).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : null;
  };
  const commands: Record<string, (value: CardValue | undefined) => CommandResult> = {
    "set-field": value => setField(String(value)),
    "set-colormap": value => setColormap(value as ColormapId),
    "set-range": value => {
      if (!field) return { ok: false, problem: "no field is shown" };
      if (String(value).trim() === "auto") { setAuto(); return { ok: true }; }
      const parts = String(value).split(/[,;…]|\.\.\.?/).map(s => Number(s.trim()));
      if (parts.length !== 2 || !parts.every(Number.isFinite) || !(parts[1] > parts[0])) return { ok: false, problem: "give \"auto\" or \"min,max\" (in the legend's unit)" };
      minInput.value = String(parts[0]); maxInput.value = String(parts[1]);
      applyManualRange();
      return { ok: true };
    },
    bands: value => setBands(value as boolean),
    "show-mesh": value => setMesh(value as boolean),
    "show-edges": value => setEdges(value as boolean),
    "show-vectors": value => setVectors(value as boolean),
    section: value => {
      const text = String(value).trim().toLowerCase();
      if (text === "off") return setSection(null);
      const axis = /^([xyz])\s+(-?[\d.]+(?:e[-+]?\d+)?)$/.exec(text);
      if (axis) return setAxisSection(axis[1] as "x" | "y" | "z", Number(axis[2]));
      const general = /^normal\s+([-\d.,\s e+]+?)\s+at\s+([-\d.,\s e+]+)$/.exec(text);
      if (general) {
        const n = parsePoint(general[1]), p = parsePoint(general[2]);
        if (!n || !p || !Math.hypot(...n)) return { ok: false, problem: "give \"normal nx,ny,nz at x,y,z\"" };
        const len = Math.hypot(...n);
        const unit: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
        const d = unit[0] * p[0] + unit[1] * p[1] + unit[2] * p[2];
        return setSection({ normal: unit, d, label: `normal ${unit.map(v => fmt(v, 3)).join(",")} at ${p.map(v => fmt(v, 4)).join(",")} mm` });
      }
      return { ok: false, problem: "give \"off\", \"x 12.5\" (mm) or \"normal nx,ny,nz at x,y,z\"" };
    },
    probe: value => {
      const text = String(value).trim().toLowerCase();
      if (text === "max" || text === "min") return probeExtreme(text);
      const p = parsePoint(text);
      return p ? probePoint(p) : { ok: false, problem: "give \"max\", \"min\" or \"x,y,z\" in mm" };
    },
    "clear-probe": () => { showProbe(null); return { ok: true }; },
    select: value => {
      const face = /^F(\d+)$/i.exec(String(value));
      if (!face || !bundle?.header.faces.some(f => f.index === Number(face[1]))) return { ok: false, problem: `no face ${value}` };
      selectFace(Number(face[1]));
      return { ok: true };
    },
    "clear-selection": () => { selectFace(0); return { ok: true }; },
    "set-view": value => { if (!bundle) return { ok: false, problem: "nothing is shown" }; setView(value as Exclude<View, "custom">); return { ok: true }; },
    fit: () => (fit() ? { ok: true } : { ok: false, problem: "nothing to fit" }),
    "reset-camera": () => { setView("iso"); return { ok: true }; },
    status: value => { setProgress(value === "ready" ? "" : String(value)); return { ok: true }; },
  };

  return {
    start() { mapSelect.value = colormap; fieldGroup.hidden = sectionGroup.hidden = true; vectorsButton.hidden = meshButton.hidden = maxButton.hidden = minButton.hidden = true; engine.requestRender(); report(); },
    async loadAsset(asset, data) {
      if (asset.kind !== "field") throw new Error("model-unsupported");
      ctx.emit.loading("Reading the result", 0.3);
      try { load(data); } catch (error) {
        empty.textContent = bundle ? "" : "The simulation result could not be shown.";
        empty.hidden = Boolean(bundle);
        ctx.emit.error("model-invalid", `The simulation result is invalid: ${error instanceof Error ? error.message : "unknown"}`.slice(0, 200), false);
        throw new Error("model-invalid");
      }
    },
    command(name, value) {
      const run = commands[name];
      return run ? run(value) : { ok: false, problem: `unknown command ${name}` };
    },
    flush() { if (pending) { clearTimeout(pending); flush(); } },
    setCamera(next) {
      if (next && next in DIRECTIONS) { setView(next as Exclude<View, "custom">); return { ok: true }; }
      return { ok: false, problem: "unknown view" };
    },
    pause() { /* nothing animates */ },
    resume() { engine.requestRender(); },
    suspend(on) { engine.setSuspended(on); },
    reset() { setSection(null, false); showProbe(null); selectFace(0, false); setColormap("rainbow"); setBands(false); if (field) setAuto(); setView("iso"); },
    resize() { engine.resize(); },
    status: () => engine.status(),
    dispose() {
      if (pending) clearTimeout(pending);
      unload();
      const left = engine.dispose();
      return { ...left, urls: 0 };
    },
  };
}
