import type { MorphTarget } from "../visual/types";

/**
 * Plays a formed model's own animation clip (v0.9, see visual/models/animation.ts): the baked frames as a loop, each
 * moment interpolated between its two frames, so the particles follow the character's genuine motion at any frame rate.
 * Returns new places only while a clip is playing (and once more, the rest pose, when it stops). Shared by the WebGPU and
 * canvas renderers.
 */
export class ModelPlayback {
  private time = 0;
  private wasPlaying = false;
  private buffer = new Float32Array(0);

  reset(target: MorphTarget | null) { this.time = 0; this.wasPlaying = target?.visual.kind === "model" && target.visual.playing === true; }

  sample(target: MorphTarget | null, dt: number): { positions: Float32Array; count: number } | null {
    const visual = target?.visual;
    if (visual?.kind !== "model") { this.wasPlaying = false; return null; }
    const { frames, fps, count, positions } = visual.particles;
    const playing = visual.playing === true && frames.length >= 2 && fps > 0;
    if (!playing) {
      if (!this.wasPlaying) return null;
      this.wasPlaying = false;
      return { positions, count };
    }
    this.wasPlaying = true;
    this.time = (this.time + Math.max(0, dt)) % (frames.length / fps);
    const at = this.time * fps, k = Math.floor(at) % frames.length, s = at - Math.floor(at);
    const a = frames[k], b = frames[(k + 1) % frames.length];
    if (this.buffer.length !== a.length) this.buffer = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) this.buffer[i] = a[i] + (b[i] - a[i]) * s;
    return { positions: this.buffer, count };
  }
}
