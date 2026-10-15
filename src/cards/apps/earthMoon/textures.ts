import { LAND_MASK } from "./landMask";

/**
 * Procedural textures for the Earth–Moon card (v0.4.5): no photographs, so nothing to license. Earth is coloured from
 * Natural Earth's land mask (public domain) with approximate climate zones; the Moon from the real selenographic
 * positions of its major maria and bright rayed craters, with seeded craters for texture. Pure pixel generation into
 * RGBA arrays (the card turns them into textures); every function is deterministic.
 */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }

/** A small, fast, seeded value noise with fractal octaves (0…1). */
export function noise2(seed: number) {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number, wrapX: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
    const xa = ((x0 % wrapX) + wrapX) % wrapX, xb = (xa + 1) % wrapX;
    const a = hash(xa, y0), b = hash(xb, y0), c = hash(xa, y0 + 1), d = hash(xb, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  /** Fractal noise; `wrap` makes it seamless across the texture's left and right edges (in cells at the base scale). */
  return (x: number, y: number, octaves: number, wrap: number) => {
    let sum = 0, amplitude = 0.5, frequency = 1, total = 0;
    for (let o = 0; o < octaves; o++) {
      sum += value(x * frequency, y * frequency, wrap * frequency) * amplitude;
      total += amplitude; amplitude *= 0.5; frequency *= 2;
    }
    return sum / total;
  };
}

/** Decodes the run-length land mask (1 = land). */
export function decodeLandMask(): { width: number; height: number; mask: Uint8Array } {
  const { width, height, data } = LAND_MASK;
  const binary = atob(data);
  const mask = new Uint8Array(width * height);
  let p = 0, i = 0;
  const varint = () => { let value = 0, shift = 0, b: number; do { b = binary.charCodeAt(i++); value |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return value; };
  for (let row = 0; row < height; row++) {
    let col = 0, land = 0;
    while (col < width) { const run = varint(); if (land) mask.fill(1, p + col, p + col + run); col += run; land ^= 1; }
    p += width;
  }
  return { width, height, mask };
}

/** Box-blurs a mask into 0…1 (separable, wrapping horizontally), for soft coasts and shallow shelves. */
function blur(mask: Uint8Array | Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(width * height), out = new Float32Array(width * height), n = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += mask[y * width + ((k % width) + width) % width];
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = sum / n;
      sum += mask[y * width + (x + radius + 1) % width] - mask[y * width + ((x - radius) % width + width) % width];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / n;
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

/** Approximate arid regions (lat, lon centre; half-extents in degrees), for the deserts' colour. */
const ARID: [number, number, number, number][] = [
  [23, 10, 12, 26], [24, 45, 9, 12], [40, 62, 7, 16], [43, 103, 5, 14], [31, -110, 6, 8], [-25, 132, 8, 14], [-24, 20, 6, 8], [-22, -69, 7, 3], [33, 66, 4, 8], [30, 80, 0, 0],
];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: number[], b: number[], t: number) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smoothstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Earth's colour (RGBA) and its ocean mask for specular highlights (R channel), equirectangular. */
export function earthTextures(): { color: Pixels; specular: Pixels } {
  const { width, height, mask } = decodeLandMask();
  const coast = blur(mask, width, height, 2), shelf = blur(mask, width, height, 10);
  const n = noise2(7);
  const color = new Uint8ClampedArray(width * height * 4), specular = new Uint8ClampedArray(width * height * 4);
  const ocean = [10, 30, 62], shallow = [22, 66, 102];
  const forest = [36, 72, 34], grass = [96, 116, 58], desert = [196, 168, 118], tundra = [118, 116, 98], ice = [236, 240, 244], rock = [110, 98, 86];
  for (let y = 0; y < height; y++) {
    const lat = 90 - (y + 0.5) / height * 180, alat = Math.abs(lat);
    for (let x = 0; x < width; x++) {
      const lon = (x + 0.5) / width * 360 - 180, i = y * width + x;
      const variation = n(x / 64, y / 64, 4, width / 64);
      let rgb: number[];
      if (coast[i] < 0.5) {
        rgb = mix(ocean, shallow, Math.min(1, shelf[i] * 1.6));
        rgb = mix(rgb, [8, 24, 52], smoothstep(40, 75, alat) * 0.3);
        if (alat > 70) rgb = mix(rgb, ice, smoothstep(72, 80, alat + variation * 6) * 0.85);
      } else {
        let arid = 0;
        for (const [la, lo, hla, hlo] of ARID) {
          if (!hla) continue;
          const d = ((lat - la) / hla) ** 2 + ((lon - lo) / hlo) ** 2;
          arid = Math.max(arid, 1 - smoothstep(0.55, 1.15, d + (variation - 0.5) * 0.5));
        }
        const temperate = smoothstep(5, 30, alat) * (1 - smoothstep(48, 62, alat));
        rgb = mix(forest, grass, temperate * 0.6 + (variation - 0.5) * 0.4);
        rgb = mix(rgb, desert, arid);
        rgb = mix(rgb, tundra, smoothstep(55, 66, alat + (variation - 0.5) * 8));
        // Mountain snow (Himalaya, Andes are too narrow at this scale), Greenland, Antarctica, the Arctic.
        const himalaya = 1 - smoothstep(0.5, 1, ((lat - 32) / 4) ** 2 + ((lon - 86) / 11) ** 2);
        rgb = mix(rgb, rock, himalaya * 0.6);
        const greenland = lat > 59 && lon > -75 && lon < -10 ? smoothstep(59, 64, lat) : 0;
        rgb = mix(rgb, ice, Math.max(greenland, smoothstep(66, 74, alat + (variation - 0.5) * 10), lat < -60 ? 1 : 0));
        rgb = mix(rgb, mix(rgb, [0, 0, 0], 0.25), (variation - 0.5) * 0.8);
      }
      // A soft coast.
      const edge = 1 - Math.abs(coast[i] - 0.5) * 2;
      if (edge > 0) rgb = mix(rgb, mix(shallow, rgb, 0.5), edge * 0.35);
      const o = i * 4;
      color[o] = rgb[0]; color[o + 1] = rgb[1]; color[o + 2] = rgb[2]; color[o + 3] = 255;
      const water = coast[i] < 0.5 && alat < 70 ? 255 : 0;
      specular[o] = specular[o + 1] = specular[o + 2] = water * 0.5; specular[o + 3] = 255;
    }
  }
  return { color: { width, height, data: color }, specular: { width, height, data: specular } };
}

/** Clouds (RGBA, white with alpha), with the tropics' and mid-latitudes' cloud bands. */
export function cloudTexture(width = 1024, height = 512): Pixels {
  const n = noise2(23), data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const lat = 90 - (y + 0.5) / height * 180, alat = Math.abs(lat);
    const band = 0.18 * Math.exp(-(((alat - 0) / 9) ** 2)) + 0.14 * Math.exp(-(((alat - 55) / 14) ** 2)) - 0.1 * Math.exp(-(((alat - 25) / 8) ** 2));
    for (let x = 0; x < width; x++) {
      const v = n(x / 48 + n(x / 96, y / 96, 2, width / 96) * 2, y / 36, 5, width / 48) + band;
      const a = smoothstep(0.52, 0.78, v);
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255; data[o + 3] = a * 235;
    }
  }
  return { width, height, data };
}

/** The Moon's major maria: selenographic latitude, longitude (east positive) and radius, in degrees. */
const MARIA: [number, number, number][] = [
  [33, -16, 15], [28, 17, 9], [8.5, 31, 10], [17, 59, 6.5], [-8, 51, 8], [-15, 34, 4.5], [-21, -17, 9], [-24, -39, 5], [13, 3.5, 3.5],
  [-10, -23, 5], [7, -30, 6], [56, -15, 4.5], [56, 8, 4.5], [57, 30, 3.5],
  [18, -57, 14], [5, -50, 12], [-5, -58, 9], [30, -50, 10], [40, -38, 7], [-15, -50, 6],
  [27, 148, 3.5], [-20, -95, 4], [-57, 170, 22],
];
/** Bright rayed craters: Tycho, Copernicus, Kepler, Aristarchus. */
const RAYED: [number, number, number][] = [[-43.3, -11.4, 1.4], [9.6, -20.1, 1.3], [8.1, -38, 0.8], [23.7, -47.4, 0.7]];

/** The Moon's albedo (RGBA) and its height for bump mapping (R channel), equirectangular, near side at the centre. */
export function moonTextures(width = 1024, height = 512): { color: Pixels; bump: Pixels } {
  const n = noise2(91);
  const albedo = new Float32Array(width * height), relief = new Float32Array(width * height);
  const DEG = Math.PI / 180;
  const unit = (lat: number, lon: number) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG)];
  const angle = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG;
  const maria = MARIA.map(([lat, lon, r]) => ({ c: unit(lat, lon), r }));
  const rayed = RAYED.map(([lat, lon, r]) => ({ c: unit(lat, lon), r, lat, lon }));
  // Seeded craters, spread evenly over the sphere.
  let s = 1234567;
  const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const craters = Array.from({ length: 900 }, () => ({ lat: Math.asin(rand() * 2 - 1) / DEG, lon: rand() * 360 - 180, r: 0.25 + rand() ** 3 * 5 }));
  for (let y = 0; y < height; y++) {
    const lat = 90 - (y + 0.5) / height * 180;
    for (let x = 0; x < width; x++) {
      const lon = (x + 0.5) / width * 360 - 180, p = unit(lat, lon), i = y * width + x;
      const grain = n(x / 24, y / 24, 5, width / 24);
      let mare = 0;
      for (const m of maria) { const d = angle(p, m.c) / m.r; mare = Math.max(mare, 1 - smoothstep(0.6, 1.15, d + (grain - 0.5) * 0.6)); }
      let a = lerp(0.6, 0.3, mare) + (grain - 0.5) * 0.12;
      const h = (1 - mare) * 0.3 + grain * 0.2;
      for (const c of rayed) {
        const d = angle(p, c.c);
        if (d < c.r * 1.5) a += 0.28 * (1 - d / (c.r * 1.5));
        // Rays: thin bright streaks out of the crater.
        const bearing = Math.atan2(lon - c.lon, lat - c.lat);
        a += Math.pow(Math.max(0, Math.cos(bearing * 9 + c.lon)), 40) * Math.exp(-d / (c.r * 9)) * 0.18;
      }
      albedo[i] = a; relief[i] = h;
    }
  }
  // Craters, each over the pixels around it only.
  for (const crater of [...craters, ...rayed.map(c => ({ lat: c.lat, lon: c.lon, r: c.r }))]) {
    const c = unit(crater.lat, crater.lon), reach = crater.r * 1.4;
    const y0 = Math.max(0, Math.floor((90 - crater.lat - reach) / 180 * height)), y1 = Math.min(height - 1, Math.ceil((90 - crater.lat + reach) / 180 * height));
    const span = reach / Math.max(0.05, Math.cos(Math.min(89, Math.abs(crater.lat) + reach) * DEG));
    const x0 = Math.floor((crater.lon - span + 180) / 360 * width), x1 = Math.ceil((crater.lon + span + 180) / 360 * width);
    for (let y = y0; y <= y1; y++) {
      const lat = 90 - (y + 0.5) / height * 180;
      for (let xx = x0; xx <= x1; xx++) {
        const x = ((xx % width) + width) % width, lon = (x + 0.5) / width * 360 - 180;
        const d = angle(unit(lat, lon), c) / crater.r;
        if (d > 1.4) continue;
        const rim = Math.exp(-(((d - 1) / 0.18) ** 2)), floor = d < 1 ? 1 - d * d : 0, i = y * width + x;
        relief[i] += rim * 0.25 - floor * 0.3;
        albedo[i] += rim * 0.06 - floor * 0.03;
      }
    }
  }
  for (let i = 0; i < albedo.length; i++) albedo[i] = Math.max(0.08, Math.min(0.95, albedo[i]));
  const color = new Uint8ClampedArray(width * height * 4), bump = new Uint8ClampedArray(width * height * 4);
  let lo = Infinity, hi = -Infinity;
  for (const v of relief) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < width * height; i++) {
    const v = albedo[i] * 255, o = i * 4;
    color[o] = v * 1.0; color[o + 1] = v * 0.98; color[o + 2] = v * 0.94; color[o + 3] = 255;
    bump[o] = bump[o + 1] = bump[o + 2] = (relief[i] - lo) / (hi - lo) * 255; bump[o + 3] = 255;
  }
  return { color: { width, height, data: color }, bump: { width, height, data: bump } };
}
