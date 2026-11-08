import type { Raster } from "../types";

/**
 * A small, strict JPEG decoder for model textures (v0.9). The model converter runs in Node, where there is no canvas, and
 * a model's colours usually live in its textures, so Aion decodes them itself rather than depending on a library:
 * baseline and extended sequential (SOF0/SOF1) and progressive (SOF2) Huffman JPEGs, 8-bit, one (greyscale) or three
 * (YCbCr, or RGB when an Adobe marker says so) components, any chroma subsampling, restart intervals. Arithmetic coding,
 * lossless, 12-bit and CMYK files are refused ("jpeg-unsupported"), a malformed file is refused ("jpeg-invalid"); nothing
 * is guessed. Upsampling is nearest-neighbour: the result is sampled for particle colours, never displayed.
 */
export const JPEG_LIMITS = { side: 8192, pixels: 32 * 1024 * 1024, bytes: 32 * 1024 * 1024 };

export class JpegError extends Error {
  constructor(code: "jpeg-invalid" | "jpeg-unsupported", readonly detail: string) { super(code); this.name = "JpegError"; }
}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

interface Huffman { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array }
interface Component {
  id: number; h: number; v: number; tq: number;
  blocksPerLine: number; blocksPerColumn: number;
  /** Blocks per line and column padded to whole MCUs (the storage). */
  lineStride: number; columnStride: number;
  coefficients: Int32Array; pred: number; dc?: Huffman; ac?: Huffman;
}
interface Frame { width: number; height: number; components: Component[]; progressive: boolean; hmax: number; vmax: number; mcusPerLine: number; mcusPerColumn: number }

function invalid(detail: string): never { throw new JpegError("jpeg-invalid", detail); }
function unsupported(detail: string): never { throw new JpegError("jpeg-unsupported", detail); }

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1];
    valptr[length] = k; mincode[length] = code;
    code += n; k += n;
    maxcode[length] = n ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, values };
}

/** Bits of the entropy-coded segment, with byte stuffing undone; a marker ends the data (zeros are read past it). */
class BitReader {
  private bits = 0;
  private count = 0;
  marker = -1;
  constructor(private readonly data: Uint8Array, public offset: number) {}
  private fill() {
    while (this.count <= 24) {
      let byte = 0;
      if (this.marker < 0 && this.offset < this.data.length) {
        byte = this.data[this.offset];
        if (byte === 0xff) {
          const next = this.data[this.offset + 1];
          if (next === 0x00) this.offset += 2;
          else if (next === 0xff) { this.offset += 1; continue; }
          else { this.marker = next; byte = 0; }
        } else this.offset += 1;
      }
      this.bits |= byte << (24 - this.count);
      this.count += 8;
    }
  }
  bit(): number {
    if (this.count === 0) this.fill();
    const value = (this.bits >>> 31) & 1;
    this.bits <<= 1; this.count--;
    return value;
  }
  receive(length: number): number {
    let value = 0;
    for (let i = 0; i < length; i++) value = (value << 1) | this.bit();
    return value;
  }
  extend(length: number): number {
    if (length === 0) return 0;
    if (length > 16) invalid("A coefficient is longer than 16 bits.");
    const value = this.receive(length);
    return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
  }
  decode(table: Huffman | undefined): number {
    if (!table) invalid("A scan uses an undefined Huffman table.");
    let code = this.bit(), length = 1;
    while (code > table!.maxcode[length]) {
      code = (code << 1) | this.bit();
      if (++length > 16) invalid("An invalid Huffman code.");
    }
    return table!.values[table!.valptr[length] + code - table!.mincode[length]];
  }
  /** Skips to the byte after a restart marker (RSTn), discarding the bits left in the byte. */
  restart() {
    this.bits = 0; this.count = 0;
    if (this.marker < 0) {
      // No marker seen yet: look for it from the current position.
      while (this.offset + 1 < this.data.length && !(this.data[this.offset] === 0xff && this.data[this.offset + 1] >= 0xd0 && this.data[this.offset + 1] <= 0xd7)) this.offset++;
      if (this.offset + 1 >= this.data.length) invalid("A restart marker is missing.");
      this.offset += 2;
      return;
    }
    if (this.marker >= 0xd0 && this.marker <= 0xd7) { this.offset += 2; this.marker = -1; return; }
    invalid("A restart marker is missing.");
  }
}

