import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CLIENT_CAPABILITIES_META_KEY, McpServer, type CallToolResult, type ClientCapabilities, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AION_BODIES, bodyLabel, PERSISTENT_BODIES } from "../../core/body";
import { AION_IDENTITY, embodimentStatement } from "../../core/identity";
import {
  cleanCode, cleanText, describePresentation, LIMITS, type ImageMode, type Presentation, type PresentationContent,
} from "../../core/presentation";
import { PRESENTATION_ROUTES, type PresentationPreference } from "../../core/presentationRouter";
import type { TerrainStyle } from "../../visual/types";
import { greetingLine, greetingLineChinese, onboardingGuidance } from "../../core/guidance";
import { ACTIVITY_STATES } from "../../core/state";
import { errorCode } from "../../visual/errors";
import { fitForIntent, portraitStyleFor, type ImageFit, type PortraitStyle } from "../../visual/types";
import { accentColor, contrastOnBlack, COLOR_PRESETS, hexToRgb, parseColor, type NamedColor } from "../../core/colors";
import { markerWords, MARKER_LIMITS, type GeoMarker } from "../../core/presentation";
import { decodeMap } from "../../visual/geo/map";
import { decodeHeightField } from "../../visual/heightfield";
import type { Frame } from "../../visual/geo/projection";
import { inside, regionFrame, type GeoRegion } from "../geo/region";
import { visualForms, type VisualFormRegistry } from "../../visual/forms";
import { clockText } from "../../visual/validate";
import { SCENE_PRESETS, SCENE_PRESET_NAMES, type ScenePreset } from "../../visual/scene3d/presets";
import { checkScene } from "../../visual/scene3d/validate";
import { SCENE_LIMITS } from "../../visual/scene3d/types";
import type { PresenceBackend, PresenceLink } from "../hub/link";
import type { DisplayPreference, HubSnapshot } from "../hub/protocol";
import { loadImageSource, MediaError } from "../media";
import { imageSize } from "../resolver/imageInfo";
import { VisualResolver } from "../resolver";
import {
  expressInput, mediaInput, setSceneViewInput, showSceneInput, openPresenceInput, setBodyFormInput, setPresenceStateInput, showArtifactInput, showClockInput, showEmojiInput,
  showFormInput, showImageInput, showNumberInput, showPortraitInput, showResultInput, showSymbolInput, showTerrainInput, showMapInput, markMapInput, setColorsInput,
  showMusicInput, playMusicInput, musicLessonInput, setAudioVisualizerInput, showStrokeAnimationInput, playAnimationInput, controlAnimationInput,
  type markerInput,
  showTextInput, showVisualFormInput, svgSource, syncInput,
} from "../schemas";
import { decideSurface, hostSupportsMcpApps, openBrowser, type SurfaceMode } from "../surface";
import { answerStep, buildScore, defaultTempo, events, highlights, moveLesson, noteFacts, type LessonPosition } from "../music";
import { checkScore, type CheckedScore, type MusicHighlight } from "../../music/notation/score";
import { lessonById, LESSONS, type Language } from "../../music/lessons/lessons";
import type { MusicLessonRef } from "../../core/presentation";
import type { AudioSettings } from "../../audio/settings";
import { packSymbol, strokeCatalogText } from "../../animation/stroke/registry";
import { lookupConcept, MUSIC_CONCEPTS } from "../../music/glossary";
import { MUSIC_FORM_IDS } from "../../music/visual/glyphForms";
import type { StrokeSequence } from "../../animation/stroke/types";
import { compiledFor, controlAnimation, sequenceFor, speedRate } from "../../animation/control";
import { chinesePack, type ChinesePack } from "../writing/chinesePack";
import { resolveWriting, type WritingFacts } from "../writing/resolve";
import { phaseAt } from "../../animation/timeline";
import { validateSequence, type AnimationSpec } from "../../animation/scene/sequence";
import { DEMO_SEQUENCES } from "../../animation/scene/demos";

export const PRESENCE_RESOURCE_URI = "ui://aion-presence/presence.html";

export { APP_TOOL_NAMES, TOOL_NAMES, type ToolName } from "./toolNames";

export interface AionServerOptions {
  link: PresenceLink;
  /** The single-file presence surface (also served by the hub as the companion page). */
  page: () => string;
  version: string;
  /** Opens the companion window (injectable for tests). `immersive`: as a foreground, full-screen-sized app window. */
  openWindow?: (url: string, options?: { immersive?: boolean }) => Promise<boolean>;
  /** Looks up portraits, images and terrain on public data sources (injectable for tests). */
  resolver?: VisualResolver;
  /** The plugin's assets/ directory, for curated first-party assets. */
  assetsDir?: string;
  /** The local clock (injectable for tests). */
  now?: () => Date;
  /** A companion window launched this recently is never replaced (it may still be loading). Default 15 s. */
  relaunchQuietMs?: number;
  /** Called once the host has connected and declared its capabilities (first-run opening). */
  onReady?: (host: { embedded: boolean; client?: string }) => void;
  env?: NodeJS.ProcessEnv;
}

const PRESENTATION_KINDS = ["form", "text", "result", "image", "terrain", "map", "clock", "number", "symbol", "emoji", "scene", "music", "artifact", "writing", "animation"] as const;

/** The structured result every Aion tool returns. */
export const presenceOutput = z.object({
  ok: z.boolean(),
  message: z.string(),
  state: z.enum(ACTIVITY_STATES),
  body: z.enum(AION_BODIES),
  presentation: z.object({
    id: z.string(), kind: z.enum(PRESENTATION_KINDS), description: z.string(), hold_seconds: z.number(),
    route: z.enum(PRESENTATION_ROUTES).describe("body: Aion's particle body became it. card: a high-fidelity card beside the body. hybrid: both."),
    reason: z.string().describe("Why this route (e.g. portrait-hybrid, fidelity, body-native, too-detailed-for-body)."),
  }).nullable(),
  surface: z.object({
    mode: z.enum(["embedded", "companion"]),
    open: z.boolean().describe("A companion window is connected, or the host is embedding Aion."),
    hooks: z.enum(["active", "not-detected"]).describe("active: Codex lifecycle hooks already reflect reading, editing, testing, building and completion."),
  }),
  shown: z.string().optional().describe("What the body shows, when you may want to say it: the local time, the form a name found, the person or place found."),
  source: z.object({ provider: z.string(), page: z.string().optional(), license: z.string().optional() }).optional()
    .describe("Where a looked-up picture or terrain came from (a public source), for attribution if asked."),
  greeting: z.object({
    due: z.boolean().describe("true once per newly opened Presence: introduce Aion in one short reply (see line); false: it is already open, do not greet again."),
    line: z.string().optional().describe("The canonical introduction in English. Word it naturally; keep the names and facts."),
    line_zh: z.string().optional().describe("The same introduction in Chinese, for a user writing in Chinese."),
  }).optional(),
  markers: z.array(z.object({ label: z.string(), lat: z.number(), lon: z.number(), color: z.string() })).optional()
    .describe("The places marked on the map or terrain on show, with their real coordinates (say them if useful)."),
  colors: z.object({ base: z.object({ hex: z.string(), name: z.string() }), accent: z.object({ hex: z.string(), name: z.string() }) }).optional()
    .describe("Aion's colours now: the particles' base colour and the accent of markers and highlights. Remembered across sessions."),
  music: z.object({
    title: z.string(), clef: z.string(), time: z.string().optional(),
    notes: z.array(z.record(z.string(), z.unknown())).describe("Each note: its pitch and name, solfège, frequency (Hz), duration, and where it sits on the staff."),
    playback: z.enum(["playing", "blocked", "requested", "no-window", "stopped"]).optional()
      .describe("playing: sounding in Aion's window now. blocked: the browser needs one click in Aion's window first (say so). requested: sent (the embedded view does not report). no-window: Aion is not open."),
    lesson: z.object({ id: z.number(), title: z.string(), step: z.number(), steps: z.number(), language: z.string(), text: z.string(), question: z.boolean().optional() }).optional()
      .describe("The lesson step on show. text is the teaching point: say it in your own words, in the user's language."),
    answer: z.object({ correct: z.boolean(), expected: z.string(), heard: z.string().nullable() }).optional(),
    concept: z.object({ id: z.string(), title: z.string(), title_zh: z.string(), point: z.string(), point_zh: z.string(), handwriting: z.string().optional() }).optional(),
  }).optional(),
  audio: z.object({
    enabled: z.boolean(), source: z.string(), mode: z.string(), intensity: z.string(), sensitivity: z.number(),
    codex: z.string().describe("Codex voice capture: streaming (real audio drives the body), starting, waiting (for Codex's audio), off, unavailable (why) or failed (why)."),
    voice_sync: z.string().optional().describe("Codex Voice Sync (remembered): off, or on with where it stands (following Codex's voice, waiting, why not)."),
    system: z.string().describe("Other apps' sound: as codex."),
    microphone: z.string().optional(), tab: z.string().optional(),
  }).optional().describe("How Aion responds to sound, and which sources are really connected. Never claim a source is connected unless it says so."),
  writing: z.object({
    text: z.string(), title: z.string(), system: z.string(), convention: z.string(), note: z.string().optional(), notes: z.array(z.string()).optional(),
    symbols: z.array(z.object({
      symbol: z.string(), strokes: z.array(z.string()).describe("Where the pen goes in each stroke, in order (stroke 1 first)."),
      names: z.array(z.string()).optional(), form: z.string().optional(), pinyin: z.array(z.string()).optional(), definition: z.string().optional(),
      radical: z.string().optional(), radical_strokes: z.array(z.number()).optional(), decomposition: z.string().optional(),
      etymology: z.record(z.string(), z.unknown()).optional(), traditional: z.array(z.string()).optional(), simplified: z.array(z.string()).optional(),
      converted_from: z.string().optional(),
    })),
    stroke: z.object({ symbol: z.number(), n: z.number(), direction: z.string() }).optional().describe("The stroke being written now (or repeated): which symbol (from 1) and which of its strokes."),
    playback: z.enum(["playing", "paused", "finished"]), speed: z.number(),
  }).optional().describe("What is being written: its convention, each symbol's strokes in order, and (Chinese) its dictionary facts, for your explanation."),
  animation: z.object({
    title: z.string(), seconds: z.number(), actions: z.array(z.string()), playback: z.enum(["playing", "paused", "finished"]), speed: z.number(),
  }).optional().describe("The action sequence on show: what it does and its length. Do not narrate every movement."),
  url: z.string().optional().describe("The local companion window address (open_presence only)."),
  window_opened: z.boolean().optional(),
  fullscreen: z.enum(["requested", "not-requested"]).optional(),
  immersive: z.object({
    requested: z.boolean(),
    path: z.enum(["host-fullscreen", "companion-fullscreen", "companion-window", "none"])
      .describe("host-fullscreen: asked the host for its fullscreen display mode (the host's own composer or voice controls may stay). "
        + "companion-fullscreen: a foreground window that enters true fullscreen at the user's first click on Enter Presence. "
        + "companion-window: a foreground window only. none: not requested."),
    needs_gesture: z.boolean().describe("The browser requires one click (Enter Presence) before true fullscreen."),
  }).optional(),
});
type PresenceOutput = z.infer<typeof presenceOutput>;

