import type { StrokePack, SymbolSpec } from "../types";

/**
 * Pack B — English letters, and Pack C — numbers, in one documented convention: simple print manuscript
 * ("ball and stick"), as taught in many primary schools. Letters start at the top (e alone begins with its bar, in
 * the middle); straight lines are pulled down
 * or slid right; circles start at about two o'clock and go anticlockwise ("circle back"); a letter is lifted between
 * strokes. Where schools differ (the stem of T before or after its bar, a closed or an open 4), the choice is stated in
 * the symbol's note. Units: baseline 0, x-height 50, cap height 100, descender −40 (y up). Other styles (cursive,
 * D'Nealian) would be further packs with their own `variant`.
 */
const letter = (symbol: string, title: string, strokes: string[], note?: string, names: string[] = []): SymbolSpec =>
  ({ symbol, title, names, strokes: strokes.map(d => ({ d })), ...(note ? { note } : {}) });
const upper = (symbol: string, strokes: string[], note?: string) =>
  letter(symbol, `uppercase ${symbol}`, strokes, note, [`uppercase ${symbol}`, `capital ${symbol}`, `upper case ${symbol}`, `大写${symbol}`]);
const lower = (symbol: string, strokes: string[], note?: string) =>
  letter(symbol, `lowercase ${symbol}`, strokes, note, [`lowercase ${symbol}`, `small ${symbol}`, `lower case ${symbol}`, `小写${symbol}`]);

// Circles: an ellipse from about two o'clock, anticlockwise, all the way round.
const O = (cx: number, cy: number, rx: number, ry: number, from = 30) => `E ${cx} ${cy} ${rx} ${ry} ${from} ${from + 360}`;

export const LATIN_PACK: StrokePack = {
  system: "latin",
  variant: "manuscript",
  convention: "Print manuscript (ball and stick): start at the top, pull down, circles anticlockwise from two o'clock",
  box: [0, -45, 60, 105],
  width: 0.062,
  guide: "lines",
  autoWidth: true,
  symbols: [
    upper("A", ["M 30 100 L 4 0", "M 30 100 L 56 0", "M 14 38 L 46 38"]),
    upper("B", ["M 6 100 L 6 0", "M 6 100 L 32 100 C 52 100 52 52 30 52 C 58 52 58 0 34 0 L 6 0"], "The stem, then both bumps in one stroke."),
    upper("C", ["E 34 50 30 50 45 315"]),
    upper("D", ["M 6 100 L 6 0", "M 6 100 L 22 100 C 62 100 62 0 22 0 L 6 0"]),
    upper("E", ["M 6 100 L 6 0", "M 6 100 L 50 100", "M 6 52 L 42 52", "M 6 0 L 50 0"]),
    upper("F", ["M 6 100 L 6 0", "M 6 100 L 50 100", "M 6 52 L 42 52"]),
    upper("G", ["E 34 50 30 50 45 360 L 40 50"], "Circle back, then the bar inward."),
    upper("H", ["M 6 100 L 6 0", "M 54 100 L 54 0", "M 6 52 L 54 52"]),
    upper("I", ["M 20 100 L 20 0"]),
    upper("J", ["M 44 100 L 44 24 C 44 -6 6 -6 4 22"]),
    upper("K", ["M 6 100 L 6 0", "M 52 100 L 6 40", "M 22 58 L 54 0"]),
    upper("L", ["M 6 100 L 6 0 L 48 0"]),
    upper("M", ["M 6 100 L 6 0", "M 6 100 L 34 30 L 62 100", "M 62 100 L 62 0"]),
    upper("N", ["M 6 100 L 6 0", "M 6 100 L 54 0", "M 54 0 L 54 100"], "Pull down, slant down, push up."),
    upper("O", [O(34, 50, 30, 50, 90)], "From the top, circle back all the way round."),
    upper("P", ["M 6 100 L 6 0", "M 6 100 L 32 100 C 56 100 56 50 32 50 L 6 50"]),
    upper("Q", [O(34, 50, 30, 50, 90), "M 38 24 L 62 -6"]),
    upper("R", ["M 6 100 L 6 0", "M 6 100 L 32 100 C 56 100 56 50 32 50 L 6 50", "M 28 50 L 56 0"]),
    upper("S", ["M 54 86 C 48 104 8 104 8 76 C 8 50 58 56 58 24 C 58 -6 8 -4 4 14"]),
    upper("T", ["M 30 100 L 30 0", "M 4 100 L 56 100"], "The stem first, then the bar (some schools teach the bar first)."),
    upper("U", ["M 6 100 L 6 30 C 6 -10 58 -10 58 30 L 58 100"]),
    upper("V", ["M 4 100 L 30 0 L 56 100"]),
    upper("W", ["M 2 100 L 16 0 L 32 70 L 48 0 L 62 100"]),
    upper("X", ["M 4 100 L 56 0", "M 56 100 L 4 0"]),
    upper("Y", ["M 4 100 L 30 50", "M 56 100 L 30 50 L 30 0"]),
    upper("Z", ["M 4 100 L 56 100 L 4 0 L 58 0"]),
    lower("a", [O(26, 25, 22, 25, 30), "M 48 50 L 48 0"], "Circle back, then the stem."),
    lower("b", ["M 6 100 L 6 0", "E 28 25 22 25 180 -180"], "The stem, then the circle forward from it."),
    lower("c", ["E 28 25 24 25 45 315"]),
    lower("d", [O(26, 25, 22, 25, 30), "M 48 100 L 48 0"]),
    lower("e", ["M 4 25 L 50 25 E 27 25 23 25 0 320"]),
    lower("f", ["M 40 92 C 34 102 16 100 16 80 L 16 0", "M 2 50 L 34 50"]),
    lower("g", [O(26, 25, 22, 25, 30), "M 48 50 L 48 -24 C 48 -48 8 -46 4 -30"]),
    lower("h", ["M 6 100 L 6 0", "M 6 30 C 10 54 50 58 50 30 L 50 0"]),
    lower("i", ["M 12 50 L 12 0", "E 12 72 2.5 2.5 90 450"], "The stem, then the dot."),
    lower("j", ["M 30 50 L 30 -24 C 30 -46 6 -44 2 -32", "E 30 72 2.5 2.5 90 450"]),
    lower("k", ["M 6 100 L 6 0", "M 44 50 L 6 22", "M 18 30 L 46 0"]),
    lower("l", ["M 12 100 L 12 0"]),
    lower("m", ["M 6 50 L 6 0", "M 6 30 C 8 54 32 56 32 30 L 32 0", "M 32 30 C 34 54 60 56 60 30 L 60 0"]),
    lower("n", ["M 6 50 L 6 0", "M 6 30 C 10 54 50 58 50 30 L 50 0"]),
    lower("o", [O(26, 25, 24, 25, 90)]),
    lower("p", ["M 6 50 L 6 -40", "E 28 25 22 25 180 -180"]),
    lower("q", [O(26, 25, 22, 25, 30), "M 48 50 L 48 -40"]),
    lower("r", ["M 6 50 L 6 0", "M 6 30 C 10 50 32 56 44 44"]),
    lower("s", ["M 44 44 C 40 54 8 54 8 38 C 8 24 46 28 46 12 C 46 -4 8 -4 4 8"]),
    lower("t", ["M 22 86 L 22 6 C 22 -2 34 -2 40 4", "M 6 50 L 40 50"]),
    lower("u", ["M 6 50 L 6 18 C 6 -6 46 -6 46 18", "M 46 50 L 46 0"]),
    lower("v", ["M 4 50 L 26 0 L 48 50"]),
    lower("w", ["M 2 50 L 14 0 L 28 40 L 42 0 L 54 50"]),
    lower("x", ["M 4 50 L 46 0", "M 46 50 L 4 0"]),
    lower("y", ["M 4 50 L 26 0", "M 48 50 L 14 -40"]),
    lower("z", ["M 4 50 L 46 50 L 4 0 L 48 0"]),
  ],
};

