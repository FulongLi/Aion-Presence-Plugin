import type { SceneDocument, Vec3 } from "./ir";

/**
 * The engineering backend boundary (v0.5, interface only — no backend ships in v0.5). See docs/FUTURE-CAD-INTEGRATION.md.
 *
 * A parametric CAD kernel (FreeCAD, OpenCASCADE) or an engineering solver (AIPE) is a *backend*: it owns parametric
 * geometry and computation. Aion stays the *visualization and interaction* layer: it shows what the backend produced
 * (as a Scene IR document that references an exported mesh, or as a model in the CAD viewer), keeps selection in sync by
 * stable component ids, and routes parameter changes back. Mesh visualization is never presented as parametric
 * modelling: the parameters live in the backend, and only the backend regenerates geometry.
 *
 *   Codex ─ engineering parameters ─► EngineeringBackend.regenerate ─► BackendModel (revision, components, mesh export)
 *                                                                         │
 *        Aion Scene Adapter (sceneFromModel) ◄────────────────────────────┘
 *              │
 *        generative-scene card / CAD viewer  ─ selection (component ids) ─► Codex ─ parameter update ─► backend
 */
export interface EngineeringParameter {
  id: string;
  name: string;
  value: number | string | boolean;
  unit?: string;
  min?: number;
  max?: number;
}

/** One component of a backend model, with an id that survives regeneration (selection stays on it). */
export interface BackendComponent {
  id: string;
  name: string;
  parent?: string;
  /** Engineering metadata (part number, material, mass…), reported when selected. */
  metadata: Record<string, string | number | boolean>;
  /** The component's mesh in the exported asset (a glTF node name), when it has geometry. */
  meshNode?: string;
  bounds?: { min: Vec3; max: Vec3 };
}

/** A model revision a backend produced: what changed, and where its geometry is. */
export interface BackendModel {
  backend: string;
  modelId: string;
  /** Monotonic: a selection or a change against an older revision is stale. */
  revision: number;
  parameters: EngineeringParameter[];
  components: BackendComponent[];
  /** The exported geometry: a validated glTF/GLB asset (loaded by the card through the host, never by URL). */
  asset?: { mime: "model/gltf-binary"; bytes: number; sha256: string };
  units: "mm" | "m";
  warnings: string[];
}

/** Errors a backend reports (shown to the user as they are; never replaced by an approximation). */
export type BackendError =
  | { code: "backend-unavailable"; message: string }
  | { code: "invalid-parameter"; parameter: string; message: string }
  | { code: "regeneration-failed"; message: string; component?: string }
  | { code: "stale-revision"; current: number; message: string }
  | { code: "timeout"; message: string };

export type RegenerateResult = { ok: true; model: BackendModel } | { ok: false; error: BackendError };

/**
 * What an engineering backend implements. Regeneration is asynchronous and may take long: the host reports progress to
 * the card (LOADING) and keeps the previous revision on show until the new one is ready (or failed).
 */
export interface EngineeringBackend {
  readonly id: string;
  /** What it can compute ("parametric-solid", "magnetic-field", …): registered as compute capabilities. */
  readonly capabilities: readonly string[];
  open(modelId: string): Promise<RegenerateResult>;
  /** Applies parameter changes against `baseRevision` (stale ones are refused) and regenerates. */
  regenerate(modelId: string, changes: { id: string; value: EngineeringParameter["value"] }[], baseRevision: number, signal?: AbortSignal): Promise<RegenerateResult>;
  /** Exports the current revision's geometry (glTF/GLB bytes). */
  exportMesh(modelId: string, revision: number): Promise<Uint8Array>;
}

/**
 * The Aion Scene Adapter for a backend model: a scene whose objects are the model's components (ids preserved), each a
 * group carrying the component's metadata, so selection in the card names the backend's own component. The geometry is
 * the exported mesh (loaded by the CAD viewer today); the scene says it is a mesh view of a parametric model.
 */
export function sceneFromModel(model: BackendModel): SceneDocument {
  return {
    version: 1,
    sceneId: `${model.backend}-${model.modelId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 64),
    title: `${model.modelId} (revision ${model.revision})`.slice(0, 80),
    intent: { kind: "engineering", fidelity: "measured", interaction: "inspect" },
    units: { length: model.units, time: "s", angle: "deg" },
    disclosure: [`A mesh view of a parametric model from ${model.backend}; parameters are changed in the backend, which regenerates the geometry.`.slice(0, 200)],
    objects: model.components.slice(0, 256).map(c => ({
      id: c.id.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 64), type: "group" as const, name: c.name.slice(0, 80),
      metadata: Object.fromEntries(Object.entries(c.metadata).slice(0, 16)),
    })),
  };
}