/** Every form id SCF's own visual language offers, grouped by category (symbols have their own tool). */
export function formCatalog(registry: VisualFormRegistry = visualForms): string {
  return registry.categories().filter(category => category.id !== "symbol")
    .map(category => `${category.label}: ${registry.forms().filter(form => form.category === category.id).map(form => form.id).join(", ")}`)
    .join(". ");
}

/** The variants forms declare, forms with the same set grouped together; the first is the default (SCF). */
export function formVariantCatalog(registry: VisualFormRegistry = visualForms): string {
  const groups = new Map<string, string[]>();
  for (const form of registry.forms()) {
    if (!form.variants?.length) continue;
    const key = form.variants.map((variant, index) => `${variant.id}${index ? "" : " (default)"}`).join(" or ");
    groups.set(key, [...(groups.get(key) ?? []), form.id]);
  }
  return [...groups].map(([variants, forms]) => `${forms.join(", ")}: ${variants}`).join("; ");
}

/**
 * Tool descriptions are part of the visual-intent system: Codex chooses a visual from them. The wording is
 * SCF's, tuned there over many conversations, with "your particle body" read as Aion, Codex's body.
 */
export const TOOL_DESCRIPTIONS = {
  show_image: `Form a picture of almost anything with Aion's particle body (a person, object, animal, building, place, artwork, logo, map or `
    + `idea). query: Aion's curated assets first (such as the ${AION_IDENTITY.creatorCompany} logo), then open image sources (Wikipedia, Commons, `
    + "Openverse); source: an image on this machine, shown as it is (intent portrait if the user says it is one). Use when seeing it helps. "
    + "For a real person's face prefer show_portrait; for Taoist symbols, constellations and zodiac signs use show_form.",
  show_portrait: "Form a portrait of a real person with Aion's particle body, from public photos (Wikipedia first): by default a heritage portrait (an "
    + "antique oval of particles) beside the original photograph. Use when the user wants to see what someone looks like (\"What did Nikola Tesla "
    + "look like?\", \"展示一下牛顿的肖像\"). source: a portrait photograph on this machine instead. style \"classic\" only when asked (\"without the oval\"). "
    + "Not just because a name appears.",
  show_terrain: "Form the terrain of a real region as a raised relief with Aion's particle body, from real elevation data: mountains rise, "
    + "valleys sink. Use for the terrain, topography, relief or landscape shape of a country, region, island, mountain range or other "
    + "place (\"What is the terrain of Scotland like?\", \"Show me the Swiss Alps\").",
  show_map: "Show a geographic map with Aion's particle body — the outline of a continent, country, part of one, state or city, its "
    + "borders, and its neighbours faintly around it — and mark places on it with coloured markers and labels at their real coordinates. "
    + "Use when the user asks where something is, or to see a country, region or continent as a map (\"Show me where Los Angeles is in "
    + "the USA\" → region United States, markers [Los Angeles]; \"Show me Scotland and mark Glasgow in red\"; \"Show me the United States\"; "
    + "\"Show me Africa\"). For mountains, relief and topography use show_terrain instead (it takes markers too). A map is not a picture: never "
    + "use show_image for one.",
  mark_map: "Change the places marked on the map or terrain on show, without forming it again: add places (\"Mark Los Angeles in red\", "
    + "\"Add New York in yellow\", \"Add it to the map\"), change one (\"Change the Los Angeles marker to blue\"), remove one (\"Remove the "
    + "New York marker\") or clear them. Places are found by name near the region on show (Glasgow on Scotland is Glasgow, Scotland). If the "
    + "map has already gone, it comes back with the change. A place outside the view widens it.",
  set_colors: "Change Aion's colours, remembered across sessions: base is the colour of every particle (the sphere, the eyes, the figure, "
    + "every particle visual and 3D object); accent is the colour of markers and highlights. Names in any language (\"blue\", \"warm gold\", "
    + `"紫色"), presets (${COLOR_PRESETS.join(", ")}) or #RRGGBB. "Restore your original colour" → reset base (Aion Silver). Photographs and `
    + "cards are never tinted. Use only when the user asks for a colour.",
  show_form: () => "Form a symbol or figure from Aion's own visual language directly with its particle body. It is drawn procedurally on the "
    + "device, with no image search: Taoist symbols (the yin-yang/taiji, the yin and yang lines, the eight trigrams 乾 兑 离 震 巽 坎 艮 坤 "
    + "and the bagua), constellations as star maps, the twelve zodiac signs and the planetary symbols. Always prefer it to show_image for "
    + "these (\"What does Orion look like?\", \"Show me the yin-yang\"). Pass a form id from the list, or a plain name in English or Chinese "
    + `("yin yang", "Orion", "Leo zodiac sign", "猎户座"). Form ids: ${formCatalog()}.`,
  show_clock: "Form a clock face showing a time with Aion's particle body. Use when seeing a time helps: the user asks what time it is, or "
    + "a specific time matters to the answer. Omit time to show the user's current local time; the result tells you that time so you can say it.",
  show_number: "Show one short, key number with Aion's particle body (e.g. 42%, 84, 23°C, £28,000, 3.14). Use only for the single number "
    + "that is the heart of the answer, not for every number mentioned.",
  show_text: `Show text with Aion. One short word or label (up to 16 plain characters, e.g. a city, a name, "48/48") becomes the particle `
    + `body itself: use it sparingly, when a single word is the answer or a useful anchor. Longer text (≤ ${LIMITS.text} characters) appears as `
    + "quiet typography beside the presenting body, for one point the user should see at a glance. Not for logs or code (show_artifact).",
  show_symbol: "Show a simple symbol with Aion's particle body, e.g. a check for yes/correct, a cross for no/wrong, a heart, a star, or an "
    + "arrow for a direction or trend.",
  show_emoji: "Briefly form one emoji with Aion's particle body as a short expressive reaction, like a gesture: e.g. 🎉 for a celebration, "
    + "😂 amusement, 🤔 thinking, 😮 surprise, 👍 approval, 💡 an idea, 🚀 a launch. Also use it when the user asks to see an emoji. It is drawn "
    + "instantly on the device (no image search). Use it only when a reaction genuinely adds to the moment, never on every reply or as filler.",
  clear_presentation: "Immediately end the temporary visual or presentation, e.g. when it is no longer relevant: Aion returns to its current "
    + "persistent body (the sphere or the figure). It does not change that body; use set_body_form for that. Presentations also end by "
    + "themselves after their hold.",
  set_body_form: "Change Aion's persistent body, the form it rests in between visuals: "
    + `${PERSISTENT_BODIES.map(body => `"${body.id}" (${body.description.replace(/^your /, "its ")})`).join(", ")}. `
    + "Use it only when the user asks Aion to take a form, e.g. \"show your eyes\", \"take a human form\", \"become a figure\", "
    + "\"become a sphere\", \"go back to your original form\" (the sphere), \"变成人形\", \"回到球体\". It stays until changed; every "
    + "temporary visual returns to it. A figure or eyes are not something to search for: never use show_image or show_portrait for them.",
  show_scene: "Form a genuine 3D object with Aion's particle body when the user wants to see something's 3D shape (\"Show me an Egyptian "
    + `pyramid in 3D", "Visualize Saturn", "a DNA double helix"). Presets: ${SCENE_PRESET_NAMES.join(", ")}; otherwise compose primitives `
    + `(at most ${SCENE_LIMITS.objects} objects). It turns; the user can drag, zoom, reset. A conceptual model, not measured. Not for `
    + "pictures, people or terrain.",
  set_scene_view: "Change how the 3D object on show is viewed: \"rotate it\" (rotate left or right), \"show it from above\" (rotate up), "
    + "\"from below\" (rotate down), \"zoom in\", \"stop rotating\" (spin false), \"back to the default view\" (reset). Only while a "
    + "show_scene object is on show; to leave it, use clear_presentation.",
  show_music: "Show music notation exactly, engraved on a staff beside Aion (VexFlow, Bravura): notes, a scale, a melody or rhythm, an empty staff "
    + "(staff: true), or a glossary concept with its example (concept: \"alto clef\", \"half rest\", \"tie\", \"repeat sign\", \"6/8\"). Use it whenever "
    + "the user learns notes, clefs, rhythms or symbols (\"Show me a 4/4 measure with four quarter notes\"). C4 is middle C. highlight lights notes, a line, "
    + "space, the clef, time or key; symbol makes the body form it; play: true plays it. How a symbol is drawn by hand: show_stroke_animation.",
  play_music: "Play music on this device (A4 = 440 Hz, a soft piano-like tone, nothing generated by a model): the music on show (optionally only some "
    + "notes, by index), or notes or a scale you give (they are shown as they play). Each note lights up the moment it sounds, and Aion's body moves "
    + "with the sound. Use when the user asks to hear something (\"Can you play it?\", \"Play the C major scale\", \"Play it slower\" → tempo). "
    + "stop: true stops. If the result says blocked, the user must click once in Aion's window (a browser rule) — say so.",
  music_lesson: `Teach music theory step by step with Aion's notation, playback and body. Lessons: ${LESSONS.map(lesson => `${lesson.id} ${lesson.title.en}`).join("; ")}. `
    + "Start one (\"I want to learn to read music\" → lesson 1), go on (step next, previous, repeat), switch language (language zh or en: the lesson and "
    + "step stay), or check the user's answer to a practice question (answer: \"E\"). Each result has the step's teaching point (music.lesson.text): "
    + "say it in your own words, in the user's language, then wait for them; never read the whole lesson at once.",
  set_audio_visualizer: "How Aion moves with sound: the source (the user's microphone; your own spoken voice on this Mac — Codex Voice Sync, "
    + "remembered once asked; another app's music; a shared tab; Aion's own music), the form (auto, sphere, spectrum — a circular particle spectrum — "
    + "or hybrid), the intensity and sensitivity. Only when asked (\"React to your own voice\" → source codex; \"Visualize the music\" → mode spectrum; "
    + "\"back to normal\" → mode sphere). Capturing needs macOS and the user's permission; never claim more than the result says is connected.",
  show_stroke_animation: () => "Teach handwriting: Aion's particle body writes a Chinese character or short word, an English letter, word or name, "
    + "a digit, or a music or maths symbol stroke by stroke in the right order, beside a reference card. Chinese: about 9,500 characters, "
    + "simplified and traditional, with their true stroke shapes; the result adds pinyin, meaning, radical and structure. Use when the user wants to "
    + "learn to write something (\"Teach me how to write 永\", \"How do you write 国?\", \"Write HELLO\", \"Write my name\", \"How do I draw a treble clef?\"). "
    + "Pass the character itself, not its meaning. Never invent an order: if data is missing, say so. Then control_animation.",
  play_animation: "Play a short particle animation of Aion's own flexible figure (not a video): a curated demo or a sequence of approved actions "
    + "— walk, jump, pick-up, put-down, point, face, gesture, react, crouch, wait, think, notice, examine, touch — with up to three objects (box, ball, "
    + "panel, question). \"Show a stick figure jumping over a box\" → demo jump-over-obstacle; \"Animate the figure thinking\" → thinking; \"Make it explore "
    + "this box\" → exploring. The body becomes the figure and returns. Keep it short; one sentence about it, no running commentary.",
  control_animation: "Control the animation on show — a symbol being written or a figure's action sequence: pause, resume, replay, change speed "
    + "(\"write it more slowly\" → replay with speed slow, \"faster\"), next or previous stroke, repeat a stroke (\"repeat the third stroke\" → "
    + "repeat, stroke 3), complete (\"show the whole character again\"), stop. The result says which stroke is being written and how.",
  express: "Show an expression or a gesture with Aion's body, briefly, when the user asks for one (\"look happy\", \"a curious expression\", "
    + "\"wave\") or — rarely — when a small reaction adds to the moment. The eyes wear it; the figure acts it out; the sphere gathers. It "
    + "does not change the body and ends by itself. Aion's state already shows listening, thinking and answering: never call this for those.",
} as const;