/**
 * Separable float IDCT of one dequantized block (natural order), level-shifted and clamped, into n×n samples: n = 8 is the
 * full block; n = 4, 2, 1 is a scaled decode (the n-point IDCT of the lowest n×n coefficients, which keeps every level and
 * low frequency, as libjpeg's scaled decoding does) — a texture sampled for particle colours needs no more than ~1024 px.
 */
const COSINES = [1, 2, 4, 8].map(n => {
  const table = new Float32Array(n * n);
  for (let x = 0; x < n; x++) for (let u = 0; u < n; u++) table[x * n + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / (2 * n)) / 2;
  return table;
});
function idct(block: Float32Array, n: number, out: Uint8ClampedArray, outOffset: number, outStride: number, temp: Float32Array) {
  // A block with only its DC coefficient (common in smooth areas) is one level.
  let flat = true;
  for (let k = 1; k < 64 && flat; k++) if (block[k] !== 0 && (k % 8) < n && (k >> 3) < n) flat = false;
  if (flat) {
    const level = block[0] / 8 + 128;
    for (let y = 0; y < n; y++) out.fill(level, outOffset + y * outStride, outOffset + y * outStride + n);
    return;
  }
  const cos = COSINES[n === 8 ? 3 : n === 4 ? 2 : n === 2 ? 1 : 0];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let u = 0; u < n; u++) sum += cos[x * n + u] * block[y * 8 + u];
      temp[y * 8 + x] = sum;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let sum = 0;
      for (let v = 0; v < n; v++) sum += cos[y * n + v] * temp[v * 8 + x];
      out[outOffset + y * outStride + x] = sum + 128;
    }
  }
}

