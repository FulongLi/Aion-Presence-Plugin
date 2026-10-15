import type { CardAppManifest } from "../manifest";

/**
 * The CAD viewer (v0.4.5): a glTF/GLB engineering model viewer. A viewer, not a CAD kernel: it renders, navigates,
 * selects and hides; geometry itself comes from a CAD backend as an exported asset. See docs/CAD-VIEWER.md.
 */
export const CAD_VIEWER_MANIFEST = {
  id: "cad-viewer",
  name: "CAD Viewer",
  version: "1.0.0",
  entry: "cad-viewer",
  description: "An interactive glTF/GLB model viewer: orbit, zoom, pan, select components, inspect their metadata, hide, isolate and fit.",
  capabilities: ["webgl", "model-assets", "selection", "camera", "visibility", "interaction-events", "resource-status"],
  permissions: ["pointer", "keyboard"],
  config: {
    view: { type: "enum", values: ["iso", "front", "back", "left", "right", "top", "bottom"] },
    edges: { type: "boolean" },
  },
  commands: {
    select: { value: { type: "id" }, description: "Select a component by its id (highlighted, its properties shown)." },
    "clear-selection": { value: { type: "none" }, description: "Select nothing." },
    hide: { value: { type: "id" }, description: "Hide a component (or a group and everything in it)." },
    show: { value: { type: "id" }, description: "Show a hidden component again." },
    isolate: { value: { type: "id" }, description: "Show only this component (and what it contains)." },
    "show-all": { value: { type: "none" }, description: "Restore visibility of every component." },
    fit: { value: { type: "none" }, description: "Fit the whole visible model to the view." },
    focus: { value: { type: "id" }, description: "Fit one component to the view." },
    "set-view": { value: { type: "enum", values: ["iso", "front", "back", "left", "right", "top", "bottom"] }, description: "A standard engineering view." },
    "reset-camera": { value: { type: "none" }, description: "The default isometric view of the whole model." },
    "show-edges": { value: { type: "boolean" }, description: "Feature edges on every component." },
  },
  state: {
    model: { type: "text", max: 80 },
    components: { type: "tree", max: 400 },
    componentCount: { type: "number", min: 0, max: 100_000, integer: true },
    truncated: { type: "boolean" },
    selected: { type: "id" },
    hidden: { type: "ids", max: 400 },
    isolated: { type: "id" },
    view: { type: "enum", values: ["iso", "front", "back", "left", "right", "top", "bottom", "custom"] },
    edges: { type: "boolean" },
    triangles: { type: "number", min: 0, max: 10_000_000, integer: true },
  },
  resources: { assets: ["model"], maxAssetBytes: 16 * 1024 * 1024, maxTriangles: 2_000_000, maxTextures: 32, maxTextureSize: 4096, maxLoadSeconds: 20 },
  display: { minWidth: 360, minHeight: 260, layouts: ["compact", "expanded", "fullscreen"], defaultLayout: "expanded" },
  cleanup: { onClose: "dispose", onHidden: "suspend" },
} satisfies CardAppManifest;
