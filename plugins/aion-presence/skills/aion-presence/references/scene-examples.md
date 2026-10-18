# Scene IR — worked examples (Aion v0.5.1)

Each document below is complete and valid (the tests build every one). Use them for their patterns — assemblies,
couplings, surfaces, flows, honesty — not as templates to copy: write what the user asked for.

## A mechanical assembly: a wind turbine

Pattern: groups for assemblies (each blade hangs from its own turned "arm" group, so the blades fan out around the
hub), one `spin` on the rotor group turns everything under it, presets and a shared material.

```json
{
  "version": 1, "sceneId": "wind-turbine", "title": "Wind turbine",
  "intent": { "kind": "engineering", "summary": "A three-blade wind turbine turning", "fidelity": "illustrative", "interaction": "inspect" },
  "units": { "length": "m", "time": "s", "angle": "deg" },
  "disclosure": ["Illustrative: proportions simplified, rotor speed not to scale."],
  "materials": [{ "id": "white", "preset": "plastic", "color": "#e9edf1" }],
  "objects": [
    { "id": "ground", "type": "cylinder", "radius": 6, "height": 0.2, "position": [0, -0.1, 0], "material": { "preset": "matte", "color": "#5c6b52" }, "selectable": false },
    { "id": "tower", "type": "cylinder", "name": "Tower", "radius": 0.35, "radiusTop": 0.2, "height": 12, "position": [0, 6, 0], "material": "white", "label": "Tower" },
    { "id": "nacelle", "type": "box", "name": "Nacelle", "size": [1, 1, 2.6], "position": [0, 12.4, 0.3], "material": "white", "label": "Nacelle",
      "metadata": { "Contains": "gearbox and generator" } },
    { "id": "rotor", "type": "group", "name": "Rotor", "position": [0, 12.4, 1.8] },
    { "id": "hub", "type": "sphere", "name": "Hub", "parent": "rotor", "radius": 0.45, "material": { "preset": "steel" } },
    { "id": "arm-1", "type": "group", "parent": "rotor" },
    { "id": "arm-2", "type": "group", "parent": "rotor", "rotation": [0, 0, 120] },
    { "id": "arm-3", "type": "group", "parent": "rotor", "rotation": [0, 0, 240] },
    { "id": "blade-1", "type": "box", "name": "Blade 1", "parent": "arm-1", "size": [0.5, 6, 0.12], "position": [0, 3.2, 0], "material": "white", "label": "Blades" },
    { "id": "blade-2", "type": "box", "name": "Blade 2", "parent": "arm-2", "size": [0.5, 6, 0.12], "position": [0, 3.2, 0], "material": "white" },
    { "id": "blade-3", "type": "box", "name": "Blade 3", "parent": "arm-3", "size": [0.5, 6, 0.12], "position": [0, 3.2, 0], "material": "white" }
  ],
  "animations": [{ "id": "turn-rotor", "target": "rotor", "type": "spin", "axis": [0, 0, 1], "speed": 60 }],
  "environment": { "style": "presentation" }
}
```

`repeat` would not do here: it copies an object's geometry about the object's own origin (good for a row of fins or
a ring of bolts placed at the centre), while each blade must turn about the hub.

## A mathematical surface whose height pulses

Pattern: a `parametric` surface from the catalog; its amplitude animated by an `oscillate` on `scale` along y.

```json
{
  "version": 1, "sceneId": "sinc-surface", "title": "A pulsing sinc surface",
  "intent": { "kind": "scientific", "summary": "z = sin(r)/r with a pulsing height", "fidelity": "illustrative", "interaction": "view" },
  "objects": [
    { "id": "surface", "type": "parametric", "name": "sin(r)/r", "surface": "sinc", "width": 12, "depth": 12, "amplitude": 2, "frequency": 1.4,
      "resolution": 128, "material": { "preset": "plastic", "color": "#5aa9e6", "roughness": 0.35 } },
    { "id": "caption", "type": "text", "text": "z = sin(r) / r", "textSize": 0.6, "position": [0, 3.2, 0] }
  ],
  "animations": [{ "id": "pulse", "target": "surface", "type": "oscillate", "property": "scale", "axis": [0, 1, 0], "amplitude": 0.6, "period": 4 }],
  "environment": { "style": "scientific", "axes": true }
}
```

