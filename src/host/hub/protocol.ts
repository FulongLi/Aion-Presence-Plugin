import { z } from "zod";
import { AION_BODIES } from "../../core/body";
import {
  ARTIFACT_TYPES, CHANGE_KINDS, cleanCode, cleanLine, cleanText, IMAGE_FITS, IMAGE_MODES, LIMITS, PORTRAIT_STYLES, RESULT_STATUSES, SYMBOL_NAMES, TERRAIN_STYLES,
  type PresentationContent,
} from "../../core/presentation";
import { CLOCK_TIME, isSingleEmojiGrapheme, validNumber } from "../../visual/validate";
import { ACTIVITY_STATES } from "../../core/state";
import { WELCOME_OUTCOMES } from "../../core/welcomeNarration";
import { EYE_EXPRESSIONS } from "../../core/eyes/expression";
import { FIGURE_GESTURES } from "../../core/figure/motion";
import { checkScene } from "../../visual/scene3d/validate";
import type { Scene3D } from "../../visual/scene3d/types";
import type { OrbitCommand } from "../../render/interaction/orbit";
import { PRESENTATION_PREFERENCES, type PresentationPreference } from "../../core/presentationRouter";
import type { PresenceSnapshot } from "../../core/store";
import { isHexColor } from "../../core/colors";
import { MARKER_LIMITS, type GeoMarker } from "../../core/presentation";
import { checkHighlights, checkScore, SCORE_LIMITS, type MusicHighlight, type MusicScore, type PlaybackEvent } from "../../music/notation/score";
import { MUSIC_FORM_IDS } from "../../music/visual/glyphForms";
import { AUDIO_INTENSITIES, AUDIO_MODES, AUDIO_SOURCE_PREFERENCES, BRIDGE_SOURCES, type AudioSettings, type BridgeSource } from "../../audio/settings";
import { TEMPO } from "../../music/theory/rhythm";
import { ANIMATION_ACTIONS, ANIMATION_SPEEDS, type AnimationCommand } from "../../animation/control";
import { RATE_LIMITS } from "../../animation/timeline";
import { writingSequence } from "../../animation/stroke/registry";
import { STROKE_LIMITS, WRITING_SYSTEMS } from "../../animation/stroke/types";
import type { WritingSource } from "../../animation/stroke/compose";
import { checkHanziData, type HanziData } from "../../writing/hanzi/codec";
import { validateHanzi } from "../../writing/hanzi/geometry";
import { validateSequence, type AnimationSpec } from "../../animation/scene/sequence";
import { DEMO_NAMES, type DemoName } from "../../animation/scene/demos";
import { CARD_LAYOUTS, checkConfig, UNIVERSAL_COMMANDS } from "../../cards/manifest";
import { CARD_INSTANCE } from "../../cards/protocol";
import { CARD_APP_IDS } from "../../cards/registry";
import { cardRegistry } from "../../core/cards";
import { GLB_MIME } from "../../cards/assets/gltf";
import type { CardValue } from "../../cards/values";
import type { SceneDocument } from "../../scene/ir";
import { validateScene } from "../../scene/validate";
import { PATCH_LIMITS } from "../../scene/patch";
import { toParticleScene } from "../../scene/particleAdapter";
import { validateRoute, type GeoRoute } from "../../visual/geo/route";

/**
 * The hub's small local protocol: what every surface receives (HubSnapshot) and the commands the MCP
 * server, other Aion MCP processes and the hooks send. Commands arriving over HTTP are validated again
 * here, whoever sent them.
 */
/**
 * How Aion asks to be shown. `immersive` is the product-level preference ("Open Aion"): the cleanest Aion-only
 * presentation this environment permits — host fullscreen when embedded, a foreground app window entering true
 * fullscreen at the user's first gesture in the companion. `fullscreen` is kept for v0.2 callers.
 */
export const DISPLAY_PREFERENCES = ["auto", "inline", "fullscreen", "immersive"] as const;
export type DisplayPreference = typeof DISPLAY_PREFERENCES[number];

