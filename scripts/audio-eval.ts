import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AudioAnalyzer, DIGITAL_SOURCE } from "../src/audio/analyzer";
import { MusicDetector } from "../src/audio/detector";

/**
 * Measures the music detector on real recordings on this Mac (macOS only): music from Apple Loops (real
 * instrument and production loops that ship with macOS/GarageBand), speech from the system voices (`say`, English
 * and Chinese), and speech over quiet music. Nothing is kept: the corpus is built in a temporary directory and
 * deleted. Every file runs through the same AudioAnalyzer and MusicDetector the surfaces use, at 60 frames a second.
 *
 *   npm run audio:eval            build the corpus, measure, print the table
 *   npm run audio:eval -- <dir>   measure WAV files in <dir> named music-*.wav / speech-*.wav / mixed-*.wav
 */
const SECONDS = 24;
const RATE = 48_000;

function readWav(path: string): Float32Array {
  const data = readFileSync(path);
  let at = 12, format = 0, channels = 1, bits = 16;
  while (at + 8 <= data.length) {
    const id = data.toString("ascii", at, at + 4), size = data.readUInt32LE(at + 4);
    if (id === "fmt ") { format = data.readUInt16LE(at + 8); channels = data.readUInt16LE(at + 10); bits = data.readUInt16LE(at + 22); }
    if (id === "data") {
      const frames = Math.floor(size / (bits / 8) / channels), out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const offset = at + 8 + (i * channels + c) * (bits / 8);
          sum += format === 3 ? data.readFloatLE(offset) : data.readInt16LE(offset) / 32768;
        }
        out[i] = sum / channels;
      }
      return out;
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

function convert(input: string, output: string) {
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", input, output]);
}

/** Repeats a (short) recording until it lasts `SECONDS`. */
const loop = (samples: Float32Array) => {
  const out = new Float32Array(SECONDS * RATE);
  for (let i = 0; i < out.length; i++) out[i] = samples[i % samples.length];
  return out;
};

function buildCorpus(dir: string): Map<string, Float32Array> {
  const corpus = new Map<string, Float32Array>();
  const root = "/Library/Audio/Apple Loops/Apple";
  const decode = (file: string) => { const out = join(dir, "loop.wav"); convert(join(root, file), out); return readWav(out); };
  if (existsSync(root)) {
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".caf")).sort();
    const effects = files.filter(file => file.startsWith("Final Cut Pro Sound Effects"));
    const instruments = files.filter(file => !file.startsWith("Final Cut Pro Sound Effects"));
    // Single loops, a spread across the library: beats, keys, pads, guitars, basses, vocals.
    const step = Math.max(1, Math.floor(instruments.length / 24));
    for (let i = 0; i < instruments.length && [...corpus.keys()].filter(k => k.startsWith("music")).length < 24; i += step) {
      try { corpus.set(`music · ${basename(instruments[i], ".caf")}`, loop(decode(instruments[i]))); } catch { /* unreadable loop */ }
    }
    // Layered tracks, as Apple Loops are meant to be used: a beat, a bass and a melodic part from one genre pack (same tempo).
    const packs = [...new Set(instruments.map(file => file.split("/")[0]).filter(pack => /^\d\d /.test(pack)))];
    for (const pack of packs) {
      const inPack = instruments.filter(file => file.startsWith(`${pack}/`));
      const pick = (pattern: RegExp, skip = 0) => inPack.filter(file => pattern.test(basename(file)))[skip];
      for (const skip of [0, 2]) {
        const parts = [pick(/Beat|Break|Drum/i, skip), pick(/Bass/i, skip), pick(/Piano|Synth|Keys|Pad|Guitar|Organ|Lead|Strings|Horn/i, skip)].filter(Boolean) as string[];
        if (parts.length < 3) continue;
        try {
          const layers = parts.map(part => loop(decode(part)));
          const mix = new Float32Array(layers[0].length);
          for (const layer of layers) for (let k = 0; k < mix.length; k++) mix[k] += layer[k] * 0.45;
          corpus.set(`track · ${pack.slice(3)}: ${parts.map(part => basename(part, ".caf")).join(" + ")}`, mix);
        } catch { /* unreadable loop */ }
      }
    }
    const fx = Math.max(1, Math.floor(effects.length / 8));
    for (let i = 0; i < effects.length && [...corpus.keys()].filter(k => k.startsWith("effect")).length < 8; i += fx) {
      try { corpus.set(`effect · ${basename(effects[i], ".caf")}`, loop(decode(effects[i]))); } catch { /* unreadable */ }
    }
  }
  const text = {
    en: "Good morning. I wanted to tell you about the walk I took yesterday, down by the river. It was cold, but the light was beautiful, and for a while I just stood there, listening. Then a dog ran past, chasing a ball, and I laughed. Anyway, I think we should meet again next week, maybe on Tuesday, if that works for you.",
    zh: "早上好。我想跟你说说昨天在河边散步的事。天气很冷，但是光线很美，我在那里站了一会儿，只是静静地听着。后来一只小狗追着球跑过去，我笑了。总之，我觉得我们下周可以再见一次面，也许星期二，如果你方便的话。",
  };
  const voices = execFileSync("say", ["-v", "?"], { encoding: "utf8" }).split("\n")
    .map(line => /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .filter(m => m[2].startsWith("en_") || m[2] === "zh_CN").map(m => ({ name: m[1].trim(), lang: m[2].startsWith("en_") ? "en" as const : "zh" as const }));
  const chosen = [...voices.filter(v => v.lang === "en").filter((_, i) => i % 3 === 0).slice(0, 10), ...voices.filter(v => v.lang === "zh").slice(0, 3)];
  for (const voice of chosen) {
    const aiff = join(dir, "speech.aiff"), out = join(dir, `speech-${corpus.size}.wav`);
    try {
      execFileSync("say", ["-v", voice.name, "-o", aiff, text[voice.lang]]);
      convert(aiff, out);
      corpus.set(`speech · ${voice.name} (${voice.lang})`, loop(readWav(out)));
    } catch { /* voice not installed */ }
  }
  // Speech over quiet music (a podcast bed, 18 dB down): it should stay speech.
  const music = [...corpus].filter(([name]) => name.startsWith("track"));
  const speech = [...corpus].filter(([name]) => name.startsWith("speech"));
  for (let i = 0; i < Math.min(8, speech.length); i++) {
    const [voiceName, voice] = speech[i], [musicName, bed] = music[(i * 7) % music.length];
    const mixed = new Float32Array(voice.length);
    for (let k = 0; k < mixed.length; k++) mixed[k] = voice[k] + bed[k] * 0.125;
    corpus.set(`mixed · ${voiceName.slice(9)} over ${musicName.slice(8, 60)}`, mixed);
  }
  return corpus;
}

