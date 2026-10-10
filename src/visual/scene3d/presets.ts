import type { Scene3D } from "./types";

/**
 * Curated scenes, written in the same schema Codex uses (and validated like any other): reliable answers to the most
 * common requests and worked examples of composition. Conceptual geometry, not measured models.
 */
export const SCENE_PRESETS = {
  /** A square-based pyramid in the proportions of the Great Pyramid of Giza (height ≈ 0.64 × base). */
  pyramid: {
    title: "Egyptian pyramid", tilt: 18,
    objects: [{ type: "pyramid", base: 2.3, height: 1.46, sides: 4, detail: "both", tone: 0.9 }],
  },
  /** Saturn: the planet, its rings in two bands with the Cassini division between them, tilted about 27°. */
  saturn: {
    title: "Saturn", tilt: 12,
    objects: [
      { type: "sphere", radius: 1, tone: 0.82 },
      { type: "ring", inner: 1.24, outer: 1.62, rotation: [27, 0, 0], tone: 0.8, weight: 1.35 },
      { type: "ring", inner: 1.68, outer: 2.05, rotation: [27, 0, 0], tone: 0.92, weight: 1.5 },
    ],
  },
  /** DNA: two helical backbones half a turn apart, joined by base-pair rungs. */
  dna: {
    title: "DNA double helix", tilt: 8,
    objects: [
      { type: "helix", radius: 0.55, height: 3.6, turns: 2.5, phase: 0, tone: 0.95, weight: 1.2 },
      { type: "helix", radius: 0.55, height: 3.6, turns: 2.5, phase: 180, tone: 0.95, weight: 1.2 },
      {
        type: "line", from: [-0.55, -1.8, 0], to: [0.55, -1.8, 0], tone: 0.6, weight: 0.12,
        repeat: { count: 26, offset: [0, 0.144, 0], rotation: [0, -36, 0] },
      },
    ],
  },
} satisfies Record<string, Scene3D>;

export type ScenePreset = keyof typeof SCENE_PRESETS;
export const SCENE_PRESET_NAMES = Object.keys(SCENE_PRESETS) as ScenePreset[];