export interface HubInfo {
  /** Random per hub start: a new id means a new hub (and a fresh revision sequence). */
  id: string;
  /** The companion surface address, without its token. */
  url: string;
  /** Companion windows currently connected. */
  viewers: number;
  display: DisplayPreference;
  /** Codex hooks have reported activity recently (they are trusted and running). */
  hooksActive: boolean;
  /** Aion opened by itself (first run) and Codex has not introduced it yet. */
  introduction: boolean;
  /**
   * v0.6: a companion window is being launched right now (by any Aion process): another "Open Aion" waits for it rather
   * than opening a second window.
   */
  launching: boolean;
  /** v0.6: the getting-started welcome should be on show (the first launch, or the user asked to see it again). */
  welcome: boolean;
  /** v0.6: where the latest "Open Aion" put Aion (an embedded view shows a short note while it is in its own window). */
  surfaceMode: "companion" | "embedded";
  /**
   * What the companion windows report about themselves: is one of them focused, on screen (not covered or
   * minimized), or in true fullscreen? A window that has not reported yet counts as visible.
   */
  surface: { focused: boolean; visible: boolean; fullscreen: boolean; audio?: SurfaceAudio };
  /** The companion window that plays music and opens captures (the newest); null when none is connected. */
  audioWindow?: string | null;
}

export interface HubSnapshot extends Omit<PresenceSnapshot, "revision"> {
  /** Increments on every change the surfaces can see. */
  revision: number;
  hub: HubInfo;
}

export type HubCommand =
  | { type: "activity"; state: (typeof ACTIVITY_STATES)[number]; label?: string }
  | { type: "body"; body: (typeof AION_BODIES)[number] }
  | { type: "present"; content: PresentationContent; hold?: number; presentation?: PresentationPreference; detail?: boolean; rate?: number }
  /** v0.6 `keep: "terrain"`: a route's card was closed — the route goes, the terrain it was drawn on stays a while. */
  | { type: "clear"; keep?: "terrain" }
  /** `greet`: a newly opened Presence waves once (default: when no companion window is connected). */
  | { type: "open"; display?: DisplayPreference; greet?: boolean; introduce?: boolean; surface?: "companion" | "embedded" }
  /** Codex has given (or is giving) Aion's introduction. */
  | { type: "introduced" }
  /** A new companion window is on its way to the foreground: the open ones retire once it has connected. */
  | { type: "supersede" }
  /** v0.6: a companion window is being launched (other processes wait for it instead of opening another); `failed`: it could not be. */
  | { type: "launching"; failed?: boolean }
  /**
   * v0.6: show the welcome again (`show`), or the user has seen it (`done`: remembered, never shown again unasked); v0.7:
   * `outcome` says how (the spoken welcome finished, was skipped, the user started something, it was interrupted after it
   * was heard, or the text alternative was read).
   */
  | { type: "welcome"; show?: boolean; done?: boolean; outcome?: (typeof WELCOME_OUTCOMES)[number] }
  /** An expression or gesture by name (Aion Eyes wear it, the figure acts it out). */
  | { type: "express"; expression?: (typeof EYE_EXPRESSIONS)[number]; gesture?: (typeof FIGURE_GESTURES)[number]; seconds?: number }
  /** Turn, tilt or zoom the 3D object on show. */
  | ({ type: "view" } & OrbitCommand)
  /** The places marked on the map or terrain on show (replaces them all; the map is not formed again). */
  | { type: "markers"; markers: GeoMarker[] }
  /** Aion's colours: a new base and/or accent (already validated colours), or back to the defaults. */
  | { type: "appearance"; base?: { hex: string; name: string }; accent?: { hex: string; name: string }; reset?: "base" | "accent" | "all" }
  /**
   * How Aion responds to sound (v0.4.2): settings to change, a bridge capture to start (Codex's voice, another app's sound;
   * only ever asked for by the user), captures to stop.
   */
  | { type: "audio"; settings?: Partial<AudioSettings>; capture?: { source: BridgeSource; app?: string }; stop?: BridgeSource[]; /** v0.4.3: Codex Voice Sync on or off (remembered). */ voiceSync?: boolean }
  /** Music for the surfaces to play (validated events), highlighting the notes of a music card as they sound. */
  | { type: "play"; events: PlaybackEvent[]; tempo: number; volume: number; presentation?: string }
  /** Silences any music playing. */
  | { type: "stop-music" }
  /** v0.4.3: controls the animation on show (a symbol being written, a figure's action sequence). */
  | ({ type: "animation" } & AnimationCommand)
  /** v0.4.5: a command for the interactive card on show (checked against its application's manifest). */
  | { type: "card"; command: string; value?: CardValue }
  /** v0.5: a change to the generative scene card's scene (its outcome is reported in card.scene.outcome by request). */
  | { type: "scene"; action: "set" | "patch" | "undo" | "redo" | "reset"; request: string; document?: SceneDocument; ops?: Record<string, unknown>[]; base?: number; label?: string };

