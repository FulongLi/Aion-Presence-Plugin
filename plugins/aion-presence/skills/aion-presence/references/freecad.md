# FreeCAD reference (`cad_model`)

`cad_model { action, args?, document?, revision? }` runs one operation in the user's FreeCAD (1.0 or newer), which owns
the parametric model. Lengths are **millimetres**, angles **degrees**, coordinates FreeCAD's (X length, Y width, Z up).
Every change is a FreeCAD transaction: recomputed, checked, and refused (nothing changed) if the model would be invalid.
Each result reports the document id, `revision`, the visible solids (size, volume, validity), the result of the action,
the viewer's selection and timings. `document` is only needed when several documents are open; `revision` refuses a
change made against an older revision (`stale-revision`).

Ids: every component is a FreeCAD object with a stable id (its name, e.g. `Enclosure`, `Hole2`, `Fillet1`) and a label.
A visible solid made by features (holes, a pocket, a fillet) is a result object with the body's label (`Enclosure`):
naming the body or the result both work; parameters are on the body. `"$selected"` in `component`, `target`, `base`,
`tool` or `sketch` is the component selected in the CAD viewer.

## Actions

| action | args | notes |
| --- | --- | --- |
| `status` | — | FreeCAD's version and the open documents |
| `create_document` | `name?` | a new, empty, unsaved document |
| `open_document` | `path` (absolute `.FCStd`) | |
| `inspect` | — | every component with its parameters, the history, undo/redo |
| `add_primitive` | `kind` box (`length`, `width`, `height`) · cylinder (`radius` or `diameter`, `height`) · sphere (`radius` or `diameter`) · cone (`radius1`, `radius2`, `height`); `name?`, `at?` [x, y, z] (the minimum corner of a box; a cylinder's base centre), `rotate?` {`axis`, `angle`}, `color?` #rrggbb | |
| `add_holes` | `target`, `diameter`, `depth?` (0 or absent: through), `face?` top · bottom · front · back · left · right (default top), and **either** `corners` (inset in mm from the edges: four holes) **or** `positions` [[u, v], …] (mm from the face's minimum corner; u, v = x, y on top/bottom, x, z on front/back, y, z on left/right) | holes on a box follow its size (FreeCAD expressions); each hole has `Inset X`, `Inset Y` from its anchor edges |
| `add_sketch` | `profiles` [{`rectangle`: {`x`, `y`, `width`, `height`}} or {`circle`: {`x`, `y`, `diameter`}}], `plane?` XY · XZ · YZ, `offset?` (along the plane's normal), `name?` | a constrained Sketcher sketch; named constraints `Width`, `Height`, `Diameter`, `X`, `Y` (prefixed `1 `, `2 ` … with several profiles) |
| `pad` | `sketch`, `length`, `reversed?`, `name?` | extrudes the sketch into a solid |
| `pocket` | `sketch`, `target`, `depth` or `through: true`, `reversed?` (default true: into the material below the sketch) | cuts the extruded sketch from the target |
| `set_constraint` | `sketch`, `constraint` (its name), `value` | |
| `boolean` | `operation` union · subtract · intersect, `base`, `tool`, `name?` | |
| `fillet` | `target`, `radius`, `edges?` all · vertical · top · bottom (default vertical) | the edge rule is kept: it follows later changes |
| `chamfer` | `target`, `size`, `edges?` | |
| `set_parameter` | `component`, `parameter`, `value` **or** `delta` | box `Length` `Width` `Height`; cylinder `Radius` `Diameter` `Height`; hole `Diameter` `Depth` `Inset X` `Inset Y` and `Inset` (both at once: "move it 5 mm inward" → `Inset` `delta: 5`, one change); fillet `Radius`; chamfer `Size`; pad `Length`; sketch constraints by name; `X` `Y` `Z` position |
| `transform` | `component`, `move?` [dx, dy, dz], `to?` [x, y, z], `rotate?` {`axis`, `angle`} | holes move with `set_parameter` insets instead |
| `set_visibility` | `component`, `visible` | |
| `set_appearance` | `component`, `color?`, `material?` (a name, kept as metadata) | |
| `delete` | `component` | a hole, fillet, chamfer, pocket or boolean is unwrapped; a body still used is refused |
| `undo` / `redo` | — | FreeCAD's own transactions; each is a new revision |
| `save` | `path?` (absolute `.FCStd`; required the first time), `overwrite?` | never overwrites another file unless `overwrite: true` (only when the user said so) |
| `export` | `format` step · stl, `path`, `overwrite?` | |
| `open_in_freecad` | — | saves, opens the file in the FreeCAD application, and keeps Aion read-only until `reload` |
| `reload` | — | rereads the saved file (after the user changed it in FreeCAD) |
| `close` | `discard?` | refused with unsaved changes unless `discard: true` |

## Example

"Create a rectangular enclosure, 120 by 80 by 40 mm" → `create_document {name: "Enclosure"}`, then `add_primitive
{kind: "box", length: 120, width: 80, height: 40, name: "Enclosure"}`. "Make it 20 mm longer" → `set_parameter
{component: "Enclosure", parameter: "Length", delta: 20}`. "Add four 6 mm mounting holes near the corners" → `add_holes
{target: "Enclosure", diameter: 6, corners: 8}`. The user clicks a hole: "Move this hole 5 mm inward" → `set_parameter
{component: "$selected", parameter: "Inset", delta: 5}` (both insets, one change, one undo). "Round the vertical edges" →
`fillet {target: "Enclosure", radius: 4}`. "Undo that" → `undo`. "Save it" → `save {path: "/Users/…/Enclosure.FCStd"}`.
