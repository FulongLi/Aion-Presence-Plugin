import { SILVER_PALETTE, type ParticlePalette, type Rgb } from "../core/colors";

/**
 * The particles' colours as they change: a new palette is reached in about a second (eased per channel), so
 * "change your colour to blue" reads as the body itself changing colour, never a cut. Both renderers draw from it.
 */
export class PaletteEase {
  readonly current: ParticlePalette = structuredClone(SILVER_PALETTE);
  private target: ParticlePalette = structuredClone(SILVER_PALETTE);

  set(palette: ParticlePalette) { this.target = structuredClone(palette); }

  /** Jumps straight to the target (the first frame of a page, so a remembered colour does not fade in from silver). */
  settle() { for (const key of ["cool", "warm", "formed"] as const) this.current[key] = [...this.target[key]] as Rgb; }

  sample(dt: number): ParticlePalette {
    const k = 1 - Math.exp(-4 * Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0)));
    for (const key of ["cool", "warm", "formed"] as const) {
      const now = this.current[key], goal = this.target[key];
      for (let c = 0; c < 3; c++) now[c] += (goal[c] - now[c]) * k;
    }
    return this.current;
  }
}
