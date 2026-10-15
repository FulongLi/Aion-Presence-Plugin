import { GROUND, STAGE, type ObjectFrame } from "../animation/scene/sequence";
import { FIGURE_SCALE } from "../core/figure/skeleton";
import { hexToRgb, type Rgb } from "../core/colors";

/**
 * The objects of an action sequence (v0.4.3) — a box, a ball, a diagram panel — and a faint ground line, drawn as small
 * glowing grains over the particle body, like map markers: at the screen position the renderer's own projection gives
 * each grain, every frame, so they stand exactly where the figure reaches, jumps and lifts. The figure itself is Aion's
 * particle body; these are its props. Grains are laid out once per shape (deterministic) and only moved per frame.
 */
export interface SceneLayerSources {
  /** The objects at this moment and how visible the stage is (0…1), or null when nothing performs. */
  frame(): { objects: readonly ObjectFrame[]; visible: number } | null;
  project(point: [number, number, number]): [number, number] | null;
  /** Aion's base colour (the props are drawn in it) and its accent (a panel's mark). */
  colors(): { base: string; accent: string };
}

const random = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

/** Grain layouts in unit coordinates: outline grains (bright) and fill grains (dim), with a twinkle phase each. */
interface Grain { x: number; y: number; light: number; phase: number }
function outline(points: [number, number][], spacing: number, light: number, next: () => number): Grain[] {
  const out: Grain[] = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i], n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / spacing));
    for (let k = 0; k < n; k++) out.push({ x: ax + (bx - ax) * (k + next() * 0.3) / n, y: ay + (by - ay) * (k + next() * 0.3) / n, light, phase: next() * 7 });
  }
  return out;
}
const SHAPES = (() => {
  const next = random(0x5ce1e);
  const square: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]];
  const circle: [number, number][] = Array.from({ length: 65 }, (_, i) => [Math.cos(i / 64 * Math.PI * 2) * 0.5, Math.sin(i / 64 * Math.PI * 2) * 0.5]);
  const fill = (count: number, inside: (x: number, y: number) => boolean) => {
    const out: Grain[] = [];
    while (out.length < count) { const x = next() - 0.5, y = next() - 0.5; if (inside(x, y)) out.push({ x, y, light: 0.38, phase: next() * 7 }); }
    return out;
  };
  return {
    box: [...outline(square, 0.012, 1, next), ...outline([[-0.5, 0.5], [-0.32, 0.64], [0.68, 0.64], [0.5, 0.5]], 0.014, 0.7, next), ...outline([[0.68, 0.64], [0.68, -0.36], [0.5, -0.5]], 0.014, 0.55, next), ...fill(110, () => true)],
    ball: [...outline(circle, 0.012, 1, next), ...fill(70, (x, y) => x * x + y * y < 0.2), ...Array.from({ length: 14 }, (_, i) => ({ x: 0.3 * Math.cos(i * 0.1), y: 0.3 * Math.sin(i * 0.1), light: 0.95, phase: i }))],
    panel: [
      ...outline(square, 0.016, 0.85, next),
      // A small bar chart: three bars, the first (whose top is where the figure points) the tallest.
      ...[[-0.18, 0.64], [0.02, 0.42], [0.22, 0.52]].flatMap(([x, h]) => outline([[x - 0.05, -0.36], [x - 0.05, -0.36 + h], [x + 0.05, -0.36 + h], [x + 0.05, -0.36]], 0.03, 0.7, next)),
      ...outline([[-0.4, -0.36], [0.4, -0.36]], 0.03, 0.45, next),
    ],
    ground: outline([[-1.6, 0], [1.6, 0]], 0.018, 0.32, next),
    // v0.4.4: a floating question mark, and the "!" it becomes when the figure gets it.
    question: [
      ...outline(Array.from({ length: 28 }, (_, i) => { const a = Math.PI * (1.05 - 1.45 * i / 27); return [Math.cos(a) * 0.3, 0.2 + Math.sin(a) * 0.26] as [number, number]; }), 0.02, 1, next),
      ...outline([[0.08, -0.02], [0.0, -0.12], [0.0, -0.22]], 0.02, 1, next),
      ...Array.from({ length: 10 }, (_, i) => ({ x: Math.cos(i) * 0.04, y: -0.42 + Math.sin(i) * 0.04, light: 1, phase: i })),
    ],
    answer: [
      ...outline([[0, 0.48], [0, -0.2]], 0.02, 1, next),
      ...Array.from({ length: 10 }, (_, i) => ({ x: Math.cos(i) * 0.045, y: -0.42 + Math.sin(i) * 0.045, light: 1, phase: i })),
    ],
  };
})();

const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] as Rgb;

