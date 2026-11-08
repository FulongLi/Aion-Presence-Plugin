import { createSphere } from "../../render/sphere/createSphere";
import { particleDefaults } from "../../render/particleDefaults";
import type { ModelParticles } from "./sampler";

/**
 * Point correspondence with Aion's sphere (v0.9). The renderer morphs grain i of the body to point i of the target; with
 * an arbitrary order every grain crosses the body to a random place and the change reads as an explosion. Here the model's
 * points are reordered so that point i lies, relative to the model, where sphere grain i lies relative to the sphere:
 * both sets are split in half by the same axis at their medians, again and again (vertical first), and the halves are
 * paired — a deterministic, balanced approximation of optimal transport in O(n log² n). Grains from the top of the sphere
 * become the ears, grains from its left become the left arm; and because every model is matched to the same sphere, one
 * model morphs into another just as coherently.
 *
 * The sphere is the renderer's own (createSphere: one seeded sequence, so any prefix is the sphere of that many grains),
 * which keeps the correspondence valid at every quality tier: the first n points belong to the first n grains.
 */
export function matchToSphere(particles: ModelParticles): { particles: ModelParticles; order: Uint32Array } {
  const n = particles.count;
  const sphere = createSphere(n, particleDefaults.geometry.radius).positions;
  const model = particles.positions;
  const a = new Uint32Array(n).map((_, i) => i), b = new Uint32Array(n).map((_, i) => i);
  const assignment = new Uint32Array(n); // sphere grain → model point
  const split = (start: number, end: number, depth: number) => {
    const size = end - start;
    if (size === 1) { assignment[a[start]] = b[start]; return; }
    if (size <= 0) return;
    const axis = [1, 0, 2][depth % 3];
    const sa = a.subarray(start, end), sb = b.subarray(start, end);
    sa.sort((i, j) => sphere[i * 3 + axis] - sphere[j * 3 + axis]);
    sb.sort((i, j) => model[i * 3 + axis] - model[j * 3 + axis]);
    const mid = start + (size >> 1);
    split(start, mid, depth + 1);
    split(mid, end, depth + 1);
  };
  split(0, n, 0);
  const positions = new Float32Array(n * 3), colors = new Uint8Array(n * 3), shade = new Uint8Array(n);
  for (let grain = 0; grain < n; grain++) {
    const point = assignment[grain];
    positions.set(model.subarray(point * 3, point * 3 + 3), grain * 3);
    colors.set(particles.colors.subarray(point * 3, point * 3 + 3), grain * 3);
    shade[grain] = particles.shade[point];
  }
  return { particles: { ...particles, positions, colors, shade }, order: assignment };
}

/** Mean distance a grain travels from the sphere to its point (diagnostics and tests: lower is more orderly). */
export function meanTravel(particles: ModelParticles): number {
  const sphere = createSphere(particles.count, particleDefaults.geometry.radius).positions;
  let total = 0;
  for (let i = 0; i < particles.count; i++) {
    total += Math.hypot(particles.positions[i * 3] - sphere[i * 3], particles.positions[i * 3 + 1] - sphere[i * 3 + 1], particles.positions[i * 3 + 2] - sphere[i * 3 + 2]);
  }
  return total / particles.count;
}
