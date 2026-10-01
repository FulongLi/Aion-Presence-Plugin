import { ACESFilmicToneMapping, PerspectiveCamera, Scene, type Vector4 } from "three";
import { WebGPURenderer } from "three/webgpu";
import { particleDefaults, type ParticleConfig } from "./particleDefaults";
import type { BodySource } from "../core/aion";
import type { PresenceSignalSource } from "../core/signal";
import type { MorphTarget } from "../visual/types";
import { morphSpeechBlend } from "./morphBlend";
import { AdaptiveQuality, qualityRange, qualityTiers } from "./quality";
import { createParticleSystem } from "./ParticleSystem";
import { PointerPusher } from "./interaction/pointer";
import { syncUniforms } from "./physics/uniforms";
import { createPostFX } from "./rendering/postfx";
import { SpeechMotion } from "./speechMotion";

/** What the runtime reads each frame. It knows nothing about the host, MCP, hooks or tools. */
export interface MorphSource { sample(dt: number): number; readonly revision: number; readonly target: MorphTarget | null }
/**
 * `body` is Aion's persistent body (sphere or figure, see core/body.ts), the rest every temporary visual
 * forms from and returns to.
 */
export interface RuntimeInputs { presence: PresenceSignalSource; morph: MorphSource; body: BodySource }

export interface RuntimeOptions {
  /** A fixed quality tier for the whole session: no adaptive changes. */
  tier?: number;
  /** Pointer interaction with the body. Default true. */
  interactive?: boolean;
  /** Calm the body under prefers-reduced-motion. Default true. */
  reducedMotion?: boolean;
}

export interface QualityReport { tier: number; ceiling: number; count: number; effects: boolean; frameMs: number }

export interface RuntimeHandle {
  readonly backend: "webgpu" | "canvas";
  readonly config: ParticleConfig;
  /** Development tuning: copy `config` into uniforms every frame. */
  tuning: boolean;
  quality(): QualityReport;
  setTier(tier: number): void;
  dispose(): void;
}

const STEP = 1 / 120;

/**
 * The WebGPU particle body from SCF Presence: compute-shader physics at a fixed 120 Hz step, instanced
 * microdisc particles and bloom, with adaptive quality. Throws "webgpu-unavailable" / "webgpu-failed" when
 * the browser cannot run it; the caller then falls back to the canvas renderer (see render/index.ts).
 */
