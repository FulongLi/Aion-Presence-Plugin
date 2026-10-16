import {
  BoxGeometry, BufferGeometry, CatmullRomCurve3, ConeGeometry, CylinderGeometry, Euler, ExtrudeGeometry, Float32BufferAttribute, Matrix4, PlaneGeometry, Quaternion, RingGeometry,
  Shape, SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PointsSpec, SceneNode, Vec3 } from "../../../scene/ir";
import { pathPoints } from "../../../scene/paths";

/**
 * Geometry for the generative scene (v0.5): one Three.js BufferGeometry per Scene IR node, built only from validated
 * numbers (src/scene/validate.ts). Paths are built from exactly the points src/scene/paths.ts gives, so an object moving
 * along a curve stays on the drawn curve. Every function here is deterministic (point clouds use a seeded generator).
 */
export type GeometryClass = "mesh" | "line" | "line-loop" | "points" | "sprite" | "none";

export function geometryClass(node: SceneNode): GeometryClass {
  switch (node.type) {
    case "group": return "none";
    case "line": case "polyline": case "curve": return node.type !== "line" && node.closed ? "line-loop" : "line";
    case "circle": return "line-loop";
    case "helix": return node.tube ? "mesh" : "line";
    case "points": return "points";
    case "text": return "sprite";
    default: return "mesh";
  }
}

const v = (p: Vec3) => new Vector3(p[0], p[1], p[2]);
const DEG = Math.PI / 180;

/** A seeded generator (deterministic point clouds). */
function random(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Particle positions for a point cloud (flow animations move them along their path afterwards). */
export function pointPositions(spec: PointsSpec, pathOf: (id: string) => Vec3[] | null): Float32Array {
  const out = new Float32Array(spec.count * 3), rand = random(spec.seed ?? 7);
  const put = (i: number, p: Vec3) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; };
  const r = spec.radius ?? 1, size = spec.size ?? [1, 1, 1];
  const path = spec.distribution === "path" && spec.path ? pathOf(spec.path) : null;
  const side = Math.max(1, Math.round(Math.cbrt(spec.count)));
  for (let i = 0; i < spec.count; i++) {
    switch (spec.distribution) {
      case "sphere": { const u = rand() * 2 - 1, t = rand() * Math.PI * 2, k = Math.cbrt(rand()) * r, q = Math.sqrt(1 - u * u); put(i, [k * q * Math.cos(t), k * u, k * q * Math.sin(t)]); break; }
      case "shell": { const u = rand() * 2 - 1, t = rand() * Math.PI * 2, q = Math.sqrt(1 - u * u); put(i, [r * q * Math.cos(t), r * u, r * q * Math.sin(t)]); break; }
      case "box": put(i, [(rand() - 0.5) * size[0], (rand() - 0.5) * size[1], (rand() - 0.5) * size[2]]); break;
      case "disc": { const k = Math.sqrt(rand()) * r, t = rand() * Math.PI * 2; put(i, [k * Math.cos(t), 0, k * Math.sin(t)]); break; }
      case "ring": { const inner = spec.inner ?? r * 0.8, k = Math.sqrt(inner * inner + rand() * (r * r - inner * inner)), t = rand() * Math.PI * 2; put(i, [k * Math.cos(t), (rand() - 0.5) * (r - inner) * 0.08, k * Math.sin(t)]); break; }
      case "line": { const a = spec.from!, b = spec.to!, t = spec.count > 1 ? i / (spec.count - 1) : 0.5; put(i, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); break; }
      case "grid": {
        const x = i % side, y = Math.floor(i / side) % side, z = Math.floor(i / (side * side));
        const at = (n: number, s: number) => side > 1 ? (n / (side - 1) - 0.5) * s : 0;
        put(i, [at(x, size[0]), at(y, size[1]), at(z, size[2])]);
        break;
      }
      case "spiral": { const t = i / spec.count, a = t * Math.PI * 2 * 3 + (i % 2) * Math.PI, k = t * r; put(i, [k * Math.cos(a) + (rand() - 0.5) * r * 0.06, (rand() - 0.5) * r * 0.04, k * Math.sin(a) + (rand() - 0.5) * r * 0.06]); break; }
      case "path": {
        if (!path?.length) { put(i, [0, 0, 0]); break; }
        const at = path[Math.min(path.length - 1, Math.floor((i / spec.count) * path.length))];
        put(i, at);
        break;
      }
    }
  }
  return out;
}

function gearShape(radius: number, teeth: number, inner?: number): Shape {
  const root = radius * (1 - 2.4 / teeth), shape = new Shape();
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2, step = (Math.PI * 2) / teeth;
    const pts: [number, number][] = [[root, a], [radius, a + step * 0.18], [radius, a + step * 0.48], [root, a + step * 0.66]];
    pts.forEach(([r, t], k) => { const x = r * Math.cos(t), y = r * Math.sin(t); if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y); });
  }
  shape.closePath();
  if (inner && inner > 0) {
    const hole = new Shape();
    hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return shape;
}

