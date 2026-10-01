import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AION_IDENTITY } from "../../core/identity";
import { ResolveError } from "../../visual/errors";
import { svgProblem } from "../../visual/svg";

/**
 * Curated local visual assets (SCF's sources/localAssets.ts): first-party material, such as the creator
 * company's logo, that must come from the plugin itself, never from a public image search. They ship in the
 * plugin's assets/ directory.
 */
export interface LocalAsset {
  id: string;
  /** The brand or subject, also the label the body shows. */
  brand: string;
  /** "logo" assets are rendered as crisp marks; "image" assets like photos. */
  type: "logo" | "image";
  /** Path under the plugin's assets/ directory. */
  file: string;
  /** Exact phrases (matched after normalization) that mean this asset. */
  aliases: readonly string[];
}

export const LOCAL_ASSETS: readonly LocalAsset[] = [
  {
    id: "spirit-connect-logo",
    brand: AION_IDENTITY.creatorCompany,
    type: "logo",
    file: "brand/spirit-connect-logo.svg",
    aliases: [
      "spirit connect", "spiritconnect", "spirit connect logo",
      // A first-party build: "our company" is the creator company. Only these explicit phrases map to it.
      "our company logo", "my company logo", "company logo",
    ],
  },
];

/** Lower case, accents folded, possessives dropped, punctuation to spaces: "Acme-Corp's Logo!" → "acme corp logo". */
export function normalizeAssetQuery(query: string): string {
  return query.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/['’]s\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Words that may accompany a brand's name when asking for its logo ("the … brand mark", "our official … logo"). */
const LOGO_WORDS = new Set([
  "logo", "logos", "brand", "mark", "logomark", "wordmark", "icon", "emblem", "symbol", "insignia",
  "company", "corporate", "official", "the", "a", "our", "my",
]);

/**
 * Deterministic, auditable matching — no fuzzy scoring:
 * 1. the normalized query equals a normalized alias; or
 * 2. (logos) the query contains the brand name and every other word is a logo word.
 * A generic word alone ("company", "logo") never matches.
 */
export function matchLocalAsset(query: string, assets: readonly LocalAsset[] = LOCAL_ASSETS): LocalAsset | null {
  const normalized = normalizeAssetQuery(query).replace(/^the /, "");
  if (!normalized) return null;
  for (const asset of assets) if (asset.aliases.some(alias => normalizeAssetQuery(alias) === normalized)) return asset;
  const words = normalized.split(" ");
  for (const asset of assets) {
    if (asset.type !== "logo") continue;
    const brand = normalizeAssetQuery(asset.brand).split(" ");
    const compact = brand.join("");
    let rest: string[] | null = null;
    const compactAt = words.indexOf(compact);
    if (compactAt >= 0) rest = words.filter((_, i) => i !== compactAt);
    else {
      for (let i = 0; i + brand.length <= words.length; i++) {
        if (brand.every((word, j) => words[i + j] === word)) { rest = [...words.slice(0, i), ...words.slice(i + brand.length)]; break; }
      }
    }
    if (rest && rest.every(word => LOGO_WORDS.has(word))) return asset;
  }
  return null;
}

/**
 * Reads a curated asset. A query that names one is answered from the plugin's own file or not at all: for
 * first-party brand assets the wrong image is worse than none ("image-unavailable").
 */
export async function loadLocalAsset(asset: LocalAsset, assetsDir: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\.svg$/i.test(asset.file)) throw new ResolveError("image-unavailable");
  let text: string;
  try { text = await readFile(join(assetsDir, asset.file), "utf8"); } catch { throw new ResolveError("image-unavailable"); }
  if (svgProblem(text)) throw new ResolveError("image-unavailable");
  return { bytes: new TextEncoder().encode(text), mime: "image/svg+xml" };
}
