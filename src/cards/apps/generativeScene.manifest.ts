import type { CardAppManifest } from "../manifest";

/**
 * The generative scene (v0.5): a general-purpose Three.js scene runtime on Card 2.0. Unlike Earth–Moon and the CAD
 * viewer it represents no particular subject: it builds whatever validated Scene IR document (src/scene) it is handed,
 * keeps it as it is patched (objects keep their identity), animates it on one timeline and lets the user select and
 * inspect any object. See docs/GENERATIVE-VISUAL-ENGINE.md.
 */
export const GENERATIVE_SCENE_MANIFEST = {
  id: "generative-scene",
  name: "Generated Scene",
  version: "1.0.0",
  entry: "generative-scene",
  description: "Builds any validated Scene IR document as an interactive 3D scene: objects, materials, labels, a timeline of animations, selection and inspection.",
  capabilities: ["webgl", "scene-documents", "selection", "camera", "simulation-time", "visibility", "interaction-events", "resource-status"],
  permissions: ["pointer", "keyboard"],
  config: {
    labels: { type: "boolean" },
    paused: { type: "boolean" },
  },
  commands: {
    select: { value: { type: "id" }, description: "Select an object by its id (highlighted; its metadata is reported)." },
    "clear-selection": { value: { type: "none" }, description: "Select nothing." },
    focus: { value: { type: "id" }, description: "Fly the camera to an object." },
    "reset-camera": { value: { type: "none" }, description: "Frame the whole scene (or the scene's own camera)." },
    "set-view": { value: { type: "enum", values: ["iso", "top", "front", "side"] }, description: "A standard view of the whole scene." },
    "set-speed": { value: { type: "number", min: 0, max: 50 }, description: "Timeline playback speed (1 = real time)." },
    seek: { value: { type: "number", min: 0, max: 10_000_000 }, description: "Jump the timeline to a time in seconds." },
    "show-labels": { value: { type: "boolean" }, description: "Object labels." },
  },
  state: {
    revision: { type: "number", min: 0, max: 1e9, integer: true },
    title: { type: "text", max: 80 },
    objects: { type: "number", min: 0, max: 100_000, integer: true },
    animations: { type: "number", min: 0, max: 10_000, integer: true },
    playing: { type: "boolean" },
    time: { type: "number", min: 0, max: 1e9 },
    speed: { type: "number", min: 0, max: 50 },
    view: { type: "enum", values: ["iso", "top", "front", "side", "scene", "custom"] },
    labels: { type: "boolean" },
    triangles: { type: "number", min: 0, max: 10_000_000, integer: true },
    /** What the last revision changed in the built scene (evidence that edits are incremental). */
    changes: { type: "text", max: 120 },
    /** Milliseconds the last revision took to build. */
    buildMs: { type: "number", min: 0, max: 600_000 },
  },
  resources: { assets: [], maxAssetBytes: 0, maxTriangles: 600_000, maxTextures: 64, maxTextureSize: 1024, maxLoadSeconds: 15 },
  display: { minWidth: 320, minHeight: 240, layouts: ["compact", "expanded", "fullscreen"], defaultLayout: "expanded" },
  cleanup: { onClose: "dispose", onHidden: "suspend" },
} satisfies CardAppManifest;
