import { CARD_LAYOUTS, CARD_LIMITS, checkState, type CardAppManifest, type CardLayout } from "./manifest";
import { CARD_LIFECYCLE, type CardLifecycle } from "./lifecycle";
import { CARD_INSTANCE, editProblem, selectionProblem, validResources, type CardSelection, type ResourceStatus, type SceneEdit } from "./protocol";
import { cleanCardText, type CardValue } from "./values";
import type { SceneDocument } from "../scene/ir";
import type { HistoryEntry } from "../scene/history";
import type { GeoRoute } from "../visual/geo/route";

/**
 * The interactive card as Aion's hub knows it (v0.4.5): independent of any page's DOM, so Codex can inspect it and every
 * surface draws the same card. Only meaningful state is kept — the application, its lifecycle, its declared state, the
 * selection, the loaded asset, errors and the commands for surfaces to apply — never animation frames.
 *
 * Commands travel as numbered entries (`seq`); each surface applies those it has not applied yet and the card's RESULT
 * comes back as an acknowledgement, so a tool call knows whether its command really took effect.
 */
export interface CardCommandEntry { seq: number; command: string; value?: CardValue; at: number }
export interface CardAck { seq: number; ok: boolean; problem?: string }
export interface CardAssetRef { id: string; name: string; bytes: number; sha256: string; mime: string }

/**
 * v0.5: the scene of a `scene-documents` card (the generative scene). The document here is authoritative; the card
 * builds it and confirms which revision it has actually built (`rendered`) — an accepted change is not a rendered one.
 * Earlier documents (undo/redo) stay in the store; the snapshot carries only their count and the revision log.
 */
export interface CardSceneState {
  document: SceneDocument;
  revision: number;
  label: string;
  log: HistoryEntry[];
  undo: number;
  redo: number;
  rendered: { revision: number; ok: boolean; problem?: string; at: number } | null;
  /** The outcome of the latest scene command, by its request id (the tool that sent it reads it). */
  outcome: SceneOutcome | null;
}
/**
 * v0.6: the route of a `route-documents` card (the Route Explorer). The one route both the card and the body's terrain
 * overlay draw; each change (reversed, another mode, a waypoint) is a new revision. The card confirms what it drew.
 */
export interface CardRouteState {
  document: GeoRoute;
  revision: number;
  rendered: { revision: number; ok: boolean; problem?: string; at: number } | null;
}

export interface SceneOutcome { request: string; ok: boolean; revision: number; code?: string; problem?: string; summary?: string; changed?: string[]; removed?: string[] }

export interface CardSnapshot {
  instance: string;
  app: string;
  title: string;
  layout: CardLayout;
  lifecycle: CardLifecycle;
  state: Record<string, CardValue>;
  selection: CardSelection | null;
  error: { code: string; message: string } | null;
  asset: CardAssetRef | null;
  config: Record<string, CardValue>;
  commands: CardCommandEntry[];
  acks: CardAck[];
  nextSeq: number;
  resources: ResourceStatus | null;
  /** When a surface last reported this card (null: none has yet). */
  reportedAt: number | null;
  openedAt: number;
  /** The user is manipulating the card right now (the body calms its background motion). */
  interacting: boolean;
  /** v0.5: the scene of a generative scene card (null for other applications, or before its first scene). */
  scene: CardSceneState | null;
  /** v0.6: the route of a Route Explorer card (null for other applications). */
  route: CardRouteState | null;
}

/** What a surface reports about the card it shows. Everything is optional except whose card it is. */
export interface CardReport {
  window: string;
  instance: string;
  lifecycle?: CardLifecycle;
  layout?: CardLayout;
  state?: Record<string, CardValue>;
  selection?: CardSelection | null;
  error?: { code: string; message: string } | null;
  acks?: CardAck[];
  resources?: ResourceStatus;
  interacting?: boolean;
  /** v0.5: the scene revision the card has built (ok) or refused to build (with why). */
  scene?: { revision: number; ok: boolean; problem?: string };
  /** v0.5.1: the user's own change in the card (moved, turned, resized; undo, redo): the hub makes it a scene patch. */
  edit?: SceneEdit;
  /** v0.6: the route revision the card has drawn (ok) or could not draw (with why). */
  route?: { revision: number; ok: boolean; problem?: string };
}