const clean = (fn: (value: unknown, max: number) => string | null, max: number) =>
  z.string().refine(value => fn(value, max) === value, `at most ${max} characters of clean text`);
const mediaRef = z.object({ id: z.string().regex(/^m[a-f0-9]{18}$/), mime: z.string().regex(/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/), bytes: z.number().int().positive() }).strict();
const heightFieldRef = z.object({ id: z.string().regex(/^m[a-f0-9]{18}$/), mime: z.literal("application/vnd.aion.heightfield"), bytes: z.number().int().positive() }).strict();
const mapRef = z.object({ id: z.string().regex(/^m[a-f0-9]{18}$/), mime: z.literal("application/vnd.aion.map"), bytes: z.number().int().positive() }).strict();
const hex = z.string().refine(isHexColor, "a #rrggbb colour");
export const markerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), label: clean(cleanLine, MARKER_LIMITS.label),
  lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), color: hex, highlight: z.boolean().optional(),
}).strict() satisfies z.ZodType<GeoMarker>;
const markers = z.array(markerSchema).max(MARKER_LIMITS.markers);
const namedColor = z.object({ hex, name: clean(cleanLine, 40) }).strict();

/**
 * A writing's source (v0.4.4): curated symbols by id, Chinese characters with their Hanzi Writer data. Every receiver
 * checks each character with the same geometry rules the pack was built with, and composes it, before accepting it.
 */
const hanziPiece = z.object({
  type: z.literal("hanzi"), char: z.string().refine(value => Array.from(value).length === 1, "one character"),
  data: z.custom<HanziData>(value => {
    try { return validateHanzi(checkHanziData(value)).length === 0; } catch { return false; }
  }, "valid character data"),
  title: clean(cleanLine, LIMITS.title).optional(),
}).strict();
const writingSource = z.object({
  system: z.enum(WRITING_SYSTEMS), text: clean(cleanLine, 40), title: clean(cleanLine, LIMITS.title),
  pieces: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("symbol"), id: z.string().max(40) }).strict(),
    hanziPiece,
    z.object({ type: z.literal("space") }).strict(),
  ])).min(1).max(STROKE_LIMITS.items * 2),
}).strict().refine(source => { try { writingSequence(source as WritingSource); return true; } catch { return false; } }, "a writing that can be composed");

/** A validated model asset (v0.4.5): its media id, file name, size and SHA-256 (checked by the page before the card sees it). */
const cardAsset = z.object({
  id: z.string().regex(/^m[a-f0-9]{18}$/), name: clean(cleanLine, 120), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.literal(GLB_MIME),
}).strict();
const cardValue: z.ZodType<CardValue> = z.lazy(() => z.union([z.string().max(400), z.number().finite(), z.boolean(), z.null(), z.array(z.union([z.string().max(120), z.record(z.string(), z.unknown())])).max(500)])) as z.ZodType<CardValue>;

const presentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("form"), form: z.string().regex(/^[a-z][a-z0-9]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/), variant: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(), label: clean(cleanLine, 120) }).strict(),
  z.object({
    kind: z.literal("text"), text: clean(cleanText, LIMITS.text), title: clean(cleanLine, LIMITS.title).optional(), emphasis: clean(cleanLine, LIMITS.emphasis).optional(),
  }).strict().refine(value => value.emphasis === undefined || value.text.includes(value.emphasis), "emphasis must be part of the text"),
  z.object({
    kind: z.literal("result"), title: clean(cleanLine, LIMITS.title), summary: clean(cleanText, LIMITS.summary), status: z.enum(RESULT_STATUSES),
    details: z.array(clean(cleanLine, LIMITS.detail)).max(LIMITS.details),
  }).strict(),
  z.object({
    kind: z.literal("image"), media: mediaRef, alt: clean(cleanLine, LIMITS.alt).optional(), mode: z.enum(IMAGE_MODES).optional(),
    fit: z.enum(IMAGE_FITS).optional(), credit: clean(cleanLine, LIMITS.title).optional(),
    width: z.number().int().positive().max(100_000).optional(), height: z.number().int().positive().max(100_000).optional(),
    origin: z.enum(["lookup", "local"]).optional(), style: z.enum(PORTRAIT_STYLES).optional(),
  }).strict(),
  z.object({
    kind: z.literal("terrain"), media: heightFieldRef, style: z.enum(TERRAIN_STYLES), label: clean(cleanLine, LIMITS.title),
    elevation: z.object({ min: z.number().finite(), max: z.number().finite() }).strict().optional(), credit: clean(cleanLine, LIMITS.title).optional(),
    region: clean(cleanLine, 80).optional(), markers: markers.optional(),
  }).strict(),
  z.object({
    kind: z.literal("map"), media: mapRef, label: clean(cleanLine, LIMITS.title), region: clean(cleanLine, 80), markers,
    credit: clean(cleanLine, LIMITS.title).optional(),
  }).strict(),
  z.object({ kind: z.literal("clock"), time: z.string().regex(CLOCK_TIME) }).strict(),
  z.object({ kind: z.literal("number"), value: z.string().refine(validNumber) }).strict(),
  z.object({ kind: z.literal("symbol"), symbol: z.enum(SYMBOL_NAMES) }).strict(),
  z.object({ kind: z.literal("emoji"), emoji: z.string().refine(isSingleEmojiGrapheme) }).strict(),
  z.object({
    kind: z.literal("scene"), scene: z.custom<Scene3D>(value => checkScene(value).ok, "a valid 3D scene"), label: clean(cleanLine, LIMITS.title),
    preset: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional(),
  }).strict(),
  z.object({
    kind: z.literal("music"), title: clean(cleanLine, LIMITS.title), score: z.custom<MusicScore>(value => checkScore(value).ok, "a valid score"),
    highlight: z.array(z.custom<MusicHighlight>(value => typeof value === "object" && value !== null)).max(SCORE_LIMITS.highlights).optional(),
    caption: clean(cleanLine, LIMITS.summary).optional(), symbol: z.enum(MUSIC_FORM_IDS as [string, ...string[]]).optional(),
    tempo: z.number().min(TEMPO.min).max(TEMPO.max).optional(),
    lesson: z.object({
      id: z.number().int().min(1).max(99), step: z.number().int().min(1).max(99), steps: z.number().int().min(1).max(99), language: z.enum(["en", "zh"]),
      title: clean(cleanLine, LIMITS.title), question: z.boolean().optional(),
    }).strict().optional(),
  }).strict().refine(value => {
    const score = checkScore(value.score);
    return score.ok && checkHighlights(value.highlight, score.value).ok;
  }, "highlights must name notes, lines or spaces of the score"),
  z.object({
    kind: z.literal("writing"), stroke: z.string().max(80), label: clean(cleanLine, LIMITS.title), source: writingSource,
    highlight: z.literal("radical").optional(), practice: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("animation"), sequence: z.custom<AnimationSpec>(value => validateSequence(value).ok, "a valid action sequence"), label: clean(cleanLine, LIMITS.title),
    demo: z.enum(DEMO_NAMES as [DemoName, ...DemoName[]]).optional(),
  }).strict(),
  z.object({
    kind: z.literal("interactive"), app: z.enum(CARD_APP_IDS), instance: z.string().regex(CARD_INSTANCE), title: clean(cleanLine, LIMITS.title),
    layout: z.enum(CARD_LAYOUTS), config: z.record(z.string(), cardValue), asset: cardAsset.optional(),
    bodyScene: z.custom<Scene3D>(value => checkScene(value).ok, "a valid 3D scene").optional(),
    scene: z.custom<SceneDocument>(value => validateScene(value).ok, "a valid Scene IR document").optional(),
    terrain: z.object({
      media: heightFieldRef, style: z.enum(TERRAIN_STYLES), label: clean(cleanLine, LIMITS.title),
      region: clean(cleanLine, 80).optional(), elevation: z.object({ min: z.number().finite(), max: z.number().finite() }).strict().optional(),
      credit: clean(cleanLine, LIMITS.title).optional(), markers: markers.optional(),
    }).strict().optional(),
    geoRoute: z.custom<GeoRoute>(value => validateRoute(value).ok, "a valid route document").optional(),
  }).strict().refine(value => {
    const manifest = cardRegistry.get(value.app);
    if (!manifest || !manifest.display.layouts.includes(value.layout) || !checkConfig(manifest, value.config).ok) return false;
    // Only a model-assets application takes a model, and its particle form is only ever its manifest's own.
    if (value.asset && (!manifest.resources.assets.includes("model") || value.asset.bytes > manifest.resources.maxAssetBytes)) return false;
    // v0.5: only a scene-documents application takes a scene, and its particle form is that scene's own (the adapter's).
    if (value.scene !== undefined && !manifest.capabilities.includes("scene-documents")) return false;
    // v0.6: only a route-documents application takes a route, and only it forms terrain beside the card.
    if ((value.geoRoute !== undefined || value.terrain !== undefined) && !manifest.capabilities.includes("route-documents")) return false;
    if (value.bodyScene !== undefined && manifest.capabilities.includes("scene-documents")) {
      const checked = value.scene === undefined ? null : validateScene(value.scene);
      return !!checked?.ok && JSON.stringify(value.bodyScene) === JSON.stringify(toParticleScene(checked.document).scene);
    }
    return value.bodyScene === undefined || JSON.stringify(value.bodyScene) === JSON.stringify(manifest.hybrid);
  }, "an interactive card its application's manifest allows"),
  z.object({
    kind: z.literal("artifact"), type: z.enum(ARTIFACT_TYPES), title: clean(cleanLine, LIMITS.title),
    content: clean(cleanCode, LIMITS.artifact).optional(), language: z.string().regex(/^[a-z0-9+#.-]{1,24}$/i).optional(), media: mediaRef.optional(),
    items: z.array(clean(cleanLine, LIMITS.item)).max(LIMITS.items).optional(),
    changes: z.array(z.object({
      path: clean(cleanLine, LIMITS.path), change: z.enum(CHANGE_KINDS),
      additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional(),
    }).strict()).max(LIMITS.changes).optional(),
  }).strict(),
]);