/** The route in a few words, for the tool result. */
function routeWords(presentation: Presentation): string {
  const seconds = (value: number) => value ? `${Math.round(value)} s` : "until cleared";
  switch (presentation.route) {
    case "body": return `the body becomes it (${seconds(presentation.bodyHold)}; ${presentation.reason})`;
    case "card": return `a card beside the body (${seconds(presentation.cardHold)}; ${presentation.reason})`;
    case "hybrid": return `the body forms it (${seconds(presentation.bodyHold)}) and a card shows ${presentation.kind === "writing" ? "the numbered stroke order" : presentation.kind === "music" ? "the notation" : "the original"} (${seconds(presentation.cardHold)}; ${presentation.reason})`;
  }
}

/** Model-facing explanations of resolver failures (SCF's tool statuses), so Codex can carry on in words. */
function resolveFailure(code: string, what: string): string {
  switch (code) {
    case "portrait-not-found": return `portrait-not-found: no public portrait of ${what} was found. Describe them in words instead.`;
    case "image-not-found": return `image-not-found: no suitable open image of "${what}" was found. Describe it in words, or try a more specific query.`;
    case "region-not-found": return `region-not-found: no place called "${what}" was found. Check the name, or describe the terrain in words.`;
    case "terrain-unavailable": return `terrain-unavailable: elevation data for ${what} could not be loaded right now. Describe the terrain in words.`;
    case "region-unavailable": return `region-unavailable: the place finder (OpenStreetMap) could not be reached for "${what}". Countries, continents and their named parts work offline; try one of those, or answer in words.`;
    case "place-not-found": return `place-not-found: no place called "${what}" was found to mark. Check the name, or add the country (e.g. "Springfield, Illinois").`;
    case "place-unavailable": return `place-unavailable: the place finder could not be reached to find "${what}". Major cities work offline; otherwise answer in words.`;
    default: return `${code}: the public image sources could not be reached right now. Answer in words; Aion stays as it is.`;
  }
}

/**
 * The Aion Presence MCP server: a small, coherent tool surface over the presence hub. Codex is the
 * intelligence and calls these tools; nothing here calls a model or holds a credential. The only network it
 * uses beyond its loopback hub is public data (pictures, places, elevation) when Codex asks to show one.
 */
