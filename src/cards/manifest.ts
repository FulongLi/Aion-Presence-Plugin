import { checkValue, cleanCardText, validSpec, type CardValue, type ValueSpec } from "./values";

/**
 * Interactive card applications (v0.4.5): what an application is allowed to be. Every application Aion can host is
 * described by a manifest and checked against it before it is registered; afterwards everything it sends and receives is
 * checked against the same manifest (src/cards/protocol.ts). An application cannot widen its own permissions: an unknown
 * capability, an unknown permission or a limit above Aion's ceilings makes the manifest invalid.
 */

/** Where a card stands on screen (see docs/CARDS.md). */
export const CARD_LAYOUTS = ["compact", "expanded", "fullscreen"] as const;
export type CardLayout = typeof CARD_LAYOUTS[number];

/**
 * What an application may do. Each capability unlocks exactly the bridge messages listed in CAPABILITY_MESSAGES; an
 * application without it is never sent them and may not send them. v0.5: `scene-documents` — the application is handed
 * validated Scene IR documents (LOAD_SCENE) and renders them. v0.6: `route-documents` — validated GeoRoutes (LOAD_ROUTE),
 * and the card may tell Aion where along the route the user is pointing (CURSOR); `map-tiles` — the card may ask for
 * map tiles of what it is showing (TILE_REQUEST) and is handed their bytes (LOAD_TILE). It never fetches anything itself.
 */
export const CARD_CAPABILITIES = ["webgl", "model-assets", "selection", "camera", "simulation-time", "visibility", "interaction-events", "resource-status", "scene-documents", "route-documents", "map-tiles"] as const;
export type CardCapability = typeof CARD_CAPABILITIES[number];

/** What an application may receive from the user: pointer input (always) and keyboard focus inside its frame. */
export const CARD_PERMISSIONS = ["pointer", "keyboard"] as const;
export type CardPermission = typeof CARD_PERMISSIONS[number];

/** Asset kinds an application may be handed (by the parent, as bytes: never a URL). */
export const CARD_ASSET_KINDS = ["model", "field"] as const;
export type CardAssetKind = typeof CARD_ASSET_KINDS[number];

/** Aion's ceilings: no manifest may ask for more. */
export const CARD_LIMITS = {
  assetBytes: 16 * 1024 * 1024,
  triangles: 2_000_000,
  textures: 64,
  textureSize: 4096,
  loadSeconds: 30,
  /** Card → Aion messages: their size and rate (a token bucket per card). */
  messageBytes: 64 * 1024,
  messageBurst: 120,
  messagesPerSecond: 40,
  /** Dropped messages that make a card a flood (it is then stopped with an error). */
  floodDrops: 400,
  /** Seconds an EXECUTE_COMMAND waits for the card's RESULT. */
  commandSeconds: 4,
  /** Commands kept in the hub for surfaces to apply (the newest). */
  commandQueue: 16,
  stateKeys: 40,
  configKeys: 16,
  commands: 40,
  properties: 24,
  minWidth: 200,
  minHeight: 160,
  /** v0.6: map tiles one TILE_REQUEST may ask for, and the largest tile handed over. */
  tilesPerRequest: 16,
  tileBytes: 768 * 1024,
} as const;

export interface CardCommandSpec { value: ValueSpec; description: string }

export interface CardResources {
  assets: CardAssetKind[];
  maxAssetBytes: number;
  maxTriangles: number;
  maxTextures: number;
  maxTextureSize: number;
  maxLoadSeconds: number;
}

export interface CardAppManifest {
  /** Stable application id ("earth-moon"). */
  id: string;
  name: string;
  /** Semantic version of the application. */
  version: string;
  /** The application module in the card runtime (src/cards/runtime/apps.ts) that implements it. */
  entry: string;
  /** One sentence for Codex and the docs. */
  description: string;
  capabilities: CardCapability[];
  permissions: CardPermission[];
  /** Configuration accepted at launch (show_interactive_card's config). */
  config: Record<string, ValueSpec>;
  /** Commands it accepts (control_interactive_card), each with its value type. */
  commands: Record<string, CardCommandSpec>;
  /** State it reports (inspect_interactive_card), each key with its value type. */
  state: Record<string, ValueSpec>;
  resources: CardResources;
  display: { minWidth: number; minHeight: number; layouts: CardLayout[]; defaultLayout: CardLayout };
  /** What happens when the card is closed (always: everything is released) and when its page is hidden. */
  cleanup: { onClose: "dispose"; onHidden: "suspend" | "pause" };
  /**
   * A particle representation the body may form beside the card (HYBRID), as a validated 3D scene; absent: the
   * application has no body form and is shown as a card only.
   */
  hybrid?: unknown;
}

