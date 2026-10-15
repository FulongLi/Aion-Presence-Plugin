import { createFigureLayout, figurePoint } from "../../core/figure/layout";
import { createEyesLayout, eyesPoint } from "../../core/eyes/layout";
import { createTargetPoints } from "../../visual/points";
import { particleDefaults } from "../particleDefaults";
import { formedPoint } from "../physics/morph";
import { createSphere } from "../sphere/createSphere";
import type { QualityReport, RuntimeHandle, RuntimeInputs, RuntimeOptions } from "../ParticleRuntime";
import { PaletteEase } from "../palette";
import { SILVER_PALETTE } from "../../core/colors";
import { RING_STAGGER, ringHash, ringParams, ringPoint, sphereAudioOffset, type RingPoint } from "../ring";
import { NO_WRITING, writingLight, writingPoint, writingSize } from "../writing";

/**
 * The fallback body for browsers or embedded hosts without WebGPU: the same particles (the same sphere
 * sampling, the same figure layout and pose, the same visual targets and morph timing) drawn on a 2D
 * canvas from the CPU reference of each GPU expression, at a lower density. It keeps the identity of the
 * Presence where the full renderer cannot run; it is not a second look.
 */
export const fallbackDefaults = { count: 4_000, coarseCount: 2_500, pixelRatio: 1.5, size: 1.4, levels: 10 };

const smooth = (w: number) => { const x = Math.max(0, Math.min(1, w)); return x * x * (3 - 2 * x); };
const hash = (x: number, y: number, z: number, a: number, b: number, c: number, k: number) => {
  const v = Math.sin(x * a + y * b + z * c) * k;
  return v - Math.floor(v);
};

