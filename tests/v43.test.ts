import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { connectAion, PAGE, tempHome } from "./helpers";
import { PresenceHub } from "../src/host/hub/hub";
import { hubCommandSchema } from "../src/host/hub/protocol";
import { NativeAudioBridge } from "../src/host/audio/bridge";
import { loadVoiceSync, saveVoiceSync, VoiceSyncController } from "../src/host/audio/voiceSync";
import { decideVoiceSync, DEFAULT_VOICE_SYNC, permissionFrom, RECONNECT_BACKOFF_SECONDS, type VoiceSyncPreference } from "../src/audio/voiceSync";
import { routeAudio } from "../src/audio/route";
import { DEFAULT_AUDIO_SETTINGS, type BridgeStatus } from "../src/audio/settings";
import { PresenceStore, type StoreClock } from "../src/core/store";
import { routePresentation } from "../src/core/presentationRouter";
import { planPresentation, type PresentationContent } from "../src/core/presentation";
import { portraitStyleFor } from "../src/visual/types";
import { normalizeImage } from "../src/visual/image";
import {
  ease, endOf, interpolate, pause, phaseAt, positionAt, replay, resume, seek, segmentAt, sequence, setRate, startPlayback,
} from "../src/animation/timeline";
import { describeDirection, parseStrokePath } from "../src/animation/stroke/path";
import { lookupStroke, STROKE_PACKS, strokeCatalog, strokeSequence } from "../src/animation/stroke/registry";
import { strokeIndexAt, strokeWindow, writingFrame, writingPlan, WRITING_TIMING } from "../src/animation/stroke/timeline";
import { controlAnimation, planFor } from "../src/animation/control";
import { compileSequence, evaluateSequence, SEQUENCE_LIMITS, validateSequence, type AnimationSpec } from "../src/animation/scene/sequence";
import { DEMO_NAMES, DEMO_SEQUENCES } from "../src/animation/scene/demos";
import { createTargetPoints, WRITING_KEYS } from "../src/visual/points";
import { GHOST_LIGHT, NO_WRITING, writingLight, writingPoint, writingSize, type WritingUniforms } from "../src/render/writing";
import { strokesTarget } from "../src/surface/writing";
import { NEUTRAL_POSE, solvePose, unflattenPose, FigureAnimator } from "../src/core/figure/pose";
import { ANCHOR, PROPORTIONS } from "../src/core/figure/skeleton";
import { AionBody } from "../src/core/body";
import { discoverSkills } from "../scripts/lib/pluginPackage";
import { playAnimationInput } from "../src/host/schemas";
import { ChinesePack } from "../src/host/writing/chinesePack";
import { resolveWriting } from "../src/host/writing/resolve";

/** v0.4.4: Chinese characters come from the Chinese Writing Pack (the hand-drawn v0.4.3 set is gone). */
const pack = new ChinesePack(join(import.meta.dirname, "..", "plugins/aion-presence/packs/chinese-writing"));
const chinese = (text: string) => { const found = resolveWriting({ text }, pack); if (!found.ok) throw new Error(found.problem); return found; };

/** A manual clock: time moves only when the test says so; scheduled callbacks run in order. */
function manualClock(start = 1_000_000) {
  let now = start;
  const jobs: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const clock: StoreClock & { advance(ms: number): void } = {
    now: () => now,
    schedule(run, ms) { const job = { at: now + ms, run, id: ++ids }; jobs.push(job); return () => { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); }; },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        jobs.sort((a, b) => a.at - b.at || a.id - b.id);
        const job = jobs[0];
        if (!job || job.at > until) break;
        jobs.shift(); now = job.at; job.run();
      }
      now = until;
    },
  };
  return clock;
}

// ── Task B: portraits from any source ──────────────────────────────────────────────────────────────────────────

test("portrait style: heritage by default for any portrait, classic only on request, nothing else framed", () => {
  assert.equal(portraitStyleFor("portrait"), "heritage");
  assert.equal(portraitStyleFor("portrait", "classic"), "classic");
  for (const fit of ["object", "map", "logo", undefined] as const) assert.equal(portraitStyleFor(fit, "classic"), undefined, String(fit));
});

test("router: a local portrait is a hybrid heritage portrait like a looked-up one; other local pictures stay cards", () => {
  const media = { id: "m0123456789abcdef01", mime: "image/jpeg", bytes: 100 };
  type Image = Extract<PresentationContent, { kind: "image" }>;
  const local = (fit: "portrait" | "object", size = 900): Image => ({ kind: "image", media, fit, origin: "local", width: size, height: Math.round(size * 1.3) });
  assert.deepEqual(routePresentation({ content: local("portrait") }), { route: "hybrid", reason: "portrait-hybrid", preference: "auto" });
  assert.deepEqual(routePresentation({ content: { ...local("portrait"), origin: "lookup" } }), { route: "hybrid", reason: "portrait-hybrid", preference: "auto" });
  assert.equal(routePresentation({ content: local("object") }).route, "card", "a landscape, a screenshot or a car from this machine is shown exactly");
  assert.equal(routePresentation({ content: local("portrait", 120) }).route, "body", "too small for a card of its own");
  const plan = planPresentation({ ...local("portrait"), style: "heritage" }, "hybrid");
  assert.deepEqual([plan.body.type, plan.card], ["image", true]);
  assert.equal((plan.body as { style?: string }).style, "heritage");
});

test("heritage composition keeps the photograph's colours and proportions (cropped to 3:4, never stretched)", () => {
  const width = 400, height = 300, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([200, 120, 40, 255], i * 4);
  const target = normalizeImage({ width, height, data }, "portrait", { portraitStyle: "heritage" });
  assert.equal(target.frame, "oval");
  assert.ok(Math.abs(target.raster.width / target.raster.height - 0.75) < 0.02, "a 3:4 crop");
  assert.deepEqual([...target.raster.data.slice(0, 4)], [200, 120, 40, 255], "colours unchanged");
  assert.equal(normalizeImage({ width, height, data }, "object").frame, undefined, "an ordinary picture is not framed");
});

