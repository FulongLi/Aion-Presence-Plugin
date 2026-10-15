import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { decodeHanzi, type HanziData } from "../../writing/hanzi/codec";
import { CHINESE_PACK_FILES, CHINESE_PACK_PLUGIN_DIR } from "../../writing/hanzi/sources";
import { characterForm, otherForms, type CharacterForm, type VariantTables } from "../../writing/hanzi/variants";
import { findCodepoint, readPackHeader, readPackIndex, recordInBlock, type PackHeader } from "../../writing/pack/container";

/**
 * The Chinese Writing Pack in the host (v0.4.4): reads one character at a time from the installed pack, offline.
 *
 * Nothing is read at startup. The first lookup reads the small index (4 bytes a character); each character then costs one
 * positional read of its compressed block (≈ 32 characters, ≈ 23 KB) and a brotli decompression. Decoded characters
 * are kept in a small LRU cache; blocks are not kept. The pack ships inside the plugin (packs/chinese-writing), so a
 * normal installation has every character with no download and no CDN.
 */
export interface ChineseEntry {
  char: string;
  data: HanziData;
  form: CharacterForm;
}

/** One dictionary line of Make Me a Hanzi (only the fields Aion uses are typed). */
export interface DictionaryEntry {
  character: string;
  definition?: string;
  pinyin?: string[];
  decomposition?: string;
  radical?: string;
  etymology?: { type?: string; hint?: string; phonetic?: string; semantic?: string };
  matches?: (number[] | null)[];
}

class BlockFile {
  private header: PackHeader | null = null;
  private index: { codepoints: Uint32Array; offsets: Uint32Array } | null = null;
  constructor(readonly path: string) {}

  private read(position: number, length: number): Uint8Array {
    const fd = openSync(this.path, "r");
    try {
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const n = readSync(fd, out, done, length - done, position + done);
        if (n <= 0) throw new Error("pack-truncated");
        done += n;
      }
      return out;
    } finally { closeSync(fd); }
  }

  private open() {
    if (this.header && this.index) return { header: this.header, index: this.index };
    // The notice is a few hundred bytes; 8 KB holds it and the fixed header.
    const head = this.read(0, 8192);
    const header = readPackHeader(head);
    const index = readPackIndex(header, this.read(header.indexOffset, header.dataOffset - header.indexOffset));
    this.header = header; this.index = index;
    return { header, index };
  }

  get count() { return this.open().header.count; }

  has(codepoint: number) { return findCodepoint(this.open().index.codepoints, codepoint) >= 0; }

  codepoints(): Uint32Array { return this.open().index.codepoints; }

  record(codepoint: number): Uint8Array | null {
    const { header, index } = this.open();
    const i = findCodepoint(index.codepoints, codepoint);
    if (i < 0) return null;
    const block = Math.floor(i / header.blockSize);
    const start = index.offsets[block], end = index.offsets[block + 1];
    const compressed = this.read(header.dataOffset + start, end - start);
    return recordInBlock(brotliDecompressSync(compressed), i % header.blockSize);
  }
}

export class ChinesePack {
  private readonly strokes: BlockFile;
  private readonly dictionary: BlockFile;
  private tables: VariantTables | null = null;
  private readonly cache = new Map<string, ChineseEntry>();
  private readonly limit: number;

  constructor(readonly dir: string, options: { cache?: number } = {}) {
    this.strokes = new BlockFile(join(dir, CHINESE_PACK_FILES.strokes));
    this.dictionary = new BlockFile(join(dir, CHINESE_PACK_FILES.dictionary));
    this.limit = options.cache ?? 256;
  }

  /** The pack's manifest (version, counts, upstream pins). */
  manifest(): { version: string; counts: { imported: number; simplifiedCoverage: number; traditionalCoverage: number } } {
    return JSON.parse(readFileSync(join(this.dir, CHINESE_PACK_FILES.manifest), "utf8"));
  }

  get size() { return this.strokes.count; }

  /** Characters held and decoded (for diagnostics and tests). */
  get cached() { return this.cache.size; }

  private variantTables(): VariantTables {
    return (this.tables ??= JSON.parse(readFileSync(join(this.dir, CHINESE_PACK_FILES.variants), "utf8")) as VariantTables);
  }

  has(char: string): boolean {
    const cp = char.codePointAt(0);
    return [...char].length === 1 && cp !== undefined && this.strokes.has(cp);
  }

  /** A character's stroke data, or null when the pack does not hold it. */
  get(char: string): ChineseEntry | null {
    if ([...char].length !== 1) return null;
    const hit = this.cache.get(char);
    if (hit) { this.cache.delete(char); this.cache.set(char, hit); return hit; }
    const record = this.strokes.record(char.codePointAt(0)!);
    if (!record) return null;
    const entry: ChineseEntry = { char, data: decodeHanzi(record).data, form: characterForm(char, this.variantTables()) };
    this.cache.set(char, entry);
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }

  /** The original upstream JSON text of a character (lossless; for `npm run chinese:export` and the tests). */
  upstreamText(char: string): string | null {
    const record = this.strokes.record(char.codePointAt(0) ?? -1);
    return record ? decodeHanzi(record).text : null;
  }

  /** Make Me a Hanzi's dictionary entry: radical, decomposition, etymology, pinyin, definition. */
  entry(char: string): DictionaryEntry | null {
    const record = this.dictionary.record(char.codePointAt(0) ?? -1);
    return record ? JSON.parse(new TextDecoder().decode(record)) as DictionaryEntry : null;
  }

  form(char: string): CharacterForm { return characterForm(char, this.variantTables()); }

  /** The character's forms toward `target` that the pack holds (国 → 國; 發 and 髮 for 发). */
  variants(char: string, target: "traditional" | "simplified"): string[] {
    return otherForms(char, target, this.variantTables()).filter(form => this.has(form));
  }

  /** Every character in the pack, in code point order (for the export and the tests). */
  *characters(): Generator<string> {
    for (const cp of this.strokes.codepoints()) yield String.fromCodePoint(cp);
  }
}

/** Where the installed pack is: beside the runtime (plugin/packs), in the repository during development, or an override. */
export function locateChinesePack(env: NodeJS.ProcessEnv = process.env): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.AION_CHINESE_PACK,
    join(here, "..", CHINESE_PACK_PLUGIN_DIR),
    join(here, "../../../plugins/aion-presence", CHINESE_PACK_PLUGIN_DIR),
    join(here, "../../plugins/aion-presence", CHINESE_PACK_PLUGIN_DIR),
  ];
  return candidates.find((dir): dir is string => Boolean(dir && existsSync(join(dir, CHINESE_PACK_FILES.strokes)))) ?? null;
}

let shared: ChinesePack | null | undefined;
/** The process's pack (opened on first use; null when the plugin was installed without it). */
export function chinesePack(env: NodeJS.ProcessEnv = process.env): ChinesePack | null {
  if (shared === undefined) { const dir = locateChinesePack(env); shared = dir ? new ChinesePack(dir) : null; }
  return shared;
}
