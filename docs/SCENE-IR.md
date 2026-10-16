# Scene IR (v0.5)

The Scene IR is the one description of a visual scene that Codex, the hub, the particle body and the interactive
card share. It is versioned (`version: 1`), serializable JSON, renderer-independent, and validated everywhere it
arrives. Types live in `src/scene/ir.ts`, validation in `src/scene/validate.ts`. The full field reference that Codex
reads is [`plugins/aion-presence/skills/aion-presence/references/scene-ir.md`](../plugins/aion-presence/skills/aion-presence/references/scene-ir.md).
This page explains the design.

## Shape

```
SceneDocument
  version            1 (a document of another version is refused: unsupported-version)
  sceneId, title
  intent             { kind, summary, fidelity, interaction } — Codex's interpretation, read by the router
  units              { length: unit|mm|cm|m|km|au, time: "s", angle: "deg" }
  coordinateSystem   "right-handed-y-up" (the only one; explicit so nothing is assumed)
  disclosure[]       what the user must know (scale, illustrative, sources) — always shown
  requirements[]     capabilities beyond the content ("compute:magnetic-field")
  objects[]          a flat list of nodes with stable ids; hierarchy by `parent`
  materials[]        shared materials by id
  animations[]       declarative animations of nodes
  camera, environment, timeline, presentation
```

Design choices:

- **A flat node list with parent references**, not a nested tree. Every object has one address, its id, so a patch,
  a selection, an animation or a label names it directly, and reparenting is one field.
- **Stable ids** (`[a-z0-9][a-z0-9_.-]{0,63}`) that are also valid Card Bridge object ids, so the card's selection
  reports exactly the id Codex patches.
- **Geometry as parameters, not meshes.** 20 node types (group, sphere, box, cylinder, cone, torus, plane, ring,
  circle, line, polyline, curve, tube, helix, arrow, gear, points, text, parametric, mesh) are built procedurally by
  each renderer. Small explicit meshes (`mesh`, at most 2,048 vertices) cover the rest. Parametric surfaces come from
  a fixed catalog, so no expression is ever evaluated.
- **Materials are values**: colour, opacity, emission, metalness, roughness, wireframe, unlit, dashed. They are shared
  by id or owned by a node. Colour names are normalized to `#rrggbb` (`src/core/colors.ts`).
- **Metadata and annotations are data for people and for Codex.** They appear in the inspector when an object is
  selected and are reported with the selection, so answers come from the model and not from guesses.
- **Abstract scenes are cheap**: a few primitives and an `intent` of `abstract` are enough. The router can then
  express them in the particle body without a card.

## Validation

`validateScene(input)` returns either `{ ok: true, document, stats }` (a **clean copy** with only known fields) or
`{ ok: false, code, problem }`. The codes are:

| code | when |
| --- | --- |
| `invalid-scene` | malformed: unknown fields, wrong types, out-of-range numbers, bad text |
| `unsupported-geometry` | a node `type` Aion does not build |
| `unsupported-animation` | an animation `type` (or animated property) Aion does not run |
| `invalid-reference` | a parent, material, path, centre, look-at target or coupling source that does not exist or is not allowed (orbit centres, look-at targets and paths must share the target's parent; hierarchies and couplings must not form cycles) |
| `resource-limit` | above a limit (below) |
| `unsupported-version` | not `version: 1` |

Unknown fields are refused rather than ignored. A typo is never silently dropped, and no field can smuggle
something in (`onClick`, `shader`, `url`, `script` all fail).

## Limits

| | |
| --- | --- |
| Serialized size | 48 KB (it crosses the hub and the 64 KB Card Bridge message limit) |
| Objects / after repeats | 256 / 2,000 |
| Estimated triangles | 600,000 (the card's manifest also says 600,000 and checks again before building) |
| Particles | 60,000 in all, 20,000 per point cloud |
| Animations / keyframes per animation | 128 / 64 |
| Points per path | 256 |
| Mesh | 2,048 vertices, 12,288 indices |
| Coordinates / sizes | ±100,000 / 0.0001 … 100,000 |
| Hierarchy depth | 16 |
| Text | titles and labels 80 characters, annotations 240, metadata values 120, 6 disclosures of 200 |

The triangle estimate (`nodeTriangles`) is the same function the compiler uses, and it follows the builders in
`src/cards/apps/generativeScene/geometry.ts`.

## Two renderers, one document

| | Particle Renderer Adapter (`src/scene/particleAdapter.ts`) | Three.js Renderer Adapter (`src/cards/apps/generativeScene`) |
| --- | --- | --- |
| Output | the body's own 3D scene (`src/visual/scene3d`): ≤ 24 primitives, ≤ 16 KB | Three.js objects in the sandboxed card |
| Hierarchy | flattened to world space at the start of the animations | kept: one holder `Group` per node |
| Materials | brightness only (tone from colour, emission and opacity) | full material values, updated in place |
| Text, labels, point clouds, meshes, parametric surfaces | left out, with the limitation stated | built |
| Motion | the starting arrangement; the body turns slowly | the full timeline |
| Selection | none (the body is not inspectable) | every selectable object |

The adapter reports `fit` (the share of objects it could form) and `limitations`. The router weighs both. Neither
adapter reproduces the other: the body carries shape and presence, and the card carries exactness and interaction.

## Versioning

`version` is the Scene IR's own version, independent of Aion's. A future version will be accepted alongside version
1 (validated by its own rules) or refused with `unsupported-version`. It is never misread.