## An electrical assembly: an RC low-pass filter on a board

Pattern: a board (`box` with the `pcb` preset), components as simple solids with labels and metadata, traces as
`polyline`s, current as a `points` cloud that `flow`s along a trace, an `emissive` swing for "charging".

```json
{
  "version": 1, "sceneId": "rc-filter", "title": "RC low-pass filter",
  "intent": { "kind": "engineering", "summary": "An RC low-pass filter on a circuit board", "fidelity": "illustrative", "interaction": "inspect" },
  "units": { "length": "cm", "time": "s", "angle": "deg" },
  "disclosure": ["Conceptual: the flowing points show the idea of current, not computed values."],
  "materials": [{ "id": "trace", "preset": "copper", "unlit": true }],
  "objects": [
    { "id": "board", "type": "box", "name": "Circuit board", "size": [10, 0.16, 6], "material": { "preset": "pcb" } },
    { "id": "filter", "type": "group", "name": "Filter" },
    { "id": "r1", "type": "cylinder", "name": "Resistor R1", "parent": "filter", "radius": 0.25, "height": 1.6, "rotation": [0, 0, 90], "position": [-1.5, 0.35, 0],
      "material": { "preset": "ceramic", "color": "#d8c7a4" }, "label": "R1", "metadata": { "Resistance (kΩ)": 10 } },
    { "id": "c1", "type": "cylinder", "name": "Capacitor C1", "parent": "filter", "radius": 0.4, "height": 1, "position": [1.5, 0.6, 0.8],
      "material": { "preset": "plastic", "color": "#3b6fb6" }, "label": "C1", "metadata": { "Capacitance (nF)": 100 } },
    { "id": "trace-in", "type": "polyline", "parent": "filter", "points": [[-4.5, 0.1, 0], [-2.3, 0.1, 0]], "material": "trace", "selectable": false },
    { "id": "trace-mid", "type": "polyline", "parent": "filter", "points": [[-0.7, 0.1, 0], [1.5, 0.1, 0], [1.5, 0.1, 0.8]], "material": "trace", "selectable": false },
    { "id": "current", "type": "points", "parent": "filter", "particles": { "distribution": "path", "path": "trace-in", "count": 60, "pointSize": 4 },
      "material": { "color": "#ffd27a", "emissive": "#ffb84d" } }
  ],
  "animations": [
    { "id": "flow-in", "target": "current", "type": "flow", "path": "trace-in", "rate": 1.2 },
    { "id": "charge", "target": "c1", "type": "oscillate", "property": "emissive", "amplitude": 0.8, "period": 2 }
  ]
}
```

## Something to compute: say so, show nothing else

"Calculate the exact magnetic flux density in this transformer core" needs a field solver Aion does not have. Declare
it and let Aion refuse it; then tell the user what is missing. Only if they want a picture of the idea, send the same
scene with `"fidelity": "illustrative"` — it is drawn and labelled "not computed".

```json
{
  "version": 1, "sceneId": "core-flux", "title": "Transformer core flux density",
  "intent": { "kind": "engineering", "summary": "Accurate flux density in a transformer core", "fidelity": "measured", "interaction": "inspect" },
  "requirements": ["compute:magnetic-flux-density"],
  "objects": [{ "id": "core", "type": "box", "name": "Core", "size": [4, 3, 1], "material": { "preset": "ferrite" } }]
}
```

## An idea, not an object: the body forms it

Abstract and look-only scenes go to the particle body; keep them to a few strong shapes.

```json
{
  "version": 1, "sceneId": "growth", "title": "Growth",
  "intent": { "kind": "abstract", "summary": "The idea of growth", "fidelity": "symbolic", "interaction": "none" },
  "objects": [
    { "id": "seed", "type": "sphere", "radius": 0.4 },
    { "id": "spiral", "type": "helix", "radius": 1.2, "height": 5, "turns": 3, "position": [0, 2.5, 0] },
    { "id": "crown", "type": "torus", "radius": 1.6, "tube": 0.08, "position": [0, 5.2, 0], "rotation": [90, 0, 0] }
  ]
}
```