test("MCP: a local photograph becomes a heritage portrait (show_portrait source, or show_image intent portrait); classic on request; no intent stays a picture", async () => {
  const home = tempHome();
  // A JPEG header the size reader understands (SOF0 640×800) is enough: the surface decodes it, the tools only route it.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  const photo = join(home, "grandmother.jpg");
  writeFileSync(photo, jpeg);
  const aion = await connectAion({ home });
  try {
    const presentation = async (name: string, args: Record<string, unknown>) => {
      const out = await aion.call(name, args);
      assert.ok(!out.isError, JSON.stringify(out.content));
      return (await aion.link.run(backend => backend.state())).presentation as Extract<PresentationContent, { kind: "image" }> & { route: string };
    };
    let shown = await presentation("show_portrait", { source: photo, person: "My grandmother" });
    assert.deepEqual([shown.fit, shown.style, shown.origin, shown.route, shown.alt], ["portrait", "heritage", "local", "hybrid", "My grandmother"]);
    shown = await presentation("show_image", { source: photo, intent: "portrait" });
    assert.deepEqual([shown.fit, shown.style, shown.route], ["portrait", "heritage", "hybrid"]);
    shown = await presentation("show_image", { source: photo, intent: "portrait", style: "classic" });
    assert.equal(shown.style, "classic", "\"without the oval\"");
    shown = await presentation("show_image", { source: photo });
    assert.deepEqual([shown.fit, shown.style, shown.route], ["object", undefined, "card"], "no portrait intent: never an oval");
    shown = await presentation("show_image", { source: photo, intent: "vehicle" });
    assert.equal(shown.fit, "object");
    const missing = await aion.call("show_portrait", {});
    assert.ok(missing.isError && /person.*or source/.test((missing.content as { text: string }[])[0].text));
  } finally { await aion.close(); }
});

// ── Animation core ─────────────────────────────────────────────────────────────────────────────────────────────

test("animation core: a playhead anchored to the clock — pause, resume, seek with a stop, rate, replay", () => {
  let state = startPlayback(10, 0);
  assert.equal(positionAt(state, 2_000), 2);
  state = pause(state, 2_000);
  assert.equal(positionAt(state, 9_000), 2, "paused stays");
  assert.equal(phaseAt(state, 9_000), "paused");
  state = resume(state, 9_000);
  assert.equal(positionAt(state, 10_000), 3);
  state = setRate(state, 10_000, 0.5);
  assert.equal(positionAt(state, 12_000), 4, "half speed from now on, no jump");
  state = seek(state, 12_000, 6, { until: 7 });
  assert.equal(positionAt(state, 20_000), 7, "stops by itself at until");
  assert.equal(phaseAt(state, 20_000), "finished");
  assert.equal(endOf(resume(state, 20_000)), 10, "resuming after a stop carries on to the end");
  state = replay(state, 21_000, 1);
  assert.equal(positionAt(state, 21_000), 1);
  assert.equal(positionAt(state, 999_000), 10);
  assert.ok(state.revision > 0);
  assert.equal(setRate(state, 0, 99).rate, 2.5, "rates are bounded");
});

test("animation core: keyframes, easing and sequenced segments", () => {
  assert.equal(ease("linear", 0.25), 0.25);
  assert.equal(ease("inOut", 0.5), 0.5);
  assert.ok(ease("back", 0.8) > 1, "follow-through overshoots");
  const keys = [{ at: 0, value: 0 }, { at: 1, value: 10, ease: "linear" as const }, { at: 3, value: 0, ease: "linear" as const }];
  assert.deepEqual([interpolate(keys, -1), interpolate(keys, 0.5), interpolate(keys, 2), interpolate(keys, 9)], [0, 5, 5, 0]);
  const segments = sequence(["a", "b", "c"], item => ({ a: 1, b: 2, c: 0.5 })[item]!);
  assert.deepEqual(segments.map(s => [s.start, s.end]), [[0, 1], [1, 3], [3, 3.5]]);
  assert.equal(segmentAt(segments, 2)!.value, "b");
  assert.equal(segmentAt(segments, 9)!.value, "c");
});

// ── Stroke Animation Engine ────────────────────────────────────────────────────────────────────────────────────

test("stroke paths: one continuous movement; malformed paths are refused", () => {
  assert.equal(parseStrokePath("M 0 0 L 10 0 Q 20 0 20 10 C 20 20 10 20 0 20").length, 4);
  assert.equal(parseStrokePath("E 0 0 5 5 0 360").length, 1, "an arc may start a stroke");
  for (const bad of ["L 1 1", "M 0 0 M 1 1", "M 0 0 L 1", "M 0 0 X 1 1", "M 0 0 L 1 NaN", ""]) assert.throws(() => parseStrokePath(bad), /stroke-path-invalid/, bad);
  assert.equal(describeDirection([0, 0, 1, 0]), "right");
  assert.equal(describeDirection([0, 0, 0, -1]), "down");
  assert.equal(describeDirection([0, 1, -0.6, 0]), "down-left");
  assert.equal(describeDirection([0, 1, -0.3, 0]), "down", "eight sectors: within 22.5° of down is down");
  assert.equal(describeDirection([0, 0, 1, 0, 1, -1, 0.9, -0.95]), "right, then down, then a hook up-left");
});

test("every curated symbol builds, validates and stays inside the stage", () => {
  let count = 0;
  for (const pack of STROKE_PACKS) {
    assert.ok(pack.variant && pack.convention, `${pack.system} names its convention`);
    for (const spec of pack.symbols) {
      const sequence = strokeSequence(`${pack.system}:${spec.symbol}`)!;
      assert.ok(sequence, spec.symbol);
      assert.equal(sequence.strokes.length, spec.strokes.length);
      sequence.strokes.forEach((stroke, i) => {
        assert.equal(stroke.order, i + 1);
        assert.ok(stroke.length > 0 && stroke.duration >= 0.45 && stroke.duration <= 3.4, `${spec.symbol} ${i + 1}`);
        assert.deepEqual(stroke.startPoint, [stroke.path[0], stroke.path[1]]);
        assert.ok(stroke.path.every(v => Math.abs(v) <= 0.95));
      });
      count++;
    }
  }
  const catalog = strokeCatalog();
  assert.equal(catalog.chinese, undefined, "Chinese comes from the Chinese Writing Pack, not a curated list");
  assert.equal(catalog.latin!.length, 52, "A–Z and a–z");
  assert.equal(catalog.digits!.length, 10);
  assert.deepEqual(catalog.music, ["𝄞", "𝄢", "♩", "♪", "♯", "♭", "♮", "𝄡", "𝅝", "𝅗𝅥", "𝅘𝅥𝅯", "𝄻", "𝄼", "𝄽", "𝄾", "𝄴", "𝄁", "𝄂"]);
  assert.ok(count >= 88);
});

