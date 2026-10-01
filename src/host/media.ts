import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaRef } from "../core/presentation";
import { HEIGHTFIELD_MIME, isHeightField } from "../visual/heightfield";

/**
 * Images the host hands to Aion. Only local content is accepted (an absolute file path, a file:// URL or a
 * data: URL): Aion never fetches remote URLs, so presenting an image creates no network traffic and sends
 * nothing anywhere. Files are checked by extension, size and their actual leading bytes, and kept in memory
 * only while they may still be shown.
 */
export const MEDIA_LIMITS = { bytes: 8 * 1024 * 1024, items: 12, totalBytes: 48 * 1024 * 1024 };

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
};

export class MediaError extends Error {
  constructor(code: string, readonly detail: string) { super(code); this.name = "MediaError"; }
}

export interface MediaItem extends MediaRef { data: Buffer }

/** The image type a buffer actually is, from its leading bytes (never from what it claims to be). */
export function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString("latin1", 0, 6))) return "image/gif";
  const head = data.toString("utf8", 0, Math.min(data.length, 2048)).replace(/^\uFEFF/, "");
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/;

/** Reads an image source into bytes, or throws a MediaError whose message is a short, model-safe code. */
export async function loadImageSource(source: string): Promise<{ data: Buffer; mime: string }> {
  const value = source.trim();
  if (/^https?:\/\//i.test(value)) {
    throw new MediaError("remote-image-not-supported", "Aion does not fetch remote images. Save the image locally and pass its absolute path.");
  }
  if (value.startsWith("data:")) {
    const match = DATA_URL.exec(value);
    if (!match) throw new MediaError("image-invalid", "Only base64 data:image URLs of PNG, JPEG, WebP, GIF or SVG are accepted.");
    const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    return checked(data, match[1]);
  }
  let path = value;
  if (/^file:\/\//i.test(value)) {
    try { path = fileURLToPath(value); } catch { throw new MediaError("image-invalid", "The file:// URL is not valid."); }
  }
  if (!isAbsolute(path)) throw new MediaError("image-path-not-absolute", "Pass an absolute path to the image file.");
  const declared = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!declared) throw new MediaError("image-type", "Supported image files: .png, .jpg, .jpeg, .webp, .gif, .svg.");
  let real: string;
  try { real = await realpath(path); } catch { throw new MediaError("image-not-found", "The image file does not exist."); }
  const info = await stat(real);
  if (!info.isFile()) throw new MediaError("image-not-found", "The path is not a file.");
  if (info.size > MEDIA_LIMITS.bytes) throw new MediaError("image-too-large", `Images are limited to ${MEDIA_LIMITS.bytes / 1024 / 1024} MB.`);
  return checked(await readFile(real), declared);
}

function checked(data: Buffer, declared: string) {
  if (data.length > MEDIA_LIMITS.bytes) throw new MediaError("image-too-large", `Images are limited to ${MEDIA_LIMITS.bytes / 1024 / 1024} MB.`);
  if (data.length < 16) throw new MediaError("image-invalid", "The image is empty or truncated.");
  const actual = sniffImage(data);
  if (!actual) throw new MediaError("image-invalid", "The file is not a PNG, JPEG, WebP, GIF or SVG image.");
  // A JPEG named .png is still a JPEG; what matters is that it is an image we know how to show.
  return { data, mime: actual === declared || declared !== "image/svg+xml" ? actual : declared };
}

/**
 * What a media buffer actually is, from its bytes: one of the image types, or a height field (terrain the
 * resolver built). Anything else is refused.
 */
export function sniffMedia(data: Buffer): string | null {
  return sniffImage(data) ?? (isHeightField(data) ? HEIGHTFIELD_MIME : null);
}

/** A small in-memory store of recently presented images, bounded by count and size (oldest dropped first). */
export class MediaStore {
  private readonly items = new Map<string, MediaItem>();

  add(data: Buffer, mime: string): MediaRef {
    const id = `m${randomBytes(9).toString("hex")}`;
    const item = { id, mime, bytes: data.length, data };
    this.items.set(id, item);
    let total = [...this.items.values()].reduce((sum, value) => sum + value.bytes, 0);
    for (const [key, value] of this.items) {
      if (this.items.size <= MEDIA_LIMITS.items && total <= MEDIA_LIMITS.totalBytes) break;
      if (key === id) continue;
      this.items.delete(key);
      total -= value.bytes;
    }
    return { id, mime, bytes: data.length };
  }

  get(id: string): MediaItem | undefined { return this.items.get(id); }
  get size() { return this.items.size; }
}
