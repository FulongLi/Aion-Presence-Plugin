import { IMAGE_FITS, SYMBOL_NAMES, TERRAIN_STYLES, type ImageFit, type SymbolName, type TerrainStyle } from "../visual/types";

/**
 * The presentation model: what Aion is showing, independent of how it is drawn. The host adapter validates
 * tool input into these shapes; the store holds at most one; every surface renders the same one.
 *
 * A presentation is temporary. The persistent body (sphere or figure) becomes the information, holds it,
 * and returns to the same persistent body. Long or exact content (a result card, an artifact, a framed
 * image) is shown beside a presenting body instead, kept short: details stay in the host conversation.
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
  /** `fit`: how the body frames it (a portrait's head-and-shoulders band, an object, a map, a logo). `credit`: where a looked-up picture came from. */
  | { kind: "image"; media: MediaRef; alt?: string; mode: ImageMode; fit?: ImageFit; credit?: string }
  /** Real elevation as a height field (media of type application/vnd.aion.heightfield), shaded in `style`. */
  | { kind: "terrain"; media: MediaRef; style: TerrainStyle; label: string }
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
  /** Seconds it is held (0: until cleared). */
  hold: number;
};

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

/** Hold seconds: default per kind, 0 for "until cleared", otherwise clamped into LIMITS.hold. */
export function holdFor(content: PresentationContent, requested?: number): number {
  if (requested === 0) return 0;
  if (typeof requested === "number" && Number.isFinite(requested)) return Math.max(LIMITS.hold.min, Math.min(LIMITS.hold.max, requested));
  switch (content.kind) {
    case "text":
      return planPresentation(content).panel ? Math.min(30, Math.max(HOLD_SECONDS.panelText, 5 + graphemes(content.text) / 16)) : HOLD_SECONDS.text;
    case "image": return content.fit === "portrait" ? HOLD_SECONDS.portrait : HOLD_SECONDS.image;
    default: return HOLD_SECONDS[content.kind];
  }
}

/** Text short and plain enough for the particle body itself to become it (one line of glyphs). */
const GLYPH_TEXT = /^[\p{L}\p{M}\p{N} .,!?'’\-&·:()/%+#°]+$/u;
export const GLYPH_TEXT_MAX = 16;
export const isGlyphText = (text: string) => graphemes(text) <= GLYPH_TEXT_MAX && !text.includes("\n") && GLYPH_TEXT.test(text);

/** The symbol form each result status becomes (see the symbol pack in the visual forms). */
export const RESULT_SYMBOL: Record<ResultStatus, string | null> = {
  success: "symbol.check", failure: "symbol.cross", partial: "symbol.exclamation", info: null,
};

/**
 * What the particle body itself becomes for a presentation. Anything else is shown beside a body in the
 * presenting pose ("panel"): the body is still the one presenting, but long text is not particles.
 */
export type BodyVisual =
  | { type: "form"; form: string; variant?: string }
  | { type: "text"; text: string }
  | { type: "image"; media: MediaRef; fit: ImageFit }
  | { type: "terrain"; media: MediaRef; style: TerrainStyle }
  | { type: "emoji"; emoji: string }
  | { type: "none" };

export interface PresentationPlan { body: BodyVisual; panel: boolean }

export function planPresentation(presentation: PresentationContent): PresentationPlan {
  switch (presentation.kind) {
    case "form": return { body: { type: "form", form: presentation.form, variant: presentation.variant }, panel: false };
    case "text": {
      const glyph = !presentation.title && isGlyphText(presentation.text);
      return { body: glyph ? { type: "text", text: presentation.text } : { type: "none" }, panel: !glyph };
    }
    case "result": {
      const symbol = RESULT_SYMBOL[presentation.status];
      return { body: symbol ? { type: "form", form: symbol } : { type: "none" }, panel: true };
    }
    case "image":
      return presentation.mode === "particles"
        ? { body: { type: "image", media: presentation.media, fit: presentation.fit ?? "object" }, panel: false }
        : { body: { type: "none" }, panel: true };
    case "terrain": return { body: { type: "terrain", media: presentation.media, style: presentation.style }, panel: false };
    case "clock": return { body: { type: "text", text: presentation.time }, panel: false };
    case "number": return { body: { type: "text", text: presentation.value }, panel: false };
    case "symbol": return { body: { type: "form", form: `symbol.${presentation.symbol}` }, panel: false };
    case "emoji": return { body: { type: "emoji", emoji: presentation.emoji }, panel: false };
    case "artifact": return { body: { type: "none" }, panel: true };
  }
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