export const CARD_REPORT_BYTES = 96 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Validates a report against the card on show: a report about another (closed, replaced, obsolete) instance is refused,
 * and its state must be what the application's manifest declares.
 */
export function checkCardReport(raw: unknown, card: CardSnapshot | null, manifest: CardAppManifest | undefined): { ok: true; report: CardReport } | { ok: false; problem: string; stale?: boolean } {
  if (!isRecord(raw)) return { ok: false, problem: "not an object" };
  const allowed = ["window", "instance", "lifecycle", "layout", "state", "selection", "error", "acks", "resources", "interacting", "scene", "edit", "route"];
  if (Object.keys(raw).some(key => !allowed.includes(key))) return { ok: false, problem: "unknown fields" };
  if (typeof raw.window !== "string" || !/^[a-z0-9]{8,32}$/.test(raw.window)) return { ok: false, problem: "invalid window" };
  if (typeof raw.instance !== "string" || !CARD_INSTANCE.test(raw.instance)) return { ok: false, problem: "invalid instance" };
  if (!card || raw.instance !== card.instance || !manifest) return { ok: false, problem: "stale card instance", stale: true };
  const report: CardReport = { window: raw.window, instance: raw.instance };
  if (raw.lifecycle !== undefined) {
    if (!(CARD_LIFECYCLE as readonly unknown[]).includes(raw.lifecycle)) return { ok: false, problem: "invalid lifecycle" };
    report.lifecycle = raw.lifecycle as CardLifecycle;
  }
  if (raw.layout !== undefined) {
    if (!(CARD_LAYOUTS as readonly unknown[]).includes(raw.layout) || !manifest.display.layouts.includes(raw.layout as CardLayout)) return { ok: false, problem: "invalid layout" };
    report.layout = raw.layout as CardLayout;
  }
  if (raw.state !== undefined) {
    const state = checkState(manifest, raw.state);
    if (!state.ok) return { ok: false, problem: state.problem };
    report.state = state.state;
  }
  if (raw.selection !== undefined) {
    if (raw.selection !== null) {
      if (!manifest.capabilities.includes("selection")) return { ok: false, problem: "selection needs the selection capability" };
      const problem = selectionProblem(raw.selection);
      if (problem) return { ok: false, problem: `selection: ${problem}` };
    }
    report.selection = raw.selection as CardSelection | null;
  }
  if (raw.error !== undefined) {
    if (raw.error !== null) {
      const error = raw.error as Record<string, unknown>;
      if (!isRecord(error) || Object.keys(error).some(key => key !== "code" && key !== "message") || typeof error.code !== "string" || !/^[a-z][a-z0-9-]{1,40}$/.test(error.code)
        || cleanCardText(error.message, 200) !== error.message) return { ok: false, problem: "invalid error" };
    }
    report.error = raw.error as CardReport["error"];
  }
  if (raw.acks !== undefined) {
    if (!Array.isArray(raw.acks) || raw.acks.length > CARD_LIMITS.commandQueue) return { ok: false, problem: "invalid acknowledgements" };
    for (const ack of raw.acks as unknown[]) {
      const a = ack as Record<string, unknown>;
      if (!isRecord(a) || !Number.isInteger(a.seq) || (a.seq as number) < 1 || (a.seq as number) >= card.nextSeq || typeof a.ok !== "boolean"
        || (a.problem !== undefined && cleanCardText(a.problem, 200) !== a.problem) || Object.keys(a).some(key => !["seq", "ok", "problem"].includes(key))) return { ok: false, problem: "invalid acknowledgement" };
    }
    report.acks = raw.acks as CardAck[];
  }
  if (raw.resources !== undefined) {
    if (!validResources(raw.resources)) return { ok: false, problem: "invalid resources" };
    report.resources = raw.resources;
  }
  if (raw.interacting !== undefined) {
    if (typeof raw.interacting !== "boolean") return { ok: false, problem: "invalid interacting" };
    report.interacting = raw.interacting;
  }
  if (raw.scene !== undefined) {
    const scene = raw.scene as Record<string, unknown>;
    if (!manifest.capabilities.includes("scene-documents")) return { ok: false, problem: "scene needs the scene-documents capability" };
    if (!isRecord(scene) || Object.keys(scene).some(key => !["revision", "ok", "problem"].includes(key)) || !Number.isInteger(scene.revision) || (scene.revision as number) < 1
      || (scene.revision as number) > (card.scene?.revision ?? 0) || typeof scene.ok !== "boolean" || (scene.problem !== undefined && cleanCardText(scene.problem, 200) !== scene.problem)) return { ok: false, problem: "invalid scene acknowledgement" };
    report.scene = { revision: scene.revision as number, ok: scene.ok as boolean, ...(scene.problem !== undefined ? { problem: scene.problem as string } : {}) };
  }
  if (raw.edit !== undefined) {
    if (!manifest.capabilities.includes("scene-documents") || !card.scene) return { ok: false, problem: "edit needs a generated scene" };
    const problem = editProblem(raw.edit);
    if (problem) return { ok: false, problem: `edit: ${problem}` };
    const edit = raw.edit as SceneEdit;
    if (edit.base > card.scene.revision) return { ok: false, problem: "edit: from a revision that does not exist" };
    if (edit.action === "transform" && !card.scene.document.objects.some(n => n.id === edit.id)) return { ok: false, problem: "edit: no such object" };
    report.edit = structuredClone(edit);
  }
  if (raw.route !== undefined) {
    const route = raw.route as Record<string, unknown>;
    if (!manifest.capabilities.includes("route-documents")) return { ok: false, problem: "route needs the route-documents capability" };
    if (!isRecord(route) || Object.keys(route).some(key => !["revision", "ok", "problem"].includes(key)) || !Number.isInteger(route.revision) || (route.revision as number) < 1
      || (route.revision as number) > (card.route?.revision ?? 0) || typeof route.ok !== "boolean" || (route.problem !== undefined && cleanCardText(route.problem, 200) !== route.problem)) return { ok: false, problem: "invalid route acknowledgement" };
    report.route = { revision: route.revision as number, ok: route.ok as boolean, ...(route.problem !== undefined ? { problem: route.problem as string } : {}) };
  }
  return { ok: true, report };
}

