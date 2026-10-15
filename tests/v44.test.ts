import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connectAion, tempHome } from "./helpers";
import { findCodepoint, joinRecords, pushVarint, readPackHeader, readPackIndex, readVarint, recordInBlock, writePack } from "../src/writing/pack/container";
import { canonicalJson, decodeHanzi, encodeHanzi, formatHalf } from "../src/writing/hanzi/codec";
import { flattenOutline, insideOutline, outlineArea, ringArea, validateHanzi, HANZI_EM } from "../src/writing/hanzi/geometry";
import { characterForm, parseOpenccTable } from "../src/writing/hanzi/variants";
import { CHINESE_PACK_DIR, CHINESE_PACK_FILES } from "../src/writing/hanzi/sources";
import { ChinesePack, locateChinesePack } from "../src/host/writing/chinesePack";
import { resolveWriting, WRITING_LIMITS } from "../src/host/writing/resolve";
import { composeWriting, smoothMedian, trimLeadIn } from "../src/animation/stroke/compose";
import { packSymbol, writingSequence, STROKE_PACKS } from "../src/animation/stroke/registry";
import { STROKE_SPACE } from "../src/animation/stroke/types";
import { writingFrame } from "../src/animation/stroke/timeline";
import { controlAnimation, planFor } from "../src/animation/control";
import { startPlayback } from "../src/animation/timeline";
import { createTargetPoints, strokeLayout, WRITING_KEYS } from "../src/visual/points";
import { GHOST_LIGHT, writingLight, type WritingUniforms } from "../src/render/writing";
import { strokesTarget } from "../src/surface/writing";
import { MUSIC_CONCEPTS, lookupConcept } from "../src/music/glossary";
import { checkScore, displayedAccidentals, keyAccidentals } from "../src/music/notation/score";
import { CLEF_REFERENCE, staffPosition } from "../src/music/notation/staff";
import { parsePitch } from "../src/music/theory/pitch";
import { MUSIC_PACK } from "../src/animation/stroke/packs/symbols";
import { compareWithEngraving, ENGRAVED_REFERENCE } from "../src/music/visual/compare";
import { limbCurve, limbSpan, createFigureLayout, figurePoint, FIGURE_KINDS, unpackAnchors } from "../src/core/figure/layout";
import { FIGURE_SLOTS, LIMB_SLOT, LIMBS, ANCHOR, FIGURE_SCALE } from "../src/core/figure/skeleton";
import { FigureAnimator, NEUTRAL_POSE, solvePose, unflattenPose } from "../src/core/figure/pose";
import { performedLag, SecondaryMotion, SECONDARY, SECONDARY_WEIGHTS } from "../src/core/figure/secondary";
import { compileSequence, evaluateSequence, validateSequence, type AnimationSpec } from "../src/animation/scene/sequence";
import { DEMO_SEQUENCES } from "../src/animation/scene/demos";
import { toolMetadataReport, TOOL_METADATA_BUDGET, TOOL_METADATA_TARGET } from "../src/host/mcp/budget";
import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "../src/host/mcp/server";
import { hubCommandSchema } from "../src/host/hub/protocol";
import { loadVoiceSync } from "../src/host/audio/voiceSync";
import { validatePluginPackage, PLUGIN_ROOT } from "../scripts/lib/pluginPackage";
import { writeFileSync } from "node:fs";
import { VOICE_SYNC_FILE } from "../src/host/paths";

const ROOT = join(import.meta.dirname, "..");
const pack = new ChinesePack(join(ROOT, CHINESE_PACK_DIR));
const chinese = (text: string, form?: "simplified" | "traditional") => {
  const found = resolveWriting({ text, ...(form ? { form } : {}) }, pack);
  if (!found.ok) throw new Error(found.problem);
  return found;
};

// ── The pack container and the codec ─────────────────────────────────────────────────────────────────────────────

