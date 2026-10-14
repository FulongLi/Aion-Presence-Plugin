import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants, gunzipSync } from "node:zlib";
import { encodeHanzi, checkHanziData } from "../../src/writing/hanzi/codec";
import { validateHanzi } from "../../src/writing/hanzi/geometry";
import { characterForm, parseOpenccTable, type CharacterForm, type VariantTables } from "../../src/writing/hanzi/variants";
import { writePack } from "../../src/writing/pack/container";
import { CHINESE_PACK_DATE, CHINESE_PACK_DIR, CHINESE_PACK_FILES, CHINESE_PACK_VERSION, UPSTREAM } from "../../src/writing/hanzi/sources";
import { composeWriting } from "../../src/animation/stroke/compose";
import { REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run chinese:build`: builds the Chinese Writing Pack (plugins/aion-presence/packs/chinese-writing) from pinned
 * upstream releases, reproducibly. Every input is downloaded from its fixed address and checked against its SHA-256
 * before use; `--from <dir>` reads the same files from a directory instead (offline). Nothing here edits a character:
 * each upstream file is converted to the pack's compact form and checked to decode back to the identical bytes.
 *
 * Inputs (see src/writing/hanzi/sources.ts):
 *   hanzi-writer-data 2.0.1 (npm)      stroke outlines + medians        Arphic Public License
 *   Make Me a Hanzi dictionary.txt     radical, decomposition, pinyin…  LGPL-3.0-or-later (Unihan notice inside)
 *   OpenCC 1.4.2 character tables      simplified ↔ traditional         Apache-2.0
 */
const args = process.argv.slice(2);
const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : null;
const outDir = join(REPO_ROOT, CHINESE_PACK_DIR);
const cache = join(tmpdir(), "aion-chinese-pack-inputs");
mkdirSync(cache, { recursive: true });

const sha256 = (data: Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function input(name: keyof typeof UPSTREAM.files): Promise<Buffer> {
  const spec = UPSTREAM.files[name];
  const local = from ? join(from, spec.file) : join(cache, spec.file);
  let data: Buffer | null = existsSync(local) ? readFileSync(local) : null;
  if ((!data || sha256(data) !== spec.sha256) && !from) {
    const response = await fetch(spec.url, { redirect: "follow", headers: { "user-agent": "aion-presence-pack-builder (+https://github.com/FulongLi/Aion-Presence-Plugin)" } });
    if (!response.ok) throw new Error(`download failed: ${spec.url} (${response.status})`);
    data = Buffer.from(await response.arrayBuffer());
    writeFileSync(local, data);
  }
  if (!data) throw new Error(`missing input ${spec.file} in ${from}`);
  if (sha256(data) !== spec.sha256) throw new Error(`checksum mismatch for ${spec.file}: ${sha256(data)} ≠ ${spec.sha256}`);
  return data;
}

/** The regular files of a (gzipped) ustar archive, by name. Only plain files are read; nothing is written to disk. */
function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = (field(345, 155) ? `${field(345, 155)}/` : "") + field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    if (type === "0") files.set(name, Buffer.from(tar.subarray(at + 512, at + 512 + size)));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const brotli = (block: Uint8Array) => brotliCompressSync(block, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 22, [constants.BROTLI_PARAM_SIZE_HINT]: block.length },
});

const today = CHINESE_PACK_DATE;

function notice(what: string, license: string, changes: string): string {
  return [
    `Aion Presence — Chinese Writing Pack ${CHINESE_PACK_VERSION} — ${what}`,
    `License: ${license} (see the license files in this directory). This file is not covered by Aion Presence's own license.`,
    `MODIFICATION NOTICE: ${changes}`,
    `Converted on ${today} by scripts/chinese/build-pack.ts (Aion Presence). Source: see manifest.json and NOTICE.md.`,
    "No warranty: the data is provided AS IS, without warranty of any kind.",
    "",
  ].join("\n");
}

