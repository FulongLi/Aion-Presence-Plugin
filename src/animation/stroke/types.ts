/**
 * Ordered writing strokes (v0.4.3): how a character or symbol is *written*, not only what it looks like.
 *
 * A font outline is a filled shape; it says nothing about which stroke comes first, where a stroke starts or which way
 * the pen moves. So nothing here is derived from a font: every stroke is a centre line drawn in the order and the
 * direction of an explicitly named writing convention (see the packs in ./packs). A symbol without such data is not
 * offered, rather than guessed.
 */
export const WRITING_SYSTEMS = ["chinese", "latin", "digits", "music", "math"] as const;
export type WritingSystem = typeof WRITING_SYSTEMS[number];

/** A name in English and, where the convention has one, in Chinese (e.g. 横 "horizontal"). */
export interface StrokeName { en: string; zh?: string }

/** How one stroke is authored: a path in the pack's own units (y up), and what it is called. */
export interface StrokeSpec {
  /**
   * The stroke's centre line, in the order it is written. Commands (absolute, space separated):
   *   M x y · L x y · Q cx cy x y · C c1x c1y c2x c2y x y · E cx cy rx ry from to
   * E is an elliptical arc (degrees, anticlockwise when to > from); it joins the current point with a line, or, first,
   * starts the stroke at its own start. At most one M, at the start: a stroke is one continuous movement of the pen.
   */
  d: string;
  name?: StrokeName;
  /** Line width relative to the pack's (1 = the pack's width); `taper` [start, end] scales it along the stroke. */
  width?: number;
  taper?: [number, number];
  /** Where the pen goes, in words, when the stroke is too intricate for the automatic description (a clef). */
  say?: string;
}

/** A curated symbol in a pack. */
export interface SymbolSpec {
  /** The symbol itself ("永", "A", "7", "𝄞", "π"). */
  symbol: string;
  /** Names a request may use ("eternity", "yong", "treble clef", "高音谱号", "pi"). */
  names: readonly string[];
  /** Plain-language meaning or name, for the result ("eternity", "uppercase A", "treble clef"). */
  title: string;
  strokes: readonly StrokeSpec[];
  /** The authoring box [left, bottom, right, top]; the symbol is centred in it. Default: the pack's box. */
  box?: readonly [number, number, number, number];
  /** Notes on this symbol's convention (e.g. "verticals first"), for the result and the documentation. */
  note?: string;
}

/** Faint, unordered context drawn with the symbol: a practice grid, a staff, writing lines. */
export type GuideKind = "grid" | "staff" | "lines" | "none";

export interface StrokePack {
  system: WritingSystem;
  /** The convention the order follows, named so it can be cited ("zh-Hans: mainland China standard …"). */
  variant: string;
  convention: string;
  /** The default authoring box [left, bottom, right, top] (y up). */
  box: readonly [number, number, number, number];
  /** Pen width in normalized units (the stage spans −1…1). */
  width: number;
  guide: GuideKind;
  /** Letters: each symbol's left and right come from its own extent (plus a margin), bottom and top from `box`, so all share one scale. */
  autoWidth?: boolean;
  symbols: readonly SymbolSpec[];
}

/**
 * Normalized geometry: x right, y up. A single symbol fits within [−limit, limit]; a word may run wider, up to
 * ±halfWidth, at the same height (v0.4.4).
 */
export const STROKE_SPACE = { limit: 0.86, halfWidth: 1.5 } as const;

/** One stroke, ready to animate: its ordered centre line in normalized units and what it is. */
export interface Stroke {
  id: string;
  /** 1-based writing order. */
  order: number;
  /** Flat [x0, y0, x1, y1, …], in writing order. */
  path: number[];
  startPoint: [number, number];
  endPoint: [number, number];
  /** Where the pen goes, in words: "right", "down", "right, then down, then a hook left", "a loop, anticlockwise". */
  direction: string;
  /** Normalized length of the centre line. */
  length: number;
  /** Seconds to write it at normal speed. */
  duration: number;
  /** Pen width at its start and end (normalized). */
  width: [number, number];
  name?: StrokeName;
  /** v0.4.4: which symbol of the writing it belongs to (0-based) and its number within that symbol (1-based). */
  item: number;
  local: number;
  /** v0.4.4: seconds the pen travels (lifted) before this stroke, at normal speed; 0 for the first. */
  pause: number;
  /**
   * v0.4.4: the stroke's true filled outline (rings of flat [x, y, …], normalized), when the data has one (Chinese
   * characters). The particles fill it exactly; `path` is then the stroke's median, which only orders the reveal.
   * Without an outline the stroke is a pen line of `width` along `path` (round ends).
   */
  outline?: number[][];
}

/** One symbol inside a writing (a character of a word, a letter of a name). */
export interface WritingItem {
  symbol: string;
  title: string;
  /** Index of its first stroke in the sequence, and how many it has. */
  first: number;
  count: number;
  /** Its square or letter box [left, bottom, right, top], normalized. */
  box: [number, number, number, number];
  /** Strokes that form its radical (0-based, within the item), when the data says. */
  radical?: number[];
}

/** A symbol's complete writing sequence. */
export interface StrokeSequence {
  /** Registry id, e.g. "chinese:永", "latin:A", "music:treble-clef". */
  id: string;
  symbol: string;
  title: string;
  writingSystem: WritingSystem;
  variant: string;
  convention: string;
  note?: string;
  strokes: Stroke[];
  /** Faint context lines (flat point lists, normalized), never part of the order. */
  guides: number[][];
  /** v0.4.4: the symbols written, in order (one for a single symbol). Strokes keep each symbol's own order. */
  items: WritingItem[];
  /** Seconds of writing (strokes and the pauses between them) at normal speed. */
  totalDuration: number;
}

/** Bounds a sequence must respect (checked by validateSequence). */
export const STROKE_LIMITS = { strokes: 160, symbolStrokes: 64, items: 12, vertices: 60_000, minLength: 0.002, width: { min: 0.004, max: 0.2 } } as const;