/** Universal commands every interactive card accepts (handled by Aion, not by the application). */
export const UNIVERSAL_COMMANDS = ["pause", "resume", "reset", "expand", "collapse", "fullscreen", "close"] as const;
export type UniversalCommand = typeof UNIVERSAL_COMMANDS[number];

const ID = /^[a-z][a-z0-9-]{1,30}$/;
const COMMAND = /^[a-z][a-z0-9-]{1,31}$/;
/** State and setting keys: camelCase. */
const KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const KNOWN_KEYS = ["id", "name", "version", "entry", "description", "capabilities", "permissions", "config", "commands", "state", "resources", "display", "cleanup", "hybrid"];

export type ManifestCheck = { ok: true; manifest: CardAppManifest } | { ok: false; problems: string[] };

/**
 * Validates a manifest. `checkHybrid` validates the optional body form (the host passes the 3D scene validator; the
 * sandboxed runtime has no use for it).
 */
export function validateManifest(input: unknown, checkHybrid: (scene: unknown) => boolean = () => true): ManifestCheck {
  const problems: string[] = [];
  const m = input as Partial<CardAppManifest> & Record<string, unknown> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, problems: ["not an object"] };
  for (const key of Object.keys(m)) if (!KNOWN_KEYS.includes(key)) problems.push(`unknown field ${key}`);
  if (typeof m.id !== "string" || !ID.test(m.id)) problems.push("id must be lowercase letters, digits and hyphens");
  if (cleanCardText(m.name, 60) === null) problems.push("name must be one line of at most 60 characters");
  if (typeof m.version !== "string" || !VERSION.test(m.version)) problems.push("version must be major.minor.patch");
  if (typeof m.entry !== "string" || !ID.test(m.entry)) problems.push("entry must name a runtime module");
  if (cleanCardText(m.description, 240) === null) problems.push("description must be one line of at most 240 characters");
  const list = <T extends string>(value: unknown, known: readonly T[], what: string): T[] => {
    if (!Array.isArray(value)) { problems.push(`${what} must be a list`); return []; }
    for (const item of value) if (!known.includes(item as T)) problems.push(`${what}: ${String(item)} is not one Aion grants`);
    if (new Set(value).size !== value.length) problems.push(`${what} repeat`);
    return value as T[];
  };
  const capabilities = list(m.capabilities, CARD_CAPABILITIES, "capabilities");
  list(m.permissions, CARD_PERMISSIONS, "permissions");
  const specs = (value: unknown, what: string, max: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) { problems.push(`${what} must be an object`); return; }
    const entries = Object.entries(value);
    if (entries.length > max) problems.push(`${what}: at most ${max}`);
    for (const [key, spec] of entries) {
      if (!KEY.test(key)) problems.push(`${what}: ${key} is not a valid name`);
      if (!validSpec(spec)) problems.push(`${what}: ${key} has an invalid type`);
    }
  };
  specs(m.config, "config", CARD_LIMITS.configKeys);
  specs(m.state, "state", CARD_LIMITS.stateKeys);
  if (!m.commands || typeof m.commands !== "object" || Array.isArray(m.commands)) problems.push("commands must be an object");
  else {
    const entries = Object.entries(m.commands);
    if (entries.length > CARD_LIMITS.commands) problems.push(`commands: at most ${CARD_LIMITS.commands}`);
    for (const [name, spec] of entries) {
      if (!COMMAND.test(name)) problems.push(`commands: ${name} is not a valid name`);
      if ((UNIVERSAL_COMMANDS as readonly string[]).includes(name)) problems.push(`commands: ${name} is universal (handled by Aion)`);
      const command = spec as Partial<CardCommandSpec> | null;
      if (!command || typeof command !== "object" || !validSpec(command.value) || cleanCardText(command.description, 160) === null || Object.keys(command).some(key => key !== "value" && key !== "description")) {
        problems.push(`commands: ${name} needs a value type and a description`);
      }
    }
  }
  const r = m.resources as Partial<CardResources> | undefined;
  if (!r || typeof r !== "object") problems.push("resources must be an object");
  else {
    const assets = list(r.assets, CARD_ASSET_KINDS, "resources.assets");
    if (assets.length && !capabilities.includes("model-assets")) problems.push("resources.assets needs the model-assets capability");
    const bounded = (key: keyof CardResources, ceiling: number) => {
      const value = r[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) problems.push(`resources.${key} must be a whole number`);
      else if (value > ceiling) problems.push(`resources.${key} exceeds Aion's limit (${ceiling})`);
    };
    bounded("maxAssetBytes", CARD_LIMITS.assetBytes);
    bounded("maxTriangles", CARD_LIMITS.triangles);
    bounded("maxTextures", CARD_LIMITS.textures);
    bounded("maxTextureSize", CARD_LIMITS.textureSize);
    bounded("maxLoadSeconds", CARD_LIMITS.loadSeconds);
    if (Object.keys(r).some(key => !["assets", "maxAssetBytes", "maxTriangles", "maxTextures", "maxTextureSize", "maxLoadSeconds"].includes(key))) problems.push("resources has unknown fields");
  }
  const d = m.display as Partial<CardAppManifest["display"]> | undefined;
  if (!d || typeof d !== "object") problems.push("display must be an object");
  else {
    const layouts = list(d.layouts, CARD_LAYOUTS, "display.layouts");
    if (!layouts.length) problems.push("display.layouts must not be empty");
    if (!layouts.includes(d.defaultLayout as CardLayout)) problems.push("display.defaultLayout must be one of its layouts");
    if (!Number.isInteger(d.minWidth) || d.minWidth! < CARD_LIMITS.minWidth || d.minWidth! > 2000) problems.push(`display.minWidth must be ${CARD_LIMITS.minWidth}…2000`);
    if (!Number.isInteger(d.minHeight) || d.minHeight! < CARD_LIMITS.minHeight || d.minHeight! > 2000) problems.push(`display.minHeight must be ${CARD_LIMITS.minHeight}…2000`);
  }
  const c = m.cleanup as Partial<CardAppManifest["cleanup"]> | undefined;
  if (!c || c.onClose !== "dispose" || (c.onHidden !== "suspend" && c.onHidden !== "pause") || Object.keys(c).length !== 2) problems.push("cleanup must be { onClose: dispose, onHidden: suspend|pause }");
  if (m.hybrid !== undefined && !checkHybrid(m.hybrid)) problems.push("hybrid must be a valid 3D scene");
  return problems.length ? { ok: false, problems } : { ok: true, manifest: m as CardAppManifest };
}

