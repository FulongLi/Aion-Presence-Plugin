import { BUILTIN_CARD_APPS } from "../registry";
import { CARD_PROTOCOL_VERSION, CARD_INSTANCE, parseToCard, type FromCardMessage, type FromCardPayloads, type FromCardType, type ToCardMessage } from "../protocol";
import type { CardAppManifest } from "../manifest";
import type { CardApp, CardContext } from "./app";
import { CARD_APP_FACTORIES } from "./apps";

/**
 * The interactive card runtime (v0.4.5): the script inside the sandboxed frame. It runs with an opaque origin (no
 * cookies, storage, parent access or network beyond its own blob: images), receives exactly one MessagePort from its
 * parent at start, and from then on speaks only the Card Bridge protocol over it. Nothing it receives is ever executed:
 * messages are validated (src/cards/protocol.ts) and mapped onto the application's hooks.
 */
const manifests = new Map<string, CardAppManifest>(BUILTIN_CARD_APPS.map(app => [app.id, app]));
const stage = document.getElementById("stage")!, ui = document.getElementById("ui")!;

// Object URLs are counted so disposal can prove none is left behind.
let urls = 0;
const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (object: Blob | MediaSource) => { urls++; return createURL(object); };
URL.revokeObjectURL = (url: string) => { if (url.startsWith("blob:")) urls = Math.max(0, urls - 1); revokeURL(url); };

let bound = false;
addEventListener("message", event => {
  // One port, once, from the parent page only; every other window message is ignored.
  if (bound || event.source !== parent || event.ports.length !== 1) return;
  const data = event.data as { aion?: unknown; v?: unknown; instance?: unknown; app?: unknown } | null;
  if (!data || data.aion !== "card-port" || data.v !== CARD_PROTOCOL_VERSION || typeof data.instance !== "string" || !CARD_INSTANCE.test(data.instance)) return;
  const manifest = typeof data.app === "string" ? manifests.get(data.app) : undefined;
  if (!manifest) return;
  bound = true;
  run(event.ports[0], data.instance, manifest);
});

