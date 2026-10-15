# Scene IR — writing a generated scene (Aion v0.5)

A generated scene is **data you write**: a Scene IR document passed to `show_interactive_card` with
`app: "generative-scene"` and `scene: {…}`. Aion validates it, decides how to show it (the particle body, an interactive
card, or both), builds it, and reports what it built. Nothing in it is code: no JavaScript, HTML, shaders or URLs.

## The document

```json
{
  "version": 1,
  "sceneId": "solar-system",
  "title": "The Solar System",
  "intent": { "kind": "scientific", "summary": "A 3D solar system", "fidelity": "illustrative", "interaction": "view" },
  "units": { "length": "unit", "time": "s", "angle": "deg" },
  "disclosure": ["Not to scale: sizes and distances are compressed so every planet is visible."],
  "materials": [{ "id": "orbit", "color": "#7f8a99", "opacity": 0.45, "unlit": true }],
  "objects": [
    { "id": "sun", "type": "sphere", "name": "Sun", "radius": 1.4, "label": "Sun",
      "material": { "color": "#ffcc66", "emissive": "#ffaa33", "emissiveIntensity": 1.6, "unlit": true },
      "metadata": { "Radius (km)": 696340 } },
    { "id": "orbit-earth", "type": "circle", "radius": 5.6, "material": "orbit", "selectable": false },
    { "id": "earth", "type": "sphere", "name": "Earth", "radius": 0.34, "position": [5.6, 0, 0], "label": "Earth",
      "material": { "color": "#3b82f6" }, "metadata": { "Orbital period (days)": 365.26 } }
  ],
  "animations": [
    { "id": "orbit-earth", "target": "earth", "type": "orbit", "center": "sun", "radius": 5.6, "period": 8 },
    { "id": "spin-earth", "target": "earth", "type": "spin", "speed": 90 }
  ],
  "camera": { "position": [0, 14, 26], "target": [0, 0, 0] },
  "environment": { "background": "#04060a", "stars": true, "lightSource": "sun" }
}
```

Required: `version` (1), `sceneId`, `title`, `objects`. Everything else is optional.

- **Conventions**: right-handed, **y up**; positions in `units.length` (default `unit`); rotations are Euler degrees
  `[x, y, z]` applied X then Y then Z; times in seconds. A node's transform is relative to its `parent`.
- **Ids**: lowercase letters, digits, `-`, `_`, `.` (`"earth"`, `"coil-a"`). They are stable: patches, selection and
  animations name objects by id. Animation ids are separate from object ids.
- **intent** (for the router): `kind` abstract | concrete | structural | scientific | engineering; `fidelity` symbolic |
  illustrative | approximate | measured; `interaction` none | view | inspect | edit. Say what the user asked for,
  honestly: an abstract idea is `abstract`/`symbolic`; something to inspect is `inspect`.
- **disclosure**: up to 6 short notes the user must see (scale, "illustrative", sources). Always shown on the card.
  Say them in your answer too.
- **requirements**: capabilities beyond the content, e.g. `"compute:magnetic-field"`, `"compute:circuit-simulation"`,
  `"physics:rigid-body"`. Aion has **no numerical solver**: with `fidelity: "measured"` such a scene is refused
  (UNSUPPORTED — say so plainly); with `fidelity: "illustrative"` it is drawn and labelled "not computed".

## Objects (`type` and its fields)

| type | fields | notes |
| --- | --- | --- |
| `group` | — | a parent for others (assemblies) |
| `sphere` | `radius` | |
| `box` | `size` [x,y,z] | |
| `cylinder` | `radius`, `height`, `radiusTop?` | axis along y |
| `cone` | `radius`, `height` | apex up |
| `torus` | `radius`, `tube`, `arc?` (deg) | in the x–y plane (upright) |
| `plane` | `width`, `depth` | flat in x–z |
| `ring` | `inner`, `outer` | flat in x–z |
| `circle` | `radius` | a line loop in x–z (orbits) |
| `line` | `from`, `to` | |
| `polyline` | `points` (2–256), `closed?` | straight segments |
| `curve` | `points`, `closed?` | smooth through the points |
| `tube` | `points`, `radius`, `closed?` | |
| `helix` | `radius`, `height`, `turns`, `tube?` | about y; `tube` > 0 makes it solid (a coil) |
| `arrow` | `from`, `to`, `radius?` | vectors, fields |
| `gear` | `radius`, `teeth` (6–120), `thickness`, `inner?` | flat in x–z, turns about y |
| `points` | `particles: { distribution, count, … }` | sphere, shell, box, disc, ring, line, path, grid, spiral |
| `text` | `text`, `textSize?` | a label that faces the camera |
| `parametric` | `surface`, `width`, `depth`, `amplitude?`, `frequency?`, `resolution?` | wave, ripple, saddle, paraboloid, sinc, gaussian |
| `mesh` | `positions` (x,y,z…), `indices?` | small explicit meshes |

