/**
 * The resource pack container (v0.4.4): many small records keyed by Unicode code point, compressed in blocks so that
 * one record is read without touching the rest. Pure: compression is passed in (Node's brotli in the host and the build
 * script), so the same code writes, reads and tests the format.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ notice (UTF-8 text, readable with `head`)     │  what the file is, where it came from, how and when it was changed
 *   │ 0x00                                          │
 *   │ "AHPK" · u16 version · u16 kind               │  header (little-endian)
 *   │ u32 count · u32 blockSize · u32 blockCount    │
 *   │ u32 codepoints[count]   (ascending)           │  index
 *   │ u32 blockOffsets[blockCount + 1]              │  relative to the start of the data
 *   │ data: compressed blocks                       │  each block: records as (varint length, bytes)
 *   └──────────────────────────────────────────────┘
 *
 * Record i lives in block ⌊i / blockSize⌋ at position i mod blockSize.
 */
export const PACK_MAGIC = "AHPK";
export const PACK_VERSION = 1;
/** What the records hold. */
export const PACK_KINDS = { strokes: 1, dictionary: 2 } as const;
export type PackKind = keyof typeof PACK_KINDS;

export interface PackHeader {
  /** Byte offset of the binary header (just after the notice and its NUL). */
  start: number;
  version: number;
  kind: number;
  count: number;
  blockSize: number;
  blockCount: number;
  /** Byte offsets of the index and of the block table, and where the data begins. */
  indexOffset: number;
  tableOffset: number;
  dataOffset: number;
}

const HEADER_BYTES = 4 + 2 + 2 + 4 + 4 + 4;

/** Writes a varint (unsigned LEB128). */
export function pushVarint(out: number[], value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("pack-varint-invalid");
  while (value > 127) { out.push((value % 128) | 128); value = Math.floor(value / 128); }
  out.push(value);
}

/** Reads a varint at `at`; returns the value and the next position. */
export function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0, scale = 1;
  for (let i = 0; i < 8; i++) {
    if (at >= bytes.length) throw new Error("pack-truncated");
    const byte = bytes[at++];
    value += (byte & 127) * scale;
    if (byte < 128) return [value, at];
    scale *= 128;
  }
  throw new Error("pack-varint-invalid");
}

/** Joins records into one block: each as (varint length, bytes). */
export function joinRecords(records: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const record of records) {
    const prefix: number[] = [];
    pushVarint(prefix, record.length);
    parts.push(Uint8Array.from(prefix), record);
    size += prefix.length + record.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** The record at `position` inside a decompressed block. */
export function recordInBlock(block: Uint8Array, position: number): Uint8Array {
  let at = 0;
  for (let i = 0; ; i++) {
    const [length, next] = readVarint(block, at);
    if (next + length > block.length) throw new Error("pack-truncated");
    if (i === position) return block.subarray(next, next + length);
    at = next + length;
  }
}

/** Builds a whole pack file. `records` must be sorted by code point, without duplicates. */
export function writePack(options: {
  notice: string; kind: PackKind; blockSize: number; records: readonly { codepoint: number; data: Uint8Array }[]; compress: (block: Uint8Array) => Uint8Array;
}): Uint8Array {
  const { records, blockSize } = options;
  if (options.notice.includes("\u0000")) throw new Error("pack-notice-invalid");
  if (!(blockSize >= 1 && blockSize <= 4096)) throw new Error("pack-block-size-invalid");
  for (let i = 1; i < records.length; i++) if (records[i].codepoint <= records[i - 1].codepoint) throw new Error("pack-order-invalid");
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < records.length; i += blockSize) blocks.push(options.compress(joinRecords(records.slice(i, i + blockSize).map(record => record.data))));
  const notice = new TextEncoder().encode(options.notice);
  const headerSize = HEADER_BYTES + records.length * 4 + (blocks.length + 1) * 4;
  const dataSize = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(notice.length + 1 + headerSize + dataSize);
  const view = new DataView(out.buffer);
  out.set(notice, 0);
  out[notice.length] = 0;
  let at = notice.length + 1;
  for (const char of PACK_MAGIC) out[at++] = char.charCodeAt(0);
  view.setUint16(at, PACK_VERSION, true); at += 2;
  view.setUint16(at, PACK_KINDS[options.kind], true); at += 2;
  view.setUint32(at, records.length, true); at += 4;
  view.setUint32(at, blockSize, true); at += 4;
  view.setUint32(at, blocks.length, true); at += 4;
  for (const record of records) { view.setUint32(at, record.codepoint, true); at += 4; }
  let offset = 0;
  for (const block of blocks) { view.setUint32(at, offset, true); at += 4; offset += block.length; }
  view.setUint32(at, offset, true); at += 4;
  for (const block of blocks) { out.set(block, at); at += block.length; }
  return out;
}

/** Parses the header from the first bytes of a pack (the notice plus at least the fixed header). */
export function readPackHeader(head: Uint8Array): PackHeader {
  const nul = head.indexOf(0);
  if (nul < 0 || nul + 1 + HEADER_BYTES > head.length) throw new Error("pack-truncated");
  const start = nul + 1;
  const magic = String.fromCharCode(...head.subarray(start, start + 4));
  if (magic !== PACK_MAGIC) throw new Error("pack-magic-invalid");
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const version = view.getUint16(start + 4, true), kind = view.getUint16(start + 6, true);
  if (version !== PACK_VERSION) throw new Error("pack-version-unsupported");
  const count = view.getUint32(start + 8, true), blockSize = view.getUint32(start + 12, true), blockCount = view.getUint32(start + 16, true);
  if (blockSize < 1 || blockCount !== Math.ceil(count / blockSize)) throw new Error("pack-header-invalid");
  const indexOffset = start + HEADER_BYTES, tableOffset = indexOffset + count * 4, dataOffset = tableOffset + (blockCount + 1) * 4;
  return { start, version, kind, count, blockSize, blockCount, indexOffset, tableOffset, dataOffset };
}

/** The notice at the top of a pack. */
export function readPackNotice(head: Uint8Array): string {
  const nul = head.indexOf(0);
  return new TextDecoder().decode(head.subarray(0, nul < 0 ? head.length : nul));
}

/** Index arrays from the bytes of the index and the block table (read once, kept small: 4 bytes a record). */
export function readPackIndex(header: PackHeader, bytes: Uint8Array): { codepoints: Uint32Array; offsets: Uint32Array } {
  const need = (header.count + header.blockCount + 1) * 4;
  if (bytes.length < need) throw new Error("pack-truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, need);
  const codepoints = new Uint32Array(header.count), offsets = new Uint32Array(header.blockCount + 1);
  for (let i = 0; i < header.count; i++) codepoints[i] = view.getUint32(i * 4, true);
  for (let i = 0; i <= header.blockCount; i++) offsets[i] = view.getUint32(header.count * 4 + i * 4, true);
  for (let i = 1; i < codepoints.length; i++) if (codepoints[i] <= codepoints[i - 1]) throw new Error("pack-order-invalid");
  for (let i = 1; i < offsets.length; i++) if (offsets[i] < offsets[i - 1]) throw new Error("pack-table-invalid");
  return { codepoints, offsets };
}

/** Binary search for a code point; −1 when absent. */
export function findCodepoint(codepoints: Uint32Array, codepoint: number): number {
  let low = 0, high = codepoints.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1, value = codepoints[mid];
    if (value === codepoint) return mid;
    if (value < codepoint) low = mid + 1; else high = mid - 1;
  }
  return -1;
}
