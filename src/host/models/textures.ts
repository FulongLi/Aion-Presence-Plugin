import { decodePng } from "../resolver/png";
import { decodeJpeg } from "../../visual/models/jpeg";
import type { ModelImage } from "../../visual/models/geometry";
import type { Raster } from "../../visual/types";

/**
 * A model's textures decoded for colour sampling (v0.9), on the host: PNG with the resolver's strict decoder, JPEG with
 * the model library's own. A texture that cannot be decoded (16-bit or interlaced PNG, CMYK JPEG, WebP) is reported and
 * left out: its surfaces take their material colour instead, never a guess.
 */
export const TEXTURE_LIMITS = { side: 8192, bytes: 48 * 1024 * 1024 };

/** `used`: the images a material reads its colour from (others — normal maps, roughness — are never decoded). */
export function decodeTextures(images: ModelImage[], warnings: string[], used?: Set<number>): (Raster | null)[] {
  return images.map((image, index) => {
    if (used && !used.has(index)) return null;
    try {
      if (image.mime === "image/png") return decodePng(image.data, TEXTURE_LIMITS);
      // Colours for at most a few tens of thousands of particles: a texture is decoded at up to 1024 px a side.
      if (image.mime === "image/jpeg") return decodeJpeg(image.data, { side: TEXTURE_LIMITS.side, pixels: 64 * 1024 * 1024, bytes: TEXTURE_LIMITS.bytes }, { maxSide: 1024 });
      warnings.push(`texture ${index + 1}: ${image.mime} is not decoded (material colour used)`);
    } catch (error) {
      warnings.push(`texture ${index + 1}: ${error instanceof Error ? error.message : "undecodable"} (material colour used)`);
    }
    return null;
  });
}

/** The images a geometry's materials take their base colour from. */
export const colourImages = (materials: { texture?: { image: number } }[]) => new Set(materials.flatMap(m => m.texture ? [m.texture.image] : []));