/** Validates launch configuration against a manifest. */
export function checkConfig(manifest: CardAppManifest, config: Record<string, unknown> | undefined): { ok: true; config: Record<string, CardValue> } | { ok: false; problem: string } {
  const out: Record<string, CardValue> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const spec = manifest.config[key];
    if (!spec) return { ok: false, problem: `${manifest.id} has no setting "${key}"` };
    const checked = checkValue(spec, value);
    if (!checked.ok) return { ok: false, problem: `${key} ${checked.problem}` };
    if (checked.value !== undefined) out[key] = checked.value;
  }
  return { ok: true, config: out };
}

/** Validates a command (an application command or a universal one) against a manifest. */
export function checkCommand(manifest: CardAppManifest, command: string, value: unknown): { ok: true; universal: boolean; value?: CardValue } | { ok: false; problem: string } {
  if ((UNIVERSAL_COMMANDS as readonly string[]).includes(command)) {
    return value === undefined || value === null ? { ok: true, universal: true } : { ok: false, problem: `${command} takes no value` };
  }
  const spec = manifest.commands[command];
  if (!spec) return { ok: false, problem: `${manifest.name} has no command "${command}" (it accepts: ${[...UNIVERSAL_COMMANDS, ...Object.keys(manifest.commands)].join(", ")})` };
  const checked = checkValue(spec.value, value);
  if (!checked.ok) return { ok: false, problem: `${command}: value ${checked.problem}` };
  return { ok: true, universal: false, ...(checked.value !== undefined ? { value: checked.value } : {}) };
}

/** Validates reported state against a manifest: only declared keys, each of its declared type. */
export function checkState(manifest: CardAppManifest, state: unknown): { ok: true; state: Record<string, CardValue> } | { ok: false; problem: string } {
  if (!state || typeof state !== "object" || Array.isArray(state)) return { ok: false, problem: "state must be an object" };
  const out: Record<string, CardValue> = {};
  for (const [key, value] of Object.entries(state)) {
    const spec = manifest.state[key];
    if (!spec) return { ok: false, problem: `undeclared state "${key}"` };
    const checked = checkValue(spec, value);
    if (!checked.ok) return { ok: false, problem: `${key} ${checked.problem}` };
    if (checked.value !== undefined) out[key] = checked.value;
  }
  return { ok: true, state: out };
}