test("stroke order: Chinese characters from the pack keep the data's order, with directions read from each median", () => {
  const yong = chinese("永").sequence;
  assert.equal(yong.strokes.length, 5);
  assert.deepEqual(yong.strokes.map(stroke => stroke.direction), ["down-right", "right, then down, then a hook up-left", "right, then down-left", "down, then down-left", "down-right"]);
  const shi = chinese("十").sequence;
  assert.deepEqual(shi.strokes.map(stroke => stroke.direction), ["right", "down"], "十: the horizontal, then the vertical");
  const zhong = chinese("中").sequence;
  assert.deepEqual(zhong.strokes.map(stroke => stroke.direction).slice(0, 2), ["down", "right, then down"], "中: 竖, then 横折");
  // Every stroke's pen path runs inside or along its own true outline.
  for (const char of "永爱国鬱龍") {
    for (const stroke of chinese(char).sequence.strokes) {
      assert.ok(stroke.outline && stroke.outline.length >= 1, `${char}: stroke ${stroke.local} has its outline`);
      assert.ok(stroke.path.length >= 4);
    }
  }
});

test("stroke order: letters, digits, music and maths follow their stated conventions", () => {
  const a = lookupStroke("A")!, lower = lookupStroke("a")!;
  assert.equal(a.title, "uppercase A");
  assert.equal(lower.title, "lowercase a", "letters are case-sensitive");
  assert.equal(lookupStroke("capital G")!.symbol, "G");
  // Uppercase A: both slants start at the apex and go down; the bar goes right.
  assert.ok(a.strokes[0].startPoint[1] > a.strokes[0].endPoint[1] && a.strokes[1].startPoint[1] > a.strokes[1].endPoint[1]);
  assert.equal(a.strokes[2].direction, "right");
  assert.match(lookupStroke("o")!.strokes[0].direction, /anticlockwise/, "circles go anticlockwise");
  assert.match(lookupStroke("T")!.note!, /stem first/);
  for (const spec of STROKE_PACKS.find(item => item.system === "latin")!.symbols.filter(item => item.symbol !== "e")) {
    // Start at the top: in the upper part of the first stroke (a circle starts at about two o'clock).
    const first = lookupStroke(spec.symbol)!.strokes[0];
    const ys = first.path.filter((_, i) => i % 2 === 1), low = Math.min(...ys), high = Math.max(...ys);
    assert.ok(first.startPoint[1] >= low + (high - low) * 0.75 - 1e-9, `${spec.symbol} starts in its upper part`);
  }
  assert.equal(lookupStroke("e")!.strokes[0].startPoint[0] < lookupStroke("e")!.strokes[0].endPoint[0] + 0.5, true, "e begins with its bar");
  const clef = lookupStroke("treble clef")!;
  assert.equal(clef.strokes.length, 1);
  assert.match(clef.note!, /G line/);
  assert.equal(lookupStroke("高音谱号")!.symbol, "𝄞");
  assert.deepEqual(lookupStroke("quarter note")!.strokes.map(s => s.direction), ["a small filled oval", "up"], "notehead, then the stem");
  assert.deepEqual(lookupStroke("sharp")!.strokes.slice(0, 2).map(s => s.direction), ["down", "down"], "verticals first");
  assert.equal(lookupStroke("π")!.strokes[0].direction, "right", "the bar first");
  assert.equal(lookupStroke("7", "digits")!.writingSystem, "digits");
  assert.equal(lookupStroke("龍"), null, "no data: never guessed");
  assert.equal(lookupStroke("a cat"), null);
});

test("stroke timing: the plan and the writing frame — preview, clear, each stroke in order, finished", () => {
  const yong = chinese("永").sequence, plan = writingPlan(yong);
  assert.equal(plan.strokes.length, 5);
  for (let i = 1; i < plan.strokes.length; i++) assert.ok(plan.strokes[i].start > plan.strokes[i - 1].end, "a pause between strokes");
  assert.equal(plan.writeStart, WRITING_TIMING.lead + WRITING_TIMING.preview + WRITING_TIMING.clear + WRITING_TIMING.ready);
  assert.equal(writingFrame(yong, plan, 0.5).phase, "forming");
  assert.equal(writingFrame(yong, plan, 0.5).complete, 1, "the symbol forms complete first");
  assert.equal(writingFrame(yong, plan, plan.clearStart + WRITING_TIMING.clear).complete, 0, "then clears to its ghost");
  let previous = -1;
  for (let t = plan.writeStart; t < plan.duration; t += 0.05) {
    const frame = writingFrame(yong, plan, t);
    assert.ok(frame.progress >= previous - 1e-9, "never unwrites");
    previous = frame.progress;
  }
  const start = writingFrame(yong, plan, plan.strokes[2].start + 1e-4), end = writingFrame(yong, plan, plan.strokes[2].end - 1e-4);
  assert.equal(start.stroke, 2);
  assert.ok(Math.hypot(start.tip[0] - yong.strokes[2].startPoint[0], start.tip[1] - yong.strokes[2].startPoint[1]) < 0.01, "the pen starts at the stroke's start");
  assert.ok(Math.hypot(end.tip[0] - yong.strokes[2].endPoint[0], end.tip[1] - yong.strokes[2].endPoint[1]) < 0.02, "and ends at its end");
  const gap = writingFrame(yong, plan, (plan.strokes[2].end + plan.strokes[3].start) / 2);
  assert.equal(gap.phase, "gap");
  assert.ok(gap.tip[2] > 0.05 && gap.pen < 1, "the pen lifts between strokes");
  const done = writingFrame(yong, plan, plan.duration);
  assert.deepEqual([done.phase, done.progress, done.rest], ["done", 5, 1]);
  assert.equal(strokeIndexAt(plan, plan.strokes[3].start), 3);
  const window = strokeWindow(plan, 2)!;
  assert.ok(window.from < plan.strokes[2].start && window.until > plan.strokes[2].end);
  assert.equal(writingFrame(yong, plan, window.from).progress, 2, "repeating stroke 3 shows strokes 1–2 written");
});

