import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AudioAnalyzer, DIGITAL_SOURCE } from "../src/audio/analyzer";
import { bandCentres, bandPowers, logBandEdges, resampleBands } from "../src/audio/bands";
import { AudioFeatureBus } from "../src/audio/bus";
import { MusicDetector } from "../src/audio/detector";
import { createFeatures } from "../src/audio/features";
import { RealFft } from "../src/audio/fft";
import { PLAYBACK_ECHO_SECONDS, routeAudio, type SourceState } from "../src/audio/route";
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from "../src/audio/settings";
import { decodeFeatures, encodeFeatures } from "../src/audio/wire";
import { PresenceEngine } from "../src/core/signal";
import type { MicFrame } from "../src/core/listening/frame";
import { bridgeArgs, macosFromDarwin, NativeAudioBridge } from "../src/host/audio/bridge";
import { PresenceHub, loadAudioSettings } from "../src/host/hub/hub";
import { hubCommandSchema } from "../src/host/hub/protocol";
import { answerStep, buildScore, moveLesson, noteFacts } from "../src/host/music";
import { checkReading, readingQuestions } from "../src/music/exercises/reading";
import { LESSONS, findLesson } from "../src/music/lessons/lessons";
import { checkHighlights, checkScore, noteAt, playbackEvents, schedule } from "../src/music/notation/score";
import { CLEF_REFERENCE, describePosition, ledgerLines, lineNotes, pitchAt, spaceNotes, staffPosition } from "../src/music/notation/staff";
import { A4_HZ, diatonic, frequency, midi, parsePitch, pitchName } from "../src/music/theory/pitch";
import { barQuarters, isCompound, parseTimeSignature, quarters } from "../src/music/theory/rhythm";
import { scale, stepPattern } from "../src/music/theory/scales";
import { MUSIC_FORM_IDS, outlineRings } from "../src/music/visual/glyphForms";
import { bandAt, ringParams, ringPoint, spectrumPosition, sphereAudioOffset } from "../src/render/ring";
import { visualForms } from "../src/visual/forms";
import { PAGE, connectAion, tempHome } from "./helpers";

const RATE = 48_000;
const sine = (hz: number, seconds: number, amplitude = 0.5, rate = RATE) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
const names = (pitches: readonly { letter: string; accidental: number; octave: number }[]) => pitches.map(p => pitchName(p as never, true)).join(" ");
/** Feeds a signal to an analyser at 60 frames a second and returns every frame's copy of a few features. */
function run(analyzer: AudioAnalyzer, samples: Float32Array, onFrame?: (features: ReturnType<AudioAnalyzer["analyze"]>, t: number) => void) {
  const hop = RATE / 60;
  for (let at = 0, frame = 0; at + hop <= samples.length; at += hop, frame++) {
    analyzer.push(samples.subarray(at, at + hop));
    const features = analyzer.analyze(1 / 60);
    onFrame?.(features, frame / 60);
  }
  return analyzer.features;
}

// ── Music theory ───────────────────────────────────────────────────────────────────────────────────────────────

test("pitch: scientific names, MIDI numbers and equal-tempered frequencies (A4 = 440 Hz)", () => {
  assert.equal(midi(parsePitch("C4")!), 60);
  assert.equal(midi(parsePitch("A4")!), 69);
  assert.equal(midi(parsePitch("C#4")!), 61);
  assert.equal(midi(parsePitch("Db4")!), 61);
  assert.equal(midi(parsePitch("B♭3")!), 58);
  assert.equal(midi(parsePitch("Cb4")!), 59, "C flat is B");
  assert.equal(midi(parsePitch("E#4")!), 65, "E sharp is F");
  assert.equal(A4_HZ, 440);
  assert.equal(frequency(69), 440);
  assert.equal(frequency(81), 880, "an octave doubles");
  assert.ok(Math.abs(frequency(60) - 261.6256) < 1e-4, "middle C");
  assert.ok(Math.abs(frequency(70) / frequency(69) - 2 ** (1 / 12)) < 1e-12, "a semitone is the twelfth root of two");
  assert.equal(frequency(69, 442), 442, "another tuning reference");
  for (const bad of ["H4", "C", "C44", "4C", "", "C#", "Cx#4", 42]) assert.equal(parsePitch(bad), null, String(bad));
  assert.equal(diatonic(parsePitch("C4")!), 28);
  assert.equal(pitchName(parsePitch("F#5")!), "F♯5");
  assert.equal(pitchName(parsePitch("F#5")!, true), "F#5");
});

test("staff: every clef's lines and spaces, middle C on its ledger lines, positions named as a teacher would", () => {
  assert.equal(names(lineNotes("treble")), "E4 G4 B4 D5 F5");
  assert.equal(names(spaceNotes("treble")), "F4 A4 C5 E5");
  assert.equal(names(lineNotes("bass")), "G2 B2 D3 F3 A3");
  assert.equal(names(spaceNotes("bass")), "A2 C3 E3 G3");
  const c4 = parsePitch("C4")!;
  assert.equal(staffPosition(c4, "treble"), -2, "middle C: one ledger line below the treble staff");
  assert.equal(staffPosition(c4, "bass"), 10, "and one above the bass staff");
  assert.deepEqual(ledgerLines(-2), [-2]);
  assert.deepEqual(ledgerLines(-5), [-2, -4]);
  assert.deepEqual(ledgerLines(12), [10, 12]);
  assert.deepEqual(ledgerLines(4), []);
  assert.equal(staffPosition(parsePitch("C#4")!, "treble"), -2, "an accidental does not move the note");
  assert.equal(pitchName(pitchAt(CLEF_REFERENCE.treble.position, "treble")), CLEF_REFERENCE.treble.pitch, "the G clef curls round G4 on line 2");
  assert.equal(CLEF_REFERENCE.treble.position, 2);
  assert.equal(pitchName(pitchAt(CLEF_REFERENCE.bass.position, "bass")), CLEF_REFERENCE.bass.pitch, "the F clef's dots frame F3 on line 4");
  assert.equal(CLEF_REFERENCE.bass.position, 6);
  assert.equal(describePosition(0), "line 1");
  assert.equal(describePosition(3), "space 2");
  assert.equal(describePosition(-2), "the first ledger line below the staff");
  assert.equal(describePosition(-1), "the space just below the staff");
  assert.equal(describePosition(-3), "the space below the first ledger line below the staff");
  assert.equal(describePosition(10), "the first ledger line above the staff");
  assert.equal(describePosition(0, "zh"), "第一线");
  assert.equal(describePosition(7, "zh"), "第四间");
  assert.equal(describePosition(-2, "zh"), "下加一线");
  assert.equal(describePosition(-1, "zh"), "下加一间");
  assert.equal(describePosition(12, "zh"), "上加二线");
});