export function createCanvasRuntime(container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, options: RuntimeOptions = {}): RuntimeHandle {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas-unavailable");
  container.append(canvas);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const count = coarse ? fallbackDefaults.coarseCount : fallbackDefaults.count;
  const radius = particleDefaults.geometry.radius;
  const sphere = createSphere(count, radius);
  const layout = createFigureLayout(count), eyesLayout = createEyesLayout(count);
  // Per-particle stagger, as in the GPU morph and body weights (physics/morph.ts).
  const morphStagger = new Float32Array(count), bodyStagger = new Float32Array(count), eyesStagger = new Float32Array(count), ringStagger = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [sphere.positions[i * 3], sphere.positions[i * 3 + 1], sphere.positions[i * 3 + 2]];
    morphStagger[i] = hash(x, y, z, 12.9898, 78.233, 37.719, 43758.5453);
    bodyStagger[i] = hash(x, y, z, 41.3, 17.9, 63.1, 24634.6345);
    eyesStagger[i] = hash(x, y, z, 23.7, 59.3, 11.9, 31871.2297);
    ringStagger[i] = ringHash(x, y, z, ...RING_STAGGER);
  }
  let target: { positions: Float32Array; tones: Float32Array; keys?: Float32Array } | null = null;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const calm = () => options.reducedMotion !== false && reducedMotion.matches;
  let centre = { x: 0, y: 0, zoom: 1 };
  let width = 1, height = 1, scale = 1, frame = 0, frames = 0, last = performance.now(), clock = 0, revision = -1, spin = 0, frameMs = 16.7, stopped = false;
  const xs = new Float32Array(count), ys = new Float32Array(count), light = new Float32Array(count), sizes = new Float32Array(count).fill(1);
  const palette = new PaletteEase();
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, fallbackDefaults.pixelRatio);
    width = Math.max(1, container.clientWidth); height = Math.max(1, container.clientHeight);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    scale = Math.min(width, height) / 4.6;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const draw = (dt: number, now: number) => {
    const motion = calm() ? 0.15 : 1;
    clock += dt * motion;
    const presence = inputs.presence.sample(dt, now);
    const morph = inputs.morph.sample(dt);
    if (revision !== inputs.morph.revision) {
      revision = inputs.morph.revision; spin = 0;
      try { target = inputs.morph.target ? createTargetPoints(inputs.morph.target.visual, count) : null; } catch { target = null; }
    }
    const turn = inputs.morph.target?.motion?.spin ?? 0;
    const view = inputs.orbit?.sample(dt) ?? { yaw: 0, pitch: 0, zoom: 1, depth: 0 };
    const formedView = view.depth ? { angle: spin, yaw: view.yaw, pitch: view.pitch, zoom: view.zoom } : { angle: spin, yaw: 0, pitch: 0, zoom: 1 };
    if (morph > 0 && turn) spin = (spin + turn * dt * motion) % (Math.PI * 2);
    const body = inputs.body.sample(dt, now, calm());
    const framing = inputs.framing?.sample(dt) ?? { x: 0, y: 0, scale: 1 };
    const centreX = width / 2 + framing.x * width, centreY = height / 2 - framing.y * height, zoom = scale * framing.scale;
    centre = { x: centreX, y: centreY, zoom };
    const cycle = clock * particleDefaults.idle.frequency;
    const breath = particleDefaults.idle.breathing * (1 - presence.focus * particleDefaults.listening.breath - presence.responding * particleDefaults.responding.breath);
    const { listening, responding } = particleDefaults;
    const gather = presence.focus * listening.contraction + presence.acousticFocus * particleDefaults.focus.contraction + presence.userAmplitude * listening.response;
    const swirl = presence.thinking * 0.08;
    const warm = presence.warmth * 0.28;
    // Sound (v0.4.2): the sphere's audio field and the circular spectrum, from the CPU reference (render/ring.ts).
    const sound = inputs.audio?.sample(dt);
    const audio = sound ? { bands: sound.bands, bass: sound.bass, mid: sound.mid, treble: sound.treble, beat: sound.beat, gain: sound.gain * (calm() ? 0.3 : 1), level: sound.level, weight: sound.sphere } : null;
    const ring = sound ? ringParams(sound.layout) : null;
    if (ring && calm()) ring.flow *= 0.2;
    const point: RingPoint = { position: [0, 0, 0], energy: 0, core: false };
    const writing = inputs.writing?.sample(dt) ?? NO_WRITING;
    const colors = palette.sample(dt);
    const base = colors.cool.map((value, k) => (value + (colors.warm[k] - value) * warm) * 255);
    // Formed visuals take the palette's formed tint relative to its body colour (Aion Silver: unchanged from v0.4).
    const formedTint = colors.formed.map((value, k) => value / Math.max(1e-3, colors.cool[k]) / (SILVER_PALETTE.formed[k] / SILVER_PALETTE.cool[k]));
    for (let i = 0; i < count; i++) {
      const rx = sphere.positions[i * 3], ry = sphere.positions[i * 3 + 1], rz = sphere.positions[i * 3 + 2];
      // The sphere's own field, reduced to its readable parts: travelling breath, gathering, a thinking swirl.
      const r = Math.hypot(rx, ry, rz);
      const rise = Math.sin(clock * responding.speed - ry * 1.2) * 0.5 + 0.5;
      const crossing = Math.sin(clock * responding.speed * 0.61 + rx * 1.4 + 1.7) * 0.5 + 0.5;
      const outer = 0.3 + 0.7 * smooth((r - 0.4) / 0.95);
      const swell = (rise * 0.65 + crossing * 0.35) * outer * presence.responding * responding.swell;
      const ripple = Math.sin(r * 9 + clock * 6.5) * presence.userAmplitude * listening.ripple;
      const b = (Math.sin(cycle + ry * 0.65 + rx * 0.25) + Math.sin(cycle * 1.71 + rz) * 0.22) * breath - gather + (swell + ripple) / radius;
      const s = (Math.sin(clock * 0.9 + ry * 1.4) * swirl + Math.sin(clock * 0.7 + ry * 1.6) * presence.responding * responding.flow) * motion;
      let x = rx * (1 + b) + rz * s, y = ry * (1 + b), z = rz * (1 + b) - rx * s;
      let tone = 0.62 + 0.3 * (rz / radius) + (presence.focus + presence.userAmplitude) * listening.glow + rise * presence.responding * responding.glow;
      const rw = sound && sound.ring > 0 ? smooth(sound.ring * 1.35 - ringStagger[i] * 0.35) : 0;
      if (audio && audio.weight > 0 && rw < 1) {
        const [ox, oy, oz] = sphereAudioOffset([rx, ry, rz], audio, clock);
        x += ox * (1 - rw); y += oy * (1 - rw); z += oz * (1 - rw);
        tone += (audio.level * 0.12 + audio.beat * 0.1) * audio.weight * Math.min(1.3, audio.gain);
      }
      const bw = body.level > 0 ? smooth(body.level * 1.35 - bodyStagger[i] * 0.35) : 0;
      if (bw > 0) {
        const f = figurePoint(layout, i, body.anchors, { clock, orbit: body.orbit, thinking: presence.thinking });
        x += (f.position[0] - x) * bw; y += (f.position[1] - y) * bw; z += (f.position[2] - z) * bw;
        tone += (Math.min(1, f.tone * 1.25) - tone) * bw;
      }
      const ew = body.eyes > 0 ? smooth(body.eyes * 1.35 - eyesStagger[i] * 0.35) : 0;
      let grain = 1;
      if (ew > 0) {
        const e = eyesPoint(eyesLayout, i, body.eyeParams, clock);
        x += (e.position[0] - x) * ew; y += (e.position[1] - y) * ew; z += (e.position[2] - z) * ew;
        tone += (Math.min(1, e.tone * 1.25) - tone) * ew;
        // The eyes' fill grains are larger (fewer particles here than on the GPU, so a little larger still).
        grain += (e.grain * 1.6 - 1) * ew;
      }
      if (rw > 0 && audio && ring) {
        ringPoint([rx, ry, rz], ring, audio, clock, point);
        x += (point.position[0] - x) * rw; y += (point.position[1] - y) * rw; z += (point.position[2] - z) * rw;
        tone += ((0.62 + point.energy * 0.95 + audio.beat * 0.12) * (point.core ? 0.85 : 1) - tone) * rw;
        grain += (0.86 - grain) * rw;
      }
      const mw = morph > 0 && target ? smooth(morph * 1.3 - morphStagger[i] * 0.3) : 0;
      let written = 1;
      if (mw > 0 && target) {
        // Writing (v0.4.3): the pen's grains ride the tip; strokes are lit as they are written (render/writing.ts).
        const key = target.keys ? target.keys[i] : -1;
        const [wx, wy, wz] = writingPoint(target.positions[i * 3], target.positions[i * 3 + 1], target.positions[i * 3 + 2], key, writing);
        const [tx, ty, tz] = formedPoint(wx, wy, wz, formedView);
        x += (tx - x) * mw; y += (ty - y) * mw; z += (tz - z) * mw;
        // A 3D object is lit by depth (nearer is brighter), as on the GPU.
        const near = view.depth ? 0.5 + 0.62 * smooth((tz + 1.9) / 3.8) : 1;
        tone += (target.tones[i] * 0.95 * near * writingLight(key, writing) - tone) * mw;
        written = 1 + (writingSize(key, writing) - 1) * mw;
      }
      const perspective = 7.4 / (7.4 - z);
      xs[i] = centreX + x * zoom * perspective;
      ys[i] = centreY - y * zoom * perspective;
      light[i] = Math.max(0, Math.min(1, tone));
      sizes[i] = (grain + (1 - grain) * mw) * written;
    }
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = "lighter";
    const size = fallbackDefaults.size;
    // Particles are batched by brightness so each level is one fill.
    const tint = base.map((value, k) => value * (1 + (formedTint[k] - 1) * morph));
    for (let level = 1; level <= fallbackDefaults.levels; level++) {
      const lo = (level - 1) / fallbackDefaults.levels, hi = level / fallbackDefaults.levels;
      const [r, g, bl] = tint.map(value => Math.min(255, Math.round(value * (0.35 + hi * 0.75))));
      context.fillStyle = `rgba(${r}, ${g}, ${bl}, ${(0.25 + hi * 0.6).toFixed(3)})`;
      context.beginPath();
      for (let i = 0; i < count; i++) if (light[i] > lo && light[i] <= hi) { const d = size * sizes[i]; context.rect(xs[i] - d / 2, ys[i] - d / 2, d, d); }
      context.fill();
    }
    context.globalCompositeOperation = "source-over";
    frames++;
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.remove();
    lifetime.removeEventListener("abort", cleanup);
  };
  lifetime.addEventListener("abort", cleanup, { once: true });
  let minFrameMs = 0;
  const animate = (now: number) => {
    if (stopped) return;
    if (minFrameMs && now - last < minFrameMs - 2) { frame = requestAnimationFrame(animate); return; }
    const raw = (now - last) / 1000;
    last = now;
    if (raw > 0 && raw < 0.15) frameMs += (raw * 1000 - frameMs) * 0.05;
    if (!document.hidden) draw(Math.min(Math.max(raw, 0), 0.1), now / 1000);
    frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  const report = (): QualityReport => ({ tier: 0, ceiling: 0, count, effects: false, frameMs, frames });
  const toWorld = (clientX: number, clientY: number): [number, number] | null => {
    const bounds = canvas.getBoundingClientRect();
    return bounds.width > 0 ? [(clientX - bounds.left - centre.x) / centre.zoom, (centre.y - (clientY - bounds.top)) / centre.zoom] : null;
  };
  const project = ([x, y, z]: [number, number, number]): [number, number] | null => {
    const bounds = canvas.getBoundingClientRect();
    if (!(bounds.width > 0) || z >= 7.4) return null;
    const perspective = 7.4 / (7.4 - z);
    return [bounds.left + centre.x + x * centre.zoom * perspective, bounds.top + centre.y - y * centre.zoom * perspective];
  };
  const setPalette = (next: Parameters<RuntimeHandle["setPalette"]>[0], immediate?: boolean) => { palette.set(next); if (immediate) palette.settle(); };
  const setFrameCap = (fps: number | null) => { minFrameMs = fps && fps > 0 ? 1000 / fps : 0; };
  return { backend: "canvas", config: particleDefaults, tuning: false, quality: report, setTier: () => {}, toWorld, project, setPalette, setFrameCap, dispose: cleanup };
}