test("stroke control: repeat a stroke, next, previous, slower, complete — and what does not apply", () => {
  const content = { kind: "writing" as const, source: chinese("永").source };
  const plan = planFor(content)!;
  const playing = startPlayback(plan.duration, 0);
  let result = controlAnimation(content, playing, { action: "repeat", stroke: 3 }, 1_000);
  assert.ok(result.ok && result.stroke === 3);
  if (!result.ok) return;
  assert.ok(Math.abs(result.playback.position - strokeWindow(plan, 2)!.from) < 1e-9 && result.playback.until === strokeWindow(plan, 2)!.until);
  result = controlAnimation(content, result.playback, { action: "next" }, 1_000);
  assert.ok(result.ok && result.stroke === 4);
  if (!result.ok) return;
  result = controlAnimation(content, result.playback, { action: "previous" }, 1_000);
  assert.ok(result.ok && result.stroke === 3);
  const slower = controlAnimation(content, playing, { action: "replay", speed: "slow" }, 0);
  assert.ok(slower.ok && slower.playback.rate === 0.5 && slower.playback.position === plan.clearStart);
  const complete = controlAnimation(content, playing, { action: "complete" }, 0);
  assert.ok(complete.ok && !complete.playback.playing && complete.playback.position === plan.duration);
  assert.equal(controlAnimation(content, playing, { action: "repeat", stroke: 9 }, 0).ok, false, "there are five strokes");
  const finished = { ...playing, position: plan.duration };
  const first = controlAnimation(content, finished, { action: "next" }, 0);
  assert.ok(first.ok && first.stroke === 1, "from the finished symbol, next starts at the first stroke");
  const scene = { kind: "animation" as const, sequence: DEMO_SEQUENCES["walk-and-stop"] as unknown as AnimationSpec };
  assert.equal(controlAnimation(scene, startPlayback(5, 0), { action: "repeat" }, 0).ok, false, "a figure's sequence has no strokes");
});

test("stroke particles: every grain has a reveal key — strokes in order, the pen, the guides — and prefixes keep the whole symbol", () => {
  const sequence = chinese("永").sequence;
  const points = createTargetPoints(strokesTarget(sequence), 6000);
  const keys = points.keys!;
  assert.equal(keys.length, 6000);
  const strokes = [...keys].filter(k => k >= 0);
  assert.ok(strokes.every(k => k < 5), "keys within the five strokes");
  for (let s = 0; s < 5; s++) assert.ok(strokes.some(k => Math.floor(k) === s), `stroke ${s + 1} has grains`);
  assert.ok([...keys].some(k => k === WRITING_KEYS.pen) && [...keys].some(k => k === WRITING_KEYS.guide));
  const prefix = createTargetPoints(strokesTarget(sequence), 1500).keys!;
  assert.deepEqual([...prefix], [...keys.slice(0, 1500)], "a lower quality tier is a prefix of the same writing");
  for (let s = 0; s < 5; s++) assert.ok([...prefix].some(k => Math.floor(k) === s), "the prefix still has every stroke");
  assert.throws(() => createTargetPoints({ kind: "strokes", strokes: [], guides: [] }, 100), /invalid-strokes/);
  assert.throws(() => createTargetPoints({ kind: "strokes", strokes: [{ path: [0, 0, 9, 9], width: [0.1, 0.1] }], guides: [] }, 100), /invalid-strokes/);
});

test("writing light (the CPU reference of the GPU expression): ghost → written → the current stroke a little brighter; the pen rides the tip", () => {
  const u: WritingUniforms = { progress: 2.5, complete: 0, pen: 1, stroke: 2, rest: 0.8, ghost: GHOST_LIGHT, tip: [0.3, -0.2, 0.05] };
  assert.equal(writingLight(4.2, u), GHOST_LIGHT, "not yet written: the faint ghost");
  assert.ok(Math.abs(writingLight(0.5, u) - 0.8) < 1e-9, "written earlier: rest light");
  assert.ok(writingLight(2.2, u) >= 1, "in the stroke being written: full light");
  assert.ok(writingLight(2.47, u) > writingLight(2.2, u), "just written: a brief glow");
  assert.equal(writingLight(WRITING_KEYS.guide, u), 1, "guides as sampled");
  assert.equal(writingLight(WRITING_KEYS.pen, u), 1);
  const pen = writingPoint(0.01, 0.02, 0, WRITING_KEYS.pen, u);
  assert.ok([0.31, -0.18, 0.05].every((v, i) => Math.abs(pen[i] - v) < 1e-9), "the pen at the tip plus its offset");
  assert.deepEqual(writingPoint(0.01, 0.02, 0, 1.3, u), [0.01, 0.02, 0], "strokes never move");
  assert.equal(writingSize(WRITING_KEYS.pen, { ...u, pen: 0 }), 0, "the pen vanishes with its light");
  // Every non-writing target: keys −1 and NO_WRITING leave every grain exactly as sampled.
  assert.equal(writingLight(-1, NO_WRITING), 1);
  assert.equal(writingLight(3.4, NO_WRITING), 1, "even a writing grain is fully lit without writing");
  assert.equal(writingSize(-1, NO_WRITING), 1);
  // The GPU module evaluates the same roles, ramp and glow.
  const gpu = readFileSync(join(import.meta.dirname, "..", "src/render/physics/writing.ts"), "utf8");
  for (const name of ["REVEAL_RAMP", "WRITING_GLOW", "writeProgress", "writeComplete", "writePen", "writeStroke", "writeRest", "writeGhost", "writeTip"]) assert.match(gpu, new RegExp(name));
});

