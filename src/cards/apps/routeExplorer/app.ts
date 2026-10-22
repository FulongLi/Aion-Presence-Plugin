import type { CardApp, CardContext, CommandResult } from "../../runtime/app";
import { button, el } from "../../runtime/app";
import type { MapTile, ResourceStatus } from "../../protocol";
import type { CardValue } from "../../values";
import {
  elevationAt, formatDistance, formatDuration, routeAlong, routePointAt, steepestClimb, validateRoute, type GeoRoute,
} from "../../../visual/geo/route";
import { clampZoom, fitView, nearestAlong, niceTicks, parseSection, tileKey, tilesInView, tileZoom, toScreen, toWorld, worldX, worldY, type MapView } from "./model";

/**
 * The Route Explorer card (v0.6): the precise view of the one route Aion holds. A map (OpenStreetMap's tiles, handed over
 * by Aion as bytes — the card never touches the network), the route's real geometry with A, B and its waypoints, an
 * elevation profile linked to the map and to Aion's particle terrain (the pointer's place along the route is reported as
 * CURSOR), and the route's figures. Drawn on two 2D canvases, only when something changed.
 */
type Highlight = { kind: "point" | "highest" | "lowest" | "start" | "end"; distance: number } | null;
const MODE_LABEL: Record<GeoRoute["travelMode"], string> = { walking: "Walking", cycling: "Cycling", hiking: "Hiking" };

