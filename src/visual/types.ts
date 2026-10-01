/**
 * The visual vocabulary the particle body understands (from SCF Presence's Visual Resolver). The body only
 * ever sees a VisualTarget; whether it came from a procedural visual form, a glyph, an image or real elevation
 * data stays outside the renderer.
 */

/** An RGBA image, row-major, 4 bytes per pixel. */
export interface Raster { width: number; height: number; data: Uint8ClampedArray }

/** What kind of picture an image request is after. It steers provider order, ranking and cropping (SCF). */
export const IMAGE_INTENTS = ["portrait", "celebrity", "object", "vehicle", "product", "reference", "map", "general"] as const;
export type ImageIntent = typeof IMAGE_INTENTS[number];
export const PORTRAIT_INTENTS: readonly ImageIntent[] = ["portrait", "celebrity"];

/**
 * How a decoded picture is framed for the body: a portrait (head-and-shoulders band), an object (plain
 * background trimmed), a map (kept whole) or a logo (a crisp mark on nothing).
 */
export const IMAGE_FITS = ["portrait", "object", "map", "logo"] as const;
export type ImageFit = typeof IMAGE_FITS[number];
export const fitForIntent = (intent: ImageIntent): ImageFit =>
  PORTRAIT_INTENTS.includes(intent) ? "portrait" : intent === "map" ? "map" : "object";

/** How a height field is lit and toned. The geometry is the same real elevation for every style. */
export const TERRAIN_STYLES = ["terrain", "topography", "relief", "heightmap"] as const;
export type TerrainStyle = typeof TERRAIN_STYLES[number];

/** SCF's simple symbols (drawn by the symbol form pack). */
export const SYMBOL_NAMES = [
  "check", "cross", "heart", "star", "question", "exclamation",
  "arrow-up", "arrow-down", "arrow-left", "arrow-right", "plus", "minus",
] as const;
export type SymbolName = typeof SYMBOL_NAMES[number];

/**
 * A flat picture sampled into particle rest positions.
 * - portrait: luminance-weighted density with a vignette and shallow relief (faces, people).
 * - object: density follows what differs from the image's background (vehicles, products, screenshots).
 * - glyph: alpha-weighted crisp shapes with even light (text, numbers, clocks).
 * - logo: a mark on transparency: alpha-shaped silhouette, strong edges, even density.
 * - emoji: one system-font emoji on transparency: density follows alpha, with extra weight on the silhouette
 *   and on colour boundaries inside it (eyes, mouth). Still particles, never a flat sticker.
 * - ink: a procedural monochrome form (a visual form such as the yin-yang): alpha is density, RGB is tone.
 */
export interface Raster2DTarget {
  kind: "raster2d";
  raster: Raster;
  style: "portrait" | "object" | "glyph" | "logo" | "emoji" | "ink";
}

/** A grid of normalized heights (0 = lowest shown, 1 = highest), row 0 is the far (north) edge. */
export interface HeightField {
  width: number;
  height: number;
  values: Float32Array;
  /** 1 where the surface exists (e.g. land inside the region), 0 elsewhere. Omitted: everywhere. */
  mask?: Uint8Array;
  /** Ground width / ground height of the grid (the map's aspect, not the grid's). */
  aspect: number;
  /** Visual relief, 0..1: how tall the tallest point stands relative to the layout. */
  relief: number;
  /** Real elevation range in metres when the source had it, for diagnostics. */
  elevation?: { min: number; max: number };
}

/** 2.5D: X/Y keep the source layout, Z rises with height. */
export interface HeightFieldTarget {
  kind: "heightfield";
  field: HeightField;
  style: TerrainStyle;
}

/**
 * A procedural arrangement of weighted points and strokes, sampled into particles directly with no raster
 * in between: star maps and star-drawn glyphs. Coordinates are normalized (x right, y up) within [-1, 1].
 */
export interface PointLayout {
  /** Particles gather around each point in proportion to `weight`, spread over `radius`, lit by `tone` (0..1). */
  points: { x: number; y: number; weight: number; radius: number; tone: number }[];
  /** Particles are strewn along each polyline (flat [x0, y0, x1, y1, …]) in proportion to `weight` × length. */
  strokes: { points: number[]; width: number; weight: number; tone: number }[];
  /** Fraction (0..0.8) of the body spread thinly and dimly over the frame, as a quiet background. */
  dust: number;
}

/** celestial: sparse and deep. Points are luminous cores; strokes are fine lines; the dust is a faint field. */
export interface PointLayoutTarget {
  kind: "points";
  layout: PointLayout;
  style: "celestial";
}

export type VisualTarget = Raster2DTarget | HeightFieldTarget | PointLayoutTarget;

/** A particle arrangement ready for the runtime: a visual target plus how long to hold it. */
export interface MorphTarget {
  visual: VisualTarget;
  /** Seconds to hold the formed state; Infinity holds it until released. */
  hold: number;
  label: string;
  /** Optional morph durations in seconds for this target (default `transitionSeconds`). */
  transition?: { form?: number; return?: number };
  /** Optional movement while formed. `spin`: radians per second about the view axis (anticlockwise positive). */
  motion?: { spin?: number };
}
