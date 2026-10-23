/**
 * v0.8 Simulation Core: a planar section through a tetrahedral mesh (marching tetrahedra). Every section vertex lies on a
 * mesh edge whose two nodes straddle the plane; it carries those two nodes and its position between them, so any nodal
 * field is interpolated there exactly as the linear elements define it (and so are probes on the section). Nothing is
 * smoothed or invented: where the plane misses the mesh, there is no section.
 */
export interface Section {
  /** Vertex positions (3 per vertex), three vertices per triangle. */
  positions: Float32Array;
  /** The two mesh nodes of each vertex's edge. */
  nodes: Uint32Array;
  /** Each vertex's weight of its second node (value = (1 − w)·a + w·b). */
  weights: Float32Array;
  /** The solid of each triangle. */
  solids: Uint32Array;
  triangles: number;
}

/** The section of the tetrahedra by the plane n·x = d (n need not be unit length). */
export function sliceTets(nodes: Float32Array, tets: Uint32Array, tetSolid: Uint32Array | null, n: [number, number, number], d: number, maxTriangles = 2_000_000): Section {
  const count = tets.length / 4;
  const positions: number[] = [], pairs: number[] = [], weights: number[] = [], solids: number[] = [];
  const s = [0, 0, 0, 0];
  const id = [0, 0, 0, 0];
  let triangles = 0;
  const vertex = (a: number, b: number, sa: number, sb: number) => {
    const w = sa / (sa - sb);
    for (let k = 0; k < 3; k++) positions.push(nodes[a * 3 + k] + w * (nodes[b * 3 + k] - nodes[a * 3 + k]));
    pairs.push(a, b);
    weights.push(w);
  };
  const triangle = (edges: [number, number][], solid: number) => {
    const start = positions.length;
    for (const [a, b] of edges) vertex(id[a], id[b], s[a], s[b]);
    // Wind the triangle so that it faces along n (consistent shading).
    const p = (k: number, c: number) => positions[start + k * 3 + c];
    const ux = p(1, 0) - p(0, 0), uy = p(1, 1) - p(0, 1), uz = p(1, 2) - p(0, 2), vx = p(2, 0) - p(0, 0), vy = p(2, 1) - p(0, 1), vz = p(2, 2) - p(0, 2);
    const facing = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    if (facing < 0) {
      for (let c = 0; c < 3; c++) { const t = positions[start + 3 + c]; positions[start + 3 + c] = positions[start + 6 + c]; positions[start + 6 + c] = t; }
      const v = pairs.length - 6;
      [pairs[v + 2], pairs[v + 4]] = [pairs[v + 4], pairs[v + 2]];
      [pairs[v + 3], pairs[v + 5]] = [pairs[v + 5], pairs[v + 3]];
      const w = weights.length - 3;
      [weights[w + 1], weights[w + 2]] = [weights[w + 2], weights[w + 1]];
    }
    solids.push(solid);
    triangles++;
  };
  for (let t = 0; t < count && triangles < maxTriangles; t++) {
    let above = 0;
    for (let k = 0; k < 4; k++) {
      const i = tets[t * 4 + k];
      id[k] = i;
      s[k] = nodes[i * 3] * n[0] + nodes[i * 3 + 1] * n[1] + nodes[i * 3 + 2] * n[2] - d;
      // A node exactly on the plane counts as above (no degenerate zero-length edges).
      if (s[k] >= 0) { s[k] = Math.max(s[k], 1e-30); above++; }
    }
    if (above === 0 || above === 4) continue;
    const up = [0, 1, 2, 3].filter(k => s[k] > 0), down = [0, 1, 2, 3].filter(k => s[k] < 0);
    const solid = tetSolid ? tetSolid[t] : 0;
    if (up.length === 1) triangle([[up[0], down[0]], [up[0], down[1]], [up[0], down[2]]], solid);
    else if (up.length === 3) triangle([[down[0], up[0]], [down[0], up[1]], [down[0], up[2]]], solid);
    else {
      const [a, b] = up, [c, e] = down;
      // The quad a–c, a–e, b–e, b–c (in cyclic order), as two triangles.
      triangle([[a, c], [a, e], [b, e]], solid);
      triangle([[a, c], [b, e], [b, c]], solid);
    }
  }
  return { positions: Float32Array.from(positions), nodes: Uint32Array.from(pairs), weights: Float32Array.from(weights), solids: Uint32Array.from(solids), triangles };
}

/** A nodal scalar at each section vertex. */
export function sectionValues(section: Section, values: ArrayLike<number>, components = 1, component = -1): Float32Array {
  const n = section.weights.length;
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const a = section.nodes[v * 2], b = section.nodes[v * 2 + 1], w = section.weights[v];
    if (components === 1) out[v] = (1 - w) * values[a] + w * values[b];
    else if (component >= 0) out[v] = (1 - w) * values[a * components + component] + w * values[b * components + component];
    else {
      let m = 0;
      for (let k = 0; k < components; k++) { const x = (1 - w) * values[a * components + k] + w * values[b * components + k]; m += x * x; }
      out[v] = Math.sqrt(m);
    }
  }
  return out;
}

/** The containing tetrahedron of a point and its barycentric weights (linear interpolation), or null outside. */
export function locate(nodes: Float32Array, tets: Uint32Array, p: [number, number, number]): { tet: number; nodes: number[]; weights: number[] } | null {
  const count = tets.length / 4;
  for (let t = 0; t < count; t++) {
    const ids = [tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]];
    let inside = true;
    for (let k = 0; k < 3 && inside; k++) {
      const lo = Math.min(...ids.map(i => nodes[i * 3 + k])), hi = Math.max(...ids.map(i => nodes[i * 3 + k]));
      const pad = (hi - lo) * 1e-6 + 1e-12;
      if (p[k] < lo - pad || p[k] > hi + pad) inside = false;
    }
    if (!inside) continue;
    const q = ids.map(i => [nodes[i * 3], nodes[i * 3 + 1], nodes[i * 3 + 2]]);
    const m = [0, 1, 2].map(r => [q[1][r] - q[0][r], q[2][r] - q[0][r], q[3][r] - q[0][r]]);
    const rhs = [p[0] - q[0][0], p[1] - q[0][1], p[2] - q[0][2]];
    const det3 = (x: number[][]) => x[0][0] * (x[1][1] * x[2][2] - x[1][2] * x[2][1]) - x[0][1] * (x[1][0] * x[2][2] - x[1][2] * x[2][0]) + x[0][2] * (x[1][0] * x[2][1] - x[1][1] * x[2][0]);
    const det = det3(m);
    if (det === 0) continue;
    const w = [0, 1, 2].map(k => det3(m.map((row, r) => row.map((x, c) => (c === k ? rhs[r] : x)))) / det);
    const weights = [1 - w[0] - w[1] - w[2], w[0], w[1], w[2]];
    if (weights.every(x => x >= -1e-7)) return { tet: t, nodes: ids, weights };
  }
  return null;
}
