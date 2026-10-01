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

/** Default seconds each kind of presentation is held before Aion returns to its body. */
export const HOLD_SECONDS = { form: 12, text: 9, result: 16, image: 16, artifact: 45 } as const;

/** An image the host adapter has read and validated; surfaces fetch the bytes by id. */
export interface MediaRef { id: string; mime: string; bytes: number }

export interface FileChange { path: string; change: ChangeKind; additions?: number; deletions?: number }

export type PresentationContent =
  | { kind: "form"; form: string; variant?: string; label: string }
  | { kind: "text"; text: string; title?: string }
  | { kind: "result"; title: string; summary: string; status: ResultStatus; details: string[] }
  | { kind: "image"; media: MediaRef; alt?: string; mode: ImageMode }
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
export function holdFor(kind: PresentationKind, requested?: number, text?: string): number {
  if (requested === 0) return 0;
  if (typeof requested === "number" && Number.isFinite(requested)) return Math.max(LIMITS.hold.min, Math.min(LIMITS.hold.max, requested));
  if (kind === "text" && text) return Math.min(30, Math.max(HOLD_SECONDS.text, 5 + graphemes(text) / 16));
  return HOLD_SECONDS[kind];
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
  | { type: "image"; media: MediaRef }
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
      return presentation.mode === "particles" ? { body: { type: "image", media: presentation.media }, panel: false } : { body: { type: "none" }, panel: true };
    case "artifact": return { body: { type: "none" }, panel: true };
  }
}

/** A one-line description for logs and tool results ("result: Tests passed"). */
export function describePresentation(presentation: PresentationContent): string {
  switch (presentation.kind) {
    case "form": return `form: ${presentation.label}`;
    case "text": return `text: ${presentation.title ?? presentation.text.slice(0, 40)}`;
    case "result": return `result (${presentation.status}): ${presentation.title}`;
    case "image": return `image${presentation.alt ? `: ${presentation.alt}` : ""}`;
    case "artifact": return `${presentation.type} artifact: ${presentation.title}`;
  }
}
