import type { StrokePack, SymbolSpec } from "../types";

/**
 * Pack D — introductory music symbols, and Pack E — mathematical symbols. Music is drawn on a five-line staff (lines at
 * y = 0, 10, 20, 30, 40; the G line of the treble clef is y = 10, the F line of the bass clef y = 30). Bravura's
 * outlines (music/visual/bravura.ts) give the engraved shapes; they say nothing about how a hand draws them, so these
 * paths are curated, and where hands differ the demonstrated way is stated in the symbol's note.
 */
const symbol = (spec: Omit<SymbolSpec, "strokes"> & { strokes: (string | { d: string; width?: number; taper?: [number, number]; say?: string })[] }): SymbolSpec =>
  ({ ...spec, strokes: spec.strokes.map(stroke => typeof stroke === "string" ? { d: stroke } : stroke) });

const CLEF_BOX = [-6, -26, 44, 66] as const;
const NOTE_BOX = [-4, -10, 46, 60] as const;
const ACCIDENTAL_BOX = [-8, -18, 40, 60] as const;
// A filled notehead is a small pen scribble filling an oval: two rounds, the second inside the first.
const NOTEHEAD = "E 13 20 6.5 4.4 200 560 E 13 20 3.4 2 200 560";

export const MUSIC_PACK: StrokePack = {
  system: "music",
  variant: "hand-copying",
  convention: "Common hand-copying practice for introductory notation (clefs on their reference line, noteheads before stems)",
  box: [-6, -26, 44, 66],
  width: 0.05,
  guide: "staff",
  symbols: [
    symbol({
      symbol: "𝄞", names: ["treble clef", "g clef", "treble", "高音谱号", "g谱号"], title: "treble clef", box: CLEF_BOX,
      note: "One stroke, beginning on the G line: a curl around the G line, a wider round outward, up through the staff to the top loop, then straight down through the staff to a small hook below it. Some teachers start from the hook at the bottom instead.",
      strokes: [{ d: "M 15 14 C 13 20 22 23 25 17 C 28 10 22 2 15 2 C 6 2 3 12 6 19 C 9 27 18 32 22 38 C 26 44 26 54 20 58 C 15 61 12 54 14 48 L 19 -12 C 20 -18 13 -21 9 -16", taper: [1.2, 0.8],
        say: "a curl around the G line, out and up through the staff to the top loop, then straight down to a small hook" }],
    }),
    symbol({
      symbol: "𝄢", names: ["bass clef", "f clef", "bass", "低音谱号", "f谱号"], title: "bass clef", box: CLEF_BOX,
      note: "Begin with the dot on the F line (the fourth line), arch up and over to the right, sweep down to the left; then the two dots, above and below the F line.",
      strokes: [
        { d: "E 6 30 2.6 2.6 180 540 C 4 42 20 46 26 38 C 33 28 26 12 4 -4", taper: [1.3, 0.7], say: "a dot on the F line, arching up and over to the right, then down to the left" },
        { d: "E 34 35 1.6 1.6 90 450", width: 1.6 }, { d: "E 34 25 1.6 1.6 90 450", width: 1.6 },
      ],
    }),
    symbol({
      symbol: "♩", names: ["quarter note", "crotchet", "四分音符"], title: "quarter note", box: NOTE_BOX,
      note: "The notehead first (filled in a small round motion), then the stem up from its right side.",
      strokes: [{ d: NOTEHEAD, width: 1.9, say: "a small filled oval" }, "M 19.4 21 L 19.4 52"],
    }),
    symbol({
      symbol: "♪", names: ["eighth note", "quaver", "八分音符"], title: "eighth note", box: NOTE_BOX,
      note: "The notehead, the stem, then the flag from the top of the stem.",
      strokes: [{ d: NOTEHEAD, width: 1.9, say: "a small filled oval" }, "M 19.4 21 L 19.4 52", { d: "M 19.4 52 C 21 44 31 40 29 26", taper: [1.3, 0.7] }],
    }),
    symbol({
      symbol: "♯", names: ["sharp", "sharp sign", "升号"], title: "sharp", box: ACCIDENTAL_BOX,
      note: "The two verticals first, then the two slanted bars, each rising a little to the right.",
      strokes: ["M 10 46 L 10 4", "M 20 50 L 20 8", { d: "M 3 28 L 27 34", width: 1.7 }, { d: "M 3 16 L 27 22", width: 1.7 }],
    }),
    symbol({
      symbol: "♭", names: ["flat", "flat sign", "降号"], title: "flat", box: ACCIDENTAL_BOX,
      note: "One stroke: down the stem, then the rounded bowl back to it.",
      strokes: [{ d: "M 8 54 L 8 8 C 24 16 26 32 8 24", taper: [0.9, 1.2] }],
    }),
    symbol({
      symbol: "♮", names: ["natural", "natural sign", "还原号"], title: "natural", box: ACCIDENTAL_BOX,
      note: "Two strokes: down the left side and across (an L), then across and down the right side.",
      strokes: ["M 8 46 L 8 6 L 24 11", "M 8 27 L 24 32 L 24 -10"],
    }),
  ],
};

export const MATH_PACK: StrokePack = {
  system: "math",
  variant: "school",
  convention: "Common school handwriting of mathematical symbols (left to right, top to bottom)",
  box: [0, 0, 100, 100],
  width: 0.07,
  guide: "none",
  symbols: [
    symbol({ symbol: "+", names: ["plus", "plus sign", "add", "加号"], title: "plus", note: "The horizontal bar, then the vertical (both orders are common).", strokes: ["M 12 50 L 88 50", "M 50 88 L 50 12"] }),
    symbol({ symbol: "−", names: ["minus", "minus sign", "subtract", "-", "减号"], title: "minus", strokes: ["M 12 50 L 88 50"] }),
    symbol({ symbol: "=", names: ["equals", "equal sign", "equals sign", "等号"], title: "equals", strokes: ["M 14 64 L 86 64", "M 14 36 L 86 36"] }),
    symbol({ symbol: "×", names: ["times", "multiply", "multiplication sign", "x sign", "乘号"], title: "times", strokes: ["M 18 82 L 82 18", "M 82 82 L 18 18"] }),
    symbol({
      symbol: "÷", names: ["divide", "division sign", "obelus", "除号"], title: "divided by", note: "Top dot, the bar, bottom dot.",
      strokes: [{ d: "E 50 78 2.5 2.5 90 450", width: 1.6 }, "M 12 50 L 88 50", { d: "E 50 22 2.5 2.5 90 450", width: 1.6 }],
    }),
    symbol({
      symbol: "π", names: ["pi", "圆周率", "派"], title: "pi", note: "The bar first, then the left leg, then the right leg with its small foot.",
      strokes: ["M 8 78 C 20 86 70 84 92 82", { d: "M 34 82 C 34 58 30 30 22 12", taper: [1, 0.7] }, "M 64 82 L 64 22 C 64 12 74 10 82 18"],
    }),
    symbol({
      symbol: "∫", names: ["integral", "integral sign", "积分号"], title: "integral", box: [0, -6, 100, 106],
      note: "One stroke from the hook at the top to the hook at the bottom.",
      strokes: [{ d: "M 72 96 C 68 104 56 102 55 88 L 47 12 C 45 -2 33 -4 26 6", taper: [0.7, 0.7] }],
    }),
    symbol({ symbol: "√", names: ["square root", "root", "radical", "根号"], title: "square root", strokes: ["M 6 46 L 18 54 L 34 8 L 56 96 L 96 96"] }),
  ],
};
