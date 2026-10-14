import { Path } from "../../visual/forms/geometry/path";
import { STROKE_LIMITS, STROKE_SPACE, type Stroke, type StrokePack, type StrokeSequence, type SymbolSpec } from "./types";

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

/** A direction in words: straight right, up, left or down within 15°, otherwise the diagonal it leans toward. */
function compass(dx: number, dy: number): string {
  const angle = Math.atan2(dy, dx) * 180 / Math.PI, near = (a: number) => Math.abs(((angle - a + 540) % 360) - 180) <= 15;
  if (near(0)) return "right";
  if (near(90)) return "up";
  if (near(180)) return "left";
  if (near(-90)) return "down";
  return `${dy > 0 ? "up" : "down"}-${dx > 0 ? "right" : "left"}`;
}

/**
 * Where the pen goes, in words, from the stroke's own geometry: its straight runs between sharp turns ("right, then
 * down, then a hook left"), or a loop and its sense for a stroke that turns all the way round.
 */
export function describeDirection(points: readonly number[]): string {
  const n = points.length / 2;
  if (n < 2) return "a dot";
  // Total turning tells a loop and its sense.
  let turning = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = Math.atan2(points[i * 2 + 1] - points[i * 2 - 1], points[i * 2] - points[i * 2 - 2]);
    const b = Math.atan2(points[i * 2 + 3] - points[i * 2 + 1], points[i * 2 + 2] - points[i * 2]);
    let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    turning += d;
  }
  const length = flatLength(points);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, points[i * 2]); x1 = Math.max(x1, points[i * 2]); y0 = Math.min(y0, points[i * 2 + 1]); y1 = Math.max(y1, points[i * 2 + 1]); }
  if (Math.max(x1 - x0, y1 - y0) < 0.07) return "a dot";
  if (Math.abs(turning) > Math.PI * 1.6) return `a loop, ${turning > 0 ? "anticlockwise" : "clockwise"}`;
  // Runs: split where the direction turns sharply (more than 50°) over a short distance.
  const runs: { dx: number; dy: number; length: number }[] = [];
  let run = { dx: 0, dy: 0, length: 0 };
  let heading: number | null = null;
  for (let i = 1; i < n; i++) {
    const dx = points[i * 2] - points[i * 2 - 2], dy = points[i * 2 + 1] - points[i * 2 - 1], len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const angle = Math.atan2(dy, dx);
    if (heading !== null) {
      let d = angle - heading; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 50 * Math.PI / 180 && run.length > 0) { runs.push(run); run = { dx: 0, dy: 0, length: 0 }; }
    }
    heading = angle;
    run.dx += dx; run.dy += dy; run.length += len;
  }
  if (run.length > 0) runs.push(run);
  const words: string[] = [];
  runs.forEach((r, i) => {
    // A short last run after a turn is a hook.
    const hook = i > 0 && i === runs.length - 1 && r.length < length * 0.16;
    const word = `${hook ? "a hook " : ""}${compass(r.dx, r.dy)}`;
    if (words[words.length - 1] !== word) words.push(word);
  });
  if (words.length === 1 && Math.abs(turning) > Math.PI * 0.55) return `${words[0]}, curving ${turning > 0 ? "anticlockwise" : "clockwise"}`;
  return words.slice(0, 4).join(", then ");
}

/** Seconds to write a stroke at normal speed: unhurried, longer strokes taking longer. */
export const strokeSeconds = (length: number) => Math.max(0.45, Math.min(3.4, 0.4 + length * 0.46));

/** Builds a pack's symbol into its normalized, measured, ordered sequence. */
export function buildSequence(pack: StrokePack, spec: SymbolSpec): StrokeSequence {
  const commands = spec.strokes.map(stroke => parseStrokePath(stroke.d));
  const box = spec.box ?? (pack.autoWidth ? autoBox(pack.box, commands) : pack.box);
  const [left, bottom, right, top] = box;
  const width = right - left, height = top - bottom;
  if (!(width > 0 && height > 0)) throw new Error("stroke-box-invalid");
  const scale = (STROKE_SPACE.limit * 2) / Math.max(width, height);
  const cx = (left + right) / 2, cy = (bottom + top) / 2;
  const map = (x: number, y: number): [number, number] => [(x - cx) * scale, (y - cy) * scale];
  const strokes: Stroke[] = spec.strokes.map((stroke, index) => {
    const path = flatten(commands[index], map, scale);
    const length = flatLength(path);
    const w = pack.width * (stroke.width ?? 1), taper = stroke.taper ?? [1, 1];
    return {
      id: `${spec.symbol}-${index + 1}`, order: index + 1, path,
      startPoint: [path[0], path[1]], endPoint: [path[path.length - 2], path[path.length - 1]],
      direction: stroke.say ?? describeDirection(path), length, duration: strokeSeconds(length),
      width: [w * taper[0], w * taper[1]], ...(stroke.name ? { name: stroke.name } : {}),
    };
  });
  const sequence: StrokeSequence = {
    id: `${pack.system}:${spec.symbol}`, symbol: spec.symbol, title: spec.title, writingSystem: pack.system, variant: pack.variant,
    convention: pack.convention, ...(spec.note ? { note: spec.note } : {}), strokes, guides: guides(pack.guide, box, map),
    totalDuration: 0,
  };
  sequence.totalDuration = writingSeconds(sequence);
  validateSequence(sequence);
  return sequence;
}

/** The pause between two strokes: the pen lifts, travels and settles. */
export const gapSeconds = (from: readonly [number, number], to: readonly [number, number]) =>
  0.34 + Math.min(0.5, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.22);

/** Strokes and the pauses between them, at normal speed. */
export function writingSeconds(sequence: Pick<StrokeSequence, "strokes">): number {
  return sequence.strokes.reduce((sum, stroke, i) => sum + stroke.duration + (i ? gapSeconds(sequence.strokes[i - 1].endPoint, stroke.startPoint) : 0), 0);
}

/** A symbol's own horizontal extent (its points and control points, plus a margin) inside the pack's vertical extent. */
function autoBox(box: readonly [number, number, number, number], commands: Command[][]): [number, number, number, number] {
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
function guides(kind: StrokePack["guide"], box: readonly [number, number, number, number], map: (x: number, y: number) => [number, number]): number[][] {
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
  let vertices = 0;
  sequence.strokes.forEach((stroke, i) => {
    if (stroke.order !== i + 1 || stroke.path.length < 4 || stroke.path.length % 2) fail();
    if (!stroke.path.every(v => Number.isFinite(v) && Math.abs(v) <= STROKE_SPACE.limit + 0.08)) fail();
    if (!(stroke.length >= STROKE_LIMITS.minLength) || !(stroke.duration > 0)) fail();
    if (!stroke.width.every(w => w >= STROKE_LIMITS.width.min && w <= STROKE_LIMITS.width.max)) fail();
    vertices += stroke.path.length / 2;
  });
  if (vertices > STROKE_LIMITS.vertices) fail();
}
