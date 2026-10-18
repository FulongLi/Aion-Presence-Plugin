import { materialOf, withPreset } from "./animation";
import { ANIMATION_TYPES, NODE_TYPES, type SceneDocument } from "./ir";

/**
 * Capability detection (v0.5): what a scene needs, what this Aion can actually do, and an honest verdict —
 * SUPPORTED, PARTIALLY_SUPPORTED or UNSUPPORTED — before anything is shown. A requirement is a name such as
 * "geometry:torus", "animation:orbit", "feature:labels" or "compute:magnetic-field". The scene's content implies most of
 * them; Codex declares the rest in `requirements` (what the user asked for that the scene alone does not show, such as
 * a field computation).
 *
 * v0.5 has no numerical backend: no field solver, circuit simulator, FEA, CFD or physics engine. A scene that *needs*
 * one (fidelity "measured") is UNSUPPORTED — never silently replaced by an animation. The same scene declared
 * "illustrative" is PARTIALLY_SUPPORTED: it is drawn, and always labelled as illustrative, not computed.
 */
export const CAPABILITY_STATUS = ["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED"] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUS[number];

export interface RuntimeCapabilities {
  /** The card runtime can run (WebGL 2): false, and nothing needing the card is supported. */
  card: boolean;
  body: boolean;
  /** Numerical backends available (none in v0.5; a future FreeCAD/OCCT or solver backend registers here). */
  compute: readonly string[];
  physics: readonly string[];
}

export const DEFAULT_RUNTIME: RuntimeCapabilities = Object.freeze({ card: true, body: true, compute: [], physics: [] });

/** What the generative scene runtime implements (everything else is unsupported or approximated). */
export const SUPPORTED_FEATURES = [
  "labels", "annotations", "metadata", "selection", "hierarchy", "transparency", "emissive", "wireframe", "timeline", "camera", "grid", "axes", "stars", "repeat", "units",
  // v0.5.1
  "styles", "material-presets", "shadows", "direct-editing",
] as const;
/** Rendering the card does (v0.5.1): a `render:` requirement for one of these is supported. */
export const SUPPORTED_RENDER = ["shadows", "environment-lighting", "pbr-materials", "styles"] as const;
/** Rendering features that are approximated when asked for (drawn, but not as asked). */
export const APPROXIMATED_RENDER: Record<string, string> = {
  "post-processing": "no post-processing (bloom, depth of field) is applied",
  bloom: "no bloom: emissive objects glow by their own colour only",
  textures: "surfaces use flat colours; image textures are not loaded into generated scenes",
  reflections: "reflections are of a neutral studio environment, not of the scene itself",
  refraction: "glass is drawn as a clear, reflective surface; light is not refracted",
  volumetric: "volumes are drawn as translucent surfaces or point clouds",
};
/** Assets a generated scene cannot load (the CAD viewer loads models; scenes have no network). */
const UNSUPPORTED_ASSETS: Record<string, string> = {
  "model-url": "generated scenes do not load models from URLs (the CAD viewer loads glTF/GLB models)",
  "texture-url": "generated scenes do not load images from URLs",
};

/** Plain words for a missing computational backend, for the model to pass on. */
export function backendWords(requirement: string): string {
  const name = requirement.split(":")[1] ?? requirement;
  const words: Record<string, string> = {
    "magnetic-field": "an accurate magnetic field computation needs a numerical field solver (FEM/BEM)",
    "magnetic-flux-density": "accurate magnetic flux density needs a numerical field solver (FEM/BEM) with the real geometry and materials",
    "electric-field": "an accurate electric field computation needs a numerical field solver",
    "circuit-simulation": "a validated circuit simulation needs a circuit simulator (SPICE-class)",
    fea: "stresses and deformations need a finite element (FEA) solver",
    cfd: "flow fields need a CFD solver",
    "thermal": "temperatures need a thermal solver",
    "orbital-mechanics": "accurate orbits need an ephemeris or an N-body integrator",
    "rigid-body": "physical motion with collisions needs a physics engine",
  };
  return words[name] ?? `${requirement.replace(":", " ")} needs a computational backend this Aion does not have`;
}

export interface CapabilityReport {
  status: CapabilityStatus;
  requested: string[];
  supported: string[];
  /** Drawn, but not as asked (with why). */
  approximated: { requirement: string; note: string }[];
  /** Not available at all (with why). */
  unsupported: { requirement: string; note: string }[];
  /** Notes the scene must carry when it is shown (added to its disclosure). */
  disclosures: string[];
  available: string[];
}