function measure(samples: Float32Array) {
  // Shared music is a digital source (a tab, another app through the bridge): its analyser has the digital floor.
  const analyzer = new AudioAnalyzer(RATE, DIGITAL_SOURCE), detector = new MusicDetector();
  const hop = RATE / 60;
  let musicSeconds = 0, firstMusic = -1, flips = 0, last = false;
  const confidences: number[] = [];
  for (let at = 0, frame = 0; at + hop <= samples.length; at += hop, frame++) {
    analyzer.push(samples.subarray(at, at + hop));
    const features = analyzer.analyze(1 / 60);
    const music = detector.sample(features, 1 / 60);
    if (music !== last) { flips++; last = music; }
    if (music) { musicSeconds += 1 / 60; if (firstMusic < 0) firstMusic = frame / 60; }
    if (frame % 30 === 0 && frame > 60 * 6) confidences.push(detector.evidence.confidence);
  }
  const mean = confidences.reduce((a, b) => a + b, 0) / Math.max(1, confidences.length);
  return { share: musicSeconds / (samples.length / RATE), firstMusic, flips, mean, evidence: { ...detector.evidence } };
}

const given = process.argv[2];
const dir = given ?? mkdtempSync(join(tmpdir(), "aion-audio-eval-"));
try {
  if (!given) mkdirSync(dir, { recursive: true });
  const corpus = given
    ? new Map(readdirSync(dir).filter(file => file.endsWith(".wav")).map(file => [file.replace(/\.wav$/, "").replace(/^(\w+)-/, "$1 · "), readWav(join(dir, file))]))
    : buildCorpus(dir);
  const rows: { name: string; kind: string; result: ReturnType<typeof measure> }[] = [];
  for (const [name, samples] of corpus) rows.push({ name, kind: name.split(" · ")[0], result: measure(samples) });
  console.log("kind    music%  first(s)  flips  conf   dips  cont  pulse  breadth  voiced  sdips  name");
  for (const { name, kind, result: r } of rows) {
    console.log(`${kind.padEnd(7)} ${(r.share * 100).toFixed(0).padStart(5)}  ${(r.firstMusic < 0 ? "-" : r.firstMusic.toFixed(1)).padStart(8)}  ${String(r.flips).padStart(5)}  ${r.mean.toFixed(2)}  `
      + `${r.evidence.dips.toFixed(2)}  ${r.evidence.continuity.toFixed(2)}  ${r.evidence.periodicity.toFixed(2)}   ${r.evidence.breadth.toFixed(2)}    ${r.evidence.voiced.toFixed(2)}  ${r.evidence.speechDips.toFixed(2)}  ${name.slice(name.indexOf("·") + 2)}`);
  }
  const summary = (kind: string, music: boolean) => {
    const set = rows.filter(row => row.kind === kind);
    const hits = set.filter(row => (row.result.share > 0.25) === music).length;
    return `${kind}: ${hits}/${set.length} ${music ? "detected as music" : "never switched to music"}`;
  };
  console.log(`\n${summary("track", true)}\n${summary("music", true)}\n${summary("speech", false)}\n${summary("mixed", false)}\n${summary("effect", false)}`);
  const falseSwitches = rows.filter(row => (row.kind === "speech" || row.kind === "mixed") && row.result.firstMusic >= 0).length;
  console.log(`false switches on speech or speech over music: ${falseSwitches}`);
} finally {
  if (!given) rmSync(dir, { recursive: true, force: true });
}
