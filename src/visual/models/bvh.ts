/**
 * A compact bounding-volume hierarchy over a model's triangles (v0.9) for one question: does a ray from a surface point
 * leave the model without hitting anything? The sampler uses it to drop points no one could see — the inside of a head
 * under an embedded eye, mouth interiors, hidden helper faces — which would otherwise show through the particle surface
 * as noise. Arrays only (no objects per node); any-hit traversal with early exit.
 */
export class TriangleBvh {
  private readonly tri: Float32Array; // 9 floats per triangle, reordered by the tree
  private readonly bounds: Float32Array; // 6 floats per node (min xyz, max xyz)
  private readonly nodes: Int32Array; // 3 ints per node: left child (or −1 for a leaf), right child / first triangle, triangle count
  private nodeCount = 0;

  constructor(triangles: Float32Array, leafSize = 6) {
    const count = triangles.length / 9;
    const order = new Uint32Array(count).map((_, i) => i);
    const centroids = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) centroids[i * 3 + k] = (triangles[i * 9 + k] + triangles[i * 9 + 3 + k] + triangles[i * 9 + 6 + k]) / 3;
    const maxNodes = Math.max(1, Math.ceil(count / leafSize) * 2 + 1) * 2;
    this.bounds = new Float32Array(maxNodes * 6);
    this.nodes = new Int32Array(maxNodes * 3);
    const build = (start: number, end: number): number => {
      const node = this.nodeCount++;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
      for (let i = start; i < end; i++) {
        const t = order[i] * 9;
        for (let v = 0; v < 9; v += 3) {
          const x = triangles[t + v], y = triangles[t + v + 1], z = triangles[t + v + 2];
          if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
        }
        const c = order[i] * 3, cx = centroids[c], cy = centroids[c + 1], cz = centroids[c + 2];
        if (cx < cminX) cminX = cx; if (cy < cminY) cminY = cy; if (cz < cminZ) cminZ = cz;
        if (cx > cmaxX) cmaxX = cx; if (cy > cmaxY) cmaxY = cy; if (cz > cmaxZ) cmaxZ = cz;
      }
      this.bounds.set([minX, minY, minZ, maxX, maxY, maxZ], node * 6);
      const n = end - start;
      const spread = [cmaxX - cminX, cmaxY - cminY, cmaxZ - cminZ];
      const axis = spread[0] >= spread[1] && spread[0] >= spread[2] ? 0 : spread[1] >= spread[2] ? 1 : 2;
      if (n <= leafSize || spread[axis] <= 0) {
        this.nodes[node * 3] = -1; this.nodes[node * 3 + 1] = start; this.nodes[node * 3 + 2] = n;
        return node;
      }
      // Median split on the widest centroid axis (quickselect: linear per level, not a full sort).
      const mid = start + (n >> 1);
      let lo = start, hi = end - 1;
      while (lo < hi) {
        const pivot = centroids[order[(lo + hi) >>> 1] * 3 + axis];
        let i = lo, j = hi;
        while (i <= j) {
          while (centroids[order[i] * 3 + axis] < pivot) i++;
          while (centroids[order[j] * 3 + axis] > pivot) j--;
          if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
        }
        if (mid <= j) hi = j; else if (mid >= i) lo = i; else break;
      }
      const left = build(start, mid);
      const right = build(mid, end);
      this.nodes[node * 3] = left; this.nodes[node * 3 + 1] = right; this.nodes[node * 3 + 2] = 0;
      return node;
    };
    if (count) build(0, count);
    this.tri = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) this.tri.set(triangles.subarray(order[i] * 9, order[i] * 9 + 9), i * 9);
  }

  /** True when the ray (origin, unit direction) hits any triangle farther than `near`. */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, near: number): boolean {
    if (!this.nodeCount) return false;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const stack = new Int32Array(128);
    let top = 0;
    stack[top++] = 0;
    const b = this.bounds, nodes = this.nodes, t = this.tri;
    while (top) {
      const node = stack[--top];
      // Slab test.
      let t0 = ((ix >= 0 ? b[node * 6] : b[node * 6 + 3]) - ox) * ix;
      let t1 = ((ix >= 0 ? b[node * 6 + 3] : b[node * 6]) - ox) * ix;
      const ty0 = ((iy >= 0 ? b[node * 6 + 1] : b[node * 6 + 4]) - oy) * iy;
      const ty1 = ((iy >= 0 ? b[node * 6 + 4] : b[node * 6 + 1]) - oy) * iy;
      if (ty0 > t0) t0 = ty0; if (ty1 < t1) t1 = ty1;
      const tz0 = ((iz >= 0 ? b[node * 6 + 2] : b[node * 6 + 5]) - oz) * iz;
      const tz1 = ((iz >= 0 ? b[node * 6 + 5] : b[node * 6 + 2]) - oz) * iz;
      if (tz0 > t0) t0 = tz0; if (tz1 < t1) t1 = tz1;
      if (!(t1 >= Math.max(t0, near))) continue;
      const left = nodes[node * 3];
      if (left >= 0) {
        if (top + 2 > stack.length) return true;
        stack[top++] = left; stack[top++] = nodes[node * 3 + 1];
        continue;
      }
      const first = nodes[node * 3 + 1], count = nodes[node * 3 + 2];
      for (let i = first; i < first + count; i++) {
        const k = i * 9;
        const e1x = t[k + 3] - t[k], e1y = t[k + 4] - t[k + 1], e1z = t[k + 5] - t[k + 2];
        const e2x = t[k + 6] - t[k], e2y = t[k + 7] - t[k + 1], e2z = t[k + 8] - t[k + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - t[k], sy = oy - t[k + 1], sz = oz - t[k + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (hit > near) return true;
      }
    }
    return false;
  }
}