test("pack container: varints, blocks and the index round-trip; a corrupt pack is refused", () => {
  for (const value of [0, 1, 127, 128, 300, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    const out: number[] = [];
    pushVarint(out, value);
    assert.deepEqual(readVarint(Uint8Array.from(out), 0), [value, out.length]);
  }
  const records = [0x4e00, 0x6c38, 0x9fa5, 0x20000].map((codepoint, i) => ({ codepoint, data: new TextEncoder().encode(`record ${i} `.repeat(i + 1)) }));
  const file = writePack({ notice: "test pack\nmodified", kind: "strokes", blockSize: 3, records, compress: block => block });
  const header = readPackHeader(file);
  assert.equal(new TextDecoder().decode(file.subarray(0, header.start - 1)), "test pack\nmodified", "the notice is plain text at the top");
  assert.deepEqual([header.count, header.blockSize, header.blockCount], [4, 3, 2]);
  const index = readPackIndex(header, file.subarray(header.indexOffset, header.dataOffset));
  assert.equal(findCodepoint(index.codepoints, 0x6c38), 1);
  assert.equal(findCodepoint(index.codepoints, 0x6c39), -1);
  const block1 = file.subarray(header.dataOffset + index.offsets[1], header.dataOffset + index.offsets[2]);
  assert.deepEqual(new TextDecoder().decode(recordInBlock(block1, 0)), "record 3 ".repeat(4));
  assert.deepEqual(recordInBlock(joinRecords([Uint8Array.of(1), Uint8Array.of(2, 3)]), 1), Uint8Array.of(2, 3));
  assert.throws(() => writePack({ notice: "x", kind: "strokes", blockSize: 2, records: [records[1], records[0]], compress: b => b }), /pack-order-invalid/);
  const bad = Uint8Array.from(file); bad[header.start] = 0x58;
  assert.throws(() => readPackHeader(bad), /pack-magic-invalid/);
});

test("codec: a character's upstream JSON round-trips byte for byte (half units, optional radical); anything else is stored verbatim", () => {
  const data = { strokes: ["M 440 788 Q 497 731 535 718 L 521.5 -3.5 Z", "M 1 2 C 3 4 5 6 7 8 Z"], medians: [[[428, 824], [503, 781]], [[1, 2], [7, 8]]] as [number, number][][], radStrokes: [0] };
  const text = canonicalJson(data);
  assert.match(text, /"strokes": \["M 440/);
  const encoded = encodeHanzi(text);
  assert.equal(encoded.format, "binary");
  assert.equal(decodeHanzi(encoded.record).text, text);
  assert.deepEqual(decodeHanzi(encoded.record).data, data);
  assert.deepEqual([formatHalf(-7), formatHalf(-1), formatHalf(1043), formatHalf(0)], ["-3.5", "-0.5", "521.5", "0"]);
  const spaced = JSON.stringify(data);
  assert.equal(encodeHanzi(spaced).format, "json", "a file not in the canonical layout is kept verbatim");
  assert.equal(decodeHanzi(encodeHanzi(spaced).record).text, spaced);
  assert.throws(() => encodeHanzi(JSON.stringify({ strokes: ["M 1 1 Z"], medians: [] })), /hanzi-data-invalid/);
});

// ── The Chinese Writing Pack on disk ─────────────────────────────────────────────────────────────────────────────

test("chinese pack: the complete validated dataset — 9,574 characters, each counted once by form, all checksummed", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, CHINESE_PACK_DIR, CHINESE_PACK_FILES.manifest), "utf8"));
  const coverage = JSON.parse(readFileSync(join(ROOT, CHINESE_PACK_DIR, CHINESE_PACK_FILES.coverage), "utf8"));
  assert.equal(pack.size, 9574);
  assert.deepEqual([manifest.counts.upstreamFiles, manifest.counts.imported, manifest.counts.failed, manifest.counts.missingStrokeData], [9574, 9574, 0, 0]);
  const forms = manifest.counts.forms;
  assert.equal(forms.simplifiedOnly + forms.traditionalOnly + forms.shared + forms.componentForms, pack.size, "no character counted twice");
  assert.equal(manifest.counts.simplifiedCoverage, forms.simplifiedOnly + forms.shared);
  assert.equal(manifest.counts.traditionalCoverage, forms.traditionalOnly + forms.shared);
  assert.ok(manifest.counts.simplifiedCoverage > 7000 && manifest.counts.traditionalCoverage > 7000);
  assert.equal([...coverage.characters.simplifiedOnly].length, forms.simplifiedOnly);
  assert.equal(manifest.upstream.files.hanziWriterData.sha256, "72baf3d82b114e60d6e40ea05f24d2262a05cd39d544e2f322ba2fceb7beff15");
  // The plugin validator checks every file against its checksum and that the license texts ship with the data.
  assert.deepEqual(validatePluginPackage({ root: PLUGIN_ROOT, requireRuntime: true }).filter(issue => issue.level === "error"), []);
  const notice = readFileSync(join(ROOT, CHINESE_PACK_DIR, CHINESE_PACK_FILES.strokes)).subarray(0, 600).toString("utf8");
  assert.match(notice, /Arphic Public License/);
  assert.match(notice, /MODIFICATION NOTICE/);
  assert.match(readFileSync(join(ROOT, CHINESE_PACK_DIR, CHINESE_PACK_FILES.arphicLicense), "utf8"), /ARPHIC PUBLIC LICENSE/);
});

test("chinese pack: lazy, cached, offline — nothing loads until a character is asked for; each decodes to valid data", () => {
  const fresh = new ChinesePack(join(ROOT, CHINESE_PACK_DIR), { cache: 3 });
  assert.equal(fresh.cached, 0);
  for (const char of "永爱国鬱龍") assert.ok(fresh.get(char), char);
  assert.equal(fresh.cached, 3, "a bounded cache");
  assert.equal(fresh.get("a"), null);
  assert.equal(fresh.get("𠀀"), null, "absent characters are reported as absent");
  for (const char of ["永", "鬱", "龍", "饕", "一"].filter(char => pack.has(char))) {
    const entry = pack.get(char)!;
    assert.deepEqual(validateHanzi(entry.data), [], char);
    assert.equal(pack.upstreamText(char), canonicalJson(entry.data));
  }
  assert.ok(locateChinesePack({}), "the pack is found beside the sources (and beside the runtime when installed)");
  // No network anywhere in the pack's code path.
  for (const file of ["src/host/writing/chinesePack.ts", "src/host/writing/resolve.ts", "src/animation/stroke/compose.ts", "src/surface/strokeCard.ts"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), "utf8"), /fetch\(|https?:\/\/cdn/, file);
  }
  assert.match(readFileSync(join(ROOT, "src/surface/strokeCard.ts"), "utf8"), /charDataLoader/, "Hanzi Writer always gets its data from Aion, never its CDN default");
});

