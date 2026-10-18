import type { SceneDocument, VisualStyle } from "./ir";
import { sceneStats } from "./validate";

/**
 * Visual styles (v0.5.1): how a generated scene is lit and staged — never what is in it. A style is a small table of
 * rendering numbers (background, light intensities, environment reflections, exposure, shadows, ground) that the
 * generative scene card applies to whatever scene it builds; a transformer and a solar system go through the same
 * engine. The document may name a style (`environment.style`) and override any part of it (background, ambient, light,
 * shadows, ground, grid); otherwise the scene's intent picks one. Pure and deterministic (tested without a browser).
 */
export interface StyleSpec {
  background: string;
  /** Light or dark backdrop (labels and panels follow it). */
  tone: "dark" | "light";
  ambient: number;
  key: { intensity: number; color: string };
  fill: number;
  rim: number;
  /** Image-based reflections from a neutral studio environment (0: none — space scenes). */
  environment: number;
  exposure: number;
  shadows: boolean;
  ground: boolean;
  /** Shadow darkness on the ground (0…1). */
  shadowOpacity: number;
  grid: boolean;
}

export const STYLE_SPECS: Record<VisualStyle, StyleSpec> = {
  scientific: { background: "#05070b", tone: "dark", ambient: 0.35, key: { intensity: 2.2, color: "#ffffff" }, fill: 0.45, rim: 0.5, environment: 0.25, exposure: 1, shadows: false, ground: false, shadowOpacity: 0.35, grid: false },
  engineering: { background: "#0c1016", tone: "dark", ambient: 0.22, key: { intensity: 2.6, color: "#fff8f0" }, fill: 0.75, rim: 1, environment: 0.85, exposure: 1, shadows: true, ground: true, shadowOpacity: 0.45, grid: true },
  minimal: { background: "#eceef1", tone: "light", ambient: 0.55, key: { intensity: 2, color: "#ffffff" }, fill: 0.9, rim: 0.25, environment: 0.7, exposure: 0.95, shadows: true, ground: true, shadowOpacity: 0.22, grid: false },
  presentation: { background: "#0f1217", tone: "dark", ambient: 0.28, key: { intensity: 2.8, color: "#fff6ea" }, fill: 0.7, rim: 1.4, environment: 1, exposure: 1.08, shadows: true, ground: true, shadowOpacity: 0.5, grid: false },
  cinematic: { background: "#030405", tone: "dark", ambient: 0.1, key: { intensity: 3.2, color: "#ffe2c0" }, fill: 0.25, rim: 1.8, environment: 0.45, exposure: 1.15, shadows: true, ground: false, shadowOpacity: 0.6, grid: false },
};

/** Above this many estimated triangles, shadows stay off unless the scene asks for them (each shadow is another pass). */
export const SHADOW_TRIANGLE_BUDGET = 250_000;

export interface ResolvedStyle extends StyleSpec {
  name: VisualStyle;
  /** Whether the style was named by the scene or picked from its intent. */
  source: "scene" | "intent";
  /** Why shadows are off when the style would have them (said in the scene's state). */
  shadowNote?: string;
}

/** The style a scene's intent implies when it names none. */
export function defaultStyle(doc: SceneDocument): VisualStyle {
  switch (doc.intent?.kind) {
    case "engineering": case "structural": return "engineering";
    case "scientific": return "scientific";
    case "abstract": return "cinematic";
    default: return "presentation";
  }
}

/** The style a scene is rendered with: its named or implied style, refined by its own environment fields. */
export function resolveStyle(doc: SceneDocument): ResolvedStyle {
  const env = doc.environment ?? {};
  const name = env.style ?? defaultStyle(doc);
  const spec = STYLE_SPECS[name];
  const resolved: ResolvedStyle = { ...spec, key: { ...spec.key }, name, source: env.style ? "scene" : "intent" };
  if (env.background) { resolved.background = env.background; resolved.tone = lightness(env.background) > 0.6 ? "light" : "dark"; }
  if (env.ambient !== undefined) resolved.ambient = env.ambient;
  if (env.light === false) { resolved.key.intensity = 0; resolved.fill = 0; resolved.rim = 0; }
  if (env.grid !== undefined) resolved.grid = env.grid;
  // Space (stars) and a scene lit by one of its own objects (a sun) have no studio around them: no reflections of one,
  // no ground, no key-light shadow.
  const space = env.stars === true || env.lightSource !== undefined;
  if (space) { resolved.environment = Math.min(resolved.environment, 0.15); resolved.ground = false; }
  if (env.ground !== undefined) resolved.ground = env.ground;
  let shadows = env.shadows ?? (resolved.shadows && !space);
  if (env.shadows === undefined && shadows && sceneStats(doc).triangles > SHADOW_TRIANGLE_BUDGET) {
    shadows = false;
    resolved.shadowNote = `shadows off: about ${sceneStats(doc).triangles.toLocaleString("en")} triangles (over ${SHADOW_TRIANGLE_BUDGET.toLocaleString("en")})`;
  }
  if (env.light === false && shadows) { shadows = false; resolved.shadowNote = "shadows off: the key light is off"; }
  resolved.shadows = shadows;
  return resolved;
}

/** Perceived lightness of a #rrggbb colour, 0…1. */
function lightness(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
