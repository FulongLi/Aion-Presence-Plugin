import { pushVarint, readVarint } from "../pack/container";

/**
 * Hanzi Writer character data (v0.4.4), and its compact, lossless binary form inside the Chinese Writing Pack.
 *
 * Upstream (hanzi-writer-data, derived from Make Me a Hanzi; Arphic Public License) stores one JSON file per character:
 *   strokes     each stroke's filled outline as an SVG path ("M x y Q … L … C … Z") in a 1024-unit em box, y up
 *   medians     each stroke's centre line, in writing order and direction, as [x, y] points
 *   radStrokes  (optional) the strokes that form the character's radical, 0-based
 *
 * The pack keeps exactly this information. Numbers are stored in half units (two values in the whole set are x.5),
 * as zigzag varint deltas, and path commands as 4-bit codes. `canonicalJson` writes the upstream file text back
 * byte for byte; the build script checks that for every character, and a character whose file is not in that
 * canonical form is stored verbatim instead (record format 1) — so the pack is a format conversion, never an edit.
 */
export interface HanziData {
  strokes: string[];
  medians: [number, number][][];
  radStrokes?: number[];
}

export const RECORD_FORMATS = { binary: 0, json: 1 } as const;

const OPS = ["M", "L", "Q", "C", "Z"] as const;
type Op = typeof OPS[number];
const ARITY: Record<Op, number> = { M: 1, L: 1, Q: 2, C: 3, Z: 0 };

/** A number from half units, written as the upstream JSON writes it (521.5, -3, 0). */
export function formatHalf(half: number): string {
  if (half % 2 === 0) return String(half / 2);
  const sign = half < 0 ? "-" : "";
  return `${sign}${Math.floor(Math.abs(half) / 2)}.5`;
}

function toHalf(value: number): number {
  const half = value * 2;
  if (!Number.isInteger(half) || Math.abs(half) > 1e7) throw new Error("hanzi-number-invalid");
  return half;
}

const zig = (n: number) => n < 0 ? -2 * n - 1 : 2 * n;
const unzig = (n: number) => n % 2 ? -(n + 1) / 2 : n / 2;

/** Tokens of a stroke path: commands and numbers, separated by single spaces (the upstream form). */
export function parsePathTokens(path: string): { ops: Op[]; numbers: number[] } {
  const tokens = path.split(" ");
  const ops: Op[] = [], numbers: number[] = [];
  for (let i = 0; i < tokens.length;) {
    const op = tokens[i++] as Op;
    if (!OPS.includes(op)) throw new Error("hanzi-path-invalid");
    ops.push(op);
    for (let k = 0; k < ARITY[op] * 2; k++) {
      const token = tokens[i++];
      if (token === undefined || !/^-?\d+(?:\.\d+)?$/.test(token)) throw new Error("hanzi-path-invalid");
      numbers.push(Number(token));
    }
  }
  if (ops[0] !== "M") throw new Error("hanzi-path-invalid");
  return { ops, numbers };
}

/** The upstream file text for a character's data (Python's json.dumps layout: ", " and ": "). */
export function canonicalJson(data: HanziData): string {
  const strokes = data.strokes.map(path => JSON.stringify(path)).join(", ");
  const medians = data.medians.map(points => `[${points.map(([x, y]) => `[${formatHalf(toHalf(x))}, ${formatHalf(toHalf(y))}]`).join(", ")}]`).join(", ");
  const rad = data.radStrokes ? `, "radStrokes": [${data.radStrokes.join(", ")}]` : "";
  return `{"strokes": [${strokes}], "medians": [${medians}]${rad}}`;
}

/** A path rebuilt from its tokens, in the upstream spelling. */
function writePath(ops: readonly Op[], halves: readonly number[]): string {
  const parts: string[] = [];
  let k = 0;
  for (const op of ops) {
    parts.push(op);
    for (let i = 0; i < ARITY[op] * 2; i++) parts.push(formatHalf(halves[k++]));
  }
  return parts.join(" ");
}

/** Checks the shape of parsed upstream data (counts agree, every number finite); throws "hanzi-data-invalid". */
export function checkHanziData(value: unknown): HanziData {
  const fail = (): never => { throw new Error("hanzi-data-invalid"); };
  if (!value || typeof value !== "object") fail();
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (!keys.every(key => key === "strokes" || key === "medians" || key === "radStrokes")) fail();
  if (!Array.isArray(data.strokes) || !Array.isArray(data.medians) || !data.strokes.length || data.strokes.length !== data.medians.length) fail();
  const strokes = data.strokes as unknown[], medians = data.medians as unknown[];
  if (!strokes.every(path => typeof path === "string" && path.length > 0 && path.length < 20_000)) fail();
  if (!medians.every(points => Array.isArray(points) && points.length >= 1 && points.every(point => Array.isArray(point) && point.length === 2 && point.every(v => typeof v === "number" && Number.isFinite(v))))) fail();
  if (data.radStrokes !== undefined && !(Array.isArray(data.radStrokes) && data.radStrokes.every(k => Number.isInteger(k) && k >= 0 && k < strokes.length))) fail();
  return value as HanziData;
}

