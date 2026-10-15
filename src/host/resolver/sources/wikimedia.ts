import { PORTRAIT_INTENTS, type ImageIntent } from "../../../visual/types";
import { fetchJSON, HOSTS, overlap, tokens, type Fetcher } from "../net";
import { namedAfter } from "../rank";
import type { ImageCandidate, ImageProvider } from "../types";

/**
 * Wikimedia through its public, anonymous API. Only the query text is sent.
 * Two providers share this source:
 * - wikipedia: the freely licensed lead image of the article that best matches the query
 *   (people, vehicles, products, places — anything with an article); when the article itself shows none, the
 *   image its Wikidata item names (P18), so a person is never replaced by something named after them;
 * - commons: a Wikimedia Commons file search (broad, freely licensed photos, maps and drawings).
 */
type WikiPage = {
  title: string; index?: number; pageimage?: string; pageprops?: { disambiguation?: string; wikibase_item?: string };
  thumbnail?: { source: string; width: number; height: number };
  imageinfo?: { url: string; thumburl?: string; thumbwidth?: number; thumbheight?: number; width?: number; height?: number;
    mime?: string; thumbmime?: string; descriptionurl?: string }[];
};
type WikiData = { query?: { pages?: WikiPage[] }; error?: unknown };
type Claims = { claims?: { P18?: { rank?: string; mainsnak?: { datavalue?: { value?: unknown } } }[] }; error?: unknown };

/** Wikimedia's thumbnail host now serves standard widths only; 960 is one of them. */
export const THUMB_WIDTH = 960;
const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

export function wikiLanguage(text: string) {
  if (/[가-힯]/u.test(text)) return "ko";
  if (/[぀-ヿ]/u.test(text)) return "ja";
  return CJK.test(text) ? "zh" : "en";
}

async function wiki(host: string, params: Record<string, string>, signal: AbortSignal, request?: Fetcher) {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", ...params }).toString();
  const { data, ms } = await fetchJSON<WikiData>(url, { hosts: [HOSTS.wikipedia, HOSTS.commons], signal, request, maxBytes: 1024 * 1024 });
  if (data.error) throw new Error("provider-error");
  return { pages: data.query?.pages ?? [], ms };
}

const mimeFromURL = (url: string) => {
  const path = url.split("?")[0].toLowerCase();
  if (/\.jpe?g$/.test(path)) return "image/jpeg";
  if (/\.png$/.test(path)) return "image/png";
  if (/\.webp$/.test(path)) return "image/webp";
  return undefined;
};
/** Generational suffixes that still name the same person ("Martin Luther King Jr." is not named after anyone). */
const SUFFIXES = ["jr", "sr", "ii", "iii", "iv"];

/**
 * An article that carries the whole name and then goes on ("Nikola Tesla Museum", "Tesla, Inc."): named after the
 * person, not about them. A trailing "(inventor)" disambiguates rather than extends.
 */
export function extendsName(query: string, title: string) {
  const asked = tokens(query), named = tokens(title.replace(/\s*\([^)]*\)\s*$/, ""));
  if (!asked.length || !asked.every(word => named.includes(word))) return false;
  return named.slice(named.lastIndexOf(asked[asked.length - 1]) + 1).some(word => !SUFFIXES.includes(word));
}

/**
 * The image an article's Wikidata item names (P18), as a Commons thumbnail. Only the item id leaves the machine.
 * Commons hosts only freely licensed files.
 */
async function itemImage(item: string, signal: AbortSignal, request?: Fetcher) {
  if (!/^Q\d+$/.test(item)) return null;
  const url = new URL(`https://${HOSTS.wikidata}/w/api.php`);
  url.search = new URLSearchParams({ action: "wbgetclaims", format: "json", entity: item, property: "P18" }).toString();
  const { data } = await fetchJSON<Claims>(url, { hosts: [HOSTS.wikidata], signal, request, maxBytes: 256 * 1024 });
  const claims = (data.claims?.P18 ?? []).filter(claim => claim.rank !== "deprecated");
  const file = (claims.find(claim => claim.rank === "preferred") ?? claims[0])?.mainsnak?.datavalue?.value;
  if (typeof file !== "string" || !file) return null;
  const { pages } = await wiki(HOSTS.commons, { titles: `File:${file}`, prop: "imageinfo", iiprop: "url|size|mime|thumbmime", iiurlwidth: String(THUMB_WIDTH) }, signal, request);
  const info = pages[0]?.imageinfo?.[0];
  if (!info) return null;
  const source = info.thumburl ?? info.url;
  return { source, width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height, mime: info.thumbmime ?? mimeFromURL(source) ?? info.mime };
}

