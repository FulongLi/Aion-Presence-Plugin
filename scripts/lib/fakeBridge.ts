import { readFileSync } from "node:fs";
import { connect } from "node:net";

/**
 * A stand-in for the macOS Aion Audio Bridge app in the smoke test: it speaks the bridge's protocol (handshake, then
 * frames of mono Float32 samples, keep-alives) over the hub's socket, in real time, so everything after the Core Audio
 * tap — the socket, the hub's analyser, the event stream, the surface, the policy and the renderer — runs for real.
 * Only the capture is simulated. Signals (AION_FAKE_SIGNAL): music (a beat, a bass line, chords and hi-hats),
 * bass (a bass-heavy groove), treble (bright, high parts only), speech (phrases of voiced syllables), silence, or a WAV file
 * (file:/path.wav). Usage (as the hub launches the app): fakeBridge.ts stream --socket PATH --nonce HEX ...
 */
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const socketPath = option("--socket"), nonce = option("--nonce");
if (args[0] !== "stream" || !socketPath || !nonce) { console.error("usage: fakeBridge.ts stream --socket PATH --nonce HEX"); process.exit(2); }
const RATE = 48_000, BLOCK = 512;
const signal = process.env.AION_FAKE_SIGNAL ?? "music";
const seconds = Number(process.env.AION_FAKE_SECONDS ?? 60);

let seed = 11;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** One sample at time t of the chosen signal (full scale ±1, mixed to about −12 dBFS). */
function sample(t: number): number {
  const beat = 60 / 120, bar = beat * 4;
  const inBeat = t % beat, inHalf = t % (beat / 2), barIndex = Math.floor(t / bar);
  const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-inBeat * 30)) * inBeat) * Math.exp(-inBeat * 9);
  const hat = noise() * Math.exp(-inHalf * 60);
  const roots = [45, 41, 43, 38];
  const bassNote = midiHz(roots[barIndex % 4] - 12);
  const bassLine = Math.sin(2 * Math.PI * bassNote * t) * 0.8 + Math.sin(2 * Math.PI * bassNote * 2 * t) * 0.3;
  const chord = [0, 4, 7, 12].reduce((sum, interval) => sum + Math.sin(2 * Math.PI * midiHz(roots[barIndex % 4] + 12 + interval) * t), 0) / 4;
  const sparkle = Math.sin(2 * Math.PI * midiHz(84 + (Math.floor(t / (beat / 2)) % 5) * 2) * t) * Math.exp(-inHalf * 8);
  switch (signal) {
    case "silence": return noise() * 0.0002;
    case "bass": return (kick * 0.9 + bassLine * 0.7) * 0.32;
    case "treble": return (hat * 0.7 + sparkle * 0.6 + Math.sin(2 * Math.PI * 5200 * t) * 0.1 * Math.exp(-inBeat * 6)) * 0.3;
    case "speech": {
      const phrase = 1.6, gap = 0.4, local = t % (phrase + gap), k = Math.floor(t / (phrase + gap));
      if (local >= phrase) return noise() * 0.0005;
      const syllable = Math.max(0, Math.sin(Math.PI * 2 * (4.6 + (k % 3) * 0.4) * local)) ** 1.5;
      const pitch = 140 + 30 * Math.sin(local * 3 + k);
      let voiced = 0;
      for (let h = 1; h <= 8; h++) voiced += Math.sin(Math.PI * 2 * pitch * h * t) / h;
      return (voiced * 0.22 + noise() * 0.03) * syllable * Math.min(1, local * 8, (phrase - local) * 8);
    }
    default: return (kick * 0.55 + hat * 0.12 + bassLine * 0.35 + chord * 0.3 + sparkle * 0.12) * 0.42;
  }
}

let file: Float32Array | null = null;
if (signal.startsWith("file:")) {
  const data = readFileSync(signal.slice(5));
  const frames = (data.length - 44) / 2;
  file = new Float32Array(frames);
  for (let i = 0; i < frames; i++) file[i] = data.readInt16LE(44 + i * 2) / 32768;
}

const socket = connect(socketPath, () => {
  socket.write(`AION-PCM1 ${nonce} ${RATE}\n`);
  let written = 0;
  const start = performance.now();
  const timer = setInterval(() => {
    const due = Math.floor((performance.now() - start) / 1000 * RATE);
    if (written / RATE > seconds) { clearInterval(timer); socket.end(); return; }
    while (written + BLOCK <= due) {
      const frame = Buffer.alloc(4 + BLOCK * 4);
      frame.writeUInt32LE(BLOCK, 0);
      for (let i = 0; i < BLOCK; i++) frame.writeFloatLE(file ? file[(written + i) % file.length] : sample((written + i) / RATE), 4 + i * 4);
      socket.write(frame);
      written += BLOCK;
    }
  }, 10);
  socket.on("close", () => { clearInterval(timer); process.exit(0); });
});
socket.on("error", () => process.exit(1));
