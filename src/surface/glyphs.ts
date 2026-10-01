import { trimTransparent } from "../visual/image";
import { sizedSvg, svgProblem, svgRasterSize } from "../visual/svg";
import type { Raster } from "../visual/types";

/**
 * Text the body becomes (a word, "48/48", a time), drawn on a canvas that is never shown, then sampled into
 * particles (from SCF Presence's glyph provider).
 */
const FONT = '600 {size}px "SF Pro Rounded", ui-rounded, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif';

function canvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = width; element.height = height;
  const context = element.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas-unavailable");
  return context;
}

const read = (context: CanvasRenderingContext2D): Raster => {
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  return { width: pixels.width, height: pixels.height, data: pixels.data };
};

/** A single line of text, fitted to at most 360 × 150 pixels. */
export function rasterizeText(text: string): Raster {
  const measure = canvas(8, 8);
  let size = 120;
  measure.font = FONT.replace("{size}", String(size));
  const width = measure.measureText(text).width;
  size = Math.max(40, Math.min(120, Math.floor(size * 330 / Math.max(1, width))));
  const context = canvas(Math.ceil(Math.min(360, width * size / 120 + size * 0.3)), Math.ceil(size * 1.25));
  context.font = FONT.replace("{size}", String(size));
  context.fillStyle = "#fff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, context.canvas.width / 2, context.canvas.height / 2 + size * 0.04);
  return read(context);
}

/**
 * Decodes an image (any type the browser can draw) into a raster at most `maxSide` across. An SVG is checked,
 * then given explicit pixel dimensions from its viewBox (SCF's svg transform), so vector art is rendered at its
 * target size; it is only ever drawn through an <img>, which runs no script and loads nothing.
 */
export async function decodeImage(blob: Blob, maxSide = 512): Promise<Raster> {
  if (blob.type === "image/svg+xml") {
    const text = await blob.text();
    if (svgProblem(text)) throw new Error("svg-invalid");
    blob = new Blob([sizedSvg(text, svgRasterSize(text))], { type: "image/svg+xml" });
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const width = image.naturalWidth || 512, height = image.naturalHeight || 512;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const context = canvas(Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale)));
    context.drawImage(image, 0, 0, context.canvas.width, context.canvas.height);
    return read(context);
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Constructed emoji (SCF's providers/emoji.ts): one emoji drawn with the operating system's own colour emoji
 * font onto a transparent canvas that is never shown, then sampled into particles. No network, no image
 * search, no bundled emoji images: Apple Color Emoji, Segoe UI Emoji or Noto Color Emoji.
 */
export const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
export const emojiLimits = { side: 256, size: 180, cache: 48 };

/** Draws one emoji centred by its actual ink bounds, shrunk to fit if it would overflow. */
export function renderEmoji(emoji: string): Raster {
  const { side } = emojiLimits;
  const context = canvas(side, side);
  let size = emojiLimits.size;
  const measure = () => {
    context.font = `${size}px ${EMOJI_FONT}`;
    const m = context.measureText(emoji);
    const left = m.actualBoundingBoxLeft || m.width / 2, right = m.actualBoundingBoxRight || m.width / 2;
    const ascent = m.actualBoundingBoxAscent || size * 0.8, descent = m.actualBoundingBoxDescent || size * 0.2;
    return { left, right, ascent, descent };
  };
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  let box = measure();
  const extent = Math.max(box.left + box.right, box.ascent + box.descent);
  if (extent > side * 0.9) { size = Math.floor(size * side * 0.9 / extent); box = measure(); }
  // A monochrome fallback font draws in the fill colour; colour emoji fonts ignore it.
  context.fillStyle = "#fff";
  context.fillText(emoji, side / 2 + (box.left - box.right) / 2, side / 2 + (box.ascent - box.descent) / 2);
  return read(context);
}

/** Crops a rendered emoji to its visible pixels; one no font could draw fails as "emoji-unavailable". */
export function trimEmoji(raster: Raster): Raster {
  const trimmed = trimTransparent(raster, 8, 0.05);
  if (!trimmed) throw new Error("emoji-unavailable");
  return trimmed;
}

/** A bounded in-memory cache in front of a renderer, keyed by the emoji (least recently used dropped first). */
export function createEmojiRasterizer(render: (emoji: string) => Raster = renderEmoji, capacity = emojiLimits.cache) {
  const cache = new Map<string, Raster>();
  const rasterize = (emoji: string): Raster => {
    const hit = cache.get(emoji);
    if (hit) { cache.delete(emoji); cache.set(emoji, hit); return hit; }
    const raster = trimEmoji(render(emoji));
    cache.set(emoji, raster);
    const oldest = cache.keys().next().value;
    if (cache.size > capacity && oldest !== undefined) cache.delete(oldest);
    return raster;
  };
  return Object.assign(rasterize, { cache });
}

export const rasterizeEmoji = createEmojiRasterizer();
