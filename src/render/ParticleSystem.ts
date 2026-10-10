import { InstancedMesh, PlaneGeometry } from "three";
import { StorageInstancedBufferAttribute } from "three/webgpu";
import { Fn, float, instanceIndex, mix, sin, storage, vec3 } from "three/tsl";
import { SPECTRUM_BANDS } from "../core/audio";
import type { ParticleConfig } from "./particleDefaults";
import { createTargetPoints, type TargetPoints } from "../visual/points";
import type { MorphTarget } from "../visual/types";
import { createSphere } from "./sphere/createSphere";
import { createUniforms } from "./physics/uniforms";
import { createFigureLayout } from "../core/figure/layout";
import { createEyesLayout } from "../core/eyes/layout";
import { bodyWeight, eyesWeight, formedTarget, morphWeight } from "./physics/morph";
import { figureRest } from "./physics/figure";
import { eyesRest } from "./physics/eyes";
import { pusherForce } from "./physics/pusherPhysics";
import { presenceForce } from "./physics/presenceField";
import { integrateSpring } from "./physics/springPhysics";
import { createMaterial } from "./rendering/material";

export function createParticleSystem(capacity: number, config: ParticleConfig) {
  const sphere = createSphere(capacity, config.geometry.radius);
  const rest = storage(new StorageInstancedBufferAttribute(sphere.positions, 3), "vec3", capacity).toReadOnly();
  const seed = storage(new StorageInstancedBufferAttribute(sphere.seeds, 3), "vec3", capacity).toReadOnly();
  const offsets = storage(new StorageInstancedBufferAttribute(capacity, 3), "vec3", capacity);
  const velocities = storage(new StorageInstancedBufferAttribute(capacity, 3), "vec3", capacity);
  // The morph target is the rest shape of a Visual Action; the sphere remains the default rest.
  const targetPositions = new StorageInstancedBufferAttribute(new Float32Array(sphere.positions), 3);
  const targetTones = new StorageInstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
  const target = storage(targetPositions, "vec3", capacity).toReadOnly();
  const tones = storage(targetTones, "float", capacity).toReadOnly();
  // Aion's other bodies: every grain bound to the figure's skeleton (core/figure/layout.ts) and to an eye
  // (core/eyes/layout.ts). One buffer, four vec4 per particle (figure bind, local; eyes bind, local), so the
  // compute stage stays within WebGPU's default of eight storage buffers.
  const figure = createFigureLayout(capacity), eyes = createEyesLayout(capacity);
  const bodies = new Float32Array(capacity * 16);
  for (let i = 0; i < capacity; i++) {
    bodies.set(figure.bind.subarray(i * 4, i * 4 + 4), i * 16); bodies.set(figure.local.subarray(i * 4, i * 4 + 4), i * 16 + 4);
    bodies.set(eyes.bind.subarray(i * 4, i * 4 + 4), i * 16 + 8); bodies.set(eyes.local.subarray(i * 4, i * 4 + 4), i * 16 + 12);
  }
  const body = storage(new StorageInstancedBufferAttribute(bodies, 4), "vec4", capacity * 4).toReadOnly();
  const bodyInputs = () => {
    const base = instanceIndex.mul(4);
    return { bind: body.element(base), local: body.element(base.add(1)), eyesBind: body.element(base.add(2)), eyesLocal: body.element(base.add(3)) };
  };
  const u = createUniforms(config);
  const compute = Fn(() => {
    const r = rest.element(instanceIndex);
    const s = seed.element(instanceIndex);
    const o = offsets.element(instanceIndex);
    const v = velocities.element(instanceIndex);
    const m = morphWeight(r, u);
    // The persistent body is the rest a temporary visual forms from and returns to: sphere, figure or eyes.
    const inputs = bodyInputs();
    const b = bodyWeight(r, u), e = eyesWeight(r, u);
    const bodyRest = mix(mix(r, figureRest(inputs.bind, inputs.local, u).position, b), eyesRest(inputs.eyesBind, inputs.eyesLocal, u).position, e);
    const base = mix(bodyRest, formedTarget(target.element(instanceIndex), u), m);
    // The sphere's own field (breathing, listening, thinking, speech tufts) is shaped for a sphere. The figure
    // takes none of it (its strokes stay precise) and gets its body language from the pose instead.
    const sphereForce = presenceForce(r, s, u).mul(float(1).sub(m)).mul(float(1).sub(b)).mul(float(1).sub(e));
    // A formed visual action still breathes and answers speech, in a restrained way: a slow travelling
    // ripple plus a speech shimmer along the view axis (depth keeps the image legible), where each
    // column of the image follows one spectrum band and grains twinkle with articulation.
    const column = base.x.div(3.2).add(0.5).clamp(0, 0.999).mul(SPECTRUM_BANDS).floor().toInt();
    const twinkle = sin(s.x.mul(40).add(u.voicePhase.mul(9))).mul(u.voiceArticulation).mul(0.012);
    const shimmer = u.spectrum.element(column).mul(0.03).add(u.voiceBody.mul(0.022)).add(twinkle).mul(u.formedShimmer);
    // Listening and answering keep a formed visual alive too (a little deeper ripple), so it never freezes.
    const alive = float(1).add(u.responding.mul(0.9)).add(u.listeningAudio.mul(1.4));
    // A 3D object keeps only a trace of it: depth is its shape, not a ripple.
    const ripple = vec3(0, 0, sin(u.clock.mul(0.85).add(base.x.mul(2))).mul(0.016).mul(alive).add(shimmer))
      .mul(m).mul(float(1).sub(u.formedDepth.mul(0.8))).mul(u.stiffness).mul(u.motion);
    // The figure glimmers with the voice along the view axis, never scattering its outline.
    const glimmer = vec3(0, 0, u.voiceBody.mul(0.02).add(twinkle.mul(1.5)).add(sin(s.y.mul(30).add(u.clock.mul(5))).mul(u.listeningAudio).mul(0.01)))
      .mul(b.max(e).mul(float(1).sub(m))).mul(u.stiffness).mul(u.motion);
    const pointerScale = float(1).sub(m.mul(0.94));
    const force = pusherForce(base.add(o), s, u).mul(pointerScale).add(sphereForce).add(ripple).add(glimmer);
    integrateSpring(o, v, force, u);
  })().compute(capacity);
  // Camera-facing microdiscs preserve the original instanced material pipeline,
  // with six vertices per particle instead of a full polyhedron.
  const geometry = new PlaneGeometry(1, 1);
  // Read per instance from storage in the vertex stage: the material already uses every vertex buffer slot.
  const material = createMaterial(rest.toAttribute(), offsets.toAttribute(), target.toAttribute(), tones.toAttribute(), u, bodyInputs());
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.frustumCulled = false;
  // Targets sampled ahead of time (a director that knows its visuals); anything else is sampled on upload.
  const prepared = new WeakMap<object, TargetPoints>();
  return {
    mesh, compute, uniforms: u, capacity,
    prepare(value: MorphTarget) { if (!prepared.has(value.visual)) prepared.set(value.visual, createTargetPoints(value.visual, capacity)); },
    setTarget(value: MorphTarget) {
      const points = prepared.get(value.visual) ?? createTargetPoints(value.visual, capacity);
      targetPositions.array.set(points.positions); targetPositions.needsUpdate = true;
      targetTones.array.set(points.tones); targetTones.needsUpdate = true;
    },
    setCount(count: number) { mesh.count = count; compute.count = count; },
    dispose() { compute.dispose(); geometry.dispose(); material.dispose(); mesh.dispose(); },
  };
}
