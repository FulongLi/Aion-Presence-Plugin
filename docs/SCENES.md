# The 3D Scene Engine

Aion can become a genuine three-dimensional object, not a photograph turned into particles. Codex understands the
request and writes a small scene as data; Aion validates it, builds the geometry, samples it into particles and
morphs into it. The object turns slowly, the user can turn and zoom it, and it returns to the persistent body.

```text
User request ─► Codex ─► scene (JSON data) ─► validator ─► geometry builder (Three.js) ─► particle sampler
             ─► mesh3d target ─► morph from the body ─► turning, draggable 3D object ─► return to the body
```

## The scene

`src/visual/scene3d/types.ts`. y is up, z toward the viewer, angles in degrees, any units: a scene is centred and
scaled to the stage.

```json
{
  "title": "Water molecule",
  "objects": [
    { "type": "sphere", "radius": 0.6 },
    { "type": "sphere", "radius": 0.36, "position": [-0.78, -0.58, 0] },
    { "type": "sphere", "radius": 0.36, "position": [0.78, -0.58, 0] }
  ],
  "rotation": "slow",
  "tilt": 15
}
```

| Primitive | Fields |
| --- | --- |
| `box` | `size` [x, y, z] |
| `sphere` | `radius` (drawn with faint latitude and meridian guides, so it can be seen to turn) |
| `pyramid` | `base` (side width), `height`, `sides` 3–8 (default 4) |
| `cylinder` | `radius`, `height`, `radiusTop` |
| `cone` | `radius`, `height` |
| `torus` | `radius`, `tube` (upright) |
| `ring` | `inner`, `outer` (flat, horizontal: planetary rings) |
| `line` | `from`, `to` |
| `tube` | `points` (2–64), `radius`, `closed` |
| `curve` | `points` (2–64), `closed` (a thin Catmull–Rom curve) |
| `helix` | `radius`, `height`, `turns`, `phase` |

Every object also takes `position`, `rotation`, `scale` (uniform or per axis), `tone` (0.2–1), `weight` (share of
particles), `detail` (`surface`, `edges`, `both`) and `repeat` (`count` 2–64, `offset`, `rotation` and `scale` per
step: ladder rungs, spirals, arrays). Presets (`src/visual/scene3d/presets.ts`, written in the same schema):
`pyramid` (Giza's proportions), `saturn` (planet and two ring bands with the Cassini division, tilted 27°),
`dna` (two helices half a turn apart, 26 base-pair rungs turning with them).

## Safety and bounds

`src/visual/scene3d/validate.ts` checks every scene in the MCP server, again in the hub (whoever sent the command),
and again before geometry is built. It returns a clean copy, never the input object, or the first problem, worded
for the model.

| Limit | Value |
| --- | --- |
| Fields and names | Only the known ones; anything else is rejected, not ignored (`__proto__` included) |
| Objects | 1–24; 256 after repeats |
| Numbers | Finite; coordinates within ±10; sizes 0.005–10; angles within ±720° |
| Points per tube or curve | 64 |
| Triangles (fixed detail per primitive) | 80,000 |
| Payload | 16 KB of JSON |
| Title | 60 characters of plain text |

No code, no URLs, no fetched assets. Geometry detail is fixed by the builder, never by the scene.

## Sampling and rendering

- `geometry.ts`: Three.js primitives (`BoxGeometry`, `SphereGeometry`, `ConeGeometry`, `TorusGeometry`,
  `RingGeometry`, `TubeGeometry`, `CatmullRomCurve3`, `EdgesGeometry` at 25°) with each object's transform and
  repeats, to world-space triangles and segments.
- `sample.ts`: surfaces by area (uniform barycentric points), edges, rims and lines by length as fine strokes, a
  little brighter, so the structure reads first. Objects share particles by √area plus length and their weight. The
  scene is centred and scaled to a radius of 1.75. One stable sequence, so every quality tier is a prefix.
- Renderer: `formedTarget()` (shared by compute and material) turns the formed target by yaw, then pitch, then zoom.
  While a 3D object is formed, tone follows depth (nearer is brighter) and the formed-visual ripple is reduced.
  The canvas fallback evaluates the same transform (`formedPoint`) at its lower density: an honest, reduced view.
- Interaction (`src/render/interaction/orbit.ts`): a slow turn (0.28 rad/s) that pauses for three seconds after the
  user touches it; drag to turn and tilt (with a little momentum); wheel or pinch to zoom (0.6–1.8×); double-click
  to reset. `set_scene_view` eases to a new view (rotate left, right, up, down by `degrees`, zoom in or out, stop or
  resume the turn, reset).

## Routing

3D objects are BODY. They have no card form, so a requested card falls back to the body (`no-card-form`). Every
v0.3 route is unchanged.

## Proof

- Real renderer: `npm run showcase -- pyramid saturn dna` (forming, turning, a real mouse drag and wheel zoom,
  `set_scene_view`, the return).
- Tests: schema limits and rejections, every primitive within the stage and centred, the pyramid's particles on its
  surfaces with brighter edges, prefix stability, the mesh3d pipeline re-validating, orbit interaction, routing,
  store and hub, and the MCP tools.
- Smoke: the pyramid forms, turns, is dragged, takes a view command and returns, in WebGPU and in the canvas
  fallback.