test("renderer compatibility: compute stays within WebGPU's eight storage buffers; the canvas fallback mirrors writing", () => {
  const system = readFileSync(join(import.meta.dirname, "..", "src/render/ParticleSystem.ts"), "utf8");
  const storages = [...system.matchAll(/storage\(/g)].length;
  assert.ok(storages <= 8, `${storages} storage buffers`);
  assert.match(system, /writingTarget\(target\.element\(instanceIndex\), keys\.element\(instanceIndex\), u\)/);
  const canvas = readFileSync(join(import.meta.dirname, "..", "src/render/fallback/canvasRuntime.ts"), "utf8");
  for (const name of ["writingPoint", "writingLight", "writingSize"]) assert.match(canvas, new RegExp(name));
});

// ── Scene Sequencer ────────────────────────────────────────────────────────────────────────────────────────────

test("sequences: the curated demos validate, compile and stay within bounds", () => {
  assert.deepEqual(DEMO_NAMES, ["walk-and-stop", "thinking", "exploring", "jump-over-obstacle", "pick-up-object", "explain-diagram", "surprised-reaction"]);
  for (const name of DEMO_NAMES) {
    const check = validateSequence(JSON.parse(JSON.stringify(DEMO_SEQUENCES[name])));
    assert.ok(check.ok, `${name}: ${check.ok ? "" : check.problem}`);
    const compiled = compileSequence(check.spec);
    assert.ok(compiled.duration > 5 && compiled.duration <= SEQUENCE_LIMITS.seconds, `${name}: ${compiled.duration}`);
  }
});

test("sequences: declarative and bounded — nothing outside the approved primitives is accepted", () => {
  const ok = (spec: unknown) => validateSequence(spec).ok;
  const base: AnimationSpec = { title: "t", actions: [{ do: "wait", seconds: 1 }] };
  assert.ok(ok(base));
  assert.ok(!ok({ ...base, actions: [{ do: "fly" }] }), "unknown action");
  assert.ok(!ok({ ...base, actions: [{ do: "walk", to: 9 }] }), "off the stage");
  assert.ok(!ok({ ...base, actions: Array.from({ length: 13 }, () => ({ do: "wait", seconds: 0.5 })) }), "too many actions");
  assert.ok(!ok({ ...base, objects: Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, type: "box", x: 0 })) }), "too many objects");
  assert.ok(!ok({ ...base, objects: [{ id: "a", type: "box", x: 0 }, { id: "a", type: "ball", x: 0.5 }] }), "duplicate ids");
  assert.ok(!ok({ ...base, actions: [{ do: "jump", over: "ghost" }] }), "unknown object");
  assert.ok(!ok({ ...base, objects: [{ id: "p", type: "panel", x: 0.5 }], actions: [{ do: "pick-up", object: "p" }] }), "a panel cannot be lifted");
  assert.ok(!ok({ ...base, actions: [{ do: "put-down" }] }), "nothing to put down");
  assert.ok(!ok({ ...base, actions: Array.from({ length: 12 }, () => ({ do: "wait", seconds: 3 })) }), "too long");
  assert.equal(playAnimationInput.safeParse({ sequence: { ...base, actions: [{ do: "wait", seconds: 1, joints: { knee: 9 } }] } }).success, false, "joint values are refused by the tool schema");
  assert.equal(playAnimationInput.safeParse({ sequence: { ...base, code: "walk()" } }).success, false, "so is anything else");
  assert.ok(!ok({ title: "<script>".repeat(20), actions: base.actions }), "the title is bounded");
  assert.ok(!ok("walk(); alert(1)"), "never code");
});

test("figure motion: a walk plants its feet (no sliding), limbs keep their length, nothing goes below the ground", () => {
  const compiled = compileSequence({ title: "walk", start: { x: -1, facing: "right" }, actions: [{ do: "walk", to: 0.8 }] });
  const length = (a: Float32Array, i: number, j: number) => Math.hypot(a[i * 3] - a[j * 3], a[i * 3 + 1] - a[j * 3 + 1], a[i * 3 + 2] - a[j * 3 + 2]);
  let previous: Float32Array | null = null, planted = 0, sliding = 0;
  for (let t = 0; t <= compiled.duration; t += 1 / 60) {
    const frame = evaluateSequence(compiled, t);
    const anchors = solvePose(unflattenPose(frame.channels));
    assert.ok(anchors.every(Number.isFinite));
    assert.ok(Math.abs(length(anchors, ANCHOR.hipLeft, ANCHOR.kneeLeft) - PROPORTIONS.thigh) < 1e-3, "thigh length");
    assert.ok(Math.abs(length(anchors, ANCHOR.shoulderRight, ANCHOR.elbowRight) - PROPORTIONS.upperArm) < 1e-3, "upper arm length");
    for (const foot of [ANCHOR.footLeft, ANCHOR.footRight]) {
      assert.ok(anchors[foot * 3 + 1] >= PROPORTIONS.footY - 1e-6, "feet never go below the ground");
      // A foot on the ground does not slide.
      if (previous && Math.abs(anchors[foot * 3 + 1] - PROPORTIONS.footY) < 1e-4 && Math.abs(previous[foot * 3 + 1] - PROPORTIONS.footY) < 1e-4) {
        planted++;
        if (Math.abs(anchors[foot * 3] - previous[foot * 3]) > 1e-3) sliding++;
      }
    }
    previous = anchors;
  }
  assert.ok(planted > 100);
  assert.equal(sliding, 0, "planted feet stay put");
  const end = evaluateSequence(compiled, compiled.duration).channels;
  assert.ok(Math.abs(end.rootX - 0.8) < 1e-6, "it arrives");
});

test("figure motion: the jump clears the box; pick-up lifts the object with the hands; interruption eases back", () => {
  const spec = JSON.parse(JSON.stringify(DEMO_SEQUENCES["jump-over-obstacle"])) as AnimationSpec;
  const jump = compileSequence(spec);
  const box = spec.objects![0];
  let cleared = false;
  for (let t = 0; t <= jump.duration; t += 1 / 60) {
    const frame = evaluateSequence(jump, t);
    const anchors = solvePose(unflattenPose(frame.channels)), boxFrame = frame.objects[0];
    for (const foot of [ANCHOR.footLeft, ANCHOR.footRight]) {
      const x = anchors[foot * 3], y = anchors[foot * 3 + 1];
      if (Math.abs(x - box.x) < boxFrame.w / 2) { assert.ok(y > boxFrame.y + boxFrame.h / 2, "a foot over the box is above it"); cleared = true; }
    }
  }
  assert.ok(cleared, "the feet passed over the box");
  const pick = compileSequence(JSON.parse(JSON.stringify(DEMO_SEQUENCES["pick-up-object"])) as AnimationSpec);
  const start = evaluateSequence(pick, 0).objects[0], end = evaluateSequence(pick, pick.duration).objects[0];
  assert.ok(end.y > start.y + 0.6, "the ball is lifted");
  // Interruption: a performance that stops eases out from where it was, never snapping.
  const animator = new FigureAnimator();
  animator.perform({ ...evaluateSequence(pick, 6).channels });
  for (let i = 0; i < 90; i++) animator.sample(1 / 60, "idle", i / 60);
  const during = animator.pose.rootX;
  animator.perform(null);
  animator.sample(1 / 60, "idle", 2);
  assert.ok(Math.abs(animator.pose.rootX - during) < 0.05, "no jump on interruption");
  for (let i = 0; i < 120; i++) animator.sample(1 / 60, "idle", 2 + i / 60);
  assert.ok(Math.abs(animator.pose.rootX) < 0.01 && animator.performing === 0, "back to the state's own pose");
  // State poses are unchanged by the new channels.
  const neutral = solvePose(NEUTRAL_POSE);
  assert.ok(neutral.every(Number.isFinite));
});

