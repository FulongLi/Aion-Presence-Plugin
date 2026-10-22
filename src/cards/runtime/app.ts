import type { CardAppManifest, CardLayout, CardResources } from "../manifest";
import type { CardAssetInfo, CardSelection, CardTheme, FromCardPayloads, MapTile, ResourceStatus, SceneEdit } from "../protocol";
import type { GeoRoute } from "../../visual/geo/route";
import type { CardValue } from "../values";
import type { SceneDocument } from "../../scene/ir";

/**
 * What an interactive card application implements inside the sandbox (v0.4.5). The runtime (main.ts) owns the bridge:
 * it validates every message from Aion, calls these hooks, and turns what the application emits into validated messages
 * back. An application never sees the MessagePort, the page, the hub or any URL.
 *
 * Lifecycle hooks: start (once, after INITIALIZE) → loadAsset / loadScene (zero or more) → command / setState / setCamera / resize
 * while live → pause / resume (simulation time stops; on-demand frames), suspend / wake (nothing renders) → reset →
 * dispose (release everything; report what is left, ideally nothing).
 */
export interface CardInit {
  manifest: CardAppManifest;
  config: Record<string, CardValue>;
  state?: Record<string, CardValue>;
  layout: CardLayout;
  reducedMotion: boolean;
  theme: CardTheme;
  limits: CardResources;
}

export interface CardEmitter {
  /** Declared state changed (only keys from the manifest; the runtime coalesces bursts). */
  state(state: Record<string, CardValue>): void;
  selection(selection: CardSelection): void;
  loading(phase: string, progress: number): void;
  error(code: string, message: string, fatal: boolean): void;
  interaction(kind: FromCardPayloads["INTERACTION"]["kind"]): void;
  /** v0.5.1 (scene-documents): proposes the user's own change to the scene (applied only when the hub confirms it). */
  edit(edit: SceneEdit): void;
  /** v0.6 (route-documents): where along the route the user points, in metres (null: nowhere). Throttled by the runtime. */
  cursor(distance: number | null): void;
  /** v0.6 (map-tiles): the map tiles the card shows and has not received (each arrives as loadTile). */
  tiles(tiles: MapTile[]): void;
}

export interface CardContext extends CardInit {
  /** The element the application renders into (the full card area) and its overlay for controls. */
  stage: HTMLElement;
  ui: HTMLElement;
  emit: CardEmitter;
}

export type CommandResult = { ok: true } | { ok: false; problem: string };

export interface CardApp {
  start(): Promise<void> | void;
  loadAsset?(asset: CardAssetInfo, data: ArrayBuffer): Promise<void>;
  /** v0.5 (scene-documents): builds a validated scene revision; answers only once it is built (or why not). */
  loadScene?(revision: number, document: SceneDocument, history?: { undo: number; redo: number }): Promise<CommandResult> | CommandResult;
  /** v0.6 (route-documents): draws a validated route revision; answers once it is drawn (or why not). */
  loadRoute?(revision: number, route: GeoRoute): Promise<CommandResult> | CommandResult;
  /** v0.6 (map-tiles): one map tile's bytes, as asked for. */
  loadTile?(tile: MapTile, mime: string, data: ArrayBuffer): Promise<void> | void;
  command(name: string, value: CardValue | undefined): Promise<CommandResult> | CommandResult;
  setState?(state: Record<string, CardValue>): void;
  /** Emits any state change still waiting (the runtime calls it before answering a request, so state precedes the answer). */
  flush?(): void;
  setCamera?(view?: string, focus?: string): CommandResult;
  pause(): void;
  resume(): void;
  suspend(on: boolean): void;
  reset(): void;
  resize(layout: CardLayout): void;
  status(): ResourceStatus;
  dispose(): { geometries: number; textures: number; urls: number; loops: number };
}

export type CardAppFactory = (context: CardContext) => CardApp;

/** A small DOM helper for application controls (text only: nothing is ever parsed as HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string; label?: string; title?: string } = {}, children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.label) node.setAttribute("aria-label", props.label);
  if (props.title) node.title = props.title;
  node.append(...children);
  return node;
}

export function button(text: string, label: string, onClick: () => void, className = "btn"): HTMLButtonElement {
  const b = el("button", { className, text, label, title: label });
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** A toggle button (aria-pressed) that reflects and changes a boolean. */
export function toggle(text: string, label: string, get: () => boolean, set: (on: boolean) => void): HTMLButtonElement & { sync(): void } {
  const b = button(text, label, () => { set(!get()); sync(); }, "btn toggle") as HTMLButtonElement & { sync(): void };
  const sync = () => b.setAttribute("aria-pressed", String(get()));
  b.sync = sync;
  sync();
  return b;
}
