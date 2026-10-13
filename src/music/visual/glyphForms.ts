import type { Raster2DTarget } from "../../visual/types";
import { InkCanvas, type Ink } from "../../visual/forms/geometry/ink";
import type { Point } from "../../visual/forms/geometry/path";
import type { VisualFormEntry, VisualFormPack } from "../../visual/forms/types";
import { BRAVURA, type BravuraGlyph } from "./bravura";

/**
 * The music pack: symbols of notation that Aion's body can become (BODY route), drawn from the Bravura outlines with the
 * same ink painter as the other symbol forms: no font, no canvas, the same shape on every device. Exact notation on a
 * staff is never particles: that is the card's job (see the music presentation).
 */
const INK: Ink = { density: 1, tone: 0.94, grain: 0.05 };

/** Parses the outline's absolute commands (M L H V Q Z, as fontTools writes them) into closed rings, in glyph units. */
export function outlineRings(d: string): Point[][] {
  const rings: Point[][] = [];
  const tokens = d.match(/[MLHVQZ]|-?\d+(?:\.\d+)?/g) ?? [];
  let ring: Point[] | null = null, x = 0, y = 0, command = "", i = 0;
  const number = () => Number(tokens[i++]);
  const flatten = (cx: number, cy: number, ex: number, ey: number) => {
    const n = Math.max(2, Math.ceil(Math.hypot(cx - x, cy - y) + Math.hypot(ex - cx, ey - cy)) / 24 | 0);
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      ring!.push([u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey]);
    }
  };
  while (i < tokens.length) {
    if (/[MLHVQZ]/.test(tokens[i])) command = tokens[i++];
    switch (command) {
      case "M": x = number(); y = number(); ring = [[x, y]]; rings.push(ring); command = "L"; break;
      case "L": x = number(); y = number(); ring!.push([x, y]); break;
      case "H": x = number(); ring!.push([x, y]); break;
      case "V": y = number(); ring!.push([x, y]); break;
      case "Q": { const cx = number(), cy = number(), ex = number(), ey = number(); flatten(cx, cy, ex, ey); x = ex; y = ey; break; }
      case "Z": if (ring && ring.length) { ring.push(ring[0]); [x, y] = ring[0]; } ring = null; break;
      default: i++;
    }
  }
  return rings.filter(r => r.length > 2);
}

/**
 * A glyph centred in the form's frame, scaled to `size` of it (its taller side). `line`: a short staff line drawn through
 * the glyph's top (a whole rest hangs from line 4) or bottom (a half rest sits on line 3), without which the two rests
 * are the same block.
 */
export function renderGlyph(glyph: BravuraGlyph, size = 1.6, line?: "top" | "bottom"): Raster2DTarget {
  const outline = BRAVURA[glyph];
  const [x0, y0, x1, y1] = outline.bounds;
  const scale = size / Math.max(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rings = outlineRings(outline.d).map(ring => ring.map(([x, y]) => [(x - cx) * scale, (y - cy) * scale] as Point));
  const canvas = new InkCanvas({ left: -1, right: 1, bottom: -1, top: 1 }, 220);
  canvas.polygon(rings, INK);
  if (line) {
    const y = ((line === "top" ? y1 : y0) - cy) * scale, half = (x1 - x0) * scale * 0.95;
    canvas.stroke([[-half, y], [half, y]], 0.035, INK, "butt");
  }
  return { kind: "raster2d", style: "ink", raster: canvas.toRaster() };
}

const MUSIC_FORMS: { id: string; glyph: BravuraGlyph; label: string; aliases: string[]; size?: number; line?: "top" | "bottom" }[] = [
  { id: "treble-clef", glyph: "gClef", label: "Treble clef 𝄞 (G clef)", aliases: ["treble clef", "g clef", "𝄞", "高音谱号", "g谱号", "高音记号"] },
  { id: "bass-clef", glyph: "fClef", label: "Bass clef 𝄢 (F clef)", aliases: ["bass clef", "f clef", "𝄢", "低音谱号", "f谱号", "低音记号"], size: 1.25 },
  { id: "whole-note", glyph: "noteWhole", label: "Whole note 𝅝", aliases: ["whole note", "semibreve", "𝅝", "全音符"], size: 0.95 },
  { id: "half-note", glyph: "noteHalfUp", label: "Half note 𝅗𝅥", aliases: ["half note", "minim", "𝅗𝅥", "二分音符"] },
  { id: "quarter-note", glyph: "noteQuarterUp", label: "Quarter note ♩", aliases: ["quarter note", "crotchet", "♩", "四分音符", "音符", "note", "music note"] },
  { id: "eighth-note", glyph: "note8thUp", label: "Eighth note ♪", aliases: ["eighth note", "quaver", "♪", "八分音符"] },
  { id: "sharp", glyph: "accidentalSharp", label: "Sharp ♯", aliases: ["sharp", "sharp sign", "♯", "升号", "升记号"], size: 1.4 },
  { id: "flat", glyph: "accidentalFlat", label: "Flat ♭", aliases: ["flat", "flat sign", "♭", "降号", "降记号"], size: 1.4 },
  { id: "natural", glyph: "accidentalNatural", label: "Natural ♮", aliases: ["natural", "natural sign", "♮", "还原号", "还原记号"], size: 1.4 },
  { id: "whole-rest", glyph: "restWhole", label: "Whole rest", aliases: ["whole rest", "semibreve rest", "全休止符"], size: 0.7, line: "top" },
  { id: "half-rest", glyph: "restHalf", label: "Half rest", aliases: ["half rest", "minim rest", "二分休止符"], size: 0.7, line: "bottom" },
  { id: "quarter-rest", glyph: "restQuarter", label: "Quarter rest 𝄽", aliases: ["quarter rest", "crotchet rest", "𝄽", "rest", "四分休止符", "休止符"], size: 1.4 },
  { id: "eighth-rest", glyph: "rest8th", label: "Eighth rest 𝄾", aliases: ["eighth rest", "quaver rest", "𝄾", "八分休止符"], size: 1.1 },
  { id: "common-time", glyph: "timeSigCommon", label: "Common time 𝄴 (4/4)", aliases: ["common time", "𝄴", "c time", "四四拍记号"], size: 1.1 },
];

export const MUSIC_FORM_IDS = MUSIC_FORMS.map(form => `music.${form.id}`);

export const musicPack: VisualFormPack = {
  id: "music",
  categories: [{ id: "music", family: "symbol", label: "Music · notation symbols (clefs, notes, rests, accidentals)", hints: ["music", "musical", "notation", "音乐", "乐谱"], transition: { form: 1.3, return: 1.1 } }],
  forms: MUSIC_FORMS.map((form): VisualFormEntry => ({
    id: `music.${form.id}`, category: "music", renderer: "ink", label: form.label, aliases: form.aliases,
    render: () => ({ visual: renderGlyph(form.glyph, form.size, form.line) }),
  })),
};