test("chinese pack: forms and variants — simplified, traditional, shared; 国 → 國, 发 → 發 / 髮; the dictionary's facts", () => {
  assert.equal(pack.form("国"), "simplified");
  assert.equal(pack.form("國"), "traditional");
  assert.equal(pack.form("永"), "shared");
  assert.equal(pack.form("⺀"), "component");
  assert.deepEqual(pack.variants("国", "traditional"), ["國"]);
  assert.deepEqual(pack.variants("國", "simplified"), ["国"]);
  assert.ok(pack.variants("发", "traditional").includes("發") && pack.variants("发", "traditional").includes("髮"));
  const yong = pack.entry("永")!;
  assert.deepEqual(yong.pinyin, ["yǒng"]);
  assert.equal(yong.radical, "水");
  assert.equal(characterForm("x", { s2t: {}, t2s: {} }), "shared");
  assert.deepEqual(parseOpenccTable("# comment\n国\t國\n发\t發 髮\n"), { 国: ["國"], 发: ["發", "髮"] });
});

// ── Geometry ────────────────────────────────────────────────────────────────────────────────────────────────────

test("geometry: outlines flatten (M L Q C Z), areas and point-in-outline are exact; broken data is caught", () => {
  const square = flattenOutline("M 0 0 L 100 0 L 100 100 L 0 100 Z");
  assert.equal(square.length, 1);
  assert.equal(Math.abs(ringArea(square[0])), 10_000);
  assert.ok(insideOutline(square, 50, 50) && !insideOutline(square, 150, 50) && !insideOutline(square, 50, -1));
  const curve = flattenOutline("M 0 0 Q 50 100 100 0 C 100 -50 0 -50 0 0 Z");
  assert.ok(curve[0].length > 10, "curves are subdivided");
  assert.ok(outlineArea(curve) > 3000);
  const good = { strokes: ["M 100 100 L 300 100 L 300 160 L 100 160 Z"], medians: [[[120, 130], [280, 130]]] as [number, number][][] };
  assert.deepEqual(validateHanzi(good), []);
  assert.ok(validateHanzi({ ...good, medians: [] }).length, "a median per outline");
  assert.ok(validateHanzi({ strokes: ["M 100 100 L 3000 100 L 300 160 Z"], medians: good.medians }).length, "inside the em box");
  assert.ok(validateHanzi({ strokes: ["M 100 100 L 300 100 L 300 160 L 100 160"], medians: good.medians }).length, "closed outlines");
  assert.ok(validateHanzi({ strokes: good.strokes, medians: [[[700, 700], [800, 800]]] }).length, "the median follows its outline");
  assert.equal(HANZI_EM.size, 1024);
});

test("compose: one em box for every character (no stretching), words side by side, each character's own stroke order", () => {
  const yong = chinese("永").sequence, one = chinese("一").sequence;
  assert.deepEqual(yong.items[0].box.map(v => +v.toFixed(3)), [-0.86, -0.86, 0.86, 0.86], "a single character fills the stage's square");
  assert.deepEqual(one.items[0].box, yong.items[0].box, "一 keeps the em box: it is not stretched to its own bounds");
  const oneHeight = Math.max(...one.strokes[0].outline!.flat().filter((_, i) => i % 2)) - Math.min(...one.strokes[0].outline!.flat().filter((_, i) => i % 2));
  assert.ok(oneHeight < 0.3, "一 stays a thin horizontal stroke");
  const word = chinese("爱国").sequence;
  assert.equal(word.items.length, 2);
  assert.deepEqual(word.items.map(item => [item.symbol, item.first, item.count]), [["爱", 0, 10], ["国", 10, 8]]);
  assert.ok(word.items[0].box[2] < word.items[1].box[0], "the characters do not overlap");
  assert.ok(Math.abs((word.items[0].box[2] - word.items[0].box[0]) - (word.items[1].box[2] - word.items[1].box[0])) < 1e-9, "one scale for both");
  word.items.forEach(item => { for (let k = 0; k < item.count; k++) assert.equal(word.strokes[item.first + k].local, k + 1); });
  assert.ok(word.strokes[10].pause >= 0.3 + 0.34, "a moment before the next character");
  assert.ok(word.items.every(item => item.box[2] <= STROKE_SPACE.halfWidth + 1e-9 && item.box[0] >= -STROKE_SPACE.halfWidth - 1e-9));
  // Every stroke of a composed character still lies inside its own em box (characters are never merged).
  for (const stroke of word.strokes) {
    const box = word.items[stroke.item].box;
    for (let i = 0; i < stroke.path.length; i += 2) assert.ok(stroke.path[i] >= box[0] - 0.02 && stroke.path[i] <= box[2] + 0.02);
  }
  assert.throws(() => composeWriting({ system: "latin", text: "x", title: "x", pieces: [{ type: "symbol", id: "latin:A" }, { type: "hanzi", char: "永", data: pack.get("永")!.data }] }, packSymbol), /writing-invalid/,
    "Chinese and letters are written separately");
});

test("compose: medians are smoothed without rounding corners, and a brush's entry is left out of the words", () => {
  const corner = smoothMedian([0, 0, 1, 0, 1, -1]);
  assert.ok(corner.some((v, i) => i % 2 === 0 && Math.abs(v - 1) < 1e-9 && Math.abs(corner[i + 1]) < 1e-9), "the corner point stays");
  const trimmed = trimLeadIn([0, 1, 0.15, 0.95, 0.15, 0.5, 0.15, -1]);
  assert.ok(Math.abs(trimmed[0] - 0.15) < 1e-9 && Math.abs(trimmed[1] - 0.897) < 0.01, "a slanted entry into a vertical is trimmed");
  assert.deepEqual(trimLeadIn([0, 0, 1, 0, 2, 0]), [0, 0, 1, 0, 2, 0], "a straight stroke is kept");
});