export function createRouteExplorer(ctx: CardContext): CardApp {
  const root = el("div", { className: "rx" });
  const head = el("div", { className: "rx-head" });
  const title = el("div", { className: "rx-title" }), mode = el("span", { className: "rx-mode" });
  const titleRow = el("div", { className: "rx-title-row" }, [title, mode]);
  const via = el("div", { className: "rx-via" });
  const stats = el("dl", { className: "rx-stats" });
  head.append(titleRow, via, stats);
  const mapBox = el("div", { className: "rx-map" });
  const mapCanvas = el("canvas", { label: "Route map: drag to pan, scroll or +/− to zoom" });
  mapCanvas.tabIndex = 0;
  const zoomIn = button("+", "Zoom in", () => zoomBy(1)), zoomOut = button("−", "Zoom out", () => zoomBy(-1)), fit = button("⤢", "Show the whole route", () => { frameRoute(); });
  const zoomBar = el("div", { className: "rx-zoom" }, [zoomIn, zoomOut, fit]);
  const attribution = el("div", { className: "rx-attrib" });
  const tileNote = el("div", { className: "rx-tilenote" });
  tileNote.hidden = true;
  mapBox.append(mapCanvas, zoomBar, attribution, tileNote);
  const profileBox = el("div", { className: "rx-profile" });
  const profileCanvas = el("canvas", { label: "Elevation profile: point to read it, drag to select a section" });
  profileCanvas.tabIndex = 0;
  const tooltip = el("div", { className: "rx-tip" });
  tooltip.hidden = true;
  profileBox.append(profileCanvas, tooltip);
  const note = el("div", { className: "rx-note" });
  note.hidden = true;
  root.append(head, mapBox, profileBox, note);
  ctx.stage.append(root);

  let route: GeoRoute | null = null, revision = 0, along: Float64Array = new Float64Array(0);
  let view: MapView = { cx: 128, cy: 128, zoom: 2 }, animation: { from: MapView; to: MapView; start: number } | null = null;
  let highlight: Highlight = null, section: [number, number] | null = null, cursor: number | null = null, viewKind: "route" | "section" | "point" | "custom" = "route";
  let suspended = false, frame = 0, drawn = 0, lastDraw = 0, disposed = false;
  const tiles = new Map<string, ImageBitmap>();
  const requested = new Map<string, number>();
  let tileState: "loading" | "ok" | "partial" | "unavailable" = "loading";
  const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e2725b";

  // ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const report = () => {
    if (!route) return;
    const state: Record<string, CardValue> = {
      revision, mode: route.travelMode, distanceKm: Math.round(route.distanceMeters / 100) / 10, durationMin: Math.round(route.estimatedDurationSeconds / 60),
      highlight: highlight ? (highlight.kind === "point" ? "point" : highlight.kind) : section ? (viewKind === "section" && sectionIsSteepest ? "steepest" : "section") : "none",
      sectionKm: section ? `${(section[0] / 1000).toFixed(1)}-${(section[1] / 1000).toFixed(1)}` : "all",
      cursorKm: cursor === null ? -1 : Math.round(cursor / 100) / 10, zoom: Math.round(view.zoom * 10) / 10, view: viewKind, tiles: tileState,
    };
    if (route.totalAscentMeters !== null) Object.assign(state, { ascentM: route.totalAscentMeters, descentM: route.totalDescentMeters ?? 0, minM: route.minimumElevationMeters ?? 0, maxM: route.maximumElevationMeters ?? 0 });
    if (highlight) {
      state.highlightKm = Math.round(highlight.distance / 100) / 10;
      const e = elevationAt(route, highlight.distance);
      if (e !== null) state.highlightM = Math.round(e);
    }
    ctx.emit.state(state);
  };
  let sectionIsSteepest = false;

  // ── Layout and drawing ─────────────────────────────────────────────────────────────────────────────────────────
  const size = (canvas: HTMLCanvasElement) => {
    const ratio = Math.min(2, devicePixelRatio || 1), w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
    const g = canvas.getContext("2d")!;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { g, w, h };
  };
  const invalidate = () => { if (!frame && !suspended && !disposed) frame = requestAnimationFrame(draw); };
  // While the view is still "the whole route" (the user has not moved it), a resize frames the whole route again: the
  // card opens with a transition, so its first size is not its final one.
  const observer = new ResizeObserver(() => { if (route && viewKind === "route" && !animation) view = fitRoute(); invalidate(); });
  observer.observe(mapBox); observer.observe(profileBox);

  const routeScreen = (w: number, h: number) => route ? route.coordinates.map(([lon, lat]) => toScreen(view, w, h, worldX(lon), worldY(lat))) : [];

  function draw(now: number) {
    frame = 0;
    if (!route || suspended || disposed) return;
    lastDraw = now; drawn++;
    if (animation) {
      const t = Math.min(1, (now - animation.start) / 450), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      view = { cx: animation.from.cx + (animation.to.cx - animation.from.cx) * e, cy: animation.from.cy + (animation.to.cy - animation.from.cy) * e, zoom: animation.from.zoom + (animation.to.zoom - animation.from.zoom) * e };
      if (t >= 1) { view = animation.to; animation = null; report(); } else invalidate();
    }
    drawMap();
    drawProfile();
  }

  function drawMap() {
    const { g, w, h } = size(mapCanvas);
    g.fillStyle = "#0b0f14"; g.fillRect(0, 0, w, h);
    // Tiles: those in view at the tile zoom; a missing one is filled from a coarser tile already here.
    const needed = tilesInView(view, w, h), z = tileZoom(view), drawSize = 256 * 2 ** (view.zoom - z);
    g.save();
    g.filter = "saturate(0.6) brightness(0.74) contrast(1.06)";
    g.imageSmoothingQuality = "high";
    let have = 0;
    for (const tile of needed) {
      const [sx, sy] = toScreen(view, w, h, nearestTileX(tile.x, z) * 256 / 2 ** z, tile.y * 256 / 2 ** z);
      const own = tiles.get(tileKey(tile));
      if (own) { g.drawImage(own, sx, sy, drawSize + 0.5, drawSize + 0.5); have++; continue; }
      for (let up = 1; up <= 5 && z - up >= 0; up++) {
        const pz = z - up, px = tile.x >> up, py = tile.y >> up, parent = tiles.get(`${pz}/${px}/${py}`);
        if (!parent) continue;
        const part = 256 / 2 ** up, ox = (tile.x - (px << up)) * part, oy = (tile.y - (py << up)) * part;
        g.drawImage(parent, ox, oy, part, part, sx, sy, drawSize + 0.5, drawSize + 0.5);
        break;
      }
    }
    g.restore();
    requestTiles(needed);
    const status = have === needed.length ? "ok" : [...requested.values()].some(at => performance.now() - at < 5_000) ? "loading" : have ? "partial" : "unavailable";
    if (status !== tileState) { tileState = status; tileNote.hidden = status === "ok" || status === "loading"; tileNote.textContent = "Map tiles are not available here: the route and its profile are still exact."; report(); }
    if (!route) return;
    const points = routeScreen(w, h);
    const colour = accent();
    const line = (from: number, to: number, width: number, style: string) => {
      g.strokeStyle = style; g.lineWidth = width; g.lineJoin = "round"; g.lineCap = "round";
      g.beginPath();
      let started = false;
      for (let i = 0; i < points.length; i++) {
        if (along[i] < from && i + 1 < points.length && along[i + 1] < from) continue;
        if (along[i] > to && i > 0 && along[i - 1] > to) break;
        if (!started) { g.moveTo(points[i][0], points[i][1]); started = true; } else g.lineTo(points[i][0], points[i][1]);
      }
      g.stroke();
    };
    const total = along[along.length - 1] ?? 0;
    line(0, total, 7, "rgba(4, 7, 11, 0.82)");
    line(0, total, 3.6, section ? `color-mix(in srgb, ${colour} 55%, #3a4048)` : colour);
    if (section) { line(section[0], section[1], 7.5, "rgba(4, 7, 11, 0.9)"); line(section[0], section[1], 4.4, colour); line(section[0], section[1], 1.4, "rgba(255,255,255,0.7)"); }
    else line(0, total, 1.1, "rgba(255,255,255,0.32)");
    // Waypoints, then A and B.
    route.waypoints.forEach((place, i) => {
      const [x, y] = toScreen(view, w, h, worldX(place.lon), worldY(place.lat));
      disc(g, x, y, 7, "#e9eef3", colour, String(i + 1), "#0b0f14");
    });
    const [ax, ay] = toScreen(view, w, h, worldX(route.origin.lon), worldY(route.origin.lat));
    const [bx, by] = toScreen(view, w, h, worldX(route.destination.lon), worldY(route.destination.lat));
    // Where the path actually starts and ends (it may be a little off the place asked for): a thin connector.
    for (const [px, py, [cx2, cy2]] of [[ax, ay, points[0]], [bx, by, points[points.length - 1]]] as const) {
      if (Math.hypot(px - cx2, py - cy2) > 6) { g.setLineDash([3, 3]); g.strokeStyle = "rgba(230,236,242,0.55)"; g.lineWidth = 1.2; g.beginPath(); g.moveTo(px, py); g.lineTo(cx2, cy2); g.stroke(); g.setLineDash([]); }
    }
    disc(g, ax, ay, 10, "#f3f6f9", "rgba(4,7,11,0.85)", "A", "#0b0f14");
    disc(g, bx, by, 10, colour, "rgba(4,7,11,0.85)", "B", "#ffffff");
    // The highlight and the pointer.
    if (highlight) {
      const [lon, lat] = routePointAt(route, highlight.distance, along);
      const [x, y] = toScreen(view, w, h, worldX(lon), worldY(lat));
      g.strokeStyle = "rgba(255,255,255,0.95)"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke();
      g.fillStyle = colour; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
      const e = elevationAt(route, highlight.distance);
      tag(g, x, y, `${highlight.kind === "highest" ? "Highest · " : highlight.kind === "lowest" ? "Lowest · " : ""}${e === null ? "" : `${Math.round(e)} m · `}${(highlight.distance / 1000).toFixed(1)} km`, w);
    }
    if (cursor !== null) {
      const [lon, lat] = routePointAt(route, cursor, along);
      const [x, y] = toScreen(view, w, h, worldX(lon), worldY(lat));
      g.fillStyle = "#ffffff"; g.strokeStyle = colour; g.lineWidth = 2.5;
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    scaleBar(g, h);
  }

  /** The tile column nearest the view (the world wraps east and west). */
  const nearestTileX = (x: number, z: number) => {
    const n = 2 ** z, centre = view.cx * n / 256;
    let best = x;
    for (const k of [-1, 1]) if (Math.abs(x + k * n + 0.5 - centre) < Math.abs(best + 0.5 - centre)) best = x + k * n;
    return best;
  };

  function disc(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, ring: string, text: string, ink: string) {
    g.fillStyle = ring; g.beginPath(); g.arc(x, y, r + 2.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink; g.font = `700 ${r > 8 ? 11 : 9}px -apple-system, "Segoe UI", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, x, y + 0.5);
    g.textAlign = "start"; g.textBaseline = "alphabetic";
  }

  function tag(g: CanvasRenderingContext2D, x: number, y: number, text: string, w: number) {
    g.font = "600 11.5px -apple-system, 'Segoe UI', sans-serif";
    const tw = g.measureText(text).width + 14, right = x + 16 + tw < w - 6;
    const lx = right ? x + 16 : x - 16 - tw, ly = Math.max(4, y - 24);
    g.fillStyle = "rgba(8, 11, 15, 0.86)"; g.strokeStyle = "rgba(200,215,230,0.22)"; g.lineWidth = 1;
    g.beginPath(); g.roundRect(lx, ly, tw, 20, 6); g.fill(); g.stroke();
    g.fillStyle = "#eef2f6"; g.fillText(text, lx + 7, ly + 14);
  }

  function scaleBar(g: CanvasRenderingContext2D, h: number) {
    const lat = (Math.atan(Math.sinh(Math.PI - 2 * Math.PI * view.cy / 256)) * 180) / Math.PI;
    const metresPerPixel = 156_543.034 * Math.cos(lat * Math.PI / 180) / 2 ** view.zoom;
    const target = metresPerPixel * 90, mag = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].map(k => k * mag).filter(v => v <= target).pop() ?? mag;
    const px = nice / metresPerPixel, x = 10, y = h - 12;
    g.strokeStyle = "rgba(235,240,245,0.85)"; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x, y); g.lineTo(x + px, y); g.lineTo(x + px, y - 5); g.stroke();
    g.fillStyle = "rgba(235,240,245,0.9)"; g.font = "10.5px -apple-system, 'Segoe UI', sans-serif";
    g.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, x + 4, y - 4);
  }

  function drawProfile() {
    const { g, w, h } = size(profileCanvas);
    g.clearRect(0, 0, w, h);
    if (!route) return;
    const samples = route.elevationSamples;
    if (samples.length < 2) {
      g.fillStyle = "#8e99a5"; g.font = "12px -apple-system, 'Segoe UI', sans-serif"; g.textAlign = "center";
      g.fillText("No elevation data could be read for this route.", w / 2, h / 2); g.textAlign = "start";
      return;
    }
    const left = 40, right = 10, top = 12, bottom = 20, pw = w - left - right, ph = h - top - bottom;
    const total = route.distanceMeters;
    let lo = Infinity, hi = -Infinity;
    for (const [, e] of samples) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
    const span = Math.max(20, hi - lo), y0 = Math.max(lo - span * 0.12, lo - 40), y1 = hi + span * 0.12;
    const X = (d: number) => left + d / total * pw, Y = (e: number) => top + (1 - (e - y0) / (y1 - y0)) * ph;
    // Grid and axes.
    g.font = "10px -apple-system, 'Segoe UI', sans-serif"; g.fillStyle = "#7f8a96"; g.strokeStyle = "rgba(190,205,220,0.09)"; g.lineWidth = 1;
    for (const e of niceTicks(y0, y1, 3)) { const y = Y(e); g.beginPath(); g.moveTo(left, y); g.lineTo(w - right, y); g.stroke(); g.fillText(`${Math.round(e)} m`, 4, y + 3); }
    g.textAlign = "center";
    for (const d of niceTicks(0, total / 1000, Math.max(2, Math.floor(pw / 70)))) g.fillText(`${d} km`, X(d * 1000), h - 5);
    g.textAlign = "start";
    const colour = accent();
    if (section) { g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(X(section[0]), top, X(section[1]) - X(section[0]), ph); }
    // The profile: a filled area and its line.
    const gradient = g.createLinearGradient(0, top, 0, top + ph);
    gradient.addColorStop(0, `color-mix(in srgb, ${colour} 38%, transparent)`); gradient.addColorStop(1, `color-mix(in srgb, ${colour} 4%, transparent)`);
    g.beginPath(); g.moveTo(X(samples[0][0]), top + ph);
    for (const [d, e] of samples) g.lineTo(X(d), Y(e));
    g.lineTo(X(samples[samples.length - 1][0]), top + ph); g.closePath();
    g.fillStyle = gradient; g.fill();
    g.beginPath();
    samples.forEach(([d, e], i) => i ? g.lineTo(X(d), Y(e)) : g.moveTo(X(d), Y(e)));
    g.strokeStyle = colour; g.lineWidth = 1.6; g.stroke();
    if (section) {
      g.beginPath();
      let started = false;
      for (const [d, e] of samples) { if (d < section[0] || d > section[1]) continue; if (!started) { g.moveTo(X(d), Y(e)); started = true; } else g.lineTo(X(d), Y(e)); }
      g.strokeStyle = "#ffffff"; g.lineWidth = 2.2; g.stroke();
    }
    // The highest point, always marked.
    if (route.highest) {
      const x = X(route.highest.distanceMeters), y = Y(route.highest.elevationMeters);
      g.fillStyle = "#eef2f6"; g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x - 4.5, y - 11); g.lineTo(x + 4.5, y - 11); g.closePath(); g.fill();
      g.font = "600 10px -apple-system, 'Segoe UI', sans-serif";
      const label = `${route.highest.elevationMeters} m`, tw = g.measureText(label).width;
      g.fillText(label, Math.min(w - right - tw, Math.max(left, x - tw / 2)), Math.max(10, y - 14));
    }
    const mark = (d: number, strong: boolean) => {
      const e = elevationAt(route!, d);
      if (e === null) return;
      const x = X(d), y = Y(e);
      g.strokeStyle = strong ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.45)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + ph); g.stroke();
      g.fillStyle = strong ? colour : "#ffffff"; g.beginPath(); g.arc(x, y, strong ? 4.5 : 3.5, 0, Math.PI * 2); g.fill();
    };
    if (highlight) mark(highlight.distance, true);
    if (cursor !== null) {
      mark(cursor, false);
      const e = elevationAt(route, cursor);
      tooltip.hidden = false;
      tooltip.textContent = `${(cursor / 1000).toFixed(cursor < 10_000 ? 2 : 1)} km · ${e === null ? "—" : `${Math.round(e)} m`}`;
      tooltip.style.left = `${Math.min(w - 120, Math.max(left, X(cursor) + 8))}px`;
    } else tooltip.hidden = true;
    profileGeometry = { left, pw, total };
  }
  let profileGeometry = { left: 40, pw: 1, total: 1 };

  // ── Tiles ──────────────────────────────────────────────────────────────────────────────────────────────────────
  function requestTiles(needed: MapTile[]) {
    const now = performance.now(), missing: MapTile[] = [];
    for (const tile of needed) {
      const key = tileKey(tile);
      if (tiles.has(key)) continue;
      const at = requested.get(key);
      // A tile that did not arrive is asked for again a while later (the page may have been offline).
      if (at !== undefined && now - at < 15_000) continue;
      requested.set(key, now);
      missing.push(tile);
    }
    if (missing.length) ctx.emit.tiles(missing.slice(0, 32));
    if (missing.length) setTimeout(invalidate, 5_200);
  }

  // ── Framing ────────────────────────────────────────────────────────────────────────────────────────────────────
  const mapSize = () => ({ w: Math.max(1, mapCanvas.clientWidth), h: Math.max(1, mapCanvas.clientHeight) });
  function goTo(next: MapView, kind: typeof viewKind) {
    viewKind = kind;
    next = { ...next, zoom: clampZoom(next.zoom) };
    if (ctx.reducedMotion || !route) { view = next; animation = null; } else animation = { from: view, to: next, start: performance.now() };
    report(); invalidate();
  }
  /** The view that shows the whole route, its places and a margin (wider on the right, where the zoom controls are). */
  function fitRoute(): MapView {
    const { w, h } = mapSize();
    const fitted = fitView([...route!.coordinates, [route!.origin.lon, route!.origin.lat], [route!.destination.lon, route!.destination.lat]], Math.max(1, w - 44), h, 32);
    // Shift the centre so the route sits clear of the controls on the right.
    return { ...fitted, cx: fitted.cx + 22 / 2 ** fitted.zoom };
  }
  function frameRoute() {
    if (!route) return;
    section = null; sectionIsSteepest = false;
    goTo(fitRoute(), "route");
  }
  function frameSection(from: number, to: number, steepest = false) {
    if (!route) return;
    section = [from, to]; sectionIsSteepest = steepest; highlight = null;
    const points = route.coordinates.filter((_, i) => along[i] >= from && along[i] <= to);
    points.push(routePointAt(route, from, along), routePointAt(route, to, along));
    const { w, h } = mapSize();
    goTo(fitView(points, w, h, 40), "section");
  }
  function pointTo(kind: NonNullable<Highlight>["kind"], distance: number) {
    if (!route) return;
    highlight = { kind, distance: Math.max(0, Math.min(route.distanceMeters, distance)) };
    section = null; sectionIsSteepest = false;
    const [lon, lat] = routePointAt(route, highlight.distance, along);
    const { w, h } = mapSize();
    const [sx, sy] = toScreen(view, w, h, worldX(lon), worldY(lat));
    const whole = fitView(route.coordinates, w, h, 30);
    // Bring it into view (closer than the whole route), unless it already is, comfortably.
    const inside = sx > w * 0.12 && sx < w * 0.88 && sy > h * 0.12 && sy < h * 0.88 && view.zoom >= whole.zoom + 0.9;
    if (!inside) goTo({ cx: worldX(lon), cy: worldY(lat), zoom: Math.min(15.5, Math.max(view.zoom, whole.zoom + 1.6)) }, "point");
    else { viewKind = "point"; report(); invalidate(); }
    emitSelection(highlight.distance);
  }
  function emitSelection(distance: number) {
    if (!route) return;
    const [lon, lat] = routePointAt(route, distance, along), e = elevationAt(route, distance);
    ctx.emit.selection({
      objectId: "route-point", name: `${(distance / 1000).toFixed(1)} km along the route`, kind: "route point",
      properties: { distance_km: Math.round(distance / 100) / 10, ...(e === null ? {} : { elevation_m: Math.round(e) }), lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 },
    });
  }
  function zoomBy(delta: number, at?: [number, number]) {
    const { w, h } = mapSize();
    const [sx, sy] = at ?? [w / 2, h / 2];
    const [wx, wy] = toWorld(view, w, h, sx, sy);
    const zoom = clampZoom(view.zoom + delta), k = 2 ** zoom;
    animation = null;
    view = { cx: wx - (sx - w / 2) / k, cy: wy - (sy - h / 2) / k, zoom };
    viewKind = "custom"; report(); invalidate();
  }

  // ── Pointer and keys ───────────────────────────────────────────────────────────────────────────────────────────
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  const local = (event: PointerEvent | WheelEvent | MouseEvent, canvas: HTMLCanvasElement): [number, number] => { const r = canvas.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top]; };
  const setCursor = (distance: number | null) => { if (distance === cursor) return; cursor = distance; ctx.emit.cursor(distance); invalidate(); };
  mapCanvas.addEventListener("pointerdown", event => {
    mapCanvas.setPointerCapture(event.pointerId); ctx.emit.interaction("pointer-down");
    drag = { x: event.clientX, y: event.clientY, cx: view.cx, cy: view.cy, moved: false };
    animation = null;
  });
  mapCanvas.addEventListener("pointermove", event => {
    if (!route) return;
    const { w, h } = mapSize();
    if (drag && mapCanvas.hasPointerCapture(event.pointerId)) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) { const k = 2 ** view.zoom; view = { ...view, cx: drag.cx - dx / k, cy: drag.cy - dy / k }; viewKind = "custom"; invalidate(); }
      return;
    }
    const [x, y] = local(event, mapCanvas);
    setCursor(nearestAlong(routeScreen(w, h), along, x, y)?.distance ?? null);
  });
  mapCanvas.addEventListener("pointerup", event => {
    ctx.emit.interaction("pointer-up");
    const wasClick = drag && !drag.moved;
    drag = null;
    if (!route) return;
    if (!wasClick) { report(); return; }
    const { w, h } = mapSize(), [x, y] = local(event, mapCanvas);
    const hit = nearestAlong(routeScreen(w, h), along, x, y, 14);
    if (hit) { highlight = { kind: "point", distance: hit.distance }; section = null; viewKind = "point"; emitSelection(hit.distance); report(); invalidate(); }
  });
  mapCanvas.addEventListener("pointerleave", () => { if (!drag) setCursor(null); });
  mapCanvas.addEventListener("wheel", event => { event.preventDefault(); ctx.emit.interaction("wheel"); zoomBy(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0022), local(event, mapCanvas)); }, { passive: false });
  mapCanvas.addEventListener("dblclick", event => zoomBy(1, local(event, mapCanvas)));
  mapCanvas.addEventListener("keydown", event => {
    const k = 2 ** view.zoom, step = 60 / k;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) { view = { ...view, cx: view.cx + moves[event.key][0], cy: view.cy + moves[event.key][1] }; viewKind = "custom"; report(); invalidate(); event.preventDefault(); }
    else if (event.key === "+" || event.key === "=") zoomBy(1);
    else if (event.key === "-") zoomBy(-1);
    else if (event.key === "0") frameRoute();
    else if (event.key === "Escape") ctx.emit.interaction("escape");
  });

  // The profile: point to read it (the map and the terrain follow), click to mark a point, drag to frame a section.
  let sweep: { x: number; moved: boolean } | null = null;
  const distanceAt = (x: number) => Math.max(0, Math.min(profileGeometry.total, (x - profileGeometry.left) / profileGeometry.pw * profileGeometry.total));
  profileCanvas.addEventListener("pointerdown", event => { profileCanvas.setPointerCapture(event.pointerId); ctx.emit.interaction("pointer-down"); sweep = { x: local(event, profileCanvas)[0], moved: false }; });
  profileCanvas.addEventListener("pointermove", event => {
    if (!route || route.elevationSamples.length < 2) return;
    const [x] = local(event, profileCanvas);
    if (sweep && Math.abs(x - sweep.x) > 6) { sweep.moved = true; section = [distanceAt(Math.min(x, sweep.x)), distanceAt(Math.max(x, sweep.x))]; sectionIsSteepest = false; highlight = null; }
    setCursor(distanceAt(x));
  });
  profileCanvas.addEventListener("pointerup", event => {
    ctx.emit.interaction("pointer-up");
    if (!route || !sweep) { sweep = null; return; }
    const [x] = local(event, profileCanvas), moved = sweep.moved;
    sweep = null;
    if (moved && section && section[1] - section[0] >= 50) frameSection(section[0], section[1]);
    else pointTo("point", distanceAt(x));
  });
  profileCanvas.addEventListener("pointerleave", () => { if (!sweep) setCursor(null); });
  profileCanvas.addEventListener("keydown", event => {
    if (!route) return;
    const step = route.distanceMeters / 100, at = highlight?.distance ?? cursor ?? 0;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") { pointTo("point", at + (event.key === "ArrowRight" ? step : -step)); event.preventDefault(); }
  });

  // ── The route itself ───────────────────────────────────────────────────────────────────────────────────────────
  function showSummary(r: GeoRoute) {
    title.textContent = `${r.origin.name} → ${r.destination.name}`;
    mode.textContent = MODE_LABEL[r.travelMode];
    via.textContent = r.waypoints.length ? `via ${r.waypoints.map(w => w.name).join(", ")}` : "";
    via.hidden = !r.waypoints.length;
    const items: [string, string][] = [["Distance", formatDistance(r.distanceMeters)], ["Time", `≈ ${formatDuration(r.estimatedDurationSeconds)}`]];
    if (r.totalAscentMeters !== null) items.push(["Ascent", `↑ ${r.totalAscentMeters} m`], ["Descent", `↓ ${r.totalDescentMeters} m`], ["Elevation", `${r.minimumElevationMeters}–${r.maximumElevationMeters} m`]);
    stats.replaceChildren(...items.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
    attribution.textContent = `© OpenStreetMap contributors · ${r.source.routing}`;
    attribution.title = `${r.source.attribution} · Elevation: ${r.source.elevation}`;
    const shown = r.warnings.find(w => !/^The route (starts|ends)/.test(w)) ?? r.warnings[0];
    note.hidden = !shown;
    note.textContent = shown ?? "";
    note.title = r.warnings.join("\n");
  }

  return {
    start() { ctx.emit.loading("Waiting for the route", 0.3); },
    loadRoute(next, document) {
      const checked = validateRoute(document);
      if (!checked.ok) return { ok: false, problem: checked.problem };
      const first = !route;
      const same = route && route.coordinates.length === checked.route.coordinates.length && route.coordinates[0][0] === checked.route.coordinates[0][0];
      route = checked.route; revision = next; along = routeAlong(route);
      highlight = null; section = null; sectionIsSteepest = false; cursor = null;
      showSummary(route);
      if (first || !same) { const fitted = fitRoute(); if (first) { view = fitted; viewKind = "route"; } else goTo(fitted, "route"); }
      ctx.emit.loading("Route drawn", 1);
      report(); invalidate();
      return { ok: true };
    },
    async loadTile(tile, mime, data) {
      if (disposed) return;
      const key = tileKey(tile);
      try {
        const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
        if (disposed) { bitmap.close(); return; }
        tiles.get(key)?.close();
        tiles.set(key, bitmap);
        // A bounded cache: the tiles furthest from the view's zoom go first.
        if (tiles.size > 220) {
          const z = tileZoom(view);
          const victims = [...tiles.keys()].sort((a, b) => Math.abs(Number(b.split("/")[0]) - z) - Math.abs(Number(a.split("/")[0]) - z)).slice(0, tiles.size - 180);
          for (const v of victims) { tiles.get(v)?.close(); tiles.delete(v); requested.delete(v); }
        }
        invalidate();
      } catch { /* an undecodable tile is simply not drawn */ }
    },
    command(name, value): CommandResult {
      if (!route) return { ok: false, problem: "no route yet" };
      switch (name) {
        case "show": {
          if (value === "route") { highlight = null; frameRoute(); return { ok: true }; }
          if (value === "highest" || value === "lowest") {
            const point = value === "highest" ? route.highest : route.lowest;
            if (!point) return { ok: false, problem: "this route has no elevation data" };
            pointTo(value, point.distanceMeters); return { ok: true };
          }
          if (value === "start") { pointTo("start", 0); return { ok: true }; }
          if (value === "end") { pointTo("end", route.distanceMeters); return { ok: true }; }
          if (value === "steepest") {
            const climb = steepestClimb(route.elevationSamples, Math.min(500, route.distanceMeters / 4));
            if (!climb) return { ok: false, problem: route.elevationSamples.length ? "the route has no climb" : "this route has no elevation data" };
            frameSection(climb.from, climb.to, true); return { ok: true };
          }
          return { ok: false, problem: "unknown view" };
        }
        case "section": {
          const parsed = typeof value === "string" ? parseSection(value, route.distanceMeters) : null;
          if (!parsed) return { ok: false, problem: `give two distances within 0–${(route.distanceMeters / 1000).toFixed(1)} km, e.g. "12-30"` };
          frameSection(parsed[0], parsed[1]); return { ok: true };
        }
        case "point-at": {
          if (typeof value !== "number" || value * 1000 > route.distanceMeters + 1) return { ok: false, problem: `the route is ${(route.distanceMeters / 1000).toFixed(1)} km long` };
          pointTo("point", value * 1000); return { ok: true };
        }
        case "clear-highlight": highlight = null; section = null; sectionIsSteepest = false; viewKind = "custom"; report(); invalidate(); return { ok: true };
        default: return { ok: false, problem: `unknown command ${name}` };
      }
    },
    flush() { report(); },
    pause() { /* nothing runs on its own */ },
    resume() { invalidate(); },
    suspend(on) { suspended = on; if (on && frame) { cancelAnimationFrame(frame); frame = 0; } if (!on) invalidate(); },
    reset() { highlight = null; frameRoute(); },
    resize() { invalidate(); },
    status(): ResourceStatus {
      return { fps: drawn && performance.now() - lastDraw < 1000 ? 60 : 0, frameMs: 0, drawCalls: drawn, triangles: 0, geometries: 0, textures: tiles.size, programs: 0, rendering: frame !== 0 || animation !== null };
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const bitmap of tiles.values()) bitmap.close();
      tiles.clear(); requested.clear();
      root.remove();
      return { geometries: 0, textures: 0, urls: 0, loops: 0 };
    },
  };
}