export const hubCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity"), state: z.enum(ACTIVITY_STATES), label: clean(cleanLine, LIMITS.label).optional() }).strict(),
  z.object({ type: z.literal("body"), body: z.enum(AION_BODIES) }).strict(),
  z.object({
    type: z.literal("present"), content: presentationSchema, hold: z.number().min(0).max(LIMITS.hold.max).optional(),
    presentation: z.enum(PRESENTATION_PREFERENCES).optional(), detail: z.boolean().optional(), rate: z.number().min(RATE_LIMITS.min).max(RATE_LIMITS.max).optional(),
  }).strict(),
  z.object({ type: z.literal("clear"), keep: z.literal("terrain").optional() }).strict(),
  z.object({ type: z.literal("open"), display: z.enum(DISPLAY_PREFERENCES).optional(), greet: z.boolean().optional(), introduce: z.boolean().optional(), surface: z.enum(["companion", "embedded"]).optional() }).strict(),
  z.object({ type: z.literal("introduced") }).strict(),
  z.object({ type: z.literal("supersede") }).strict(),
  z.object({ type: z.literal("launching"), failed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("welcome"), show: z.boolean().optional(), done: z.boolean().optional(), outcome: z.enum(WELCOME_OUTCOMES).optional() }).strict(),
  z.object({
    type: z.literal("express"), expression: z.enum(EYE_EXPRESSIONS).optional(), gesture: z.enum(FIGURE_GESTURES).optional(),
    seconds: z.number().min(1).max(30).optional(),
  }).strict().refine(value => value.expression !== undefined || value.gesture !== undefined, "an expression or a gesture"),
  z.object({
    type: z.literal("view"), rotate: z.enum(["left", "right", "up", "down"]).optional(), degrees: z.number().min(5).max(180).optional(),
    zoom: z.enum(["in", "out"]).optional(), spin: z.boolean().optional(), reset: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("markers"), markers }).strict(),
  z.object({ type: z.literal("appearance"), base: namedColor.optional(), accent: namedColor.optional(), reset: z.enum(["base", "accent", "all"]).optional() }).strict(),
  z.object({
    type: z.literal("audio"),
    settings: z.object({
      enabled: z.boolean().optional(), source: z.enum(AUDIO_SOURCE_PREFERENCES).optional(), mode: z.enum(AUDIO_MODES).optional(),
      intensity: z.enum(AUDIO_INTENSITIES).optional(), sensitivity: z.number().min(0).max(1).optional(),
    }).strict().optional(),
    capture: z.object({ source: z.enum(BRIDGE_SOURCES), app: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u).optional() }).strict().optional(),
    stop: z.array(z.enum(BRIDGE_SOURCES)).max(2).optional(),
    voiceSync: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("play"),
    events: z.array(z.object({
      index: z.number().int().min(0).max(SCORE_LIMITS.notes), midi: z.number().int().min(21).max(108).nullable(),
      start: z.number().min(0).max(SCORE_LIMITS.notes * 6), length: z.number().positive().max(6),
    }).strict()).min(1).max(SCORE_LIMITS.notes * 2),
    tempo: z.number().min(TEMPO.min).max(TEMPO.max), volume: z.number().min(0).max(1), presentation: z.string().regex(/^p[a-z0-9]{2,30}$/).optional(),
  }).strict(),
  z.object({ type: z.literal("stop-music") }).strict(),
  z.object({
    type: z.literal("animation"), action: z.enum(ANIMATION_ACTIONS), stroke: z.number().int().min(1).max(STROKE_LIMITS.symbolStrokes).optional(),
    character: z.number().int().min(1).max(STROKE_LIMITS.items).optional(),
    speed: z.enum(ANIMATION_SPEEDS).optional(),
  }).strict(),
  z.object({
    type: z.literal("card"),
    command: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).refine(value => (UNIVERSAL_COMMANDS as readonly string[]).includes(value) || cardRegistry.list().some(app => value in app.commands), "a card command"),
    value: z.union([z.string().max(120), z.number().finite(), z.boolean()]).optional(),
  }).strict(),
  z.object({
    type: z.literal("scene"), action: z.enum(["set", "patch", "undo", "redo", "reset"]), request: z.string().regex(/^q[a-z0-9]{4,32}$/),
    document: z.custom<SceneDocument>(value => validateScene(value).ok, "a valid Scene IR document").optional(),
    ops: z.array(z.record(z.string(), z.unknown())).min(1).max(PATCH_LIMITS.ops).optional(),
    base: z.number().int().min(0).optional(), label: clean(cleanLine, 160).optional(),
  }).strict().refine(value => value.action === "set" ? value.document !== undefined && value.ops === undefined : value.action === "patch" ? value.ops !== undefined && value.document === undefined : value.document === undefined && value.ops === undefined, "set takes a document, patch takes ops"),
]);

