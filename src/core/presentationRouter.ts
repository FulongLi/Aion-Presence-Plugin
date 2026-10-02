import type { PresentationContent } from "./presentation";

/**
 * The Presentation Router: how a piece of information reaches the user while Aion is open.
 *
 *   BODY     Aion's particle body itself becomes the information, holds it, and returns to its persistent body.
 *            For what particles carry well: forms, constellations, zodiac and Tao symbols, terrain relief, a clock,
 *            one key number, a short word, a symbol, an emoji.
 *   CARD     A quiet, high-fidelity card beside the body, for what must stay exact or recognizable: longer text,
 *            code, tables, file changes, results, screenshots, detailed photographs. The body keeps living.
 *   HYBRID   Both, when that materially helps: a recognizable portrait forms in particles while the original
 *            photograph stands beside it; a relief forms while the card gives the exact map and numbers.
 *
 * This module is policy only: deterministic, with no rendering and no host. The model may state a preference
 * (`auto`, the default, or `body`, `card`, `hybrid`); the policy honours it when it is valid and overrides it
 * when it is clearly wrong (3000 characters never become particles; a photograph the user wants to inspect is
 * never dissolved into them). Surfaces render whatever route was decided; they do not decide again.
 */
export const PRESENTATION_PREFERENCES = ["auto", "body", "card", "hybrid"] as const;
export type PresentationPreference = typeof PRESENTATION_PREFERENCES[number];
export const PRESENTATION_ROUTES = ["body", "card", "hybrid"] as const;
export type PresentationRoute = typeof PRESENTATION_ROUTES[number];

/** What the current surface can show. Both are true on every surface today; the router never assumes it. */
export interface PresentationCapabilities { body: boolean; card: boolean }
export const ALL_CAPABILITIES: PresentationCapabilities = Object.freeze({ body: true, card: true });

export type RouteReason =
  /** auto: the information is native to the particle body. */
  | "body-native"
  /** auto: exactness or recognizability matters more than transformation. */
  | "fidelity"
  /** auto: a recognizable portrait — the particle portrait and the original photograph together. */
  | "portrait-hybrid"
  /** auto: a looked-up, high-resolution picture — a particle impression and the picture itself. */
  | "picture-hybrid"
  /** auto: the picture is too small to be worth a card of its own. */
  | "low-resolution"
  /** The user wants to inspect detail: the picture is shown exactly, not as particles. */
  | "detail-requested"
  /** The requested route was valid and is used. */
  | "requested"
  /** The request asked for the body, but this content cannot become particles legibly. */
  | "too-detailed-for-body"
  /** The request asked for a card, but this content has no card form (a form, symbol or emoji is the body). */
  | "no-card-form"
  /** The surface cannot show the preferred route. */
  | "surface-limited";

export interface RouteRequest {
  content: PresentationContent;
  preference?: PresentationPreference;
  /** The user asked to inspect exact detail (a photograph's detail, a screenshot's text). */
  detail?: boolean;
  capabilities?: PresentationCapabilities;
}

export interface RouteDecision { route: PresentationRoute; reason: RouteReason; preference: PresentationPreference }

