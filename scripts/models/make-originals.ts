/**
 * Builds Aion's own original test models (v0.9) into plugins/aion-presence/assets/models/originals/: designed for this
 * project, so they carry no third-party rights and are safe to redistribute. They exercise what character models need —
 * ears or antennae, eyes, a tail, several material colours, vertex colours, disconnected parts — without depicting anyone
 * else's character.
 *
 *   npm run models:originals
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BufferGeometry} from "three";
import { CapsuleGeometry, CatmullRomCurve3, ConeGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, SphereGeometry, TorusGeometry,
  TubeGeometry, Vector3,
} from "three";
import type { ModelGeometry, ModelMaterial, ModelPrimitive } from "../../src/visual/models/geometry";
import { geometryToGlb } from "../../src/visual/models/writeGltf";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "plugins/aion-presence/assets/models/originals");

const hex = (value: string): [number, number, number, number] => [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255, 1];

class Builder {
  readonly materials: ModelMaterial[] = [];
  readonly primitives: ModelPrimitive[] = [];
  material(name: string, color: string) { this.materials.push({ name, color: hex(color), alphaMode: "OPAQUE" }); return this.materials.length - 1; }
  add(geometry: BufferGeometry, material: number, at: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1], colors?: (p: Vector3) => [number, number, number]) {
    const m = new Matrix4().compose(new Vector3(...at), new Quaternion().setFromEuler(new Euler(...rotation.map(d => d * Math.PI / 180) as [number, number, number])), new Vector3(...scale));
    geometry.applyMatrix4(m);
    const positions = new Float32Array(geometry.attributes.position.array as ArrayLike<number>);
    const indices = geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    let vertexColors: Float32Array | undefined;
    if (colors) {
      vertexColors = new Float32Array(positions.length / 3 * 4);
      for (let i = 0; i < positions.length / 3; i++) vertexColors.set([...colors(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])), 1], i * 4);
    }
    this.primitives.push({ positions, indices, uvs: [], ...(vertexColors ? { colors: vertexColors } : {}), material, node: this.primitives.length });
    geometry.dispose();
  }
  mirror(make: () => BufferGeometry, material: number, at: [number, number, number], rotation: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]) {
    this.add(make(), material, at, rotation, scale);
    this.add(make(), material, [-at[0], at[1], at[2]], [rotation[0], -rotation[1], -rotation[2]], scale);
  }
  geometry(): ModelGeometry { return { format: "glb", primitives: this.primitives, materials: this.materials, images: [], animations: [], skins: 0, warnings: [] }; }
}

/** Lumen: a small round creature with two antennae ending in glowing orbs, large eyes, short arms, a curled tail with a fin. */
function lumen(): ModelGeometry {
  const b = new Builder();
  const body = b.material("lumen-body", "#6fcfc4"), belly = b.material("lumen-belly", "#f2e6c8"), dark = b.material("lumen-eye", "#15161c");
  const shine = b.material("lumen-shine", "#ffffff"), orb = b.material("lumen-orb", "#ffc04d"), feet = b.material("lumen-feet", "#3f8f8a");
  const fin = b.material("lumen-fin", "#ffffff"), mouth = b.material("lumen-mouth", "#9a3b4a");
  b.add(new SphereGeometry(1, 64, 40), body, [0, 0.95, 0], [0, 0, 0], [0.9, 0.95, 0.82]);
  b.add(new SphereGeometry(1, 48, 32), belly, [0, 0.8, 0.42], [0, 0, 0], [0.58, 0.62, 0.42]);
  b.add(new SphereGeometry(0.7, 64, 40), body, [0, 2.05, 0.05]);
  // Eyes: large and dark, each with a highlight; set into the face.
  b.mirror(() => new SphereGeometry(0.2, 32, 20), dark, [0.26, 2.12, 0.6], [0, 0, 0], [1, 1.25, 0.55]);
  b.mirror(() => new SphereGeometry(0.06, 16, 10), shine, [0.21, 2.22, 0.71]);
  b.add(new TorusGeometry(0.1, 0.025, 10, 32, Math.PI), mouth, [0, 1.86, 0.66], [0, 0, 180]);
  // Antennae: thin curved stalks with glowing orbs.
  for (const side of [1, -1]) {
    const curve = new CatmullRomCurve3([new Vector3(0.25 * side, 2.6, 0), new Vector3(0.45 * side, 3.1, -0.05), new Vector3(0.75 * side, 3.4, 0.05)]);
    b.add(new TubeGeometry(curve, 48, 0.045, 10), feet);
    b.add(new SphereGeometry(0.16, 32, 20), orb, [0.78 * side, 3.45, 0.06]);
  }
  // Arms and feet.
  b.mirror(() => new CapsuleGeometry(0.13, 0.42, 6, 16), body, [0.78, 1.15, 0.18], [0, 0, 55]);
  b.mirror(() => new SphereGeometry(0.3, 32, 20), feet, [0.38, 0.12, 0.18], [0, 0, 0], [1, 0.45, 1.3]);
  // Tail: a curl behind, ending in a fin whose colour fades from amber to white (vertex colours).
  const tail = new CatmullRomCurve3([new Vector3(0, 0.55, -0.7), new Vector3(0, 0.35, -1.3), new Vector3(0, 0.75, -1.75), new Vector3(0, 1.25, -1.55)]);
  b.add(new TubeGeometry(tail, 64, 0.11, 12), body);
  b.add(new ConeGeometry(0.32, 0.8, 24, 1), fin, [0, 1.55, -1.45], [-25, 0, 0], [1, 1, 0.35], p => {
    const t = Math.max(0, Math.min(1, (p.y - 1.15) / 0.8));
    return [1, 0.75 + 0.25 * t, 0.3 + 0.7 * t];
  });
  // A small crest on the head.
  b.add(new CylinderGeometry(0.0, 0.09, 0.28, 12), orb, [0, 2.8, 0.05]);
  return b.geometry();
}

mkdirSync(out, { recursive: true });
const glb = geometryToGlb(lumen(), "lumen");
writeFileSync(join(out, "lumen.glb"), glb);
console.log(`lumen.glb: ${(glb.byteLength / 1024).toFixed(0)} KB`);
