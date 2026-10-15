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
      strokes: [{ d: "M 15 13.4 C 12.9 18.6 22.4 21.2 25.5 16 C 28.7 10 22.4 3.1 15 3.1 C 5.6 3.1 2.4 11.7 5.6 17.7 C 8.7 24.6 18.2 28.9 22.4 34.1 C 26.6 39.2 26.6 47.8 20.3 51.3 C 15 53.9 11.9 47.8 14 42.7 L 19.2 -8.9 C 20.3 -14.1 12.9 -16.7 8.7 -12.4", taper: [1.2, 0.8],
        say: "a curl around the G line, out and up through the staff to the top loop, then straight down to a small hook" }],
    }),
    symbol({
      symbol: "𝄢", names: ["bass clef", "f clef", "bass", "低音谱号", "f谱号"], title: "bass clef", box: CLEF_BOX,
      note: "Begin with the dot on the F line (the fourth line), arch up and over to the right, sweep down to the left; then the two dots, above and below the F line.",
      strokes: [
        { d: "E 6 30 2.6 2.6 180 540 C 4 39 17 42 23 35.5 C 29.5 28 24 14 4 4.8", taper: [1.3, 0.7], say: "a dot on the F line, arching up and over to the right, then down to the left" },
        { d: "E 31 35 1.6 1.6 90 450", width: 1.6 }, { d: "E 31 25 1.6 1.6 90 450", width: 1.6 },
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
      strokes: ["M 10.8 37 L 10.8 11", "M 16.6 39 L 16.6 13", { d: "M 7.6 28 L 19.8 31", width: 1.6 }, { d: "M 7.6 19 L 19.8 22", width: 1.6 }],
    }),
    symbol({
      symbol: "♭", names: ["flat", "flat sign", "降号"], title: "flat", box: ACCIDENTAL_BOX,
      note: "One stroke: down the stem, then the rounded bowl back to it.",
      strokes: [{ d: "M 9 37.4 L 9 13.2 C 17 16.5 19.5 25.5 9.4 24.4", taper: [0.9, 1.2] }],
    }),
    symbol({
      symbol: "♮", names: ["natural", "natural sign", "还原号"], title: "natural", box: ACCIDENTAL_BOX,
      note: "Two strokes: down the left side and across (an L), then across and down the right side.",
      strokes: ["M 9.4 33.4 L 9.4 13 L 15.4 15.4", "M 9.4 21.6 L 15.4 24 L 15.4 6.8"],
    }),
    // ── v0.4.4: the rest of the introductory vocabulary ──
    symbol({
      symbol: "𝄡", names: ["alto clef", "c clef", "viola clef", "中音谱号", "c谱号"], title: "alto clef", box: CLEF_BOX,
      note: "The two vertical lines first (the thick one, then the thin one beside it), then the upper curve from the middle line up and round, and the lower curve from the middle line down and round — the common hand shortcut (a K with curled ends) for the engraved double-lobed shape.",
      strokes: [
        { d: "M 4 42 L 4 -2", width: 1.7, say: "down, the full height of the staff (thick)" }, { d: "M 10 42 L 10 -2", say: "down, beside it (thin)" },
        { d: "M 10 20 C 13 22 14 25 15 29 C 16 35 19 40 25 40 C 31 40 33 35 31 32 C 29 29 24 30 24 34", taper: [1, 0.8], say: "from the middle line up and round to the top" },
        { d: "M 10 20 C 13 18 14 15 15 11 C 16 5 19 0 25 0 C 31 0 33 5 31 8 C 29 11 24 10 24 6", taper: [1, 0.8], say: "from the middle line down and round to the bottom" },
      ],
    }),
    symbol({
      symbol: "𝅝", names: ["whole note", "semibreve", "全音符"], title: "whole note", box: NOTE_BOX,
      note: "One open oval, a little wider than a filled notehead, drawn round from the top; no stem.",
      strokes: [{ d: "E 20 20 8.4 5.2 90 450", width: 1.3, say: "an open oval, round from the top" }],
    }),
    symbol({
      symbol: "𝅗𝅥", names: ["half note", "minim", "二分音符"], title: "half note", box: NOTE_BOX,
      note: "The open notehead first, then the stem up from its right side (below the middle line).",
      strokes: [{ d: "E 13 20 6.5 4.4 90 450", say: "an open oval, round from the top" }, "M 19.4 21 L 19.4 52"],
    }),
    symbol({
      symbol: "𝅘𝅥𝅯", names: ["sixteenth note", "semiquaver", "十六分音符"], title: "sixteenth note", box: NOTE_BOX,
      note: "The notehead, the stem, then two flags from the top of the stem, the second just below the first.",
      strokes: [{ d: NOTEHEAD, width: 1.9, say: "a small filled oval" }, "M 19.4 21 L 19.4 52",
        { d: "M 19.4 52 C 21 46 30 43 28 34", taper: [1.3, 0.7] }, { d: "M 19.4 45 C 21 39 30 36 28 27", taper: [1.3, 0.7] }],
    }),
    symbol({
      symbol: "𝄻", names: ["whole rest", "semibreve rest", "全休止符"], title: "whole rest", box: ACCIDENTAL_BOX,
      note: "A short, thick block hanging from line 4 (it fills the top half of the space below it).",
      strokes: [{ d: "M 9 27.6 L 23 27.6", width: 1.9, say: "right, a thick block just under line 4" }],
    }),
    symbol({
      symbol: "𝄼", names: ["half rest", "minim rest", "二分休止符"], title: "half rest", box: ACCIDENTAL_BOX,
      note: "The same block sitting on line 3 (the half rest sits, the whole rest hangs).",
      strokes: [{ d: "M 9 22.4 L 23 22.4", width: 1.9, say: "right, a thick block on top of line 3" }],
    }),
    symbol({
      symbol: "𝄽", names: ["quarter rest", "crotchet rest", "四分休止符"], title: "quarter rest", box: ACCIDENTAL_BOX,
      note: "One stroke from near the top of the staff: down-right, back down-left, down-right again, then a small hook curling left at the bottom (like a Z followed by a c). Some teachers draw it as a reversed 7 instead.",
      strokes: [{ d: "M 9 35 L 17 27 L 10 19 L 18 12 C 12 13 8 9 13 4", taper: [1, 0.8], say: "down-right, down-left, down-right, then a small hook curling left" }],
    }),
    symbol({
      symbol: "𝄾", names: ["eighth rest", "quaver rest", "八分休止符"], title: "eighth rest", box: ACCIDENTAL_BOX,
      note: "The small round dot first, then from it a short curve to the right and a straight line down to the left.",
      strokes: [{ d: "E 11 25 2.2 2 90 450", width: 1.7, say: "a small filled dot" }, { d: "M 12 23.4 C 15 22 18 23 21 27 L 14.5 10", say: "a short curve right, then straight down-left" }],
    }),
    symbol({
      symbol: "𝄴", names: ["common time", "c time", "四四拍记号"], title: "common time", box: ACCIDENTAL_BOX,
      note: "A large C centred on the middle line, from the upper right round anticlockwise to the lower right.",
      strokes: [{ d: "E 16 20 8 10 40 320", say: "a C from the upper right, round anticlockwise" }],
    }),
    symbol({
      symbol: "𝄁", names: ["double bar line", "double bar", "双纵线", "段落线"], title: "double bar line", box: ACCIDENTAL_BOX,
      note: "Two thin lines down the full height of the staff, close together.", strokes: ["M 12 40 L 12 0", "M 18 40 L 18 0"],
    }),
    symbol({
      symbol: "𝄂", names: ["final bar line", "final bar", "end bar", "终止线"], title: "final bar line", box: ACCIDENTAL_BOX,
      note: "A thin line, then a thick line just to its right.", strokes: ["M 11 40 L 11 0", { d: "M 18 40 L 18 0", width: 2 }],
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
