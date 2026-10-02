import { z } from "zod";
import { AION_BODIES } from "../core/body";
import { AION_IDENTITY } from "../core/identity";
import { ARTIFACT_TYPES, CHANGE_KINDS, cleanCode, cleanLine, cleanText, IMAGE_MODES, LIMITS, RESULT_STATUSES } from "../core/presentation";
import { ACTIVITY_STATES } from "../core/state";
import { PRESENTATION_PREFERENCES } from "../core/presentationRouter";
import { IMAGE_INTENTS, SYMBOL_NAMES, TERRAIN_STYLES } from "../visual/types";
import { isSingleEmojiGrapheme, normalizeClockTime, tidy, validNumber, validPerson, validQuery, VISUAL_LIMITS } from "../visual/validate";

/**
 * Input and output schemas shared by the MCP tools and the hub's local HTTP API, so a command is validated
 * the same way however it arrives. Text fields are cleaned (whitespace, control characters) and bounded:
 * Aion shows concise information; logs and long output stay in the host conversation.
 */
const line = (max: number, what: string) => z.string().max(max * 2).transform((value, ctx) => {
  const clean = cleanLine(value, max);
  if (clean === null) { ctx.addIssue({ code: "custom", message: `${what}: 1–${max} characters of plain text` }); return z.NEVER; }
  return clean;
});
const text = (max: number, what: string) => z.string().max(max * 2).transform((value, ctx) => {
  const clean = cleanText(value, max);
  if (clean === null) { ctx.addIssue({ code: "custom", message: `${what}: 1–${max} characters of plain text` }); return z.NEVER; }
  return clean;
});
const hold = z.number().min(0).max(LIMITS.hold.max)
  .describe(`Seconds to hold the presentation before Aion returns to its body (${LIMITS.hold.min}–${LIMITS.hold.max}; 0 = until cleared). Omit for a sensible default.`);

/** How the user should see it (the Presentation Router decides by default; see core/presentationRouter.ts). */
const presentation = z.enum(PRESENTATION_PREFERENCES).describe(
  "auto (default, recommended): Aion decides. body: Aion's particle body becomes it. card: a high-fidelity card beside the body. "
  + "hybrid: both (e.g. a particle portrait and the photograph). Clearly unsuitable choices are overridden (long text never becomes particles).");

/** A free-text field checked by one of SCF's validators after its whitespace is tidied. */
const checked = (max: number, valid: (value: string) => boolean, what: string) => z.string().max(max * 4).transform((value, ctx) => {
  const clean = tidy(value);
  if (!valid(clean)) { ctx.addIssue({ code: "custom", message: what }); return z.NEVER; }
  return clean;
});

export const activityStateSchema = z.enum(ACTIVITY_STATES);
export const bodySchema = z.enum(AION_BODIES);

export const setPresenceStateInput = z.object({
  state: activityStateSchema.describe("What Codex is doing now."),
  label: line(LIMITS.label, "label").optional().describe("Optional short status line, e.g. \"Running the test suite\". No logs."),
}).strict();

export const setBodyFormInput = z.object({
  body: bodySchema.describe("sphere: the original abstract body. figure: a quiet, minimal humanoid of particles."),
}).strict();

export const showFormInput = z.object({
  form: z.string().min(1).max(60).describe("A visual form id or name, e.g. \"tao.yin-yang\", \"yin yang\", \"Orion\", \"Leo zodiac sign\", \"check\"."),
  variant: z.string().min(1).max(40).optional().describe("Optional variant the form declares, e.g. \"later-heaven\" for the bagua, \"stars\" for a constellation without lines."),
  hold_seconds: hold.optional(),
}).strict();

/** The v0.1 name of show_form's input, kept for older clients. */
export const showVisualFormInput = showFormInput;

