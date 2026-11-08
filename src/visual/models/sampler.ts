import { TriangleBvh } from "./bvh";
import type { ModelGeometry, ModelMaterial, TextureRef } from "./geometry";
import type { Raster } from "../types";
import { normalizeGeometry, type Orientation } from "./normalization";
import { matchToSphere } from "./correspond";

/**
 * A model's surface → particles (v0.9), the heart of the model library:
 *
 * 1. Surfaces are sampled by area: a triangle receives particles in proportion to its area (never one per vertex, which
 *    follows the mesh's tessellation instead of its shape). Uniform barycentric points, from one seeded sequence, so the
 *    same model and options always give the same particles.
 * 2. A share of the particles favours detail: triangles whose colour varies across them (an eye, a mouth, a stripe) are
 *    sampled more densely, so small features read.
 * 3. Points no one could see — inside the body, under an embedded eye, in a closed mouth — are dropped: a point is kept
 *    when a ray in at least one of 14 directions leaves the model (TriangleBvh).
 * 4. Each point takes its colour (material × vertex colour × texture, alpha-cut surfaces skipped) and a baked tone from
 *    its outward normal under a soft key light, so the form reads even in Aion's silver.
 * 5. Positions are normalized (orientation, centre, scale to the stage) and the points are put in correspondence with
 *    Aion's sphere (correspond.ts): particle i of the model is where grain i of the sphere goes. Morphing from the sphere
 *    is then an orderly unfolding, and two models — both matched to the same sphere — morph into one another coherently.
 */
export interface ModelParticles {
  count: number;
  /** Stage coordinates (x right, y up, z toward the viewer), within ±extent. */
  positions: Float32Array;
  /** sRGB colour per particle, 3 bytes each. */
  colors: Uint8Array;
  /** Baked light per particle, 0…255. */
  shade: Uint8Array;
  /** The radius the positions are scaled to. */
  extent: number;
}

export interface SampleOptions {
  count: number;
  seed?: number;
  /** Decoded textures by image index (null: not decodable — the material colour is used). */
  textures?: (Raster | null)[];
  orientation?: Orientation;
  /** Share of particles placed by colour detail (0…0.5). */
  detail?: number;
  /** Skip the visibility test (tests and very large models). */
  visibility?: boolean;
  /** Primitives whose material or node name matches are left out (a ground plane, a backdrop). */
  exclude?: (material: ModelMaterial, node: number) => boolean;
}

export interface SampleReport { triangles: number; candidates: number; hidden: number; cut: number; ms: { visibility: number; total: number } }

/**
 * Where each particle (in the final order) lies on the surface: its triangle (over the kept primitives, in order) and
 * barycentric weights, plus the matrix that placed the model on the stage. An animation re-evaluates these in another
 * pose (animation.ts) without sampling again, so every particle stays on its own spot of the moving surface.
 */
export interface SurfaceRefs { triangle: Uint32Array; r1: Float32Array; r2: Float32Array; matrix: Float64Array; kept: number[] }

/** Particles fill a sphere of this radius on the stage (scene3d's SCENE_EXTENT, so models and scenes share a size). */
export const MODEL_EXTENT = 1.75;