export async function createParticleRuntime(
  container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, onError: (message: string) => void,
  options: RuntimeOptions = {},
): Promise<RuntimeHandle | undefined> {
  if (!navigator.gpu) throw new Error("webgpu-unavailable");
  const config = structuredClone(particleDefaults);
  const renderer = new WebGPURenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  try { await renderer.init(); } catch { renderer.dispose(); throw new Error("webgpu-failed"); }
  if (lifetime.aborted) { renderer.dispose(); return; }
  if (!("isWebGPUBackend" in renderer.backend)) { renderer.dispose(); throw new Error("webgpu-unavailable"); }
  renderer.setClearColor(0x090e16, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 40);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const fixed = options.tier === undefined ? null : Math.max(0, Math.min(qualityTiers.length - 1, Math.round(options.tier)));
  const range = fixed === null ? qualityRange(coarse, navigator.hardwareConcurrency || 4, memory) : { initial: fixed, max: fixed };
  const quality = new AdaptiveQuality(range.initial, range.max);
  // Buffers are sized for the session ceiling so the tier can rise without reallocation.
  const system = createParticleSystem(qualityTiers[range.max].count, config);
  system.setCount(quality.settings().count);
  scene.add(system.mesh);
  const u = system.uniforms;
  const speechMotion = new SpeechMotion();
  const fx = createPostFX(renderer, scene, camera, config);
  const pointer = options.interactive === false ? null : new PointerPusher(container, camera);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const calm = () => options.reducedMotion !== false && reducedMotion.matches;
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.append(renderer.domElement);
  let stopped = false, frame = 0, revision = -1, accumulator = 0, frameMs = 16.7, spinAngle = 0;
  let last = performance.now();
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    const extent = (config.geometry.radius + config.spring.maxOffset) * 1.07;
    camera.position.z = Math.max(7.4, extent / (Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect)));
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, quality.settings().pixelRatio));
    renderer.setSize(width, height);
  };
  const applyQuality = () => { system.setCount(quality.settings().count); resize(); };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    pointer?.dispose();
    fx.post.dispose(); fx.scenePass.dispose(); fx.glow.dispose();
    system.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    document.removeEventListener("visibilitychange", visibility);
    lifetime.removeEventListener("abort", cleanup);
  };
  const visibility = () => { last = performance.now(); accumulator = 0; pointer?.reset(); };
  document.addEventListener("visibilitychange", visibility);
  lifetime.addEventListener("abort", cleanup, { once: true });
  renderer.onDeviceLost = () => { if (!stopped) { cleanup(); onError("device-lost"); } };

  /** One frame: presence and morph inputs, fixed-step physics, then the (post-processed) render. */
  const step = (dt: number, now: number) => {
    accumulator = Math.min(accumulator + dt, STEP * 8);
    if (handle.tuning) {
      syncUniforms(u, config);
      fx.glow.strength.value = config.bloom.strength;
      fx.glow.radius.value = config.bloom.radius; fx.glow.threshold.value = config.bloom.threshold;
    }
    const presence = inputs.presence.sample(dt, now);
    const morph = inputs.morph.sample(dt);
    // The controller only replaces its target while the body is at rest, so this upload never snaps.
    if (revision !== inputs.morph.revision) {
      revision = inputs.morph.revision;
      spinAngle = 0;
      if (inputs.morph.target) {
        try { system.setTarget(inputs.morph.target); } catch { /* invalid targets are rejected upstream */ }
      }
    }
    u.morph.value = morph;
    const body = inputs.body.sample(dt, now, calm());
    u.bodyMorph.value = body.level;
    u.figureOrbit.value = body.orbit;
    const anchors = u.anchors.array as Vector4[];
    for (let i = 0; i < anchors.length; i++) anchors[i].fromArray(body.anchors, i * 4);
    // A spinning visual (MorphTarget.motion) turns slowly about the view axis; each new target starts upright.
    const spin = inputs.morph.target?.motion?.spin ?? 0;
    if (morph > 0 && Number.isFinite(spin) && spin !== 0) spinAngle = (spinAngle + spin * dt * (calm() ? 0.15 : 1)) % (Math.PI * 2);
    u.formedAngle.value = spinAngle;
    const blend = morphSpeechBlend(morph);
    u.speechGain.value = blend.speech; u.formedShimmer.value = blend.shimmer;
    for (let i = 0; i < presence.assistantBands.length; i++) u.spectrum.array[i] = presence.assistantBands[i];
    const speech = speechMotion.sample(presence.assistantAmplitude, dt);
    u.voiceBody.value = speech.body; u.voiceArticulation.value = speech.articulation;
    u.voiceAccent.value = speech.accent; u.voiceFollow.value = speech.follow;
    u.voicePhase.value = speech.phase;
    u.voiceDirection.value.set(speech.directionX, speech.directionY, speech.directionZ);
    u.attention.value = presence.focus;
    u.focusPulse.value = presence.acousticFocus;
    u.thinking.value = presence.thinking;
    u.listeningAudio.value = presence.userAmplitude;
    u.energy.value = presence.energy;
    u.warmth.value = presence.warmth;
    u.motion.value = calm() ? 0.15 : 1;
    try {
      while (accumulator >= STEP) {
        if (pointer) {
          pointer.step(STEP, config.pusher.follow, config.pusher.maxSpeed);
          u.pusherPosition.value.copy(pointer.position);
          u.pusherVelocity.value.copy(pointer.velocity);
        }
        u.active.value = pointer?.active ? (calm() ? 0.25 : 1) : 0;
        u.clock.value += STEP;
        renderer.compute(system.compute);
        if (stopped) return false;
        accumulator -= STEP;
      }
      // Bloom is a secondary effect: it is the first thing adaptive quality gives up.
      if (quality.effects) fx.post.render(); else renderer.render(scene, camera);
    } catch {
      if (!stopped) { cleanup(); onError("device-lost"); }
      return false;
    }
    return true;
  };

  const handle: RuntimeHandle = {
    backend: "webgpu", config, tuning: false,
    quality: () => ({ tier: quality.tier, ceiling: quality.ceiling, count: quality.settings().count, effects: quality.effects, frameMs }),
    setTier(tier) { quality.force(Math.min(range.max, tier)); applyQuality(); },
    dispose: cleanup,
  };
  const animate = (now: number) => {
    if (stopped) return;
    const rawDt = (now - last) / 1000;
    last = now;
    if (!document.hidden) {
      const dt = Math.min(Math.max(rawDt, 0), STEP * 8);
      if (rawDt > 0 && rawDt < 0.15) frameMs += (rawDt * 1000 - frameMs) * 0.05;
      if (fixed === null && quality.sample(rawDt)) applyQuality();
      if (!step(dt, now / 1000)) return;
    }
    if (!stopped) frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  return handle;
}
