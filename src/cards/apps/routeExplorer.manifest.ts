import type { CardAppManifest } from "../manifest";

/**
 * The Route Explorer (v0.6): the precise view of a planned route beside Aion's particle terrain — a pannable, zoomable map
 * (OpenStreetMap tiles, handed over by Aion, never fetched by the card), the route's real geometry with its start, end
 * and waypoints, an elevation profile linked to the map and to the body, and the route's figures. It draws the one
 * GeoRoute the hub keeps (LOAD_ROUTE) and nothing else: it cannot plan, change or invent a route. Opened by `plan_route`
 * only. See docs/ROUTE-EXPLORER.md.
 */
export const ROUTE_EXPLORER_MANIFEST = {
  id: "route-explorer",
  name: "Route Explorer",
  version: "1.0.0",
  entry: "route-explorer",
  description: "A planned route's exact map, elevation profile and figures, linked to the particle terrain beside it.",
  capabilities: ["route-documents", "map-tiles", "selection", "interaction-events", "resource-status"],
  permissions: ["pointer", "keyboard"],
  config: {},
  commands: {
    show: { value: { type: "enum", values: ["route", "highest", "lowest", "start", "end", "steepest"] }, description: "Frame the whole route, or highlight a point or the steepest climb on the map, the profile and the terrain." },
    section: { value: { type: "text", max: 24 }, description: "Frame the part of the route between two distances in km, e.g. \"12-30\"." },
    "point-at": { value: { type: "number", min: 0, max: 2000 }, description: "Highlight the point this many km along the route." },
    "clear-highlight": { value: { type: "none" }, description: "Remove the highlight." },
  },
  state: {
    revision: { type: "number", min: 0, max: 1e9, integer: true },
    mode: { type: "enum", values: ["walking", "cycling", "hiking"] },
    distanceKm: { type: "number", min: 0, max: 2000 },
    durationMin: { type: "number", min: 0, max: 50_000 },
    ascentM: { type: "number", min: 0, max: 100_000 },
    descentM: { type: "number", min: 0, max: 100_000 },
    minM: { type: "number", min: -500, max: 9000 },
    maxM: { type: "number", min: -500, max: 9000 },
    /** What is highlighted (Codex's show / point-at / section, or the user's click). */
    highlight: { type: "enum", values: ["none", "highest", "lowest", "start", "end", "steepest", "point", "section"] },
    highlightKm: { type: "number", min: 0, max: 2000 },
    highlightM: { type: "number", min: -500, max: 9000 },
    /** The part of the route framed, as "from-to" km ("all": no section — the whole route or the user's own view). */
    sectionKm: { type: "text", max: 24 },
    /** Where the pointer is along the route (km), or -1 when it is not over the route or the profile. */
    cursorKm: { type: "number", min: -1, max: 2000 },
    zoom: { type: "number", min: 0, max: 19 },
    view: { type: "enum", values: ["route", "section", "point", "custom"] },
    tiles: { type: "enum", values: ["loading", "ok", "partial", "unavailable"] },
  },
  resources: { assets: [], maxAssetBytes: 0, maxTriangles: 0, maxTextures: 0, maxTextureSize: 0, maxLoadSeconds: 10 },
  display: { minWidth: 320, minHeight: 300, layouts: ["compact", "expanded", "fullscreen"], defaultLayout: "compact" },
  cleanup: { onClose: "dispose", onHidden: "suspend" },
} satisfies CardAppManifest;
