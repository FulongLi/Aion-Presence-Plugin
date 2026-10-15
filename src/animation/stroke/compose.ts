import { boundsOf, flattenOutline, HANZI_EM, outlineArea, polylineLength, type Rings } from "../../writing/hanzi/geometry";
import type { HanziData } from "../../writing/hanzi/codec";
import { autoBox, curatedStrokes, describeDirection, gapSeconds, guides, strokeSeconds, validateSequence } from "./path";
import { STROKE_LIMITS, STROKE_SPACE, type Stroke, type StrokePack, type StrokeSequence, type SymbolSpec, type WritingItem, type WritingSystem } from "./types";

/**
 * The Writing Education Core's composer (v0.4.4): what to write → one validated, timed StrokeSequence that the renderer,
 * the card and the controls share. One pipeline for every pack:
 *
 *   Chinese characters   true outlines + medians from the Chinese Writing Pack (Hanzi Writer data)
 *   letters, digits      curated manuscript pen paths (packs/latin.ts)
 *   music, mathematics   curated hand-copying pen paths (packs/symbols.ts)
 *
 * A word is several symbols laid side by side; each keeps its own strokes in its own order (the sequence lists them
 * one symbol after another — never one symbol's strokes interleaved with another's), and its own box. Every symbol of
 * a system shares one scale (Chinese: Hanzi Writer's em box), so nothing is stretched to fill a box.
 *
 * Pure and deterministic: the host composes a writing to describe it, the hub to time it, every surface to draw it —
 * from the same source, so all agree.
 */
export type WritingPiece =
  /** A curated symbol of a pack, by id ("latin:A", "digits:7", "music:𝄞"). */
  | { type: "symbol"; id: string }
  /** A Chinese character with its data from the pack. `title`: its reading and meaning, for the card. */
  | { type: "hanzi"; char: string; data: HanziData; title?: string }
  /** A gap between words. */
  | { type: "space" };

export interface WritingSource {
  system: WritingSystem;
  /** What is written ("永", "爱国", "HELLO", "𝄞"). */
  text: string;
  title: string;
  pieces: WritingPiece[];
}

/** The convention the Chinese data follows, cited in results and on the card. */
export const HANZI_CONVENTION = {
  variant: "makemeahanzi",
  convention: "Stroke shapes and order from Make Me a Hanzi / Hanzi Writer data (Arphic PL KaitiM GB and UKai outlines); simplified forms follow the mainland order",
} as const;

/** Space between two Chinese characters, and a word gap, in em units; the extra pause before a new symbol. */
const HANZI_GAP = 40, WORD_GAP = 0.45, ITEM_PAUSE = 0.3;

export interface PackLookup {
  /** The pack and spec of a curated symbol id, or null. */
  (id: string): { pack: StrokePack; spec: SymbolSpec } | null;
}

interface Placed {
  piece: Exclude<WritingPiece, { type: "space" }>;
  /** Authoring box [left, bottom, right, top] and where its left edge sits in the line. */
  box: readonly [number, number, number, number];
  x: number;
  pack?: StrokePack; spec?: SymbolSpec;
}

/** Corner-preserving smoothing of a median: curved runs become smooth (centripetal Catmull–Rom), sharp turns stay sharp. */
export function smoothMedian(points: readonly number[]): number[] {
  const n = points.length / 2;
  if (n < 3) return [...points];
  const P = (i: number): [number, number] => [points[Math.max(0, Math.min(n - 1, i)) * 2], points[Math.max(0, Math.min(n - 1, i)) * 2 + 1]];
  const sharp = (i: number) => {
    if (i <= 0 || i >= n - 1) return false;
    const [ax, ay] = P(i - 1), [bx, by] = P(i), [cx, cy] = P(i + 1);
    const a = Math.atan2(by - ay, bx - ax), b = Math.atan2(cy - by, cx - bx);
    let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
    return d > Math.PI / 3;
  };
  const out: number[] = [...P(0)];
  for (let i = 0; i < n - 1; i++) {
    const p1 = P(i), p2 = P(i + 1);
    // At a sharp corner the neighbour is mirrored, so the curve meets the corner with the segment's own direction.
    const p0 = sharp(i) || i === 0 ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : P(i - 1);
    const p3 = sharp(i + 1) || i + 1 === n - 1 ? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] : P(i + 2);
    const steps = Math.max(1, Math.min(8, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.02)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      // Uniform Catmull–Rom with tension ½; mirrored ends keep it from overshooting at corners.
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push(x, y);
    }
  }
  return out;
}

/**
 * A measured median often begins with the brush's entry — a short slant into the stroke before its real direction. For
 * describing where the pen goes, an entry within its first 10 % is
 * left out when it turns more than 40° from the stretch after it (the drawn path keeps it).
 */
