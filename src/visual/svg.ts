/**
 * SVG checks and sizing (from SCF's transforms/svg.ts). An SVG is only ever drawn through an <img> (browsers
 * render SVG images in a secure static mode: no scripts, no external loads) onto a canvas, so the particle
 * sampler only sees pixels. Curated assets are still checked before use, and refused rather than sanitized.
 */
export const svgLimits = {
  /** Largest SVG file read. */
  bytes: 1024 * 1024,
  /** Longest side of the rasterized SVG (vector art is rendered at this size rather than scaled). */
  side: 400,
  /** Shortest side, so a very wide wordmark still has rows to sample. */
  minSide: 24,
};

const ROOT = /<svg\b[^>]*>/i;
/** Everything an SVG image could use to run code or reach outside itself. A logo needs none of it. */
const UNSAFE: [RegExp, string][] = [
  [/<script\b/i, "script"],
  [/<foreignObject\b/i, "foreign-object"],
  [/<!ENTITY/i, "entity"],
  [/\son[a-z]+\s*=/i, "event-handler"],
  [/javascript:/i, "javascript-url"],
  [/@import\b/i, "css-import"],
  // Links and references may only point inside the document (#id) or to an embedded raster.
  [/\b(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);base64,)/i, "external-reference"],
  [/url\(\s*["']?(?!#|data:image\/(?:png|jpeg|webp);base64,)/i, "external-reference"],
];

/** Null when the text is a self-contained, script-free SVG document; otherwise the reason. */
export function svgProblem(text: string): string | null {
  if (text.length > svgLimits.bytes) return "svg-too-large";
  if (!ROOT.test(text)) return "svg-invalid";
  for (const [pattern, reason] of UNSAFE) if (pattern.test(text)) return `svg-unsafe-${reason}`;
  return null;
}

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
const length = (value: string | undefined) => {
  const match = value ? /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value) : null;
  return match ? Number(match[1]) : undefined;
};

/** The raster size for an SVG: its aspect ratio (viewBox, else width/height, else square) at `side` pixels. */
export function svgRasterSize(text: string, side = svgLimits.side): { width: number; height: number } {
  const root = ROOT.exec(text)?.[0] ?? "<svg>";
  const box = attribute(root, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  let aspect = box && box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : undefined;
  if (aspect === undefined) {
    const width = length(attribute(root, "width")), height = length(attribute(root, "height"));
    aspect = width && height ? width / height : 1;
  }
  aspect = Math.min(12, Math.max(1 / 12, aspect));
  const width = aspect >= 1 ? side : Math.round(side * aspect);
  const height = aspect >= 1 ? Math.round(side / aspect) : side;
  return { width: Math.max(svgLimits.minSide, width), height: Math.max(svgLimits.minSide, height) };
}

/** The SVG with explicit pixel width/height on its root, so every browser renders it at exactly `size`. */
export function sizedSvg(text: string, size: { width: number; height: number }): string {
  return text.replace(ROOT, tag => {
    const bare = tag.replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/gi, "");
    return bare.replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
  });
}
