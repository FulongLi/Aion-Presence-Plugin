# The Earth–Moon card (`earth-moon`, v0.4.5)

An interactive 3D Earth and Moon, built for one teaching question above all: **why does the same side of the Moon
always face Earth?** Codex explains; the card shows it; Aion stays present beside it.

![Synchronous rotation, then a Moon that does not rotate](media/v0.4.5/05-earth-moon-orbit-synchronous-rotation.gif)

## What it shows

- **Earth** turning once per sidereal day under its **rotation axis**, tilted 23.44° (with a north marker), lit by the
  Sun: a day side, a night side, ocean glints, clouds, a thin atmosphere.
- **The Moon** on its orbit, inclined 5.145° to the ecliptic, turning once per orbit, with its major maria at their
  real selenographic positions (the near side faces Earth).
- **The orbit** line, the **orbital plane** (a translucent disc), **labels**, the direction sunlight comes from.
- **Teaching marks**: a marker on the near side that turns with the Moon and keeps pointing at Earth, a dashed line to
  the same distant stars all month, and a caption. **No spin** shows the hypothetical Moon that does not rotate: its
  marker keeps pointing at the stars and turns away from Earth.

## The model (`src/cards/apps/earthMoon/model.ts`)

| Value | Used |
| --- | --- |
| Earth diameter | ≈ 12,742 km |
| Moon diameter | ≈ 3,474.8 km (0.2727 Earth radii) |
| Mean Earth–Moon distance | ≈ 384,400 km (60.34 Earth radii) |
| Sidereal month | ≈ 27.3217 days |
| Sidereal day | ≈ 23.9345 h |
| Earth's axial tilt | 23.44° |
| Lunar orbit inclination | 5.145° |
| Sidereal year (sunlight direction) | ≈ 365.256 days |

Simplifications, said plainly: a **circular** orbit at the mean distance (the real one has e ≈ 0.055), a fixed line of
nodes (they precess every 18.6 years), no precession of Earth's axis, no libration, the Moon's spin axis taken as its
orbit's normal (its own 1.54° tilt ignored). It is a teaching model, **not an ephemeris**: never use it for real
dates or positions.

**Simulation time is separate from display scale.** Time runs at `speed` days per second (0.01–100; default 1). Scale:
`educational` (default) compresses the distance to 12 Earth radii so both bodies are visible, sizes in true proportion
— the card says *Not to scale · distance shown 5× shorter*; `true-distance` uses 60.34 Earth radii.

The tests check that the near side faces Earth at every moment with rotation, and turns away without it; one orbit per
sidereal month; one turn per sidereal day; a circular orbit in its inclined plane.

## Textures

Procedural, nothing to license: Earth is coloured from a land mask rasterized from Natural Earth 1:50m (public domain;
`npm run cards:earth-mask` writes `landMask.ts`, 28 KB) with approximate climate zones, ice and clouds; the Moon from
its maria and four rayed craters (Tycho, Copernicus, Kepler, Aristarchus) at their real positions plus seeded craters,
with a bump map. Generation takes about 0.7 s when the card starts (reported as loading progress).

## Interaction

Drag to turn, scroll or pinch (macOS trackpads included) to zoom, right-drag or Shift-drag to pan, arrow keys
when the view is focused. Click Earth or the Moon to select it: a ring marks it and its facts appear. Controls in the
card: slower / faster, back to day 0, focus (System, Earth, Moon), Orbit, Labels, Plane, Axis, Teach, No spin, and the
scale switch. Pause, reset, size, fullscreen and close are the universal controls.

## Commands (`control_interactive_card`)

| Command | Value |
| --- | --- |
| `set-time-speed` | days per second, 0.01–100 |
| `set-time` | a day, 0–3650 |
| `reset-time` | — |
| `focus` | `system`, `earth`, `moon` (the camera follows a focused Moon) |
| `set-view` | `overview`, `top`, `edge` (the orbital plane edge-on), `from-earth` |
| `reset-camera` | — |
| `select` | `earth`, `moon`, `none` |
| `show-orbit`, `show-labels`, `show-orbital-plane`, `show-axis`, `show-teaching`, `compare-no-rotation` | true / false |
| `set-scale` | `educational`, `true-distance` |

Plus the universal `pause`, `resume`, `reset`, `expand`, `collapse`, `fullscreen`, `close`. Settings at launch:
`speed`, `focus`, `view`, `scale`, `teaching`, `labels`, `paused`.

## State (`inspect_interactive_card`)

`running`, `speed`, `day`, `orbitDegrees`, `moonRotationDegrees`, `earthRotationDegrees`, `focus`, `view`, `selected`,
`orbit`, `labels`, `orbitalPlane`, `axis`, `teaching`, `noRotation`, `scale`, `nearSideFacingEarth`; the selection
carries the body's name, kind and properties.

## The teaching flow

"Why does the Moon always show the same face to Earth?" → `show_interactive_card { app: "earth-moon", settings:
{ teaching: true } }` (the orbit runs, the marker keeps pointing at Earth) → the user pauses or turns the view →
Codex explains that one rotation takes exactly one orbit (tidal locking) → `compare-no-rotation true` shows the
alternative → close when done. A **hybrid** (`presentation: "hybrid"`) also forms Earth, Moon and orbit in particles
for a moment.