async function main() {
  const tarball = await input("hanziWriterData");
  const dictionary = (await input("dictionary")).toString("utf8");
  const st = parseOpenccTable((await input("openccST")).toString("utf8"));
  const ts = parseOpenccTable((await input("openccTS")).toString("utf8"));
  const licenses = {
    arphic: await input("arphicLicense"), lgpl: await input("lgpl"), gpl: await input("gpl"), mmahCopying: await input("mmahCopying"), opencc: await input("openccLicense"),
  };

  // ── Strokes ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const files = untar(tarball);
  const entries = [...files].filter(([name]) => /^package\/[^/]+\.json$/.test(name) && name !== "package/package.json");
  const upstreamArphic = files.get("package/ARPHICPL.TXT");
  if (!upstreamArphic || !upstreamArphic.equals(licenses.arphic)) throw new Error("the license in the tarball differs from the pinned ARPHICPL.TXT");
  const records: { codepoint: number; char: string; data: Uint8Array }[] = [];
  const failures: { file: string; problems: string[] }[] = [];
  const verbatim: string[] = [];
  const missingStrokes: string[] = [];
  const noRadical: string[] = [];
  for (const [name, bytes] of entries) {
    const char = name.slice("package/".length, -".json".length);
    if ([...char].length !== 1) { failures.push({ file: name, problems: ["file name is not one character"] }); continue; }
    const text = bytes.toString("utf8");
    try {
      const data = checkHanziData(JSON.parse(text));
      if (!data.strokes.length) { missingStrokes.push(char); continue; }
      const problems = validateHanzi(data);
      if (problems.length) { failures.push({ file: name, problems: problems.map(p => `${p.stroke !== undefined ? `stroke ${p.stroke + 1}: ` : ""}${p.problem}`) }); continue; }
      // The production pipeline must accept it: composed, measured and validated exactly as Aion will write it.
      try { composeWriting({ system: "chinese", text: char, title: char, pieces: [{ type: "hanzi", char, data }] }, () => null); }
      catch (error) { failures.push({ file: name, problems: [`cannot be composed for writing (${error instanceof Error ? error.message : String(error)})`] }); continue; }
      const encoded = encodeHanzi(text);
      if (encoded.format === "json") verbatim.push(char);
      if (!data.radStrokes) noRadical.push(char);
      records.push({ codepoint: char.codePointAt(0)!, char, data: encoded.record });
    } catch (error) {
      failures.push({ file: name, problems: [error instanceof Error ? error.message : String(error)] });
    }
  }
  records.sort((a, b) => a.codepoint - b.codepoint);
  const chars = new Set(records.map(record => record.char));

  // ── Dictionary (verbatim lines) ─────────────────────────────────────────────────────────────────────────────────────
  const dictionaryRecords: { codepoint: number; data: Uint8Array }[] = [];
  const dictionaryMissing: string[] = [];
  const seen = new Set<string>();
  for (const line of dictionary.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { character: string };
    if (!chars.has(entry.character) || seen.has(entry.character)) continue;
    seen.add(entry.character);
    dictionaryRecords.push({ codepoint: entry.character.codePointAt(0)!, data: new TextEncoder().encode(line) });
  }
  for (const char of chars) if (!seen.has(char)) dictionaryMissing.push(char);
  dictionaryRecords.sort((a, b) => a.codepoint - b.codepoint);

  // ── Variants (the OpenCC tables, reduced to the pack's characters) ──────────────────────────────────────────────────
  const reduce = (table: Record<string, string[]>) => Object.fromEntries(Object.entries(table).filter(([key]) => chars.has(key)).sort(([a], [b]) => a.codePointAt(0)! - b.codePointAt(0)!));
  const tables: VariantTables = { s2t: reduce(st), t2s: reduce(ts) };
  const forms: Record<CharacterForm, string[]> = { simplified: [], traditional: [], shared: [], component: [] };
  for (const record of records) forms[characterForm(record.char, tables)].push(record.char);

  // ── Write ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const write = (file: string, data: string | Uint8Array) => { writeFileSync(join(outDir, file), data); return file; };
  write(CHINESE_PACK_FILES.strokes, writePack({
    notice: notice("character stroke outlines and medians", "Arphic Public License",
      `converted from hanzi-writer-data ${UPSTREAM.hanziWriterDataVersion} (one JSON file per character) to this block-compressed binary form; each record decodes to its original file byte for byte (npm run chinese:export). ${failures.length + missingStrokes.length} upstream files that fail validation are left out (coverage.json). No glyph was altered.`),
    kind: "strokes", blockSize: 32, records, compress: brotli,
  }));
  write(CHINESE_PACK_FILES.dictionary, writePack({
    notice: notice("character dictionary (radical, decomposition, etymology, pinyin, definition)", "GNU LGPL-3.0-or-later; Unicode notice for Unihan-derived data",
      `the lines of Make Me a Hanzi's dictionary.txt (commit ${UPSTREAM.makemeahanziCommit.slice(0, 12)}) for the pack's characters, stored verbatim and block-compressed. No entry was altered.`),
    kind: "dictionary", blockSize: 64, records: dictionaryRecords, compress: brotli,
  }));
  write(CHINESE_PACK_FILES.variants, `${JSON.stringify({
    notice: `Derived from OpenCC ${UPSTREAM.openccVersion} data/dictionary/STCharacters.txt and TSCharacters.txt (Apache-2.0): reduced on ${today} to entries whose key is a character of this pack; values unchanged.`,
    ...tables,
  })}\n`);
  write(CHINESE_PACK_FILES.arphicLicense, licenses.arphic);
  write(CHINESE_PACK_FILES.lgpl, licenses.lgpl);
  write(CHINESE_PACK_FILES.gpl, licenses.gpl);
  write(CHINESE_PACK_FILES.mmahCopying, licenses.mmahCopying);
  write(CHINESE_PACK_FILES.openccLicense, licenses.opencc);

  const counts = {
    upstreamFiles: entries.length,
    imported: records.length,
    validated: records.length,
    failed: failures.length,
    missingStrokeData: missingStrokes.length,
    storedVerbatim: verbatim.length,
    withoutRadicalStrokes: noRadical.length,
    dictionaryEntries: dictionaryRecords.length,
    forms: { simplifiedOnly: forms.simplified.length, traditionalOnly: forms.traditional.length, shared: forms.shared.length, componentForms: forms.component.length },
    simplifiedCoverage: forms.simplified.length + forms.shared.length,
    traditionalCoverage: forms.traditional.length + forms.shared.length,
  };
  write(CHINESE_PACK_FILES.coverage, `${JSON.stringify({
    pack: CHINESE_PACK_VERSION, generated: today, upstream: `hanzi-writer-data ${UPSTREAM.hanziWriterDataVersion}`,
    rule: "Each character is counted once. simplifiedOnly + traditionalOnly + shared + componentForms = imported. Simplified coverage = simplifiedOnly + shared; traditional coverage = traditionalOnly + shared (OpenCC tables).",
    counts,
    failures, missingStrokeData: missingStrokes.join(""), storedVerbatim: verbatim.join(""), withoutRadicalStrokes: noRadical.join(""),
    dictionaryMissing: dictionaryMissing.join(""),
    characters: { simplifiedOnly: forms.simplified.join(""), traditionalOnly: forms.traditional.join(""), shared: forms.shared.join(""), componentForms: forms.component.join("") },
  }, null, 1)}\n`);
  const checksums = Object.fromEntries(Object.values(CHINESE_PACK_FILES).filter(file => file !== CHINESE_PACK_FILES.manifest && file !== CHINESE_PACK_FILES.notice)
    .map(file => [file, sha256(readFileSync(join(outDir, file)))]));
  write(CHINESE_PACK_FILES.notice, noticeMarkdown(counts));
  checksums[CHINESE_PACK_FILES.notice] = sha256(readFileSync(join(outDir, CHINESE_PACK_FILES.notice)));
  write(CHINESE_PACK_FILES.manifest, `${JSON.stringify({
    name: "aion-chinese-writing-pack", version: CHINESE_PACK_VERSION, built: today, builder: "scripts/chinese/build-pack.ts",
    convention: "Stroke order and shapes as in Make Me a Hanzi / Hanzi Writer data (derived from Arphic PL KaitiM GB and UKai fonts; order follows the mainland standard for simplified forms and the data's own order for traditional forms).",
    counts, upstream: UPSTREAM, files: checksums,
  }, null, 1)}\n`);
  console.log(JSON.stringify(counts, null, 1));
  for (const file of Object.values(CHINESE_PACK_FILES)) console.log(`${file.padEnd(28)} ${readFileSync(join(outDir, file)).length} B`);
}

