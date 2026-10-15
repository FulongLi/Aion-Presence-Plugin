import { CARD_LAYOUTS, CARD_LIMITS, checkCommand, checkConfig, checkState, type CardAppManifest, type CardCapability, type CardLayout, type CardResources } from "./manifest";
import { cleanCardText, isObjectId, type CardValue } from "./values";
import type { SceneDocument } from "../scene/ir";
import { validateScene } from "../scene/validate";

/**
 * The Aion Card Bridge (v0.4.5): the only way an interactive card and the Aion page talk. It runs over a dedicated
 * MessageChannel handed to the sandboxed frame once, at start; the page never listens to window messages from the frame.
 * Every message is versioned, names its card instance, and is validated on arrival against this schema and the
 * application's manifest: unknown types, undeclared capabilities, oversized or malformed messages are dropped. There is
 * no message that runs code.
 *
 *   Aion → card   INITIALIZE LOAD_ASSET LOAD_SCENE SET_STATE SET_CAMERA EXECUTE_COMMAND PAUSE RESUME RESIZE RESET DISPOSE
 *   card → Aion   READY LOADING STATE_CHANGED SELECTION_CHANGED INTERACTION ERROR RESOURCE_STATUS DISPOSED RESULT
 *
 * Requests carry an `id`; the card answers with RESULT and `re` set to that id (request/response correlation).
 * v0.5: LOAD_SCENE hands a `scene-documents` application a Scene IR document and its revision; the card validates it
 * again, applies it incrementally, and answers only once it is built (an accepted command is not a rendered result).
 */
export const CARD_PROTOCOL_VERSION = 1;

export const TO_CARD = ["INITIALIZE", "LOAD_ASSET", "LOAD_SCENE", "SET_STATE", "SET_CAMERA", "EXECUTE_COMMAND", "PAUSE", "RESUME", "RESIZE", "RESET", "DISPOSE"] as const;
export const FROM_CARD = ["READY", "LOADING", "STATE_CHANGED", "SELECTION_CHANGED", "INTERACTION", "ERROR", "RESOURCE_STATUS", "DISPOSED", "RESULT"] as const;
export type ToCardType = typeof TO_CARD[number];
export type FromCardType = typeof FROM_CARD[number];

/** Card instance ids: one per opened card, never reused. */
export const CARD_INSTANCE = /^c[a-z0-9]{8,24}$/;
export const REQUEST_ID = /^r[a-z0-9]{1,24}$/;

/** Messages an application may send only with a capability (the rest are core). */
export const CAPABILITY_MESSAGES: Partial<Record<FromCardType, CardCapability>> = {
  SELECTION_CHANGED: "selection", INTERACTION: "interaction-events", RESOURCE_STATUS: "resource-status",
};
/** Messages Aion sends only to an application with a capability. */
export const CAPABILITY_REQUESTS: Partial<Record<ToCardType, CardCapability>> = { LOAD_ASSET: "model-assets", SET_CAMERA: "camera", LOAD_SCENE: "scene-documents" };

export const INTERACTION_KINDS = ["pointer-down", "pointer-up", "wheel", "key", "escape", "focus", "blur"] as const;
export const PAUSE_REASONS = ["user", "codex", "hidden"] as const;

export interface CardTheme { base: string; accent: string }
export interface CardAssetInfo { id: string; name: string; kind: "model"; bytes: number; sha256: string }

export interface ToCardPayloads {
  INITIALIZE: { app: string; config: Record<string, CardValue>; state?: Record<string, CardValue>; layout: CardLayout; reducedMotion: boolean; theme: CardTheme; limits: CardResources };
  LOAD_ASSET: { asset: CardAssetInfo; data: ArrayBuffer };
  LOAD_SCENE: { revision: number; document: SceneDocument };
  SET_STATE: { state: Record<string, CardValue> };
  SET_CAMERA: { view?: string; focus?: string };
  EXECUTE_COMMAND: { command: string; value?: CardValue };
  PAUSE: { reason: typeof PAUSE_REASONS[number] };
  RESUME: { reason: typeof PAUSE_REASONS[number] };
  RESIZE: { width: number; height: number; layout: CardLayout };
  RESET: Record<string, never>;
  DISPOSE: Record<string, never>;
}

export interface CardSelection {
  objectId: string | null;
  name?: string;
  kind?: string;
  properties?: Record<string, string | number | boolean>;
  /** Where the selected object is in the card, 0…1 across and down — only when the application knows it exactly. */
  screen?: { x: number; y: number };
}

