import { z } from "zod";
import { CAD_ACTIONS } from "./cad/commands";
import { SIM_ACTIONS } from "./sim/commands";
import { OPENABLE_CARD_APP_IDS } from "../cards/registry";
import { CARD_LAYOUTS } from "../cards/manifest";
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
import { DURATIONS, TEMPO } from "../music/theory/rhythm";
import { SCALE_KINDS, type ScaleKind } from "../music/theory/scales";
import { CLEFS } from "../music/notation/staff";
import { BARLINES, DYNAMICS, SCORE_LIMITS } from "../music/notation/score";
import { LANGUAGES, LESSONS } from "../music/lessons/lessons";
import { AUDIO_INTENSITIES, AUDIO_MODES, AUDIO_SOURCE_PREFERENCES } from "../audio/settings";
import { WRITING_SYSTEMS, STROKE_LIMITS } from "../animation/stroke/types";
import { ACTIONS, FACINGS, OBJECT_SIZES, OBJECT_TYPES, SCENE_GESTURES, SEQUENCE_LIMITS, WALK_SPEEDS } from "../animation/scene/sequence";
import { DEMO_NAMES, type DemoName } from "../animation/scene/demos";
import { ANIMATION_ACTIONS, ANIMATION_SPEEDS } from "../animation/control";
import { ROUTE_LIMITS, TRAVEL_MODES } from "../visual/geo/route";

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
  .describe(`Seconds (${LIMITS.hold.min}–${LIMITS.hold.max}; 0: until cleared). Usually omit.`);

/** How the user should see it (the Presentation Router decides by default; see core/presentationRouter.ts). */
const presentation = z.enum(PRESENTATION_PREFERENCES).describe("auto (default): Aion decides; body: particles; card: exact card; hybrid: both.");

/** A free-text field checked by one of SCF's validators after its whitespace is tidied. */
const checked = (max: number, valid: (value: string) => boolean, what: string) => z.string().max(max * 4).transform((value, ctx) => {
  const clean = tidy(value);
  if (!valid(clean)) { ctx.addIssue({ code: "custom", message: what }); return z.NEVER; }
  return clean;
});

/** A portrait's composition (the card always shows the original photograph). Omitted: heritage, enforced by Aion. */
const portraitStyle = z.enum(PORTRAIT_STYLES).describe(
  "Omit it: every portrait is a heritage portrait by default (an antique oval of particles, like a locket). classic: the head-and-shoulders "
  + "portrait, only when the user asks (\"the classic portrait\", \"without the oval\").");

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
  intent: z.enum(IMAGE_INTENTS).optional().describe("What kind of picture it is: chooses the sources and framing (default general). With source: "
    + "portrait (or celebrity) only when the user says the local picture is a portrait (a heritage portrait then); omit it for any other local picture."),
  source: z.string().min(1).max(12_000_000).optional()
    .describe("Instead of query: an image on this machine — an absolute path to a PNG, JPEG, WebP, GIF or SVG file (or a file:// URL), or a data:image/…;base64 URL. Remote URLs are not accepted here; use query to look something up."),
  alt: line(LIMITS.alt, "alt").optional().describe("Short description of the image."),
  mode: z.enum(IMAGE_MODES).optional().describe("Older form of presentation (particles = body, framed = card). Prefer presentation."),
  presentation: presentation.optional(),
  detail: z.boolean().optional().describe("true when the user wants to inspect the picture's exact detail: it is shown as a card, not dissolved into particles."),
  style: portraitStyle.optional().describe("Only for a portrait (intent portrait or celebrity, with query or source): heritage (default, an antique oval) or classic. Ignored for anything else."),
  hold_seconds: hold.optional(),
}).strict();