test("a performance borrows the figure without changing the persistent body", () => {
  const body = new AionBody();
  body.set("eyes");
  body.override = "figure";
  assert.equal(body.form, "eyes");
  assert.equal(body.shown, "figure");
  for (let i = 0; i < 300; i++) body.sample(1 / 60);
  assert.ok(body.level > 0.99 && body.eyes < 0.01);
  body.override = null;
  for (let i = 0; i < 300; i++) body.sample(1 / 60);
  assert.ok(body.level < 0.01 && body.eyes > 0.99, "back to the eyes");
});

// ── Store, hub and tools ───────────────────────────────────────────────────────────────────────────────────────

test("store: an animation plays with its presentation; controls re-arm a sequence's lifetime; stop ends it", () => {
  const clock = manualClock();
  const store = new PresenceStore(clock);
  const writing = store.present({ kind: "writing", stroke: "chinese:永", label: "永", source: chinese("永").source }, 0);
  assert.equal(store.snapshot().animation?.presentation, writing.id);
  assert.equal(writing.route, "hybrid");
  assert.equal(store.controlAnimation({ action: "repeat", stroke: 2 }).ok, true);
  clock.advance(600_000);
  assert.ok(store.snapshot().presentation, "writing stays until cleared");
  const spec = JSON.parse(JSON.stringify(DEMO_SEQUENCES["walk-and-stop"])) as AnimationSpec;
  store.present({ kind: "animation", sequence: spec, label: spec.title }, undefined, { rate: 0.5 });
  const duration = compileSequence(spec).duration;
  assert.equal(store.snapshot().animation!.playback.rate, 0.5);
  clock.advance((duration / 0.5) * 1000 - 500);
  assert.ok(store.snapshot().presentation, "plays at half speed for twice as long");
  assert.equal(store.controlAnimation({ action: "pause" }).ok, true);
  clock.advance(30_000);
  assert.ok(store.snapshot().presentation, "a paused sequence waits");
  assert.equal(store.controlAnimation({ action: "stop" }).ok, true);
  assert.equal(store.snapshot().presentation, null);
  assert.equal(store.snapshot().animation, null);
  assert.equal(store.controlAnimation({ action: "pause" }).ok, false, "nothing animates");
});

test("hub protocol: writing and animation content and controls are validated again, whoever sends them", () => {
  const present = (content: unknown) => hubCommandSchema.safeParse({ type: "present", content }).success;
  const yong = chinese("永").source;
  assert.ok(present({ kind: "writing", stroke: "chinese:永", label: "永", source: yong }));
  assert.ok(!present({ kind: "writing", stroke: "chinese:永", label: "永" }), "no source, no writing");
  const broken = JSON.parse(JSON.stringify(yong));
  broken.pieces[0].data.medians.pop();
  assert.ok(!present({ kind: "writing", stroke: "chinese:永", label: "永", source: broken }), "character data is checked again: one median per outline");
  assert.ok(present({ kind: "animation", sequence: DEMO_SEQUENCES["walk-and-stop"], label: "Walk" }));
  assert.ok(!present({ kind: "animation", sequence: { title: "x", actions: [{ do: "teleport" }] }, label: "x" }));
  assert.ok(hubCommandSchema.safeParse({ type: "animation", action: "repeat", stroke: 3 }).success);
  assert.ok(!hubCommandSchema.safeParse({ type: "animation", action: "explode" }).success);
  assert.ok(!hubCommandSchema.safeParse({ type: "present", content: { kind: "writing", stroke: "chinese:永", label: "永", source: yong }, rate: 99 }).success, "rates are bounded");
});

test("MCP: show_stroke_animation, play_animation and control_animation — honest, structured, never guessed", async () => {
  const aion = await connectAion();
  try {
    let out = await aion.call("show_stroke_animation", { symbol: "永" });
    assert.ok(!out.isError);
    const writing = (out.structuredContent as Record<string, unknown>).writing as { text: string; symbols: { symbol: string; strokes: string[]; pinyin?: string[] }[]; convention: string };
    assert.equal(writing.text, "永");
    assert.equal(writing.symbols[0].strokes.length, 5);
    assert.equal(writing.symbols[0].strokes[1], "right, then down, then a hook up-left");
    assert.deepEqual(writing.symbols[0].pinyin, ["yǒng"]);
    assert.match(writing.convention, /Make Me a Hanzi/);
    assert.equal(((out.structuredContent as Record<string, unknown>).presentation as { route: string }).route, "hybrid");
    out = await aion.call("control_animation", { action: "repeat", stroke: 3 });
    assert.match((out.content as { text: string }[])[0].text, /stroke 3 of 5: right, then down-left/);
    out = await aion.call("control_animation", { action: "repeat", stroke: 8 });
    assert.ok(out.isError && /has 5 strokes/.test((out.content as { text: string }[])[0].text));
    out = await aion.call("show_stroke_animation", { symbol: "\u{20000}" });
    assert.ok(out.isError && /character-not-in-pack/.test((out.content as { text: string }[])[0].text) && /never guesses/.test((out.content as { text: string }[])[0].text));
    out = await aion.call("play_animation", { demo: "jump-over-obstacle", speed: "slow" });
    assert.ok(!out.isError);
    const animation = (out.structuredContent as Record<string, unknown>).animation as { title: string; actions: string[]; speed: number };
    assert.deepEqual([animation.title, animation.speed], ["Jump over a box", 0.5]);
    out = await aion.call("control_animation", { action: "next" });
    assert.ok(out.isError, "a figure's sequence has no strokes");
    out = await aion.call("play_animation", { sequence: { title: "Bad", actions: [{ do: "walk", to: 5 }] } });
    assert.ok(out.isError, "the tool schema bounds positions");
    out = await aion.call("play_animation", { sequence: { title: "Lift", objects: [{ id: "panel", type: "panel", x: 0.5 }], actions: [{ do: "pick-up", object: "panel" }] } });
    assert.ok(out.isError && /animation-invalid/.test((out.content as { text: string }[])[0].text));
    out = await aion.call("play_animation", {});
    assert.ok(out.isError);
    out = await aion.call("control_animation", { action: "stop" });
    assert.ok(!out.isError);
    out = await aion.call("control_animation", { action: "pause" });
    assert.ok(out.isError && /no-animation/.test((out.content as { text: string }[])[0].text));
  } finally { await aion.close(); }
});

// ── Task A: Codex Voice Sync ───────────────────────────────────────────────────────────────────────────────────

const status = (patch: Partial<BridgeStatus>): BridgeStatus => ({ state: "off", ...patch });
const on = (patch: Partial<VoiceSyncPreference> = {}): VoiceSyncPreference => ({ enabled: true, permission: "granted", updatedAt: 1, ...patch });