export interface ResourceStatus {
  fps: number; frameMs: number; drawCalls: number; triangles: number; geometries: number; textures: number; programs: number;
  /** Whether a render loop is running right now (false when paused on demand, suspended or disposed). */
  rendering: boolean;
  heapMB?: number;
}

export interface FromCardPayloads {
  READY: { app: string; version: string };
  LOADING: { phase: string; progress: number };
  STATE_CHANGED: { state: Record<string, CardValue> };
  SELECTION_CHANGED: CardSelection;
  INTERACTION: { kind: typeof INTERACTION_KINDS[number] };
  ERROR: { code: string; message: string; fatal: boolean };
  RESOURCE_STATUS: ResourceStatus;
  DISPOSED: { geometries: number; textures: number; urls: number; loops: number };
  RESULT: { ok: boolean; problem?: string };
}

export type Envelope<T extends string, P> = { v: typeof CARD_PROTOCOL_VERSION; instance: string; type: T; id?: string; re?: string; payload: P };
export type ToCardMessage = { [K in ToCardType]: Envelope<K, ToCardPayloads[K]> }[ToCardType];
export type FromCardMessage = { [K in FromCardType]: Envelope<K, FromCardPayloads[K]> }[FromCardType];

export type Parsed<T> = { ok: true; message: T } | { ok: false; problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const finite = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const ERROR_CODE = /^[a-z][a-z0-9-]{1,40}$/;
const PROPERTY = /^[\p{L}][\p{L}\p{N} ._()-]{0,39}$/u;

/** Why a selection is not valid, or null when it is. */
export function selectionProblem(p: unknown): string | null {
  if (!isRecord(p) || !onlyKeys(p, ["objectId", "name", "kind", "properties", "screen"])) return "unknown fields";
  if (p.objectId !== null && !isObjectId(p.objectId)) return "objectId must be an object id or null";
  if (p.name !== undefined && cleanCardText(p.name, 80) !== p.name) return "name must be one line";
  if (p.kind !== undefined && cleanCardText(p.kind, 40) !== p.kind) return "kind must be one line";
  if (p.properties !== undefined) {
    if (!isRecord(p.properties) || Object.keys(p.properties).length > CARD_LIMITS.properties) return `at most ${CARD_LIMITS.properties} properties`;
    for (const [key, value] of Object.entries(p.properties)) {
      if (!PROPERTY.test(key)) return `property name ${JSON.stringify(key)} is invalid`;
      const ok = typeof value === "boolean" || finite(value, -1e15, 1e15) || (typeof value === "string" && cleanCardText(value, 200) === value);
      if (!ok) return `property ${key} must be short text, a number or true/false`;
    }
  }
  if (p.screen !== undefined && (!isRecord(p.screen) || !onlyKeys(p.screen, ["x", "y"]) || !finite(p.screen.x, 0, 1) || !finite(p.screen.y, 0, 1))) return "screen must be {x, y} within 0…1";
  return null;
}

const RESOURCE_COUNTERS = ["fps", "frameMs", "drawCalls", "triangles", "geometries", "textures", "programs"] as const;
/** Whether resource counters are valid. */
export function validResources(p: unknown): p is ResourceStatus {
  return isRecord(p) && onlyKeys(p, [...RESOURCE_COUNTERS, "rendering", "heapMB"]) && RESOURCE_COUNTERS.every(key => finite(p[key], 0, 1e9)) && typeof p.rendering === "boolean"
    && (p.heapMB === undefined || finite(p.heapMB, 0, 1e6));
}

/** The size of a message as JSON, or Infinity when it is not plain JSON (functions, cycles, binary data). */
export function messageBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "function" || typeof item === "bigint" || typeof item === "symbol" || item instanceof ArrayBuffer || ArrayBuffer.isView(item)) throw new Error("not-json");
      return item;
    });
    return json === undefined ? Infinity : json.length;
  } catch { return Infinity; }
}

