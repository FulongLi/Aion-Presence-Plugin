import { Path } from "../../visual/forms/geometry/path";
import { composeWriting } from "./compose";
import { STROKE_LIMITS, STROKE_SPACE, type StrokePack, type StrokeSequence, type SymbolSpec } from "./types";

/**
 * The Stroke Path Processor: authored stroke paths → normalized, ordered, measured strokes. Lines and quadratic and
 * cubic curves are flattened by the shared path builder (visual/forms/geometry/path.ts); elliptical arcs here. Pure.
 */
type Command = { op: "M" | "L"; x: number; y: number } | { op: "Q"; cx: number; cy: number; x: number; y: number }
  | { op: "C"; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: "E"; cx: number; cy: number; rx: number; ry: number; from: number; to: number };

const ARITY = { M: 2, L: 2, Q: 4, C: 6, E: 6 } as const;

/** Parses a stroke's path; throws "stroke-path-invalid" on anything malformed (a pack bug, caught by the tests). */
export function parseStrokePath(d: string): Command[] {
  const tokens = d.trim().split(/[\s,]+/);
  const out: Command[] = [];
  for (let i = 0; i < tokens.length;) {
    const op = tokens[i++] as keyof typeof ARITY;
    const arity = ARITY[op];
    if (arity === undefined) throw new Error("stroke-path-invalid");
    const v = tokens.slice(i, i + arity).map(Number);
    if (v.length !== arity || !v.every(Number.isFinite)) throw new Error("stroke-path-invalid");
    i += arity;
    // One continuous movement: it starts with M (or an arc, which starts at its own start) and never moves again.
    if (op === "M" ? out.length > 0 : out.length === 0 && op !== "E") throw new Error("stroke-path-invalid");
    switch (op) {
      case "M": case "L": out.push({ op, x: v[0], y: v[1] }); break;
      case "Q": out.push({ op, cx: v[0], cy: v[1], x: v[2], y: v[3] }); break;
      case "C": out.push({ op, c1x: v[0], c1y: v[1], c2x: v[2], c2y: v[3], x: v[4], y: v[5] }); break;
      case "E": out.push({ op, cx: v[0], cy: v[1], rx: v[2], ry: v[3], from: v[4], to: v[5] }); break;
    }
  }
  if (!out.length) throw new Error("stroke-path-invalid");
  return out;
}

/** Flattens commands into one polyline, mapping authoring units with `map` first (so flattening is in normalized units). */
function flatten(commands: Command[], map: (x: number, y: number) => [number, number], scale: number): number[] {
  const path = new Path();
  for (const c of commands) {
    switch (c.op) {
      case "M": path.moveTo(...map(c.x, c.y)); break;
      case "L": path.lineTo(...map(c.x, c.y)); break;
      case "Q": { const [cx, cy] = map(c.cx, c.cy), [x, y] = map(c.x, c.y); path.quadTo(cx, cy, x, y); break; }
      case "C": { const [ax, ay] = map(c.c1x, c.c1y), [bx, by] = map(c.c2x, c.c2y), [x, y] = map(c.x, c.y); path.cubicTo(ax, ay, bx, by, x, y); break; }
      case "E": {
        // Ramanujan's perimeter, for the flattening density.
        const a = c.rx * scale, b = c.ry * scale, sweep = Math.abs(c.to - c.from) / 360;
        const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))) * sweep;
        const n = Math.max(8, Math.ceil(perimeter * 48));
        for (let i = 0; i <= n; i++) {
          const angle = (c.from + (c.to - c.from) * i / n) * Math.PI / 180;
          const [x, y] = map(c.cx + Math.cos(angle) * c.rx, c.cy + Math.sin(angle) * c.ry);
          if (i === 0 && !path.lines.length) path.moveTo(x, y); else path.lineTo(x, y);
        }
        break;
      }
    }
  }
  const line = path.lines.flat();
  const flat: number[] = [];
  for (const [x, y] of line) {
    // Drop repeated points (a line joining an arc at its own start).
    if (flat.length && Math.hypot(x - flat[flat.length - 2], y - flat[flat.length - 1]) < 1e-6) continue;
    flat.push(x, y);
  }
  return flat;
}

/** Length of a flat polyline. */
export function flatLength(points: readonly number[]): number {
  let length = 0;
  for (let i = 2; i < points.length; i += 2) length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return length;
}

/** Cumulative arc length at each vertex (the first is 0). */
export function arcLengths(points: readonly number[]): Float64Array {
  const out = new Float64Array(points.length / 2);
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  return out;
}