function surfaceHeight(node: SceneNode, x: number, z: number): number {
  const a = node.amplitude ?? 0.5, f = node.frequency ?? 1, half = Math.max(node.width!, node.depth!) / 2, r = Math.hypot(x, z);
  switch (node.surface!) {
    case "wave": return a * Math.sin(f * x) * Math.cos(f * z);
    case "ripple": return a * Math.cos(f * r) / (1 + r * 0.6);
    case "saddle": return a * (x * x - z * z) / (half * half);
    case "paraboloid": return a * (x * x + z * z) / (half * half);
    case "sinc": return r * f < 1e-6 ? a : a * Math.sin(f * r) / (f * r);
    case "gaussian": return a * Math.exp(-(r * r) * f * f / Math.max(1e-6, half * half) * 4);
  }
}

/** Builds a node's geometry, or null for a group. Throws only on an internal failure (the compiler reports it). */
export function buildGeometry(node: SceneNode, pathOf: (id: string) => Vec3[] | null): BufferGeometry | null {
  switch (node.type) {
    case "group": case "text": return null;
    case "sphere": return new SphereGeometry(node.radius!, 48, 32);
    case "box": return new BoxGeometry(...node.size!);
    case "cylinder": return new CylinderGeometry(node.radiusTop ?? node.radius!, node.radius!, node.height!, 64);
    case "cone": return new ConeGeometry(node.radius!, node.height!, 64);
    case "torus": return new TorusGeometry(node.radius!, node.tube!, 24, 96, (node.arc ?? 360) * DEG);
    case "plane": return new PlaneGeometry(node.width!, node.depth!).rotateX(-Math.PI / 2);
    case "ring": return new RingGeometry(node.inner!, node.outer!, 128).rotateX(-Math.PI / 2);
    case "parametric": {
      const res = node.resolution ?? 64, g = new PlaneGeometry(node.width!, node.depth!, res, res).rotateX(-Math.PI / 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, surfaceHeight(node, p.getX(i), p.getZ(i)));
      g.computeVertexNormals();
      return g;
    }
    case "mesh": {
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(node.positions!, 3));
      if (node.indices) g.setIndex(node.indices);
      g.computeVertexNormals();
      return g;
    }
    case "gear": {
      const g = new ExtrudeGeometry(gearShape(node.radius!, node.teeth!, node.inner), { depth: node.thickness!, bevelEnabled: false, curveSegments: 6 });
      // Centred on its axis, the axis along y (it turns like a wheel lying flat; spin's default axis).
      g.translate(0, 0, -node.thickness! / 2).rotateX(-Math.PI / 2);
      return g;
    }
    case "arrow": {
      const from = v(node.from!), to = v(node.to!), dir = to.clone().sub(from), length = dir.length();
      const shaft = node.radius ?? Math.max(1e-4, length * 0.02), head = Math.min(length * 0.3, shaft * 8);
      const body = new CylinderGeometry(shaft, shaft, Math.max(1e-4, length - head), 24).translate(0, (length - head) / 2, 0);
      const tip = new ConeGeometry(shaft * 2.6, head, 24).translate(0, length - head / 2, 0);
      const merged = mergeGeometries([body, tip])!;
      body.dispose(); tip.dispose();
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
      merged.applyMatrix4(new Matrix4().compose(from, q, new Vector3(1, 1, 1)));
      return merged;
    }
    case "tube": case "helix": {
      const path = pathPoints(node)!;
      if (node.type === "helix" && !node.tube) return new BufferGeometry().setFromPoints(path.points.map(v));
      const curve = new CatmullRomCurve3(path.points.map(v), path.closed, "catmullrom", 0.5);
      return new TubeGeometry(curve, Math.min(2048, Math.max(16, path.points.length * 2)), node.type === "tube" ? node.radius! : node.tube!, 12, path.closed);
    }
    case "line": case "polyline": case "curve": case "circle": {
      const path = pathPoints(node)!;
      return new BufferGeometry().setFromPoints(path.points.map(v));
    }
    case "points": {
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(pointPositions(node.particles!, pathOf), 3));
      return g;
    }
  }
}

/** The matrix of copy `i` of a repeated node (offset, turn and scale accumulate step by step). */
export function repeatMatrix(node: SceneNode, i: number): Matrix4 {
  const r = node.repeat!;
  const offset = r.offset ? new Vector3(...r.offset).multiplyScalar(i) : new Vector3();
  const turn = r.rotation ? new Quaternion().setFromEuler(new Euler(r.rotation[0] * DEG * i, r.rotation[1] * DEG * i, r.rotation[2] * DEG * i, "XYZ")) : new Quaternion();
  const s = (r.scale ?? 1) ** i;
  return new Matrix4().compose(offset, turn, new Vector3(s, s, s));
}
