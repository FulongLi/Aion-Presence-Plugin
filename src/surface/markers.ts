import type { GeoMarker } from "../core/presentation";
import { hexToRgb, type Rgb } from "../core/colors";
import { markerWorldPoint } from "../visual/geo/markers";
import type { MorphTarget } from "../visual/types";

/**
 * Places marked on a map or on terrain, drawn over the particle body. The body draws the land; a marker has to be
 * exact and readable, so it is drawn here — a small cluster of glowing grains in its colour, a quiet pulse, and a
 * crisp label — at the screen position the renderer itself gives the marker's latitude and longitude (through the
 * same geometry the sampler used), every frame. On terrain a marker stands on a thin stem above the relief, like a
 * pin. Changing, adding or removing markers never re-forms the map: markers pop in, recolour and fade out here.
 */
export interface MarkerLayerSources {
  /** The formed visual (null at rest), how far it is formed (0…1), and the screen projection. */
  target(): MorphTarget | null;
  level(): number;
  project(point: [number, number, number]): [number, number] | null;
}

interface Shown { marker: GeoMarker; appear: number; leaving: boolean; color: Rgb; born: number }

const GRAINS = Array.from({ length: 26 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453, b = Math.sin(i * 78.233) * 12345.678;
  const r = Math.sqrt(-2 * Math.log(1 - (a - Math.floor(a)) * 0.98)) * 3.6, t = (b - Math.floor(b)) * Math.PI * 2;
  return { x: Math.cos(t) * r, y: Math.sin(t) * r, phase: (a + b) % 7 };
});

