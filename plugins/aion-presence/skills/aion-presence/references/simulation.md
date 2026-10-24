# Simulation reference (`simulate`)

`simulate { action, args?, study? }` runs one step of a finite-element study on the user's FreeCAD geometry: Gmsh
meshes it, Elmer FEM solves it (both installed on the user's machine), and the Simulation Card shows the setup or the
computed fields. `study` is only needed with several studies (default: the one used last, or the one the card shows).
Every result says what was done and what was not; a refusal (`invalid-arguments`, `unresolved-faces`, `conflict`,
`not-ready`, `unknown-material`, `no-selection`…) changed nothing.

**Units**: give them as text — `"10 V"`, `"100 A"`, `"25 °C"`, `"10 W/(m2*K)"`, `"5 W"`, `"2e5 W/m3"`, `"5.8e7 S/m"`,
`"1.72 uohm*cm"`. A bare number is SI (V, A, K, W…) — so temperatures without a unit are **kelvin**; lengths (mesh
sizes, points) are **millimetres**. Coordinates are FreeCAD's (Z up).

**Faces** (`faces`): `"left"` · `"right"` · `"front"` · `"back"` · `"bottom"` · `"top"` (the outermost flat faces on that
side, −X +X −Y +Y −Z +Z; scope it with `{side: "left", body: "Busbar"}`), `{facing: "top"}` (every flat face facing up,
not only the outermost), `"feature:Hole1"` (the faces a CAD feature made), `"remaining"` (every exterior face that has
no other condition of the same kind — for convection), `"exterior"` (the same), face numbers `[3, 7]` from `inspect`,
`{at: [x, y, z]}` (the face nearest a point, mm), or `"$selected"` (the face the user clicked in the Simulation Card).
Faces picked by number or point are checked against the geometry after a CAD change (stale picks are reported, not
moved); sides and features are found again on the new geometry.

## Actions

| action | args | notes |
| --- | --- | --- |
| `status` | — | Gmsh and Elmer found (versions), what is supported, the studies |
| `create` | `analysis` electric · thermal · electrothermal, `name?`, `document?` (CAD document id; default the one shown / used last), `bodies?` [ids or labels] (default every visible solid) | exports the geometry; the result lists bodies, solids and faces (number, body, feature, facing side, area, centre) |
| `list` · `open` · `inspect` | `inspect`: `faces?: true` for every face | the setup, its validation and the faces; `open` shows the setup in the card |
| `set_physics` | `analysis?`, `reference_temperature?`, `linear?` iterative · direct, `tolerance?`, `timeout_s?` | |
| `set_material` | `bodies` (id, label, list or `"all"`), and `material` (library: copper, aluminium-1350, aluminium (6061), aluminium-6063, brass, silver, gold, nickel, tin, steel, stainless, solder, fr4, alumina, thermal-pad) and/or `conductivity` / `resistivity`, `thermal_conductivity`, `density`, `name?`, `insulator?: true` | properties override the library's; insulators (no conductivity) conduct heat only |
| `set_boundary` | `faces`, `type`, its value, `name?`, `replace?` (a boundary id) | types: `voltage` (`voltage`), `ground`, `current` (`current`: total into the conductor at an equipotential terminal; one current terminal + ground), `insulated`, `temperature` (`temperature`), `convection` (`h`, `ambient`), `heat_flux` (`flux`, into the body), `heat_flow` (`power`, W into the body spread over the faces), `adiabatic` |
| `set_source` | `bodies`, `power_density` (W/m³) or `power` (W, spread uniformly) | a volumetric heat source (thermal studies; Joule heat is automatic in electrothermal) |
| `remove` | `id` (M1, B2, Q1, R1…) | |
| `set_mesh` | `size?` coarse · normal · fine · very_fine, `max_mm?`, `min_mm?`, `curvature?` (elements per circle), `order?` 1 · 2, `refine?` {`faces` or `bodies`, `size_mm`}, `clear_refinement?`, `auto?` | sizes are meshing settings, not accuracy guarantees; the result gives the estimate |
| `mesh` | — | meshes now and reports nodes, elements, quality (optional: `run` meshes when needed) |
| `validate` | — | errors (blocking), warnings, defaults |
| `run` | `wait_s?` (default 40) | meshes if needed, solves, shows the result; a long run continues in the background |
| `results` | `run?`, `probe?` [x, y, z] mm | the numbers of a run; a probe interpolates every field inside the containing element |
| `show` | `run?`, `field?`, `setup?: true` | shows a result (or the setup) in the card |
| `sync` | — | re-reads the CAD geometry now and reports what changed for each boundary |
| `compare` | `runs?` [a, b] (default the last two) | key numbers side by side with % change, and what differed (geometry, mesh, setup) |

In the open card (`control_interactive_card`): `set-field` potential · electric_field · current_density · joule_heating ·
temperature · heat_flux, `set-colormap`, `set-range` ("auto" or "min,max" in the legend's unit), `bands`, `show-mesh`,
`show-vectors`, `section` ("x 12.5", "off"), `probe` ("max", "min" or "x,y,z"), `select` (F12). `inspect_interactive_card`
reports the field, range, section, probe and the selected face.

## What a result contains

Electric: each terminal's potential and current (Elmer's reaction currents), the resistance ΔV/I for two-terminal
problems (and Elmer's ΔV²/P), the Joule loss (Elmer's integral and Aion's σ|∇φ|² check), current conservation. Thermal:
minimum and maximum temperature with locations, the heat leaving through each boundary, the heat balance. Fields: min
and max (nodal) with locations. Plus the mesh (nodes, elements, quality), Elmer's version, linear iterations and time,
notes (mesh-dependent peaks, poor elements), and the VTU file (ParaView). Answer from these numbers only.

## Example

"Create a copper busbar 100 × 10 × 5 mm, apply 1 mV across its ends and show the current density" →
`cad_model add_primitive {kind: "box", length: 100, width: 10, height: 5, name: "Busbar"}` (after `create_document`),
`simulate create {analysis: "electric"}`, `set_material {bodies: "Busbar", material: "copper"}`, `set_boundary {faces:
"left", type: "voltage", voltage: "1 mV", name: "Terminal +"}`, `set_boundary {faces: "right", type: "ground"}`, `run`,
then `show {field: "current_density"}`. "Use the losses to calculate the temperature with natural convection at 25 °C,
ends held at 40 °C" → `set_physics {analysis: "electrothermal"}`, `set_boundary {faces: "left", type: "temperature",
temperature: "40 °C"}` (and right), `set_boundary {faces: "remaining", type: "convection", h: "10 W/(m2*K)", ambient: "25 °C"}`,
`run`, `show {field: "temperature"}`. "Make it 8 mm thick and run again" → `cad_model set_parameter {component:
"Busbar", parameter: "Height", value: 8}`, `simulate run` (the sides are found again on the new geometry), `compare`.
