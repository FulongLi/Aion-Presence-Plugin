import { IMAGE_FITS, SYMBOL_NAMES, TERRAIN_STYLES, type ImageFit, type SymbolName, type TerrainStyle } from "../visual/types";
import { cardSeconds, isGlyphText, routePresentation, type PresentationCapabilities, type PresentationPreference, type PresentationRoute, type RouteReason } from "./presentationRouter";

export { GLYPH_TEXT_MAX, isGlyphText } from "./presentationRouter";

/**
 * The presentation model: what Aion is showing, independent of how it is drawn. The host adapter validates
 * tool input into these shapes; the store holds at most one; every surface renders the same one.
 *
 * A presentation is temporary. The Presentation Router (presentationRouter.ts) decides how it is shown: the
 * persistent body (sphere or figure) becomes the information, holds it and returns to the same body (BODY);
 * exact content stands beside the living body as a quiet card (CARD); or both (HYBRID). Body visuals and cards
 * have their own lifetimes. Content stays concise: details stay in the host conversation.
 */
export const RESULT_STATUSES = ["success", "failure", "partial", "info"] as const;
export type ResultStatus = typeof RESULT_STATUSES[number];

export const ARTIFACT_TYPES = ["text", "code", "list", "changes", "svg", "image"] as const;
export type ArtifactType = typeof ARTIFACT_TYPES[number];

export const IMAGE_MODES = ["particles", "framed"] as const;
export type ImageMode = typeof IMAGE_MODES[number];
export { IMAGE_FITS, SYMBOL_NAMES, TERRAIN_STYLES, type ImageFit, type SymbolName, type TerrainStyle };

export const CHANGE_KINDS = ["added", "modified", "deleted", "renamed"] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];

/** Upper bounds for every field. Aion presents concise information; logs stay in the host. */
export const LIMITS = {
  title: 80,
  label: 60,
  text: 600,
  summary: 280,
  detail: 140,
  details: 8,
  artifact: 12_000,
  item: 200,
  items: 40,
  changes: 60,
  path: 240,
  alt: 200,
  /** Hold bounds in seconds; 0 means "until cleared or replaced". */
  hold: { min: 2, max: 600 },
} as const;

/**
 * Default seconds each kind of presentation is held formed before Aion returns to its body. The visuals SCF
 * Presence had keep its tuned hold times (clock 7, number 7, glyph text 6, symbol 5, emoji 4, form 10,
 * portrait 14, image 12, terrain 14); text standing beside the body is held long enough to read; results and
 * artifacts, which only the plugin presents, are held longer.
 */
export const HOLD_SECONDS = {
  form: 10, text: 6, panelText: 9, result: 16, image: 12, portrait: 14, terrain: 14, clock: 7, number: 7, symbol: 5, emoji: 4, artifact: 45,
} as const;

/** Media the host adapter has read and validated (an image, or a height field); surfaces fetch the bytes by id. */
export interface MediaRef { id: string; mime: string; bytes: number }

export interface FileChange { path: string; change: ChangeKind; additions?: number; deletions?: number }

export type PresentationContent =
  | { kind: "form"; form: string; variant?: string; label: string }
  | { kind: "text"; text: string; title?: string }
  | { kind: "result"; title: string; summary: string; status: ResultStatus; details: string[] }
  /**
   * `fit`: how the body frames it (a portrait's head-and-shoulders band, an object, a map, a logo). `credit`: where
   * a looked-up picture came from. `width`/`height`: the original picture's size (the card shows the original,
   * never the particle raster). `origin`: looked up on public sources, or a file on this machine. `mode`: the
   * v0.2 preference (particles → body, framed → card), still honoured when no presentation preference is given.
   */
  | { kind: "image"; media: MediaRef; alt?: string; mode?: ImageMode; fit?: ImageFit; credit?: string; width?: number; height?: number; origin?: "lookup" | "local" }
  /** Real elevation as a height field (media of type application/vnd.aion.heightfield), shaded in `style`. */
  | { kind: "terrain"; media: MediaRef; style: TerrainStyle; label: string; elevation?: { min: number; max: number }; credit?: string }
  | { kind: "clock"; time: string }
  | { kind: "number"; value: string }
  | { kind: "symbol"; symbol: SymbolName }
  | { kind: "emoji"; emoji: string }
  | { kind: "artifact"; type: ArtifactType; title: string; content?: string; language?: string; media?: MediaRef; items?: string[]; changes?: FileChange[] };

export type PresentationKind = PresentationContent["kind"];

export type Presentation = PresentationContent & {
  /** Unique per presentation, so surfaces know when a new one replaced an identical-looking one. */
  id: string;
  /** Milliseconds since the epoch when it was shown. */
  at: number;
  /** Seconds the whole presentation lasts (0: until cleared). */
  hold: number;
  /** How it is shown (see presentationRouter.ts), and why. */
  route: PresentationRoute;
  reason: RouteReason;
  /** Seconds the body holds its visual formed (0: until cleared; unused when the route is card). */
  bodyHold: number;
  /** Seconds the card stays (0: until cleared; unused when the route is body). */
  cardHold: number;
};

/** How a presentation was asked for: a route preference and whether exact detail matters. */
export interface PresentationRequest { preference?: PresentationPreference; detail?: boolean; capabilities?: PresentationCapabilities }

/** Control, zero-width and bidirectional-override characters. Newlines and tabs are handled separately. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;
const graphemes = (value: string) => Array.from(value).length;

/** One line of display text: trimmed, inner whitespace collapsed, no control characters. */
export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && graphemes(text) <= max && !CONTROL.test(text) ? text : null;
}

