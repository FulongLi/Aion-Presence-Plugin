/**
 * Colour maps for the Simulation Card (v0.8). Each is a 256-entry sRGB lookup table built from exact definitions or the
 * published samples: the legend and the surface use the same table, so the colour a value has on the model is the colour
 * the legend shows for it.
 *
 *   rainbow    blue → cyan → green → yellow → red, the usual FEM contour scale (piecewise linear, exact)
 *   viridis    matplotlib's perceptually uniform map (its 11 published samples)
 *   inferno    matplotlib's (11 samples)
 *   coolwarm   Moreland's diverging map (matplotlib's samples at 0, ¼, ½, ¾, 1)
 *   jet        MATLAB's classic definition (exact)
 *   grayscale  black → white
 */
export const COLORMAPS = ["rainbow", "viridis", "inferno", "coolwarm", "jet", "grayscale"] as const;
export type ColormapId = typeof COLORMAPS[number];

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const STOPS: Record<Exclude<ColormapId, "jet">, string[]> = {
  rainbow: ["#0000ff", "#00ffff", "#00ff00", "#ffff00", "#ff0000"],
  viridis: ["#440154", "#482475", "#414487", "#355f8d", "#2a788e", "#21918c", "#22a884", "#44bf70", "#7ad151", "#bddf26", "#fde725"],
  inferno: ["#000004", "#160b39", "#420a68", "#6a176e", "#932667", "#bc3754", "#dd513a", "#f37819", "#fca50a", "#f6d746", "#fcffa4"],
  coolwarm: ["#3b4cc0", "#8db0fe", "#dddddd", "#f49a7b", "#b40426"],
  grayscale: ["#000000", "#ffffff"],
};

/** The colour of t ∈ [0, 1] as 0–255 sRGB. */
export function colorAt(map: ColormapId, t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  if (map === "jet") {
    const c = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
    return [c(1.5 - Math.abs(4 * x - 3)), c(1.5 - Math.abs(4 * x - 2)), c(1.5 - Math.abs(4 * x - 1))];
  }
  const stops = STOPS[map].map(hex);
  const f = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), w = f - i;
  return [0, 1, 2].map(k => Math.round(stops[i][k] + w * (stops[i + 1][k] - stops[i][k]))) as [number, number, number];
}

/** 256 RGBA entries. */
export function lookupTable(map: ColormapId): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = colorAt(map, i / 255);
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

/** About `count` round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