function noticeMarkdown(counts: Record<string, unknown>): string {
  return `# Aion Chinese Writing Pack ${CHINESE_PACK_VERSION}

This directory is a separate, license-governed resource pack inside the Aion Presence plugin. **It is not covered by Aion
Presence's own license**; each file keeps the license of the data it comes from. Aion's code reads these files at run
time and never mixes them into its own sources (mere aggregation on one distribution medium).

| File | Contents | Source | License |
| --- | --- | --- | --- |
| \`${CHINESE_PACK_FILES.strokes}\` | stroke outlines and medians of ${(counts as { imported: number }).imported} characters | hanzi-writer-data ${UPSTREAM.hanziWriterDataVersion} (from Make Me a Hanzi graphics, derived from Arphic PL KaitiM GB and Arphic PL UKai) | Arphic Public License (\`${CHINESE_PACK_FILES.arphicLicense}\`) |
| \`${CHINESE_PACK_FILES.dictionary}\` | radical, decomposition, etymology, pinyin, definition | Make Me a Hanzi \`dictionary.txt\`, commit ${UPSTREAM.makemeahanziCommit} (from Unihan and CJKlib) | LGPL-3.0-or-later (\`${CHINESE_PACK_FILES.lgpl}\`, \`${CHINESE_PACK_FILES.gpl}\`, \`${CHINESE_PACK_FILES.mmahCopying}\`; the Unicode notice is at the top of the LGPL file) |
| \`${CHINESE_PACK_FILES.variants}\` | simplified ↔ traditional character tables | OpenCC ${UPSTREAM.openccVersion} \`STCharacters.txt\`, \`TSCharacters.txt\` | Apache-2.0 (\`${CHINESE_PACK_FILES.openccLicense}\`) |
| \`${CHINESE_PACK_FILES.coverage}\` | the machine-readable coverage report | generated | — |
| \`${CHINESE_PACK_FILES.manifest}\` | version, upstream pins, SHA-256 of every file | generated | — |

## Modifications (Arphic Public License §2a; LGPL; Unicode notice; Apache-2.0 §4b)

- **${CHINESE_PACK_FILES.strokes}** — converted on ${today} from one JSON file per character to a block-compressed binary
  record format (format conversion only). Every record decodes back to its original JSON file, byte for byte;
  \`npm run chinese:export -- <dir>\` writes those files out again. Upstream files that fail validation are left out and
  listed in \`${CHINESE_PACK_FILES.coverage}\`. No glyph, stroke order or median was changed. The notice at the top of the file
  says the same.
- **${CHINESE_PACK_FILES.dictionary}** — the lines of \`dictionary.txt\` for the pack's characters, stored verbatim in the same
  block-compressed container on ${today}. No entry was changed.
- **${CHINESE_PACK_FILES.variants}** — the two OpenCC tables reduced on ${today} to entries whose key is a character of the
  pack; values unchanged.

## Getting the source

The modified files are available to everyone, under their licenses, in this public repository
(https://github.com/FulongLi/Aion-Presence-Plugin, directory \`${CHINESE_PACK_DIR}\`). The unmodified upstream data is at the
pinned addresses in \`manifest.json\` (each checked by SHA-256). \`npm run chinese:build\` rebuilds this directory from them;
\`npm run chinese:export -- <dir>\` recovers the original per-character JSON files.

## Attribution

- Hanzi Writer and hanzi-writer-data by David Chanin — https://github.com/chanind/hanzi-writer, https://github.com/chanind/hanzi-writer-data
- Make Me a Hanzi by Shaunak Kishore — https://github.com/skishore/makemeahanzi
- Fonts by Arphic Technology Co., Ltd. (AR PL KaitiM GB, AR PL UKai), released under the Arphic Public License in 1999
- Unihan database © Unicode, Inc.; CJKlib
- OpenCC by Carbo Kuo (BYVoid) and contributors — https://github.com/BYVoid/OpenCC

## Warranty

None. The data is provided "as is", without warranty of any kind (Arphic Public License §7; LGPL/GPL §15–16; Apache-2.0 §7).
`;
}

await main();