test("rhythm: note values in quarter notes, dots, time signatures and compound metre", () => {
  assert.deepEqual(["whole", "half", "quarter", "eighth", "sixteenth"].map(d => quarters(d as never)), [4, 2, 1, 0.5, 0.25]);
  assert.equal(quarters("half", true), 3);
  assert.deepEqual(parseTimeSignature("4/4"), { beats: 4, unit: 4 });
  assert.deepEqual(parseTimeSignature("C"), { beats: 4, unit: 4 });
  assert.deepEqual(parseTimeSignature("6/8"), { beats: 6, unit: 8 });
  for (const bad of ["5/4", "4/3", "x", "", "4/4/4"]) assert.equal(parseTimeSignature(bad), null, bad);
  assert.equal(barQuarters({ beats: 3, unit: 4 }), 3);
  assert.equal(barQuarters({ beats: 6, unit: 8 }), 3);
  assert.equal(isCompound({ beats: 6, unit: 8 }), true);
  assert.equal(isCompound({ beats: 3, unit: 8 }), false);
});

test("scales are spelled correctly: one of each letter, the pattern's accidentals", () => {
  const c = scale(parsePitch("C4")!);
  assert.equal(names(c), "C4 D4 E4 F4 G4 A4 B4 C5");
  assert.deepEqual(stepPattern(c), ["W", "W", "H", "W", "W", "W", "H"]);
  assert.equal(names(scale(parsePitch("G3")!)), "G3 A3 B3 C4 D4 E4 F#4 G4");
  assert.equal(names(scale(parsePitch("F4")!)), "F4 G4 A4 Bb4 C5 D5 E5 F5");
  assert.equal(names(scale(parsePitch("A3")!, "natural-minor")), "A3 B3 C4 D4 E4 F4 G4 A4");
  assert.equal(names(scale(parsePitch("A3")!, "harmonic-minor")), "A3 B3 C4 D4 E4 F4 G#4 A4");
  assert.equal(scale(parsePitch("C4")!, "major", 2).length, 15);
});

test("scores are validated strictly: real, writable pitches; exact bars; highlights that exist", () => {
  const ok = checkScore({ clef: "treble", time: "4/4", notes: [{ pitch: "C5", duration: "half" }, { pitch: "G4", duration: "quarter" }, { duration: "quarter" }, { pitch: "E4", duration: "whole" }] });
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.value.measures, 2); assert.deepEqual(ok.value.notes.map(n => n.measure), [0, 0, 0, 1]); assert.equal(ok.value.totalQuarters, 8); }
  const crossing = checkScore({ clef: "treble", time: "4/4", notes: [{ pitch: "C5", duration: "half", dotted: true }, { pitch: "C5", duration: "half" }] });
  assert.ok(!crossing.ok && /crosses a bar line/.test(crossing.problem));
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "C1", duration: "quarter" }] }).ok, "too far below the treble staff");
  assert.ok(checkScore({ clef: "bass", notes: [{ pitch: "C2", duration: "quarter" }] }).ok, "but fine in the bass clef");
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "H4", duration: "quarter" }] }).ok);
  assert.ok(!checkScore({ clef: "alto", notes: [] }).ok);
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "C4", duration: "breve" }] }).ok);
  assert.ok(checkScore({ clef: "treble", notes: [] }).ok, "an empty staff");
  assert.ok(!checkScore({ clef: "treble", notes: Array.from({ length: 49 }, () => ({ pitch: "C4", duration: "quarter" })) }).ok);
  assert.ok(!checkScore({ clef: "treble", notes: [{ pitch: "C4", duration: "quarter", label: "x\u0007" }] }).ok);
  if (ok.ok) {
    assert.ok(checkHighlights([{ note: 3 }, { line: 5 }, { space: 1 }, { clef: true }, { time: true }], ok.value).ok);
    assert.ok(!checkHighlights([{ note: 4 }], ok.value).ok);
    assert.ok(!checkHighlights([{ line: 6 }], ok.value).ok);
  }
});

test("playback is scheduled exactly on the audio clock: start times from tempo, rests kept, the sounding note found", () => {
  const checked = checkScore({ clef: "treble", notes: [{ pitch: "C4", duration: "quarter" }, { duration: "quarter" }, { pitch: "A4", duration: "half" }] });
  assert.ok(checked.ok);
  if (!checked.ok) return;
  const events = playbackEvents(checked.value);
  assert.deepEqual(events.map(e => [e.midi, e.start, e.length]), [[60, 0, 1], [null, 1, 1], [69, 2, 2]]);
  const timed = schedule(events, 120, 10);
  assert.deepEqual(timed.map(n => [n.at, n.until]), [[10, 10.5], [10.5, 11], [11, 12]]);
  assert.equal(timed[2].frequency, 440);
  assert.equal(timed[1].frequency, null);
  assert.equal(noteAt(timed, 10.25)?.index, 0);
  assert.equal(noteAt(timed, 11.99)?.index, 2);
  assert.equal(noteAt(timed, 12), null);
  assert.deepEqual(playbackEvents(checked.value, [2]).map(e => [e.index, e.start]), [[2, 0]], "chosen notes play without the gaps");
  assert.equal(schedule(events, 1_000)[1].at, 60 / 240, "the tempo is clamped to 240");
});

test("note-reading practice: deterministic, never the same note twice in a row, answers in letters, octaves or solfège", () => {
  const questions = readingQuestions(3, "treble", 20);
  assert.deepEqual(questions, readingQuestions(3, "treble", 20));
  for (let i = 1; i < questions.length; i++) assert.notEqual(questions[i].position, questions[i - 1].position);
  for (const q of questions) assert.ok(q.position >= -2 && q.position <= 10);
  const e4 = { clef: "treble" as const, pitch: "E4", position: 0 };
  for (const answer of ["E", "e", "E4", "mi", "It's E.", "这是E", "e note"]) assert.equal(checkReading(e4, answer).correct, true, answer);
  for (const answer of ["F", "E5", "fa", "E sharp", "Eb", "banana"]) assert.equal(checkReading(e4, answer).correct, false, answer);
  assert.equal(checkReading({ clef: "treble", pitch: "F#4", position: 1 }, "F sharp").correct, true);
  assert.equal(checkReading({ clef: "treble", pitch: "Bb4", position: 4 }, "bb").correct, true);
  assert.equal(checkReading(e4, "banana").heard, null);
});