export function createAionServer(options: AionServerOptions): McpServer {
  const { link } = options;
  const env = options.env ?? process.env;
  const openWindow = options.openWindow ?? openBrowser;
  const resolver = options.resolver ?? new VisualResolver({ env, assetsDir: options.assetsDir });
  const now = options.now ?? (() => new Date());
  const server = new McpServer({ name: "aion-presence", title: "Aion Presence", version: options.version }, {
    instructions: `${embodimentStatement("Codex")} Call open_presence with display "immersive" when the user asks to open Aion. While Aion `
      + "is open, you are present to the user as Aion: speak in the first person, never describe Aion as a separate agent, and do not narrate "
      + "these tools. When the user asks to see something, or what someone or something looks like, show it with the matching tool instead of "
      + `only describing it; otherwise use the tools sparingly. ${onboardingGuidance()} See the aion-presence skill (Embodiment Mode).`,
  });
  let embeddedSeen = false;
  /** When this server last launched a companion window: a window still loading is never replaced. */
  let launchedAt = -Infinity;
  const RELAUNCH_QUIET_MS = options.relaunchQuietMs ?? 15_000;
  /** When an embedded view last synced: it is showing Aion right now if that was recent. */
  let embeddedSyncAt = -Infinity;
  const EMBEDDED_LIVE_MS = 30_000;

  const capabilities = (ctx?: ServerContext): ClientCapabilities | undefined =>
    (ctx?.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined
    ?? server.server.getClientCapabilities();
  const modeFor = (ctx?: ServerContext): SurfaceMode => decideSurface(capabilities(ctx), "auto", env).mode;

  const summarize = (snapshot: HubSnapshot, mode: SurfaceMode, message: string, ok = true): PresenceOutput => ({
    ok, message,
    state: snapshot.activity.state,
    body: snapshot.body,
    presentation: snapshot.presentation
      ? {
        id: snapshot.presentation.id, kind: snapshot.presentation.kind, description: describePresentation(snapshot.presentation), hold_seconds: snapshot.presentation.hold,
        route: snapshot.presentation.route, reason: snapshot.presentation.reason,
      }
      : null,
    surface: { mode, open: mode === "embedded" ? embeddedSeen : snapshot.hub.viewers > 0, hooks: snapshot.hub.hooksActive ? "active" : "not-detected" },
  });
  const result = (output: PresenceOutput): CallToolResult => {
    const notOpen = !output.surface.open && output.surface.mode === "companion" ? " (Aion is not open: call open_presence if the user wants to see it.)" : "";
    return { content: [{ type: "text", text: `${output.message}${notOpen}` }], structuredContent: output };
  };
  const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
  const run = async (ctx: ServerContext | undefined, command: (backend: PresenceBackend) => Promise<HubSnapshot>, message: (snapshot: HubSnapshot) => string,
    extra: Partial<PresenceOutput> = {}) => {
    const snapshot = await link.run(command);
    return result({ ...summarize(snapshot, modeFor(ctx), message(snapshot)), ...extra });
  };
  const present = (ctx: ServerContext, content: PresentationContent, hold?: number, extra: Partial<PresenceOutput> = {},
    request: { presentation?: PresentationPreference; detail?: boolean; rate?: number } = {}) =>
    run(ctx, backend => backend.apply({ type: "present", content, hold, ...request }),
      snapshot => `Shown: ${describePresentation(content)}${snapshot.presentation ? ` — ${routeWords(snapshot.presentation)}` : ""}. `
        + "Answer in your own voice, in the first person; do not narrate this tool call.", extra);
  const media = async (source: string) => {
    const { data, mime } = await loadImageSource(source);
    return link.run(backend => backend.addMedia(data, mime));
  };
  const mediaFailure = (error: unknown) => error instanceof MediaError ? failure(`${error.message}: ${error.detail}`) : failure("image-unavailable: the image could not be read.");
  const hand = (bytes: Uint8Array, mime: string) => link.run(backend => backend.addMedia(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime));
  const credit = (source: { provider: string; license?: string }) => source.provider === "local-assets" ? undefined
    : `${{ wikipedia: "Wikipedia", commons: "Wikimedia Commons", openverse: "Openverse", web: "Web search" }[source.provider] ?? source.provider}${source.license ? ` · ${source.license}` : ""}`.slice(0, LIMITS.title);
  const label = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, LIMITS.title) || undefined;
  const size = (bytes: Uint8Array) => imageSize(bytes) ?? {};
  /**
   * A picture on this machine (a screenshot, a generated image, a photograph the user names). Its bytes are kept as
   * they are, so the card shows the original; `fit` and `style` come from the request, never from the file.
   */
  const presentLocal = async (ctx: ServerContext, source: string, fit: ImageFit, style: PortraitStyle | undefined, alt: string | undefined,
    args: { mode?: ImageMode; hold_seconds?: number }, request: { presentation?: PresentationPreference; detail?: boolean }) => {
    try {
      const { data, mime } = await loadImageSource(source);
      const ref = await link.run(backend => backend.addMedia(data, mime));
      return present(ctx, {
        kind: "image", media: ref, ...(args.mode ? { mode: args.mode } : {}), fit, origin: "local", ...(style ? { style } : {}), ...size(data), ...(alt ? { alt } : {}),
      }, args.hold_seconds, {}, request);
    } catch (error) { return mediaFailure(error); }
  };

  const showForm = (ctx: ServerContext, args: z.infer<typeof showFormInput>) => {
    const match = visualForms.lookup(args.form);
    if (!match) return failure(`form-not-found: "${args.form}" is not one of Aion's visual forms yet. Use another tool (show_image for a picture), or just speak. Available: ${visualForms.ids().join(", ")}.`);
    // An unknown variant falls back to the default, like an image intent (SCF): only a well-formed but unknown name fails.
    const variant = (args.variant === undefined ? undefined : visualForms.variant(match.entry, args.variant)) ?? match.variant;
    const shown = visualForms.label(match.entry.id, variant);
    return present(ctx, { kind: "form", form: match.entry.id, ...(variant ? { variant } : {}), label: shown }, args.hold_seconds, { shown });
  };

  registerAppResource(server, "Aion Presence", PRESENCE_RESOURCE_URI, {
    description: "The Aion Presence surface: Aion's particle body and the presentations it carries.",
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: { microphone: {} }, prefersBorder: false } },
  }, async () => ({
    contents: [{
      uri: PRESENCE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: options.page(),
      // The microphone is only analysed locally for body language (never recorded or sent); hosts may decline it.
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: { microphone: {} }, prefersBorder: false } },
    }],
  }));

  registerAppTool(server, "open_presence", {
    title: "Open Aion",
    description: [
      `Open ${AION_IDENTITY.name}, your embodied interface: while it is open the user sees and hears you through Aion. Use when the user asks to open,`,
      "show or wake Aion (\"Open Aion\", \"打开 Aion\") — then pass display \"immersive\" — or once before presenting something visually when Aion is",
      "not open. Aion is not another AI model: you keep doing all reasoning and work. In hosts that render MCP Apps Aion appears inside the host",
      "(fullscreen where the host offers it); otherwise a local companion window opens in the foreground. Calling it again is harmless and does",
      "not open a second window. Do not call it every turn.",
    ].join(" "),
    inputSchema: openPresenceInput,
    annotations: { title: "Open Aion", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI } },
  }, async (args, ctx) => {
    const decision = decideSurface(capabilities(ctx), args.surface ?? "auto", env);
    const display: DisplayPreference = args.display ?? "auto";
    const immersive = display === "immersive" || display === "fullscreen";
    // A newly opened Presence (nothing is showing Aion yet) greets once: a small wave, and Codex's introduction.
    const before = await link.run(backend => backend.state());
    const fresh = decision.mode === "embedded" ? Date.now() - embeddedSyncAt > EMBEDDED_LIVE_MS : before.hub.viewers === 0;
    let snapshot = await link.run(backend => backend.apply({ type: "open", display, greet: fresh }));
    // Aion may already be showing because it opened by itself on the first run: Codex still introduces it, once.
    const introduce = fresh || before.hub.introduction;
    if (before.hub.introduction) snapshot = await link.run(backend => backend.apply({ type: "introduced" }));
    if (args.body) snapshot = await link.run(backend => backend.apply({ type: "body", body: args.body! }));
    // AION_PRESENCE_DEBUG=1 opens the companion with its diagnostics (for `npm run diagnose`; development only).
    const url = link.current?.surfaceUrl && `${link.current.surfaceUrl}${env.AION_PRESENCE_DEBUG === "1" ? "&debug=1" : ""}`;
    let opened = false;
    if (decision.mode === "embedded") embeddedSeen = true;
    else if (snapshot.hub.viewers === 0 && url) opened = await openWindow(url, { immersive });
    else if (immersive && url && !snapshot.hub.surface.visible && !snapshot.hub.surface.fullscreen && Date.now() - launchedAt > RELAUNCH_QUIET_MS) {
      // Open but hidden behind other windows (or minimized): a page cannot raise itself, but a newly launched app
      // window comes to the front. It replaces the open one, which retires as soon as the new one connects. (Focus
      // alone is not used: a pending permission prompt takes it from a window that is in front.)
      snapshot = await link.run(backend => backend.apply({ type: "supersede" }));
      opened = await openWindow(url, { immersive });
    }
    if (opened) launchedAt = Date.now();
    const output = summarize(snapshot, decision.mode, decision.mode === "embedded"
      ? `Aion is open ${immersive ? "and asked the host for fullscreen (the host decides; its own composer may stay visible)" : "in this conversation"}, as the ${bodyLabel(snapshot.body)}.`
      : opened ? `Aion opened in its own ${immersive ? "foreground window; one click on Enter Presence makes it fullscreen" : "window"}, as the ${bodyLabel(snapshot.body)}.`
        : snapshot.hub.viewers > 0 ? `Aion is already open${snapshot.hub.surface.fullscreen ? " in fullscreen (its own space)" : snapshot.hub.surface.visible ? " on screen" : ""}, as the ${bodyLabel(snapshot.body)}.`
          : `Aion is ready as the ${bodyLabel(snapshot.body)}; open ${url ?? "the companion window"} to see it.`);
    if (decision.mode === "companion") output.surface.open = snapshot.hub.viewers > 0 || opened;
    const greeting = introduce ? { due: true, line: greetingLine(), line_zh: greetingLineChinese() } : { due: false };
    if (introduce) output.message += " A greeting is due: introduce Aion once, briefly (see greeting.line).";
    const path = !immersive ? "none" : decision.mode === "embedded" ? "host-fullscreen" : "companion-fullscreen";
    return result({
      ...output, greeting, url, window_opened: opened, fullscreen: immersive ? "requested" : "not-requested",
      immersive: { requested: immersive, path, needs_gesture: path === "companion-fullscreen" },
    });
  });

  server.registerTool("set_presence_state", {
    title: "Set Aion's state",
    description: [
      `Reflect what Codex is doing in Aion's body language: ${ACTIVITY_STATES.join(", ")}.`,
      "When open_presence reports hooks: active, reading, editing, testing, building and completion already follow Codex automatically; then use this only",
      "for phases hooks cannot see (thinking through a design, an error you diagnosed). When hooks are not detected, set the state at the start of each",
      "meaningful phase. Never call it for every small step, and never claim a state that is not true.",
    ].join(" "),
    inputSchema: setPresenceStateInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, ctx) => run(ctx, backend => backend.apply({ type: "activity", state: args.state, label: args.label }), () => `State: ${args.state}. Nothing to tell the user about it.`));

  server.registerTool("set_body_form", {
    title: "Set Aion's body",
    description: TOOL_DESCRIPTIONS.set_body_form,
    inputSchema: setBodyFormInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, ctx) => run(ctx, backend => backend.apply({ type: "body", body: args.body }), snapshot => `Body: ${bodyLabel(snapshot.body)}. Say it in the first person if at all (e.g. "Here I am in human form").`,
    { shown: bodyLabel(args.body) }));

  server.registerTool("express", {
    title: "Express",
    description: TOOL_DESCRIPTIONS.express,
    inputSchema: expressInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => {
    if (!args.expression && !args.gesture) return failure("invalid-arguments: give an expression (e.g. \"happy\") or a gesture (e.g. \"wave\").");
    return run(ctx, backend => backend.apply({ type: "express", ...args }),
      snapshot => `Expressed ${[args.expression, args.gesture].filter(Boolean).join(" and ")} as the ${bodyLabel(snapshot.body)}. Do not narrate it.`);
  });

  server.registerTool("show_scene", {
    title: "Show a 3D object",
    description: TOOL_DESCRIPTIONS.show_scene,
    inputSchema: showSceneInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => {
    if ((args.preset === undefined) === (args.scene === undefined)) return failure("invalid-arguments: give exactly one of preset or scene.");
    const check = checkScene(args.preset ? SCENE_PRESETS[args.preset as ScenePreset] : args.scene);
    if (!check.ok) return failure(`scene-invalid: ${check.problem}. Fix it and try again, or describe it in words.`);
    return present(ctx, { kind: "scene", scene: check.scene, label: check.scene.title, ...(args.preset ? { preset: args.preset } : {}) }, args.hold_seconds,
      { shown: check.scene.title });
  });

  server.registerTool("set_scene_view", {
    title: "Turn the 3D object",
    description: TOOL_DESCRIPTIONS.set_scene_view,
    inputSchema: setSceneViewInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    const before = await link.run(backend => backend.state());
    if (before.presentation?.kind !== "scene") return failure("no-scene: no 3D object is on show. Use show_scene first.");
    return run(ctx, backend => backend.apply({ type: "view", ...args }), () => "View changed. Do not narrate it.");
  });

  server.registerTool("show_image", {
    title: "Show an image",
    description: TOOL_DESCRIPTIONS.show_image,
    inputSchema: showImageInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    if ((args.query === undefined) === (args.source === undefined)) {
      return failure("invalid-arguments: give exactly one of query (something to look up, e.g. \"Eiffel Tower\") or source (an image file on this machine).");
    }
    if (args.source !== undefined) {
      // A local picture is a portrait only when the request says so (intent portrait or celebrity); then it is
      // composed exactly as a looked-up one (heritage unless classic was asked for). Anything else stays an object.
      const fit = fitForIntent(args.intent ?? "general");
      return presentLocal(ctx, args.source, fit, portraitStyleFor(fit, args.style), args.alt, args, { presentation: args.presentation, detail: args.detail });
    }
    try {
      const found = await resolver.image(args.query!, args.intent ?? "general");
      const ref = await hand(found.bytes, found.mime);
      const alt = args.alt ?? label(found.label);
      const by = credit(found.source);
      // A person's picture is a heritage portrait unless classic was asked for; nothing else is ever framed as one.
      const style = portraitStyleFor(found.fit, args.style);
      return present(ctx, {
        kind: "image", media: ref, ...(args.mode ? { mode: args.mode } : {}), fit: found.fit, origin: "lookup", ...(style ? { style } : {}),
        ...(found.width && found.height ? { width: found.width, height: found.height } : {}), ...(alt ? { alt } : {}), ...(by ? { credit: by } : {}),
      }, args.hold_seconds, { shown: found.label, source: found.source }, { presentation: args.presentation, detail: args.detail });
    } catch (error) { return failure(resolveFailure(errorCode(error), args.query!)); }
  });

  server.registerTool("show_portrait", {
    title: "Show a portrait",
    description: TOOL_DESCRIPTIONS.show_portrait,
    inputSchema: showPortraitInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    if (args.person === undefined && args.source === undefined) return failure("invalid-arguments: give person (a name to look up) or source (a portrait photograph on this machine).");
    // A photograph on this machine: no lookup, the same composition as a looked-up portrait.
    if (args.source !== undefined) return presentLocal(ctx, args.source, "portrait", portraitStyleFor("portrait", args.style), args.alt ?? args.person, args, { presentation: args.presentation });
    const person = args.person!;
    try {
      const found = await resolver.portrait(person);
      const ref = await hand(found.bytes, found.mime);
      const by = credit(found.source);
      return present(ctx, {
        kind: "image", media: ref, fit: "portrait", origin: "lookup", alt: label(found.label) ?? person, style: portraitStyleFor("portrait", args.style),
        ...(found.width && found.height ? { width: found.width, height: found.height } : {}), ...(by ? { credit: by } : {}),
      }, args.hold_seconds, { shown: found.label, source: found.source }, { presentation: args.presentation });
    } catch (error) { return failure(resolveFailure(errorCode(error), person)); }
  });

  // ── Geography: maps, terrain and the places marked on them ─────────────────────────────────────────────────

  /** The last geographic presentation this server showed: "Add New York" brings it back if it has gone. */
  let lastGeo: { kind: "map" | "terrain"; region: string; style: TerrainStyle; markers: GeoMarker[] } | null = null;
  type MarkerArg = z.infer<typeof markerInput>;
  const appearance = async () => (await link.run(backend => backend.state())).appearance;
  const colorFailure = (words: string) => failure(`color-unknown: "${words}" is not a colour Aion knows. Use a name (red, orange, yellow, gold, `
    + `green, teal, cyan, blue, sky blue, navy, purple, violet, pink, rose, white, grey — or in Chinese, e.g. 红色, 紫色), a preset (${COLOR_PRESETS.join(", ")}) or #RRGGBB.`);
  const slug = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `p${Math.random().toString(36).slice(2, 8)}`;
  const sameMarker = (marker: GeoMarker, name: string) => {
    const key = name.trim().toLowerCase();
    return marker.label.toLowerCase() === key || marker.id === slug(name);
  };
  /** Finds each place near the region and gives it its colour (the accent unless asked). Throws a failure result. */
  const placeMarkers = async (list: readonly MarkerArg[], near: { region?: GeoRegion; frame?: Frame }): Promise<GeoMarker[] | CallToolResult> => {
    const accent = (await appearance()).accent.hex;
    const out: GeoMarker[] = [];
    for (const item of list) {
      let color = accentColor(accent);
      if (item.color) { const parsed = parseColor(item.color); if (!parsed) return colorFailure(item.color); color = accentColor(parsed.hex); }
      try {
        const found = await resolver.place(item.place, near);
        const label = (item.label ?? item.place).slice(0, MARKER_LIMITS.label);
        out.push({ id: slug(label), label, lat: Math.round(found.lat * 1e5) / 1e5, lon: Math.round(found.lon * 1e5) / 1e5, color, ...(item.highlight ? { highlight: true } : {}) });
      } catch (error) { return failure(resolveFailure(errorCode(error), item.place)); }
    }
    return out;
  };
  const coordinate = (marker: GeoMarker) => `${Math.abs(marker.lat).toFixed(2)}° ${marker.lat >= 0 ? "N" : "S"}, ${Math.abs(marker.lon).toFixed(2)}° ${marker.lon >= 0 ? "E" : "W"}`;
  const markerOutput = (markers: readonly GeoMarker[]) => markers.map(({ label, lat, lon, color }) => ({ label, lat, lon, color }));
  const markerShown = (markers: readonly GeoMarker[]) => markers.map(marker => `${marker.label} (${coordinate(marker)})`).join("; ");
  const merge = (existing: GeoMarker[], added: GeoMarker[]) => {
    const out = [...existing];
    for (const marker of added) {
      const at = out.findIndex(other => other.id === marker.id);
      if (at >= 0) out[at] = marker; else out.push(marker);
    }
    return out.slice(-MARKER_LIMITS.markers);
  };

  const presentMap = async (ctx: ServerContext, region: string, markers: GeoMarker[], hold?: number, preference?: PresentationPreference) => {
    const found = await resolver.map(region, markers.map(marker => [marker.lon, marker.lat]));
    // A place that is a point (a city, a mountain) marks itself when nothing else is marked.
    if (!markers.length && found.region.point) {
      const [lon, lat] = found.region.point;
      markers = [{ id: slug(found.region.label), label: found.region.label.slice(0, MARKER_LIMITS.label), lat, lon, color: accentColor((await appearance()).accent.hex), highlight: true }];
    }
    const ref = await hand(found.bytes, found.mime);
    lastGeo = { kind: "map", region, style: "terrain", markers };
    // Natural Earth names are clean English; a place found on OpenStreetMap is called what the user called it.
    const name = (found.region.provider === "natural-earth" ? label(found.region.label) : label(region)) ?? region;
    return present(ctx, { kind: "map", media: ref, label: name, region, markers, credit: found.source.provider }, hold,
      { shown: `${name}${markers.length ? ` — ${markerShown(markers)}` : ""}`, source: found.source, markers: markerOutput(markers) }, { presentation: preference });
  };

  const presentTerrain = async (ctx: ServerContext, region: string, style: TerrainStyle, markers: GeoMarker[], hold?: number, preference?: PresentationPreference) => {
    const found = await resolver.terrain(region, style, undefined, markers.map(marker => [marker.lon, marker.lat]));
    const ref = await hand(found.bytes, found.mime);
    const { elevation } = found.field;
    const by = credit(found.source);
    lastGeo = { kind: "terrain", region, style, markers };
    return present(ctx, {
      kind: "terrain", media: ref, style, label: (found.source.provider.includes("natural-earth") ? label(found.label) : label(region)) ?? region, region,
      ...(markers.length ? { markers } : {}), ...(elevation ? { elevation: { min: elevation.min, max: elevation.max } } : {}), ...(by ? { credit: by } : {}),
    }, hold, {
      shown: `${found.label}${elevation ? ` (elevation ${elevation.min}–${elevation.max} m)` : ""}${markers.length ? ` — ${markerShown(markers)}` : ""}`,
      source: found.source, ...(markers.length ? { markers: markerOutput(markers) } : {}),
    }, { presentation: preference });
  };

  server.registerTool("show_terrain", {
    title: "Show terrain",
    description: TOOL_DESCRIPTIONS.show_terrain,
    inputSchema: showTerrainInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    try {
      let markers: GeoMarker[] = [];
      if (args.markers?.length) {
        const region = await resolver.region(args.region);
        const placed = await placeMarkers(args.markers, { region, frame: regionFrame(region) });
        if (!Array.isArray(placed)) return placed;
        markers = placed;
      }
      return await presentTerrain(ctx, args.region, args.style ?? "terrain", markers, args.hold_seconds, args.presentation);
    } catch (error) { return failure(resolveFailure(errorCode(error), args.region)); }
  });

  server.registerTool("show_map", {
    title: "Show a map",
    description: TOOL_DESCRIPTIONS.show_map,
    inputSchema: showMapInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    try {
      let markers: GeoMarker[] = [];
      if (args.markers?.length) {
        const region = await resolver.region(args.region);
        const placed = await placeMarkers(args.markers, { region, frame: regionFrame(region) });
        if (!Array.isArray(placed)) return placed;
        markers = placed;
      }
      return await presentMap(ctx, args.region, markers, args.hold_seconds, args.presentation);
    } catch (error) { return failure(resolveFailure(errorCode(error), args.region)); }
  });

  /** The map or terrain on show, with its frame (read back from its own media, whichever process showed it). */
  const currentGeo = async () => {
    const snapshot = await link.run(backend => backend.state());
    const presentation = snapshot.presentation;
    if (presentation?.kind !== "map" && presentation?.kind !== "terrain") return null;
    const item = await link.run(backend => backend.media(presentation.media.id));
    if (!item) return null;
    try {
      const bytes = new Uint8Array(item.data);
      const frame = presentation.kind === "map" ? decodeMap(bytes).frame : decodeHeightField(bytes).geo;
      const region = presentation.kind === "map" ? presentation.region : presentation.region ?? presentation.label;
      return { presentation, frame, region, markers: presentation.markers ?? [], style: presentation.kind === "terrain" ? presentation.style : "terrain" as TerrainStyle };
    } catch { return null; }
  };

  server.registerTool("mark_map", {
    title: "Mark places on the map",
    description: TOOL_DESCRIPTIONS.mark_map,
    inputSchema: markMapInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    if (!args.add && !args.change && !args.remove && !args.clear) return failure("invalid-arguments: give add, change, remove or clear.");
    const current = await currentGeo();
    const base = current ?? (lastGeo ? { presentation: null, frame: undefined, region: lastGeo.region, markers: lastGeo.markers, style: lastGeo.style } : null);
    if (!base) return failure("no-map: no map or terrain is on show. Use show_map (or show_terrain) with the region, and markers.");
    const kind = current?.presentation.kind ?? lastGeo!.kind;
    try {
      const region = await resolver.region(base.region);
      let markers = args.clear ? [] : [...base.markers];
      const missing: string[] = [];
      for (const name of args.remove ?? []) {
        const before = markers.length;
        markers = markers.filter(marker => !sameMarker(marker, name));
        if (markers.length === before) missing.push(name);
      }
      for (const change of args.change ?? []) {
        const at = markers.findIndex(marker => sameMarker(marker, change.place));
        if (at < 0) { missing.push(change.place); continue; }
        let color = markers[at].color;
        if (change.color) { const parsed = parseColor(change.color); if (!parsed) return colorFailure(change.color); color = accentColor(parsed.hex); }
        markers[at] = { ...markers[at], color, ...(change.label ? { label: change.label } : {}), ...(change.highlight !== undefined ? { highlight: change.highlight } : {}) };
      }
      if (args.add?.length) {
        const placed = await placeMarkers(args.add, { region, frame: base.frame ?? regionFrame(region) });
        if (!Array.isArray(placed)) return placed;
        markers = merge(markers, placed);
      }
      const note = missing.length ? ` No marker called ${missing.map(name => `"${name}"`).join(", ")} was on the map.` : "";
      // Everything fits the view on show: only the markers change. Otherwise the map comes (back) with them in view.
      if (current?.frame && markers.every(marker => inside(current.frame!, [marker.lon, marker.lat]))) {
        lastGeo = { kind, region: base.region, style: base.style, markers };
        return run(ctx, backend => backend.apply({ type: "markers", markers }),
          () => `Markers: ${markers.length ? markerShown(markers) : "none"}.${note} Answer in your own voice; do not narrate this tool call.`,
          { markers: markerOutput(markers), ...(markers.length ? { shown: markerWords(markers) } : {}) });
      }
      const shown = kind === "map" ? await presentMap(ctx, base.region, markers) : await presentTerrain(ctx, base.region, base.style, markers);
      if (note && !shown.isError) (shown.content[0] as { text: string }).text += note;
      return shown;
    } catch (error) { return failure(resolveFailure(errorCode(error), base.region)); }
  });

  server.registerTool("set_colors", {
    title: "Set Aion's colours",
    description: TOOL_DESCRIPTIONS.set_colors,
    inputSchema: setColorsInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    if (!args.base && !args.accent && !args.reset) return failure("invalid-arguments: give base, accent or reset.");
    let base: NamedColor | undefined, accent: NamedColor | undefined;
    if (args.base) { base = parseColor(args.base) ?? undefined; if (!base) return colorFailure(args.base); }
    if (args.accent) { accent = parseColor(args.accent) ?? undefined; if (!accent) return colorFailure(args.accent); }
    const lifted = [base, accent].filter((c): c is NamedColor => !!c && contrastOnBlack(hexToRgb(c.hex)) < 4.5).map(c => c.name);
    const snapshot = await link.run(backend => backend.apply({ type: "appearance", ...(base ? { base } : {}), ...(accent ? { accent } : {}), ...(args.reset ? { reset: args.reset } : {}) }));
    const message = `Colours: particles ${snapshot.appearance.base.name}, accent ${snapshot.appearance.accent.name} (remembered).`
      + `${lifted.length ? ` ${lifted.join(" and ")} is brightened a little so it stays visible on black.` : ""} Say it in the first person if at all.`;
    return result({ ...summarize(snapshot, modeFor(ctx), message), colors: { base: snapshot.appearance.base, accent: snapshot.appearance.accent } });
  });

  // ── Music and sound (v0.4.2) ───────────────────────────────────────────────────────────────────────────────────

  /** The lesson this server last showed: "next", "in Chinese" and answers continue it. */
  let lessonAt: LessonPosition | null = null;
  const musicFailure = (problem: string) => failure(`music-invalid: ${problem}. Fix it and try again, or explain in words.`);
  const musicOutput = (title: string, built: CheckedScore, language: Language = "en", extra: Partial<NonNullable<PresenceOutput["music"]>> = {}): NonNullable<PresenceOutput["music"]> => ({
    title, clef: built.clef, ...(built.score.time ? { time: built.score.time } : {}), notes: noteFacts(built, language), ...extra,
  });
  /** Waits (briefly) for Aion's window to say whether playback `id` is sounding. */
  const playbackState = async (id: number, mode: SurfaceMode): Promise<NonNullable<PresenceOutput["music"]>["playback"]> => {
    if (mode === "embedded") return "requested";
    let snapshot = await link.run(backend => backend.state());
    if (!snapshot.hub.viewers) return "no-window";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const report = snapshot.hub.surface.audio?.playback;
      if (report && report.id >= id) return report.state === "blocked" ? "blocked" : report.state === "playing" || report.state === "finished" ? "playing" : "stopped";
      snapshot = await link.run(backend => backend.state(snapshot.revision, snapshot.hub.id, Math.max(50, deadline - Date.now())));
    }
    return "requested";
  };
  const playbackWords = (state: NonNullable<PresenceOutput["music"]>["playback"]) => state === "blocked"
    ? " The browser is holding the sound until the user clicks once in Aion's window: ask them to."
    : state === "no-window" ? " Aion is not open, so nothing sounds: call open_presence first." : "";
  /** Shows a score as a music card (routed: card, or hybrid with a symbol) and, if asked, plays it. */
  const showScore = async (ctx: ServerContext, built: CheckedScore, title: string, options: {
    highlight?: MusicHighlight[]; caption?: string; symbol?: string; lesson?: MusicLessonRef; hold?: number; preference?: PresentationPreference;
    play?: boolean | readonly number[]; tempo?: number; volume?: number; language?: Language; lessonText?: string; answer?: NonNullable<PresenceOutput["music"]>["answer"];
  }) => {
    const content: PresentationContent = {
      kind: "music", title, score: built.score, ...(options.highlight?.length ? { highlight: options.highlight } : {}),
      ...(options.caption ? { caption: options.caption } : {}), ...(options.symbol ? { symbol: options.symbol } : {}), ...(options.lesson ? { lesson: options.lesson } : {}),
      ...(options.tempo ? { tempo: options.tempo } : {}),
    };
    let snapshot = await link.run(backend => backend.apply({ type: "present", content, hold: options.hold ?? 0, presentation: options.preference }));
    const mode = modeFor(ctx);
    let playback: NonNullable<PresenceOutput["music"]>["playback"];
    if (options.play) {
      const chosen = events(built, Array.isArray(options.play) ? options.play : undefined);
      if (chosen.ok) {
        snapshot = await link.run(backend => backend.apply({ type: "play", events: chosen.value, tempo: defaultTempo(options.tempo), volume: options.volume ?? 0.8, presentation: snapshot.presentation?.id }));
        playback = await playbackState(snapshot.playback!.id, mode);
      }
    }
    const lesson = options.lesson ? { id: options.lesson.id, title: options.lesson.title, step: options.lesson.step, steps: options.lesson.steps, language: options.lesson.language, text: options.lessonText ?? "", ...(options.lesson.question ? { question: true } : {}) } : undefined;
    const message = `Shown: ${describePresentation(content)}${snapshot.presentation ? ` — ${routeWords(snapshot.presentation)}` : ""}.${playback ? ` Playback: ${playback}.` : ""}${playbackWords(playback)} `
      + (lesson ? "Teach this step in your own words, in the user's language (music.lesson.text); then wait for them." : "Explain it in your own voice; music.notes has every note's name and place.");
    return result({
      ...summarize(snapshot, mode, message),
      music: musicOutput(title, built, options.language, { ...(playback ? { playback } : {}), ...(lesson ? { lesson } : {}), ...(options.answer ? { answer: options.answer } : {}) }),
    });
  };

  server.registerTool("show_music", {
    title: "Show music notation",
    description: TOOL_DESCRIPTIONS.show_music,
    inputSchema: showMusicInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    if (args.symbol !== undefined && !MUSIC_FORM_IDS.includes(args.symbol)) return musicFailure(`symbol must be one of ${MUSIC_FORM_IDS.join(", ")}`);
    if (args.concept) {
      // A concept of the glossary: its curated, validated example, engraved exactly (v0.4.4).
      const concept = lookupConcept(args.concept);
      if (!concept) return musicFailure(`"${args.concept}" is not in the notation glossary (${MUSIC_CONCEPTS.map(c => c.title.en).join(", ")}); write it with notes instead`);
      const checked = checkScore(concept.score);
      if (!checked.ok) return musicFailure(checked.problem);
      const language = args.language ?? "en";
      const writing = concept.writing ? packSymbol(concept.writing)?.spec : undefined;
      const shown = await showScore(ctx, checked.value, concept.title[language], {
        highlight: concept.highlight, caption: args.caption ?? concept.caption[language], symbol: args.symbol ?? concept.form, hold: args.hold_seconds,
        preference: args.presentation, play: args.play, tempo: args.tempo ?? concept.tempo, language,
      });
      const structured = shown.structuredContent as PresenceOutput | undefined;
      if (structured?.music) structured.music.concept = {
        id: concept.id, title: concept.title.en, title_zh: concept.title.zh, point: concept.caption.en, point_zh: concept.caption.zh,
        ...(writing ? { handwriting: writing.symbol } : {}),
      };
      if (writing && structured) structured.message += ` A validated handwriting demonstration exists: show_stroke_animation {text: "${writing.symbol}"}.`;
      return shown;
    }
    const built = buildScore(args, args.title);
    if (!built.ok) return musicFailure(built.problem);
    const lit = highlights(args.highlight, built.score);
    if (!lit.ok) return musicFailure(lit.problem);
    return showScore(ctx, built.score, built.title, {
      highlight: lit.value, caption: args.caption, symbol: args.symbol, hold: args.hold_seconds, preference: args.presentation, play: args.play, tempo: args.tempo,
    });
  });

  server.registerTool("play_music", {
    title: "Play music",
    description: TOOL_DESCRIPTIONS.play_music,
    inputSchema: playMusicInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    if (args.stop) return run(ctx, backend => backend.apply({ type: "stop-music" }), () => "Music stopped.");
    if (args.notes?.length || args.scale) {
      const built = buildScore(args);
      if (!built.ok) return musicFailure(built.problem);
      return showScore(ctx, built.score, built.title, { play: args.only?.length ? args.only : true, tempo: args.tempo, volume: args.volume });
    }
    // The music on show.
    const snapshot = await link.run(backend => backend.state());
    const shown = snapshot.presentation?.kind === "music" ? snapshot.presentation : null;
    if (!shown) return failure("no-music: no music is on show. Give notes or a scale (they are shown as they play), or use show_music first.");
    const check = checkScore(shown.score);
    if (!check.ok) return failure("no-music: the music on show cannot be played.");
    const chosen = events(check.value, args.only);
    if (!chosen.ok) return musicFailure(chosen.problem);
    const played = await link.run(backend => backend.apply({ type: "play", events: chosen.value, tempo: defaultTempo(args.tempo), volume: args.volume ?? 0.8, presentation: shown.id }));
    const mode = modeFor(ctx);
    const playback = await playbackState(played.playback!.id, mode);
    return result({
      ...summarize(played, mode, `Playing ${args.only?.length ? `note${args.only.length > 1 ? "s" : ""} ${args.only.join(", ")} of ` : ""}${shown.title} (${playback}).${playbackWords(playback)} Do not narrate this tool call.`),
      music: musicOutput(shown.title, check.value, shown.lesson?.language, { playback }),
    });
  });

  server.registerTool("music_lesson", {
    title: "Music lesson",
    description: TOOL_DESCRIPTIONS.music_lesson,
    inputSchema: musicLessonInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    // The lesson on show (any Aion process may have shown it), else the one this server remembers.
    const shown = (await link.run(backend => backend.state())).presentation;
    const current = shown?.kind === "music" && shown.lesson ? { id: shown.lesson.id, step: shown.lesson.step, language: shown.lesson.language } : lessonAt;
    if (args.answer !== undefined) {
      if (!current) return failure("no-question: no practice question is on show. Start one with lesson 8.");
      const step = lessonById(current.id)!.steps[current.step - 1];
      const answer = answerStep(step, args.answer);
      if (!answer) return failure("no-question: this step asks no question; carry on with step \"next\".");
      const lesson = lessonById(current.id)!;
      const built = checkScore(step.score(current.language));
      if (!built.ok) return failure("lesson-invalid");
      lessonAt = current;
      return showScore(ctx, built.value, lesson.title[current.language], {
        highlight: step.highlight, lesson: { id: lesson.id, step: current.step, steps: lesson.steps.length, language: current.language, title: lesson.title[current.language], question: true },
        caption: answer.correct ? (current.language === "zh" ? `✓ 正确：${answer.expected}` : `✓ Correct: ${answer.expected}`) : (current.language === "zh" ? `再想想（是 ${answer.expected}）` : `Not quite: it is ${answer.expected}`),
        play: [0], tempo: step.tempo, language: current.language, lessonText: step.text[current.language], answer: { correct: answer.correct, expected: answer.expected, heard: answer.heard },
      });
    }
    const move = moveLesson(current, args);
    if (!move.ok) return failure(`lesson: ${move.problem}`);
    const { lesson, step, position } = move;
    const built = checkScore(step.score(position.language));
    if (!built.ok) return failure("lesson-invalid");
    lessonAt = position;
    const play = args.play === false || !step.play ? false : step.play === "all" ? true : step.play;
    return showScore(ctx, built.value, lesson.title[position.language], {
      highlight: step.highlight, symbol: step.symbol, play, tempo: step.tempo, language: position.language, lessonText: step.text[position.language],
      lesson: { id: lesson.id, step: position.step, steps: lesson.steps.length, language: position.language, title: lesson.title[position.language], ...(step.question ? { question: true } : {}) },
    });
  });

  /** Where every source stands, for the tool result (from the hub's own knowledge and the window's report). */
  const audioOutput = (snapshot: HubSnapshot): NonNullable<PresenceOutput["audio"]> => {
    const { settings, bridge } = snapshot.audio;
    const describe = (source: "codex" | "system") => bridge.source !== source ? "off"
      : bridge.state === "streaming" ? (bridge.silentCapture ? "streaming, but every sample is silent: macOS has not granted System Audio Recording to Aion Audio Bridge" : `streaming${bridge.app ? ` (${bridge.app})` : ""}`)
        : bridge.waiting ? "waiting for Codex's audio (the bridge runs; Codex has no audio process yet)" : `${bridge.state}${bridge.reason ? ` (${bridge.reason})` : ""}`;
    const audio = snapshot.hub.surface.audio, sync = snapshot.audio.voiceSync;
    return { ...settings, codex: describe("codex"), system: describe("system"), ...(sync ? { voice_sync: sync.status } : {}), ...(audio ? { microphone: audio.microphone, tab: audio.tab } : {}) };
  };
  const bridgeWords = (reason?: string) => ({
    "not-macos": "it needs macOS (Core Audio process taps)",
    "macos-too-old": "it needs macOS 14.2 or later",
    "not-installed": "the Aion Audio Bridge is not installed on this Mac (from the Aion Presence repository: npm run audio-bridge:install)",
    "no-connection": "the capture did not start in time — macOS is probably asking to allow System Audio Recording for \"Aion Audio Bridge\": the user can allow it (or in System Settings → Privacy & Security), then ask again",
    "launch": "the bridge could not be launched", "ended": "the bridge stopped", "handshake": "the bridge did not identify itself",
  } as Record<string, string>)[reason ?? ""] ?? reason ?? "unknown";

  server.registerTool("set_audio_visualizer", {
    title: "Set Aion's response to sound",
    description: TOOL_DESCRIPTIONS.set_audio_visualizer,
    inputSchema: setAudioVisualizerInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const settings = Object.fromEntries(Object.entries({ enabled: args.enabled, source: args.source, mode: args.mode, intensity: args.intensity, sensitivity: args.sensitivity })
      .filter(([, value]) => value !== undefined)) as Partial<AudioSettings>;
    // Codex's voice is Codex Voice Sync (v0.4.3): asking for it is remembered, unless voice_sync false keeps it to this session.
    const before = (await link.run(backend => backend.state())).audio.voiceSync;
    const voiceSync = args.voice_sync ?? (args.source === "codex" ? true : undefined);
    const capture = args.source === "codex" && !voiceSync ? { source: "codex" as const }
      : args.source === "system" ? { source: "system" as const, ...(args.app ? { app: args.app } : {}) } : undefined;
    const stop = (args.stop ?? []).filter((source): source is "codex" | "system" => source !== "tab");
    // Choosing another source ends a capture that is no longer wanted (Codex Voice Sync resumes when it ends, if on).
    if (args.source && args.source !== "auto" && args.source !== "codex" && !capture) stop.push("system");
    if (voiceSync === false && args.source !== "codex") stop.push("codex");
    let snapshot = await link.run(backend => backend.apply({
      type: "audio", ...(Object.keys(settings).length ? { settings } : {}), ...(capture ? { capture } : {}), ...(stop.length ? { stop: [...new Set(stop)] } : {}),
      ...(voiceSync !== undefined ? { voiceSync } : {}),
    }));
    const firstTime = voiceSync === true && !before?.enabled;
    if (args.stop?.includes("tab") || (args.source && args.source !== "tab" && args.source !== "auto")) snapshot = await link.run(backend => backend.apply({ type: "audio", settings: { source: args.source ?? "auto" } }));
    // A capture: wait for the bridge to stream (or say why not); the first start waits for the user's answer to macOS's prompt.
    // Voice Sync connects only while Aion is open; with no window it is remembered and connects when Aion opens.
    const waitsForCapture = capture || (voiceSync === true && snapshot.hub.viewers > 0);
    const deadline = Date.now() + 22_000;
    while (waitsForCapture && ((snapshot.audio.bridge.state === "starting" && !snapshot.audio.bridge.waiting) || snapshot.audio.bridge.state === "off") && Date.now() < deadline) {
      snapshot = await link.run(backend => backend.state(snapshot.revision, snapshot.hub.id, Math.max(50, deadline - Date.now())));
    }
    const audio = audioOutput(snapshot);
    const bridge = snapshot.audio.bridge;
    const notes: string[] = [];
    const connected = (source: "codex" | "system") => bridge.source === source && bridge.state === "streaming" && !bridge.silentCapture;
    if (capture || voiceSync === true) {
      const source = capture?.source ?? "codex";
      notes.push(connected(source) ? `${source === "codex" ? "Your own voice" : "The sound"} is now captured on this Mac and analysed locally; Aion moves with it.`
        : bridge.source === source && bridge.state === "streaming" ? "The bridge runs, but macOS gives it only silence: System Audio Recording is not allowed for Aion Audio Bridge (System Settings → Privacy & Security → Screen & System Audio Recording)."
          : bridge.source === source && bridge.waiting ? "The bridge is ready and waits for Codex's audio; Aion follows your voice as soon as you speak."
            : voiceSync && snapshot.audio.voiceSync?.unavailable ? `Not connected: ${bridgeWords(snapshot.audio.voiceSync.unavailable)}. Voice Sync is remembered for when it can run; Aion keeps its semantic response — do not claim it follows the real audio.`
              : voiceSync && !snapshot.hub.viewers ? "Aion is not open: Voice Sync is on and connects as soon as Aion opens."
              : `Not connected: ${bridgeWords(bridge.reason)}. Aion keeps its semantic response; do not claim it follows the real audio.`);
    }
    if (voiceSync === true && firstTime) {
      notes.push("First time: tell the user once, briefly, that from now on Aion follows your spoken voice whenever it is open — captured only from the "
        + "Codex app on this Mac, analysed locally, never recorded or sent; macOS asks once to allow System Audio Recording for \"Aion Audio Bridge\"; "
        + "\"stop reacting to your voice\" turns it off.");
    }
    if (voiceSync === false) notes.push("Codex Voice Sync is off: Aion keeps its semantic response to your voice.");
    if (args.source === "tab") notes.push(snapshot.hub.viewers ? "Ask the user to click \"Share tab audio\" in Aion's window and choose the tab (with \"Share tab audio\" on)." : "Aion's window is not open: open_presence first, then the user shares a tab there.");
    if (args.source === "microphone" && audio.microphone && audio.microphone !== "connected") notes.push(`The microphone is ${audio.microphone}.`);
    const message = `Sound: ${audio.enabled ? `${audio.source} · ${audio.mode} · ${audio.intensity}` : "off"}. ${notes.join(" ")} Say it in the first person if at all.`;
    return result({ ...summarize(snapshot, modeFor(ctx), message), audio });
  });

  // ── Stroke animation and action sequences (v0.4.3) ─────────────────────────────────────────────────────────────

  const phase = (snapshot: HubSnapshot) => snapshot.animation ? phaseAt(snapshot.animation.playback, Date.now()) : "finished";
  const strokeName = (stroke: StrokeSequence["strokes"][number]) => stroke.name ? `${stroke.name.zh ? `${stroke.name.zh} ` : ""}(${stroke.name.en})` : undefined;
  /** The writing for Codex: per symbol, every stroke in order (where the pen goes) and, for Chinese, the dictionary's facts. */
  const writingOutput = (sequence: StrokeSequence, snapshot: HubSnapshot, facts: WritingFacts[] = [], notes: string[] = [], stroke?: number): NonNullable<PresenceOutput["writing"]> => {
    const at = stroke ? sequence.strokes[stroke - 1] : undefined;
    return {
      text: sequence.symbol, title: sequence.title, system: sequence.writingSystem, convention: sequence.convention,
      ...(sequence.note ? { note: sequence.note } : {}), ...(notes.length ? { notes } : {}),
      symbols: sequence.items.map((item, i) => {
        const strokes = sequence.strokes.slice(item.first, item.first + item.count);
        const fact = facts.find(f => f.symbol === item.symbol) ?? facts[i];
        const names = strokes.map(strokeName);
        return {
          symbol: item.symbol, strokes: strokes.map(s => s.direction), ...(names.some(Boolean) ? { names: names.map(name => name ?? "") } : {}),
          ...(fact?.form ? { form: fact.form } : {}), ...(fact?.pinyin ? { pinyin: fact.pinyin } : {}), ...(fact?.definition ? { definition: fact.definition } : {}),
          ...(fact?.radical ? { radical: fact.radical } : {}), ...(fact?.radicalStrokes ? { radical_strokes: fact.radicalStrokes } : {}),
          ...(fact?.decomposition ? { decomposition: fact.decomposition } : {}), ...(fact?.etymology ? { etymology: fact.etymology } : {}),
          ...(fact?.traditional ? { traditional: fact.traditional } : {}), ...(fact?.simplified ? { simplified: fact.simplified } : {}),
          ...(fact?.convertedFrom ? { converted_from: fact.convertedFrom } : {}),
        };
      }),
      ...(at ? { stroke: { symbol: at.item + 1, n: at.local, direction: at.direction } } : {}),
      playback: phase(snapshot), speed: snapshot.animation?.playback.rate ?? 1,
    };
  };
  const pack = (): ChinesePack | null => chinesePack(env);
  /** Facts for a writing already on show (re-read from the pack; cheap and cached). */
  const factsFor = (sequence: StrokeSequence): WritingFacts[] => {
    if (sequence.writingSystem !== "chinese") return [];
    const again = resolveWriting({ text: sequence.symbol, system: "chinese" }, pack());
    return again.ok ? again.facts : [];
  };
  const animationOutput = (spec: AnimationSpec, snapshot: HubSnapshot): NonNullable<PresenceOutput["animation"]> => ({
    title: spec.title, seconds: Math.round(compiledFor(spec).duration * 10) / 10, actions: spec.actions.map(action => action.do),
    playback: phase(snapshot), speed: snapshot.animation?.playback.rate ?? 1,
  });

  server.registerTool("show_stroke_animation", {
    title: "Show how to write it",
    description: TOOL_DESCRIPTIONS.show_stroke_animation(),
    inputSchema: showStrokeAnimationInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    const text = args.text ?? args.symbol;
    if (!text) return failure("invalid-arguments: give text (the character, word, letter or symbol to write).");
    const found = resolveWriting({ text, system: args.system, form: args.form }, pack());
    if (!found.ok) {
      const how = found.code === "character-not-in-pack" || found.code === "stroke-data-unavailable"
        ? ` Aion never guesses a stroke order. It has ${pack()?.size ?? 0} Chinese characters (simplified and traditional), letters A–Z and a–z, digits and these symbols — ${strokeCatalogText()}.`
        : "";
      return failure(`${found.code}: ${found.problem}.${how} Explain it in words, or offer something Aion can write.`);
    }
    const { source, sequence } = found;
    const highlight = args.highlight === "radical" && sequence.items.some(item => item.radical?.length) ? "radical" as const : undefined;
    const content: PresentationContent = {
      kind: "writing", stroke: sequence.id, label: `${sequence.symbol} · ${sequence.title}`.slice(0, LIMITS.title), source,
      ...(highlight ? { highlight } : {}), ...(args.practice ? { practice: true } : {}),
    };
    const preference = args.practice && (args.presentation === undefined || args.presentation === "auto") ? "card" as const : args.presentation;
    const snapshot = await link.run(backend => backend.apply({ type: "present", content, hold: args.hold_seconds ?? 0, presentation: preference, rate: speedRate(args.speed) }));
    const count = sequence.items.length;
    const notes = [...found.notes, ...(args.highlight === "radical" && !highlight ? ["The data marks no radical strokes for this character."] : [])];
    const message = `Writing ${sequence.symbol} (${count > 1 ? `${count} symbols, ` : ""}${sequence.strokes.length} stroke${sequence.strokes.length > 1 ? "s" : ""}); convention: ${sequence.convention}`
      + `${snapshot.presentation ? ` — ${routeWords(snapshot.presentation)}` : ""}. It forms complete first, then writes each stroke in order${count > 1 ? ", one symbol after another" : ""}. `
      + `${args.practice ? "The reference card is set for tracing: invite the user to write it there. " : ""}Explain one stroke or a small group at a time from writing.symbols, calmly, and let the animation finish; do not narrate this tool call.`;
    return result({ ...summarize(snapshot, modeFor(ctx), message), shown: `${sequence.symbol} (${sequence.title})`, writing: writingOutput(sequence, snapshot, found.facts, notes) });
  });

  server.registerTool("play_animation", {
    title: "Play an animation",
    description: TOOL_DESCRIPTIONS.play_animation,
    inputSchema: playAnimationInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    if ((args.demo === undefined) === (args.sequence === undefined)) return failure("invalid-arguments: give exactly one of demo or sequence.");
    // Plain data, checked again strictly (bounds, references, the compiled length): nothing is ever executed.
    const spec = JSON.parse(JSON.stringify(args.demo ? DEMO_SEQUENCES[args.demo] : args.sequence)) as unknown;
    const check = validateSequence(spec);
    if (!check.ok) return failure(`animation-invalid: ${check.problem}. Fix it and try again, or describe it in words.`);
    const content: PresentationContent = { kind: "animation", sequence: check.spec, label: check.spec.title, ...(args.demo ? { demo: args.demo } : {}) };
    const snapshot = await link.run(backend => backend.apply({ type: "present", content, hold: args.hold_seconds, rate: speedRate(args.speed) }));
    const output = animationOutput(check.spec, snapshot);
    const message = `Playing "${check.spec.title}" (${output.seconds} s, the body becomes the figure for it and returns). Say one short sentence about it `
      + "if anything; do not narrate each movement or this tool call.";
    return result({ ...summarize(snapshot, modeFor(ctx), message), shown: check.spec.title, animation: output });
  });

  server.registerTool("control_animation", {
    title: "Control the animation",
    description: TOOL_DESCRIPTIONS.control_animation,
    inputSchema: controlAnimationInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    const before = await link.run(backend => backend.state());
    const shown = before.presentation;
    if (!shown || (shown.kind !== "writing" && shown.kind !== "animation") || before.animation?.presentation !== shown.id) {
      return failure("no-animation: nothing is being written or animated now. Use show_stroke_animation or play_animation first.");
    }
    const command = {
      action: args.action, ...(args.stroke !== undefined ? { stroke: args.stroke } : {}), ...(args.character !== undefined ? { character: args.character } : {}),
      ...(args.speed ? { speed: args.speed } : {}),
    };
    // The same pure rules the hub applies, so a command that cannot apply is explained instead of silently ignored.
    const check = args.action === "stop" ? null : controlAnimation(shown, before.animation.playback, command, Date.now());
    if (check && !check.ok) return failure(`animation-control: ${check.problem}.`);
    const snapshot = await link.run(backend => backend.apply({ type: "animation", ...command }));
    if (args.action === "stop") return result(summarize(snapshot, modeFor(ctx), "Stopped: back to the persistent body."));
    const stroke = check?.ok ? check.stroke : undefined;
    if (shown.kind === "writing") {
      const sequence = sequenceFor(shown)!;
      const at = stroke ? sequence.strokes[stroke - 1] : undefined;
      const item = at ? sequence.items[at.item] : undefined;
      const whole = args.action === "repeat" && args.character !== undefined && args.stroke === undefined && sequence.items.length > 1;
      const message = whole && item ? `Writing ${item.symbol} again (symbol ${at!.item + 1} of ${sequence.items.length}, ${item.count} strokes). Let it finish.`
        : at && item ? `Writing stroke ${at.local} of ${item.count}${sequence.items.length > 1 ? ` of ${item.symbol}` : ""}${strokeName(at) ? `, ${strokeName(at)}` : ""}: ${at.direction}. Explain just this stroke, then wait.`
          : `Writing ${sequence.symbol}: ${args.action}${args.speed ? ` (${args.speed})` : ""}. Do not narrate this tool call.`;
      return result({ ...summarize(snapshot, modeFor(ctx), message), writing: writingOutput(sequence, snapshot, factsFor(sequence), [], stroke) });
    }
    return result({ ...summarize(snapshot, modeFor(ctx), `Animation: ${args.action}${args.speed ? ` (${args.speed})` : ""}. Do not narrate this tool call.`), animation: animationOutput(shown.sequence, snapshot) });
  });

  server.registerTool("show_form", {
    title: "Show a visual form",
    description: TOOL_DESCRIPTIONS.show_form(),
    inputSchema: showFormInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => showForm(ctx, args));

  server.registerTool("show_clock", {
    title: "Show a clock",
    description: TOOL_DESCRIPTIONS.show_clock,
    inputSchema: showClockInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => {
    const time = args.time ?? clockText(now());
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return present(ctx, { kind: "clock", time }, args.hold_seconds, { shown: args.time ? time : `${time} (local time, ${zone})` });
  });

  server.registerTool("show_number", {
    title: "Show a number",
    description: TOOL_DESCRIPTIONS.show_number,
    inputSchema: showNumberInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "number", value: args.value }, args.hold_seconds));

  server.registerTool("show_text", {
    title: "Show text",
    description: TOOL_DESCRIPTIONS.show_text,
    inputSchema: showTextInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => {
    if (args.emphasis && !args.text.includes(args.emphasis)) return failure(`emphasis-not-in-text: "${args.emphasis}" must appear in the text exactly.`);
    return present(ctx, { kind: "text", text: args.text, ...(args.title ? { title: args.title } : {}), ...(args.emphasis ? { emphasis: args.emphasis } : {}) },
      args.hold_seconds, {}, { presentation: args.presentation });
  });

  server.registerTool("show_symbol", {
    title: "Show a symbol",
    description: TOOL_DESCRIPTIONS.show_symbol,
    inputSchema: showSymbolInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "symbol", symbol: args.symbol }, args.hold_seconds));

  server.registerTool("show_emoji", {
    title: "Show an emoji",
    description: TOOL_DESCRIPTIONS.show_emoji,
    inputSchema: showEmojiInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "emoji", emoji: args.emoji }, args.hold_seconds));

  server.registerTool("show_result", {
    title: "Show a result",
    description: "Present the outcome of a task concisely: a title, a one- or two-line summary, a status (success ✓, failure ✕, partial !, info) and up to 8 short detail lines — e.g. title \"Done\", summary \"48 / 48 tests passed\", details [\"8 files changed\", \"Build successful\"]. Use once when meaningful work finishes (tests, a build, a refactor). Never paste logs: the full detail stays in Codex.",
    inputSchema: showResultInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "result", title: args.title, summary: args.summary, status: args.status ?? "info", details: args.details ?? [] },
    args.hold_seconds, {}, { presentation: args.presentation }));

  server.registerTool("show_artifact", {
    title: "Show an artifact",
    description: `Show a concise artifact beside Aion: a code excerpt, short text, a list, a file-change summary, an SVG diagram (e.g. an architecture sketch) or a local image. Use when seeing it helps more than describing it. Keep it short (≤ ${LIMITS.artifact} characters — an excerpt, not a whole file). Required fields by type: text/code/svg → content; list → items; changes → changes; image → source.`,
    inputSchema: showArtifactInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    const base = { kind: "artifact" as const, type: args.type, title: args.title };
    const routed = { presentation: args.presentation };
    switch (args.type) {
      case "text": {
        const content = cleanText(args.content, LIMITS.artifact);
        return content ? present(ctx, { ...base, content }, args.hold_seconds, {}, routed) : failure("content-required: a text artifact needs content (plain text).");
      }
      case "code": {
        const content = cleanCode(args.content, LIMITS.artifact);
        return content ? present(ctx, { ...base, content, ...(args.language ? { language: args.language.toLowerCase() } : {}) }, args.hold_seconds, {}, routed)
          : failure("content-required: a code artifact needs content.");
      }
      case "list":
        return args.items ? present(ctx, { ...base, items: args.items }, args.hold_seconds, {}, routed) : failure("items-required: a list artifact needs items.");
      case "changes":
        return args.changes ? present(ctx, { ...base, changes: args.changes }, args.hold_seconds, {}, routed) : failure("changes-required: a changes artifact needs changes.");
      case "svg": {
        const svg = args.content === undefined ? null : svgSource(args.content);
        if (!svg) return failure("svg-invalid: content must be one <svg>…</svg> document.");
        const ref = await link.run(backend => backend.addMedia(Buffer.from(svg, "utf8"), "image/svg+xml"));
        return present(ctx, { ...base, media: ref }, args.hold_seconds, {}, routed);
      }
      case "image": {
        if (!args.source) return failure("source-required: an image artifact needs source (an absolute local path or a data:image URL).");
        try { return present(ctx, { ...base, media: await media(args.source) }, args.hold_seconds, {}, routed); } catch (error) { return mediaFailure(error); }
      }
    }
  });

  server.registerTool("clear_presentation", {
    title: "Return to the body",
    description: TOOL_DESCRIPTIONS.clear_presentation,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (_args, ctx) => run(ctx, backend => backend.apply({ type: "clear" }), () => "Cleared: back to the persistent body."));

  server.registerTool("show_visual_form", {
    title: "Show a visual form (older name)",
    description: "Older name of show_form, kept so earlier clients keep working. Prefer show_form; it behaves identically.",
    inputSchema: showVisualFormInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => showForm(ctx, args));

  // Tools only the embedded view calls. They exist only for hosts that render MCP Apps: elsewhere they would
  // be noise in the agent's tool list.
  let appToolsRegistered = false;
  const registerAppOnlyTools = () => {
    if (appToolsRegistered) return;
    appToolsRegistered = true;
    registerAppTool(server, "presence_sync", {
      title: "Aion Presence sync",
      description: "For the Aion Presence view only: waits for the next presence state.",
      inputSchema: syncInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI, visibility: ["app"] } },
    }, async args => {
      embeddedSeen = true;
      embeddedSyncAt = Date.now();
      const snapshot = await link.run(backend => backend.state(args.after_revision ?? -1, args.hub, args.wait_ms ?? 0));
      return { content: [{ type: "text", text: `revision ${snapshot.revision}` }], structuredContent: snapshot as unknown as Record<string, unknown> };
    });
    registerAppTool(server, "presence_media", {
      title: "Aion Presence media",
      description: "For the Aion Presence view only: the bytes of an image or terrain being presented.",
      inputSchema: mediaInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI, visibility: ["app"] } },
    }, async args => {
      const item = await link.run(backend => backend.media(args.id));
      if (!item) return failure("media-not-found");
      return { content: [{ type: "text", text: item.mime }], structuredContent: { mime: item.mime, data: item.data.toString("base64") } };
    });
  };
  if (env.AION_PRESENCE_APP_TOOLS === "always") registerAppOnlyTools();
  server.server.oninitialized = () => {
    const embedded = hostSupportsMcpApps(server.server.getClientCapabilities());
    if (embedded) registerAppOnlyTools();
    options.onReady?.({ embedded, client: server.server.getClientVersion()?.name });
  };
  return server;
}