export class SceneLayer {
  private readonly context: CanvasRenderingContext2D;
  private last = performance.now();
  private clock = 0;
  private frame = 0;
  private ratio = 1;
  /** What was drawn this frame (object id → screen centre), for diagnostics and tests. */
  readonly drawn = new Map<string, { x: number; y: number; visible: number }>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly sources: SceneLayerSources) {
    this.context = canvas.getContext("2d")!;
    const tick = (now: number) => { this.draw(Math.min(0.1, Math.max(0, (now - this.last) / 1000))); this.last = now; this.frame = requestAnimationFrame(tick); };
    this.frame = requestAnimationFrame(tick);
  }

  dispose() { cancelAnimationFrame(this.frame); }

  /** Normalized stage coordinates → world (the figure's stage: smaller and lower, see animation/scene/sequence.ts). */
  private world(x: number, y: number): [number, number, number] { return [x * FIGURE_SCALE * STAGE.scale, y * FIGURE_SCALE * STAGE.scale + STAGE.y, 0]; }

  private draw(dt: number) {
    this.clock += dt;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const width = Math.round(this.canvas.clientWidth * ratio), height = Math.round(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height || this.ratio !== ratio) { this.canvas.width = width; this.canvas.height = height; this.ratio = ratio; }
    const g = this.context;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn.clear();
    const frame = this.sources.frame();
    if (!frame || frame.visible < 0.02) return;
    const bounds = this.canvas.getBoundingClientRect();
    g.setTransform(ratio, 0, 0, ratio, -bounds.left * ratio, -bounds.top * ratio);
    const { base, accent } = this.sources.colors();
    const rgb = hexToRgb(base), mark = hexToRgb(accent);
    const fillStyle = (c: Rgb, alpha: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha.toFixed(3)})`;
    const grains = (shape: readonly Grain[], place: (x: number, y: number) => [number, number], alpha: number, color: Rgb, size = 1.7) => {
      for (const grain of shape) {
        const [x, y] = place(grain.x, grain.y);
        const screen = this.sources.project(this.world(x, y));
        if (!screen) continue;
        const twinkle = 0.75 + 0.25 * Math.sin(this.clock * 2.1 + grain.phase);
        g.fillStyle = fillStyle(color, alpha * grain.light * twinkle);
        g.fillRect(screen[0] - size / 2, screen[1] - size / 2, size, size);
      }
    };
    g.globalCompositeOperation = "lighter";
    grains(SHAPES.ground, (x, y) => [x, GROUND - 0.03 + y], frame.visible * 0.8, rgb, 1.4);
    for (const object of frame.objects) {
      const alpha = frame.visible * (0.82 + 0.18 * object.focus);
      const c = Math.cos(object.spin), s = Math.sin(object.spin);
      // A touched box wobbles about its bottom edge (v0.4.4); a ball rolls; the rest stand as they are.
      const tc = Math.cos(object.tilt), ts = Math.sin(object.tilt);
      const place = (x: number, y: number): [number, number] => object.type === "ball"
        ? [object.x + (x * c - y * s) * object.w, object.y + (x * s + y * c) * object.h]
        : object.type === "box" ? [object.x + (x * tc - (y + 0.5) * ts) * object.w, object.y + ((x * ts + (y + 0.5) * tc) - 0.5) * object.h]
          : [object.x + x * object.w, object.y + y * object.h];
      const lit = alpha * (1 + object.glow * 0.6);
      if (object.type === "question") {
        // "?" fading into "!" (in the accent) when the figure gets it, with a soft pulse at that moment.
        if (object.solved < 1) grains(SHAPES.question, place, lit * (1 - object.solved), rgb, 2.1);
        if (object.solved > 0) grains(SHAPES.answer, place, lit * object.solved * (1 + 0.5 * Math.sin(Math.PI * object.solved)), mark, 2.4);
      } else grains(SHAPES[object.type], place, lit, object.glow > 0.05 ? mixRgb(rgb, mark, object.glow * 0.6) : rgb, 2.1);
      const centre = this.sources.project(this.world(object.x, object.y));
      if (centre) this.drawn.set(object.id, { x: centre[0], y: centre[1], visible: alpha });
      // The mark being pointed at: a soft pulse in the accent colour.
      if (object.mark) {
        const at = this.sources.project(this.world(object.mark[0], object.mark[1]));
        if (at) {
          const pulse = 0.5 + 0.5 * Math.sin(this.clock * 5);
          const glow = g.createRadialGradient(at[0], at[1], 0, at[0], at[1], 14);
          glow.addColorStop(0, fillStyle(mark, 0.7 * frame.visible)); glow.addColorStop(1, fillStyle(mark, 0));
          g.fillStyle = glow; g.beginPath(); g.arc(at[0], at[1], 14, 0, Math.PI * 2); g.fill();
          g.fillStyle = fillStyle(mark, frame.visible); g.beginPath(); g.arc(at[0], at[1], 2.6 + pulse, 0, Math.PI * 2); g.fill();
        }
      }
    }
    g.globalCompositeOperation = "source-over";
  }
}