/** Every capability a document needs: implied by its content, plus what it declares. */
export function requirementsOf(doc: SceneDocument): string[] {
  const needs = new Set<string>();
  for (const n of doc.objects) {
    needs.add(`geometry:${n.type}`);
    if (n.label) needs.add("feature:labels");
    if (n.annotation) needs.add("feature:annotations");
    if (n.metadata) needs.add("feature:metadata");
    if (n.parent) needs.add("feature:hierarchy");
    if (n.repeat) needs.add("feature:repeat");
    const m = typeof n.material === "object" ? withPreset(n.material) : undefined;
    if (m?.opacity !== undefined && m.opacity < 1) needs.add("feature:transparency");
    if (m?.emissive || m?.emissiveIntensity) needs.add("feature:emissive");
    if (n.material !== undefined && materialOf(doc, n).preset) needs.add("feature:material-presets");
  }
  for (const raw of doc.materials ?? []) { const m = withPreset(raw); if (m.opacity !== undefined && m.opacity < 1) needs.add("feature:transparency"); if (m.emissive) needs.add("feature:emissive"); }
  if (doc.environment?.style) needs.add("feature:styles");
  for (const a of doc.animations ?? []) needs.add(`animation:${a.type}`);
  if (doc.animations?.length) needs.add("feature:timeline");
  for (const r of doc.requirements ?? []) needs.add(r);
  return [...needs].sort();
}

export function checkCapabilities(doc: SceneDocument, runtime: RuntimeCapabilities = DEFAULT_RUNTIME): CapabilityReport {
  const requested = requirementsOf(doc);
  const fidelity = doc.intent?.fidelity;
  const report: CapabilityReport = { status: "SUPPORTED", requested, supported: [], approximated: [], unsupported: [], disclosures: [], available: availableCapabilities(runtime) };
  for (const requirement of requested) {
    const [kind, name] = requirement.split(":") as [string, string];
    switch (kind) {
      case "geometry":
        if ((NODE_TYPES as readonly string[]).includes(name)) report.supported.push(requirement);
        else report.unsupported.push({ requirement, note: `"${name}" is not a geometry Aion builds` });
        break;
      case "animation":
        if ((ANIMATION_TYPES as readonly string[]).includes(name)) report.supported.push(requirement);
        else report.unsupported.push({ requirement, note: `"${name}" is not an animation Aion runs` });
        break;
      case "feature":
        if ((SUPPORTED_FEATURES as readonly string[]).includes(name)) report.supported.push(requirement);
        else report.approximated.push({ requirement, note: `${name} is not available; the scene is shown without it` });
        break;
      case "render":
        if ((SUPPORTED_RENDER as readonly string[]).includes(name) && runtime.card) report.supported.push(requirement);
        else if (APPROXIMATED_RENDER[name]) report.approximated.push({ requirement, note: APPROXIMATED_RENDER[name] });
        else report.approximated.push({ requirement, note: `${name} rendering is not available; the scene is shown without it` });
        break;
      case "asset":
        report.unsupported.push({ requirement, note: UNSUPPORTED_ASSETS[name] ?? `${name} assets are not available in generated scenes` });
        break;
      case "compute": case "physics": {
        const have = kind === "compute" ? runtime.compute : runtime.physics;
        if (have.includes(name)) { report.supported.push(requirement); break; }
        // Without a backend: an illustration is possible only when it is declared (and labelled) as one.
        if (fidelity === "measured" || fidelity === "approximate") report.unsupported.push({ requirement, note: backendWords(requirement) });
        else {
          report.approximated.push({ requirement, note: `${backendWords(requirement)}; this is an illustrative visualization, not a computed result` });
          report.disclosures.push("Illustrative visualization: not computed by a numerical solver.");
        }
        break;
      }
      default:
        report.unsupported.push({ requirement, note: "unknown capability" });
    }
  }
  if (!runtime.card) report.unsupported.push({ requirement: "render:webgl2", note: "this browser or host does not provide WebGL 2, so 3D cards cannot run here" });
  // A missing backend the result depends on (or no 3D at all) makes it unsupported; anything else missing is partial.
  const essential = report.unsupported.some(u => /^(compute|physics):/.test(u.requirement) || u.requirement === "render:webgl2");
  report.status = essential ? "UNSUPPORTED" : report.unsupported.length || report.approximated.length ? "PARTIALLY_SUPPORTED" : "SUPPORTED";
  report.disclosures = [...new Set(report.disclosures)];
  return report;
}

/** The capabilities this runtime offers, for the router's explanation. */
export function availableCapabilities(runtime: RuntimeCapabilities = DEFAULT_RUNTIME): string[] {
  return [
    ...(runtime.body ? ["mode:body"] : []), ...(runtime.card ? ["mode:card", "mode:hybrid"] : []),
    ...NODE_TYPES.map(t => `geometry:${t}`), ...ANIMATION_TYPES.map(t => `animation:${t}`), ...SUPPORTED_FEATURES.map(f => `feature:${f}`),
    ...(runtime.card ? SUPPORTED_RENDER.map(r => `render:${r}`) : []),
    ...runtime.compute.map(c => `compute:${c}`), ...runtime.physics.map(p => `physics:${p}`),
  ];
}
