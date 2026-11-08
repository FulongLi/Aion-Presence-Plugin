/**
 * A minimal animated GIF encoder for documentation clips (v0.9): one global palette (median cut over all frames), each
 * frame mapped to it, LZW-compressed, looping. Development only — never part of the runtime.
 */
export interface GifFrame { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray; delayMs: number }

function medianCut(samples: number[][], colours: number): number[][] {
  const boxes = [samples];
  while (boxes.length < colours) {
    let best = -1, bestRange = -1, bestAxis = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let axis = 0; axis < 3; axis++) {
        let lo = 255, hi = 0;
        for (const p of box) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = i; bestAxis = axis; }
      }
    });
    if (best < 0 || bestRange <= 0) break;
    const box = boxes[best].sort((a, b) => a[bestAxis] - b[bestAxis]);
    const mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map(box => [0, 1, 2].map(k => Math.round(box.reduce((sum, p) => sum + p[k], 0) / box.length)));
}

function lzw(indices: Uint8Array, minCode: number): number[] {
  const clear = 1 << minCode, end = clear + 1;
  const out: number[] = [];
  let bits = 0, value = 0, size = minCode + 1, next = end + 1;
  let table = new Map<string, number>();
  const emit = (code: number) => { value |= code << bits; bits += size; while (bits >= 8) { out.push(value & 255); value >>>= 8; bits -= 8; } };
  emit(clear);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = `${prefix},${k}`;
    if (table.has(key)) { prefix = key; continue; }
    emit(prefix.includes(",") ? table.get(prefix)! : Number(prefix));
    if (next < 4096) { table.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); table = new Map(); size = minCode + 1; next = end + 1; }
    prefix = String(k);
  }
  emit(prefix.includes(",") ? table.get(prefix)! : Number(prefix));
  emit(end);
  if (bits > 0) out.push(value & 255);
  return out;
}

export function encodeGif(frames: GifFrame[]): Uint8Array {
  const { width, height } = frames[0];
  const samples: number[][] = [];
  for (const f of frames) for (let i = 0; i < f.width * f.height; i += 37) samples.push([f.rgba[i * 4], f.rgba[i * 4 + 1], f.rgba[i * 4 + 2]]);
  const palette = medianCut(samples, 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const cache = new Map<number, number>();
  const nearest = (r: number, g: number, b: number) => {
    const key = (r >> 2) << 12 | (g >> 2) << 6 | (b >> 2);
    let hit = cache.get(key);
    if (hit === undefined) {
      let best = 0, distance = Infinity;
      palette.forEach((p, i) => { const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < distance) { distance = d; best = i; } });
      cache.set(key, hit = best);
    }
    return hit;
  };
  const bytes: number[] = [];
  const word = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  bytes.push(...Buffer.from("GIF89a"));
  word(width); word(height); bytes.push(0xf7, 0, 0);
  for (const p of palette) bytes.push(...p);
  bytes.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0);
    bytes[bytes.length - 4] = Math.round(f.delayMs / 10) & 255; bytes[bytes.length - 3] = (Math.round(f.delayMs / 10) >> 8) & 255;
    bytes.push(0x2c); word(0); word(0); word(width); word(height); bytes.push(0);
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) indices[i] = nearest(f.rgba[i * 4], f.rgba[i * 4 + 1], f.rgba[i * 4 + 2]);
    bytes.push(8);
    const data = lzw(indices, 8);
    for (let i = 0; i < data.length; i += 255) { const chunk = data.slice(i, i + 255); bytes.push(chunk.length, ...chunk); }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