const digit = (symbol: string, title: string, strokes: string[], note?: string): SymbolSpec =>
  ({ symbol, title, names: [title, `number ${symbol}`, `digit ${symbol}`, `number ${title}`], strokes: strokes.map(d => ({ d })), ...(note ? { note } : {}) });

export const DIGITS_PACK: StrokePack = {
  system: "digits",
  variant: "manuscript",
  convention: "Print manuscript numerals: start at the top; curves anticlockwise unless the shape turns the other way",
  box: [0, -45, 60, 105],
  width: 0.062,
  guide: "lines",
  autoWidth: true,
  symbols: [
    digit("0", "zero", [O(28, 50, 24, 50, 90)], "From the top, circle back all the way round."),
    digit("1", "one", ["M 20 100 L 20 0"]),
    digit("2", "two", ["M 6 76 C 8 102 54 104 52 72 C 50 50 6 20 4 0 L 56 0"]),
    digit("3", "three", ["M 8 88 C 20 104 54 100 52 76 C 50 56 30 54 24 54 C 54 54 60 30 56 18 C 50 -6 10 -2 4 14"]),
    digit("4", "four", ["M 40 100 L 4 32 L 58 32", "M 44 80 L 44 0"], "Down and across, then the downstroke (an open 4)."),
    digit("5", "five", ["M 12 100 L 10 56 C 30 66 58 60 56 30 C 54 -6 10 -2 4 14", "M 12 100 L 52 100"], "Down and round, then the flag on top."),
    digit("6", "six", ["M 48 96 C 26 92 4 60 6 30 C 8 -6 54 -6 52 30 C 50 60 10 58 6 34"]),
    digit("7", "seven", ["M 4 100 L 56 100 L 20 0"]),
    digit("8", "eight", ["M 48 84 C 48 104 8 104 8 84 C 8 62 50 48 52 26 C 54 -6 4 -6 6 26 C 8 48 48 62 48 84"], "An S, then back up to close it, in one stroke."),
    digit("9", "nine", ["E 28 72 22 26 20 380", "M 50 76 L 46 0"], "Circle back, then the stem."),
  ],
};
