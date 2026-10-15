import { insideOutline, distanceToRings } from "../../writing/hanzi/geometry";
import { outlineRings } from "./glyphForms";
import { BRAVURA, type BravuraGlyph } from "./bravura";
import { parseStrokePath } from "../../animation/stroke/path";
import type { SymbolSpec } from "../../animation/stroke/types";


/**
 * Handwriting against engraving (v0.4.4): how closely a curated handwriting path of a music symbol follows the engraved
 * Bravura glyph, measured on the staff. A SMuFL glyph is 250 font units to a staff space (10 of the pack's units) and sits
 * on its reference line (a G clef's origin is the G line, a note's its notehead centre…), so both meet in the same staff
 * coordinates; horizontally both are centred. The measure is the distance from points along the handwritten centre lines
 * to the engraved shape (0 inside it), in staff spaces.
 */
export const ENGRAVED_REFERENCE: Partial<Record<string, { glyph: BravuraGlyph; y: number }>> = {
  "𝄞": { glyph: "gClef", y: 10 }, "𝄢": { glyph: "fClef", y: 30 },
  "♩": { glyph: "noteQuarterUp", y: 20 }, "♪": { glyph: "note8thUp", y: 20 }, "𝅗𝅥": { glyph: "noteHalfUp", y: 20 }, "𝅝": { glyph: "noteWhole", y: 20 },
  "♯": { glyph: "accidentalSharp", y: 25 }, "♭": { glyph: "accidentalFlat", y: 20 }, "♮": { glyph: "accidentalNatural", y: 20 },
  "𝄻": { glyph: "restWhole", y: 30 }, "𝄼": { glyph: "restHalf", y: 20 }, "𝄽": { glyph: "restQuarter", y: 20 }, "𝄾": { glyph: "rest8th", y: 20 },
  "𝄴": { glyph: "timeSigCommon", y: 20 },
};

/** Points along a curated symbol's centre lines, in the pack's units (y up). */
export function handwritingPoints(spec: SymbolSpec): number[][] {
  const out: number[][] = [];
  for (const stroke of spec.strokes) {
    let x = 0, y = 0;
    for (const command of parseStrokePath(stroke.d)) {
      const steps = 24;
      if (command.op === "M") { x = command.x; y = command.y; out.push([x, y]); continue; }
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        if (command.op === "L") out.push([x + (command.x - x) * t, y + (command.y - y) * t]);
        else if (command.op === "Q") out.push([u * u * x + 2 * u * t * command.cx + t * t * command.x, u * u * y + 2 * u * t * command.cy + t * t * command.y]);
        else if (command.op === "C") out.push([u ** 3 * x + 3 * u * u * t * command.c1x + 3 * u * t * t * command.c2x + t ** 3 * command.x, u ** 3 * y + 3 * u * u * t * command.c1y + 3 * u * t * t * command.c2y + t ** 3 * command.y]);
        else if (command.op === "E") { const a = (command.from + (command.to - command.from) * t) * Math.PI / 180; out.push([command.cx + Math.cos(a) * command.rx, command.cy + Math.sin(a) * command.ry]); }
      }
      if (command.op === "E") { const a = command.to * Math.PI / 180; x = command.cx + Math.cos(a) * command.rx; y = command.cy + Math.sin(a) * command.ry; }
      else { x = command.x; y = command.y; }
    }
  }
  return out;
}

export interface EngravedComparison { symbol: string; mean: number; p90: number; within: number; heightRatio: number }

/** Compares a curated symbol's handwriting with its engraved glyph (distances in staff spaces). */
export function compareWithEngraving(spec: SymbolSpec): EngravedComparison | null {
  const reference = ENGRAVED_REFERENCE[spec.symbol];
  if (!reference) return null;
  const outline = BRAVURA[reference.glyph];
  const rings = outlineRings(outline.d).map(ring => ring.flatMap(([x, y]) => [x / 25, y / 25 + reference.y]));
  const points = handwritingPoints(spec);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const [gx0, gy0, gx1, gy1] = [outline.bounds[0] / 25, outline.bounds[1] / 25 + reference.y, outline.bounds[2] / 25, outline.bounds[3] / 25 + reference.y];
  const dx = (gx0 + gx1) / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
  const distances = points.map(([x, y]) => insideOutline(rings, x + dx, y) ? 0 : distanceToRings(rings, x + dx, y) / 10).sort((a, b) => a - b);
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
  return {
    symbol: spec.symbol, mean, p90: distances[Math.floor(distances.length * 0.9)], within: distances.filter(d => d <= 0.15).length / distances.length,
    heightRatio: (Math.max(...ys) - Math.min(...ys)) / (gy1 - gy0),
  };
}