test("lessons: eight, bilingual, every step's score, highlight and playback valid in both languages", () => {
  assert.deepEqual(LESSONS.map(lesson => lesson.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const lesson of LESSONS) {
    assert.ok(lesson.title.en && lesson.title.zh, `lesson ${lesson.id} has both titles`);
    assert.ok(lesson.steps.length >= 2);
    for (const [i, step] of lesson.steps.entries()) {
      const where = `lesson ${lesson.id} step ${i + 1}`;
      assert.ok(step.text.en.length > 20 && step.text.zh.length > 6, `${where}: text in both languages`);
      assert.ok(/[一-鿿]/.test(step.text.zh), `${where}: Chinese text is Chinese`);
      for (const language of ["en", "zh"] as const) {
        const checked = checkScore(step.score(language));
        assert.ok(checked.ok, `${where} (${language}): ${checked.ok ? "" : checked.problem}`);
        if (!checked.ok) continue;
        assert.ok(checkHighlights(step.highlight, checked.value).ok, `${where}: highlights`);
        if (Array.isArray(step.play)) for (const index of step.play) assert.ok(index < checked.value.notes.length, `${where}: play ${index}`);
      }
      if (step.symbol) assert.ok(MUSIC_FORM_IDS.includes(step.symbol), `${where}: ${step.symbol}`);
      if (step.question) assert.equal(answerStep(step, pitchName(parsePitch(step.score("en").notes[0].pitch!)!).replace(/\d/, ""))?.correct, true, `${where}: answerable`);
    }
  }
  // The content is right: lesson 3 names the treble lines and spaces; lesson 7 has the scale and its half steps.
  assert.deepEqual(LESSONS[2].steps[0].score("en").notes.map(n => n.pitch), ["E4", "G4", "B4", "D5", "F5"]);
  assert.deepEqual(LESSONS[2].steps[1].score("en").notes.map(n => n.pitch), ["F4", "A4", "C5", "E5"]);
  assert.deepEqual(LESSONS[2].steps[2].score("en").notes.map(n => n.pitch), ["G2", "A2", "B2", "C3", "D3", "E3", "F3", "G3", "A3"]);
  assert.deepEqual(LESSONS[6].steps[0].score("zh").notes.map(n => n.label), ["do", "re", "mi", "fa", "sol", "la", "si", "do"]);
  assert.equal(findLesson("clefs")?.id, 2);
  assert.equal(findLesson("lesson 7")?.id, 7);
  assert.equal(findLesson("休止符")?.id, 5);
  assert.equal(findLesson("C major")?.id, 7);
});

test("the host side: scores from notes or scales, facts for every note, lessons that move and keep their language", () => {
  const built = buildScore({ scale: { tonic: "C4" } });
  assert.ok(built.ok);
  if (built.ok) {
    assert.equal(built.title, "C major scale");
    const facts = noteFacts(built.score);
    assert.deepEqual(facts.map(f => (f as { pitch: string }).pitch), ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]);
    assert.equal((facts[0] as { where: string }).where, "the first ledger line below the staff");
    assert.equal((facts[5] as { frequency: number }).frequency, 440);
    assert.equal((facts[0] as { middleC?: boolean }).middleC, true);
    assert.equal((noteFacts(built.score, "zh")[0] as { where: string; duration: string }).where, "下加一线");
  }
  const low = buildScore({ notes: [{ pitch: "C3" }, { pitch: "G2" }] });
  assert.ok(low.ok && low.score.clef === "bass", "low notes choose the bass clef");
  assert.ok(!buildScore({ notes: [{ pitch: "C4" }], scale: { tonic: "C4" } }).ok);
  assert.ok(!buildScore({}).ok);
  let move = moveLesson(null, { lesson: 2 });
  assert.ok(move.ok && move.position.step === 1 && move.position.language === "en");
  if (!move.ok) return;
  move = moveLesson(move.position, { step: "next" });
  assert.ok(move.ok && move.position.step === 2);
  if (!move.ok) return;
  const zh = moveLesson(move.position, { language: "zh" });
  assert.ok(zh.ok && zh.position.step === 2 && zh.position.id === 2 && zh.position.language === "zh", "a language switch repeats the step");
  const back = moveLesson(move.position, { step: "previous" });
  assert.ok(back.ok && back.position.step === 1);
  const done = moveLesson({ id: 2, step: 4, language: "en" }, { step: "next" });
  assert.ok(!done.ok && /complete/.test(done.problem) && /lesson 3/.test(done.problem));
  assert.ok(!moveLesson(null, { step: "next" }).ok);
});

test("music symbols for the body: every form draws a closed, non-empty outline, found by English and Chinese names", () => {
  for (const id of MUSIC_FORM_IDS) {
    const raster = (visualForms.render(id).visual as { raster: { data: Uint8ClampedArray } }).raster;
    let ink = 0;
    for (let i = 3; i < raster.data.length; i += 4) ink += raster.data[i];
    assert.ok(ink > 255 * 200, `${id} has ink`);
  }
  for (const [name, id] of [["treble clef", "music.treble-clef"], ["高音谱号", "music.treble-clef"], ["F clef", "music.bass-clef"], ["quarter note", "music.quarter-note"], ["♯", "music.sharp"], ["降号", "music.flat"], ["四分休止符", "music.quarter-rest"]]) {
    assert.equal(visualForms.lookup(name)?.entry.id, id, name);
  }
  for (const ring of outlineRings("M0 0L10 0L10 10Z M20 20Q30 20 30 30L20 30Z")) assert.deepEqual(ring[0], ring.at(-1), "closed");
});

// ── Audio analysis ─────────────────────────────────────────────────────────────────────────────────────────────

