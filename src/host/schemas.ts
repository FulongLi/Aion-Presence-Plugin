import { z } from "zod";
import { AION_BODIES } from "../core/body";
import { AION_IDENTITY } from "../core/identity";
import { ARTIFACT_TYPES, CHANGE_KINDS, cleanCode, cleanLine, cleanText, IMAGE_MODES, LIMITS, MARKER_LIMITS, RESULT_STATUSES } from "../core/presentation";
import { ACTIVITY_STATES } from "../core/state";
import { PRESENTATION_PREFERENCES } from "../core/presentationRouter";
import { EYE_EXPRESSIONS } from "../core/eyes/expression";
import { FIGURE_GESTURES } from "../core/figure/motion";
import { SCENE_PRESET_NAMES } from "../visual/scene3d/presets";
import { SCENE_LIMITS } from "../visual/scene3d/types";
import { IMAGE_INTENTS, PORTRAIT_STYLES, SYMBOL_NAMES, TERRAIN_STYLES } from "../visual/types";
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

/** A portrait's composition (the card always shows the original photograph). Omitted: heritage, enforced by Aion. */
const portraitStyle = z.enum(PORTRAIT_STYLES).describe(
  "Omit it: every portrait is a heritage portrait by default — an antique 3:4 oval of particles with a soft edge and a fine silver outline, "
  + "like a Victorian locket. classic: the head-and-shoulders particle portrait, only when the user asks for it (\"the classic portrait\", "
  + "\"without the oval\", \"show the classic portrait instead\").");

export const activityStateSchema = z.enum(ACTIVITY_STATES);
export const bodySchema = z.enum(AION_BODIES);

export const setPresenceStateInput = z.object({
  state: activityStateSchema.describe("What Codex is doing now."),
  label: line(LIMITS.label, "label").optional().describe("Optional short status line, e.g. \"Running the test suite\". No logs."),
}).strict();

export const setBodyFormInput = z.object({
  body: bodySchema.describe("sphere: the original abstract body (visuals, information). eyes: two expressive eyes (conversation, attention). "
    + "figure: an articulated stick figure (gesture, explanation)."),
}).strict();

export const expressInput = z.object({
  expression: z.enum(EYE_EXPRESSIONS).optional().describe("An expression: neutral, attentive, thinking, curious, happy, surprised, confused, sleepy, concerned."),
  gesture: z.enum(FIGURE_GESTURES).optional().describe("A gesture: wave, nod, point, shrug, surprise, jump, step, turn, look-around, think."),
  seconds: z.number().min(1).max(30).optional().describe("How long an expression is held (default about 4 s). Gestures take their own time."),
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
  emphasis: line(LIMITS.emphasis, "emphasis").optional().describe("Optional: one term of the text to highlight in the card, e.g. \"c²\" in \"a² + b² = c²\". "
    + "As the figure, Aion looks at it, points to it and explains it; the eyes glance at it."),
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
  style: portraitStyle.optional().describe("Only for a portrait (intent portrait or celebrity): heritage (default, an antique oval) or classic. Ignored for anything else."),
  hold_seconds: hold.optional(),
}).strict();