/** The card after a report (state merges key by key; acknowledgements accumulate, the newest kept). */
export function applyCardReport(card: CardSnapshot, report: CardReport, now: number): CardSnapshot {
  const acks = report.acks?.length
    ? [...card.acks.filter(ack => !report.acks!.some(next => next.seq === ack.seq)), ...report.acks].sort((a, b) => a.seq - b.seq).slice(-CARD_LIMITS.commandQueue)
    : card.acks;
  return {
    ...card,
    ...(report.lifecycle ? { lifecycle: report.lifecycle } : {}),
    ...(report.layout ? { layout: report.layout } : {}),
    ...(report.state ? { state: { ...card.state, ...report.state } } : {}),
    ...(report.selection !== undefined ? { selection: report.selection } : {}),
    ...(report.error !== undefined ? { error: report.error } : {}),
    ...(report.resources ? { resources: report.resources } : {}),
    ...(report.interacting !== undefined ? { interacting: report.interacting } : {}),
    ...(report.scene && card.scene ? { scene: { ...card.scene, rendered: { ...report.scene, at: now } } } : {}),
    ...(report.route && card.route ? { route: { ...card.route, rendered: { ...report.route, at: now } } } : {}),
    acks, reportedAt: now,
  };
}

/** Appends a command for the surfaces to apply; returns the card and the command's number. */
export function queueCardCommand(card: CardSnapshot, command: string, value: CardValue | undefined, now: number): { card: CardSnapshot; seq: number } {
  const seq = card.nextSeq;
  const entry: CardCommandEntry = { seq, command, ...(value !== undefined ? { value } : {}), at: now };
  return { card: { ...card, commands: [...card.commands, entry].slice(-CARD_LIMITS.commandQueue), nextSeq: seq + 1 }, seq };
}

/** A card just opened (nothing reported yet). */
export function openCard(init: { instance: string; app: string; title: string; layout: CardLayout; asset: CardAssetRef | null; config: Record<string, CardValue>; now: number }): CardSnapshot {
  return {
    instance: init.instance, app: init.app, title: init.title, layout: init.layout, lifecycle: "loading", state: {}, selection: null, error: null,
    asset: init.asset, config: init.config, commands: [], acks: [], nextSeq: 1, resources: null, reportedAt: null, openedAt: init.now, interacting: false, scene: null, route: null,
  };
}