// ── Particles ───────────────────────────────────────────────────────────────────────────────────────────────────

test("particles: grains fill each stroke's true outline (not a centre line), in proportion to its area, with keys along its median", () => {
  for (const char of ["永", "鬱", "龍"]) {
    const sequence = chinese(char).sequence;
    const { positions, keys, tones } = createTargetPoints(strokesTarget(sequence), 20_000);
    const perStroke = new Array(sequence.strokes.length).fill(0);
    let inside = 0, grains = 0;
    for (let k = 0; k < keys!.length; k++) {
      if (keys![k] < 0) continue;
      const s = Math.floor(keys![k]);
      perStroke[s]++; grains++;
      if (insideOutline(sequence.strokes[s].outline!, positions[k * 3] / strokeLayout.scale, positions[k * 3 + 1] / strokeLayout.scale)) inside++;
      assert.ok(tones[k] > 0);
    }
    assert.ok(inside / grains > 0.985, `${char}: ${(inside / grains * 100).toFixed(2)} % inside their own outline`);
    const areas = sequence.strokes.map(stroke => outlineArea(stroke.outline!)), total = areas.reduce((a, b) => a + b, 0);
    perStroke.forEach((count, s) => assert.ok(Math.abs(count / grains - areas[s] / total) < 0.02 + areas[s] / total * 0.25, `${char} stroke ${s + 1} density`));
  }
  // The reveal key follows the pen: along 一 (written left to right) the key grows with x.
  const one = chinese("一").sequence;
  const { positions, keys } = createTargetPoints(strokesTarget(one), 6000);
  const pairs = [...keys!].map((key, k) => [key, positions[k * 3]]).filter(([key]) => key >= 0);
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  let inversions = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i][1] < sorted[i - 1][1] - 0.05) inversions++;
  assert.ok(inversions / sorted.length < 0.02, "keys rise with the pen's progress");
});

test("particles: crossings stay calm (a later stroke's grains over an earlier one are dimmer); every tier is a prefix", () => {
  const ten = chinese("十").sequence;
  const { positions, keys, tones } = createTargetPoints(strokesTarget(ten), 12_000);
  const over: number[] = [], clear: number[] = [];
  for (let k = 0; k < keys!.length; k++) {
    if (Math.floor(keys![k]) !== 1) continue;
    const x = positions[k * 3] / strokeLayout.scale, y = positions[k * 3 + 1] / strokeLayout.scale;
    (insideOutline(ten.strokes[0].outline!, x, y) ? over : clear).push(tones[k]);
  }
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(over.length > 20 && mean(over) < mean(clear) * 0.7, "the vertical's grains where it crosses the horizontal are dimmer");
  const low = createTargetPoints(strokesTarget(ten), 3000).keys!;
  assert.deepEqual([...low], [...keys!.slice(0, 3000)]);
});

test("reveal: as the pen moves along stroke k, its grains light in order; later strokes stay a ghost; nothing is revealed early", () => {
  const sequence = chinese("永").sequence;
  const keys = [...createTargetPoints(strokesTarget(sequence), 8000).keys!];
  const lit = (progress: number, stroke: number) => {
    const u: WritingUniforms = { progress, complete: 0, pen: 1, stroke: Math.floor(progress), rest: 0.8, ghost: GHOST_LIGHT, tip: [0, 0, 0] };
    const own = keys.filter(key => Math.floor(key) === stroke);
    return own.filter(key => writingLight(key, u) > GHOST_LIGHT + 0.05).length / own.length;
  };
  let previous = -1;
  for (const u of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
    const share = lit(1 + u, 1);
    assert.ok(share >= previous - 1e-9, "never unwrites");
    previous = share;
    assert.ok(Math.abs(share - u) < 0.12, `stroke 2 at ${u}: ${share.toFixed(2)} lit`);
    assert.equal(lit(1 + u, 3), 0, "a later stroke stays a ghost");
  }
  assert.equal(lit(2, 1), 1, "a written stroke is whole: no gaps, its ending included");
  assert.ok(keys.some(key => key === WRITING_KEYS.pen) && keys.some(key => key === WRITING_KEYS.guide));
});

// ── Lookup, words and controls ──────────────────────────────────────────────────────────────────────────────────