const random = (initial: number) => { let seed = initial >>> 0 || 1; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };
function pick(distribution: Float64Array, value: number) {
  let lo = 0, hi = distribution.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (distribution[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The 14 directions a point may escape by (axes and diagonals). */
const DIRECTIONS = (() => {
  const out: number[][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push([x / Math.sqrt(3), y / Math.sqrt(3), z / Math.sqrt(3)]);
  return out;
})();
const LIGHT = (() => { const v = [0.35, 0.75, 0.55]; const l = Math.hypot(...v); return v.map(x => x / l); })();

const wrap = (value: number, mode: number) => {
  if (mode === 33071) return Math.max(0, Math.min(1, value)); // clamp
  if (mode === 33648) { const t = ((value % 2) + 2) % 2; return t > 1 ? 2 - t : t; } // mirrored repeat
  return value - Math.floor(value); // repeat
};

export function textureColor(texture: TextureRef, raster: Raster, u: number, v: number, out: number[]) {
  if (texture.transform) {
    const { offset, scale, rotation } = texture.transform;
    const su = u * scale[0], sv = v * scale[1], c = Math.cos(rotation), s = Math.sin(rotation);
    u = c * su + s * sv + offset[0]; v = -s * su + c * sv + offset[1];
  }
  const x = Math.min(raster.width - 1, Math.floor(wrap(u, texture.wrapS) * raster.width));
  const y = Math.min(raster.height - 1, Math.floor(wrap(v, texture.wrapT) * raster.height));
  const i = (y * raster.width + x) * 4;
  out[0] = raster.data[i] / 255; out[1] = raster.data[i + 1] / 255; out[2] = raster.data[i + 2] / 255; out[3] = raster.data[i + 3] / 255;
}

export function sampleModel(source: ModelGeometry, options: SampleOptions): { particles: ModelParticles; report: SampleReport; surface: SurfaceRefs } {
  const started = performance.now();
  const count = Math.max(64, Math.min(200_000, Math.round(options.count)));
  const { geometry, matrix } = normalizeGeometry(source, options.orientation, MODEL_EXTENT);
  const next = random(options.seed ?? 0xa10de1);
  const textures = options.textures ?? [];
  // Every triangle of every kept primitive, world positions flattened (for the BVH and sampling).
  const keptIndices = geometry.primitives.map((_, i) => i).filter(i => !options.exclude?.(geometry.materials[geometry.primitives[i].material], geometry.primitives[i].node));
  const kept = keptIndices.map(i => geometry.primitives[i]);
  const triangleTotal = kept.reduce((sum, p) => sum + p.indices.length / 3, 0);
  if (!triangleTotal) throw new Error("model-empty");
  const flat = new Float32Array(triangleTotal * 9);
  const owner = new Uint32Array(triangleTotal), local = new Uint32Array(triangleTotal);
  const areas = new Float64Array(triangleTotal);
  let t = 0;
  kept.forEach((p, pi) => {
    const material = geometry.materials[p.material];
    const alpha = material?.alphaMode === "BLEND" ? Math.max(0.15, material.color[3]) : 1;
    for (let k = 0; k < p.indices.length; k += 3, t++) {
      for (let c = 0; c < 3; c++) flat.set(p.positions.subarray(p.indices[k + c] * 3, p.indices[k + c] * 3 + 3), t * 9 + c * 3);
      const o = t * 9;
      const ax = flat[o + 3] - flat[o], ay = flat[o + 4] - flat[o + 1], az = flat[o + 5] - flat[o + 2];
      const bx = flat[o + 6] - flat[o], by = flat[o + 7] - flat[o + 1], bz = flat[o + 8] - flat[o + 2];
      areas[t] = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2 * alpha;
      owner[t] = pi; local[t] = k / 3;
    }
  });
  const colorAt = (tri: number, r1: number, r2: number, out: number[]) => {
    const p = kept[owner[tri]], k = local[tri] * 3, material = geometry.materials[p.material];
    const a = p.indices[k], b = p.indices[k + 1], c = p.indices[k + 2], w0 = 1 - r1 - r2;
    out[0] = material.color[0]; out[1] = material.color[1]; out[2] = material.color[2]; out[3] = material.color[3];
    if (p.colors) for (let ch = 0; ch < 4; ch++) out[ch] *= p.colors[a * 4 + ch] * w0 + p.colors[b * 4 + ch] * r1 + p.colors[c * 4 + ch] * r2;
    const texture = material.texture, raster = texture ? textures[texture.image] : null;
    const uv = texture ? p.uvs[texture.texCoord] ?? p.uvs[0] : undefined;
    if (texture && raster && uv) {
      const u = uv[a * 2] * w0 + uv[b * 2] * r1 + uv[c * 2] * r2, v = uv[a * 2 + 1] * w0 + uv[b * 2 + 1] * r1 + uv[c * 2 + 1] * r2;
      const texel = [0, 0, 0, 0];
      textureColor(texture, raster, u, v, texel);
      for (let ch = 0; ch < 4; ch++) out[ch] *= texel[ch];
    }
    return material;
  };
  // Detail weights: how much a triangle's colour varies (corners and centre), on top of its area.
  const detailShare = Math.max(0, Math.min(0.5, options.detail ?? 0.18));
  let detail: Float64Array | null = null;
  if (detailShare > 0 && triangleTotal <= 1_500_000) {
    const weights = new Float64Array(triangleTotal), c0 = [0, 0, 0, 0], c1 = [0, 0, 0, 0];
    let any = false;
    for (let i = 0; i < triangleTotal; i++) {
      if (!(areas[i] > 0)) continue;
      colorAt(i, 1 / 3, 1 / 3, c0);
      let variation = 0;
      for (const [r1, r2] of [[0.02, 0.02], [0.96, 0.02], [0.02, 0.96]]) {
        colorAt(i, r1, r2, c1);
        variation = Math.max(variation, Math.abs(c1[0] - c0[0]) + Math.abs(c1[1] - c0[1]) + Math.abs(c1[2] - c0[2]));
      }
      if (variation > 0.08) { weights[i] = areas[i] * Math.min(1, variation); any = true; }
    }
    if (any) { let total = 0; for (let i = 0; i < triangleTotal; i++) { total += weights[i]; weights[i] = total; } detail = weights; }
  }
  const byArea = new Float64Array(triangleTotal);
  { let total = 0; for (let i = 0; i < triangleTotal; i++) { total += areas[i]; byArea[i] = total; } }
  const areaTotal = byArea[triangleTotal - 1];
  if (!(areaTotal > 0)) throw new Error("model-empty");
  // Detail never more than triples a surface's density: a small varied patch (a gradient fin) would otherwise take the
  // whole share and turn solid, while the rest of the model thins out.
  let share = detailShare;
  if (detail) {
    const fraction = Math.min(1, detail[triangleTotal - 1] / areaTotal);
    share = fraction >= 1 ? detailShare : Math.min(detailShare, 2 / (1 / fraction - 1));
  }
  const visibility = options.visibility !== false;
  const bvh = visibility ? new TriangleBvh(flat) : null;
  let visibilityMs = 0;
  const near = MODEL_EXTENT * 2e-4;
  const positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3), shade = new Uint8Array(count);
  const refTriangle = new Uint32Array(count), refR1 = new Float32Array(count), refR2 = new Float32Array(count);
  const color = [0, 0, 0, 0];
  let filled = 0, candidates = 0, hidden = 0, cut = 0;
  const maxCandidates = count * 6;
  while (filled < count && candidates < maxCandidates) {
    candidates++;
    const detailed = detail && next() < share;
    const tri = detailed ? pick(detail!, next() * detail![triangleTotal - 1]) : pick(byArea, next() * areaTotal);
    let r1 = next(), r2 = next();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const o = tri * 9;
    const x = flat[o] + (flat[o + 3] - flat[o]) * r1 + (flat[o + 6] - flat[o]) * r2;
    const y = flat[o + 1] + (flat[o + 4] - flat[o + 1]) * r1 + (flat[o + 7] - flat[o + 1]) * r2;
    const z = flat[o + 2] + (flat[o + 5] - flat[o + 2]) * r1 + (flat[o + 8] - flat[o + 2]) * r2;
    const material = colorAt(tri, r1, r2, color);
    // Cut-out (MASK) and nearly invisible (BLEND) parts of a texture are not surface.
    if ((material.alphaMode === "MASK" && color[3] < 0.5) || (material.alphaMode === "BLEND" && color[3] < 0.08)) { cut++; continue; }
    // The face normal; its outward side is the side a ray escapes by.
    const ax = flat[o + 3] - flat[o], ay = flat[o + 4] - flat[o + 1], az = flat[o + 5] - flat[o + 2];
    const bx = flat[o + 6] - flat[o], by = flat[o + 7] - flat[o + 1], bz = flat[o + 8] - flat[o + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    let outward = 1;
    if (bvh) {
      const v0 = performance.now();
      let escaped = 0;
      // Try along the normal first (both ways): most surface points escape on the first ray.
      for (const sign of [1, -1]) {
        if (!bvh.occluded(x + nx * sign * near, y + ny * sign * near, z + nz * sign * near, nx * sign, ny * sign, nz * sign, near)) { escaped = sign; break; }
      }
      if (!escaped) {
        for (const d of DIRECTIONS) {
          if (!bvh.occluded(x + d[0] * near, y + d[1] * near, z + d[2] * near, d[0], d[1], d[2], near)) { escaped = d[0] * nx + d[1] * ny + d[2] * nz >= 0 ? 1 : -1; break; }
        }
      }
      visibilityMs += performance.now() - v0;
      if (!escaped) { hidden++; continue; }
      outward = escaped;
    } else if (nx * x + ny * y + nz * z < 0) outward = -1;
    const lambert = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) * outward);
    positions[filled * 3] = x; positions[filled * 3 + 1] = y; positions[filled * 3 + 2] = z;
    colors[filled * 3] = Math.round(Math.max(0, Math.min(1, color[0])) * 255);
    colors[filled * 3 + 1] = Math.round(Math.max(0, Math.min(1, color[1])) * 255);
    colors[filled * 3 + 2] = Math.round(Math.max(0, Math.min(1, color[2])) * 255);
    shade[filled] = Math.round((0.5 + 0.5 * lambert) * 255);
    refTriangle[filled] = tri; refR1[filled] = r1; refR2[filled] = r2;
    filled++;
  }
  if (filled < count) {
    // Not enough visible surface (a heavily nested model): repeat what was found rather than invent anything.
    if (filled === 0) throw new Error("model-empty");
    for (let i = filled; i < count; i++) {
      const from = Math.floor(next() * filled);
      positions.copyWithin(i * 3, from * 3, from * 3 + 3); colors.copyWithin(i * 3, from * 3, from * 3 + 3); shade[i] = shade[from];
      refTriangle[i] = refTriangle[from]; refR1[i] = refR1[from]; refR2[i] = refR2[from];
    }
  }
  const { particles, order } = matchToSphere({ count, positions, colors, shade, extent: MODEL_EXTENT });
  const surface: SurfaceRefs = {
    triangle: order.map(i => refTriangle[i]), r1: Float32Array.from(order, i => refR1[i]), r2: Float32Array.from(order, i => refR2[i]), matrix, kept: keptIndices,
  };
  return { particles, surface, report: { triangles: triangleTotal, candidates, hidden, cut, ms: { visibility: Math.round(visibilityMs), total: Math.round(performance.now() - started) } } };
}