/** The point at fraction `u` (0…1) of a polyline's length, and the unit tangent there. */
export function pointAlong(points: readonly number[], u: number, lengths = arcLengths(points)): { x: number; y: number; tx: number; ty: number } {
  const total = lengths[lengths.length - 1];
  const s = Math.max(0, Math.min(1, Number.isFinite(u) ? u : 0)) * total;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < s) i++;
  const a = lengths[i - 1], b = lengths[i], k = b > a ? (s - a) / (b - a) : 0;
  const x0 = points[i * 2 - 2], y0 = points[i * 2 - 1], x1 = points[i * 2], y1 = points[i * 2 + 1];
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, tx: (x1 - x0) / len, ty: (y1 - y0) / len };
}

/** A direction in words, by eight sectors: right, up, left or down within 22.5°, otherwise the diagonal it leans toward. */
function compass(dx: number, dy: number): string {
  const angle = Math.atan2(dy, dx) * 180 / Math.PI, near = (a: number) => Math.abs(((angle - a + 540) % 360) - 180) <= 22.5;
  if (near(0)) return "right";
  if (near(90)) return "up";
  if (near(180)) return "left";
  if (near(-90)) return "down";
  return `${dy > 0 ? "up" : "down"}-${dx > 0 ? "right" : "left"}`;
}

/** A polyline resampled at an even spacing (its ends kept). */
function resample(points: readonly number[], step: number): number[] {
  const lengths = arcLengths(points), total = lengths[lengths.length - 1];
  const n = Math.max(2, Math.ceil(total / step) + 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const p = pointAlong(points, i / (n - 1), lengths); out.push(p.x, p.y); }
  return out;
}

const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const DEG = Math.PI / 180;

/**
 * Where the pen goes, in words, from the stroke's own geometry (v0.4.4): the stroke is split at its sharp corners;
 * each piece is straight ("right"), a curve with its sense ("up-left, curving anticlockwise"), an S ("left, curving
 * anticlockwise, then clockwise") or a loop; a short last piece after a corner is a hook ("a hook up-left"). The
 * small wobbles of a measured centre line (a Chinese character's median) are not movements of the pen.
 */
export function describeDirection(input: readonly number[]): string {
  if (input.length < 4) return "a dot";
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < input.length; i += 2) { x0 = Math.min(x0, input[i]); x1 = Math.max(x1, input[i]); y0 = Math.min(y0, input[i + 1]); y1 = Math.max(y1, input[i + 1]); }
  const length = flatLength(input);
  if (Math.max(x1 - x0, y1 - y0) < 0.07 || length < 0.08) return "a dot";
  const step = Math.max(0.004, length / 160);
  const pts = resample(simplifyPolyline(input, 0.012), step);
  const n = pts.length / 2;
  const heading: number[] = [];
  for (let i = 1; i < n; i++) heading.push(Math.atan2(pts[i * 2 + 1] - pts[i * 2 - 1], pts[i * 2] - pts[i * 2 - 2]));
  const turn = heading.slice(1).map((h, i) => wrap(h - heading[i]));
  // Corners: a sharp change of heading (over 60°) within a short distance (≈ 0.12: a brush turns a corner in a moment).
  const window = Math.max(1, Math.round(Math.max(0.04, Math.min(0.12, length * 0.1)) / step));
  const corners: number[] = [];
  for (let i = 0; i < turn.length; i++) {
    let sum = 0;
    for (let k = i; k < Math.min(turn.length, i + window); k++) sum += turn[k];
    if (Math.abs(sum) > 60 * DEG && (!corners.length || i - corners[corners.length - 1] > window)) {
      // The corner sits where the turn is sharpest inside the window.
      let at = i, best = 0;
      for (let k = i; k < Math.min(turn.length, i + window); k++) if (Math.abs(turn[k]) > best) { best = Math.abs(turn[k]); at = k; }
      corners.push(at + 1);
      i = at + window;
    }
  }
  let cuts = [0, ...corners, heading.length];
  // A short lead-in before the first corner (a brush's entry in a measured median) belongs to the movement after it.
  if (cuts.length > 2 && (cuts[1] - cuts[0]) * step < length * 0.12) cuts = [0, ...cuts.slice(2)];
  const words: string[] = [];
  const sense = (k: number) => k > 0 ? "anticlockwise" : "clockwise";
  for (let p = 0; p < cuts.length - 1; p++) {
    const a = cuts[p], b = cuts[p + 1];
    if (b - a < 1) continue;
    const piece = heading.slice(a, b);
    // The turning inside the piece, away from the corners that bound it (their turn belongs to the corner).
    const trimA = p > 0 ? Math.min(window, Math.floor((b - a) / 3)) : 0, trimB = p < cuts.length - 2 ? Math.min(window, Math.floor((b - a) / 3)) : 0;
    const turns = turn.slice(a + trimA, Math.max(a + trimA, b - 1 - trimB));
    const net = turns.reduce((sum, t) => sum + t, 0), absolute = turns.reduce((sum, t) => sum + Math.abs(t), 0);
    const chordX = pts[b * 2] - pts[a * 2], chordY = pts[b * 2 + 1] - pts[a * 2 + 1];
    const pieceLength = piece.length * step;
    const hook = p > 0 && p === cuts.length - 2 && pieceLength < length * 0.16;
    const mean = (hs: number[]) => Math.atan2(hs.reduce((s, h) => s + Math.sin(h), 0), hs.reduce((s, h) => s + Math.cos(h), 0));
    let word: string;
    if (absolute < 60 * DEG || hook) word = compass(chordX, chordY);
    else if (Math.abs(net) >= 300 * DEG) word = `a loop, ${sense(net)}`;
    else {
      const k = Math.max(1, Math.round(piece.length * 0.15));
      const start = mean(piece.slice(trimA, trimA + k)), finish = mean(piece.slice(Math.max(0, piece.length - trimB - k), piece.length - trimB));
      // Senses in order, ignoring wobbles: an S turns one way, then the other.
      const senses: number[] = [];
      let run = 0;
      for (const t of turns) {
        if (Math.sign(t) !== Math.sign(run) && Math.abs(run) > 50 * DEG) { senses.push(Math.sign(run)); run = 0; }
        run += t;
      }
      if (Math.abs(run) > 50 * DEG) senses.push(Math.sign(run));
      const merged = senses.filter((value, i) => i === 0 || value !== senses[i - 1]);
      const from = compass(Math.cos(start), Math.sin(start)), to = compass(Math.cos(finish), Math.sin(finish));
      if (merged.length >= 2) word = `${from}, curving ${sense(merged[0])}, then ${sense(merged[1])}`;
      else if (Math.abs(net) < 45 * DEG) word = compass(chordX, chordY);
      else word = Math.abs(net) >= 100 * DEG && to !== from ? `${from}, curving ${sense(net)} to ${to}` : `${from}, curving ${sense(net)}`;
    }
    word = `${hook ? "a hook " : ""}${word}`;
    if (words[words.length - 1] !== word) words.push(word);
  }
  return words.slice(0, 4).join(", then ") || compass(input[input.length - 2] - input[0], input[input.length - 1] - input[1]);
}