/**
 * Encodes one character's upstream file text. Returns the binary record when the text is exactly the canonical form of
 * its data (so decoding gives the same bytes back); otherwise a verbatim record.
 */
export function encodeHanzi(text: string): { record: Uint8Array; format: "binary" | "json" } {
  const data = checkHanziData(JSON.parse(text));
  let binary: Uint8Array | null = null;
  try { if (canonicalJson(data) === text) binary = encodeBinary(data); } catch { binary = null; }
  if (binary && decodeHanzi(binary).text === text) return { record: binary, format: "binary" };
  const utf8 = new TextEncoder().encode(text);
  const record = new Uint8Array(utf8.length + 1);
  record[0] = RECORD_FORMATS.json;
  record.set(utf8, 1);
  return { record, format: "json" };
}

function encodeBinary(data: HanziData): Uint8Array {
  const out: number[] = [RECORD_FORMATS.binary];
  pushVarint(out, data.strokes.length);
  for (const path of data.strokes) {
    const { ops, numbers } = parsePathTokens(path);
    pushVarint(out, ops.length);
    for (let i = 0; i < ops.length; i += 2) out.push(OPS.indexOf(ops[i]) | ((i + 1 < ops.length ? OPS.indexOf(ops[i + 1]) : 0) << 4));
    let px = 0, py = 0;
    for (let i = 0; i < numbers.length; i += 2) {
      const x = toHalf(numbers[i]), y = toHalf(numbers[i + 1]);
      pushVarint(out, zig(x - px)); pushVarint(out, zig(y - py));
      px = x; py = y;
    }
  }
  for (const points of data.medians) {
    pushVarint(out, points.length);
    let px = 0, py = 0;
    for (const [vx, vy] of points) {
      const x = toHalf(vx), y = toHalf(vy);
      pushVarint(out, zig(x - px)); pushVarint(out, zig(y - py));
      px = x; py = y;
    }
  }
  if (data.radStrokes) { pushVarint(out, data.radStrokes.length + 1); for (const k of data.radStrokes) pushVarint(out, k); } else pushVarint(out, 0);
  return Uint8Array.from(out);
}

/** Decodes a record: the character's data and its upstream file text. */
export function decodeHanzi(record: Uint8Array): { data: HanziData; text: string } {
  if (!record.length) throw new Error("hanzi-record-invalid");
  if (record[0] === RECORD_FORMATS.json) {
    const text = new TextDecoder().decode(record.subarray(1));
    return { data: checkHanziData(JSON.parse(text)), text };
  }
  if (record[0] !== RECORD_FORMATS.binary) throw new Error("hanzi-record-invalid");
  let at = 1;
  const next = () => { const [value, after] = readVarint(record, at); at = after; return value; };
  const count = next();
  if (count < 1 || count > 64) throw new Error("hanzi-record-invalid");
  const strokes: string[] = [];
  for (let s = 0; s < count; s++) {
    const opCount = next();
    const ops: Op[] = [];
    for (let i = 0; i < opCount; i += 2) {
      const byte = record[at++];
      ops.push(OPS[byte & 15]);
      if (i + 1 < opCount) ops.push(OPS[byte >> 4]);
    }
    if (ops.some(op => op === undefined)) throw new Error("hanzi-record-invalid");
    const halves: number[] = [];
    let px = 0, py = 0;
    const pairs = ops.reduce((sum, op) => sum + ARITY[op], 0);
    for (let i = 0; i < pairs; i++) { px += unzig(next()); py += unzig(next()); halves.push(px, py); }
    strokes.push(writePath(ops, halves));
  }
  const medians: [number, number][][] = [];
  for (let s = 0; s < count; s++) {
    const n = next();
    const points: [number, number][] = [];
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) { px += unzig(next()); py += unzig(next()); points.push([px / 2, py / 2]); }
    medians.push(points);
  }
  const rad = next();
  const data: HanziData = { strokes, medians, ...(rad ? { radStrokes: Array.from({ length: rad - 1 }, () => next()) } : {}) };
  if (at !== record.length) throw new Error("hanzi-record-invalid");
  return { data, text: canonicalJson(data) };
}
