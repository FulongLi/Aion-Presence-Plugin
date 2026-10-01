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

/** Decodes an image (any type the browser can draw, SVG included) into a raster at most `maxSide` across. */
export async function decodeImage(blob: Blob, maxSide = 512): Promise<Raster> {
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