/** `maxSide`: decode at 1/2, 1/4 or 1/8 scale when the image is larger (the result is then that much smaller). */
export function decodeJpeg(bytes: Uint8Array, limits = JPEG_LIMITS, options: { maxSide?: number } = {}): Raster {
  if (bytes.length > limits.bytes) unsupported("The JPEG is too large.");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid("Not a JPEG file.");
  const quant: (Int32Array | undefined)[] = [];
  const dcTables: (Huffman | undefined)[] = [], acTables: (Huffman | undefined)[] = [];
  let frame: Frame | null = null;
  let restartInterval = 0, adobeTransform = -1, offset = 2, ended = false;
  const u16 = (at: number) => { if (at + 1 >= bytes.length) invalid("The JPEG is truncated."); return (bytes[at] << 8) | bytes[at + 1]; };

  while (offset < bytes.length && !ended) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xff) { offset--; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) { ended = true; break; }
    const length = u16(offset), end = offset + length;
    if (length < 2 || end > bytes.length) invalid("A JPEG segment runs past the end of the file.");
    const body = offset + 2;
    switch (marker) {
      case 0xdb: { // DQT
        let at = body;
        while (at < end) {
          const precision = bytes[at] >> 4, id = bytes[at] & 15;
          at++;
          if (id > 3) invalid("A quantization table id is out of range.");
          const table = new Int32Array(64);
          for (let k = 0; k < 64; k++) { table[k] = precision ? u16(at) : bytes[at]; at += precision ? 2 : 1; }
          quant[id] = table;
        }
        break;
      }
      case 0xc4: { // DHT
        let at = body;
        while (at < end) {
          const kind = bytes[at] >> 4, id = bytes[at] & 15;
          if (id > 3 || kind > 1) invalid("A Huffman table id is out of range.");
          const counts = bytes.subarray(at + 1, at + 17);
          const total = counts.reduce((sum, value) => sum + value, 0);
          if (at + 17 + total > end) invalid("A Huffman table is truncated.");
          const table = buildHuffman(counts, bytes.slice(at + 17, at + 17 + total));
          (kind === 0 ? dcTables : acTables)[id] = table;
          at += 17 + total;
        }
        break;
      }
      case 0xdd: restartInterval = u16(body); break;
      case 0xee: // APP14 (Adobe): the colour transform flag.
        if (length >= 14 && String.fromCharCode(...bytes.subarray(body, body + 5)) === "Adobe") adobeTransform = bytes[body + 11];
        break;
      case 0xc0: case 0xc1: case 0xc2: { // SOF
        if (frame) invalid("The JPEG has two frames.");
        if (bytes[body] !== 8) unsupported("Only 8-bit JPEGs are supported.");
        const height = u16(body + 1), width = u16(body + 3), count = bytes[body + 5];
        if (!width || !height) invalid("The JPEG has no size (DNL is not supported).");
        if (width > limits.side || height > limits.side || width * height > limits.pixels) unsupported(`The JPEG is ${width}×${height} (at most ${limits.side} px a side).`);
        if (count !== 1 && count !== 3) unsupported("Only greyscale and three-component JPEGs are supported.");
        const components: Component[] = [];
        for (let i = 0; i < count; i++) {
          const at = body + 6 + i * 3;
          const h = bytes[at + 1] >> 4, v = bytes[at + 1] & 15;
          if (h < 1 || h > 4 || v < 1 || v > 4) invalid("A sampling factor is out of range.");
          components.push({ id: bytes[at], h, v, tq: bytes[at + 2] & 3, blocksPerLine: 0, blocksPerColumn: 0, lineStride: 0, columnStride: 0, coefficients: new Int32Array(0), pred: 0 });
        }
        const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
        const mcusPerLine = Math.ceil(width / (8 * hmax)), mcusPerColumn = Math.ceil(height / (8 * vmax));
        for (const c of components) {
          c.blocksPerLine = Math.ceil(Math.ceil(width * c.h / hmax) / 8);
          c.blocksPerColumn = Math.ceil(Math.ceil(height * c.v / vmax) / 8);
          c.lineStride = mcusPerLine * c.h; c.columnStride = mcusPerColumn * c.v;
          c.coefficients = new Int32Array(c.lineStride * c.columnStride * 64);
        }
        frame = { width, height, components, progressive: marker === 0xc2, hmax, vmax, mcusPerLine, mcusPerColumn };
        break;
      }
      case 0xc3: case 0xc5: case 0xc6: case 0xc7: case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
        unsupported("Lossless, hierarchical and arithmetic-coded JPEGs are not supported.");
        break;
      case 0xda: { // SOS
        if (!frame) invalid("A scan comes before the frame header.");
        const count = bytes[body];
        const scan: Component[] = [];
        for (let i = 0; i < count; i++) {
          const id = bytes[body + 1 + i * 2], tables = bytes[body + 2 + i * 2];
          const component = frame!.components.find(c => c.id === id);
          if (!component) invalid("A scan names an unknown component.");
          component!.dc = dcTables[tables >> 4]; component!.ac = acTables[tables & 15];
          scan.push(component!);
        }
        const at = body + 1 + count * 2;
        const ss = bytes[at], se = bytes[at + 1], ah = bytes[at + 2] >> 4, al = bytes[at + 2] & 15;
        if (se > 63 || ss > se) invalid("A scan's spectral range is invalid.");
        offset = decodeScan(bytes, end, frame!, scan, restartInterval, ss, se, ah, al);
        continue;
      }
      default: break; // APPn, COM and anything else: skipped.
    }
    offset = end;
  }
  if (!frame) invalid("The JPEG has no frame.");
  const side = Math.max(frame!.width, frame!.height);
  const n = options.maxSide ? [8, 4, 2, 1].find(size => side * size / 8 <= options.maxSide!) ?? 1 : 8;
  return output(frame!, quant, adobeTransform, n);
}