/** Ramer–Douglas–Peucker simplification of a flat polyline, keeping its ends. */
export function simplifyPolyline(points: readonly number[], epsilon: number): number[] {
  const n = points.length / 2;
  if (n <= 2) return [...points];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = points[a * 2], ay = points[a * 2 + 1], bx = points[b * 2], by = points[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let worst = -1, far = 0;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * 2] - ax, py = points[i * 2 + 1] - ay;
      const d = len > 1e-12 ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      if (d > far) { far = d; worst = i; }
    }
    if (worst >= 0 && far > epsilon) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/** Seconds to write a stroke at normal speed: unhurried, longer strokes taking longer. */
export const strokeSeconds = (length: number) => Math.max(0.45, Math.min(3.4, 0.4 + length * 0.46));

/**
 * A curated symbol's strokes, flattened in normalized units through `map` (authoring → normalized; `scale` is its
 * factor): each stroke's ordered centre line, its pen width at start and end, its name and any hand-written description.
 */
export function curatedStrokes(pack: StrokePack, spec: SymbolSpec, map: (x: number, y: number) => [number, number], scale: number) {
  return spec.strokes.map(stroke => {
    const path = flatten(parseStrokePath(stroke.d), map, scale);
    const w = pack.width * (stroke.width ?? 1), taper = stroke.taper ?? [1, 1];
    return { path, width: [w * taper[0], w * taper[1]] as [number, number], name: stroke.name, say: stroke.say };
  });
}

/** Builds a pack's symbol into its normalized, measured, ordered sequence (one item; see compose.ts). */
export function buildSequence(pack: StrokePack, spec: SymbolSpec): StrokeSequence {
  return composeWriting({ system: pack.system, text: spec.symbol, title: spec.title, pieces: [{ type: "symbol", id: `${pack.system}:${spec.symbol}` }] },
    () => ({ pack, spec }));
}

/** The pause between two strokes: the pen lifts, travels and settles. */
export const gapSeconds = (from: readonly [number, number], to: readonly [number, number]) =>
  0.34 + Math.min(0.5, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.22);

/** Strokes and the pauses between them, at normal speed. */
export function writingSeconds(sequence: Pick<StrokeSequence, "strokes">): number {
  return sequence.strokes.reduce((sum, stroke) => sum + stroke.pause + stroke.duration, 0);
}

