import type { CardAppManifest } from "../manifest";

/**
 * The Simulation Card (v0.8): the interactive 3D front of Aion's engineering simulations. It shows a study's setup (the
 * CAD faces coloured by their boundary conditions, a face picked for "$selected") and the numerical fields a solver
 * computed (Elmer, via `simulate`): colour-mapped surfaces with a labelled legend, sections through the mesh, vectors,
 * mesh display and probes. It only ever displays a validated field bundle (src/sim/field.ts); it never computes or
 * invents a field, and it never runs a solver. See docs/SIMULATION-CARD.md.
 */
export const SIMULATION_MANIFEST = {
  id: "simulation",
  name: "Simulation",
  version: "1.0.0",
  entry: "simulation",
  description: "Interactive FEM results and setup: colour-mapped fields with a legend, sections, vectors, mesh, face picking and probes.",
  capabilities: ["webgl", "model-assets", "selection", "camera", "visibility", "interaction-events", "resource-status"],
  permissions: ["pointer", "keyboard"],
  config: {},
  commands: {
    "set-field": { value: { type: "text", max: 40 }, description: "Show a field by id (potential, electric_field, current_density, joule_heating, temperature, heat_flux)." },
    "set-colormap": { value: { type: "enum", values: ["rainbow", "viridis", "inferno", "coolwarm", "jet", "grayscale"] }, description: "The colour map." },
    "set-range": { value: { type: "text", max: 60 }, description: "\"auto\", or \"min,max\" in the field's display unit." },
    bands: { value: { type: "boolean" }, description: "Banded contours (12 levels) instead of a smooth gradient." },
    "show-mesh": { value: { type: "boolean" }, description: "The mesh's surface edges." },
    "show-edges": { value: { type: "boolean" }, description: "The CAD faces' edges." },
    "show-vectors": { value: { type: "boolean" }, description: "Arrows of a vector field (current density, electric field, heat flux)." },
    section: { value: { type: "text", max: 80 }, description: "\"off\", \"x 12.5\" (axis and offset in mm), or \"normal nx,ny,nz at x,y,z\" (mm)." },
    probe: { value: { type: "text", max: 60 }, description: "\"max\", \"min\" (of the shown field) or \"x,y,z\" in mm: marks the point and reads every field there." },
    "clear-probe": { value: { type: "none" }, description: "Remove the probe." },
    select: { value: { type: "id" }, description: "Select a face by id (F12)." },
    "clear-selection": { value: { type: "none" }, description: "Select nothing." },
    "set-view": { value: { type: "enum", values: ["iso", "front", "back", "left", "right", "top", "bottom"] }, description: "A standard view." },
    fit: { value: { type: "none" }, description: "Fit the model to the view." },
    "reset-camera": { value: { type: "none" }, description: "The default isometric view." },
    status: { value: { type: "text", max: 80 }, description: "A short progress note from the simulation backend (\"ready\": none)." },
  },
  state: {
    loaded: { type: "text", max: 80 },
    mode: { type: "enum", values: ["empty", "setup", "results"] },
    study: { type: "text", max: 40 },
    run: { type: "number", min: 0, max: 1_000_000, integer: true },
    field: { type: "text", max: 40 },
    fields: { type: "ids", max: 16 },
    unit: { type: "text", max: 20 },
    colormap: { type: "enum", values: ["rainbow", "viridis", "inferno", "coolwarm", "jet", "grayscale"] },
    range: { type: "text", max: 80 },
    autoRange: { type: "boolean" },
    bands: { type: "boolean" },
    mesh: { type: "boolean" },
    edges: { type: "boolean" },
    vectors: { type: "boolean" },
    section: { type: "text", max: 80 },
    probe: { type: "text", max: 300 },
    selected: { type: "id" },
    view: { type: "enum", values: ["iso", "front", "back", "left", "right", "top", "bottom", "custom"] },
    triangles: { type: "number", min: 0, max: 10_000_000, integer: true },
    interior: { type: "boolean" },
  },
  resources: { assets: ["field"], maxAssetBytes: 16 * 1024 * 1024, maxTriangles: 2_000_000, maxTextures: 8, maxTextureSize: 1024, maxLoadSeconds: 20 },
  display: { minWidth: 360, minHeight: 280, layouts: ["compact", "expanded", "fullscreen"], defaultLayout: "expanded" },
  cleanup: { onClose: "dispose", onHidden: "suspend" },
} satisfies CardAppManifest;