Every object may have: `name`, `parent`, `position`, `rotation`, `scale` (number or [x,y,z]), `material` (a material
id, or `{ color, opacity, emissive, emissiveIntensity, metalness, roughness, wireframe, unlit, dashed }`), `visible`,
`selectable` (default true; false for lines, labels and point clouds), `label` (short text beside it), `annotation`
(a note shown when selected), `metadata` (up to 16 facts: `{ "Radius (km)": 6371 }`), `repeat`
(`{ count, offset?, rotation?, scale? }` copies of its own geometry). Colours are `#rrggbb` or names (`"blue"`).

## Animations

| type | fields | what it does |
| --- | --- | --- |
| `spin` | `speed` (deg/s), `axis?` | turns about its own axis (default y) |
| `orbit` | `period`, `center?` (an object sharing the parent, or [x,y,z]), `radius?`, `phase?`, `eccentricity?`, `inclination?`, `axis?`, `clockwise?` | circles a centre; a moving centre carries it (Moon around Earth). Give `radius` (otherwise it is the current distance to the centre, which changes if the centre is moved) |
| `oscillate` | `property` (position, rotation, scale, opacity, emissive), `amplitude`, `period`, `phase?`, `axis?`, `wave?` (sine, square, triangle, saw) | phase relationships: 0, 120, 240 |
| `keyframes` | `property` (position, rotation, scale, color, opacity, emissive, visible), `keys: [{ t, value }]`, `easing?` | |
| `path` | `path` (a line/polyline/curve/tube/circle/helix sharing the parent), `duration`, `orient?`, `easing?` | follows the drawn path exactly |
| `flow` | `path`, `rate` (units/s) | a `points` object's particles stream along a path (current, energy) |
| `track` | `lookAt` (an object sharing the parent) | keeps facing it |
| `couple` | `source` (a spin), `ratio` | gear trains: `-2` turns the other way twice as fast |

Common: `start` (s), `repeat` (a number or `"loop"`; periodic motion loops by default, keyframes and paths play once),
`yoyo`, `timeScale`, `paused` (stopped where it is, the rest keeps moving). Motion is illustrative — never present it
as a physical simulation.

## Limits (exceeding one is refused with `resource-limit`; nothing is truncated)

48 KB per document · 256 objects · 2,000 after repeats · 600,000 triangles · 60,000 particles · 128 animations ·
64 keyframes · 256 points per path.

## Changing a scene: patches

`control_interactive_card` `{ "action": "patch", "patch": [ …operations ], "revision": <the revision you saw> }`.
A patch is all-or-nothing; on success the result says it is **rendered** (the card confirmed it), with the new
revision. `"$selected"` in place of an id is the object the user selected in the card.

| op | fields | example |
| --- | --- | --- |
| `add` | `object` or `objects` | `{ "op": "add", "object": { "id": "moon", "type": "sphere", "radius": 0.1, "position": [6.2, 0, 0] } }` |
| `update` | `id`, `set`, `unset?` | `{ "op": "update", "id": "earth", "set": { "material": { "color": "blue" } } }` |
| `transform` | `id`, `position` / `rotation` / `scale`, or `translate` / `rotateBy` / `scaleBy` | `{ "op": "transform", "id": "$selected", "translate": [-2, 0, 0], "scaleBy": 2 }` |
| `remove` | `id` | removes its children and the animations that need it |
| `reparent` | `id`, `parent` (id or null) | |
| `material` | `id`, `set` | a shared material: `{ "op": "material", "id": "orbit", "set": { "color": "blue" } }` |
| `add-animation` | `animation` | `{ "op": "add-animation", "animation": { "id": "orbit-moon", "target": "moon", "type": "orbit", "center": "earth", "period": 2 } }` |
| `update-animation` | `id`, `set` | "Stop Mars": `{ "op": "update-animation", "id": "orbit-mars", "set": { "paused": true } }` |
| `remove-animation` | `id` | |
| `camera`, `environment`, `timeline`, `presentation` | `set` | |
| `meta` | `title?`, `disclosure?`, `intent?`, `requirements?` | |

Other actions: `undo`, `redo`, `revert` (back to the scene as created) — each is a new revision. A patch from an old
`revision` is refused (`stale-revision`): inspect, then patch again. Viewing and playback are commands, not edits:
`select` / `focus` (an id), `clear-selection`, `reset-camera`, `set-view` (iso, top, front, side), `set-speed`, `seek`
(seconds), `show-labels`, and the universal `pause`, `resume`, `reset`, `close`.

## Words that mean an edit

- "Make Earth three times larger" → `transform` `earth` `scaleBy: 3`.
- "Stop Mars" → `update-animation` on Mars's orbit (and spin) `paused: true`; "Resume" → `paused: false`.
- "Change the orbit colour to blue" → `material` `orbit` (when orbits share it) or `update` each orbit.
- "Make this twice as large" (after a click) → `transform` `$selected` `scaleBy: 2`.
- "Add the major geological periods" → `add` the new objects (a group and its children) to the open scene.
- "Undo that" → `undo`. "Start over" → `revert`.
- "Pause" / "Play" → `pause` / `resume` (the whole timeline).