function decodeScan(bytes: Uint8Array, start: number, frame: Frame, scan: Component[],
  restartInterval: number, ss: number, se: number, ah: number, al: number): number {
  const reader = new BitReader(bytes, start);
  const progressive = frame.progressive;
  let eobrun = 0;
  const block = (c: Component, row: number, col: number) => (row * c.lineStride + col) * 64;
  const decodeBlock = (c: Component, base: number) => {
    const coefficients = c.coefficients;
    if (!progressive) {
      const t = reader.decode(c.dc);
      c.pred += reader.extend(t);
      coefficients[base] = c.pred;
      for (let k = 1; k < 64;) {
        const rs = reader.decode(c.ac), s = rs & 15, r = rs >> 4;
        if (s === 0) { if (r < 15) break; k += 16; continue; }
        k += r;
        if (k > 63) break;
        coefficients[base + ZIGZAG[k]] = reader.extend(s);
        k++;
      }
      return;
    }
    if (ss === 0) { // DC scans
      if (ah === 0) { const t = reader.decode(c.dc); c.pred += reader.extend(t); coefficients[base] = c.pred * (1 << al); }
      else if (reader.bit()) coefficients[base] |= 1 << al;
      return;
    }
    if (ah === 0) { // AC first
      if (eobrun > 0) { eobrun--; return; }
      for (let k = ss; k <= se;) {
        const rs = reader.decode(c.ac), s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) { eobrun = reader.receive(r) + (1 << r) - 1; break; }
          k += 16; continue;
        }
        k += r;
        if (k > 63) break;
        coefficients[base + ZIGZAG[k]] = reader.extend(s) * (1 << al);
        k++;
      }
      return;
    }
    // AC refinement (successive approximation).
    const p1 = 1 << al, m1 = -1 << al;
    let k = ss;
    const refine = (z: number) => {
      if (reader.bit() && (coefficients[z] & p1) === 0) coefficients[z] += coefficients[z] >= 0 ? p1 : m1;
    };
    if (eobrun <= 0) {
      for (; k <= se; k++) {
        const rs = reader.decode(c.ac);
        let s = rs & 15, r = rs >> 4;
        if (s) s = reader.bit() ? p1 : m1;
        else if (r !== 15) { eobrun = 1 << r; if (r) eobrun += reader.receive(r); break; }
        while (k <= se) {
          const z = base + ZIGZAG[k];
          if (coefficients[z] !== 0) refine(z);
          else if (--r < 0) break;
          k++;
        }
        if (s && k <= 63) coefficients[base + ZIGZAG[k]] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k++) { const z = base + ZIGZAG[k]; if (coefficients[z] !== 0) refine(z); }
      eobrun--;
    }
  };
  const single = scan.length === 1;
  const total = single ? scan[0].blocksPerLine * scan[0].blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
  for (let mcu = 0; mcu < total; mcu++) {
    if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
      reader.restart();
      for (const c of scan) c.pred = 0;
      eobrun = 0;
    }
    if (single) {
      const c = scan[0], row = Math.floor(mcu / c.blocksPerLine), col = mcu % c.blocksPerLine;
      decodeBlock(c, block(c, row, col));
    } else {
      const mcuRow = Math.floor(mcu / frame.mcusPerLine), mcuCol = mcu % frame.mcusPerLine;
      for (const c of scan) {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, block(c, mcuRow * c.v + v, mcuCol * c.h + h));
      }
    }
  }
  for (const c of scan) c.pred = 0;
  // The scan ends at the next marker: continue the segment loop there.
  let at = reader.offset;
  while (at + 1 < bytes.length && !(bytes[at] === 0xff && bytes[at + 1] !== 0x00 && !(bytes[at + 1] >= 0xd0 && bytes[at + 1] <= 0xd7))) at++;
  return at;
}

function output(frame: Frame, quant: (Int32Array | undefined)[], adobeTransform: number, n: number): Raster {
  const { components, hmax, vmax } = frame;
  const width = Math.max(1, Math.ceil(frame.width * n / 8)), height = Math.max(1, Math.ceil(frame.height * n / 8));
  const planes = components.map(c => {
    const table = quant[c.tq];
    if (!table) invalid("A component uses an undefined quantization table.");
    const planeWidth = c.lineStride * n, plane = new Uint8ClampedArray(planeWidth * c.columnStride * n);
    const dequantized = new Float32Array(64), temp = new Float32Array(64);
    for (let row = 0; row < c.blocksPerColumn; row++) {
      for (let col = 0; col < c.blocksPerLine; col++) {
        const base = (row * c.lineStride + col) * 64;
        for (let k = 0; k < 64; k++) dequantized[ZIGZAG[k]] = c.coefficients[base + ZIGZAG[k]] * table![k];
        idct(dequantized, n, plane, row * n * planeWidth + col * n, planeWidth, temp);
      }
    }
    return { plane, planeWidth, sx: c.h / hmax, sy: c.v / vmax };
  });
  const data = new Uint8ClampedArray(width * height * 4);
  const rgb = components.length === 3 && adobeTransform === 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const sample = (p: typeof planes[number]) => p.plane[Math.floor(y * p.sy) * p.planeWidth + Math.floor(x * p.sx)];
      if (planes.length === 1) { data[o] = data[o + 1] = data[o + 2] = sample(planes[0]); }
      else if (rgb) { data[o] = sample(planes[0]); data[o + 1] = sample(planes[1]); data[o + 2] = sample(planes[2]); }
      else {
        const Y = sample(planes[0]), cb = sample(planes[1]) - 128, cr = sample(planes[2]) - 128;
        data[o] = Y + 1.402 * cr; data[o + 1] = Y - 0.344136 * cb - 0.714136 * cr; data[o + 2] = Y + 1.772 * cb;
      }
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
