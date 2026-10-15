import {
  AdditiveBlending, AmbientLight, BackSide, Box3, BufferGeometry, CanvasTexture, CircleGeometry, Color, ConeGeometry, DirectionalLight, DoubleSide, Float32BufferAttribute, Group, Line,
  LineBasicMaterial, LineDashedMaterial, LineLoop, Mesh, MeshBasicMaterial, MeshPhongMaterial, MeshStandardMaterial, Points, PointsMaterial, RingGeometry,
  ShaderMaterial, SphereGeometry, SRGBColorSpace, Vector3, type Texture,
} from "three";
import { ViewerEngine } from "../../runtime/engine";
import { button, el, toggle, type CardApp, type CardContext, type CommandResult } from "../../runtime/app";
import type { CardValue } from "../../values";
import {
  ASTRONOMY, BODY_FACTS, degrees, distanceFor, earthAxis, earthRotation, MOON_RADIUS, moonPosition, moonRotation, nearSideFacesEarth, orbitAngle, orbitNormal, sunAngle, type DisplayScale,
} from "./model";
import { cloudTexture, earthTextures, moonTextures, type Pixels } from "./textures";

/**
 * The Earth–Moon card (v0.4.5). A live Three.js scene of the model in model.ts: Earth turning under its tilted axis, the
 * Moon on its inclined orbit turning once per orbit, sunlight from a slowly turning direction. The user turns, zooms and
 * selects; Codex controls it through the manifest's commands. Simulation time and display scale are independent; the
 * card always says when distances are not to scale.
 */
type Focus = "system" | "earth" | "moon";
type View = "overview" | "top" | "edge" | "from-earth" | "custom";
type Selected = "earth" | "moon" | "none";

const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];