/** Multi-line display text: line breaks kept (at most two in a row), tabs as spaces, no control characters. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[ \u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text && graphemes(text) <= max && !CONTROL.test(text) ? text : null;
}

/** Code keeps its indentation and blank lines; only control characters and the size are checked. */
export function cleanCode(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  return text && graphemes(text) <= max && !CONTROL.test(text) ? text : null;
}

const clampHold = (seconds: number) => Math.max(LIMITS.hold.min, Math.min(LIMITS.hold.max, seconds));

/** The body's default hold for a kind (SCF's tuned times, see HOLD_SECONDS). */
function bodySeconds(content: PresentationContent): number {
  switch (content.kind) {
    case "text": return HOLD_SECONDS.text;
    case "image": return content.fit === "portrait" ? HOLD_SECONDS.portrait : HOLD_SECONDS.image;
    case "result": case "artifact": return HOLD_SECONDS.image;
    default: return HOLD_SECONDS[content.kind];
  }
}

/**
 * Lifetimes for a routed presentation, in seconds (0: until cleared). The body holds its visual for a moment;
 * a card may stay longer. A requested hold applies to what the user looks at longest: the body's visual when it
 * is the body alone, the card otherwise — a hybrid's particle portrait still returns after its moment.
 */
export function holdsFor(content: PresentationContent, route: PresentationRoute, requested?: number): { total: number; body: number; card: number } {
  const asked = requested === undefined || !Number.isFinite(requested) ? undefined : requested === 0 ? 0 : clampHold(requested);
  const bodyDefault = bodySeconds(content), cardDefault = cardSeconds(content) || HOLD_SECONDS.image;
  if (route === "body") { const body = asked ?? bodyDefault; return { total: body, body, card: 0 }; }
  const card = asked ?? cardDefault;
  if (route === "card") return { total: card, body: 0, card };
  const body = asked === undefined || asked === 0 ? bodyDefault : Math.min(asked, bodyDefault);
  return { total: card === 0 ? 0 : Math.max(card, body), body, card };
}

/** Hold seconds of the whole presentation under the automatic route (v0.2's single hold). */
export function holdFor(content: PresentationContent, requested?: number): number {
  return holdsFor(content, routePresentation({ content }).route, requested).total;
}

/** The v0.2 image mode as a route preference, when no explicit preference was given. */
export function legacyPreference(content: PresentationContent): PresentationPreference | undefined {
  if (content.kind !== "image" || !content.mode) return undefined;
  return content.mode === "framed" ? "card" : "body";
}

/** The symbol form each result status becomes (see the symbol pack in the visual forms). */
export const RESULT_SYMBOL: Record<ResultStatus, string | null> = {
  success: "symbol.check", failure: "symbol.cross", partial: "symbol.exclamation", info: null,
};

/** What the particle body itself becomes for a presentation (none: the body keeps living beside a card). */
export type BodyVisual =
  | { type: "form"; form: string; variant?: string }
  | { type: "text"; text: string }
  | { type: "image"; media: MediaRef; fit: ImageFit }
  | { type: "terrain"; media: MediaRef; style: TerrainStyle }
  | { type: "emoji"; emoji: string }
  | { type: "none" };

export interface PresentationPlan { body: BodyVisual; card: boolean }

/** The body visual a content becomes when its route includes the body. */
function bodyVisual(presentation: PresentationContent): BodyVisual {
  switch (presentation.kind) {
    case "form": return { type: "form", form: presentation.form, variant: presentation.variant };
    case "text": return isGlyphText(presentation.text) ? { type: "text", text: presentation.text } : { type: "none" };
    case "result": { const symbol = RESULT_SYMBOL[presentation.status]; return symbol ? { type: "form", form: symbol } : { type: "none" }; }
    case "image": return { type: "image", media: presentation.media, fit: presentation.fit ?? "object" };
    case "terrain": return { type: "terrain", media: presentation.media, style: presentation.style };
    case "clock": return { type: "text", text: presentation.time };
    case "number": return { type: "text", text: presentation.value };
    case "symbol": return { type: "form", form: `symbol.${presentation.symbol}` };
    case "emoji": return { type: "emoji", emoji: presentation.emoji };
    case "artifact": return presentation.media ? { type: "image", media: presentation.media, fit: "object" } : { type: "none" };
  }
}

/** Rendering only: a routed presentation becomes a body visual, a card, or both. The decision was the router's. */
export function planPresentation(presentation: PresentationContent, route: PresentationRoute = routePresentation({ content: presentation }).route): PresentationPlan {
  const body = route === "card" ? { type: "none" as const } : bodyVisual(presentation);
  return { body, card: route !== "body" || body.type === "none" };
}

/** A one-line description for logs and tool results ("result: Tests passed"). */
export function describePresentation(presentation: PresentationContent): string {
  switch (presentation.kind) {
    case "form": return `form: ${presentation.label}`;
    case "text": return `text: ${presentation.title ?? presentation.text.slice(0, 40)}`;
    case "result": return `result (${presentation.status}): ${presentation.title}`;
    case "image": return `${presentation.fit === "portrait" ? "portrait" : "image"}${presentation.alt ? `: ${presentation.alt}` : ""}`;
    case "terrain": return `terrain: ${presentation.label}`;
    case "clock": return `clock: ${presentation.time}`;
    case "number": return `number: ${presentation.value}`;
    case "symbol": return `symbol: ${presentation.symbol}`;
    case "emoji": return `emoji: ${presentation.emoji}`;
    case "artifact": return `${presentation.type} artifact: ${presentation.title}`;
  }
}
