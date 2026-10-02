import { createRenderer } from "../render";
import { CompanionTransport } from "./transports/companion";
import { McpAppsTransport } from "./transports/mcpApps";
import type { PresenceTransport } from "./transports/types";
import { PresenceView } from "./view";

/**
 * The Presence surface. One page serves both presentation modes:
 *   - opened from the local hub with its token → the companion window;
 *   - loaded by an MCP Apps host → embedded, over the host's standard bridge.
 * Anywhere else (the file opened directly) Aion rests and says how to open it from Codex.
 */
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const debug = params.get("debug") === "1";

async function chooseTransport(): Promise<PresenceTransport | null> {
  const token = params.get("token");
  if (token && /^https?:$/.test(location.protocol) && window.parent === window) return new CompanionTransport(token);
  try { return await McpAppsTransport.connect(); } catch { return null; }
}

function sizeEmbedded(transport: McpAppsTransport, root: HTMLElement) {
  const apply = () => {
    if (transport.displayMode === "fullscreen" || transport.displayMode === "pip") { root.style.height = ""; return; }
    // Inline, the presence takes a calm, fixed height within whatever the host allows.
    root.style.height = "520px";
  };
  const previous = transport.onDisplayChange;
  transport.onDisplayChange = () => { previous?.(); apply(); };
  apply();
}

async function boot() {
  const root = element("presence");
  const stage = element("stage");
  const transport = await chooseTransport();
  const lifetime = new AbortController();
  const fallback: PresenceTransport = {
    kind: "companion", start: (_onSnapshot, onConnection) => onConnection("resting"),
    media: () => Promise.reject(new Error("no-host")), fullscreen: () => null, close: () => {},
  };
  const view = new PresenceView({
    root, card: element("card"), status: element("status"), fullscreen: element<HTMLButtonElement>("fullscreen"), debug: element("debug"),
    entry: element("entry"), enter: element<HTMLButtonElement>("enter"),
  }, transport ?? fallback, { debug });
  if (transport instanceof McpAppsTransport) sizeEmbedded(transport, root);
  // Diagnostics only (?debug=1): the view, for checking the live chain from a test or the console.
  if (debug) Object.assign(window, { aionPresence: view });
  const { handle } = await createRenderer(stage, view.inputs(), lifetime.signal, (code, replacement) => {
    if (replacement) view.runtime = replacement;
    if (debug) console.warn("[Aion] renderer", code);
  }, { prefer: params.get("renderer") === "canvas" ? "canvas" : undefined });
  view.runtime = handle ?? null;
  (transport ?? fallback).start(view.apply, view.connectionChanged);
  // Presence listens locally while it is open (?mic=0 turns it off). Only in a live Presence, never at rest.
  if (transport && params.get("mic") !== "0") void view.listen();
  addEventListener("pagehide", () => { lifetime.abort(); transport?.close(); view.stopListening(); });
}

void boot();