test("lookup: characters and words, simplified and traditional, letters, names and symbols — never a guess", () => {
  assert.equal(chinese("永").sequence.strokes.length, 5);
  assert.equal(chinese("國").sequence.strokes.length, 11);
  const traditional = chinese("国", "traditional");
  assert.equal(traditional.sequence.symbol, "國");
  assert.equal(traditional.facts[0].convertedFrom, "国");
  assert.match(traditional.notes[0], /written 國/);
  assert.equal(chinese("國", "simplified").sequence.symbol, "国");
  assert.equal(chinese("中华人民").sequence.items.length, 4);
  const tooLong = resolveWriting({ text: "中华人民共和国" }, pack);
  assert.ok(!tooLong.ok && tooLong.code === "writing-too-long" && WRITING_LIMITS.chinese === 4);
  const missing = resolveWriting({ text: "\u{20000}" }, pack);
  assert.ok(!missing.ok && missing.code === "character-not-in-pack");
  const mixed = resolveWriting({ text: "永a" }, pack);
  assert.ok(!mixed.ok);
  assert.ok(!resolveWriting({ text: "永" }, null).ok, "without the pack, Chinese is refused honestly");
  const hello = resolveWriting({ text: "HELLO" }, pack);
  assert.ok(hello.ok && hello.sequence.items.length === 5 && hello.sequence.items.map(item => item.symbol).join("") === "HELLO");
  const name = resolveWriting({ text: "Maria 2026" }, pack);
  assert.ok(name.ok && name.sequence.items.length === 9, "a name and a number, letter by letter");
  const clef = resolveWriting({ text: "treble clef" }, pack);
  assert.ok(clef.ok && clef.sequence.symbol === "𝄞");
  assert.ok(!resolveWriting({ text: "ü" }, pack).ok, "no data for ü");
  const facts = chinese("好").facts[0];
  assert.equal(facts.decomposition, "⿰女子");
  assert.equal(facts.radical, "女");
});

test("controls: in a word, 'repeat the third stroke' means the character in hand; a character can be written again on its own", () => {
  const source = chinese("爱国").source;
  const content = { kind: "writing" as const, source };
  const plan = planFor(content)!;
  const playing = startPlayback(plan.duration, 0);
  const third = controlAnimation(content, playing, { action: "repeat", stroke: 3, character: 2 }, 0);
  assert.ok(third.ok && third.stroke === 13, "stroke 3 of 国 is the 13th of the word");
  const whole = controlAnimation(content, playing, { action: "repeat", character: 2 }, 0);
  assert.ok(whole.ok);
  if (whole.ok) {
    assert.ok(whole.playback.position < plan.strokes[10].start && whole.playback.until! > plan.strokes[17].end, "国 alone, from its first stroke to its last");
    const sequence = writingSequence(source);
    assert.equal(writingFrame(sequence, plan, whole.playback.position).progress, 10, "爱 shown written while 国 is rewritten");
  }
  const tooMany = controlAnimation(content, playing, { action: "repeat", stroke: 9, character: 2 }, 0);
  assert.ok(!tooMany.ok && /国 has 8 strokes/.test(tooMany.problem));
  assert.ok(!controlAnimation(content, playing, { action: "repeat", character: 3 }, 0).ok);
  assert.ok(hubCommandSchema.safeParse({ type: "animation", action: "repeat", stroke: 3, character: 2 }).success);
});

test("english: A–Z, a–z and 0–9 in one manuscript convention; words keep one baseline, scale and spacing", () => {
  const latin = STROKE_PACKS.find(item => item.system === "latin")!, digits = STROKE_PACKS.find(item => item.system === "digits")!;
  assert.equal(latin.symbols.length, 52);
  assert.equal(digits.symbols.length, 10);
  const word = writingSequence({ system: "latin", text: "Hello", title: "Hello", pieces: [..."Hello"].map(char => ({ type: "symbol" as const, id: `latin:${char}` })) });
  const bottoms = word.items.map(item => item.box[1]), tops = word.items.map(item => item.box[3]);
  assert.ok(bottoms.every(v => Math.abs(v - bottoms[0]) < 1e-9) && tops.every(v => Math.abs(v - tops[0]) < 1e-9), "one baseline and one scale");
  for (let i = 1; i < word.items.length; i++) assert.ok(word.items[i].box[0] >= word.items[i - 1].box[2] - 1e-9, "left to right, no overlap");
  // Guides: ascender, x-height and baseline lines run under the whole word.
  assert.ok(word.guides.length >= 3);
  // Uppercase and lowercase are different letters, with their own heights.
  const H = writingSequence({ system: "latin", text: "H", title: "H", pieces: [{ type: "symbol", id: "latin:H" }] }).strokes[0];
  const h = writingSequence({ system: "latin", text: "h", title: "h", pieces: [{ type: "symbol", id: "latin:h" }] });
  assert.ok(Math.abs(H.startPoint[1] - h.strokes[0].startPoint[1]) < 0.02, "both start at the ascender line");
  assert.ok(h.strokes[1].path.every((v, i) => i % 2 === 0 || v < H.startPoint[1] * 0.6), "h's arch stays below the x-height");
});

// ── Music ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("music glossary: the full introductory vocabulary, every example a valid score, every handwriting link real", () => {
  const required = ["treble-clef", "bass-clef", "alto-clef", "staff-lines", "staff-spaces", "ledger-lines", "bar-line", "double-bar-line", "final-bar-line",
    "whole-note", "half-note", "quarter-note", "eighth-note", "sixteenth-note", "stems", "flags", "beams", "dotted-notes",
    "whole-rest", "half-rest", "quarter-rest", "eighth-rest", "sixteenth-rest", "sharp", "flat", "natural",
    "time-2-4", "time-3-4", "time-4-4", "time-6-8", "common-time", "key-signature", "tie", "slur", "repeat-sign", "dynamics", "note-position", "note-values"];
  const ids = MUSIC_CONCEPTS.map(concept => concept.id);
  for (const id of required) assert.ok(ids.includes(id), id);
  for (const concept of MUSIC_CONCEPTS) {
    const checked = checkScore(concept.score);
    assert.ok(checked.ok, `${concept.id}: ${checked.ok ? "" : checked.problem}`);
    if (concept.writing) assert.ok(packSymbol(concept.writing), `${concept.id}: ${concept.writing}`);
    assert.ok(concept.caption.en && concept.caption.zh);
  }
  assert.equal(lookupConcept("反复记号")!.id, "repeat-sign");
  assert.equal(lookupConcept("6/8")!.id, "time-6-8");
  assert.equal(lookupConcept("Common Time")!.id, "common-time");
  assert.equal(lookupConcept("glissando"), null);
});