test("FFT: a sine lands in its bin, power sums to its mean square (Parseval), DC and silence are exact", () => {
  const fft = new RealFft(1024), out = new Float32Array(513);
  const binHz = RATE / 1024, k = 40;
  fft.power(sine(k * binHz, 1024 / RATE, 0.5), out);
  const peak = out.indexOf(Math.max(...out));
  assert.equal(peak, k);
  const total = out.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 0.125) / 0.125 < 0.02, `total power ${total} ≈ 0.5²/2`);
  fft.power(new Float32Array(1024).fill(0.25), out, false);
  assert.ok(Math.abs(out[0] - 0.0625) < 1e-9 && out.slice(1).every(v => v < 1e-12), "DC");
  fft.power(new Float32Array(1024), out);
  assert.ok(out.every(v => v === 0));
  assert.throws(() => new RealFft(1000));
});

test("bands: logarithmic, centred, every band filled, power kept; resampling keeps the shape", () => {
  const edges = logBandEdges(32, 40, 16_000);
  assert.equal(edges.length, 33);
  assert.ok(Math.abs(edges[0] - 40) < 1e-9 && Math.abs(edges[32] - 16_000) < 1e-6);
  const ratio = edges[1] / edges[0];
  for (let i = 1; i < 33; i++) assert.ok(Math.abs(edges[i] / edges[i - 1] - ratio) < 1e-9, "equal width in octaves");
  const centres = bandCentres(edges);
  assert.ok(centres.every((c, i) => c > edges[i] && c < edges[i + 1]));
  const spectrum = new Float32Array(1025).fill(1e-6), bands = new Float32Array(32);
  bandPowers(spectrum, RATE, 2048, edges, bands);
  assert.ok(bands.every(v => v > 0), "even the lowest band, narrower than a bin, is never empty");
  const up = resampleBands([0, 1, 0, 1], new Float32Array(8));
  assert.deepEqual(Array.from(up), [0, 0, 1, 1, 0, 0, 1, 1]);
  const down = resampleBands(Float32Array.from({ length: 32 }, (_, i) => i), new Float32Array(16));
  assert.ok(Math.abs(down[0] - 0.5) < 1e-6 && Math.abs(down[15] - 30.5) < 1e-6);
});

test("analyser: RMS is exact; bass, mid and treble follow the frequency; silence and stale sources are silent", () => {
  const tone = (hz: number) => { const a = new AudioAnalyzer(RATE); run(a, sine(hz, 1.2, 0.5)); return { ...a.features, bands: Array.from(a.features.bands) }; };
  const low = tone(80), mid = tone(800), high = tone(6_000);
  // RMS over the newest 1024 samples: exact up to the partial period of an 80 Hz wave in that window.
  assert.ok(Math.abs(low.rms - 0.5 / Math.SQRT2) < 0.04, `rms ${low.rms}`);
  assert.ok(Math.abs(tone(750).rms - 0.5 / Math.SQRT2) < 0.002, "exact when the window holds whole periods (750 Hz: 16 in 1024 samples)");
  assert.ok(low.bass > 0.4 && low.bass > low.mid && low.bass > low.treble, `80 Hz: bass ${low.bass.toFixed(2)} mid ${low.mid.toFixed(2)} treble ${low.treble.toFixed(2)}`);
  assert.ok(mid.mid > mid.bass && mid.mid > mid.treble, "800 Hz: mid");
  assert.ok(high.treble > high.bass && high.treble > high.mid, "6 kHz: treble");
  assert.ok(low.centroid < mid.centroid && mid.centroid < high.centroid, "centroid rises with frequency");
  const loudest = (bands: number[]) => bands.indexOf(Math.max(...bands));
  assert.ok(loudest(low.bands) < loudest(mid.bands) && loudest(mid.bands) < loudest(high.bands), "the loudest band moves up with the tone");
  assert.equal(low.silent, false);
  const a = new AudioAnalyzer(RATE);
  run(a, sine(440, 1, 0.3));
  run(a, new Float32Array(2 * RATE));
  assert.equal(a.features.silent, true, "digital silence");
  assert.ok(a.features.level < 0.01 && a.features.bands.every(v => v < 0.01));
  const b = new AudioAnalyzer(RATE);
  run(b, sine(440, 0.5, 0.3));
  for (let i = 0; i < 45; i++) b.analyze(1 / 60); // stale after 0.25 s, then the silence hold
  assert.equal(b.features.silent, true, "no samples arriving (a stopped source) is silence too");
});

test("analyser: background noise stays small; quiet and loud music both read clearly (dynamic-range control)", () => {
  let seed = 3;
  const noise = (amplitude: number, seconds: number) => Float32Array.from({ length: seconds * RATE }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x3fffffff - 1) * amplitude; });
  const room = new AudioAnalyzer(RATE);
  let maxLevel = 0;
  run(room, noise(0.002, 4), f => { maxLevel = Math.max(maxLevel, f.level); });
  assert.ok(maxLevel < 0.15, `a quiet room never looks like sound (${maxLevel.toFixed(3)})`);
  const chord = (amplitude: number) => Float32Array.from({ length: 3 * RATE }, (_, i) => amplitude * (Math.sin(2 * Math.PI * 220 * i / RATE) + Math.sin(2 * Math.PI * 277 * i / RATE) + Math.sin(2 * Math.PI * 330 * i / RATE)) / 3);
  const quiet = new AudioAnalyzer(RATE, DIGITAL_SOURCE), loud = new AudioAnalyzer(RATE, DIGITAL_SOURCE);
  run(quiet, chord(0.02)); run(loud, chord(0.6));
  assert.ok(quiet.features.level > 0.5 && loud.features.level > 0.5, `quiet (−42 dBFS) ${quiet.features.level.toFixed(2)} and loud (−12 dBFS) ${loud.features.level.toFixed(2)} are both visible`);
  // The microphone's floor never takes a steady quiet sound for a voice.
  const mic = new AudioAnalyzer(RATE);
  run(mic, chord(0.02));
  assert.ok(mic.features.level < 0.2, "on a microphone, a faint steady hum is the room");
  assert.ok(Math.abs(quiet.features.level - loud.features.level) < 0.3, "automatic gain keeps them comparable");
  const sensitive = new AudioAnalyzer(RATE), insensitive = new AudioAnalyzer(RATE);
  sensitive.sensitivity = 1; insensitive.sensitivity = 0;
  run(sensitive, noise(0.004, 3)); run(insensitive, noise(0.004, 3));
  assert.ok(insensitive.features.level <= sensitive.features.level, "sensitivity lowers the gate");
});