const fileTitle = (title: string) => title.replace(/^File:/, "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ");

/** Lead images of Wikipedia articles: the exact title (following redirects) first, then a search. */
export function wikipediaProvider(request?: Fetcher): ImageProvider {
  return {
    name: "wikipedia",
    async search(query, intent, signal) {
      const host = `${wikiLanguage(query)}.wikipedia.org`;
      const lookup = { prop: "pageimages|pageprops", piprop: "name|thumbnail", pithumbsize: String(THUMB_WIDTH), pilicense: "free" };
      const usable = (page: WikiPage) => page.thumbnail && page.pageprops?.disambiguation === undefined;
      const toCandidate = (page: WikiPage, relevance: number,
        image: { source: string; width?: number; height?: number; mime?: string } = { ...page.thumbnail!, mime: mimeFromURL(page.thumbnail!.source) }): ImageCandidate => ({
        provider: "wikipedia", url: image.source, title: page.title, width: image.width, height: image.height, mime: image.mime,
        relevance, pageUrl: `https://${host}/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
        license: "free (Wikimedia Commons)",
      });
      const exact = await wiki(host, { titles: query, redirects: "1", ...lookup }, signal, request);
      const page = exact.pages.find(usable);
      if (page) return [toCandidate(page, 1)];
      // The article exists but shows no free lead image (an edit to its infobox is enough): the image its Wikidata
      // item names is still a picture of the subject, where a search would find things named after it.
      const article = exact.pages.find(p => p.pageprops?.wikibase_item && p.pageprops.disambiguation === undefined);
      if (article) {
        try {
          const image = await itemImage(article.pageprops!.wikibase_item!, signal, request);
          if (image) return [toCandidate(article, 1, image)];
        } catch { signal.throwIfAborted(); }
      }
      // A search is only trusted when the article title shares most of the query's words, so a
      // descriptive query ("futuristic concept car") does not pick an unrelated article's photo.
      const found = await wiki(host, { generator: "search", gsrsearch: query, gsrnamespace: "0", gsrlimit: "5", ...lookup }, signal, request);
      const minimum = intent === "reference" || intent === "general" ? 0.6 : 0.5;
      const person = PORTRAIT_INTENTS.includes(intent);
      return found.pages.filter(p => usable(p) && overlap(query, p.title) >= minimum && !(person && (extendsName(query, p.title) || namedAfter(query, p.title))))
        .map(p => toCandidate(p, overlap(query, p.title) * (1 - Math.min(4, (p.index ?? 5) - 1) * 0.06)))
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 3);
    },
  };
}

/** Wikimedia Commons file search. Maps may be drawings (SVG); their thumbnails are rasterized PNGs. */
export function commonsProvider(request?: Fetcher): ImageProvider {
  return {
    name: "commons",
    async search(query: string, intent: ImageIntent, signal: AbortSignal) {
      const search = intent === "map" ? `${query} map` : `${query} filetype:bitmap`;
      const { pages } = await wiki(HOSTS.commons, {
        generator: "search", gsrsearch: search, gsrnamespace: "6", gsrlimit: "12",
        prop: "imageinfo", iiprop: "url|size|mime|thumbmime", iiurlwidth: String(THUMB_WIDTH),
      }, signal, request);
      return pages.flatMap(page => {
        const info = page.imageinfo?.[0];
        if (!info) return [];
        const url = info.thumburl ?? info.url;
        return [{
          provider: "commons", url, title: fileTitle(page.title),
          width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height,
          mime: info.thumbmime ?? mimeFromURL(url) ?? info.mime,
          relevance: overlap(query, fileTitle(page.title)) * (1 - Math.min(10, (page.index ?? 12) - 1) * 0.03),
          pageUrl: info.descriptionurl, license: "free (Wikimedia Commons)",
        } satisfies ImageCandidate];
      });
    },
  };
}
