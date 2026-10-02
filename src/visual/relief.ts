import type { HeightField } from "./types";

/**
 * A quiet shaded-relief map of a height field, for a terrain card: hill shading lit from the north-west and a
 * muted elevation tint in Presence's palette (cool lowlands, pale highlands), transparent outside the region.
 * Pure: the same field always gives the same pixels (RGBA, row-major, `scale`× the grid).
 */
export function reliefPixels(field: HeightField, scale = 2): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const k = Math.max(1, Math.min(4, Math.round(scale)));
  const width = field.width * k, height = field.height * k;
  const data = new Uint8ClampedArray(width * height * 4);
  const cell = (x: number, y: number) => field.values[Math.max(0, Math.min(field.height - 1, y)) * field.width + Math.max(0, Math.min(field.width - 1, x))];
  // Bilinear height between grid points, so the map is smooth at any scale (never blocky cells).
  const at = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const top = cell(x0, y0) + (cell(x0 + 1, y0) - cell(x0, y0)) * fx;
    const bottom = cell(x0, y0 + 1) + (cell(x0 + 1, y0 + 1) - cell(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
  };
  const masked = (x: number, y: number) => field.mask![Math.max(0, Math.min(field.height - 1, y)) * field.width + Math.max(0, Math.min(field.width - 1, x))] ? 1 : 0;
  // Coverage of the region, interpolated like the height, so the coastline is smooth rather than stepped.
  const coverage = (x: number, y: number) => {
    if (!field.mask) return 1;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const top = masked(x0, y0) + (masked(x0 + 1, y0) - masked(x0, y0)) * fx;
    const bottom = masked(x0, y0 + 1) + (masked(x0 + 1, y0 + 1) - masked(x0, y0 + 1)) * fx;
    const c = top + (bottom - top) * fy;
    const t = Math.max(0, Math.min(1, (c - 0.3) / 0.4));
    return t * t * (3 - 2 * t);
  };
  // Light from the upper left, a little above the horizon; the relief exaggerates slopes enough to read.
  const light = normalize([-1, 1, 1.4]);
  const exaggeration = 18 * Math.max(0.2, field.relief);
  const low = [44, 66, 86], mid = [96, 120, 134], high = [214, 206, 196];
  const step = 1 / k;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const gx = (px + 0.5) / k - 0.5, gy = (py + 0.5) / k - 0.5;
      const i = (py * width + px) * 4;
      const alpha = coverage(gx, gy);
      if (alpha <= 0) continue;
      const h = at(gx, gy);
      const dx = (at(gx + step, gy) - at(gx - step, gy)) / (2 * step) * exaggeration;
      const dy = (at(gx, gy - step) - at(gx, gy + step)) / (2 * step) * exaggeration;
      const normal = normalize([-dx, -dy, 1]);
      const shade = Math.max(0, normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]);
      const t = Math.max(0, Math.min(1, h));
      const tint = t < 0.5 ? mix(low, mid, t * 2) : mix(mid, high, (t - 0.5) * 2);
      const lit = 0.35 + 0.85 * shade;
      data[i] = tint[0] * lit; data[i + 1] = tint[1] * lit; data[i + 2] = tint[2] * lit; data[i + 3] = Math.round(alpha * 255);
    }
  }
  return { width, height, data };
}

function normalize(v: number[]) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function mix(a: number[], b: number[], t: number) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
