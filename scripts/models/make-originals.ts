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
import { CapsuleGeometry, CatmullRomCurve3, ConeGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, TubeGeometry, Vector3 } from "three";
import { BOUNCE_SECONDS, bounceMorphs, placed, RigBuilder, softBounce } from "../lib/rig";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "plugins/aion-presence/assets/models/originals");

/**
 * Lumen: a small round creature with two antennae ending in glowing orbs, large eyes, short arms, a curled tail with a fin.
 * v0.9.1: rigged (root, body, crown, antennae, tail) with squash and stretch morph targets and a looping "Bounce" clip — the
 * redistributable fixture for soft-body animation.
 */
function lumen(): Uint8Array {
  const rig = new RigBuilder();
  rig.morph("squash"); rig.morph("stretch");
  const root = rig.bone("root", null, [0, 0, 0]);
  const body = rig.bone("body", root, [0, 0.95, 0]);
  const crown = rig.bone("crown", body, [0, 2.6, 0]);
  const antennaL = rig.bone("antenna.L", crown, [0.25, 2.6, 0]), antennaR = rig.bone("antenna.R", crown, [-0.25, 2.6, 0]);
  const tail = rig.bone("tail", body, [0, 0.55, -0.7]);
  const skin = (bone: number) => () => [[bone, 1]] as [number, number][];
  const soft = { squash: bounceMorphs.squash, stretch: bounceMorphs.stretch };
  const m = {
    body: rig.material("lumen-body", "#6fcfc4"), belly: rig.material("lumen-belly", "#f2e6c8"), eye: rig.material("lumen-eye", "#15161c"),
    shine: rig.material("lumen-shine", "#ffffff"), orb: rig.material("lumen-orb", "#ffc04d"), feet: rig.material("lumen-feet", "#3f8f8a"),
    fin: rig.material("lumen-fin", "#ffffff"), mouth: rig.material("lumen-mouth", "#9a3b4a"),
  };
  rig.part(placed(new SphereGeometry(1, 64, 40), [0, 0.95, 0], [0, 0, 0], [0.9, 0.95, 0.82]), m.body, skin(body), soft);
  rig.part(placed(new SphereGeometry(1, 48, 32), [0, 0.8, 0.42], [0, 0, 0], [0.58, 0.62, 0.42]), m.belly, skin(body), soft);
  rig.part(placed(new SphereGeometry(0.7, 64, 40), [0, 2.05, 0.05]), m.body, skin(body), soft);
  for (const side of [1, -1]) {
    rig.part(placed(new SphereGeometry(0.2, 32, 20), [0.26 * side, 2.12, 0.6], [0, 0, 0], [1, 1.25, 0.55]), m.eye, skin(body), soft);
    rig.part(placed(new SphereGeometry(0.06, 16, 10), [0.21 * side, 2.22, 0.71]), m.shine, skin(body), soft);
    const antenna = side > 0 ? antennaL : antennaR;
    rig.part(new TubeGeometry(new CatmullRomCurve3([new Vector3(0.25 * side, 2.6, 0), new Vector3(0.45 * side, 3.1, -0.05), new Vector3(0.75 * side, 3.4, 0.05)]), 48, 0.045, 10), m.feet, skin(antenna));
    rig.part(placed(new SphereGeometry(0.16, 32, 20), [0.78 * side, 3.45, 0.06]), m.orb, skin(antenna));
    rig.part(placed(new CapsuleGeometry(0.13, 0.42, 6, 16), [0.78 * side, 1.15, 0.18], [0, 0, 55 * side]), m.body, skin(body), soft);
    rig.part(placed(new SphereGeometry(0.3, 32, 20), [0.38 * side, 0.12, 0.18], [0, 0, 0], [1, 0.45, 1.3]), m.feet, skin(root));
  }
  rig.part(placed(new TorusGeometry(0.1, 0.025, 10, 32, Math.PI), [0, 1.86, 0.66], [0, 0, 180]), m.mouth, skin(body), soft);
  rig.part(new TubeGeometry(new CatmullRomCurve3([new Vector3(0, 0.55, -0.7), new Vector3(0, 0.35, -1.3), new Vector3(0, 0.75, -1.75), new Vector3(0, 1.25, -1.55)]), 64, 0.11, 12), m.body, skin(tail));
  rig.part(placed(new ConeGeometry(0.32, 0.8, 24, 1), [0, 1.55, -1.45], [-25, 0, 0], [1, 1, 0.35]), m.fin, skin(tail), {}, p => {
    const t = Math.max(0, Math.min(1, (p.y - 1.15) / 0.8));
    return [1, 0.75 + 0.25 * t, 0.3 + 0.7 * t];
  });
  rig.part(placed(new CylinderGeometry(0.0, 0.09, 0.28, 12), [0, 2.8, 0.05]), m.orb, skin(crown));
  rig.clip("Bounce", BOUNCE_SECONDS, 48, softBounce({ root, crown: { bone: crown, height: 2.6 }, appendages: [{ bone: antennaL, side: -1 }, { bone: antennaR, side: 1 }, { bone: tail, side: 0, gain: -0.6 }], height: 0.9 }));
  return rig.toGlb();
}

mkdirSync(out, { recursive: true });
const glb = lumen();
writeFileSync(join(out, "lumen.glb"), glb);
console.log(`lumen.glb: ${(glb.byteLength / 1024).toFixed(0)} KB`);