/** A symbol's own horizontal extent (its points and control points, plus a margin) inside the pack's vertical extent. */
export function autoBox(box: readonly [number, number, number, number], strokes: readonly { d: string }[]): [number, number, number, number] {
  const commands = strokes.map(stroke => parseStrokePath(stroke.d));
  let low = Infinity, high = -Infinity;
  const see = (x: number) => { low = Math.min(low, x); high = Math.max(high, x); };
  for (const command of commands.flat()) {
    if (command.op === "E") { see(command.cx - command.rx); see(command.cx + command.rx); continue; }
    see(command.x);
    if (command.op === "Q") see(command.cx);
    if (command.op === "C") { see(command.c1x); see(command.c2x); }
  }
  const margin = 12;
  return [low - margin, box[1], high + margin, box[3]];
}

/** Faint context: a practice grid (田字格 with its diagonals dashed), a five-line staff, or writing lines. */
export function guides(kind: StrokePack["guide"], box: readonly [number, number, number, number], map: (x: number, y: number) => [number, number]): number[][] {
  const [left, bottom, right, top] = box;
  const line = (x0: number, y0: number, x1: number, y1: number) => [...map(x0, y0), ...map(x1, y1)];
  switch (kind) {
    case "grid": {
      const out = [line(left, bottom, right, bottom), line(right, bottom, right, top), line(right, top, left, top), line(left, top, left, bottom)];
      const mx = (left + right) / 2, my = (bottom + top) / 2;
      // Dashed centre lines and diagonals (米字格), as short segments.
      const dashed = (x0: number, y0: number, x1: number, y1: number) => {
        const steps = 14;
        for (let i = 0; i < steps; i += 2) out.push(line(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, x0 + (x1 - x0) * (i + 1) / steps, y0 + (y1 - y0) * (i + 1) / steps));
      };
      dashed(left, my, right, my); dashed(mx, bottom, mx, top); dashed(left, bottom, right, top); dashed(left, top, right, bottom);
      return out;
    }
    case "staff": return [0, 1, 2, 3, 4].map(k => line(left, k * 10, right, k * 10));
    case "lines": return [line(left, 0, right, 0), line(left, 100, right, 100), ...Array.from({ length: 8 }, (_, i) => line(left + (right - left) * i / 8, 50, left + (right - left) * (i + 0.5) / 8, 50))];
    default: return [];
  }
}

/** Checks a built sequence against every bound; throws "stroke-sequence-invalid". */
export function validateSequence(sequence: StrokeSequence) {
  const fail = () => { throw new Error("stroke-sequence-invalid"); };
  if (!sequence.strokes.length || sequence.strokes.length > STROKE_LIMITS.strokes) fail();
  if (!sequence.items.length || sequence.items.length > STROKE_LIMITS.items) fail();
  const inStage = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= STROKE_SPACE.halfWidth + 0.12 && Math.abs(y) <= STROKE_SPACE.limit + 0.12;
  let vertices = 0;
  sequence.strokes.forEach((stroke, i) => {
    if (stroke.order !== i + 1 || stroke.path.length < 4 || stroke.path.length % 2) fail();
    for (let k = 0; k < stroke.path.length; k += 2) if (!inStage(stroke.path[k], stroke.path[k + 1])) fail();
    if (!(stroke.length >= STROKE_LIMITS.minLength) || !(stroke.duration > 0) || !(stroke.pause >= 0) || (i === 0 && stroke.pause !== 0)) fail();
    if (!stroke.width.every(w => w >= STROKE_LIMITS.width.min && w <= STROKE_LIMITS.width.max)) fail();
    vertices += stroke.path.length / 2;
    if (stroke.outline) {
      if (!stroke.outline.length) fail();
      for (const ring of stroke.outline) {
        if (ring.length < 6 || ring.length % 2) fail();
        for (let k = 0; k < ring.length; k += 2) if (!inStage(ring[k], ring[k + 1])) fail();
        vertices += ring.length / 2;
      }
    }
  });
  // Each item's strokes are contiguous and numbered from 1 in its own order.
  let next = 0;
  sequence.items.forEach((item, index) => {
    if (item.first !== next || item.count < 1 || item.count > STROKE_LIMITS.symbolStrokes) fail();
    for (let k = 0; k < item.count; k++) {
      const stroke = sequence.strokes[item.first + k];
      if (!stroke || stroke.item !== index || stroke.local !== k + 1) fail();
    }
    if (item.radical && !item.radical.every(k => Number.isInteger(k) && k >= 0 && k < item.count)) fail();
    next += item.count;
  });
  if (next !== sequence.strokes.length) fail();
  if (vertices > STROKE_LIMITS.vertices) fail();
}
