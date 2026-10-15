import { composeWriting, type WritingSource } from "./compose";
import { DIGITS_PACK, LATIN_PACK } from "./packs/latin";
import { MATH_PACK, MUSIC_PACK } from "./packs/symbols";
import type { StrokePack, StrokeSequence, SymbolSpec, WritingSystem } from "./types";

/**
 * The curated writing packs (letters, digits, music, mathematics) and lookup by symbol or name, plus composed writings
 * (v0.4.4). Chinese characters are not here: they come from the Chinese Writing Pack in the host (host/writing), which
 * puts each character's data into the writing it composes. A symbol without data is not written: the engine never
 * infers an order from a font outline.
 */
export const STROKE_PACKS: readonly StrokePack[] = [LATIN_PACK, DIGITS_PACK, MUSIC_PACK, MATH_PACK];

const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-.,'"“”‘’!?]+/g, " ").replace(/^(?:the|a|an)\s+/, "").replace(/\s+(?:sign|symbol|character)$/, "");

/** A curated symbol by id ("latin:A", "music:𝄞"). */
export function packSymbol(id: string): { pack: StrokePack; spec: SymbolSpec } | null {
  const at = id.indexOf(":");
  const pack = STROKE_PACKS.find(item => item.system === id.slice(0, at));
  const spec = pack?.symbols.find(item => item.symbol === id.slice(at + 1));
  return pack && spec ? { pack, spec } : null;
}

/** A single curated symbol as a writing source. */
export const symbolSource = (pack: StrokePack, spec: SymbolSpec): WritingSource =>
  ({ system: pack.system, text: spec.symbol, title: spec.title, pieces: [{ type: "symbol", id: `${pack.system}:${spec.symbol}` }] });

const cache = new Map<string, StrokeSequence>();
/** A cheap fingerprint of a source, so a cached sequence is never reused for different data under the same text. */
const keyOf = (source: WritingSource) => `${source.system}|${source.text}|${source.pieces.map(piece => piece.type === "hanzi"
  ? `h${piece.char}${piece.data.strokes.length}:${piece.data.strokes.reduce((n, s) => n + s.length, 0)}:${piece.data.medians.flat(2).reduce((n, v) => n + v, 0)}`
  : piece.type === "symbol" ? piece.id : "_").join(",")}`;

/** The composed, validated sequence of a writing (cached; throws on invalid input). */
export function writingSequence(source: WritingSource): StrokeSequence {
  const key = keyOf(source);
  let sequence = cache.get(key);
  if (!sequence) {
    sequence = composeWriting(source, packSymbol);
    cache.set(key, sequence);
    while (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return sequence;
}

/** A curated symbol's sequence by id ("chinese:…" ids are not curated and return null). */
export function strokeSequence(id: string): StrokeSequence | null {
  const found = packSymbol(id);
  return found ? writingSequence(symbolSource(found.pack, found.spec)) : null;
}

/**
 * Finds a curated symbol: the symbol itself first (case matters: "a" and "A" are different letters), then a name in any
 * listed language ("treble clef", "高音谱号", "capital A"). `system` narrows the search ("7" as a digit, "π").
 */
export function lookupSymbol(query: string, system?: WritingSystem): { pack: StrokePack; spec: SymbolSpec } | null {
  const packs = system ? STROKE_PACKS.filter(pack => pack.system === system) : STROKE_PACKS;
  const raw = query.normalize("NFKC").trim();
  if (!raw || raw.length > 60) return null;
  for (const pack of packs) {
    const exact = pack.symbols.find(item => item.symbol === raw || item.symbol.normalize("NFKC") === raw);
    if (exact) return { pack, spec: exact };
  }
  const wanted = normalize(raw);
  for (const pack of packs) {
    const named = pack.symbols.find(item => item.names.some(name => normalize(name) === wanted));
    if (named) return { pack, spec: named };
  }
  // "the letter a", "number 7": a single symbol inside a short phrase.
  const single = /^(?:letter|number|digit|character|symbol)\s*(\S)$/iu.exec(raw.replace(/^(?:the|a)\s+/i, ""));
  return single ? lookupSymbol(single[1], system) : null;
}

/** The sequence of a curated symbol found by `lookupSymbol`. */
export function lookupStroke(query: string, system?: WritingSystem): StrokeSequence | null {
  const found = lookupSymbol(query, system);
  return found ? writingSequence(symbolSource(found.pack, found.spec)) : null;
}

/** What each curated pack offers ("music: 𝄞 𝄢 …"). */
export function strokeCatalog(): Partial<Record<WritingSystem, string[]>> {
  return Object.fromEntries(STROKE_PACKS.map(pack => [pack.system, pack.symbols.map(item => item.symbol)]));
}

export const strokeCatalogText = () => Object.entries(strokeCatalog())
  .map(([system, symbols]) => `${system}: ${system === "latin" ? "A–Z, a–z" : system === "digits" ? "0–9" : symbols!.join(" ")}`).join("; ");