test("analyser: smoothing — fast attack, slower release, no flicker; onsets and beats on a steady pulse", () => {
  const a = new AudioAnalyzer(RATE);
  const levels: number[] = [];
  run(a, Float32Array.from({ length: 2 * RATE }, (_, i) => i < RATE ? 0.4 * Math.sin(2 * Math.PI * 300 * i / RATE) : 0), f => levels.push(f.level));
  const rise = levels.findIndex(v => v > 0.5), fall = levels.slice(60).findIndex(v => v < 0.1);
  assert.ok(rise >= 0 && rise < 8, `attack within ${rise} frames`);
  assert.ok(fall > rise, `release (${fall} frames) is slower than attack (${rise})`);
  let jumps = 0;
  for (let i = 1; i < 55; i++) if (Math.abs(levels[i] - levels[i - 1]) > 0.35) jumps++;
  assert.ok(jumps <= 1, "a steady tone does not flicker");
  // Clicks every 0.5 s: beats near each click, none in between.
  const clicks = new AudioAnalyzer(RATE);
  const beats: number[] = [];
  const pulse = Float32Array.from({ length: 4 * RATE }, (_, i) => { const t = (i / RATE) % 0.5; return t < 0.03 ? Math.sin(2 * Math.PI * 120 * t) * Math.exp(-t * 80) * 0.8 : 0.0005 * Math.sin(i); });
  run(clicks, pulse, (f, t) => { if (f.beat > 0.99) beats.push(t); });
  assert.ok(beats.length >= 5 && beats.length <= 9, `${beats.length} beats in 4 s of a 120 bpm pulse`);
  for (let i = 1; i < beats.length; i++) assert.ok(Math.abs((beats[i] - beats[i - 1]) - 0.5) < 0.06, `spaced by the pulse (${(beats[i] - beats[i - 1]).toFixed(3)} s)`);
});

test("analyser: an AnalyserNode-style window gives the same features as the samples themselves", () => {
  const samples = sine(523, 1, 0.3);
  const direct = new AudioAnalyzer(RATE), windowed = new AudioAnalyzer(RATE);
  const hop = RATE / 60;
  for (let at = hop; at <= samples.length; at += hop) {
    direct.push(samples.subarray(at - hop, at)); direct.analyze(1 / 60);
    windowed.pushWindow(samples.subarray(Math.max(0, at - 2048), at), hop); windowed.analyze(1 / 60);
  }
  for (let b = 0; b < direct.features.bands.length; b++) assert.ok(Math.abs(direct.features.bands[b] - windowed.features.bands[b]) < 0.02, `band ${b}`);
  assert.ok(Math.abs(direct.features.level - windowed.features.level) < 0.02);
});

test("music detector: sustained music becomes music after a few seconds; speech and silence never do; no flip-flop", () => {
  const music = Float32Array.from({ length: 14 * RATE }, (_, i) => {
    const t = i / RATE, beat = t % 0.5, bar = Math.floor(t / 2) % 4;
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 9);
    const bass = Math.sin(2 * Math.PI * [55, 44, 49, 41][bar] * t);
    const pad = [0, 4, 7].reduce((s, k) => s + Math.sin(2 * Math.PI * 220 * 2 ** (k / 12) * t), 0) / 3;
    return (kick * 0.5 + bass * 0.3 + pad * 0.25) * 0.4;
  });
  const speech = Float32Array.from({ length: 14 * RATE }, (_, i) => {
    const t = i / RATE, local = t % 2, k = Math.floor(t / 2);
    if (local > 1.6) return 0.0003 * Math.sin(i * 7.1);
    const syllable = Math.max(0, Math.sin(Math.PI * 2 * (4.6 + (k % 3) * 0.4) * local)) ** 1.5;
    let voiced = 0;
    for (let h = 1; h <= 8; h++) voiced += Math.sin(2 * Math.PI * (130 + 25 * Math.sin(local * 3 + k)) * h * t) / h;
    return voiced * 0.2 * syllable;
  });
  const decide = (samples: Float32Array) => {
    const analyzer = new AudioAnalyzer(RATE), detector = new MusicDetector();
    let first = -1, flips = 0, last = false;
    run(analyzer, samples, (f, t) => { const m = detector.sample(f, 1 / 60); if (m !== last) { flips++; last = m; } if (m && first < 0) first = t; });
    return { first, flips, music: detector.music, detector };
  };
  const m = decide(music);
  assert.ok(m.music && m.first > 3 && m.first < 9 && m.flips === 1, `music: detected at ${m.first.toFixed(1)} s, ${m.flips} change`);
  const s = decide(speech);
  assert.ok(!s.music && s.first < 0, "speech never becomes the spectrum");
  // Music, then silence: the decision ends within the silence exit.
  const analyzer = new AudioAnalyzer(RATE), detector = new MusicDetector();
  run(analyzer, music, f => detector.sample(f, 1 / 60));
  let endedAfter = -1;
  run(analyzer, new Float32Array(4 * RATE), (f, t) => { if (!detector.sample(f, 1 / 60) && endedAfter < 0) endedAfter = t; });
  assert.ok(endedAfter > 1 && endedAfter < 3.5, `music ends ${endedAfter.toFixed(2)} s into the silence`);
});

test("wire: features travel compactly and come back within quantisation; malformed frames are refused", () => {
  const a = new AudioAnalyzer(RATE);
  run(a, sine(220, 1, 0.4));
  const wire = encodeFeatures("codex", a.features);
  assert.ok(JSON.stringify(wire).length < 220, `${JSON.stringify(wire).length} bytes`);
  assert.deepEqual(Object.keys(wire).sort(), ["b", "n", "q", "s", "t", "v"], "no field a sample could travel in");
  const back = decodeFeatures(JSON.parse(JSON.stringify(wire)));
  assert.ok(back && back.source === "codex");
  for (let i = 0; i < 32; i++) assert.ok(Math.abs(back!.features.bands[i] - a.features.bands[i]) <= 1 / 255 + 1e-6);
  assert.ok(Math.abs(back!.features.level - a.features.level) < 0.001);
  for (const bad of [null, {}, { ...wire, s: "speaker" }, { ...wire, n: [1, 2] }, { ...wire, b: "!!!!" }, { ...wire, b: "A".repeat(200) }, { ...wire, t: Infinity }]) assert.equal(decodeFeatures(bad), null);
});

