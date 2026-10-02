import { writeFileSync } from "node:fs";

/**
 * A speech-like test signal for Chrome's fake capture device (--use-file-for-fake-audio-capture): a quiet room,
 * then phrases of syllables (voiced harmonics with a 4–6 Hz loudness envelope and a breath of noise) separated by
 * short pauses, then quiet again. No real voice and no recording: it exists so the real browser microphone path
 * (getUserMedia → MicrophoneListener → VAD → PresenceEngine) can be exercised end to end in CI.
 */
export function speechWav(path: string, options: { lead?: number; phrases?: number; tail?: number; rate?: number } = {}) {
  const rate = options.rate ?? 48_000, lead = options.lead ?? 2.5, tail = options.tail ?? 3;
  const phrases = options.phrases ?? 4;
  const phrase = 1.6, gap = 0.35;
  const seconds = lead + phrases * (phrase + gap) + tail;
  const n = Math.round(seconds * rate);
  const samples = new Int16Array(n);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let value = noise() * 0.0015; // the room
    const inSpeech = t - lead;
    const k = Math.floor(inSpeech / (phrase + gap)), local = inSpeech - k * (phrase + gap);
    if (inSpeech >= 0 && k < phrases && local < phrase) {
      const syllable = Math.max(0, Math.sin(Math.PI * 2 * (4.6 + k * 0.4) * local)) ** 1.5;
      const pitch = 120 + 25 * Math.sin(local * 3 + k);
      let voiced = 0;
      for (let h = 1; h <= 6; h++) voiced += Math.sin(Math.PI * 2 * pitch * h * t) / h;
      value += (voiced * 0.12 + noise() * 0.02) * syllable * Math.min(1, local * 8, (phrase - local) * 8);
    }
    samples[i] = Math.max(-32767, Math.min(32767, Math.round(value * 32767)));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.byteLength, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]));
  return { seconds, speechStart: lead, speechEnd: lead + phrases * (phrase + gap) - gap };
}