test("music notation: alto clef, key signatures and accidentals as engraving shows them; ties and slurs are checked", () => {
  assert.equal(CLEF_REFERENCE.alto.pitch, "C4");
  assert.equal(staffPosition(parsePitch("C4")!, "alto"), 4, "middle C on the alto staff's middle line");
  assert.deepEqual(Object.entries(keyAccidentals("D")).filter(([, v]) => v).map(([k]) => k).sort(), ["C", "F"]);
  assert.deepEqual(Object.entries(keyAccidentals("Bb")).filter(([, v]) => v).map(([k]) => k).sort(), ["B", "E"]);
  const g = checkScore({ clef: "treble", time: "4/4", key: "G", notes: ["F#4", "F4", "F4", "F#4", "F#4", "C5", "C5", "C5"].map(pitch => ({ pitch, duration: "quarter" as const })) });
  assert.ok(g.ok);
  if (g.ok) assert.deepEqual(displayedAccidentals(g.value), [null, "n", null, "#", null, null, null, null], "F♯ from the key; a natural lasts to the bar line; the next bar starts fresh");
  const plain = checkScore({ clef: "treble", time: "2/4", notes: ["F#4", "F#4", "F#4", "F4"].map(pitch => ({ pitch, duration: "quarter" as const })) });
  if (plain.ok) assert.deepEqual(displayedAccidentals(plain.value), ["#", null, "#", "n"]);
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "C4", duration: "half", tie: true }, { pitch: "D4", duration: "half" }] }).ok, "a tie needs the same pitch");
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "C4", duration: "half", slur: "end" }] }).ok, "a slur ends only after it begins");
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "C4", duration: "half", slur: "start" }] }).ok, "and every slur ends");
  assert.ok(!checkScore({ clef: "treble", key: "H", notes: [] }).ok);
  assert.ok(checkScore({ clef: "treble", repeatStart: true, end: "repeat", notes: [{ pitch: "C4", duration: "whole", dynamic: "mf", stem: "down" }] }).ok);
});

test("music handwriting follows the engraved shapes: every curated symbol within a fraction of a staff space of Bravura", () => {
  let compared = 0;
  for (const spec of MUSIC_PACK.symbols) {
    const result = compareWithEngraving(spec);
    if (!result) continue;
    compared++;
    assert.ok(result.mean < 0.06, `${spec.title}: mean distance ${result.mean.toFixed(3)} staff spaces`);
    assert.ok(result.within > 0.9, `${spec.title}: ${(result.within * 100).toFixed(0)} % within 0.15 staff spaces`);
    if (result.heightRatio > 0) assert.ok(result.heightRatio > 0.85 && result.heightRatio < 1.15, `${spec.title}: height ${result.heightRatio.toFixed(2)} of the engraving`);
  }
  assert.equal(compared, Object.keys(ENGRAVED_REFERENCE).length);
  for (const spec of MUSIC_PACK.symbols) assert.ok(spec.note && spec.note.length > 20, `${spec.title} states the convention it shows`);
});

// ── Figure 3.0 ──────────────────────────────────────────────────────────────────────────────────────────────────

test("figure 3.0: each limb is one smooth curve through its anchors — continuous position and direction, no corner, no overshoot", () => {
  const anchors = solvePose(unflattenPose({ ...flatten(NEUTRAL_POSE), "left.raise": 0.9, "left.bend": 1.4 }));
  const at = (name: keyof typeof ANCHOR) => [anchors[ANCHOR[name] * 3], anchors[ANCHOR[name] * 3 + 1], anchors[ANCHOR[name] * 3 + 2]];
  for (const limb of LIMBS) {
    const chain = limb.chain.map(at);
    for (let k = 0; k < 2; k++) {
      const end = limbCurve(chain, k, 1), start = limbCurve(chain, k + 1, 0);
      assert.ok(Math.hypot(...end.point.map((v, i) => v - start.point[i])) < 1e-9, `${limb.name}: continuous at anchor ${k + 1}`);
      const a = end.tangent, b = start.tangent, cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b) + 1e-12);
      if (Math.hypot(...b) > 1e-6 && Math.hypot(...a) > 1e-6) assert.ok(cos > 0.999, `${limb.name}: no corner at anchor ${k + 1}`);
    }
    // No overshoot: the curve stays near the anchors' polyline (within a fraction of the span).
    for (let k = 0; k < 3; k++) {
      const a = chain[k], b = chain[k + 1], span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (span < 1e-6) continue;
      for (let u = 0; u <= 1; u += 0.1) {
        const p = limbCurve(chain, k, u).point;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]) + (p[2] - a[2]) * (b[2] - a[2])) / (span * span)));
        const d = Math.hypot(p[0] - a[0] - (b[0] - a[0]) * t, p[1] - a[1] - (b[1] - a[1]) * t, p[2] - a[2] - (b[2] - a[2]) * t);
        assert.ok(d < span * 0.3, `${limb.name} span ${k}: ${d.toFixed(4)}`);
      }
    }
  }
  assert.deepEqual(limbSpan([0.1, 0.3, 0.2], 0), { segment: 0, u: 0 });
  assert.equal(limbSpan([0.25, 0.25, 0], 0.75).segment, 1, "a chain that ends early never uses its empty span");
  assert.equal(FIGURE_SLOTS, 16 + LIMBS.length);
});