test("source management: one sound is analysed once; Codex's voice is never the user; shared music becomes the ring", () => {
  const on: SourceState = { connected: true, sounding: true }, quiet: SourceState = { connected: true, sounding: false };
  const settings = (patch: Partial<AudioSettings> = {}): AudioSettings => ({ ...DEFAULT_AUDIO_SETTINGS, ...patch });
  const route = (sources: Record<string, SourceState>, patch: Partial<AudioSettings> = {}, sincePlayback = Infinity) => routeAudio({ settings: settings(patch), sources, sincePlayback });
  let r = route({ music: on, microphone: on, codex: on, system: { ...on, music: true } });
  assert.equal(r.sphere, "music"); assert.equal(r.ring, null, "a lesson never becomes the spectrum by itself");
  assert.ok(r.suppressMicrophone && r.ignoreCodex, "its echo is not the user, and Codex's tap may carry it");
  r = route({ music: quiet, microphone: on }, {}, PLAYBACK_ECHO_SECONDS / 2);
  assert.ok(r.suppressMicrophone && r.sphere === null, "the echo tail after playback");
  r = route({ codex: on, microphone: on });
  assert.equal(r.reason, "codex-voice"); assert.equal(r.ring, null); assert.equal(r.sphere, null, "Codex's voice is the speaking body (the engine)");
  r = route({ system: { ...on, music: true } });
  assert.equal(r.ring, "system"); assert.equal(r.reason, "music-detected");
  r = route({ system: { ...on, music: false } });
  assert.equal(r.ring, null); assert.equal(r.sphere, "system", "speech on a shared source moves the sphere gently");
  assert.equal(route({ system: { ...on, music: true } }, { mode: "sphere" }).ring, null, "sphere mode never forms the ring");
  assert.equal(route({ tab: quiet }, { mode: "spectrum", source: "tab" }).ring, "tab", "an explicit spectrum stays while the source is connected");
  assert.equal(route({}, { mode: "spectrum" }).ring, null, "no source, no spectrum");
  assert.equal(route({ system: { ...on, music: true } }, { enabled: false }).ring, null);
  assert.equal(route({ microphone: on }).sphere, "microphone");
  assert.equal(route({ microphone: on }, { mode: "spectrum" }).ring, null, "the user's voice never becomes the spectrum unless chosen");
  assert.equal(route({ microphone: on }, { mode: "spectrum", source: "microphone" }).ring, "microphone");
  assert.equal(route({ codex: on, system: { ...on, music: true } }, { source: "system" }).ring, "system", "a chosen source is followed");
  assert.equal(route({ system: { ...on, music: true } }, { mode: "hybrid" }).layout, "hybrid");
});

test("the feature bus: fresh frames only; a source closed or gone quiet stops driving", () => {
  const bus = new AudioFeatureBus(), features = createFeatures(32);
  features.silent = false; features.level = 0.6;
  bus.publish("tab", features, 10);
  assert.deepEqual(bus.state("tab", 10.5), { connected: true, sounding: true });
  assert.equal(bus.get("tab", 12), null, "stale after a second");
  bus.publish("tab", features, 20);
  bus.setConnected("tab", false, 20.1);
  assert.equal(bus.state("tab", 20.2).connected, false);
  assert.equal(bus.get("codex", 0), null);
});

test("presence engine: while Aion's own music plays, the microphone is not taken for the user", () => {
  let playing = true;
  const mic = { read: (): MicFrame => ({ voiced: true, level: 0.6, utterance: 1, emphasis: 0, rms: 0.05 }) };
  const engine = new PresenceEngine({ state: () => "idle", host: () => "idle", playback: () => playing });
  engine.setMicrophone(mic);
  for (let i = 0; i < 30; i++) engine.sample(1 / 60, i / 60);
  assert.equal(engine.echo, "playback");
  assert.equal(engine.activity, "idle");
  playing = false;
  for (let i = 30; i < 60; i++) engine.sample(1 / 60, i / 60);
  assert.equal(engine.activity, "listening");
});

test("the circular spectrum: bass at the bottom, treble at the top, bounded bars, a core, calm in silence", () => {
  assert.ok(Math.abs(spectrumPosition(-Math.PI / 2)) < 1e-9, "bottom: bass");
  assert.ok(Math.abs(spectrumPosition(Math.PI / 2) - 1) < 1e-9, "top: treble");
  assert.ok(Math.abs(spectrumPosition(0) - 0.5) < 1e-9 && Math.abs(spectrumPosition(Math.PI) - 0.5) < 1e-9, "mirrored left and right");
  assert.equal(bandAt([0, 1], 0.5), 0.5);
  const params = ringParams(0, 0);
  const silent = { bands: new Float32Array(32), bass: 0, mid: 0, treble: 0, beat: 0, gain: 1 };
  const bassy = { ...silent, bands: Float32Array.from({ length: 32 }, (_, i) => i < 8 ? 1 : 0), bass: 0.8 };
  const bright = { ...silent, bands: Float32Array.from({ length: 32 }, (_, i) => i > 24 ? 1 : 0), treble: 0.8 };
  let core = 0;
  const radius = (audio: typeof silent, angle: number) => { const p = ringPoint([Math.cos(angle) * 1.35, Math.sin(angle) * 1.35, 0.01], params, audio, 0); return p.core ? null : Math.hypot(p.position[0], p.position[1]); };
  const n = 2000;
  for (let i = 0; i < n; i++) { const a = i * 2.399, p = ringPoint([Math.cos(a) * 1.3, Math.sin(a) * 1.3, Math.sin(i) * 0.3], params, silent, 0); if (p.core) core++; else assert.ok(Math.abs(Math.hypot(p.position[0], p.position[1]) - params.radius) < 0.06, "silence: the bare ring"); }
  assert.ok(Math.abs(core / n - params.core) < 0.04, `about ${params.core * 100}% stay as the core (${(core / n * 100).toFixed(1)}%)`);
  const mean = (audio: typeof silent, from: number, to: number) => { const out: number[] = []; for (let i = 0; i < 400; i++) { const r = radius(audio, from + (to - from) * i / 400); if (r !== null) out.push(r); } return out.reduce((a, b) => a + b, 0) / out.length; };
  const down = [-Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4] as const, up = [Math.PI / 2 - 0.4, Math.PI / 2 + 0.4] as const;
  assert.ok(mean(bassy, ...down) > mean(bassy, ...up) + 0.15, "bass reaches out at the bottom");
  assert.ok(mean(bright, ...up) > mean(bright, ...down) + 0.15, "treble reaches out at the top");
  const loud = { ...silent, bands: new Float32Array(32).fill(1), bass: 1, mid: 1, treble: 1, beat: 1, gain: 1.6 };
  for (let i = 0; i < 500; i++) { const a = i * 0.7; const p = ringPoint([Math.cos(a), Math.sin(a), 0.2], params, loud, i * 0.1); assert.ok(Math.hypot(...p.position) < 2.75, "bars stay in view"); }
  const offset = sphereAudioOffset([0, -1.35, 0], { ...loud, level: 1, weight: 1 }, 0);
  assert.ok(Math.hypot(...offset) < 0.45, "the sphere's field is bounded: it stays a sphere");
  assert.deepEqual(sphereAudioOffset([0, 1, 0], { ...loud, level: 1, weight: 0 }, 0), [0, 0, 0]);
});