export class MarkerLayer {
  private readonly context: CanvasRenderingContext2D;
  private shown = new Map<string, Shown>();
  private visibility = 0;
  private clock = 0;
  private last = performance.now();
  private frame = 0;
  private ratio = 1;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly sources: MarkerLayerSources) {
    this.context = canvas.getContext("2d")!;
    const tick = (now: number) => { this.draw(Math.min(0.1, Math.max(0, (now - this.last) / 1000))); this.last = now; this.frame = requestAnimationFrame(tick); };
    this.frame = requestAnimationFrame(tick);
  }

  /** The markers to show (replaces the set: new ones pop in, removed ones fade, changed ones recolour). */
  set(markers: readonly GeoMarker[]) {
    const keep = new Set(markers.map(marker => marker.id));
    for (const [id, item] of this.shown) if (!keep.has(id)) item.leaving = true;
    for (const marker of markers) {
      const item = this.shown.get(marker.id);
      if (item) { item.marker = marker; item.leaving = false; }
      else this.shown.set(marker.id, { marker, appear: 0, leaving: false, color: hexToRgb(marker.color), born: this.clock });
    }
  }

  /** What is drawn now, for diagnostics and tests: each marker's label, colour and screen position. */
  readonly positions = new Map<string, { label: string; color: string; x: number; y: number; visible: number }>();

  dispose() { cancelAnimationFrame(this.frame); }

  private resize() {
    const ratio = Math.min(2, devicePixelRatio || 1);
    const width = Math.round(this.canvas.clientWidth * ratio), height = Math.round(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height || this.ratio !== ratio) {
      this.canvas.width = width; this.canvas.height = height; this.ratio = ratio;
    }
  }

  private draw(dt: number) {
    this.clock += dt;
    this.resize();
    const g = this.context, ratio = this.ratio;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const target = this.sources.target();
    const geographic = target && (target.visual.kind === "map" || target.visual.kind === "heightfield");
    // Markers appear once the land has formed, and leave as it dissolves.
    const goal = geographic && this.sources.level() > 0.9 ? 1 : 0;
    this.visibility += (goal - this.visibility) * (1 - Math.exp(-(goal ? 5 : 9) * dt));
    this.positions.clear();
    if (!target || this.visibility < 0.01) return;
    const bounds = this.canvas.getBoundingClientRect();
    g.setTransform(ratio, 0, 0, ratio, -bounds.left * ratio, -bounds.top * ratio);
    const terrain = target.visual.kind === "heightfield";
    const labels: { x: number; y: number; w: number; h: number }[] = [];
    for (const [id, item] of [...this.shown]) {
      // Pop in with a little overshoot; fade out when removed; colours ease.
      item.appear = item.leaving ? Math.max(0, item.appear - dt * 3.5) : Math.min(1, item.appear + dt * 2.8);
      if (item.leaving && item.appear <= 0) { this.shown.delete(id); continue; }
      const goalColor = hexToRgb(item.marker.color);
      for (let c = 0; c < 3; c++) item.color[c] += (goalColor[c] - item.color[c]) * (1 - Math.exp(-6 * dt));
      const ground = markerWorldPoint(target.visual, item.marker.lon, item.marker.lat);
      if (!ground) continue;
      const base = this.sources.project(ground);
      const top = terrain ? this.sources.project([ground[0], ground[1] + 0.2, ground[2]]) : base;
      if (!base || !top) continue;
      const t = item.appear, pop = t < 1 ? 1 + Math.sin(Math.min(1, t) * Math.PI) * 0.35 * (1 - t) : 1;
      const alpha = this.visibility * Math.min(1, t * 1.6);
      const [r, gr, b] = item.color.map(c => Math.round(c * 255));
      const rgba = (a: number) => `rgba(${r},${gr},${b},${a})`;
      const [x, y] = top, scale = (item.marker.highlight ? 1.35 : 1) * pop;
      this.positions.set(id, { label: item.marker.label, color: item.marker.color, x, y, visible: alpha });
      if (terrain) {
        // The pin's stem, from the relief up to the marker.
        g.strokeStyle = rgba(0.55 * alpha); g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(base[0], base[1]); g.lineTo(x, y); g.stroke();
        g.fillStyle = rgba(0.5 * alpha); g.beginPath(); g.arc(base[0], base[1], 1.6, 0, Math.PI * 2); g.fill();
      }
      // The glow, the grains (each twinkling a little), a bright core.
      const glow = g.createRadialGradient(x, y, 0, x, y, 16 * scale);
      glow.addColorStop(0, rgba(0.42 * alpha)); glow.addColorStop(1, rgba(0));
      g.fillStyle = glow; g.beginPath(); g.arc(x, y, 16 * scale, 0, Math.PI * 2); g.fill();
      for (const grain of GRAINS) {
        const twinkle = 0.55 + 0.45 * Math.sin(this.clock * 2.3 + grain.phase);
        g.fillStyle = rgba(alpha * twinkle);
        g.fillRect(x + grain.x * scale - 0.8, y + grain.y * scale - 0.8, 1.6, 1.6);
      }
      g.fillStyle = `rgba(${Math.round(r + (255 - r) * 0.45)},${Math.round(gr + (255 - gr) * 0.45)},${Math.round(b + (255 - b) * 0.45)},${alpha})`;
      g.beginPath(); g.arc(x, y, 2.9 * scale, 0, Math.PI * 2); g.fill();
      // A quiet pulse: every few seconds a ring widens and fades (a highlighted place pulses more often and wider).
      const period = item.marker.highlight ? 1.6 : 3.2, phase = ((this.clock - item.born) % period) / period;
      g.strokeStyle = rgba(alpha * (1 - phase) * (item.marker.highlight ? 0.75 : 0.4)); g.lineWidth = 1.3;
      g.beginPath(); g.arc(x, y, (5 + phase * (item.marker.highlight ? 22 : 13)) * scale, 0, Math.PI * 2); g.stroke();
      // The label: crisp type beside it, with a dark halo so it reads over particles, kept clear of other labels.
      g.font = "600 13px system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif";
      const w = g.measureText(item.marker.label).width, h = 15;
      const right = x + 12 + w < bounds.right - 8;
      const lx = right ? x + 11 : x - 11 - w;
      let ly = y + 4.5;
      for (let k = 0; k < 4 && labels.some(o => lx < o.x + o.w && lx + w > o.x && ly - h < o.y && ly > o.y - o.h); k++) ly += 16;
      labels.push({ x: lx, y: ly, w, h });
      g.lineJoin = "round"; g.lineWidth = 3.5; g.strokeStyle = `rgba(6,9,14,${0.85 * alpha})`; g.strokeText(item.marker.label, lx, ly);
      g.fillStyle = `rgba(238,243,248,${alpha})`; g.fillText(item.marker.label, lx, ly);
    }
  }
}