export const showTextInput = z.object({
  text: text(LIMITS.text, "text").describe(`Concise text (≤ ${LIMITS.text} characters). Up to 16 plain characters become the particle body itself; longer text is shown beside it.`),
  title: line(LIMITS.title, "title").optional().describe(`Optional short heading (≤ ${LIMITS.title} characters); text with a title is always shown beside the body.`),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

export const showImageInput = z.object({
  query: checked(VISUAL_LIMITS.query, value => validQuery(value, VISUAL_LIMITS.query), `query: a short search phrase of at most ${VISUAL_LIMITS.query} characters, no URLs or markup`).optional()
    .describe(`What to look up and show, as a short specific search phrase, e.g. "Tesla Model Y", "Eiffel Tower at night", "${AION_IDENTITY.creatorCompany} logo". At most ${VISUAL_LIMITS.query} characters, no URLs. Use either query or source, not both.`),
  intent: z.enum(IMAGE_INTENTS).optional().describe("With query: what kind of picture this is; it chooses the sources and the framing. Default general."),
  source: z.string().min(1).max(12_000_000).optional()
    .describe("Instead of query: an image on this machine — an absolute path to a PNG, JPEG, WebP, GIF or SVG file (or a file:// URL), or a data:image/…;base64 URL. Remote URLs are not accepted here; use query to look something up."),
  alt: line(LIMITS.alt, "alt").optional().describe("Short description of the image."),
  mode: z.enum(IMAGE_MODES).optional().describe("Older form of presentation (particles = body, framed = card). Prefer presentation."),
  presentation: presentation.optional(),
  detail: z.boolean().optional().describe("true when the user wants to inspect the picture's exact detail: it is shown as a card, not dissolved into particles."),
  hold_seconds: hold.optional(),
}).strict();

export const showPortraitInput = z.object({
  person: checked(VISUAL_LIMITS.person, validPerson, `person: a full name of at most ${VISUAL_LIMITS.person} letters`).describe("Full, unambiguous name of the person, e.g. \"Nikola Tesla\"."),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

export const showTerrainInput = z.object({
  region: checked(VISUAL_LIMITS.region, value => validQuery(value, VISUAL_LIMITS.region), `region: a place name of at most ${VISUAL_LIMITS.region} characters`)
    .describe(`The place, e.g. "Wales", "United Kingdom", "Swiss Alps", "Grand Canyon". At most ${VISUAL_LIMITS.region} characters.`),
  style: z.enum(TERRAIN_STYLES).optional().describe("Shading: terrain (default), topography (contour bands), relief (strong shading), heightmap (height only)."),
  presentation: presentation.optional().describe("auto (default): the body becomes the relief. hybrid or card: also a relief map card with the elevation range, when exact geography matters."),
  hold_seconds: hold.optional(),
}).strict();

export const showClockInput = z.object({
  time: z.string().max(16).transform((value, ctx) => {
    const time = normalizeClockTime(value);
    if (!time) { ctx.addIssue({ code: "custom", message: "time: HH:MM (24-hour), e.g. 15:42" }); return z.NEVER; }
    return time;
  }).optional().describe("Optional 24-hour time as HH:MM, e.g. \"15:42\". Omit for the user's current local time."),
  hold_seconds: hold.optional(),
}).strict();

export const showNumberInput = z.object({
  value: checked(VISUAL_LIMITS.number, validNumber, `value: one number with an optional sign, currency, % or unit; at most ${VISUAL_LIMITS.number} characters`)
    .describe(`The number with an optional sign, currency, % or unit, e.g. "42%", "84", "23°C", "£28,000", "3.14"; at most ${VISUAL_LIMITS.number} characters.`),
  hold_seconds: hold.optional(),
}).strict();

export const showSymbolInput = z.object({
  symbol: z.enum(SYMBOL_NAMES).describe("Which symbol to show."),
  hold_seconds: hold.optional(),
}).strict();

export const showEmojiInput = z.object({
  emoji: z.string().max(32).transform((value, ctx) => {
    const emoji = value.trim();
    if (!isSingleEmojiGrapheme(emoji)) { ctx.addIssue({ code: "custom", message: "emoji: exactly one Unicode emoji, no text" }); return z.NEVER; }
    return emoji;
  }).describe("Exactly one Unicode emoji, e.g. \"😊\", \"❤️\", \"👍🏻\", \"👨‍🚀\", \"🇬🇧\". No text, and not several emoji."),
  hold_seconds: hold.optional(),
}).strict();

export const showResultInput = z.object({
  title: line(LIMITS.title, "title").describe("What finished, e.g. \"Tests\", \"Refactor complete\"."),
  summary: text(LIMITS.summary, "summary").describe("One or two lines: the outcome, e.g. \"48 / 48 tests passed\"."),
  status: z.enum(RESULT_STATUSES).optional().describe("success (a check), failure (a cross), partial (an exclamation) or info (no mark). Default info."),
  details: z.array(line(LIMITS.detail, "detail")).max(LIMITS.details).optional()
    .describe(`Up to ${LIMITS.details} short lines, e.g. ["8 files changed", "Build successful"]. Never paste logs.`),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

export const fileChangeSchema = z.object({
  path: line(LIMITS.path, "path").describe("The file's path relative to the repository."),
  change: z.enum(CHANGE_KINDS),
  additions: z.number().int().min(0).max(1_000_000).optional(),
  deletions: z.number().int().min(0).max(1_000_000).optional(),
}).strict();

export const showArtifactInput = z.object({
  type: z.enum(ARTIFACT_TYPES).describe("text, code, list (items), changes (a file-change summary), svg (inline SVG markup) or image (a local file, see source)."),
  title: line(LIMITS.title, "title").describe(`A short heading (≤ ${LIMITS.title} characters).`),
  content: z.string().min(1).max(LIMITS.artifact * 2).optional().describe(`For text, code and svg: the content (≤ ${LIMITS.artifact} characters). Show an excerpt, not a whole file.`),
  language: z.string().regex(/^[a-z0-9+#.-]{1,24}$/i).optional().describe("For code: the language name, e.g. typescript."),
  items: z.array(line(LIMITS.item, "item")).min(1).max(LIMITS.items).optional().describe("For list: the items."),
  changes: z.array(fileChangeSchema).min(1).max(LIMITS.changes).optional().describe("For changes: one entry per file."),
  source: z.string().min(1).max(12_000_000).optional().describe("For image: an absolute local path or a data:image URL, as in show_image."),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

export const openPresenceInput = z.object({
  body: bodySchema.optional().describe("Optionally choose the persistent body as Aion opens."),
  display: z.enum(["immersive", "auto", "inline", "fullscreen"]).optional()
    .describe("immersive (use it when the user says \"Open Aion\"): Aion becomes the foreground, Aion-only view — host fullscreen when embedded, a "
      + "foreground window that enters fullscreen at the user's first click in the companion. auto: a calm window or inline view. "
      + "inline / fullscreen: an explicit host display mode."),
  surface: z.enum(["auto", "companion"]).optional()
    .describe("auto (default): embedded in the host when it renders MCP Apps, otherwise the companion window. companion: always open the companion window."),
}).strict();

export const syncInput = z.object({
  after_revision: z.number().int().min(-1).optional(),
  hub: z.string().max(64).optional(),
  wait_ms: z.number().int().min(0).max(25_000).optional(),
}).strict();

export const mediaInput = z.object({ id: z.string().regex(/^m[a-z0-9]{6,40}$/) }).strict();

/** Validates SVG markup for display as an image: it is never inserted into a page, only shown via <img>. */
export function svgSource(markup: string): string | null {
  const svg = cleanCode(markup, LIMITS.artifact);
  return svg && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg) && /<\/svg>\s*$/i.test(svg) ? svg : null;
}
