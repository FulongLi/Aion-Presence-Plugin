import type { WritingPiece, WritingSource } from "../../animation/stroke/compose";
import { lookupSymbol, packSymbol, symbolSource, writingSequence } from "../../animation/stroke/registry";
import type { StrokeSequence, WritingSystem } from "../../animation/stroke/types";
import type { CharacterForm } from "../../writing/hanzi/variants";
import type { ChinesePack, DictionaryEntry } from "./chinesePack";

/**
 * What to write → a writing source (v0.4.4). The Writing Education Core's lookup, in the host where the Chinese Writing
 * Pack lives: the user names a character, a short word, a letter, a name or a symbol in natural language; Codex passes
 * the text; this finds the data — never guessing an order for anything without it.
 *
 *   Chinese (any Han character)  each character from the pack (up to WRITING_LIMITS.chinese), optionally converted
 *                                to its simplified or traditional form (OpenCC tables)
 *   a curated symbol or its name "treble clef", "高音谱号", "sharp", "π", "capital A"
 *   English letters and digits   one letter ("g") or a word or name ("HELLO", "Maria", "2026"), letter by letter
 */
export const WRITING_LIMITS = { chinese: 4, latin: 16, text: 40 } as const;

export interface WritingFacts {
  symbol: string;
  form?: CharacterForm;
  /** Make Me a Hanzi's dictionary: reading, meaning, radical, structure (an Ideographic Description Sequence), origin. */
  pinyin?: string[];
  definition?: string;
  radical?: string;
  radicalStrokes?: number[];
  decomposition?: string;
  etymology?: DictionaryEntry["etymology"];
  /** The other form, when this one has one ("国" → traditional "國"). */
  traditional?: string[];
  simplified?: string[];
  /** The form asked for, when the character was converted ("国" → "國"). */
  convertedFrom?: string;
}

export type WritingResolution =
  | { ok: true; source: WritingSource; sequence: StrokeSequence; facts: WritingFacts[]; notes: string[] }
  | { ok: false; code: string; problem: string };

const HAN = /\p{Script=Han}/u;
const LATIN_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ]*$/;

export function resolveWriting(request: { text: string; system?: WritingSystem; form?: "simplified" | "traditional" }, pack: ChinesePack | null): WritingResolution {
  const text = request.text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text || Array.from(text).length > WRITING_LIMITS.text) return { ok: false, code: "writing-invalid", problem: `give 1–${WRITING_LIMITS.text} characters to write` };
  const chinese = request.system === "chinese" || (request.system === undefined && HAN.test(text));
  if (chinese) return resolveChinese(text, request.form, pack);
  // A curated symbol, by itself or by name ("treble clef", "高音谱号", "capital A").
  const found = lookupSymbol(text, request.system);
  if (found) {
    const source = symbolSource(found.pack, found.spec);
    return { ok: true, source, sequence: writingSequence(source), facts: [{ symbol: found.spec.symbol }], notes: found.spec.note ? [found.spec.note] : [] };
  }
  if ((request.system === undefined || request.system === "latin" || request.system === "digits") && LATIN_TEXT.test(text)) {
    const letters = Array.from(text.replace(/ /g, ""));
    if (letters.length > WRITING_LIMITS.latin) return { ok: false, code: "writing-too-long", problem: `write at most ${WRITING_LIMITS.latin} letters at a time (a word or a name); split longer text` };
    const pieces: WritingPiece[] = [];
    for (const char of text) {
      if (char === " ") { if (pieces.length && pieces[pieces.length - 1].type !== "space") pieces.push({ type: "space" }); continue; }
      const id = /\d/.test(char) ? `digits:${char}` : `latin:${char}`;
      if (!packSymbol(id)) return { ok: false, code: "stroke-data-unavailable", problem: `no stroke data for "${char}"` };
      pieces.push({ type: "symbol", id });
    }
    const source: WritingSource = { system: /^\d+$/.test(text.replace(/ /g, "")) ? "digits" : "latin", text, title: letters.length > 1 ? `"${text}" in manuscript letters` : `the letter ${text}`, pieces };
    return { ok: true, source, sequence: writingSequence(source), facts: letters.map(symbol => ({ symbol })), notes: [] };
  }
  return { ok: false, code: "stroke-data-unavailable", problem: `Aion has no validated stroke data for "${text}"${request.system ? ` (${request.system})` : ""}` };
}