export function trimLeadIn(points: number[]): number[] {
  const n = points.length / 2;
  if (n < 3) return points;
  const cumulative = [0];
  for (let i = 1; i < n; i++) cumulative.push(cumulative[i - 1] + Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]));
  const total = cumulative[n - 1];
  /** The point at `fraction` of the length (interpolated), and the index of the vertex after it. */
  const at = (fraction: number): [number, number, number] => {
    const s = total * fraction;
    let i = 1;
    while (i < n - 1 && cumulative[i] < s) i++;
    const k = (s - cumulative[i - 1]) / Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
    return [points[i * 2 - 2] + (points[i * 2] - points[i * 2 - 2]) * k, points[i * 2 - 1] + (points[i * 2 + 1] - points[i * 2 - 1]) * k, i];
  };
  const [x1, y1, i1] = at(0.1), [x2, y2] = at(0.2);
  let d = Math.abs(Math.atan2(y1 - points[1], x1 - points[0]) - Math.atan2(y2 - y1, x2 - x1));
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d > 40 * Math.PI / 180 ? [x1, y1, ...points.slice(i1 * 2)] : points;
}

/** A stroke's median in normalized units, with at least two distinct points (a one-point median runs to the outline's middle). */
function hanziPath(median: readonly (readonly [number, number])[], map: (x: number, y: number) => [number, number], rings: Rings): number[] {
  const flat = median.flatMap(([x, y]) => map(x, y));
  const deduped: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (deduped.length && Math.hypot(flat[i] - deduped[deduped.length - 2], flat[i + 1] - deduped[deduped.length - 1]) < 1e-6) continue;
    deduped.push(flat[i], flat[i + 1]);
  }
  if (deduped.length < 4) {
    const [x0, y0, x1, y1] = boundsOf(rings);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const [px, py] = [deduped[0] ?? cx, deduped[1] ?? cy];
    const far = Math.hypot(cx - px, cy - py) > 0.004 ? [cx, cy] : [px + 0.01, py - 0.01];
    return [px, py, far[0], far[1]];
  }
  return smoothMedian(deduped);
}

/**
 * Composes a writing. `lookup` finds curated symbols (the registry); Chinese characters carry their own data. Throws
 * "writing-invalid" on an empty or oversized writing, and "stroke-sequence-invalid" if the result breaks a bound.
 */
