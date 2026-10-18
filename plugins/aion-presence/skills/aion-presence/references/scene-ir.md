# Scene IR — writing a generated scene (Aion v0.5.1)

A generated scene is **data you write**: a Scene IR document passed to `show_interactive_card` with
`app: "generative-scene"` and `scene: {…}`. Aion validates it, decides how to show it (the particle body, an interactive
card, or both), builds it, and reports what it built. Nothing in it is code: no JavaScript, HTML, shaders or URLs.
Worked examples: [scene-examples.md](scene-examples.md).

## Plan it in one pass (briefly, in your head)

1. **Objects** — list what the user named, plus what makes it read (a base, an axle, a path). Few, recognisable shapes
   beat many small ones.
2. **Hierarchy** — one `group` per assembly ("bridge-1", "transformer"), parts with `parent`; transforms are relative
   to the parent, so an assembly moves as one. Ids are stable, lowercase, meaningful (`"gear-small"`, `"q1"`).
3. **Primitives** — the closest type from the table below (a coil is a `helix` with `tube`, a disc is a short
   `cylinder`, a wire is a `polyline`, many copies are one object with `repeat`).
4. **Size and place** — pick one unit, keep the whole scene within about ±10 of it, y up; things that touch must touch
   (a gear's `radius` plus its neighbour's equals their distance).
5. **Materials** — a `preset` (metal, copper, plastic, glass, emissive …) and a colour; share a material by id when
   several objects look the same.
6. **Motion** — only what was asked for or explains the idea; gear trains with `couple`, things on paths with
   `path`, current with `points` + `flow`, a glow with `oscillate` on `emissive`.
7. **Camera and style** — usually leave `camera` out (Aion frames everything); set `environment.style` only when the
   user asked for a look.
8. **Honesty** — `intent` (what was asked), `disclosure` for scale and "illustrative", `requirements` for anything that
   needs computing. Then write the document once.

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
id, or `{ preset, color, opacity, emissive, emissiveIntensity, metalness, roughness, wireframe, unlit, dashed }`), `visible`,
`selectable` (default true; false for lines, labels and point clouds), `label` (short text beside it), `annotation`
(a note shown when selected), `metadata` (up to 16 facts: `{ "Radius (km)": 6371 }`), `repeat`
(`{ count, offset?, rotation?, scale? }` copies of its own geometry). Colours are `#rrggbb` or names (`"blue"`).

## Materials and styles (v0.5.1)

- **`preset`**: `metal`, `steel`, `aluminium`, `copper`, `gold`, `brass`, `plastic`, `rubber`, `glass`, `matte`,
  `ceramic`, `emissive`, `pcb`, `ferrite` — plausible metalness, roughness, colour and opacity. Fields you give win:
  `{ "preset": "metal", "color": "silver" }`. Use `unlit: true` only for lines, labels and glowing bodies.
- **`environment.style`**: `scientific` (dark, no ground: space, fields), `engineering` (studio light, soft shadows,
  ground grid: machines, circuits), `minimal` (light backdrop, soft shadows), `presentation` (studio, stronger
  rim light), `cinematic` (dark, dramatic). Left out, the intent picks one (engineering → engineering, scientific →
  scientific, abstract → cinematic, otherwise presentation). `shadows`, `ground`, `grid`, `background`, `ambient`
  override it. A style changes lighting only, never the objects.

## Animations

| type | fields | what it does |
| --- | --- | --- |
| `spin` | `speed` (deg/s), `axis?` | turns about its own axis (default y) |
| `orbit` | `period`, `center?` (an object sharing the parent, or [x,y,z]), `radius?`, `phase?`, `eccentricity?`, `inclination?`, `axis?`, `clockwise?` | circles a centre; a moving centre carries it (Moon around Earth). Give `radius` (otherwise it is the current distance to the centre, which changes if the centre is moved) |
| `oscillate` | `property` (position, rotation, scale, opacity, emissive), `amplitude`, `period`, `phase?`, `axis?`, `wave?` (sine, square, triangle, saw) | phase relationships: 0, 120, 240; `scale` with an `axis` swings that direction only (a surface's amplitude: `[0, 1, 0]`) |
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

## Common mistakes (each is refused, with a hint)

| Wrong | Right |
| --- | --- |
| `"color": "red"` on an object | `"material": { "color": "red" }` |
| `"type": "cube"` / `"cylinder"` without `height` | `"type": "box", "size": [1, 1, 1]` / `"radius": 0.5, "height": 2` |
| `"children": [...]` | a flat list; each child has `"parent": "<id>"` |
| `"rotation": [1.57, 0, 0]` (radians) | `"rotation": [90, 0, 0]` (degrees) — accepted, but warned |
| `{ "type": "rotate" }` animation | `{ "type": "spin", "speed": 45 }` (degrees per second) |
| an animation inside an object | in the document's `animations`, with `target` |
| `orbit`/`lookAt`/`path` naming an object under another parent | give both the same `parent` (or use a point) |
| `"id": "Gear A"` | `"id": "gear-a"` |
| a plane rotated 90° to lie flat | planes, rings, circles and surfaces are already flat in x–z |

**When a call is refused** the result lists every problem found (up to 8), each with `→` how to fix it, and
"Attempt n of 3". Fix exactly those, keep everything else, and call again with the whole corrected document (or
patch). After the third refusal, stop: tell the user in one sentence what could not be built and offer something
simpler — never substitute an unrelated scene. A result may also say `Check:` — the scene was built, but something
looks unintended (radians, a tiny spin speed, a scale too wide to see); correct it with a patch if so.

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
`revision` is refused (`stale-revision`): inspect, then patch again. **The user edits too**: in the card they can move,
rotate and resize the selected object by hand and undo or redo; each of their changes is a revision labelled
"(by hand)" in the history. So always patch from the revision the latest result or inspection reported. Viewing and playback are commands, not edits:
`select` / `focus` (an id), `clear-selection`, `reset-camera`, `set-view` (iso, top, front, side), `set-speed`, `seek`
(seconds), `show-labels`, and the universal `pause`, `resume`, `reset`, `close`.

## Words that mean an edit

- "Make Earth three times larger" → `transform` `earth` `scaleBy: 3`.
- "Stop Mars" → `update-animation` on Mars's orbit (and spin) `paused: true`; "Resume" → `paused: false`.
- "Change the orbit colour to blue" → `material` `orbit` (when orbits share it) or `update` each orbit.
- "Make this twice as large" (after a click) → `transform` `$selected` `scaleBy: 2`.
- "Add the major geological periods" → `add` the new objects (a group and its children) to the open scene.
- "Undo that" / "Restore the previous state" → `undo`. "Start over" → `revert`.
- "Change these objects to silver" → one `update` per object (`set: { "material": { "preset": "metal", "color": "silver" } }`),
  or one `material` op when they share a material.
- "Move the selected component to the left" → `transform` `$selected` `translate: [-1, 0, 0]` (scaled to the scene).
- "Pause the second gear" → `update-animation` on that gear's spin (or couple) `paused: true` — inspect for its id.
- "Add another gear" → `add` it (meshing: its distance from the neighbour is the sum of the radii) and
  `add-animation` a `couple` to the neighbour's spin with `ratio` = −(neighbour teeth ÷ its teeth).
- "Increase the rotation speed" → `update-animation` the driving `spin` (`speed`); coupled parts follow.
- "Pause" / "Play" → `pause` / `resume` (the whole timeline).