export const showPortraitInput = z.object({
  person: checked(VISUAL_LIMITS.person, validPerson, `person: a full name of at most ${VISUAL_LIMITS.person} letters`).optional()
    .describe("Full, unambiguous name of the person to look up, e.g. \"Nikola Tesla\". With source: only their name (no lookup)."),
  source: z.string().min(1).max(12_000_000).optional()
    .describe("Instead of a lookup: a portrait photograph on this machine — an absolute path to a PNG, JPEG or WebP file (or file:// or data:image URL), "
      + "e.g. one the user gave you or one you generated. It is composed exactly like a looked-up portrait (heritage oval by default)."),
  alt: line(LIMITS.alt, "alt").optional().describe("With source: a short description (default: person)."),
  style: portraitStyle.optional(),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

/** A place to mark on a map or on terrain. Only its name leaves the machine (to a geocoder), and only if Aion's offline gazetteer does not know it. */
const colorWords = z.string().min(1).max(40);
export const markerInput = z.object({
  place: checked(VISUAL_LIMITS.region, value => validQuery(value, VISUAL_LIMITS.region), `place: a place name of at most ${VISUAL_LIMITS.region} characters`)
    .describe("A city, town, landmark or address by name (\"Glasgow\", \"Mount Everest\"); Aion finds its real coordinates."),
  label: line(MARKER_LIMITS.label, "label").optional().describe("Label (default: the place's name)."),
  color: colorWords.optional().describe("A colour name (red, 红色…) or #RRGGBB; default: Aion's accent."),
  highlight: z.boolean().optional().describe("The one to look at (\"where is …?\"): larger, pulsing."),
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

/**
 * v0.6: a route between places. Every field is optional because a follow-up changes the route on show ("Reverse it",
 * "Change to cycling", "Add Linlithgow"): what is left out stays as it is. Places are names (or "lat, lon" from a card
 * selection); only their coordinates ever reach the routing service.
 */
const routePlace = checked(VISUAL_LIMITS.region, value => validQuery(value, VISUAL_LIMITS.region), `a place name (or "lat, lon") of at most ${VISUAL_LIMITS.region} characters`);
export const planRouteInput = z.object({
  from: routePlace.optional().describe("Start: a place, landmark or address (\"Edinburgh Castle\"), or \"lat, lon\"."),
  to: routePlace.optional().describe("Destination."),
  via: z.array(routePlace).max(ROUTE_LIMITS.waypoints).optional().describe("Waypoints in order; replaces the route's ([] removes them)."),
  mode: z.enum(TRAVEL_MODES).optional().describe("walking (default), cycling or hiking."),
  reverse: z.boolean().optional().describe("Swap start and destination."),
  clear: z.boolean().optional().describe("Remove the route; the terrain stays."),
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
const vec = z.array(num).length(3);
/**
 * One flat object for every primitive (not a union per type): the schema stays small enough for hosts that budget tool
 * metadata (v0.4.4, see docs/MCP-TOOLS.md). Which fields a type needs is checked strictly by checkScene.
 */
const sceneObject = z.object({
  type: z.enum(["box", "sphere", "pyramid", "cylinder", "cone", "torus", "ring", "line", "tube", "curve", "helix"]),
  position: vec.optional().describe("Centre [x, y, z], y up."),
  rotation: vec.optional().describe("Degrees."),
  scale: z.union([num, vec]).optional(),
  size: vec.optional(), radius: num.optional(),
  radiusTop: num.optional(), height: num.optional(), base: num.optional(), sides: num.optional(), tube: num.optional(),
  inner: num.optional(), outer: num.optional(), from: vec.optional(), to: vec.optional(),
  points: z.array(vec).optional(), closed: z.boolean().optional(), turns: num.optional(), phase: num.optional(),
  tone: num.optional().describe("0.2–1"), weight: num.optional(), detail: z.enum(["surface", "edges", "both"]).optional(),
  repeat: z.object({ count: num, offset: vec.optional(), rotation: vec.optional(), scale: num.optional() }).strict().optional()
    .describe(`2–${SCENE_LIMITS.repeat} copies, each one step further (ladder rungs, a helix).`),
}).strict();
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
    .describe("immersive (for \"Open Aion\"): Aion's own foreground window, fullscreen at the user's first click. auto: a calm window. "
      + "inline / fullscreen: a host display mode (embedded only)."),
  surface: z.enum(["auto", "companion", "embedded"]).optional()
    .describe("Default: Aion's own window. embedded: inside this conversation, only when the user asks and the host renders MCP Apps."),
  welcome: z.boolean().optional().describe("Show the getting-started introduction again (\"Show me the introduction again\")."),
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

// ── v0.4.2: music and sound ────────────────────────────────────────────────────────────────────────────────────

const scoreNoteInput = z.object({
  pitch: z.string().max(8).optional().describe("C4 is middle C; C#4, Bb3. Omit for a rest."),
  duration: z.enum(DURATIONS).optional().describe("Default quarter."),
  dotted: z.boolean().optional(),
  label: z.string().max(SCORE_LIMITS.label).optional().describe("Under the note (\"C\", \"do\")."),
  tie: z.boolean().optional().describe("To the next note."), slur: z.enum(["start", "end"]).optional(),
  dynamic: z.enum(DYNAMICS).optional(), stem: z.enum(["up", "down"]).optional(),
}).strict();

const scaleInput = z.object({
  tonic: z.string().max(6).describe("e.g. C4."),
  kind: z.enum(SCALE_KINDS as [ScaleKind, ...ScaleKind[]]).optional(),
  octaves: z.number().int().min(1).max(2).optional(),
  direction: z.enum(["up", "down", "up-down"]).optional(),
  duration: z.enum(DURATIONS).optional(),
}).strict();

const highlightInput = z.object({
  note: z.number().int().min(0).optional().describe("Index from 0."),
  line: z.number().int().min(1).max(5).optional().describe("1 = bottom."),
  space: z.number().int().min(1).max(4).optional(),
  clef: z.literal(true).optional(), time: z.literal(true).optional(), key: z.literal(true).optional(),
}).strict();

const musicCommon = {
  clef: z.enum(CLEFS).optional().describe("treble, bass or alto. Omit: treble, or bass when every note is below middle C."),
  key: z.string().max(4).optional().describe("Key signature: G, D, F, Bb, Am …"),
  end: z.enum(BARLINES).optional().describe("The last bar line."),
  time: z.string().max(4).optional().describe("4/4, 3/4, 2/4, 6/8, C… when rhythm matters (every bar full); omit for scales."),
  notes: z.array(scoreNoteInput).max(SCORE_LIMITS.notes).optional().describe("The notes, in order."),
  scale: scaleInput.optional().describe("Instead of notes: a scale, spelled correctly."),
  tempo: z.number().min(TEMPO.min).max(TEMPO.max).optional().describe(`Quarter notes a minute when played (default ${TEMPO.default}).`),
};

export const showMusicInput = z.object({
  concept: z.string().max(40).optional().describe("Instead of notes, a glossary concept with its example: a clef, rest, note value, accidental, time signature, "
    + "ledger lines, bar lines, stems, beams, dots, key signature, tie, slur, repeat sign, dynamics."),
  language: z.enum(["en", "zh"]).optional().describe("The card's language (default en)."),
  title: line(LIMITS.title, "title").optional().describe("What it shows, e.g. \"C major scale\", \"Middle C\"."),
  ...musicCommon,
  staff: z.boolean().optional().describe("true with no notes: an empty staff (to explain lines and spaces)."),
  highlight: z.array(highlightInput).max(SCORE_LIMITS.highlights).optional().describe("What to light up: notes by index, a line, a space, the clef or the time signature."),
  caption: line(LIMITS.summary, "caption").optional().describe("One short line under the staff."),
  // A string (checked against the music forms in the tool) rather than an enum of 14 ids: smaller tool metadata (v0.4.4).
  symbol: z.string().max(32).optional().describe("A music form the body forms beside it: music.treble-clef, music.quarter-note, music.sharp …"),
  play: z.boolean().optional().describe("Also play it at once, each note lighting up as it sounds."),
  presentation: presentation.optional(),
  hold_seconds: hold.optional(),
}).strict();

export const playMusicInput = z.object({
  ...musicCommon,
  only: z.array(z.number().int().min(0)).max(SCORE_LIMITS.notes).optional().describe("Play only these notes of the music on show (indices from 0), e.g. [0] for the first."),
  volume: z.number().min(0).max(1).optional().describe("0…1 (default 0.8)."),
  stop: z.boolean().optional().describe("true: stop the music playing."),
}).strict();

export const musicLessonInput = z.object({
  lesson: z.union([z.number().int().min(1).max(LESSONS.length), z.string().max(40)]).optional()
    .describe(`Which lesson: ${LESSONS.map(lesson => `${lesson.id} ${lesson.title.en}`).join("; ")}. Omit to continue the current one.`),
  step: z.union([z.number().int().min(1).max(40), z.enum(["first", "next", "previous", "repeat"])]).optional().describe("A step number, or first, next (default when continuing), previous, repeat."),
  language: z.enum(LANGUAGES).optional().describe("en or zh: the language of the teaching text and labels. Switching keeps the lesson and step."),
  answer: z.string().max(40).optional().describe("The user's answer to a practice question (\"E\", \"E4\", \"mi\", \"F sharp\")."),
  play: z.boolean().optional().describe("Play the step's example (default true when the step has one)."),
}).strict();

export const setAudioVisualizerInput = z.object({
  enabled: z.boolean().optional().describe("false: Aion stops moving with sound (it keeps its semantic states)."),
  source: z.enum(AUDIO_SOURCE_PREFERENCES).optional().describe(
    "auto (default): whatever really sounds. microphone: the user's voice. codex: your own spoken voice, captured on macOS through the Aion Audio Bridge. "
    + "system: another app's sound on this Mac (name it in app, e.g. Music, Spotify) or the whole mix. tab: a browser tab the user shares in Aion's window. "
    + "music: Aion's own Music Library playback."),
  app: z.string().max(60).optional().describe("For system: the application to listen to (\"Music\", \"Spotify\", \"com.spotify.client\"). Omit for everything the Mac plays."),
  mode: z.enum(AUDIO_MODES).optional().describe("auto: the sphere for speech, the circular spectrum for sustained external music. sphere · spectrum (circular particle spectrum) · hybrid (sphere inside a lighter ring)."),
  intensity: z.enum(AUDIO_INTENSITIES).optional().describe("subtle, balanced (default) or expressive."),
  sensitivity: z.number().min(0).max(1).optional().describe("0…1: how quiet a sound may be and still move Aion (default 0.5)."),
  stop: z.array(z.enum(["codex", "system", "tab"])).max(3).optional().describe("Stop capturing these sources (\"stop listening to system audio\"; codex also turns Codex Voice Sync off)."),
  voice_sync: z.boolean().optional().describe("Codex Voice Sync, remembered across sessions and restarts: true — Aion follows your real spoken voice whenever it is open, "
    + "with no further request (source codex turns it on too); false — off (or, with source codex, capture only for this session). Covers Codex's voice only, never other apps."),
}).strict();

// ── v0.4.3: stroke animation and action sequences ───────────────────────────────────────────────────────────────

const speed = z.enum(["slow", "normal", "fast"]).describe("slow (half speed: for a learner, or \"write it more slowly\"), normal (default) or fast.");

export const showStrokeAnimationInput = z.object({
  text: z.string().min(1).max(40).optional().describe("What to write: a Chinese character or word (≤ 4: \"永\", \"爱国\"), an English letter, digit, word or name "
    + "(≤ 16 letters: \"A\", \"g\", \"HELLO\"; case matters), or a music or maths symbol or its name (\"treble clef\", \"sharp\", \"π\")."),
  symbol: z.string().min(1).max(40).optional().describe("Same as text (v0.4.3 name)."),
  system: z.enum(WRITING_SYSTEMS).optional().describe("Only to disambiguate (\"7\" as digits)."),
  form: z.enum(["simplified", "traditional"]).optional().describe("Chinese: write the simplified or traditional form (\"show the traditional form\" → traditional)."),
  highlight: z.literal("radical").optional().describe("Chinese: light the radical's strokes (explaining structure)."),
  practice: z.boolean().optional().describe("Tracing practice on the reference card (the user writes; strokes are checked)."),
  speed: speed.optional(),
  presentation: presentation.optional().describe("auto: the body writes it beside a reference card. body: the body only. card: a large reference view."),
  hold_seconds: hold.optional().describe("Default: until cleared or replaced."),
}).strict();

const sceneObjectInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).describe("A short id the actions refer to, e.g. \"box\"."),
  type: z.enum(OBJECT_TYPES).describe("box, ball, panel (a diagram card in the air, to point at) or question (a floating ?, for think)."),
  x: z.number().min(-SEQUENCE_LIMITS.reach).max(SEQUENCE_LIMITS.reach).describe(`On the stage, −${SEQUENCE_LIMITS.reach} (left) … ${SEQUENCE_LIMITS.reach} (right).`),
  size: z.enum(OBJECT_SIZES).optional(),
  from: z.number().optional().describe("A ball only: it rolls in from this x."),
  label: z.string().max(24).optional(),
}).strict();

/**
 * One flat object for every action (not a union per action), so the schema stays small for hosts that budget tool
 * metadata (v0.4.4); which fields an action takes is checked strictly by validateSequence.
 */
const actionInput = z.object({
  do: z.enum(ACTIONS).describe("walk (to), jump (over?), pick-up (object), put-down, point (at), face (toward), gesture (name), react (to?), crouch, "
    + "wait (seconds), think (about?: a question object), notice (object), examine (object: walks up slowly, looks it over), touch (object: it reacts)."),
  to: z.union([z.number(), z.string()]).optional().describe("walk: an x, or an object id; react: an object id."),
  speed: z.enum(WALK_SPEEDS).optional(),
  over: z.string().optional(), object: z.string().optional(), about: z.string().optional(),
  at: z.union([z.string(), z.tuple([z.number(), z.number()])]).optional().describe("point: an object id or [x, y]."),
  toward: z.string().optional().describe("face: left, right, viewer or an object id."),
  name: z.enum(SCENE_GESTURES).optional(), seconds: z.number().min(0.2).max(SEQUENCE_LIMITS.wait).optional(),
}).strict();

export const animationSequenceInput = z.object({
  title: z.string().min(1).max(SEQUENCE_LIMITS.title).describe("What it shows, e.g. \"Jump over a box\"."),
  start: z.object({ x: z.number().min(-SEQUENCE_LIMITS.reach).max(SEQUENCE_LIMITS.reach).optional(), facing: z.enum(FACINGS).optional() }).strict().optional()
    .describe("Where the figure stands first (default x 0, facing the viewer)."),
  objects: z.array(sceneObjectInput).max(SEQUENCE_LIMITS.objects).optional(),
  actions: z.array(actionInput).min(1).max(SEQUENCE_LIMITS.actions).describe("Approved motion primitives, in order. Turning toward a destination or an object is automatic."),
}).strict();

export const playAnimationInput = z.object({
  demo: z.enum(DEMO_NAMES as [DemoName, ...DemoName[]]).optional().describe(`A curated sequence: ${DEMO_NAMES.join(", ")}.`),
  sequence: animationSequenceInput.optional().describe(`Your own short sequence of approved primitives (at most ${SEQUENCE_LIMITS.seconds} s, ${SEQUENCE_LIMITS.actions} actions, ${SEQUENCE_LIMITS.objects} objects).`),
  speed: speed.optional(),
  hold_seconds: hold.optional(),
}).strict();

export const controlAnimationInput = z.object({
  action: z.enum(ANIMATION_ACTIONS).describe("pause, resume (or play), replay, speed (with speed), next / previous (stroke), repeat (a stroke: with stroke, or the current one), "
    + "complete (show the finished symbol), stop (end the animation)."),
  stroke: z.number().int().min(1).max(STROKE_LIMITS.symbolStrokes).optional().describe("For repeat: which stroke of the character, from 1 (\"repeat the third stroke\" → 3)."),
  character: z.number().int().min(1).max(STROKE_LIMITS.items).optional().describe("In a word: which character or letter, from 1 (repeat alone writes it again)."),
  speed: z.enum(ANIMATION_SPEEDS).optional().describe("slow, normal, fast, or slower / faster than now (\"write it more slowly\" → slower, or replay with slow)."),
}).strict();

// ── v0.4.5: interactive cards ──────────────────────────────────────────────────────────────────────────────────────
const cardSetting = z.union([z.string().max(40), z.number().finite(), z.boolean()]);
export const showInteractiveCardInput = z.object({
  app: z.enum(OPENABLE_CARD_APP_IDS),
  scene: z.record(z.string(), z.unknown()).optional().describe("generative-scene: a Scene IR document."),
  model: z.string().min(1).max(1024).optional().describe("cad-viewer: \"transformer\" or an absolute .glb/.gltf path."),
  layout: z.enum(CARD_LAYOUTS).optional(),
  presentation: z.enum(["auto", "body", "card", "hybrid"]).optional().describe("Only as the user asked. hybrid: the body forms it too."),
  settings: z.record(z.string(), cardSetting).optional()
    .describe("earth-moon: speed (days/s), focus, view, scale, teaching, labels, paused. cad-viewer: view, edges."),
  title: z.string().max(80).optional(),
  hold_seconds: z.number().min(0).max(3600).optional().describe("Default: until closed."),
}).strict();

export const controlInteractiveCardInput = z.object({
  action: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  value: z.union([z.string().max(120), z.number().finite(), z.boolean()]).optional().describe("A speed, object id, true/false or view."),
  patch: z.array(z.record(z.string(), z.unknown())).min(1).max(64).optional(),
  revision: z.number().int().min(0).optional(),
}).strict();

export const inspectInteractiveCardInput = z.object({ full: z.boolean().optional().describe("The whole scene document.") }).strict();

/** v0.7: one FreeCAD operation (the action's own arguments are validated by src/host/cad/commands.ts). */
export const cadModelInput = z.object({
  action: z.enum(CAD_ACTIONS),
  args: z.record(z.string(), z.unknown()).optional().describe("mm, degrees; \"$selected\": the viewer's selection"),
  document: z.string().max(40).optional(),
  revision: z.number().int().min(1).optional(),
}).strict();

/** v0.8: one simulation action (args validated per action in src/host/sim/commands.ts). */
export const simulateInput = z.object({
  action: z.enum(SIM_ACTIONS),
  args: z.record(z.string(), z.unknown()).optional().describe("SI units or \"value unit\"; mm for lengths"),
  study: z.string().max(24).optional(),
}).strict();

/** The embedded view's report about its interactive card (app-only; validated again by the hub). */
export const cardReportInput = z.object({ report: z.record(z.string(), z.unknown()) }).strict();
