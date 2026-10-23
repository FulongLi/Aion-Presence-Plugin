import type { SimFace, SimGeometry, Vec3 } from "../../src/sim/geometry";

/**
 * v0.8 test fixtures: synthetic analysis geometries shaped exactly like the FreeCAD worker's `sim_geometry` output
 * (faces numbered, interface faces shared by two solids, outward normals, a two-triangle tessellation per face). They
 * exercise the core's logic only; the real geometry comes from FreeCAD in the real-toolchain tests.
 */
interface BoxSpec { body: string; label?: string; min: Vec3; max: Vec3 }

/** Boxes placed along X (touching boxes share their interface face, numbered once, as OpenCASCADE does). */
export function boxesGeometry(boxes: BoxSpec[], revision = 1, document = "cad-test01"): SimGeometry {
  const faces: SimFace[] = [];
  const surface: { index: number; positions: number[]; indices: number[] }[] = [];
  const key = (c: Vec3) => c.map(v => v.toFixed(6)).join(",");
  const seen = new Map<string, SimFace>();
  boxes.forEach((b, i) => {
    const s = i + 1;
    const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
    const sides: { normal: Vec3; corners: Vec3[] }[] = [
      { normal: [-1, 0, 0], corners: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]] },
      { normal: [1, 0, 0], corners: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]] },
      { normal: [0, -1, 0], corners: [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]] },
      { normal: [0, 1, 0], corners: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] },
      { normal: [0, 0, -1], corners: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]] },
      { normal: [0, 0, 1], corners: [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]] },
    ];
    for (const side of sides) {
      const c = side.corners;
      const center: Vec3 = [0, 1, 2].map(k => c.reduce((sum, p) => sum + p[k], 0) / 4) as Vec3;
      const e1 = [0, 1, 2].map(k => c[1][k] - c[0][k]), e2 = [0, 1, 2].map(k => c[3][k] - c[0][k]);
      const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      const shared = seen.get(key(center));
      if (shared && Math.abs(shared.area_mm2 - area) < 1e-9) { shared.solids.push(s); continue; }
      const face: SimFace = {
        index: faces.length + 1, solids: [s], body: b.body, bodyLabel: b.label ?? b.body, feature: b.body, featureLabel: b.label ?? b.body,
        surface: "plane", area_mm2: area, center, normal: side.normal,
        bbox: { min: [0, 1, 2].map(k => Math.min(...c.map(p => p[k]))) as Vec3, max: [0, 1, 2].map(k => Math.max(...c.map(p => p[k]))) as Vec3 },
      };
      faces.push(face);
      seen.set(key(center), face);
      surface.push({ index: face.index, positions: c.flat(), indices: [0, 1, 2, 0, 2, 3] });
    }
  });
  const min: Vec3 = [0, 1, 2].map(k => Math.min(...boxes.map(b => b.min[k]))) as Vec3, max: Vec3 = [0, 1, 2].map(k => Math.max(...boxes.map(b => b.max[k]))) as Vec3;
  return {
    format: "aion.sim.geometry/1", backend: "test", document, documentName: "Test model", revision, units: "mm",
    bodies: boxes.map((b, i) => ({ id: b.body, label: b.label ?? b.body, solids: [i + 1], bbox: { min: b.min, max: b.max } })),
    solids: boxes.map((b, i) => ({ index: i + 1, body: b.body, bodyLabel: b.label ?? b.body, volume_mm3: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]), bbox: { min: b.min, max: b.max }, center: [0, 1, 2].map(k => (b.min[k] + b.max[k]) / 2) as Vec3 })),
    faces, bbox: { min, max }, surface: { faces: surface },
  };
}

/** A copper busbar (100 × 10 × 5 mm) and an aluminium tab (20 × 10 × 5 mm) touching at x = 100. */
export const busbarAndTab = (revision = 1) => boxesGeometry([
  { body: "Busbar", min: [0, 0, 0], max: [100, 10, 5] },
  { body: "Tab", min: [100, 0, 0], max: [120, 10, 5] },
], revision);

/** The unit cube split into six tetrahedra (Kuhn), as an ASCII MSH 2.2 file in metres with its 12 boundary triangles. */
export function cubeMsh(size = 0.001): string {
  const p: Vec3[] = [];
  for (let i = 0; i < 8; i++) p.push([(i & 1) * size, ((i >> 1) & 1) * size, ((i >> 2) & 1) * size]);
  const tets = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];
  // Faces: x=0 → 1, x=1 → 2, y=0 → 3, y=1 → 4, z=0 → 5, z=1 → 6 (two triangles each).
  const quads: [number, number, number, number, number][] = [[1, 0, 2, 6, 4], [2, 1, 5, 7, 3], [3, 0, 4, 5, 1], [4, 2, 3, 7, 6], [5, 0, 1, 3, 2], [6, 4, 6, 7, 5]];
  const lines = ["$MeshFormat", "2.2 0 8", "$EndMeshFormat", "$Nodes", "8", ...p.map((q, i) => `${i + 1} ${q.join(" ")}`), "$EndNodes", "$Elements"];
  const elements: string[] = [];
  for (const [face, a, b, c, d] of quads) {
    elements.push(`2 2 ${face} ${face} ${a + 1} ${b + 1} ${c + 1}`, `2 2 ${face} ${face} ${a + 1} ${c + 1} ${d + 1}`);
  }
  for (const t of tets) elements.push(`4 2 1 1 ${t.map(i => i + 1).join(" ")}`);
  lines.push(String(elements.length), ...elements.map((e, i) => `${i + 1} ${e}`), "$EndElements", "");
  return lines.join("\n");
}
