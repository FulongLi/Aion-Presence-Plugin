/**
 * The visual vocabulary the particle body understands (from SCF Presence's Visual Resolver). The body only
 * ever sees a VisualTarget; whether it came from a procedural visual form, a text glyph or an image the host
 * handed over stays outside the renderer.
 */

/** An RGBA image, row-major, 4 bytes per pixel. */
export interface Raster { width: number; height: number; data: Uint8ClampedArray }

/**
 * A flat picture sampled into particle rest positions.
 * - portrait: luminance-weighted density with a vignette and shallow relief (faces, people).
 * - object: density follows what differs from the image's background (screenshots, diagrams, photos).
 * - glyph: alpha-weighted crisp shapes with even light (text, numbers).
 * - logo: a mark on transparency: alpha-shaped silhouette, strong edges, even density.
 * - emoji: a system-font emoji on transparency (kept for parity; plugin mode does not use it yet).
 * - ink: a procedural monochrome form (a visual form such as the yin-yang): alpha is density, RGB is tone.
 */
export interface Raster2DTarget {
  kind: "raster2d";
  raster: Raster;
  style: "portrait" | "object" | "glyph" | "logo" | "emoji" | "ink";
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

export type VisualTarget = Raster2DTarget | PointLayoutTarget;

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