export function composeWriting(source: WritingSource, lookup: PackLookup): StrokeSequence {
  const pieces = source.pieces;
  const symbols = pieces.filter(piece => piece.type !== "space");
  if (!symbols.length || symbols.length > STROKE_LIMITS.items || pieces.length > STROKE_LIMITS.items * 2) throw new Error("writing-invalid");
  // ── Layout in authoring units ─────────────────────────────────────────────────────────────────────────────────────
  const placed: Placed[] = [];
  let cursor = 0, lastWidth = 0, bottom = Infinity, top = -Infinity;
  let pack0: StrokePack | null = null;
  for (const piece of pieces) {
    if (piece.type === "space") { cursor += lastWidth * WORD_GAP; continue; }
    if (piece.type === "hanzi") {
      if (placed.length) cursor += HANZI_GAP;
      const box = [HANZI_EM.left, HANZI_EM.bottom, HANZI_EM.right, HANZI_EM.top] as const;
      placed.push({ piece, box, x: cursor });
      cursor += HANZI_EM.size; lastWidth = HANZI_EM.size;
      bottom = Math.min(bottom, box[1]); top = Math.max(top, box[3]);
      continue;
    }
    const found = lookup(piece.id);
    if (!found) throw new Error("writing-invalid");
    // Letters and digits share one manuscript convention and one scale; other packs are written one symbol at a time.
    if (pack0 && (found.pack.variant !== pack0.variant || found.pack.guide !== pack0.guide)) throw new Error("writing-invalid");
    pack0 = found.pack;
    const { pack, spec } = found;
    const box = spec.box ?? (pack.autoWidth ? autoBox(pack.box, spec.strokes) : pack.box);
    placed.push({ piece, box, x: cursor, pack, spec });
    cursor += box[2] - box[0]; lastWidth = box[2] - box[0];
    bottom = Math.min(bottom, box[1]); top = Math.max(top, box[3]);
  }
  if (placed.some(item => item.piece.type === "hanzi") && pack0) throw new Error("writing-invalid");
  const width = cursor, height = top - bottom;
  if (!(width > 0 && height > 0)) throw new Error("writing-invalid");
  const single = placed.length === 1;
  const halfWidth = single ? STROKE_SPACE.limit : STROKE_SPACE.halfWidth;
  const scale = Math.min((halfWidth * 2) / width, (STROKE_SPACE.limit * 2) / height);
  const cx = width / 2, cy = (bottom + top) / 2;

  // ── Strokes, item by item ─────────────────────────────────────────────────────────────────────────────────────────
  const strokes: Stroke[] = [];
  const items: WritingItem[] = [];
  const guideLines: number[][] = [];
  placed.forEach((item, index) => {
    const [l, b, r, t] = item.box;
    const map = (x: number, y: number): [number, number] => [(item.x + (x - l) - cx) * scale, (y - cy) * scale];
    // How much smaller this symbol is drawn than it would be alone: strokes are timed as if written at full size.
    const alone = (STROKE_SPACE.limit * 2) / Math.max(r - l, t - b);
    const unit = Math.min(1, scale / alone);
    const first = strokes.length;
    let symbol: string, title: string, radical: number[] | undefined;
    if (item.piece.type === "hanzi") {
      const { char, data } = item.piece;
      symbol = char; title = item.piece.title ?? char;
      radical = data.radStrokes ? [...data.radStrokes] : undefined;
      if (data.strokes.length > STROKE_LIMITS.symbolStrokes) throw new Error("writing-invalid");
      data.strokes.forEach((outlinePath, k) => {
        const rings = flattenOutline(outlinePath, map);
        const path = hanziPath(data.medians[k], map, rings);
        // Words for the pen's movement come from the measured median itself (smoothing rounds its corners).
        const raw = trimLeadIn(data.medians[k].flatMap(([x, y]) => map(x, y)));
        const length = polylineLength(path);
        const area = outlineArea(rings);
        const w = Math.max(STROKE_LIMITS.width.min, Math.min(STROKE_LIMITS.width.max, length > 0 ? area / length : 0.05));
        strokes.push(makeStroke({ symbol, path, length, unit, width: [w, w], item: index, local: k + 1, outline: rings, describe: raw.length >= 4 ? raw : path }));
      });
      guideLines.push(...guides("grid", item.box, map));
    } else {
      const { pack, spec } = item;
      symbol = spec!.symbol; title = spec!.title;
      if (spec!.strokes.length > STROKE_LIMITS.symbolStrokes) throw new Error("writing-invalid");
      curatedStrokes(pack!, spec!, map, scale).forEach((stroke, k) => {
        strokes.push(makeStroke({ symbol, path: stroke.path, length: polylineLength(stroke.path), unit, width: stroke.width, item: index, local: k + 1,
          name: stroke.name, say: stroke.say }));
      });
    }
    // The pause before each stroke: the pen lifts and travels; a new symbol adds a moment.
    for (let k = first; k < strokes.length; k++) {
      if (k === 0) { strokes[k].pause = 0; continue; }
      const from = strokes[k - 1].endPoint, to = strokes[k].startPoint;
      const travel = gapSeconds([from[0] / unit, from[1] / unit], [to[0] / unit, to[1] / unit]);
      strokes[k].pause = travel + (k === first ? ITEM_PAUSE : 0);
    }
    items.push({ symbol, title, first, count: strokes.length - first, box: [map(l, b)[0], map(l, b)[1], map(r, t)[0], map(r, t)[1]], ...(radical ? { radical } : {}) });
  });
  strokes.forEach((stroke, i) => { stroke.order = i + 1; stroke.id = `${items[stroke.item].symbol}-${stroke.local}`; });
  // Writing lines and staves run under the whole word; a practice grid stands under each character.
  if (pack0 && pack0.guide !== "grid") guideLines.push(...guides(pack0.guide, [0, bottom, width, top], (x, y) => [(x - cx) * scale, (y - cy) * scale]));
  const hanzi = placed[0].piece.type === "hanzi";
  const firstSpec = placed[0].spec;
  const sequence: StrokeSequence = {
    id: `${source.system}:${source.text}`,
    symbol: source.text, title: source.title, writingSystem: source.system,
    variant: hanzi ? HANZI_CONVENTION.variant : pack0!.variant,
    convention: hanzi ? HANZI_CONVENTION.convention : pack0!.convention,
    ...(!hanzi && single && firstSpec?.note ? { note: firstSpec.note } : {}),
    strokes, guides: guideLines, items, totalDuration: 0,
  };
  sequence.totalDuration = strokes.reduce((sum, stroke) => sum + stroke.pause + stroke.duration, 0);
  validateSequence(sequence);
  return sequence;
}

function makeStroke(options: {
  symbol: string; path: number[]; length: number; unit: number; width: [number, number]; item: number; local: number;
  outline?: Rings; name?: Stroke["name"]; say?: string; describe?: number[];
}): Stroke {
  const { path } = options;
  return {
    id: `${options.symbol}-${options.local}`, order: 0, path,
    startPoint: [path[0], path[1]], endPoint: [path[path.length - 2], path[path.length - 1]],
    direction: options.say ?? describeDirection(options.describe ?? path), length: options.length, duration: strokeSeconds(options.length / options.unit),
    width: options.width, item: options.item, local: options.local, pause: 0,
    ...(options.name ? { name: options.name } : {}), ...(options.outline ? { outline: options.outline } : {}),
  };
}
