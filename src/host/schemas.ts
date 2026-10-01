import { z } from "zod";
import { AION_BODIES } from "../core/body";
import { ARTIFACT_TYPES, CHANGE_KINDS, cleanCode, cleanLine, cleanText, IMAGE_MODES, LIMITS, RESULT_STATUSES } from "../core/presentation";
import { ACTIVITY_STATES } from "../core/state";

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

export const activityStateSchema = z.enum(ACTIVITY_STATES);
export const bodySchema = z.enum(AION_BODIES);

export const setPresenceStateInput = z.object({
  state: activityStateSchema.describe("What Codex is doing now."),
  label: line(LIMITS.label, "label").optional().describe("Optional short status line, e.g. \"Running the test suite\". No logs."),
}).strict();

export const setBodyFormInput = z.object({
  body: bodySchema.describe("sphere: the original abstract body. figure: a quiet, minimal humanoid of particles."),
}).strict();

export const showVisualFormInput = z.object({
  form: z.string().min(1).max(60).describe("A visual form id or name, e.g. \"tao.yin-yang\", \"yin yang\", \"Orion\", \"Leo zodiac sign\", \"check\"."),
  variant: z.string().min(1).max(40).optional().describe("Optional variant the form declares, e.g. \"later-heaven\" for the bagua, \"stars\" for a constellation without lines."),
  hold_seconds: hold.optional(),
}).strict();

export const showTextInput = z.object({
  text: text(LIMITS.text, "text").describe(`Concise text (≤ ${LIMITS.text} characters). Up to 16 plain characters become the particle body itself; longer text is shown beside it.`),
  title: line(LIMITS.title, "title").optional().describe(`Optional short heading (≤ ${LIMITS.title} characters); text with a title is always shown beside the body.`),
  hold_seconds: hold.optional(),
}).strict();

export const showImageInput = z.object({
  source: z.string().min(1).max(12_000_000).describe("An absolute path to a local PNG, JPEG, WebP, GIF or SVG file (or a file:// URL), or a data:image/…;base64 URL. Remote http(s) URLs are not fetched."),
  alt: line(LIMITS.alt, "alt").optional().describe("Short description of the image."),
  mode: z.enum(IMAGE_MODES).optional().describe("particles (default): the body becomes the image. framed: the exact image is shown beside the body — use for diagrams and screenshots where detail matters."),
  hold_seconds: hold.optional(),
}).strict();

export const showResultInput = z.object({
  title: line(LIMITS.title, "title").describe("What finished, e.g. \"Tests\", \"Refactor complete\"."),
  summary: text(LIMITS.summary, "summary").describe("One or two lines: the outcome, e.g. \"48 / 48 tests passed\"."),
  status: z.enum(RESULT_STATUSES).optional().describe("success (a check), failure (a cross), partial (an exclamation) or info (no mark). Default info."),
  details: z.array(line(LIMITS.detail, "detail")).max(LIMITS.details).optional()
    .describe(`Up to ${LIMITS.details} short lines, e.g. ["8 files changed", "Build successful"]. Never paste logs.`),
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
  hold_seconds: hold.optional(),
}).strict();

export const openPresenceInput = z.object({
  body: bodySchema.optional().describe("Optionally choose the persistent body as Aion opens."),
  display: z.enum(["auto", "inline", "fullscreen"]).optional()
    .describe("Embedded hosts only: ask for fullscreen or inline presentation. Ignored where the host offers no such mode."),
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
