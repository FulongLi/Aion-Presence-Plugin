import { inflateSync } from "node:zlib";
import { ResolveError } from "../../visual/errors";
import type { Raster } from "../../visual/types";

/**
 * A small, strict PNG decoder for elevation tiles. Terrarium tiles store metres in their RGB values, so they
 * must be read exactly, with no colour management or premultiplication (SCF decoded them in the browser with
 * `colorSpaceConversion: "none"`; the plugin resolves terrain in Node, where there is no canvas). Supports
 * 8-bit greyscale, RGB, palette, grey+alpha and RGBA, non-interlaced: what tile servers produce. Anything else
 * is refused rather than guessed at.
 */
export const PNG_LIMITS = { side: 4096, bytes: 8 * 1024 * 1024 };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(bytes: Uint8Array): Raster {
  const fail = (code = "png-invalid"): never => { throw new ResolveError(code); };
  if (bytes.length > PNG_LIMITS.bytes || bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, type = -1, palette: Uint8Array | null = null, transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) fail();
    if (name === "IHDR") {
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      const depth = body[8]; type = body[9];
      if (depth !== 8 || !(type in CHANNELS) || body[10] !== 0 || body[11] !== 0) fail("png-unsupported");
      if (body[12] !== 0) fail("png-unsupported"); // interlaced
      if (!width || !height || width > PNG_LIMITS.side || height > PNG_LIMITS.side) fail();
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") transparency = body;
    else if (name === "IDAT") data.push(body);
    else if (name === "IEND") break;
    offset += 12 + length;
  }
  if (!width || type < 0 || !data.length || (type === 3 && !palette)) fail();
  const channels = CHANNELS[type], stride = width * channels;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height + 1 }); } catch { return fail(); }
  if (raw.length !== (stride + 1) * height) fail();

  // Undo the per-row filters in place.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0, b = above ? above[x] : 0, c = above && x >= channels ? above[x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0: value = row[x]; break;
        case 1: value = row[x] + a; break;
        case 2: value = row[x] + b; break;
        case 3: value = row[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value = row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return fail();
      }
      out[x] = value & 0xff;
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4, s = i * channels;
    switch (type) {
      case 0: rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[s]; rgba[o + 3] = 255; break;
      case 2:
        rgba[o] = pixels[s]; rgba[o + 1] = pixels[s + 1]; rgba[o + 2] = pixels[s + 2];
        // tRNS for RGB names one 16-bit colour (the low bytes, at depth 8) that is transparent.
        rgba[o + 3] = transparency && transparency.length >= 6
          && pixels[s] === transparency[1] && pixels[s + 1] === transparency[3] && pixels[s + 2] === transparency[5] ? 0 : 255;
        break;
      case 3: {
        const index = pixels[s];
        if (index * 3 + 2 >= palette!.length) fail();
        rgba[o] = palette![index * 3]; rgba[o + 1] = palette![index * 3 + 1]; rgba[o + 2] = palette![index * 3 + 2];
        rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
        break;
      }
      case 4: rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[s]; rgba[o + 3] = pixels[s + 1]; break;
      case 6: rgba.set(pixels.subarray(s, s + 4), o); break;
    }
  }
  return { width, height, data: rgba };
}
