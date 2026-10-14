/**
 * Figure 3.0's secondary motion (v0.4.4): each limb's flesh lags a little behind fast movement and settles after it —
 * follow-through, restrained. The lag is an offset of the limb's middle (its ends — hands, feet, the neck, the pelvis —
 * stay exactly where the pose puts them, so contacts and IK are untouched), uploaded per limb and applied along the
 * limb with a sin(πs) profile (render/physics/figure.ts).
 *
 * Two sources, the same response:
 *   live motion    an underdamped follower of each limb's middle, integrated at a fixed 240 Hz (frame-rate independent)
 *   a performance  a time-pure filter: the same impulse response applied to the limb's middle at past moments of the
 *                  scene, so a replay, a pause or a seek always gives exactly the same frame
 */
export const SECONDARY = {
  /** Natural frequency (rad/s) and damping ratio of the response: a soft, slightly elastic settle. */
  omega: 9.5,
  damping: 0.6,
  /** How much of the lag shows, and its bound (normalized units, before the figure's scale). */
  gain: 0.75,
  max: 0.05,
  /** The filter's taps for a performance: every `step` seconds into the past, `taps` of them. */
  step: 0.035,
  taps: 14,
  substep: 1 / 240,
} as const;

type Vec = [number, number, number];

/** The response's impulse weights at the filter's taps (they sum to 1; later taps may be negative: the overshoot). */
export const SECONDARY_WEIGHTS: readonly number[] = (() => {
  const { omega, damping, step, taps } = SECONDARY;
  const wd = omega * Math.sqrt(1 - damping * damping);
  const raw = Array.from({ length: taps }, (_, i) => { const t = (i + 1) * step; return Math.exp(-damping * omega * t) * Math.sin(wd * t); });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(w => w / sum);
})();

const clampLength = (v: Vec, max: number): Vec => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > max ? [v[0] * max / l, v[1] * max / l, v[2] * max / l] : v;
};

/**
 * A performance's lag for each limb: gain × Σ wₖ (middle(t − k·step) − middle(t)), bounded. `past[k]` holds the
 * middles k + 1 steps ago (null where the scene had not begun: the middle then counts as where it is now).
 */
export function performedLag(now: readonly Vec[], past: readonly (readonly Vec[] | null)[]): Vec[] {
  return now.map((middle, limb) => {
    const sum: Vec = [0, 0, 0];
    SECONDARY_WEIGHTS.forEach((w, k) => {
      const then = past[k]?.[limb] ?? middle;
      for (let i = 0; i < 3; i++) sum[i] += w * (then[i] - middle[i]);
    });
    return clampLength([sum[0] * SECONDARY.gain, sum[1] * SECONDARY.gain, sum[2] * SECONDARY.gain], SECONDARY.max);
  });
}

/** Live motion: an underdamped follower per limb middle; the lag is gain × (follower − middle), bounded. */
export class SecondaryMotion {
  private follow: Vec[] | null = null;
  private velocity: Vec[] = [];
  private last: Vec[] | null = null;

  /** Advances by `dt` toward the new middles (interpolated across the frame) and returns each limb's lag. */
  update(dt: number, middles: readonly Vec[]): Vec[] {
    if (!this.follow || !this.last || this.follow.length !== middles.length) {
      this.follow = middles.map(m => [...m] as Vec);
      this.velocity = middles.map(() => [0, 0, 0] as Vec);
      this.last = middles.map(m => [...m] as Vec);
      return middles.map(() => [0, 0, 0] as Vec);
    }
    const { omega, damping, substep } = SECONDARY;
    const steps = Math.max(0, Math.min(48, Math.round(Math.max(0, dt) / substep)));
    for (let s = 1; s <= steps; s++) {
      const k = s / steps;
      middles.forEach((middle, limb) => {
        const goal = [0, 1, 2].map(i => this.last![limb][i] + (middle[i] - this.last![limb][i]) * k);
        for (let i = 0; i < 3; i++) {
          const v = this.velocity[limb][i] + (omega * omega * (goal[i] - this.follow![limb][i]) - 2 * damping * omega * this.velocity[limb][i]) * substep;
          this.velocity[limb][i] = v;
          this.follow![limb][i] += v * substep;
        }
      });
    }
    this.last = middles.map(m => [...m] as Vec);
    return middles.map((middle, limb) => clampLength([0, 1, 2].map(i => (this.follow![limb][i] - middle[i]) * SECONDARY.gain) as Vec, SECONDARY.max));
  }

  reset() { this.follow = null; this.last = null; }
}