test("figure 3.0: no joint beads — the layout is limb curves, the head ring and soft hand/foot ends; GPU and CPU agree", () => {
  const layout = createFigureLayout(12_000);
  const animator = new FigureAnimator();
  const anchors = animator.sample(0.016, "idle", 0);
  let limbs = 0;
  for (let i = 0; i < layout.count; i++) {
    const { kind } = unpackAnchors(layout.bind[i * 4]);
    if (kind === FIGURE_KINDS.limb) limbs++;
    if (i % 11 === 0) {
      const { position } = figurePoint(layout, i, anchors);
      assert.ok(position.every(Number.isFinite));
    }
  }
  assert.ok(limbs / layout.count > 0.75);
  const gpu = readFileSync(join(ROOT, "src/render/physics/figure.ts"), "utf8");
  for (const term of ["limbRest", "LIMB_SLOT", "FIGURE_KINDS.limb", "0.55"]) assert.match(gpu, new RegExp(term.replace(".", "\\.")));
});

test("figure 3.0: secondary motion is restrained, bounded, frame-rate independent, time-pure in scenes, and never moves hands or feet", () => {
  assert.ok(Math.abs(SECONDARY_WEIGHTS.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  // Frame-rate independence: the same motion sampled at 30 and at 120 frames a second gives the same lag.
  const run = (fps: number) => {
    const motion = new SecondaryMotion();
    let lag: number[][] = [];
    for (let i = 0; i <= fps; i++) {
      const t = i / fps, x = Math.sin(t * 6) * 0.2;
      lag = motion.update(1 / fps, [[x, 0, 0], [0, x, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    }
    return lag;
  };
  const a = run(30), b = run(120);
  assert.ok(Math.abs(a[0][0] - b[0][0]) < 2e-3 && Math.abs(a[1][1] - b[1][1]) < 2e-3, `${a[0][0]} vs ${b[0][0]}`);
  assert.ok(a.every(v => Math.hypot(...v) <= SECONDARY.max + 1e-12), "bounded");
  // A performance's lag depends only on the scene's past poses: the same input, the same answer.
  const now = [[0, 0, 0], [0.1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] as [number, number, number][];
  const past = Array.from({ length: SECONDARY.taps }, (_, k) => now.map(([x, y, z]) => [x - 0.01 * (k + 1), y, z] as [number, number, number]));
  assert.deepEqual(performedLag(now, past), performedLag(now, past));
  assert.ok(performedLag(now, past)[1][0] < 0, "it trails behind the motion");
  // Hands and feet: the lag profile is zero at the ends of every limb.
  const animator = new FigureAnimator();
  for (let i = 0; i < 40; i++) animator.sample(0.033, "responding", i * 0.033);
  const layout = createFigureLayout(4000);
  for (let i = 0; i < layout.count; i++) {
    const { kind, d } = unpackAnchors(layout.bind[i * 4]);
    if (kind !== FIGURE_KINDS.limb || layout.local[i * 4] / FIGURE_SCALE < 0.999) continue;
    const p = figurePoint(layout, i, animator.anchors).position;
    const end = [animator.anchors[d * 4], animator.anchors[d * 4 + 1], animator.anchors[d * 4 + 2]];
    assert.ok(Math.hypot(p[0] - end[0], p[1] - end[1]) < 0.03, "a limb's end stays at its hand or foot");
  }
  assert.ok(animator.anchors.length === FIGURE_SLOTS * 4 && LIMB_SLOT === 16);
});

test("figure 3.0 behaviours: notice, think, examine and touch compile; the question is answered, the touched box reacts; no snapping", () => {
  for (const name of ["thinking", "exploring", "walk-and-stop", "jump-over-obstacle", "explain-diagram"] as const) {
    const check = validateSequence(JSON.parse(JSON.stringify(DEMO_SEQUENCES[name])));
    assert.ok(check.ok, name);
    const sequence = compileSequence(check.ok ? check.spec : (null as never));
    // No channel jumps between consecutive 1/120 s samples (smooth transitions between primitives).
    let previous = evaluateSequence(sequence, 0).channels;
    for (let t = 1 / 120; t <= sequence.duration; t += 1 / 120) {
      const channels = evaluateSequence(sequence, t).channels;
      for (const [key, value] of Object.entries(channels)) {
        if (key === "rootX" || key === "heading") continue;
        assert.ok(Math.abs(value - (previous[key] ?? value)) < 0.2, `${name} ${key} at ${t.toFixed(2)} s jumps ${(value - (previous[key] ?? value)).toFixed(3)}`);
      }
      previous = channels;
    }
  }
  const thinking = compileSequence(DEMO_SEQUENCES.thinking as unknown as AnimationSpec);
  const question = (t: number) => evaluateSequence(thinking, t).objects.find(object => object.id === "question")!;
  assert.equal(question(3).solved, 0, "a question at first");
  assert.equal(question(thinking.duration).solved, 1, "answered by the end");
  const exploring = compileSequence(DEMO_SEQUENCES.exploring as unknown as AnimationSpec);
  const touch = exploring.segments.find(segment => segment.value.name === "touch")!;
  const box = (t: number) => evaluateSequence(exploring, t).objects[0];
  assert.equal(box(touch.start + 0.5).hop, 0);
  assert.ok(box(touch.start + touch.value.poke!.at + 0.15).hop > 0.02, "the touched box hops");
  assert.ok(Math.abs(box(touch.start + touch.value.poke!.at + 0.25).tilt) > 0.01, "and wobbles");
  assert.ok(Math.abs(box(exploring.duration).tilt) < 0.01, "then settles");
  const walk = compileSequence(DEMO_SEQUENCES["walk-and-stop"] as unknown as AnimationSpec);
  const mid = walk.segments.find(segment => segment.value.name === "walk")!;
  const strides = Array.from({ length: 30 }, (_, i) => evaluateSequence(walk, mid.start + 1 + i * 0.05).channels);
  assert.ok(strides.some(c => Math.abs(c.sway) > 0.005) && strides.some(c => Math.abs(c.twist) > 0.02) && strides.some(c => c.curl > 0.05), "weight shift, counter-turn and lean");
  const jump = compileSequence(DEMO_SEQUENCES["jump-over-obstacle"] as unknown as AnimationSpec).segments.find(segment => segment.value.name === "jump")!;
  assert.ok(jump.value.pose(0.48).crouch >= 0.14, "a deep, gathered anticipation");
  assert.ok(!validateSequence({ title: "x", objects: [{ id: "q", type: "question", x: 0 }], actions: [{ do: "touch", object: "q" }] }).ok, "a floating question cannot be touched");
});

// ── MCP tool reliability ────────────────────────────────────────────────────────────────────────────────────────

test("mcp: every tool is listed with small metadata (Codex budgets it), no output schemas, and no catalogue of characters", async () => {
  const aion = await connectAion();
  try {
    const { tools } = await aion.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
    // Held 10 % inside the budget: a host's own representation of the same tools is a little larger (Codex's: about 2 %).
    const report = toolMetadataReport(tools, TOOL_METADATA_TARGET);
    assert.ok(report.ok, report.problems.join("; "));
    assert.ok(report.total < TOOL_METADATA_BUDGET.total && report.total < 302_010 / 4, `${report.total} B in all (v0.4.3: 302,010 B)`);
    for (const tool of tools) assert.equal(tool.outputSchema, undefined, tool.name);
    const writing = tools.find(tool => tool.name === "show_stroke_animation")!;
    assert.ok(!/[一-鿿]{4,}/.test(TOOL_DESCRIPTIONS.show_stroke_animation()), "no list of characters in the description");
    assert.ok(JSON.stringify(writing).length < 3000);
    let out = await aion.call("show_stroke_animation", { text: "爱国" });
    assert.ok(!out.isError);
    const structured = out.structuredContent as { writing: { symbols: { symbol: string; strokes: string[]; pinyin?: string[] }[] }; presentation: { route: string } };
    assert.deepEqual(structured.writing.symbols.map(s => [s.symbol, s.strokes.length]), [["爱", 10], ["国", 8]]);
    out = await aion.call("control_animation", { action: "repeat", stroke: 3, character: 2 });
    assert.match((out.content as { text: string }[])[0].text, /stroke 3 of 8 of 国/);
    out = await aion.call("show_stroke_animation", { text: "国", form: "traditional" });
    assert.equal((out.structuredContent as { writing: { text: string } }).writing.text, "國");
    out = await aion.call("show_stroke_animation", { text: "永", highlight: "radical", presentation: "card", practice: true });
    assert.ok(!out.isError && (out.structuredContent as { presentation: { route: string } }).presentation.route === "card");
    out = await aion.call("show_music", { concept: "repeat sign", language: "zh" });
    assert.ok(!out.isError && /反复记号/.test((out.structuredContent as { music: { title: string } }).music.title));
    out = await aion.call("show_music", { concept: "treble clef" });
    assert.equal((out.structuredContent as { music: { concept: { handwriting?: string } } }).music.concept.handwriting, "𝄞");
    out = await aion.call("show_stroke_animation", { text: "half rest" });
    assert.ok(!out.isError);
    out = await aion.call("play_animation", { demo: "exploring" });
    assert.ok(!out.isError);
    out = await aion.call("play_animation", { sequence: { title: "Think", objects: [{ id: "q", type: "question", x: 0.3 }], actions: [{ do: "think", about: "q" }] } });
    assert.ok(!out.isError, "a composed thinking sequence");
  } finally { await aion.close(); }
});

test("voice sync: a remembered v0.4.3 choice is kept by v0.4.4 (no reset on update)", () => {
  const home = tempHome();
  writeFileSync(join(home, VOICE_SYNC_FILE), JSON.stringify({ enabled: true, permission: "granted", updatedAt: 1792006208869 }, null, 2));
  assert.deepEqual(loadVoiceSync(home), { enabled: true, permission: "granted", updatedAt: 1792006208869 });
});

function flatten(pose: typeof NEUTRAL_POSE) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(pose)) {
    if (typeof value === "number") out[key] = value;
    else for (const [k, v] of Object.entries(value)) out[`${key}.${k}`] = v as number;
  }
  return out;
}