/** A companion window describing itself (focus, fullscreen, visibility): nothing else. */
export const SURFACE_CAPTURE_STATES = ["off", "requesting", "connected", "denied", "unavailable", "ended"] as const;
export const PLAYBACK_STATES = ["playing", "blocked", "finished", "stopped", "failed"] as const;
export const surfaceReportSchema = z.object({
  window: z.string().regex(/^[a-z0-9]{8,32}$/), focused: z.boolean(), fullscreen: z.boolean(), visible: z.boolean(),
  /**
   * v0.4.2: where this window's own audio stands — the microphone, a shared tab, and the latest playback (blocked: the
   * browser waits for a click before it may sound). States only: never audio.
   */
  audio: z.object({
    microphone: z.enum(SURFACE_CAPTURE_STATES), tab: z.enum(SURFACE_CAPTURE_STATES),
    playback: z.object({ id: z.number().int().min(0), state: z.enum(PLAYBACK_STATES) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type SurfaceReport = z.infer<typeof surfaceReportSchema>;
export type SurfaceAudio = NonNullable<SurfaceReport["audio"]>;

/** A window's ?debug=1 diagnostics (short labelled lines of numbers and states), for `npm run diagnose`. */
export const diagnosticsSchema = z.object({
  window: z.string().regex(/^[a-z0-9]{8,32}$/), lines: z.record(z.string().regex(/^[a-z]{2,16}$/), z.string().max(240)),
}).strict().refine(value => Object.keys(value.lines).length <= 16);

export const hookEventSchema = z.object({
  hook_event_name: z.string().max(40),
  tool_name: z.string().max(200).optional(),
  command: z.string().max(400).optional(),
  session_id: z.string().max(200).optional(),
  speech_seconds: z.number().min(0).max(120).optional(),
}).strip();

export const mediaUploadSchema = z.object({ mime: z.string(), data: z.string().max(12_000_000) }).strict();