// ── The native bridge, the hub and the tools ───────────────────────────────────────────────────────────────────

/** A stand-in for the macOS app: connects to the bridge's socket, says hello and streams `samples`. */
function fakeApp(samples: Float32Array | ((args: string[]) => Float32Array), options: { nonce?: (real: string) => string } = {}) {
  return (_app: string, args: string[]) => {
    const path = args[args.indexOf("--socket") + 1], nonce = args[args.indexOf("--nonce") + 1];
    const data = typeof samples === "function" ? samples(args) : samples;
    const socket = connect(path, () => {
      socket.write(`AION-PCM1 ${options.nonce ? options.nonce(nonce) : nonce} 48000\n`);
      for (let at = 0; at < data.length; at += 512) {
        const block = data.subarray(at, at + 512), frame = Buffer.alloc(4 + block.length * 4);
        frame.writeUInt32LE(block.length, 0);
        block.forEach((v, i) => frame.writeFloatLE(v, 4 + i * 4));
        socket.write(frame);
      }
    });
    socket.on("error", () => {});
    return null;
  };
}

test("the bridge: why it cannot run, which processes it taps, the macOS version from Darwin", () => {
  const options = { onFeatures: () => {}, onStatus: () => {} };
  assert.equal(new NativeAudioBridge({ ...options, isMac: false }).unavailable(), "not-macos");
  assert.equal(new NativeAudioBridge({ ...options, isMac: true, macosVersion: 14.1, locate: () => "x" }).unavailable(), "macos-too-old");
  assert.equal(new NativeAudioBridge({ ...options, isMac: true, macosVersion: 15, locate: () => null }).unavailable(), "not-installed");
  assert.equal(new NativeAudioBridge({ ...options, isMac: true, macosVersion: 15, locate: () => "x" }).unavailable(), null);
  // v0.4.3: --follow (wait for the app's audio processes; end when they change, so the hub reconnects).
  assert.deepEqual(bridgeArgs({ source: "codex" }), ["--bundle", "com.openai.codex", "--follow"]);
  assert.deepEqual(bridgeArgs({ source: "system" }), ["--system", "--follow"]);
  assert.deepEqual(bridgeArgs({ source: "system", app: "Spotify" }), ["--name", "Spotify", "--follow"]);
  assert.deepEqual(bridgeArgs({ source: "system", app: "com.spotify.client" }), ["--bundle", "com.spotify.client", "--follow"]);
  assert.equal(macosFromDarwin("25.6.0"), 16.6);
  assert.equal(macosFromDarwin("23.2.0"), 14.2);
});

test("the bridge: samples over its private socket become features (only features); a wrong nonce or silence is told apart", async () => {
  const frames: { source: string; level: number; bass: number }[] = [];
  const statuses: string[] = [];
  const bridge = new NativeAudioBridge({
    isMac: true, macosVersion: 15, locate: () => "stand-in", launch: fakeApp(sine(110, 1.5, 0.4)),
    onFeatures: (source, f) => frames.push({ source, level: f.level, bass: f.bass }), onStatus: s => statuses.push(s.state),
  });
  const status = await bridge.start({ source: "codex" });
  assert.equal(status.state, "streaming");
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(frames.length > 20 && frames.every(f => f.source === "codex"));
  assert.ok(frames.some(f => f.level > 0.3 && f.bass > 0.3), "a 110 Hz tone reads as bass");
  bridge.stop();
  assert.equal(bridge.status.state, "off");
  assert.deepEqual(statuses.slice(0, 2), ["starting", "streaming"]);

  const impostor = new NativeAudioBridge({ isMac: true, macosVersion: 15, locate: () => "x", launch: fakeApp(sine(110, 0.2), { nonce: () => "0".repeat(32) }), onFeatures: () => {}, onStatus: () => {}, connectTimeout: 2 });
  const refused = await impostor.start({ source: "codex" });
  assert.equal(refused.state, "failed"); assert.equal(refused.reason, "handshake");

  const withheld = new NativeAudioBridge({ isMac: true, macosVersion: 15, locate: () => "x", launch: fakeApp(new Float32Array(48_000 * 4)), onFeatures: () => {}, onStatus: () => {} });
  await withheld.start({ source: "system" });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(withheld.status.silentCapture, true, "all-zero samples: macOS has not granted the permission");
  withheld.stop();

  const missing = new NativeAudioBridge({ isMac: true, macosVersion: 15, locate: () => null, onFeatures: () => {}, onStatus: () => {} });
  assert.deepEqual(await missing.start({ source: "codex" }), { state: "unavailable", source: "codex", reason: "not-installed" });
});