export const showPortraitInput = z.object({
  person: checked(VISUAL_LIMITS.person, validPerson, `person: a full name of at most ${VISUAL_LIMITS.person} letters`).describe("Full, unambiguous name of the person, e.g. \"Nikola Tesla\"."),
  style: portraitStyle.optional(),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

/** A place to mark on a map or on terrain. Only its name leaves the machine (to a geocoder), and only if Aion's offline gazetteer does not know it. */
const colorWords = z.string().min(1).max(40);
export const markerInput = z.object({
  place: checked(VISUAL_LIMITS.region, value => validQuery(value, VISUAL_LIMITS.region), `place: a place name of at most ${VISUAL_LIMITS.region} characters`)
    .describe("The place to mark, by name: a city, town, landmark or address, e.g. \"Los Angeles\", \"Glasgow\", \"Mount Everest\". Aion finds its real coordinates (never estimate them)."),
  label: line(MARKER_LIMITS.label, "label").optional().describe("Optional label shown beside it (default: the place's name)."),
  color: colorWords.optional().describe("Optional colour: a name (red, yellow, blue, green, purple, 红色…) or #RRGGBB. Default: Aion's accent colour."),
  highlight: z.boolean().optional().describe("Make it the one to look at: larger, with a slow pulse (e.g. for \"where is …?\")."),
}).strict();
const markerList = z.array(markerInput).min(1).max(MARKER_LIMITS.markers);

export const showMapInput = z.object({
  region: checked(VISUAL_LIMITS.region, value => validQuery(value, VISUAL_LIMITS.region), `region: a place name of at most ${VISUAL_LIMITS.region} characters`)
    .describe(`What to show the map of: a continent, country, part of one, state, city or region, e.g. "United States", "Scotland", "Africa", "Japan", "California", "中国", "Europe", "world". At most ${VISUAL_LIMITS.region} characters.`),
  markers: markerList.optional().describe(`Places to mark on it at once (at most ${MARKER_LIMITS.markers}).`),
  presentation: presentation.optional().describe("auto (default): the body becomes the map. hybrid or card: also a crisp reference map card with the marked places."),
  hold_seconds: hold.optional(),
}).strict();

export const markMapInput = z.object({
  add: markerList.optional().describe("Places to add (or, if already marked, to change)."),
  change: z.array(z.object({
    place: z.string().min(1).max(VISUAL_LIMITS.region).describe("Which marker: its label or the place it marks, e.g. \"Los Angeles\"."),
    color: colorWords.optional(), label: line(MARKER_LIMITS.label, "label").optional(), highlight: z.boolean().optional(),
  }).strict()).min(1).max(MARKER_LIMITS.markers).optional().describe("Markers to recolour, relabel or highlight."),
  remove: z.array(z.string().min(1).max(VISUAL_LIMITS.region)).min(1).max(MARKER_LIMITS.markers).optional().describe("Markers to remove, by label or place."),
  clear: z.boolean().optional().describe("Remove every marker."),
}).strict();

export const setColorsInput = z.object({
  base: colorWords.optional().describe("Aion's particle colour (sphere, eyes, figure, every particle visual): a name (blue, purple, warm gold, 紫色…), a preset or #RRGGBB."),
  accent: colorWords.optional().describe("The accent colour of markers, highlighted places and emphasis."),
  reset: z.enum(["base", "accent", "all"]).optional().describe("Back to Aion's own colours: base (Aion Silver), accent (Aion Coral) or all."),
}).strict();

export const showTerrainInput = z.object({
  region: checked(VISUAL_LIMITS.region, value => validQuery(value, VISUAL_LIMITS.region), `region: a place name of at most ${VISUAL_LIMITS.region} characters`)
    .describe(`The place, e.g. "Wales", "United Kingdom", "Swiss Alps", "Grand Canyon". At most ${VISUAL_LIMITS.region} characters.`),
  style: z.enum(TERRAIN_STYLES).optional().describe("Shading: terrain (default), topography (contour bands), relief (strong shading), heightmap (height only)."),
  markers: markerList.optional().describe(`Places to mark on the relief, e.g. [{ "place": "Glasgow", "color": "red" }] (at most ${MARKER_LIMITS.markers}).`),
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

/**
 * A 3D scene for show_scene: the shape the model sees. The server validates it again, strictly and with every bound
 * (visual/scene3d/validate.ts), before anything is built.
 */
const num = z.number();
const vec = z.tuple([num, num, num]);
const sceneCommon = {
  position: vec.optional().describe("Centre [x, y, z] (y up, z toward the viewer). Default [0, 0, 0]."),
  rotation: vec.optional().describe("Euler angles in degrees [x, y, z]."),
  scale: z.union([num, vec]).optional(),
  tone: num.optional().describe("Brightness 0.2–1 (default 0.85)."),
  weight: num.optional().describe("Relative share of particles (default 1)."),
  detail: z.enum(["surface", "edges", "both"]).optional().describe("Draw surfaces, edges, or both (default by type)."),
  repeat: z.object({ count: num, offset: vec.optional(), rotation: vec.optional(), scale: num.optional() }).strict().optional()
    .describe(`Copies (2–${SCENE_LIMITS.repeat}), each offset and turned by one more step than the last (e.g. the rungs of a ladder or a helix).`),
};
const sceneObject = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"), size: vec, ...sceneCommon }).strict(),
  z.object({ type: z.literal("sphere"), radius: num, ...sceneCommon }).strict(),
  z.object({ type: z.literal("pyramid"), base: num, height: num, sides: num.optional(), ...sceneCommon }).strict(),
  z.object({ type: z.literal("cylinder"), radius: num, height: num, radiusTop: num.optional(), ...sceneCommon }).strict(),
  z.object({ type: z.literal("cone"), radius: num, height: num, ...sceneCommon }).strict(),
  z.object({ type: z.literal("torus"), radius: num, tube: num, ...sceneCommon }).strict(),
  z.object({ type: z.literal("ring"), inner: num, outer: num, ...sceneCommon }).strict().describe("A flat annulus in the horizontal plane (planetary rings)."),
  z.object({ type: z.literal("line"), from: vec, to: vec, ...sceneCommon }).strict(),
  z.object({ type: z.literal("tube"), points: z.array(vec), radius: num, closed: z.boolean().optional(), ...sceneCommon }).strict(),
  z.object({ type: z.literal("curve"), points: z.array(vec), closed: z.boolean().optional(), ...sceneCommon }).strict(),
  z.object({ type: z.literal("helix"), radius: num, height: num, turns: num, phase: num.optional(), ...sceneCommon }).strict(),
]);
export const sceneInput = z.object({
  title: z.string().describe("What it shows, e.g. \"Water molecule\" (≤ 60 characters)."),
  objects: z.array(sceneObject).describe(`1–${SCENE_LIMITS.objects} primitives, each centred at its position.`),
  rotation: z.enum(["slow", "none"]).optional().describe("slow (default): turns slowly; none: holds still."),
  tilt: num.optional().describe("Viewing elevation in degrees, −60…60 (default 15; positive looks down on it)."),
}).strict();

export const showSceneInput = z.object({
  preset: z.enum(SCENE_PRESET_NAMES as [string, ...string[]]).optional().describe(`A curated scene: ${SCENE_PRESET_NAMES.join(", ")}.`),
  scene: sceneInput.optional().describe("Your own scene of primitives, when no preset fits."),
  hold_seconds: hold.optional(),
}).strict();

export const setSceneViewInput = z.object({
  rotate: z.enum(["left", "right", "up", "down"]).optional().describe("Turn the object (left/right) or tilt it (up: see it more from above; down: from below)."),
  degrees: z.number().min(5).max(180).optional().describe("How far to turn (default 45)."),
  zoom: z.enum(["in", "out"]).optional(),
  spin: z.boolean().optional().describe("Resume (true) or stop (false) its slow turn."),
  reset: z.boolean().optional().describe("Back to the default view."),
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
