import { z } from "zod";
import { AION_BODIES } from "../../core/body";
import {
  ARTIFACT_TYPES, CHANGE_KINDS, cleanCode, cleanLine, cleanText, IMAGE_FITS, IMAGE_MODES, LIMITS, RESULT_STATUSES, SYMBOL_NAMES, TERRAIN_STYLES,
  type PresentationContent,
} from "../../core/presentation";
import { CLOCK_TIME, isSingleEmojiGrapheme, validNumber } from "../../visual/validate";
import { ACTIVITY_STATES } from "../../core/state";
import type { PresenceSnapshot } from "../../core/store";

/**
 * The hub's small local protocol: what every surface receives (HubSnapshot) and the commands the MCP
 * server, other Aion MCP processes and the hooks send. Commands arriving over HTTP are validated again
 * here, whoever sent them.
 */
export const DISPLAY_PREFERENCES = ["auto", "inline", "fullscreen"] as const;
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
}

export interface HubSnapshot extends Omit<PresenceSnapshot, "revision"> {
  /** Increments on every change the surfaces can see. */
  revision: number;
  hub: HubInfo;
}

export type HubCommand =
  | { type: "activity"; state: (typeof ACTIVITY_STATES)[number]; label?: string }
  | { type: "body"; body: (typeof AION_BODIES)[number] }
  | { type: "present"; content: PresentationContent; hold?: number }
  | { type: "clear" }
  /** `greet`: a newly opened Presence waves once (default: when no companion window is connected). */
  | { type: "open"; display?: DisplayPreference; greet?: boolean; introduce?: boolean }
  /** Codex has given (or is giving) Aion's introduction. */
  | { type: "introduced" };

const clean = (fn: (value: unknown, max: number) => string | null, max: number) =>
  z.string().refine(value => fn(value, max) === value, `at most ${max} characters of clean text`);
const mediaRef = z.object({ id: z.string().regex(/^m[a-f0-9]{18}$/), mime: z.string().regex(/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/), bytes: z.number().int().positive() }).strict();
const heightFieldRef = z.object({ id: z.string().regex(/^m[a-f0-9]{18}$/), mime: z.literal("application/vnd.aion.heightfield"), bytes: z.number().int().positive() }).strict();

const presentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("form"), form: z.string().regex(/^[a-z][a-z0-9]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/), variant: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(), label: clean(cleanLine, 120) }).strict(),
  z.object({ kind: z.literal("text"), text: clean(cleanText, LIMITS.text), title: clean(cleanLine, LIMITS.title).optional() }).strict(),
  z.object({
    kind: z.literal("result"), title: clean(cleanLine, LIMITS.title), summary: clean(cleanText, LIMITS.summary), status: z.enum(RESULT_STATUSES),
    details: z.array(clean(cleanLine, LIMITS.detail)).max(LIMITS.details),
  }).strict(),
  z.object({
    kind: z.literal("image"), media: mediaRef, alt: clean(cleanLine, LIMITS.alt).optional(), mode: z.enum(IMAGE_MODES),
    fit: z.enum(IMAGE_FITS).optional(), credit: clean(cleanLine, LIMITS.title).optional(),
  }).strict(),
  z.object({ kind: z.literal("terrain"), media: heightFieldRef, style: z.enum(TERRAIN_STYLES), label: clean(cleanLine, LIMITS.title) }).strict(),
  z.object({ kind: z.literal("clock"), time: z.string().regex(CLOCK_TIME) }).strict(),
  z.object({ kind: z.literal("number"), value: z.string().refine(validNumber) }).strict(),
  z.object({ kind: z.literal("symbol"), symbol: z.enum(SYMBOL_NAMES) }).strict(),
  z.object({ kind: z.literal("emoji"), emoji: z.string().refine(isSingleEmojiGrapheme) }).strict(),
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
  z.object({ type: z.literal("present"), content: presentationSchema, hold: z.number().min(0).max(LIMITS.hold.max).optional() }).strict(),
  z.object({ type: z.literal("clear") }).strict(),
  z.object({ type: z.literal("open"), display: z.enum(DISPLAY_PREFERENCES).optional(), greet: z.boolean().optional(), introduce: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("introduced") }).strict(),
]);

export const hookEventSchema = z.object({
  hook_event_name: z.string().max(40),
  tool_name: z.string().max(200).optional(),
  command: z.string().max(400).optional(),
  session_id: z.string().max(200).optional(),
}).strip();

export const mediaUploadSchema = z.object({ mime: z.string(), data: z.string().max(12_000_000) }).strict();