function envelope(raw: unknown, instance: string, types: readonly string[]): Parsed<Record<string, unknown>> {
  if (!isRecord(raw)) return { ok: false, problem: "not an object" };
  if (!onlyKeys(raw, ["v", "instance", "type", "id", "re", "payload"])) return { ok: false, problem: "unknown envelope fields" };
  if (raw.v !== CARD_PROTOCOL_VERSION) return { ok: false, problem: "unsupported protocol version" };
  if (typeof raw.instance !== "string" || !CARD_INSTANCE.test(raw.instance)) return { ok: false, problem: "invalid instance" };
  if (raw.instance !== instance) return { ok: false, problem: "stale instance" };
  if (typeof raw.type !== "string" || !types.includes(raw.type)) return { ok: false, problem: "unknown message type" };
  if (raw.id !== undefined && (typeof raw.id !== "string" || !REQUEST_ID.test(raw.id))) return { ok: false, problem: "invalid request id" };
  if (raw.re !== undefined && (typeof raw.re !== "string" || !REQUEST_ID.test(raw.re))) return { ok: false, problem: "invalid reply id" };
  if (!isRecord(raw.payload)) return { ok: false, problem: "payload must be an object" };
  return { ok: true, message: raw };
}

/**
 * Validates a message from a card, for the page: the envelope, its instance (a stale card's messages are refused), its
 * size, the capability its type needs, and its payload against the manifest.
 */
export function parseFromCard(raw: unknown, instance: string, manifest: CardAppManifest): Parsed<FromCardMessage> {
  if (messageBytes(raw) > CARD_LIMITS.messageBytes) return { ok: false, problem: "message too large or not plain JSON" };
  const checked = envelope(raw, instance, FROM_CARD);
  if (!checked.ok) return checked;
  const message = checked.message, type = message.type as FromCardType, p = message.payload as Record<string, unknown>;
  const needs = CAPABILITY_MESSAGES[type];
  if (needs && !manifest.capabilities.includes(needs)) return { ok: false, problem: `${type} needs the ${needs} capability` };
  const bad = (problem: string): Parsed<FromCardMessage> => ({ ok: false, problem: `${type}: ${problem}` });
  switch (type) {
    case "READY":
      if (!onlyKeys(p, ["app", "version"]) || p.app !== manifest.id || p.version !== manifest.version) return bad("must name this application and version");
      break;
    case "LOADING":
      if (!onlyKeys(p, ["phase", "progress"]) || cleanCardText(p.phase, 60) !== p.phase || !finite(p.progress, 0, 1)) return bad("needs a phase and progress 0…1");
      break;
    case "STATE_CHANGED": {
      if (!onlyKeys(p, ["state"])) return bad("unknown fields");
      const state = checkState(manifest, p.state);
      if (!state.ok) return bad(state.problem);
      return { ok: true, message: { ...message, payload: { state: state.state } } as FromCardMessage };
    }
    case "SELECTION_CHANGED": {
      const problem = selectionProblem(p);
      if (problem) return bad(problem);
      break;
    }
    case "INTERACTION":
      if (!onlyKeys(p, ["kind"]) || !(INTERACTION_KINDS as readonly unknown[]).includes(p.kind)) return bad("unknown interaction");
      break;
    case "ERROR":
      if (!onlyKeys(p, ["code", "message", "fatal"]) || typeof p.code !== "string" || !ERROR_CODE.test(p.code) || cleanCardText(p.message, 200) !== p.message || typeof p.fatal !== "boolean") return bad("needs a code, a message and fatal");
      break;
    case "RESOURCE_STATUS":
      if (!validResources(p)) return bad("invalid counters");
      break;
    case "DISPOSED":
      if (!onlyKeys(p, ["geometries", "textures", "urls", "loops"]) || ["geometries", "textures", "urls", "loops"].some(key => !finite(p[key], 0, 1e6))) return bad("invalid counters");
      break;
    case "RESULT":
      if (typeof message.re !== "string") return bad("must answer a request");
      if (!onlyKeys(p, ["ok", "problem"]) || typeof p.ok !== "boolean" || (p.problem !== undefined && cleanCardText(p.problem, 200) !== p.problem)) return bad("needs ok (and a short problem)");
      break;
  }
  return { ok: true, message: message as FromCardMessage };
}

