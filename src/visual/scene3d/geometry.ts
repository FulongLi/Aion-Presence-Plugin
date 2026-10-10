import {
  BoxGeometry, CatmullRomCurve3, ConeGeometry, CylinderGeometry, EdgesGeometry, Euler, Matrix4, Quaternion, RingGeometry,
  SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from "three";
import type { BufferGeometry } from "three";
import type { Scene3D, SceneDetail, SceneObject, Vec3 } from "./types";

/**
 * Builds a validated scene's geometry with Three.js: every object (and every repeated copy) becomes world-space
 * triangles (its surfaces) and line segments (its edges, rims and outlines; or the object itself for a line, curve or
 * helix). Detail is fixed here, never chosen by the scene, so the work per object is bounded.
 */
export interface ScenePart {
  /** Triangles, 9 floats each (three vertices). */
  triangles: Float32Array;
  /** Segments, 6 floats each (two points). */
  segments: Float32Array;
  /** Share of this object's particles on its surfaces (the rest on its segments). */
  surfaceShare: number;
  tone: number;
  /** Relative share of the scene's particles. */
  weight: number;
}

const DEFAULT_DETAIL: Record<SceneObject["type"], SceneDetail> = {
  box: "both", pyramid: "both", cylinder: "both", cone: "both", sphere: "surface", torus: "surface", ring: "surface", tube: "surface",
  line: "edges", curve: "edges", helix: "edges",
};
const v3 = (p: Vec3) => new Vector3(p[0], p[1], p[2]);
const deg = (value: number) => value * Math.PI / 180;

function polyline(points: Vector3[]): Float32Array {
  const out = new Float32Array((points.length - 1) * 6);
  for (let i = 1; i < points.length; i++) out.set([points[i - 1].x, points[i - 1].y, points[i - 1].z, points[i].x, points[i].y, points[i].z], (i - 1) * 6);
  return out;
}
const concat = (arrays: Float32Array[]) => {
  const out = new Float32Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
};

/** A sphere's guide lines (latitudes and meridians): they let its turning be seen. */
function sphereGuides(radius: number): Float32Array {
  const lines: Float32Array[] = [];
  for (const latitude of [-60, -30, 0, 30, 60]) {
    const y = Math.sin(deg(latitude)) * radius, r = Math.cos(deg(latitude)) * radius;
    lines.push(polyline(Array.from({ length: 97 }, (_, i) => new Vector3(Math.cos(i / 96 * Math.PI * 2) * r, y, Math.sin(i / 96 * Math.PI * 2) * r))));
  }
  for (let m = 0; m < 6; m++) {
    const a = m / 6 * Math.PI;
    lines.push(polyline(Array.from({ length: 97 }, (_, i) => {
      const t = i / 96 * Math.PI * 2;
      return new Vector3(Math.cos(a) * Math.sin(t) * radius, Math.cos(t) * radius, Math.sin(a) * Math.sin(t) * radius);
    })));
  }
  return concat(lines);
}

/** One object's local geometry (before its transform): its mesh, if any, and its own outline segments. */
function primitive(object: SceneObject): { mesh: BufferGeometry | null; lines: Float32Array; edges: boolean } {
  switch (object.type) {
    case "box": return { mesh: new BoxGeometry(...object.size), lines: new Float32Array(), edges: true };
    case "sphere": return { mesh: new SphereGeometry(object.radius, 48, 24), lines: sphereGuides(object.radius), edges: false };
    case "pyramid": {
      const sides = object.sides ?? 4;
      // `base` is the width of a side; a square pyramid's sides face the axes.
      const mesh = new ConeGeometry(object.base / (2 * Math.sin(Math.PI / sides)), object.height, sides, 1);
      mesh.rotateY(Math.PI / sides);
      return { mesh, lines: new Float32Array(), edges: true };
    }
    case "cylinder": return { mesh: new CylinderGeometry(object.radiusTop ?? object.radius, object.radius, object.height, 48, 1), lines: new Float32Array(), edges: true };
    case "cone": return { mesh: new ConeGeometry(object.radius, object.height, 48, 1), lines: new Float32Array(), edges: true };
    case "torus": return { mesh: new TorusGeometry(object.radius, object.tube, 24, 96), lines: new Float32Array(), edges: false };
    case "ring": {
      const mesh = new RingGeometry(object.inner, object.outer, 96, 2);
      mesh.rotateX(-Math.PI / 2);
      return { mesh, lines: new Float32Array(), edges: true };
    }
    case "line": return { mesh: null, lines: polyline([v3(object.from), v3(object.to)]), edges: false };
    case "tube": return { mesh: new TubeGeometry(new CatmullRomCurve3(object.points.map(v3), object.closed ?? false), 160, object.radius, 12, object.closed ?? false), lines: new Float32Array(), edges: false };
    case "curve": return { mesh: null, lines: polyline(new CatmullRomCurve3(object.points.map(v3), object.closed ?? false).getPoints(240)), edges: false };
    case "helix": {
      const phase = deg(object.phase ?? 0), steps = Math.max(64, Math.round(object.turns * 96));
      return {
        mesh: null, edges: false,
        lines: polyline(Array.from({ length: steps + 1 }, (_, i) => {
          const s = i / steps, a = phase + s * object.turns * Math.PI * 2;
          return new Vector3(Math.cos(a) * object.radius, (s - 0.5) * object.height, Math.sin(a) * object.radius);
        })),
      };
    }
  }
}

function transformed(values: Float32Array, matrix: Matrix4): Float32Array {
  const out = new Float32Array(values.length), v = new Vector3();
  for (let i = 0; i < values.length; i += 3) { v.set(values[i], values[i + 1], values[i + 2]).applyMatrix4(matrix); out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; }
  return out;
}

function triangles(mesh: BufferGeometry): Float32Array {
  const flat = mesh.index ? mesh.toNonIndexed() : mesh;
  return new Float32Array(flat.attributes.position.array as ArrayLike<number>);
}

/** The scene's parts, in its own (unnormalized) world coordinates. */
export function buildScene(scene: Scene3D): ScenePart[] {
  const parts: ScenePart[] = [];
  for (const object of scene.objects) {
    const local = primitive(object);
    const surface = local.mesh ? triangles(local.mesh) : new Float32Array();
    const edges = local.mesh && local.edges ? new Float32Array(new EdgesGeometry(local.mesh, 25).attributes.position.array as ArrayLike<number>) : new Float32Array();
    local.mesh?.dispose();
    const outline = concat([edges, local.lines]);
    const detail = object.detail ?? DEFAULT_DETAIL[object.type];
    const hasSurface = surface.length > 0, hasLines = outline.length > 0;
    let surfaceShare = detail === "surface" ? 1 : detail === "edges" ? 0 : 0.55;
    // A sphere drawn as a surface keeps a little of its guides; whatever an object lacks, the other part takes.
    if (detail === "surface" && object.type === "sphere") surfaceShare = 0.86;
    if (!hasLines) surfaceShare = 1;
    if (!hasSurface) surfaceShare = 0;
    const count = object.repeat?.count ?? 1;
    const position = v3(object.position ?? [0, 0, 0]), rotation = object.rotation ?? [0, 0, 0];
    const scale = typeof object.scale === "number" ? new Vector3(object.scale, object.scale, object.scale) : v3(object.scale ?? [1, 1, 1]);
    for (let k = 0; k < count; k++) {
      const step = object.repeat;
      const at = position.clone().add(v3(step?.offset ?? [0, 0, 0]).multiplyScalar(k));
      const turn = rotation.map((value, i) => deg(value + (step?.rotation?.[i] ?? 0) * k)) as Vec3;
      const grow = Math.pow(step?.scale ?? 1, k);
      const matrix = new Matrix4().compose(at, new Quaternion().setFromEuler(new Euler(turn[0], turn[1], turn[2], "XYZ")), scale.clone().multiplyScalar(grow));
      parts.push({
        triangles: surfaceShare > 0 ? transformed(surface, matrix) : new Float32Array(),
        segments: surfaceShare < 1 ? transformed(outline, matrix) : new Float32Array(),
        surfaceShare, tone: object.tone ?? 0.85, weight: object.weight ?? 1,
      });
    }
  }
  return parts;
}
