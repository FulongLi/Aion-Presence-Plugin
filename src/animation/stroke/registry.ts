import { buildSequence } from "./path";
import { CHINESE_PACK } from "./packs/chinese";
import { DIGITS_PACK, LATIN_PACK } from "./packs/latin";
import { MATH_PACK, MUSIC_PACK } from "./packs/symbols";
import type { StrokePack, StrokeSequence, WritingSystem } from "./types";

/**
 * Every writing data pack, and lookup by symbol or name. A symbol that is not here is not written: the engine never
 * infers an order from a font outline.
 */
export const STROKE_PACKS: readonly StrokePack[] = [CHINESE_PACK, LATIN_PACK, DIGITS_PACK, MUSIC_PACK, MATH_PACK];

const cache = new Map<string, StrokeSequence>();
const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-.,'"“”‘’!?]+/g, " ").replace(/^(?:the|a|an)\s+/, "").replace(/\s+(?:sign|symbol|character)$/, "");

/** The built sequence for a pack's symbol (built once, validated). */
function sequenceFor(pack: StrokePack, symbol: string): StrokeSequence {
  const key = `${pack.system}:${symbol}`;
  let sequence = cache.get(key);
  if (!sequence) {
    const spec = pack.symbols.find(item => item.symbol === symbol);
    if (!spec) throw new Error("stroke-symbol-unknown");
    sequence = buildSequence(pack, spec);
    cache.set(key, sequence);
  }
  return sequence;
}

/** A sequence by its id ("chinese:永", "latin:A", "music:𝄞"). */
export function strokeSequence(id: string): StrokeSequence | null {
  const at = id.indexOf(":");
  const pack = STROKE_PACKS.find(item => item.system === id.slice(0, at));
  if (!pack || !pack.symbols.some(item => item.symbol === id.slice(at + 1))) return null;
  return sequenceFor(pack, id.slice(at + 1));
}

/**
 * Finds a symbol: the symbol itself first (case matters: "a" and "A" are different letters), then a name in any listed
 * language ("eternity", "treble clef", "高音谱号", "capital A"). `system` narrows the search ("7" as a digit, "π").
 */
export function lookupStroke(query: string, system?: WritingSystem): StrokeSequence | null {
  const packs = system ? STROKE_PACKS.filter(pack => pack.system === system) : STROKE_PACKS;
  const raw = query.normalize("NFKC").trim();
  if (!raw || raw.length > 60) return null;
  // "-" written for minus, "x" for times only when a mathematical symbol was asked for.
  for (const pack of packs) {
    const exact = pack.symbols.find(item => item.symbol === raw || item.symbol.normalize("NFKC") === raw);
    if (exact) return sequenceFor(pack, exact.symbol);
  }
  const wanted = normalize(raw);
  for (const pack of packs) {
    const named = pack.symbols.find(item => item.names.some(name => normalize(name) === wanted));
    if (named) return sequenceFor(pack, named.symbol);
  }
  // "the letter a", "字 永": a single symbol inside a short phrase.
  const single = /^(?:letter|number|digit|character|字|汉字)\s*(\S)$/u.exec(raw.replace(/^(?:the|a)\s+/i, ""));
  return single ? lookupStroke(single[1], system) : null;
}

/** What each pack offers, for the tool description and failures ("chinese: 一 二 三 …"). */
export function strokeCatalog(): Record<WritingSystem, string[]> {
  return Object.fromEntries(STROKE_PACKS.map(pack => [pack.system, pack.symbols.map(item => item.symbol)])) as Record<WritingSystem, string[]>;
}

export const strokeCatalogText = () => Object.entries(strokeCatalog())
  .map(([system, symbols]) => `${system}: ${system === "latin" ? "A–Z, a–z" : system === "digits" ? "0–9" : symbols.join(" ")}`).join("; ");