/** Validates a message from Aion, for the card (the card trusts nothing either). */
export function parseToCard(raw: unknown, instance: string, manifest: CardAppManifest): Parsed<ToCardMessage> {
  const data = isRecord(raw) && isRecord(raw.payload) ? raw.payload.data : undefined;
  if (data !== undefined && !(data instanceof ArrayBuffer)) return { ok: false, problem: "asset data must be bytes" };
  const sized = data === undefined ? raw : { ...(raw as Record<string, unknown>), payload: { ...((raw as Record<string, unknown>).payload as Record<string, unknown>), data: null } };
  if (messageBytes(sized) > CARD_LIMITS.messageBytes) return { ok: false, problem: "message too large" };
  const checked = envelope(raw, instance, TO_CARD);
  if (!checked.ok) return checked;
  const message = checked.message, type = message.type as ToCardType, p = message.payload as Record<string, unknown>;
  const needs = CAPABILITY_REQUESTS[type];
  if (needs && !manifest.capabilities.includes(needs)) return { ok: false, problem: `${type} needs the ${needs} capability` };
  const bad = (problem: string): Parsed<ToCardMessage> => ({ ok: false, problem: `${type}: ${problem}` });
  switch (type) {
    case "INITIALIZE": {
      if (!onlyKeys(p, ["app", "config", "state", "layout", "reducedMotion", "theme", "limits"]) || p.app !== manifest.id) return bad("must name this application");
      const config = checkConfig(manifest, p.config as Record<string, unknown>);
      if (!config.ok) return bad(config.problem);
      if (p.state !== undefined && !checkState(manifest, p.state).ok) return bad("invalid state");
      if (!(CARD_LAYOUTS as readonly unknown[]).includes(p.layout) || typeof p.reducedMotion !== "boolean") return bad("invalid layout");
      const theme = p.theme as Record<string, unknown>;
      if (!isRecord(theme) || !/^#[0-9a-f]{6}$/i.test(String(theme.base)) || !/^#[0-9a-f]{6}$/i.test(String(theme.accent))) return bad("invalid theme");
      if (!isRecord(p.limits)) return bad("invalid limits");
      break;
    }
    case "LOAD_ASSET": {
      const asset = p.asset as Record<string, unknown>;
      if (!isRecord(asset) || typeof asset.id !== "string" || cleanCardText(asset.name, 120) !== asset.name || asset.kind !== "model"
        || !finite(asset.bytes, 1, manifest.resources.maxAssetBytes) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return bad("invalid asset");
      if (!(p.data instanceof ArrayBuffer) || p.data.byteLength !== asset.bytes) return bad("asset bytes do not match");
      break;
    }
    case "LOAD_SCENE": {
      if (!onlyKeys(p, ["revision", "document"]) || !Number.isInteger(p.revision) || !finite(p.revision, 1, 1e9)) return bad("needs a revision and a document");
      const scene = validateScene(p.document);
      if (!scene.ok) return bad(`${scene.code}: ${scene.problem}`);
      return { ok: true, message: { ...message, payload: { revision: p.revision, document: scene.document } } as ToCardMessage };
    }
    case "SET_STATE":
      if (!checkState(manifest, p.state).ok) return bad("invalid state");
      break;
    case "SET_CAMERA":
      if (!onlyKeys(p, ["view", "focus"]) || (p.view !== undefined && cleanCardText(p.view, 32) !== p.view) || (p.focus !== undefined && !isObjectId(p.focus))) return bad("invalid camera");
      break;
    case "EXECUTE_COMMAND": {
      if (!onlyKeys(p, ["command", "value"]) || typeof p.command !== "string") return bad("needs a command");
      const command = checkCommand(manifest, p.command, p.value);
      if (!command.ok || command.universal) return bad(command.ok ? "universal commands are messages of their own" : command.problem);
      break;
    }
    case "PAUSE": case "RESUME":
      if (!onlyKeys(p, ["reason"]) || !(PAUSE_REASONS as readonly unknown[]).includes(p.reason)) return bad("invalid reason");
      break;
    case "RESIZE":
      if (!onlyKeys(p, ["width", "height", "layout"]) || !finite(p.width, 0, 16384) || !finite(p.height, 0, 16384) || !(CARD_LAYOUTS as readonly unknown[]).includes(p.layout)) return bad("invalid size");
      break;
    case "RESET": case "DISPOSE":
      if (Object.keys(p).length) return bad("takes no payload");
      break;
  }
  return { ok: true, message: message as ToCardMessage };
}

/**
 * A token bucket: `burst` messages at once, refilled at `rate` a second. Messages beyond it are dropped and counted; a
 * card that keeps flooding is stopped (see CARD_LIMITS.floodDrops).
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  dropped = 0;
  constructor(private readonly burst: number = CARD_LIMITS.messageBurst, private readonly rate: number = CARD_LIMITS.messagesPerSecond, private readonly now: () => number = () => performance.now()) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    this.dropped++;
    return false;
  }
}

/** A fresh card instance id. */
export function newInstanceId(random: () => number = Math.random): string {
  let id = "c";
  for (let i = 0; i < 16; i++) id += Math.floor(random() * 36).toString(36);
  return id;
}