test("voice sync policy: only when opted in, sound on and Aion open; never over another app; bounded backoff", () => {
  const decide = (patch: Partial<Parameters<typeof decideVoiceSync>[0]>) =>
    decideVoiceSync({ preference: on(), audioEnabled: true, open: true, bridge: status({}), attempts: 0, ...patch }).action;
  assert.equal(decide({}), "connect");
  assert.equal(decide({ preference: DEFAULT_VOICE_SYNC }), "none", "never without the user's opt-in");
  assert.equal(decide({ open: false }), "none", "nothing is captured for nobody");
  assert.equal(decide({ open: false, bridge: status({ state: "streaming", source: "codex" }) }), "disconnect");
  assert.equal(decide({ audioEnabled: false, bridge: status({ state: "streaming", source: "codex" }) }), "disconnect");
  assert.equal(decide({ bridge: status({ state: "streaming", source: "system" }) }), "none", "another app's sound the user chose wins");
  assert.equal(decide({ bridge: status({ state: "streaming", source: "codex" }) }), "none", "no duplicate capture");
  assert.equal(decide({ bridge: status({ state: "starting", source: "codex" }) }), "none");
  assert.equal(decide({ preference: on({ permission: "unanswered" }) }), "none", "a pending prompt is not raised again by itself");
  assert.equal(decide({ preference: on({ permission: "silent" }) }), "connect", "after a denial macOS does not prompt; diagnostics say why it is silent");
  assert.equal(decide({ bridge: status({ state: "unavailable", source: "codex", reason: "not-installed" }) }), "none");
  const failed = status({ state: "failed", source: "codex", reason: "ended" });
  const retry = decideVoiceSync({ preference: on(), audioEnabled: true, open: true, bridge: failed, attempts: 2 });
  assert.deepEqual(retry.action === "retry" && retry.afterSeconds, RECONNECT_BACKOFF_SECONDS[2]);
  assert.equal(decide({ bridge: failed, attempts: RECONNECT_BACKOFF_SECONDS.length }), "none", "bounded");
});

test("voice sync permission comes from evidence only (real samples, all-zero samples, an unanswered prompt)", () => {
  assert.equal(permissionFrom("unknown", status({ state: "streaming", source: "codex" }), false), "unconfirmed");
  assert.equal(permissionFrom("unconfirmed", status({ state: "streaming", source: "codex" }), true), "granted");
  assert.equal(permissionFrom("granted", status({ state: "streaming", source: "codex" }), false), "granted", "quiet never downgrades a grant");
  assert.equal(permissionFrom("unknown", status({ state: "streaming", source: "codex", silentCapture: true }), false), "silent");
  assert.equal(permissionFrom("unknown", status({ state: "failed", source: "codex", reason: "no-connection" }), false), "unanswered");
  assert.equal(permissionFrom("unknown", status({ state: "streaming", source: "system" }), true), "unknown", "another app says nothing about Codex");
});

test("voice sync preference persists (0600) across restarts and survives a corrupt file", () => {
  const home = tempHome();
  assert.deepEqual(loadVoiceSync(home), DEFAULT_VOICE_SYNC);
  saveVoiceSync(home, on({ permission: "unconfirmed" }));
  assert.deepEqual(loadVoiceSync(home), on({ permission: "unconfirmed" }));
  writeFileSync(join(home, "voice-sync.json"), "{ not json");
  assert.deepEqual(loadVoiceSync(home), DEFAULT_VOICE_SYNC);
  writeFileSync(join(home, "voice-sync.json"), JSON.stringify({ enabled: "yes", permission: "hacked" }));
  assert.deepEqual(loadVoiceSync(home), DEFAULT_VOICE_SYNC, "only valid values are taken");
});

/** A stand-in bridge app over the real socket: optionally waits first (follow mode), then streams `samples`. */
function standIn(samples: Float32Array, options: { wait?: number; endAfter?: number } = {}) {
  const launches: string[][] = [];
  const sockets: Socket[] = [];
  const launch = (_app: string, args: string[]) => {
    launches.push(args);
    const path = args[args.indexOf("--socket") + 1], nonce = args[args.indexOf("--nonce") + 1];
    const socket = connect(path, () => {
      const stream = () => {
        if (socket.destroyed) return;
        socket.write(`AION-PCM1 ${nonce} 48000\n`);
        for (let at = 0; at < samples.length; at += 512) {
          const block = samples.subarray(at, at + 512), frame = Buffer.alloc(4 + block.length * 4);
          frame.writeUInt32LE(block.length, 0);
          block.forEach((v, i) => frame.writeFloatLE(v, 4 + i * 4));
          socket.write(frame);
        }
        if (options.endAfter !== undefined) setTimeout(() => socket.destroy(), options.endAfter);
      };
      if (options.wait) { socket.write(`AION-WAIT1 ${nonce}\n`); setTimeout(stream, options.wait); } else stream();
    });
    socket.on("error", () => {});
    sockets.push(socket);
    return null;
  };
  return { launch, launches, sockets };
}
const tone = (seconds: number) => Float32Array.from({ length: Math.round(seconds * 48_000) }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 220 * i / 48_000));
const waitFor = async (check: () => boolean, ms = 3_000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return check(); };

test("bridge follow mode: waiting for Codex's audio is not a permission prompt; the first real sample is the proof", async () => {
  const app = standIn(tone(0.5), { wait: 300 });
  const statuses: BridgeStatus[] = [];
  let heard = 0;
  const bridge = new NativeAudioBridge({
    isMac: true, macosVersion: 15, locate: () => "stand-in", launch: app.launch, connectTimeout: 0.15,
    onFeatures: () => {}, onStatus: s => statuses.push(s), onHeard: () => heard++,
  });
  const first = await bridge.start({ source: "codex" });
  assert.deepEqual([first.state, first.waiting], ["starting", true], "waiting resolves the start, without the connect timeout");
  assert.ok(await waitFor(() => bridge.status.state === "streaming"), "then streams once the app's audio appears");
  assert.equal(bridge.status.waiting, undefined);
  assert.ok(await waitFor(() => heard === 1));
  assert.ok(app.launches[0].includes("--follow"));
  bridge.stop();
});