function resolveChinese(text: string, form: "simplified" | "traditional" | undefined, pack: ChinesePack | null): WritingResolution {
  if (!pack) return { ok: false, code: "chinese-pack-unavailable", problem: "the Chinese Writing Pack is not installed with this copy of Aion (packs/chinese-writing)" };
  const chars = Array.from(text).filter(char => !/[\s\p{P}]/u.test(char));
  const foreign = chars.filter(char => !HAN.test(char) && !pack.has(char));
  if (foreign.length) return { ok: false, code: "writing-invalid", problem: `"${foreign.join("")}" is not a Chinese character; write Chinese and other scripts separately` };
  if (!chars.length) return { ok: false, code: "writing-invalid", problem: "no Chinese character to write" };
  if (chars.length > WRITING_LIMITS.chinese) return { ok: false, code: "writing-too-long", problem: `write at most ${WRITING_LIMITS.chinese} characters at a time; split "${text}" into shorter words` };
  const notes: string[] = [];
  const facts: WritingFacts[] = [];
  const written: string[] = [];
  for (const original of chars) {
    let char = original;
    if (form) {
      const options = pack.variants(original, form);
      if (options.length) {
        char = options[0];
        notes.push(options.length > 1 ? `${original} has more than one ${form} form (${options.join(", ")}); writing ${char}, the most common — say which if the user meant another.`
          : `${original} is written ${char} in ${form} characters.`);
      } else if (pack.form(original) === (form === "traditional" ? "simplified" : "traditional")) {
        notes.push(`No ${form} form of ${original} is in the data; writing it as it is.`);
      }
    }
    if (!pack.has(char)) return { ok: false, code: "character-not-in-pack", problem: `${char} is not among the pack's ${pack.size} characters, so Aion cannot show its validated stroke order` };
    written.push(char);
    const entry = pack.entry(char);
    const data = pack.get(char)!;
    facts.push({
      symbol: char, form: data.form,
      ...(entry?.pinyin?.length ? { pinyin: entry.pinyin } : {}), ...(entry?.definition ? { definition: entry.definition } : {}),
      ...(entry?.radical ? { radical: entry.radical } : {}), ...(data.data.radStrokes ? { radicalStrokes: data.data.radStrokes.map(k => k + 1) } : {}),
      ...(entry?.decomposition && !entry.decomposition.startsWith("？") ? { decomposition: entry.decomposition } : {}),
      ...(entry?.etymology ? { etymology: entry.etymology } : {}),
      ...(pack.variants(char, "traditional").length ? { traditional: pack.variants(char, "traditional") } : {}),
      ...(pack.variants(char, "simplified").length ? { simplified: pack.variants(char, "simplified") } : {}),
      ...(char !== original ? { convertedFrom: original } : {}),
    });
  }
  const word = written.join("");
  const pieces: WritingPiece[] = written.map((char, i) => {
    const fact = facts[i];
    const title = [char, fact.pinyin?.[0], fact.definition?.split(/[;,]/)[0]?.trim()].filter(Boolean).join(" · ").slice(0, 80);
    return { type: "hanzi", char, data: pack.get(char)!.data, title };
  });
  const source: WritingSource = { system: "chinese", text: word, title: written.length > 1 ? word : (pieces[0] as { title?: string }).title ?? word, pieces };
  return { ok: true, source, sequence: writingSequence(source), facts, notes };
}
