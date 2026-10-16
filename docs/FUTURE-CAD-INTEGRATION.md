# Future CAD and engineering integration (v0.5: the boundary, not the backend)

v0.5 ships **no** CAD kernel, field solver or circuit simulator. It defines where one plugs in
(`src/scene/cad.ts`), so FreeCAD or OpenCASCADE, and later AIPE's engineering tools, can use Aion's visualization and
interaction layer without changing it. The CAD viewer (`cad-viewer`, v0.4.5) is unchanged and still works.

## Mesh visualization is not parametric modelling

A glTF/GLB in the CAD viewer, or a mesh in a generated scene, is a *picture* of geometry. It has no parameters,
constraints or feature tree, and changing it does not change a design. Parametric modelling belongs to a backend that
owns the parameters and regenerates geometry. Aion never presents a mesh edit as a design change, and the adapter
says so in the scene's disclosure ("A mesh view of a parametric model from …; parameters are changed in the backend,
which regenerates the geometry").

## The boundary

```
User
  │  "Make the core 10 mm wider."
Codex ──────────── engineering parameters ─────────────► EngineeringBackend.regenerate(model, changes, baseRevision)
  ▲                                                          │  (FreeCAD / OCCT; asynchronous; may take seconds)
  │                                                          ▼
  │                                         BackendModel { revision, parameters, components (stable ids),
  │                                                        asset (exported GLB), units, warnings }
  │                                                          │
  │                         Aion Scene Adapter: sceneFromModel(model) ─► Scene IR (components as nodes, ids kept,
  │                                                          │             engineering metadata, disclosure)
  │                                                          ▼
  └──── selection (component id), inspect ◄──── generative-scene card  /  CAD viewer (the exported GLB)
```

| Need | How the interface provides it |
| --- | --- |
| Model revisions | `BackendModel.revision` is monotonic; `regenerate(…, baseRevision)` refuses stale changes (`stale-revision`), matching the Scene IR history |
| Stable component ids | `BackendComponent.id` survives regeneration, so a selection stays on "the core" across revisions; the adapter keeps the ids |
| Model replacement | a new revision becomes a new scene revision (or a new model in the open CAD viewer), so the card is kept |
| Engineering metadata | `BackendComponent.metadata` (part number, material, mass…) becomes node metadata, shown and reported on selection |
| Parameter updates | `regenerate(modelId, [{ id, value }], baseRevision)`; parameters carry units and bounds (`EngineeringParameter`) |
| Asynchronous regeneration | `regenerate` is a promise with an `AbortSignal`; the card shows `LOADING` progress and keeps the previous revision on show until the new one is ready or failed |
| CAD operation errors | `BackendError`: backend-unavailable, invalid-parameter, regeneration-failed (with the component), stale-revision, timeout. They are shown as they are and never replaced by an approximation |
| Selection synchronization | the card reports the selected component's id; Codex maps it to the backend's component and its parameters |
| Capabilities | a backend lists what it computes (`capabilities`), which the router registers as `compute:*` capabilities, so requests that were UNSUPPORTED in v0.5 become SUPPORTED with that backend present (`checkCapabilities(doc, { …, compute: [...] })`) |

## Where it would run

A backend is a host-side process: a local FreeCAD or OCCT service, or an MCP server of its own that Codex calls. It
is never code inside a card. Exported geometry reaches a card the way models do today: validated on the host
(`src/cards/assets/gltf.ts`), hashed, handed to the frame as bytes, and never fetched by URL. Field or circuit results
would arrive as data (sampled fields, waveforms) that a scene presents, labelled with their source and accuracy.

## AIPE

AIPE's engineering tools (magnetics, power electronics, waveforms) would use the same pieces: Scene IR scenes for
spatial results, Card 2.0 applications for specialised viewers (the waveform viewer sketched in [CARDS.md](CARDS.md)),
the Router 2.0 capability model so computed results are only claimed when a validated backend produced them, and the
same selection, patch and history loop.