export function createEarthMoon(ctx: CardContext): CardApp {
  const engine = new ViewerEngine(ctx.stage, { reducedMotion: ctx.reducedMotion, near: 0.005, far: 20000, fov: 38 });
  const { scene, camera } = engine;
  const accent = new Color(ctx.theme.accent);
  const textures: Texture[] = [];
  const defaults = () => ({
    speed: typeof ctx.config.speed === "number" ? ctx.config.speed : ctx.reducedMotion ? 0.25 : 1,
    focus: (ctx.config.focus as Focus | undefined) ?? "system",
    view: (ctx.config.view as View | undefined) ?? "overview",
    scale: (ctx.config.scale as DisplayScale | undefined) ?? "educational",
    teaching: ctx.config.teaching === true,
    labels: ctx.config.labels !== false,
  });
  const s = {
    day: 0, speed: defaults().speed, running: ctx.config.paused !== true, focus: defaults().focus as Focus, view: defaults().view as View, scale: defaults().scale as DisplayScale,
    selected: "none" as Selected, orbit: true, labels: defaults().labels, orbitalPlane: false, axis: true, teaching: defaults().teaching, noRotation: false,
    suspended: false,
  };

  // ── Scene ──────────────────────────────────────────────────────────────────────────────────────────────────────
  scene.background = new Color("#05070b");
  const sun = new DirectionalLight("#fff6ea", 2.6);
  scene.add(sun, new AmbientLight("#8aa0c0", 0.09));
  const earthPivot = new Group(), earthTilt = new Group();
  const axis = earthAxis();
  earthTilt.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...axis));
  earthPivot.add(earthTilt);
  scene.add(earthPivot);
  const earth = new Mesh(new SphereGeometry(1, 128, 64), new MeshPhongMaterial({ color: "#ffffff", shininess: 22, specular: new Color("#556677") }));
  earth.name = "earth";
  earthTilt.add(earth);
  const clouds = new Mesh(new SphereGeometry(1.008, 96, 48), new MeshPhongMaterial({ color: "#ffffff", transparent: true, depthWrite: false, shininess: 0 }));
  earthTilt.add(clouds);
  const atmosphere = new Mesh(new SphereGeometry(1.045, 64, 32), new ShaderMaterial({
    side: BackSide, blending: AdditiveBlending, transparent: true, depthWrite: false,
    uniforms: { glow: { value: new Color("#5d8fd6") } },
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 p = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-p.xyz); gl_Position = projectionMatrix*p; }",
    fragmentShader: "uniform vec3 glow; varying vec3 vN; varying vec3 vV; void main(){ float r = pow(clamp(1.0 + dot(vN, vV), 0.0, 1.0), 5.0); gl_FragColor = vec4(glow * r * 0.9, r * 0.6); }",
  }));
  earthPivot.add(atmosphere);
  // Earth's rotation axis, through both poles.
  const axisLine = new Line(new BufferGeometry().setFromPoints([new Vector3(0, -1.6, 0), new Vector3(0, 1.6, 0)]), new LineBasicMaterial({ color: "#c9d3dd", transparent: true, opacity: 0.7 }));
  earthTilt.add(axisLine);
  const north = new Mesh(new ConeGeometry(0.035, 0.1, 16), new MeshBasicMaterial({ color: "#c9d3dd" }));
  north.position.y = 1.62;
  axisLine.add(north);

  const orbitFrame = new Group();
  orbitFrame.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...orbitNormal()));
  scene.add(orbitFrame);
  const moonPivot = new Group();
  scene.add(moonPivot);
  const moonSpin = new Group();
  moonSpin.quaternion.copy(orbitFrame.quaternion);
  moonPivot.add(moonSpin);
  const moonTurn = new Group();
  moonSpin.add(moonTurn);
  const moon = new Mesh(new SphereGeometry(MOON_RADIUS, 96, 48), new MeshStandardMaterial({ color: "#ffffff", roughness: 0.98, metalness: 0, bumpScale: 2.2 }));
  moon.name = "moon";
  moonTurn.add(moon);
  // Teaching marks: the near side's marker (on the Moon, turning with it), its line to Earth and a fixed star direction.
  // The near side's marker: a small bright cap at the centre of the hemisphere that faces Earth, and a pointer out of it
  // that turns with the Moon; beside it a fixed pointer toward the same distant stars. The pointers are sized to the orbit,
  // so they read even when the Moon is a few pixels across.
  const marker = new Group();
  const cap = new Mesh(new SphereGeometry(MOON_RADIUS * 1.004, 48, 16, 0, Math.PI * 2, 0, 0.16), new MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85 }));
  cap.rotation.z = -Math.PI / 2;
  const pointer = new Group();
  const pointerLine = new Line(new BufferGeometry().setFromPoints([new Vector3(MOON_RADIUS, 0, 0), new Vector3(1, 0, 0)]), new LineBasicMaterial({ color: accent }));
  const pointerHead = new Mesh(new ConeGeometry(0.045, 0.14, 16), new MeshBasicMaterial({ color: accent }));
  pointerHead.rotation.z = -Math.PI / 2;
  pointerHead.position.x = 1;
  pointer.add(pointerLine, pointerHead);
  marker.add(cap, pointer);
  moonTurn.add(marker);
  const sizePointers = () => {
    const length = Math.max(MOON_RADIUS * 2.2, distanceFor(s.scale) * 0.16);
    (pointerLine.geometry as BufferGeometry).setFromPoints([new Vector3(MOON_RADIUS, 0, 0), new Vector3(length - 0.07, 0, 0)]);
    pointerHead.position.x = length - 0.07;
    pointerHead.scale.setScalar(Math.max(1, length / 2));
    // Toward the same stars the marker points at on day 0: the two coincide for a Moon that does not rotate.
    (starRef.geometry as BufferGeometry).setFromPoints([new Vector3(0, 0, 0), new Vector3(-length, 0, 0)]);
  };
  const toEarth = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]), new LineDashedMaterial({ color: accent, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.8 }));
  scene.add(toEarth);
  const starRef = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(1, 0, 0)]), new LineDashedMaterial({ color: "#9aa7b4", dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.9 }));
  starRef.quaternion.copy(orbitFrame.quaternion);
  moonPivot.add(starRef);

  const orbitLine = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: "#aab6c3", transparent: true, opacity: 0.55 }));
  orbitFrame.add(orbitLine);
  const plane = new Mesh(new CircleGeometry(1, 128), new MeshBasicMaterial({ color: "#8fa4bb", transparent: true, opacity: 0.07, side: DoubleSide, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2;
  orbitFrame.add(plane);
  const planeRim = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: "#8fa4bb", transparent: true, opacity: 0.3 }));
  orbitFrame.add(planeRim);
  const selection = new Mesh(new RingGeometry(1.2, 1.225, 128), new MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.75, side: DoubleSide, depthTest: false }));
  selection.renderOrder = 10;
  selection.visible = false;
  scene.add(selection);
  // Stars: a fixed, seeded field far away (a reference against which the Moon's turning can be seen).
  const stars = (() => {
    let seed = 42;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const points: number[] = [];
    for (let i = 0; i < 2400; i++) {
      const z = rand() * 2 - 1, t = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      points.push(r * Math.cos(t) * 9000, z * 9000, r * Math.sin(t) * 9000);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
    return new Points(geometry, new PointsMaterial({ color: "#c8d2de", size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.75 }));
  })();
  scene.add(stars);

  const setOrbitGeometry = () => {
    const distance = distanceFor(s.scale), points: Vector3[] = [];
    for (let i = 0; i < 360; i++) { const a = i / 360 * Math.PI * 2; points.push(new Vector3(distance * Math.cos(a), 0, -distance * Math.sin(a))); }
    orbitLine.geometry.dispose();
    orbitLine.geometry = new BufferGeometry().setFromPoints(points);
    planeRim.geometry.dispose();
    planeRim.geometry = new BufferGeometry().setFromPoints(points.map(p => p.clone().multiplyScalar(1.12)));
    plane.scale.setScalar(distance * 1.12);
  };
  setOrbitGeometry();
  sizePointers();
  starRef.computeLineDistances();

  // ── Controls and labels (inside the card; text only) ─────────────────────────────────────────────────────────────
  const labels = {
    earth: el("div", { className: "label", text: "Earth" }), moon: el("div", { className: "label", text: "Moon" }), sun: el("div", { className: "label sun", text: "Sunlight →" }),
  };
  const labelLayer = el("div", { className: "labels" }, Object.values(labels));
  const badge = el("div", { className: "badge" });
  const info = el("div", { className: "panel info" });
  info.hidden = true;
  info.setAttribute("aria-live", "polite");
  const caption = el("div", { className: "caption" });
  caption.setAttribute("aria-live", "polite");
  const clock = el("span", { className: "readout" });
  clock.setAttribute("aria-live", "off");
  const focusButtons: Record<Focus, HTMLButtonElement> = {
    system: button("System", "Focus on the whole system", () => focusOn("system")), earth: button("Earth", "Focus on Earth", () => focusOn("earth")), moon: button("Moon", "Focus on the Moon", () => focusOn("moon")),
  };
  const toggles = [
    toggle("Orbit", "Show the Moon's orbit", () => s.orbit, on => { s.orbit = on; apply(); }),
    toggle("Labels", "Show labels", () => s.labels, on => { s.labels = on; apply(); }),
    toggle("Plane", "Show the Moon's orbital plane", () => s.orbitalPlane, on => { s.orbitalPlane = on; apply(); }),
    toggle("Axis", "Show Earth's rotation axis", () => s.axis, on => { s.axis = on; apply(); }),
    toggle("Teach", "Teaching marks: the near side and its line to Earth", () => s.teaching, on => { s.teaching = on; apply(); }),
    toggle("No spin", "Compare: a Moon that does not rotate", () => s.noRotation, on => { s.noRotation = on; apply(); }),
  ];
  const scaleButton = button("", "Switch between educational and true distance", () => { s.scale = s.scale === "educational" ? "true-distance" : "educational"; rescale(); });
  const bar = el("div", { className: "bar" }, [
    el("div", { className: "group" }, [
      button("−", "Slower", () => setSpeed(stepSpeed(-1))), clock, button("+", "Faster", () => setSpeed(stepSpeed(1))),
      button("⟲", "Back to day 0", () => { s.day = 0; changed(); }),
    ]),
    el("div", { className: "group" }, Object.values(focusButtons)),
    el("div", { className: "group wrap" }, [...toggles, scaleButton]),
  ]);
  ctx.ui.append(labelLayer, badge, info, caption, bar);

  const stepSpeed = (direction: number) => {
    const index = SPEEDS.findIndex(v => v >= s.speed - 1e-9);
    const at = index < 0 ? SPEEDS.length - 1 : index;
    return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS[at] === s.speed || direction < 0 ? at + direction : at))];
  };
  const setSpeed = (speed: number) => { s.speed = Math.max(0.01, Math.min(100, speed)); changed(); };

  // ── Camera ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const moonWorld = new Vector3(), lastMoon = new Vector3();
  /** A view that frames the whole orbit from a direction, whatever the card's shape. */
  const frameOrbit = (direction: Vector3): [Vector3, Vector3] => {
    const d = distanceFor(s.scale) * 1.08;
    const box = new Box3(new Vector3(-d, -d * 0.12, -d), new Vector3(d, d * 0.12, d));
    const framing = engine.framing(box, direction, 0.74);
    return [framing.position, framing.target];
  };
  const views: Record<Exclude<View, "custom" | "from-earth">, () => [Vector3, Vector3]> = {
    overview: () => frameOrbit(new Vector3(0.25, 0.55, 1)),
    top: () => frameOrbit(new Vector3(0.0001, 1, 0.0001)),
    edge: () => frameOrbit(new Vector3(0, 0.03, 1)),
  };
  const fromEarth = (): [Vector3, Vector3] => {
    const direction = moonWorld.clone().normalize();
    return [direction.clone().multiplyScalar(1.25).add(new Vector3(0, 0.12, 0)), moonWorld.clone()];
  };
  const setView = (view: View, seconds = 1.4) => {
    s.view = view;
    if (view === "custom") return;
    s.focus = "system";
    const [position, target] = view === "from-earth" ? fromEarth() : views[view]();
    engine.flyTo(position, target, seconds);
    changed();
  };
  const focusOn = (focus: Focus, seconds = 1.4) => {
    s.focus = focus;
    s.view = focus === "system" ? "overview" : "custom";
    if (focus === "system") { setView("overview", seconds); return; }
    const target = focus === "earth" ? new Vector3(0, 0, 0) : moonWorld.clone();
    const radius = focus === "earth" ? 1 : MOON_RADIUS;
    // Seen from the sunlit side and a little above, so the body is lit and its motion is visible.
    const sunDir = new Vector3(Math.cos(sunAngle(s.day)), 0, -Math.sin(sunAngle(s.day)));
    const side = focus === "moon" ? moonWorld.clone().normalize().negate().lerp(sunDir, 0.5).normalize() : sunDir.clone().lerp(new Vector3(0, 0, 1), 0.4).normalize();
    const position = target.clone().add(side.multiplyScalar(radius * (focus === "earth" ? 5.2 : 8.5))).add(new Vector3(0, radius * 1.6, 0));
    engine.flyTo(position, target, seconds);
    lastMoon.copy(moonWorld);
    changed();
  };
  engine.controls.addEventListener("start", () => { if (s.view !== "custom") { s.view = "custom"; changed(); } ctx.emit.interaction("pointer-down"); });
  engine.controls.addEventListener("end", () => ctx.emit.interaction("pointer-up"));
  engine.controls.minDistance = MOON_RADIUS * 1.6;

  // ── Picking ────────────────────────────────────────────────────────────────────────────────────────────────────
  let down: { x: number; y: number } | null = null;
  const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const onUp = (event: PointerEvent) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) { down = null; return; }
    down = null;
    const hit = engine.pick(event.clientX, event.clientY, [earth, moon]);
    select(hit?.object === earth ? "earth" : hit?.object === moon ? "moon" : "none");
  };
  engine.canvas.addEventListener("pointerdown", onDown);
  engine.canvas.addEventListener("pointerup", onUp);
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") ctx.emit.interaction("escape"); };
  addEventListener("keydown", onKey);
  engine.addDisposer(() => { engine.canvas.removeEventListener("pointerdown", onDown); engine.canvas.removeEventListener("pointerup", onUp); removeEventListener("keydown", onKey); });

  const select = (body: Selected) => {
    s.selected = body;
    info.replaceChildren();
    info.hidden = body === "none";
    if (body !== "none") {
      const facts = BODY_FACTS[body];
      info.append(el("div", { className: "title", text: facts.name }), el("div", { className: "kind", text: facts.kind }),
        el("dl", {}, Object.entries(facts.properties).flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])));
    }
    const facts = body === "none" ? null : BODY_FACTS[body];
    const at = body === "none" ? null : engine.screenOf(body === "earth" ? new Vector3() : moonWorld);
    ctx.emit.selection(facts ? { objectId: body, name: facts.name, kind: facts.kind, properties: { ...facts.properties }, ...(at ? { screen: at } : {}) } : { objectId: null });
    changed();
  };

  // ── Each frame ─────────────────────────────────────────────────────────────────────────────────────────────────
  const place = () => {
    const distance = distanceFor(s.scale);
    const p = moonPosition(s.day, distance);
    moonWorld.set(...p);
    moonPivot.position.copy(moonWorld);
    moonTurn.rotation.y = moonRotation(s.day, !s.noRotation);
    earth.rotation.y = earthRotation(s.day);
    clouds.rotation.y = earthRotation(s.day) * 1.002 + s.day * 0.05;
    const a = sunAngle(s.day);
    sun.position.set(Math.cos(a) * 100, 0, -Math.sin(a) * 100);
    (toEarth.geometry.attributes.position as Float32BufferAttribute).setXYZ(0, moonWorld.x, moonWorld.y, moonWorld.z);
    toEarth.geometry.attributes.position.needsUpdate = true;
    toEarth.computeLineDistances();
    // The camera follows a focused Moon (keeping the user's offset) or the view from Earth.
    if (s.focus === "moon") engine.shift(moonWorld.clone().sub(lastMoon));
    if (s.view === "from-earth") { const [position, target] = fromEarth(); camera.position.copy(position); engine.controls.target.copy(target); }
    lastMoon.copy(moonWorld);
    if (s.selected !== "none") {
      const r = s.selected === "earth" ? 1.06 : MOON_RADIUS * 1.12;
      selection.position.copy(s.selected === "earth" ? new Vector3() : moonWorld);
      selection.scale.setScalar(r);
      selection.lookAt(camera.position);
    }
  };
  const project = () => {
    const put = (label: HTMLElement, point: Vector3, dy: number, show: boolean) => {
      const at = show ? engine.screenOf(point) : null;
      label.hidden = !at;
      if (at) label.style.transform = `translate(${(at.x * ctx.stage.clientWidth).toFixed(1)}px, ${(at.y * ctx.stage.clientHeight + dy).toFixed(1)}px) translate(-50%, 0)`;
    };
    const earthPx = camera.position.length();
    put(labels.earth, new Vector3(0, -1.15, 0), 6, s.labels && earthPx < 4000);
    put(labels.moon, moonWorld.clone().add(new Vector3(0, -MOON_RADIUS * 1.3, 0)), 6, s.labels);
    put(labels.sun, sun.position.clone().normalize().multiplyScalar(distanceFor(s.scale) * 1.2), 0, s.labels && s.view !== "from-earth");
  };
  let reportClock = 0;
  engine.onFrame(dt => {
    if (s.running && !s.suspended) {
      s.day += dt * s.speed;
      reportClock += dt;
      if (reportClock > 0.5) { reportClock = 0; changed(false); }
    }
    place();
    project();
    clock.textContent = `Day ${s.day.toFixed(1)} · ${s.speed >= 1 ? s.speed.toFixed(0) : s.speed.toString()} day${s.speed === 1 ? "" : "s"}/s`;
  });

  const apply = () => {
    orbitLine.visible = s.orbit;
    plane.visible = planeRim.visible = s.orbitalPlane;
    axisLine.visible = s.axis;
    labelLayer.hidden = !s.labels;
    marker.visible = toEarth.visible = starRef.visible = s.teaching || s.noRotation;
    toggles.forEach(t => t.sync());
    for (const [focus, b] of Object.entries(focusButtons)) b.setAttribute("aria-pressed", String(s.focus === focus));
    scaleButton.textContent = s.scale === "educational" ? "True distance" : "Educational";
    badge.textContent = s.scale === "educational"
      ? `Not to scale · distance shown ${Math.round(distanceFor("true-distance") / distanceFor("educational"))}× shorter (sizes in proportion)`
      : "True distance · sizes and distance in proportion";
    caption.textContent = s.noRotation
      ? "Hypothetical: a Moon that does not rotate. Its marker keeps pointing at the same stars and turns away from Earth — we would see every side."
      : s.teaching
        ? `The marker turns with the Moon and keeps pointing at Earth; the dashed line points at the same stars all month. The Moon turns once in the ${ASTRONOMY.siderealMonthDays.toFixed(2)} days of one orbit.`
        : "";
    caption.hidden = !caption.textContent;
    selection.visible = s.selected !== "none";
    engine.setContinuous(s.running && !s.suspended);
    engine.requestRender();
  };
  const rescale = () => {
    setOrbitGeometry();
    sizePointers();
    starRef.computeLineDistances();
    engine.controls.maxDistance = distanceFor(s.scale) * 6;
    if (s.focus === "system" && s.view !== "custom") setView(s.view === "from-earth" ? "from-earth" : s.view, 1.2);
    changed();
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    pending = null;
    ctx.emit.state({
      running: s.running, speed: s.speed, day: Math.round(s.day * 100) / 100, orbitDegrees: degrees(orbitAngle(s.day)), moonRotationDegrees: degrees(moonRotation(s.day, !s.noRotation)),
      earthRotationDegrees: degrees(earthRotation(s.day)), focus: s.focus, view: s.view, selected: s.selected, orbit: s.orbit, labels: s.labels, orbitalPlane: s.orbitalPlane,
      axis: s.axis, teaching: s.teaching, noRotation: s.noRotation, scale: s.scale, nearSideFacingEarth: nearSideFacesEarth(s.day, !s.noRotation, 2),
    });
  };
  /** Something meaningful changed: update the scene, and report (soon, coalesced). */
  function changed(refresh = true) {
    if (refresh) apply();
    pending ??= setTimeout(report, 120);
  }

  const toTexture = (pixels: Pixels, srgb = true) => {
    const canvas = document.createElement("canvas");
    canvas.width = pixels.width; canvas.height = pixels.height;
    canvas.getContext("2d")!.putImageData(new ImageData(pixels.data as Uint8ClampedArray<ArrayBuffer>, pixels.width, pixels.height), 0, 0);
    const texture = new CanvasTexture(canvas);
    if (srgb) texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = Math.min(8, engine.renderer.capabilities.getMaxAnisotropy());
    textures.push(texture);
    return texture;
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));

  const commands: Record<string, (value: CardValue | undefined) => CommandResult> = {
    "set-time-speed": value => { setSpeed(value as number); return { ok: true }; },
    "set-time": value => { s.day = value as number; changed(); return { ok: true }; },
    "reset-time": () => { s.day = 0; changed(); return { ok: true }; },
    focus: value => { focusOn(value as Focus); return { ok: true }; },
    "set-view": value => { setView(value as View); return { ok: true }; },
    "reset-camera": () => { setView("overview"); return { ok: true }; },
    select: value => { select(value as Selected); return { ok: true }; },
    "show-orbit": value => { s.orbit = value as boolean; changed(); return { ok: true }; },
    "show-labels": value => { s.labels = value as boolean; changed(); return { ok: true }; },
    "show-orbital-plane": value => { s.orbitalPlane = value as boolean; changed(); return { ok: true }; },
    "show-axis": value => { s.axis = value as boolean; changed(); return { ok: true }; },
    "show-teaching": value => { s.teaching = value as boolean; changed(); return { ok: true }; },
    "compare-no-rotation": value => { s.noRotation = value as boolean; changed(); return { ok: true }; },
    "set-scale": value => { s.scale = value as DisplayScale; rescale(); return { ok: true }; },
  };

  return {
    async start() {
      ctx.emit.loading("Painting Earth", 0.1);
      await pause();
      const e = earthTextures();
      (earth.material as MeshPhongMaterial).map = toTexture(e.color);
      (earth.material as MeshPhongMaterial).specularMap = toTexture(e.specular, false);
      ctx.emit.loading("Forming clouds", 0.5);
      await pause();
      const c = cloudTexture();
      (clouds.material as MeshPhongMaterial).map = toTexture(c);
      ctx.emit.loading("Shaping the Moon", 0.7);
      await pause();
      const m = moonTextures();
      (moon.material as MeshStandardMaterial).map = toTexture(m.color);
      (moon.material as MeshStandardMaterial).bumpMap = toTexture(m.bump, false);
      for (const material of [earth.material, clouds.material, moon.material]) (material as MeshPhongMaterial).needsUpdate = true;
      if (ctx.state) this.setState!(ctx.state);
      engine.controls.maxDistance = distanceFor(s.scale) * 6;
      place();
      if (s.focus !== "system") focusOn(s.focus, 0); else setView(s.view === "custom" ? "overview" : s.view, 0);
      ctx.emit.loading("Ready", 1);
      apply();
      report();
    },
    command(name, value) {
      const run = commands[name];
      return run ? run(value) : { ok: false, problem: `unknown command ${name}` };
    },
    flush() { if (pending) { clearTimeout(pending); report(); } },
    setState(state) {
      if (typeof state.day === "number") s.day = state.day;
      if (typeof state.speed === "number" && state.speed > 0) s.speed = state.speed;
      if (typeof state.running === "boolean") s.running = state.running;
      for (const key of ["orbit", "labels", "orbitalPlane", "axis", "teaching", "noRotation"] as const) if (typeof state[key] === "boolean") s[key] = state[key] as boolean;
      if (state.scale === "educational" || state.scale === "true-distance") { s.scale = state.scale; setOrbitGeometry(); }
      if (state.focus === "earth" || state.focus === "moon" || state.focus === "system") s.focus = state.focus;
      if (state.selected === "earth" || state.selected === "moon") s.selected = state.selected;
      apply();
    },
    setCamera(view, focus) {
      if (focus === "earth" || focus === "moon" || focus === "system") { focusOn(focus); return { ok: true }; }
      if (view === "overview" || view === "top" || view === "edge" || view === "from-earth") { setView(view); return { ok: true }; }
      return { ok: false, problem: "unknown view" };
    },
    pause() { s.running = false; changed(); },
    resume() { s.running = true; changed(); },
    suspend(on) { s.suspended = on; engine.setSuspended(on); if (!on) apply(); },
    reset() {
      const d = defaults();
      Object.assign(s, { day: 0, speed: d.speed, scale: d.scale, teaching: d.teaching, labels: d.labels, orbit: true, orbitalPlane: false, axis: true, noRotation: false });
      setOrbitGeometry();
      select("none");
      focusOn(d.focus === "system" ? "system" : d.focus, 1);
      changed();
    },
    resize() { engine.resize(); },
    status: () => engine.status(),
    dispose() {
      if (pending) clearTimeout(pending);
      for (const texture of textures) texture.dispose();
      const left = engine.dispose();
      return { ...left, urls: 0 };
    },
  };
}