/** Text short and plain enough for the particle body itself to become it (one line of glyphs). */
const GLYPH_TEXT = /^[\p{L}\p{M}\p{N} .,!?'’\-&·:()/%+#°]+$/u;
export const GLYPH_TEXT_MAX = 16;
export const isGlyphText = (text: string) => Array.from(text).length <= GLYPH_TEXT_MAX && !text.includes("\n") && GLYPH_TEXT.test(text);

/**
 * Picture quality thresholds (pixels, from the image header). A portrait needs a usable face for a card; any
 * other picture needs to be genuinely large for a card to add something the particles do not.
 */
export const PICTURE_QUALITY = { portraitMinSide: 240, pictureMinLongSide: 640 };

/** Whether the particle body can carry this content legibly. */
export function bodyCapable(content: PresentationContent): boolean {
  switch (content.kind) {
    case "form": case "clock": case "number": case "symbol": case "emoji": case "image": case "terrain": return true;
    case "text": return !content.title && isGlyphText(content.text);
    case "result": return content.status !== "info";
    case "artifact": return (content.type === "svg" || content.type === "image") && content.media !== undefined;
  }
}

/** Whether this content has a card form. A form, a symbol or an emoji is only ever the body. */
export function cardCapable(content: PresentationContent): boolean {
  return !(content.kind === "form" || content.kind === "symbol" || content.kind === "emoji");
}

function automatic(content: PresentationContent, detail: boolean): { route: PresentationRoute; reason: RouteReason } {
  switch (content.kind) {
    case "form": case "clock": case "number": case "symbol": case "emoji": case "terrain":
      return { route: "body", reason: "body-native" };
    case "text":
      return bodyCapable(content) ? { route: "body", reason: "body-native" } : { route: "card", reason: "fidelity" };
    case "result": case "artifact":
      return { route: "card", reason: "fidelity" };
    case "image": {
      if (detail) return { route: "card", reason: "detail-requested" };
      if (content.fit === "logo") return { route: "body", reason: "body-native" };
      const short = Math.min(content.width ?? 0, content.height ?? 0), long = Math.max(content.width ?? 0, content.height ?? 0);
      // A picture from this machine (a screenshot, a generated image, a diagram) is shown exactly.
      if (content.origin === "local") return { route: "card", reason: "fidelity" };
      if (content.fit === "portrait") {
        return short >= PICTURE_QUALITY.portraitMinSide ? { route: "hybrid", reason: "portrait-hybrid" } : { route: "body", reason: "low-resolution" };
      }
      return long >= PICTURE_QUALITY.pictureMinLongSide ? { route: "hybrid", reason: "picture-hybrid" } : { route: "body", reason: "low-resolution" };
    }
  }
}

/** Decides BODY, CARD or HYBRID for one presentation. Pure and deterministic. */
export function routePresentation(request: RouteRequest): RouteDecision {
  const preference = request.preference ?? "auto";
  const caps = request.capabilities ?? ALL_CAPABILITIES;
  const { content } = request;
  const detail = request.detail === true && (content.kind === "image" || (content.kind === "artifact" && content.media !== undefined));
  const body = caps.body && bodyCapable(content) && !detail;
  const card = caps.card && cardCapable(content);
  // Why a route is not possible here.
  const without = (part: "body" | "card"): RouteReason => part === "card" ? (cardCapable(content) ? "surface-limited" : "no-card-form")
    : detail ? "detail-requested" : bodyCapable(content) ? "surface-limited" : "too-detailed-for-body";
  // Whatever was wanted, the result is something this content and this surface can actually show.
  const fit = (route: PresentationRoute, reason: RouteReason): RouteDecision => {
    const possible = { body, card, hybrid: body && card };
    if (possible[route]) return { route, reason, preference };
    if (route !== "card" && card) return { route: "card", reason: without("body"), preference };
    if (route !== "body" && body) return { route: "body", reason: without("card"), preference };
    // Every content has a body or a card form; a surface with neither still gets the body.
    return { route: "body", reason: "surface-limited", preference };
  };
  if (preference === "auto") {
    const choice = automatic(content, detail);
    return fit(choice.route, choice.reason);
  }
  return fit(preference, "requested");
}

/**
 * How long each part lasts, in seconds (0: until cleared). A body visual is a moment (SCF's hold times); a card
 * stays while it is likely still relevant, then goes, so cards never accumulate.
 */
export const CARD_SECONDS = { text: 20, result: 24, artifact: 60, image: 30, terrain: 30, clock: 12, number: 12 } as const;

export function cardSeconds(content: PresentationContent): number {
  switch (content.kind) {
    case "text": return Math.min(60, Math.max(CARD_SECONDS.text, 8 + Array.from(content.text).length / 12));
    case "result": case "artifact": case "image": case "terrain": case "clock": case "number": return CARD_SECONDS[content.kind];
    default: return 0;
  }
}
