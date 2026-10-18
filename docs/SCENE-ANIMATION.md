# Scene animation (v0.5, v0.5.1)

Generated scenes move through a declarative animation engine (`src/scene/animation.ts`). Animations are data in the
Scene IR, not code, and are evaluated by a pure function of time. The same engine runs in the card every frame and in
the unit tests without a browser.

## Animation types

| type | drives | key fields |
| --- | --- | --- |
| `spin` | orientation: turns about the node's own axis | `speed` °/s, `axis` |
| `orbit` | position: circles a centre (a node sharing the parent, or a point) on a circle or an ellipse | `period`, `center`, `radius`, `phase`, `eccentricity`, `inclination`, `axis`, `clockwise` |
| `oscillate` | adds a waveform to position, rotation, scale, opacity or emission; v0.5.1: `scale` with an `axis` swings that direction only (a surface's amplitude: `[0, 1, 0]`) | `property`, `amplitude`, `period`, `phase`, `wave` (sine, square, triangle, saw), `axis` |
| `keyframes` | sets position, rotation, scale, colour, opacity, emission or visibility from keys | `keys [{t, value}]`, `easing` (linear, ease-in, ease-out, ease-in-out, step) |
| `path` | position (and optionally orientation) along a path-like node | `path`, `duration`, `orient`, `easing` |
| `flow` | a point cloud's particles stream along a path | `path`, `rate` units/s |
| `track` | orientation: keeps facing another node | `lookAt` |
| `couple` | orientation: driven by another spin with a ratio (gear trains) | `source`, `ratio` |

Common fields: `start` (s), `repeat` (a number or `"loop"`), `yoyo`, `timeScale`, `paused`.

### Relationships between objects

- **Earth orbits the Sun; the Moon orbits Earth.** An orbit's `center` may be a node that is itself animated. The
  evaluator poses nodes lazily and memoized, so the centre's current position is used and a moving centre carries its
  satellite. The validator refuses centre cycles (a orbits b orbits a).
- **A gear rotates another gear.** `couple` multiplies the source spin's angle by `ratio` (negative for meshing gears).
  Chains are allowed and must end in a spin.
- **A particle follows a curve.** `path` uses exactly the points the card draws for that node (`src/scene/paths.ts`:
  the same Catmull–Rom sampling builds the curve's geometry and the motion), so the object stays on the visible curve.
  The unit tests check this to 10⁻⁶.
- **A component moves along a constrained path.** `path` with `orient: true` (its +z faces along the path, as
  Three.js's `lookAt`).
- **Parent–child transforms.** Children move with their parent holder, which carries the node's transform and its
  animation pose.
- **Phase relationships.** `oscillate` with `phase` 0, 120, 240 (the three-phase demonstration). The tests check that
  coil B at t + T/3 equals coil A at t.

Composition: a node's animations apply in document order onto its document transform. `orbit` and `path` set its
position, `oscillate` adds to it, `keyframes` set a property, and `spin`, `couple` and `track` set or compose its
orientation.

## Time

```
SceneTimeline
  time, speed, playing           one timeline per card (playback speed, play/pause)
  clock(animation id)            each animation's own clock
  advance(dt)                    every running clock += dt × speed; stopped (paused) clocks stay
  seek(t)                        timeline and every running clock = t (stopped ones stay)
  reset()                        everything back to 0
```

- **Start, pause, resume, stop, reset, speed, seek, repeat and loop** are supported. The card's universal pause/resume
  stops or restarts the whole timeline, `set-speed` and `seek` are commands, reset returns to t = 0 and the scene's
  camera, and `repeat` / `yoyo` / `"loop"` are per animation. "Stop Mars" is a patch (`paused: true` on Mars's
  animations). It is part of the scene's history, so it can be undone.
- **Frame-rate independent.** A pose depends only on the clocks, and clocks advance by real elapsed time. The unit
  test compares 432 steps with 7 steps over the same 3 s and finds identical positions (within 10⁻⁹). The one
  deliberate exception is the viewer engine's `dt` cap of 0.1 s per frame: a frame that takes longer (a hidden or
  stalled tab) advances time by at most 0.1 s rather than jumping.
- **Reduced motion.** Under `prefers-reduced-motion` the default speed is a quarter, camera moves are instant and
  orbit damping is off. A scene with `timeline.autoplay: false` starts paused.

## Illustrative, not physical

The engine moves things at constant rates along geometric paths. It does not integrate forces, conserve energy or
solve circuits or fields, and the documentation, the tool results and the card never claim otherwise. A scene that
needs such a computation declares it (`requirements: ["compute:…"]`) and is refused or labelled illustrative (see
[PRESENTATION-ROUTER-V2.md](PRESENTATION-ROUTER-V2.md#capabilities)). A future solver backend registers its compute
capabilities and supplies data; the animation engine still only presents it.