function run(port: MessagePort, instance: string, manifest: CardAppManifest) {
  let app: CardApp | null = null, disposed = false, statusTimer = 0;
  const send = <T extends FromCardType>(type: T, payload: FromCardPayloads[T], re?: string) => {
    if (disposed && type !== "DISPOSED") return;
    port.postMessage({ v: CARD_PROTOCOL_VERSION, instance, type, ...(re ? { re } : {}), payload } as FromCardMessage);
  };
  // State bursts are coalesced: at most a few messages a second, the latest values.
  let state: Record<string, unknown> = {}, stateTimer = 0;
  const flushState = () => { stateTimer = 0; send("STATE_CHANGED", { state: state as FromCardPayloads["STATE_CHANGED"]["state"] }); state = {}; };
  const ctxFor = (init: Extract<ToCardMessage, { type: "INITIALIZE" }>["payload"]): CardContext => ({
    manifest, config: init.config, state: init.state, layout: init.layout, reducedMotion: init.reducedMotion, theme: init.theme, limits: init.limits, stage, ui,
    emit: {
      state: next => { Object.assign(state, next); if (!stateTimer) stateTimer = self.setTimeout(flushState, 200); },
      selection: selection => send("SELECTION_CHANGED", selection),
      loading: (phase, progress) => send("LOADING", { phase, progress: Math.max(0, Math.min(1, progress)) }),
      error: (code, message, fatal) => send("ERROR", { code, message: message.slice(0, 200), fatal }),
      interaction: kind => send("INTERACTION", { kind }),
      edit: edit => { if (manifest.capabilities.includes("scene-documents")) send("EDIT", edit); },
      // v0.6: the pointer along the route, at most about 20 a second (the latest wins), and tile requests in batches.
      cursor: distance => {
        if (!manifest.capabilities.includes("route-documents")) return;
        cursorNext = distance === null ? null : Math.round(distance);
        if (cursorTimer) return;
        const flush = () => { cursorTimer = 0; if (cursorNext !== cursorSent) { cursorSent = cursorNext; send("CURSOR", { distance: cursorNext }); cursorTimer = self.setTimeout(flush, 50); } };
        flush();
      },
      tiles: tiles => {
        if (!manifest.capabilities.includes("map-tiles")) return;
        for (let i = 0; i < tiles.length; i += 16) send("TILE_REQUEST", { tiles: tiles.slice(i, i + 16).map(({ z, x, y }) => ({ z, x, y })) });
      },
    },
  });
  let cursorNext: number | null = null, cursorSent: number | null | undefined = undefined, cursorTimer = 0;
  const reply = (re: string | undefined, ok: boolean, problem?: string) => {
    // What the request changed is reported before its answer, so whoever waits for the answer sees the new state.
    app?.flush?.();
    if (stateTimer) { clearTimeout(stateTimer); flushState(); }
    if (re) send("RESULT", ok ? { ok } : { ok, problem: (problem ?? "failed").slice(0, 200) }, re);
  };
  const fatal = (code: string, message: string) => { send("ERROR", { code, message, fatal: true }); };

  port.onmessage = async event => {
    const parsed = parseToCard(event.data, instance, manifest);
    if (!parsed.ok) return; // Malformed or stale: dropped (the parent's messages are validated here as well).
    const message = parsed.message;
    if (disposed) return;
    try {
      switch (message.type) {
        case "INITIALIZE": {
          if (app) return reply(message.id, false, "already initialized");
          document.documentElement.style.setProperty("--accent", message.payload.theme.accent);
          document.documentElement.dataset.layout = message.payload.layout;
          if (message.payload.reducedMotion) document.documentElement.dataset.motion = "reduced";
          const factory = CARD_APP_FACTORIES[manifest.entry];
          if (!factory) return fatal("app-missing", "This application is not part of the card runtime.");
          try { app = factory(ctxFor(message.payload)); } catch (error) {
            const code = error instanceof Error && error.message === "webgl-unavailable" ? "webgl-unavailable" : "app-start-failed";
            return fatal(code, code === "webgl-unavailable" ? "WebGL 2 is not available here, so this 3D card cannot run." : "The application could not start.");
          }
          await app.start();
          send("READY", { app: manifest.id, version: manifest.version });
          statusTimer = self.setInterval(() => { if (app && !disposed) send("RESOURCE_STATUS", app.status()); }, 2000);
          return reply(message.id, true);
        }
        case "LOAD_ASSET":
          if (!app?.loadAsset) return reply(message.id, false, "this application takes no assets");
          try {
            await app.loadAsset(message.payload.asset, message.payload.data);
            return reply(message.id, true);
          } catch (error) {
            const code = error instanceof Error && /^model-[a-z-]+$/.test(error.message) ? error.message : "model-load-failed";
            send("ERROR", { code, message: code === "model-too-large" ? "The model has more triangles than this card allows." : code === "model-load-timeout" ? "The model took too long to load." : "The model could not be loaded.", fatal: false });
            return reply(message.id, false, code);
          }
        case "LOAD_SCENE": {
          if (!app?.loadScene) return reply(message.id, false, "this application takes no scenes");
          const result = await app.loadScene(message.payload.revision, message.payload.document, message.payload.history);
          return reply(message.id, result.ok, result.ok ? undefined : result.problem);
        }
        case "LOAD_ROUTE": {
          if (!app?.loadRoute) return reply(message.id, false, "this application takes no routes");
          const result = await app.loadRoute(message.payload.revision, message.payload.route);
          return reply(message.id, result.ok, result.ok ? undefined : result.problem);
        }
        case "LOAD_TILE":
          if (!app?.loadTile) return reply(message.id, false, "this application takes no tiles");
          await app.loadTile(message.payload.tile, message.payload.mime, message.payload.data);
          return reply(message.id, true);
        case "SET_STATE": app?.setState?.(message.payload.state); return reply(message.id, true);
        case "SET_CAMERA": {
          const result = app?.setCamera?.(message.payload.view, message.payload.focus) ?? { ok: false, problem: "no camera" };
          return reply(message.id, result.ok, result.ok ? undefined : result.problem);
        }
        case "EXECUTE_COMMAND": {
          if (!app) return reply(message.id, false, "not ready");
          const result = await app.command(message.payload.command, message.payload.value);
          return reply(message.id, result.ok, result.ok ? undefined : result.problem);
        }
        case "PAUSE":
          if (message.payload.reason === "hidden") app?.suspend(true); else app?.pause();
          return reply(message.id, true);
        case "RESUME":
          if (message.payload.reason === "hidden") app?.suspend(false); else app?.resume();
          return reply(message.id, true);
        case "RESIZE":
          document.documentElement.dataset.layout = message.payload.layout;
          app?.resize(message.payload.layout);
          return reply(message.id, true);
        case "RESET": app?.reset(); return reply(message.id, true);
        case "DISPOSE": {
          disposed = true;
          clearInterval(statusTimer);
          clearTimeout(stateTimer);
          clearTimeout(cursorTimer);
          const left = app?.dispose() ?? { geometries: 0, textures: 0, urls: 0, loops: 0 };
          app = null;
          ui.replaceChildren(); stage.replaceChildren();
          send("DISPOSED", { geometries: left.geometries, textures: left.textures, urls: urls + left.urls, loops: left.loops });
          if (message.id) port.postMessage({ v: CARD_PROTOCOL_VERSION, instance, type: "RESULT", re: message.id, payload: { ok: true } });
          port.close();
          return;
        }
      }
    } catch (error) {
      send("ERROR", { code: "app-error", message: (error instanceof Error ? error.message : "The application failed.").slice(0, 200).replace(/[^\p{L}\p{N} .,:;'()/-]/gu, " "), fatal: false });
      reply(message.id, false, "the application failed");
    }
  };
  port.start();
  // Uncaught failures inside the application become a reported error, never a broken page.
  addEventListener("error", () => send("ERROR", { code: "app-error", message: "The application hit an error.", fatal: false }));
  addEventListener("unhandledrejection", () => send("ERROR", { code: "app-error", message: "The application hit an error.", fatal: false }));
}