test("the hub: sound settings are remembered (never the sources), captures start only when asked, features stream as events", async () => {
  const home = tempHome();
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE, bridge: { isMac: true, macosVersion: 15, locate: () => "stand-in", launch: fakeApp(sine(330, 3, 0.4)) } });
  await hub.start();
  try {
    assert.equal(hub.snapshot().audio.bridge.state, "off", "nothing is captured until the user asks");
    hub.apply({ type: "audio", settings: { intensity: "expressive", mode: "spectrum", source: "system" } });
    const saved = JSON.parse(readFileSync(join(home, "audio.json"), "utf8"));
    assert.deepEqual(saved, { enabled: true, mode: "spectrum", intensity: "expressive", sensitivity: 0.5 }, "the source is not remembered");
    assert.equal(loadAudioSettings(home).source, "auto");
    // A companion window's event stream receives audio events once capture streams.
    const url = new URL(`events?token=${hub.surfaceUrl.split("token=")[1]}&window=abcdefgh12`, hub.url);
    const response = await fetch(url);
    const reader = response.body!.getReader();
    hub.apply({ type: "audio", capture: { source: "system", app: "Music" } });
    let text = "";
    const deadline = Date.now() + 4_000;
    while (!/event: audio/.test(text) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: audio\ndata: \{"s":"system"/);
    assert.equal(hub.snapshot().audio.bridge.state, "streaming");
    hub.apply({ type: "audio", stop: ["system"] });
    assert.equal(hub.snapshot().audio.bridge.state, "off");
    await reader.cancel();
    // Commands are validated whoever sends them.
    assert.equal(hubCommandSchema.safeParse({ type: "play", events: [{ index: 0, midi: 200, start: 0, length: 1 }], tempo: 80, volume: 1 }).success, false);
    assert.equal(hubCommandSchema.safeParse({ type: "play", events: [{ index: 0, midi: 60, start: 0, length: 1 }], tempo: 80, volume: 1 }).success, true);
    assert.equal(hubCommandSchema.safeParse({ type: "audio", capture: { source: "system", app: "rm -rf /" } }).success, false, "an app is a name, never a command");
    assert.equal(hubCommandSchema.safeParse({ type: "present", content: { kind: "music", title: "x", score: { clef: "treble", notes: [{ pitch: "Z9", duration: "quarter" }] } } }).success, false);
  } finally { await hub.stop(); }
});

test("MCP: show_music, play_music, music_lesson and set_audio_visualizer — exact facts, honest status", async () => {
  const aion = await connectAion();
  type Out = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
  const call = async (name: string, args: Record<string, unknown> = {}) => await aion.call(name, args) as Out;
  try {
    let out = await call("show_music", { title: "Middle C", notes: [{ pitch: "C4", duration: "whole" }], highlight: [{ note: 0 }] });
    assert.ok(!out.isError);
    const music = out.structuredContent!.music as { notes: { pitch: string; where: string; frequency: number }[] };
    assert.deepEqual([music.notes[0].pitch, music.notes[0].where, music.notes[0].frequency], ["C4", "the first ledger line below the staff", 261.63]);
    assert.equal((out.structuredContent!.presentation as { route: string }).route, "card");
    out = await call("show_music", { notes: [{ pitch: "C5", duration: "half", dotted: true }, { pitch: "C5", duration: "half" }], time: "4/4" });
    assert.ok(out.isError && /crosses a bar line/.test(out.content[0].text));
    out = await call("show_music", { scale: { tonic: "C4" }, symbol: "music.treble-clef" });
    assert.equal((out.structuredContent!.presentation as { route: string }).route, "hybrid", "with a symbol the body forms it beside the notation");
    out = await call("play_music", {});
    assert.equal((out.structuredContent!.music as { playback: string }).playback, "no-window", "nothing sounds without Aion open, and it says so");
    await call("clear_presentation");
    out = await call("play_music", {});
    assert.ok(out.isError && /no-music/.test(out.content[0].text));
    out = await call("music_lesson", { lesson: 3, language: "zh" });
    const lesson = (out.structuredContent!.music as { lesson: { id: number; step: number; title: string; text: string } }).lesson;
    assert.deepEqual([lesson.id, lesson.step, lesson.title], [3, 1, "音名与音高"]);
    assert.match(lesson.text, /五条线/);
    out = await call("music_lesson", { language: "en" });
    assert.equal((out.structuredContent!.music as { lesson: { step: number; title: string } }).lesson.step, 1, "switching language keeps the step");
    out = await call("music_lesson", {});
    assert.equal((out.structuredContent!.music as { lesson: { step: number } }).lesson.step, 2);
    // v0.4.3: asking for Codex's voice turns Codex Voice Sync on (remembered); with the bridge unavailable the result says so.
    out = await call("set_audio_visualizer", { source: "codex" });
    const audio = out.structuredContent!.audio as Record<string, string>;
    assert.match(audio.voice_sync, /^on/, "the choice is remembered");
    assert.match(out.content[0].text, /Not connected: the Aion Audio Bridge is not installed/, "the bridge is not available in tests, and the result says so");
    assert.doesNotMatch(out.content[0].text, /now captured/);
    out = await call("set_audio_visualizer", { mode: "spectrum", intensity: "subtle" });
    assert.deepEqual([(out.structuredContent!.audio as Record<string, string>).mode, (out.structuredContent!.audio as Record<string, string>).intensity], ["spectrum", "subtle"]);
  } finally { await aion.close(); }
});

test("privacy: tab audio is asked for in one file and only analysed; playback is the only sound; the bridge keeps no audio", () => {
  const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
  const capture = read("src/surface/capture.ts");
  for (const pattern of [/\bfetch\b/, /WebSocket/, /EventSource/, /sendBeacon/, /postMessage/, /localStorage/, /indexedDB/, /\.destination\b/, /MediaRecorder/]) assert.doesNotMatch(capture, pattern);
  assert.match(capture, /\.connect\(analyser\); \/\/ Analysed only; never played\./);
  const player = read("src/surface/music/player.ts");
  assert.match(player, /connect\(context\.destination\)/, "the Music Library's notes are the only thing the page plays");
  for (const pattern of [/getUserMedia/, /getDisplayMedia/, /createMediaStreamSource/]) assert.doesNotMatch(player, pattern, "and it plays only what it synthesises");
  const bridge = read("src/host/audio/bridge.ts");
  for (const pattern of [/writeFile/, /createWriteStream/, /appendFile/, /\bfetch\b/, /https?:\/\//]) assert.doesNotMatch(bridge, pattern, `the bridge never ${pattern}`);
  const swift = read("native/audio-bridge/AionAudioBridge.swift");
  for (const pattern of [/FileHandle\(forWritingAtPath/, /\.write\(to:/, /URLSession/, /AVAudioRecorder/, /ExtAudioFileCreate/]) assert.doesNotMatch(swift, pattern, `the app never ${pattern}`);
  assert.match(swift, /AF_UNIX/, "it talks only over a local Unix socket");
  assert.ok(existsSync(join(import.meta.dirname, "..", "native/audio-bridge/Info.plist")));
  assert.match(read("native/audio-bridge/Info.plist"), /Nothing is recorded, stored, sent or transcribed/);
});