test("Codex Voice Sync in the hub: remembered, connects when Aion opens, reconnects with backoff, stops when closed", async () => {
  const home = tempHome();
  const app = standIn(tone(0.4), { endAfter: 250 });
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE, bridge: { isMac: true, macosVersion: 15, locate: () => "stand-in", launch: app.launch } });
  await hub.start();
  const token = hub.surfaceUrl.split("token=")[1];
  const open = async () => {
    const controller = new AbortController();
    const response = await fetch(new URL(`events?token=${token}&window=voicesync01`, hub.url), { signal: controller.signal });
    void response.body?.getReader().read().catch(() => {});
    return controller;
  };
  try {
    assert.equal(hub.snapshot().audio.voiceSync?.enabled, false);
    hub.apply({ type: "audio", voiceSync: true });
    assert.equal(app.launches.length, 0, "Aion is closed: nothing is captured yet");
    assert.equal(loadVoiceSync(home).enabled, true, "remembered on disk");
    const window = await open();
    assert.ok(await waitFor(() => hub.snapshot().audio.bridge.state === "streaming"), "opening Aion connects by itself");
    assert.ok(await waitFor(() => hub.snapshot().audio.voiceSync?.permission === "granted"), "real samples prove the permission");
    // The stand-in ends after a moment (Codex's helper restarting): the hub reconnects after its first backoff.
    assert.ok(await waitFor(() => app.launches.length >= 2, 4_000), "reconnected");
    assert.ok(app.launches.every(args => args.includes("--follow") && args.includes("com.openai.codex")), "Codex only, never other apps");
    window.abort();
    assert.ok(await waitFor(() => hub.snapshot().hub.viewers === 0));
    hub.apply({ type: "audio", stop: ["codex"] });
    assert.equal(loadVoiceSync(home).enabled, false, "\"stop reacting to your voice\" turns it off");
  } finally { await hub.stop(); }
  // A restarted hub (Codex restarted) remembers the choice.
  saveVoiceSync(home, on({ permission: "granted" }));
  const again = new PresenceHub({ home, port: 0, page: () => PAGE, bridge: { isMac: true, macosVersion: 15, locate: () => null } });
  assert.equal(again.snapshot().audio.voiceSync?.enabled, true);
  assert.equal(again.snapshot().audio.voiceSync?.unavailable, "not-installed", "and says why it cannot run here");
  await again.stop();
});

test("voice sync controller: the last window closing stops the capture after a grace; reopening resets the backoff", () => {
  const clock = manualClock();
  const calls: string[] = [];
  let bridgeStatus: BridgeStatus = { state: "off" };
  let viewers = 0;
  const fake = {
    status: bridgeStatus, heard: false, unavailable: () => null,
    start: async () => { calls.push("start"); fake.status = bridgeStatus = { state: "streaming", source: "codex" }; controller.bridgeChanged(bridgeStatus); return bridgeStatus; },
    stop: () => { calls.push("stop"); fake.status = bridgeStatus = { state: "off" }; },
  };
  const home = tempHome();
  saveVoiceSync(home, on());
  const controller = new VoiceSyncController({ bridge: fake as unknown as NativeAudioBridge, clock, home, audioEnabled: () => true, viewers: () => viewers, changed: () => {} });
  viewers = 1; controller.viewersChanged();
  assert.deepEqual(calls, ["start"]);
  controller.viewersChanged();
  assert.deepEqual(calls, ["start"], "no duplicate capture");
  viewers = 0; controller.viewersChanged();
  clock.advance(3_000);
  assert.deepEqual(calls, ["start"], "a reload keeps it during the grace");
  clock.advance(10_000);
  assert.deepEqual(calls, ["start", "stop"], "closed: it stops");
  controller.dispose();
});

test("audio routing is unchanged: Codex's voice drives the speaking body, never the spectrum unless chosen", () => {
  const route = routeAudio({ settings: DEFAULT_AUDIO_SETTINGS, sources: { codex: { connected: true, sounding: true } }, sincePlayback: Infinity });
  assert.deepEqual([route.reason, route.ring, route.sphere], ["codex-voice", null, null]);
});

// ── Skill: Storyteller Mode and narration ──────────────────────────────────────────────────────────────────────

test("Storyteller Mode: portrait vs story, told in parts, grounded, the storyteller never the person", () => {
  const skill = discoverSkills().find(item => item.name === "aion-presence")!;
  const body = skill.body;
  assert.match(body, /## Storyteller Mode/);
  assert.match(body, /\*\*Portrait\*\* — the user wants to \*see\* someone/);
  assert.match(body, /\*\*Story\*\* — the user wants to \*explore a life\*/);
  assert.match(body, /Never deliver the whole biography in one reply/);
  assert.match(body, /historical context, early life, formative experiences,\s+decisions, achievements, conflicts and setbacks, turning points, later life, legacy/);
  assert.match(body, /Keep the thread: remember whose story it is/);
  assert.match(body, /never invent quotations, conversations, motives or events/);
  assert.match(body, /what is documented, what is a reasonable interpretation, and what is uncertain/);
  assert.match(body, /You are the storyteller, not the person/);
  assert.match(body, /imaginative reconstruction/);
  assert.match(skill.description, /the story of a person's life/);
});

test("narration style: calm and unhurried, per context, honest that the host owns the voice", () => {
  const body = discoverSkills().find(item => item.name === "aion-presence")!.body;
  assert.match(body, /## Narration style/);
  assert.match(body, /calm, gentle, warm, unhurried and clear/);
  for (const context of ["Everyday conversation", "Storytelling", "Music teaching", "Writing \\(stroke order\\)", "Animations"]) assert.match(body, new RegExp(`- ${context}:`));
  assert.match(body, /You do not control\s+the host's speech synthesis/);
  assert.match(body, /no Aion tool changes them/);
  assert.match(body, /Codex Voice Sync/);
  assert.doesNotMatch(body, /set_speech_rate|speech_rate|voice_speed/, "no invented speech controls");
});

test("privacy: voice sync captures only Codex, keeps its file private, and the bridge still writes no audio", () => {
  const sync = readFileSync(join(import.meta.dirname, "..", "src/host/audio/voiceSync.ts"), "utf8");
  assert.match(sync, /start\(\{ source: "codex" \}\)/);
  assert.doesNotMatch(sync, /source: "system"/);
  assert.match(sync, /mode: 0o600/);
  const swift = readFileSync(join(import.meta.dirname, "..", "native/audio-bridge/AionAudioBridge.swift"), "utf8");
  assert.match(swift, /AudioObjectAddPropertyListenerBlock/, "process changes are notified, not polled");
  assert.match(swift, /AION-WAIT1/);
  assert.ok(existsSync(join(import.meta.dirname, "..", "src/audio/voiceSync.ts")));
});
