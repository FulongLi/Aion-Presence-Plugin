import { checkCapabilities, DEFAULT_RUNTIME, type CapabilityReport, type RuntimeCapabilities } from "./capabilities";
import type { Fidelity, InteractionLevel, IntentKind, PresentationMode, SceneDocument } from "./ir";
import { toParticleScene, type ParticleAdaptation } from "./particleAdapter";

/**
 * Presentation Router 2.0 (v0.5): which representation a generated scene gets — BODY (Aion's particle body forms it),
 * CARD (an interactive Three.js scene beside the living body) or HYBRID (both). Codex has already interpreted the user;
 * its interpretation arrives as the scene's `intent` (kind, fidelity, interaction) and the scene itself. This router adds
 * no second model: it measures the scene's own evidence, checks what each representation can actually show, and applies
 * fixed rules, so the same scene always routes the same way, with every reason stated.
 *
 *   A  semantic concreteness  intent.kind, plus named, labelled, structured, measured objects
 *   B  visual fidelity        intent.fidelity, plus text, exact colours, meshes and surfaces the body cannot form
 *   C  interaction            intent.interaction, plus metadata to inspect, selectable parts, a timeline to control
 *   D  capabilities           what the particle adapter can form (fit) and whether the card can run at all
 *   E  preference             an explicit body / card / hybrid is honoured whenever it is possible
 *
 * Abstract, symbolic, look-only scenes the body forms well → BODY. Anything to inspect, edit, read or trust in detail →
 * CARD, or HYBRID when the body can also form it faithfully and the scene is a concrete object or system (the body forms
 * it for a moment while the card stays). An engineering scene is never dissolved into particles alone.
 */
export const ROUTE_MODES = ["body", "card", "hybrid"] as const;
export type RouteMode = typeof ROUTE_MODES[number];

export interface RouteSignals { concreteness: number; fidelity: number; interaction: number; bodyFit: number; text: boolean }

export interface SceneRoute {
  mode: RouteMode;
  reason: string;
  /** What was weighed (each 0…1). */
  signals: RouteSignals;
  requested: string[];
  available: string[];
  limitations: string[];
  capability: CapabilityReport;
  /** The particle form (for body and hybrid). */
  particle: ParticleAdaptation;
  /** How the change from what is on show now happens. */
  transition: { from: RouteMode | "none"; to: RouteMode; description: string };
}

export interface RouteInput {
  document: SceneDocument;
  /** An explicit preference from the user (through Codex); default auto (or the scene's own presentation.mode). */
  preference?: PresentationMode;
  /** What is on show now: none, the body forming something, or a card (a generated scene or another application). */
  current?: RouteMode | "none";
  runtime?: RuntimeCapabilities;
}

const KIND: Record<IntentKind, number> = { abstract: 0.15, concrete: 0.7, structural: 0.8, scientific: 0.75, engineering: 0.9 };
const FIDELITY: Record<Fidelity, number> = { symbolic: 0.1, illustrative: 0.4, approximate: 0.7, measured: 1 };
const INTERACTION: Record<InteractionLevel, number> = { none: 0, view: 0.3, inspect: 0.7, edit: 1 };
const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

/** The signals a scene carries, from Codex's declared intent and the scene's own content. */
export function routeSignals(doc: SceneDocument, particle: ParticleAdaptation): RouteSignals {
  const nodes = doc.objects.filter(n => n.type !== "group");
  const share = (count: number) => nodes.length ? count / nodes.length : 0;
  const named = share(nodes.filter(n => n.name || n.label).length);
  const described = share(nodes.filter(n => n.metadata || n.annotation).length);
  const structured = doc.objects.some(n => n.parent) ? 1 : 0;
  const measured = doc.units && doc.units.length !== "unit" ? 1 : 0;
  const text = doc.objects.some(n => n.type === "text" || n.label);
  const exact = doc.objects.some(n => n.type === "mesh" || n.type === "parametric" || n.type === "gear");
  // A: declared kind, nudged by evidence (named parts, hierarchy, units).
  const declaredKind = doc.intent ? KIND[doc.intent.kind] : 0.5;
  const concreteness = clamp(declaredKind * 0.7 + (named * 0.4 + structured * 0.3 + measured * 0.3) * 0.3);
  // B: declared fidelity, raised by what only exact rendering shows (text, exact surfaces).
  const declaredFidelity = doc.intent?.fidelity ? FIDELITY[doc.intent.fidelity] : 0.4;
  const fidelity = clamp(Math.max(declaredFidelity, text ? 0.6 : 0, exact ? 0.65 : 0));
  // C: declared interaction, raised by what there is to inspect or control.
  const declaredInteraction = doc.intent?.interaction ? INTERACTION[doc.intent.interaction] : 0.3;
  const timeline = (doc.animations?.length ?? 0) > 0 ? 0.4 : 0;
  const interaction = clamp(Math.max(declaredInteraction, described > 0 ? 0.6 : 0, timeline));
  return { concreteness, fidelity, interaction, bodyFit: particle.fit, text };
}

