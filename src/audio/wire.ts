import { createFeatures, isAudioSource, type AudioFeatures, type AudioSourceKind } from "./features";

/**
 * The compact form features travel in from the hub to a surface (Codex's voice and other applications' sound are
 * analysed in the hub, next to the native bridge): about 120 bytes a frame, bands quantised to one byte each. Only
 * features: there is no field a sample could travel in.
 */
export interface WireFeatures {
  s: AudioSourceKind;
  t: number;
  /** level, rms (×1e4, rounded), bass, mid, treble, onset, beat, centroid, flatness, speech share — each ×1000, rounded */
  n: number[];
  /** bands, one byte each (0…255), base64 */
  b: string;
  /** voice, silent */
  v: 0 | 1;
  q: 0 | 1;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < bytes.length ? BASE64[c & 63] : "=");
  }
  return out;
};
const fromBase64 = (text: string, out: Float32Array) => {
  let bit = 0, value = 0, at = 0;
  for (const char of text) {
    if (char === "=") break;
    const index = BASE64.indexOf(char);
    if (index < 0) return false;
    value = (value << 6) | index; bit += 6;
    if (bit >= 8) { bit -= 8; if (at < out.length) out[at++] = ((value >> bit) & 255) / 255; }
  }
  return at === out.length;
};
const q = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 1000);

export const MAX_WIRE_BANDS = 64;

export function encodeFeatures(source: AudioSourceKind, f: AudioFeatures): WireFeatures {
  const bytes = new Uint8Array(f.bands.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, f.bands[i])) * 255);
  return {
    s: source, t: Math.round(f.t * 1000) / 1000,
    n: [q(f.level), Math.round(Math.min(1, f.rms) * 1e4), q(f.bass), q(f.mid), q(f.treble), q(f.onset), q(f.beat), q(f.centroid), q(f.flatness), q(f.speech)],
    b: toBase64(bytes), v: f.voice ? 1 : 0, q: f.silent ? 1 : 0,
  };
}

/** Decodes into `into` (reused frame to frame); null when the message is not a valid feature frame. */
export function decodeFeatures(message: unknown, into?: AudioFeatures): { source: AudioSourceKind; features: AudioFeatures } | null {
  const m = message as Partial<WireFeatures> | null;
  if (!m || typeof m !== "object" || !isAudioSource(m.s) || typeof m.t !== "number" || !Number.isFinite(m.t)) return null;
  if (!Array.isArray(m.n) || m.n.length !== 10 || !m.n.every(value => typeof value === "number" && Number.isFinite(value))) return null;
  if (typeof m.b !== "string" || m.b.length > Math.ceil(MAX_WIRE_BANDS / 3) * 4) return null;
  const count = Math.floor(m.b.replace(/=+$/, "").length * 6 / 8);
  if (count < 1) return null;
  const f = into && into.bands.length === count ? into : createFeatures(count);
  if (!fromBase64(m.b, f.bands)) return null;
  const n = m.n.map(value => Math.max(0, Math.min(1, value / 1000)));
  f.t = m.t; f.level = n[0]; f.rms = Math.max(0, Math.min(1, m.n[1] / 1e4));
  [f.bass, f.mid, f.treble, f.onset, f.beat, f.centroid, f.flatness, f.speech] = n.slice(2);
  f.voice = m.v === 1; f.silent = m.q === 1;
  return { source: m.s, features: f };
}
