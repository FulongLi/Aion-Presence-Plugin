import type { GeoMarker } from "../core/presentation";
import { hexToRgb, type Rgb } from "../core/colors";
import { markerWorldPoint } from "../visual/geo/markers";
import type { MorphTarget } from "../visual/types";
import { pointAlong, simplifyRoute, type RoutePlace } from "../visual/geo/route";

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
  /** v0.6: the colour a route is drawn in (Aion's accent). */
  accent?(): string;
}

/**
 * v0.6: a route over the terrain — the same GeoRoute the Route Explorer card draws. `along`: metres along the route at
 * each vertex (the card's own measure), so a distance the card reports lands on the same place here.
 */
export interface BodyRoute { id: string; coordinates: [number, number][]; along: Float64Array; origin: RoutePlace; destination: RoutePlace; waypoints: RoutePlace[] }
/** What along the route is pointed at: the card's pointer, its highlight (with a short label), or a section. */
export interface RouteFocus { cursor: number | null; highlight: { distance: number; label: string } | null; section: [number, number] | null }

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
  /** v0.6: the route drawn over the terrain, its body-scale simplification (per formed target), and what is pointed at. */
  private route: BodyRoute | null = null;
  private routeAppear = 0;
  private simplified: { target: unknown; coordinates: [number, number][]; along: number[] } | null = null;
  private focus: RouteFocus = { cursor: null, highlight: null, section: null };
  /** What the route overlay drew last frame (diagnostics and tests): its screen points, A, B and the focus. */
  readonly routeDrawn: { points: number; a: [number, number] | null; b: [number, number] | null; cursor: [number, number] | null; highlight: [number, number] | null; visible: number } = { points: 0, a: null, b: null, cursor: null, highlight: null, visible: 0 };

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

  /** v0.6: the route to draw over the terrain (null: none). A new route fades in; the same one keeps its place. */
  setRoute(route: BodyRoute | null) {
    if (route?.id === this.route?.id && route?.coordinates.length === this.route?.coordinates.length) { if (route) this.route = route; return; }
    this.route = route;
    this.simplified = null;
    this.routeAppear = 0;
    if (!route) this.focus = { cursor: null, highlight: null, section: null };
  }

  /** v0.6: what along the route is pointed at (from the card), drawn on the terrain at the same place. */
  setFocus(focus: Partial<RouteFocus>) { this.focus = { ...this.focus, ...focus }; }

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
    this.routeDrawn.points = 0; this.routeDrawn.a = this.routeDrawn.b = this.routeDrawn.cursor = this.routeDrawn.highlight = null; this.routeDrawn.visible = 0;
    if (!target || this.visibility < 0.01) return;
    const bounds = this.canvas.getBoundingClientRect();
    g.setTransform(ratio, 0, 0, ratio, -bounds.left * ratio, -bounds.top * ratio);
    const terrain = target.visual.kind === "heightfield";
    if (terrain && this.route) this.drawRoute(g, target, dt);
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

  /**
   * v0.6: the route over the terrain — a restrained luminous line resting on the relief (each vertex stands at the
   * terrain's height there, through the samplers' own geometry), a few grains travelling from A to B, A and B on short
   * stems like pins, and the card's highlight, section and pointer at the same places along the route. The line is
   * simplified to the terrain's own resolution (a particle terrain cannot show a footpath's every bend; the card shows
   * the exact geometry); positions are never moved for looks.
   */
  private drawRoute(g: CanvasRenderingContext2D, target: MorphTarget, dt: number) {
    const route = this.route!, visual = target.visual;
    if (visual.kind !== "heightfield" || !visual.field.geo) return;
    if (this.simplified?.target !== visual) {
      const { geo, width } = visual.field;
      // Half a terrain cell, in metres (the frame is on the unit sphere).
      const cell = (geo.x1 - geo.x0) * 6_371_000 / Math.max(1, width);
      // The route's own corners (simplified within half a cell), and a point about every cell between them, so the line
      // rests on the relief all the way rather than cutting through a hill between two distant corners.
      const index = new Map(route.coordinates.map((c, i) => [`${c[0]},${c[1]}`, i]));
      const corners = simplifyRoute(route.coordinates, Math.max(5, cell * 0.5)).map(c => route.along[index.get(`${c[0]},${c[1]}`) ?? 0]);
      const total = route.along[route.along.length - 1] ?? 0, step = Math.max(cell, total / 600);
      const distances = [...new Set([...corners, ...Array.from({ length: Math.floor(total / step) }, (_, i) => (i + 1) * step)])].sort((x, y) => x - y);
      this.simplified = { target: visual, coordinates: distances.map(d => pointAlong(route.coordinates, route.along, d)), along: distances };
    }
    this.routeAppear = Math.min(1, this.routeAppear + dt * 1.4);
    const alpha = this.visibility * this.routeAppear;
    if (alpha < 0.01) return;
    const { coordinates, along } = this.simplified;
    const screen: ([number, number] | null)[] = coordinates.map(([lon, lat]) => {
      const ground = markerWorldPoint(visual, lon, lat);
      return ground ? this.sources.project([ground[0], ground[1] + 0.012, ground[2]]) : null;
    });
    const [r, gr, b] = hexToRgb(this.sources.accent?.() ?? "#e2725b").map(c => Math.round(c * 255));
    const lift = (k: number) => `rgba(${Math.round(r + (255 - r) * k)},${Math.round(gr + (255 - gr) * k)},${Math.round(b + (255 - b) * k)},`;
    const stroke = (from: number, to: number, width: number, style: string) => {
      g.strokeStyle = style; g.lineWidth = width; g.lineJoin = "round"; g.lineCap = "round";
      g.beginPath();
      let pen = false;
      for (let i = 0; i < screen.length; i++) {
        const p = screen[i];
        if (!p || along[i] < from - 1 || along[i] > to + 1) { pen = false; continue; }
        if (!pen) { g.moveTo(p[0], p[1]); pen = true; } else g.lineTo(p[0], p[1]);
      }
      g.stroke();
    };
    const total = along[along.length - 1] ?? 0, section = this.focus.section;
    stroke(0, total, 9, `rgba(${r},${gr},${b},${0.16 * alpha})`);
    stroke(0, total, 3.4, `rgba(5,8,12,${0.55 * alpha})`);
    stroke(0, total, 2.1, `${lift(0.25)}${(section ? 0.55 : 0.95) * alpha})`);
    if (section) { stroke(section[0], section[1], 6, `rgba(${r},${gr},${b},${0.3 * alpha})`); stroke(section[0], section[1], 2.4, `${lift(0.55)}${alpha})`); }
    else stroke(0, total, 0.7, `rgba(255,255,255,${0.45 * alpha})`);
    this.routeDrawn.points = screen.filter(Boolean).length;
    this.routeDrawn.visible = alpha;
    // A few grains travelling from A to B: occasional emphasis, never a busy animation.
    const at = (d: number): [number, number] | null => {
      const [lon, lat] = pointAlong(route.coordinates, route.along, d);
      const ground = markerWorldPoint(visual, lon, lat);
      return ground ? this.sources.project([ground[0], ground[1] + 0.012, ground[2]]) : null;
    };
    if (total > 0) {
      for (let k = 0; k < 4; k++) {
        const phase = ((this.clock / 9 + k / 4) % 1), p = at(phase * total);
        if (!p) continue;
        const fade = Math.sin(phase * Math.PI);
        const glow = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], 7);
        glow.addColorStop(0, `${lift(0.6)}${0.75 * alpha * fade})`); glow.addColorStop(1, `${lift(0.6)}0)`);
        g.fillStyle = glow; g.beginPath(); g.arc(p[0], p[1], 7, 0, Math.PI * 2); g.fill();
      }
    }
    // Waypoints, then A and B on their stems.
    const pin = (place: RoutePlace, letter: string, filled: boolean) => {
      const ground = markerWorldPoint(visual, place.lon, place.lat);
      if (!ground) return null;
      const base = this.sources.project(ground), top = this.sources.project([ground[0], ground[1] + 0.06, ground[2]]);
      if (!base || !top) return null;
      g.strokeStyle = `rgba(230,236,242,${0.5 * alpha})`; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(base[0], base[1]); g.lineTo(top[0], top[1]); g.stroke();
      const glow = g.createRadialGradient(top[0], top[1], 0, top[0], top[1], 16);
      glow.addColorStop(0, `rgba(${r},${gr},${b},${0.35 * alpha})`); glow.addColorStop(1, `rgba(${r},${gr},${b},0)`);
      g.fillStyle = glow; g.beginPath(); g.arc(top[0], top[1], 16, 0, Math.PI * 2); g.fill();
      g.fillStyle = filled ? `rgba(${r},${gr},${b},${alpha})` : `rgba(243,246,249,${alpha})`;
      g.beginPath(); g.arc(top[0], top[1], letter.length > 1 || /\d/.test(letter) ? 5.5 : 7.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = filled ? `rgba(255,255,255,${alpha})` : `rgba(11,15,20,${alpha})`;
      g.font = "700 10px system-ui, -apple-system, 'Segoe UI', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(letter, top[0], top[1] + 0.5);
      g.textAlign = "start"; g.textBaseline = "alphabetic";
      return top;
    };
    route.waypoints.forEach((place, i) => pin(place, String(i + 1), false));
    const a = pin(route.origin, "A", false), bPoint = pin(route.destination, "B", true);
    this.routeDrawn.a = a; this.routeDrawn.b = bPoint;
    // Labels are few and kept apart: the places' names only when A and B stand clear of each other (the letters always),
    // each label placed where it overlaps no other label, pin or the highlight.
    g.font = "600 12px system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif";
    const taken: { x: number; y: number; w: number; h: number }[] = [a, bPoint].filter((p): p is [number, number] => !!p).map(p => ({ x: p[0] - 9, y: p[1] - 9, w: 18, h: 18 }));
    const label = (text: string, at: [number, number], strong: boolean) => {
      const w = g.measureText(text).width, h = 14;
      const spots: [number, number][] = [[at[0] + 12, at[1] + 4], [at[0] - 12 - w, at[1] + 4], [at[0] - w / 2, at[1] - 14], [at[0] - w / 2, at[1] + 22], [at[0] + 12, at[1] - 12], [at[0] - 12 - w, at[1] + 18]];
      const free = spots.find(([x, y]) => !taken.some(o => x < o.x + o.w && x + w > o.x && y - h < o.y + o.h && y > o.y));
      if (!free) return;
      taken.push({ x: free[0], y: free[1] - h, w, h });
      g.lineJoin = "round"; g.lineWidth = 3.5; g.strokeStyle = `rgba(6,9,14,${0.85 * alpha})`; g.strokeText(text, free[0], free[1]);
      g.fillStyle = `rgba(${strong ? "246,249,252" : "226,233,240"},${alpha})`; g.fillText(text, free[0], free[1]);
    };
    const apart = a && bPoint ? Math.hypot(a[0] - bPoint[0], a[1] - bPoint[1]) > 110 : true;
    // The card's highlight (a slow pulse and its label) and the pointer (a bright grain).
    const highlight = this.focus.highlight;
    if (highlight) {
      const p = at(highlight.distance);
      if (p) {
        this.routeDrawn.highlight = p;
        const phase = (this.clock % 1.8) / 1.8;
        g.strokeStyle = `${lift(0.4)}${alpha * (1 - phase) * 0.8})`; g.lineWidth = 1.4;
        g.beginPath(); g.arc(p[0], p[1], 5 + phase * 20, 0, Math.PI * 2); g.stroke();
        g.fillStyle = `rgba(255,255,255,${alpha})`; g.beginPath(); g.arc(p[0], p[1], 3.6, 0, Math.PI * 2); g.fill();
        taken.push({ x: p[0] - 6, y: p[1] - 6, w: 12, h: 12 });
        label(highlight.label, p, true);
      }
    }
    if (apart) {
      if (a) label(route.origin.name, a, false);
      if (bPoint) label(route.destination.name, bPoint, false);
    }
    if (this.focus.cursor !== null) {
      const p = at(this.focus.cursor);
      if (p) {
        this.routeDrawn.cursor = p;
        const glow = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], 10);
        glow.addColorStop(0, `rgba(255,255,255,${0.9 * alpha})`); glow.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = glow; g.beginPath(); g.arc(p[0], p[1], 10, 0, Math.PI * 2); g.fill();
      }
    }
  }
}