function describeTransition(from: RouteMode | "none", to: RouteMode): string {
  if (from === to) return to === "body" ? "the body re-forms into the new scene" : "the open card updates in place; the body stays beside it";
  switch (`${from}→${to}`) {
    case "none→body": return "the body forms the scene";
    case "none→card": return "the card opens beside the body, which steps aside and stays alive";
    case "none→hybrid": return "the body forms the scene for a moment while the card opens beside it";
    case "body→card": return "the body releases its form and steps aside as the card opens (no particle-to-mesh morph)";
    case "body→hybrid": return "the body keeps a particle form of the scene while the card opens beside it";
    case "card→body": return "the card closes and the body forms the scene";
    case "hybrid→body": return "the card closes; the body forms the scene";
    case "card→hybrid": return "the card stays; the body also forms the scene for a moment";
    case "hybrid→card": return "the card stays; the body returns to its own form beside it";
    default: return `${from} → ${to}`;
  }
}

/** Decides BODY, CARD or HYBRID for a scene, with the reasons. Pure and deterministic. */
export function routeScene(input: RouteInput): SceneRoute {
  const doc = input.document;
  const runtime = input.runtime ?? DEFAULT_RUNTIME;
  const capability = checkCapabilities(doc, runtime);
  const particle = toParticleScene(doc);
  const signals = routeSignals(doc, particle);
  const preference: PresentationMode = input.preference && input.preference !== "auto" ? input.preference : doc.presentation?.mode ?? "auto";
  const bodyPossible = runtime.body && particle.scene !== null && particle.fit > 0;
  const cardPossible = runtime.card;
  const limitations: string[] = [];
  const decide = (mode: RouteMode, reason: string): SceneRoute => {
    if (mode !== "card") limitations.push(...particle.limitations.map(l => `body: ${l}`));
    if (mode !== "body") limitations.push(...capability.approximated.map(a => a.note));
    const from = input.current ?? "none";
    return {
      mode, reason, signals, requested: capability.requested, available: capability.available, limitations: [...new Set(limitations)], capability, particle,
      transition: { from, to: mode, description: describeTransition(from, mode) },
    };
  };
  // E: an explicit preference, whenever it is possible.
  if (preference === "body") {
    if (bodyPossible) {
      if (signals.interaction >= 0.7) limitations.push("the body cannot be selected or inspected; ask for a card to inspect it");
      return decide("body", "requested: the body forms it");
    }
    if (cardPossible) return decide("card", `requested the body, but the particle body cannot form this scene (${particle.limitations[0] ?? "nothing it can form"}): a card instead`);
  }
  if (preference === "card" && cardPossible) return decide("card", "requested: an interactive card");
  if (preference === "hybrid") {
    if (cardPossible && bodyPossible) return decide("hybrid", "requested: the body forms it while the card shows it");
    if (cardPossible) return decide("card", "requested a hybrid, but the body cannot form this scene: a card only");
  }
  // D: what can run at all.
  if (!cardPossible) return bodyPossible ? decide("body", "no 3D card can run here (no WebGL 2): the body forms what it can") : decide("body", "neither representation can show this scene here");
  // A–C: the deterministic rules.
  const engineering = doc.intent?.kind === "engineering";
  const needsCard = signals.interaction >= 0.5 || signals.fidelity >= 0.6 || engineering;
  if (!needsCard && signals.concreteness < 0.45 && bodyPossible && particle.fit >= 0.6) {
    return decide("body", "abstract and look-only: the particle body expresses it");
  }
  if (!needsCard && bodyPossible && particle.fit >= 0.6) {
    return decide("hybrid", "a concrete scene the body forms well, kept as an interactive card beside it");
  }
  if (bodyPossible && particle.fit >= 0.75 && signals.concreteness >= 0.45 && !engineering && signals.fidelity < 0.9) {
    return decide("hybrid", "concrete and to be explored: the body forms it for a moment while the card stays for interaction");
  }
  const why = engineering ? "an engineering scene" : signals.interaction >= 0.5 ? "it is to be inspected or edited" : signals.fidelity >= 0.6 ? "it needs exact shapes, text or colours" : "the body cannot form it faithfully";
  return decide("card", `an interactive card: ${why}`);
}
