# v0.9.1 report: full particle bounds and non-humanoid animation

Branch `feat/v0.9-particle-model-library` (continuing v0.9.0, PR #18). Not merged, not tagged. Workflow and reference:
[MODEL-LIBRARY.md](../MODEL-LIBRARY.md#animation).

## 1. The fox's clipped nose — root cause

**Symptom.** Side on, the running Fox's snout ended in a flat vertical face; the tail tip was cut the same way.

**Cause (confirmed).** Not the camera, the viewport or the shader. A converted model travels to the Presence page as a
particle bundle whose positions are int16, quantized over a range stored in the header. v0.9.0 used the *rest pose's*
normalized radius (1.75) as that range for every animation frame and clamped anything outside it:
`Math.max(-1, Math.min(1, value / extent))` in `encodeBundle`. An animated pose reaches beyond its rest pose — the
running Fox stretches nose-forward and tail-back along its length (z) to 1.915. Measured on the bundled Fox
(`scripts` probe, 20,000 particles):

| Clip | Farthest coordinate | Coordinates clamped | Largest error |
| --- | --- | --- | --- |
| Survey | 1.746 | 0 | 0 |
| Walk | 1.902 | 1,906 | 0.152 |
| Run | 1.915 | 3,378 (all on z: 786 at the nose, 2,592 at the tail) | 0.165 |

**Fix.** `encodeBundle` quantizes over the true extent of the rest pose *and every frame* (`boundsOf`), stored in the
header the decoder already reads; the converter version went to 2 so cached v1 bundles are rebuilt. Largest decode error
after the fix: 0 at the measured precision (one int16 step, 6 × 10⁻⁵). No clipping or culling mechanism was removed.

**Rest of the chain, checked and not at fault.** Normalization scales the rest pose to 1.75 (frames may exceed it, now
encoded); the CPU samplers and the canvas fallback use floats; the GPU spring's `maxOffset` (1.1) limits how far a grain
lags its target, not where the target is; the material discards only outside each particle's disc; the particle mesh has
frustum culling off; the camera is refitted to the container on every resize (`ResizeObserver`), framing ±2.62 world units
in the smaller dimension — a model at ≤ 1.92 fits with room to spare, and only an explicit zoom (`set_scene_view`, up to
1.8×) can reach the edges, where ordinary viewport clipping applies.

**Evidence.** [before/after, side on, widest moment of the run](../media/v0.9.1/fox-run-before-after.png) (top: before,
the snout cut flat; bottom: after); clips [before](../media/v0.9.1/fox-run-before.gif) and
[after](../media/v0.9.1/fox-run-after.gif) (recorded from the real WebGPU renderer; the "before" bundle reproduces the
v0.9.0 clamp on today's code). The fox's widest lit extent side on: 448 px before, 464 px after (+3.6 %, the clamped
0.165 of its 3.8-unit length). Regression test: `tests/v091-animation.test.ts` ("an animated frame beyond the rest pose
survives the particle bundle").

## 2. Non-humanoid animation

Unchanged in principle: **animated GLB → deforming mesh → surface-attached particles → Aion's renderer.** Each particle is
sampled once on the rest pose (a triangle and barycentric weights) and re-placed on the same spot of the deformed surface
in every frame — no per-frame resampling, so no flicker or swimming. Added:

- **Morph targets** (blend shapes) in the glTF reader: POSITION deltas weighted by the node's, the mesh's or the
  animation's `weights` channel, before skinning (glTF's order). Joint and morph counts are reported.
- **Clip control**: `control_animation` (pause, resume, replay, speed slow/normal/fast/slower/faster within 0.25–2.5×,
  stop) now drives a model's own clip, in place (same particles). No new tool; tool metadata 59,986 B (−6 B).
- **A rig builder** (`scripts/lib/rig.ts`): bones, skinned parts with soft joints, morph targets, looping clips sampled
  from a function of time, two-bone leg IK, tapered tubes — written as a standard GLB any viewer opens.
- **Lumen** (Aion's own, bundled) is now rigged with squash/stretch morph targets and a "Bounce" clip: the redistributable
  soft-body fixture.

## 3. Koromon and Agumon (local only)

Both were **modelled procedurally for this evaluation** (no third-party model, texture or animation was used) and kept
in the git-ignored `local-models/digimon/` because the designs belong to their rights holders (Digimon: © Akiyoshi Hongo,
Toei Animation, Bandai). Provenance: `local-models/digimon/MANIFEST.md`.

| | Koromon | Agumon |
| --- | --- | --- |
| File | `local-models/digimon/koromon.glb` | `local-models/digimon/agumon.glb` |
| Body | soft round body, two long floppy ears | biped: head and snout, two arms, two legs, tail |
| Rig | 7 bones + 2 morph targets (squash, stretch) | 22 bones (4 in the tail) |
| Clip | Bounce, 1.6 s: rest → anticipation squash → launch stretch → airborne → landing compression → recovery | Walk, 1.1 s: IK legs on a planted-foot path, opposite arm swing, hip bob and sway, stabilized head, tail follow-through |
| In Aion | `local-models/digimon/output/koromon.gif`, `koromon-frames/`, `koromon-aion-sheet.png` | `…/agumon.gif`, `agumon-frames/`, `agumon-aion-sheet.png` |
| In the user's library | `my-koromon` (local, third-party design) | `my-agumon` |

Both play through Aion's real particle renderer (WebGPU) via the hub, as `show_model` delivers them — not merely in a GLB
viewer. Tests on rig-built fixtures of the same body types (a soft bouncer, a tailed biped) check that particles stay
attached (nearest-neighbour spacing within 2× of rest in every frame — no tearing), that the loop seam is no larger than
an ordinary step, that the landing compresses the body, that the feet move in opposite phase and the tail tip sways.

## 4. Performance

`npx tsx scripts/models/playback.ts` on the development Mac: Apple M4 (10 cores), 16 GB, macOS, Chrome headless,
**WebGPU**, window 1100 × 760 at device pixel ratio 1. Frame times from `requestAnimationFrame` over 4 s with the clip
playing. GPU target buffers: 48 bytes a grain (target, look, previous). Conversion includes baking the clip.

| Model | Triangles · bones · morphs | Bundle detail | Conversion | Bundle | Load (request → forming) | 6,000 particles | 20,000 | 50,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fox (Run) | 576 · 24 · 0 | 12k / 30k / 50k | 0.11 / 0.24 / 0.35 s | 1.3 / 3.2 / 5.3 MB | 29–38 ms | 60.2 fps | 60.2 fps | 60.2 fps |
| Koromon (Bounce) | 15,616 · 7 · 2 | 12k / 30k / 50k | 0.14 / 0.33 / 0.52 s | 1.8 / 4.4 / 6.2 MB | 31–44 ms | 58.9–60.2 fps | 60.1–60.2 fps | 60.1–60.2 fps |
| Agumon (Walk) | 24,064 · 22 · 0 | 12k / 30k / 50k | 0.33 / 0.83 / 1.34 s | 1.3 / 3.2 / 5.3 MB | 42–44 ms | 60.0–60.1 fps | 60.1–60.2 fps | 60.1 fps |

Frame-time percentiles were 16.7 / 16.7–16.8 / 16.8 ms (p50 / p95 / p99) in every one of the 27 runs; JS heap 33–62 MB;
GPU target buffers 0.3 / 0.9 / 2.3 MB. **Reading:** on this machine every combination is held by the 60 Hz display, so
the table shows there is no regression and no cost visible at 60 Hz — it cannot rank the detail levels. The costs that do
scale are conversion time (Agumon's 22-bone skin is the slowest to bake) and bundle size (a clip adds 6 bytes a particle a
frame; the clip budget caps it at 6 MB). Guidance for future models: medium detail (30,000 particles) keeps these three
recognizable at a third of the bundle size of high; skinned characters of ~25k triangles and ~20 bones convert in about a
second at high detail.

## 5. Viewport behaviour

For each model: default view, turned 90° and 180°, zoomed in (×1.7), windows of 1680 × 1050 (maximized), 620 × 900
(narrow) and 1100 × 760, and three fullscreen ↔ windowed round trips; the lit region was measured each time (full table:
`local-models/digimon/output/report.md`). The model keeps its proportion of the view across sizes (the narrow window fits
the width instead of the height, as designed); nothing touches an edge except Koromon zoomed in at the top of its jump,
which is ordinary viewport clipping of a zoomed view. No page errors. Fox screenshots: [side](../media/v0.9.1/fox-side.png),
[narrow window](../media/v0.9.1/fox-narrow-window.png), [zoomed](../media/v0.9.1/fox-zoomed.png).

Limitation of this test: headless Chrome grants fullscreen without changing the viewport, so the fullscreen rounds verify
the transitions and the absence of errors, not a larger canvas; the size changes cover the canvas resizing.

## 6. Existing functionality

`npm run check`: lint, typecheck, **450/450 tests** (8 new), the runtime matches the sources, the plugin package is
valid. `npm run smoke -- --offline --only=renderers,visuals,v4,v43,v44,v05,models` on WebGPU and the canvas fallback:
**265 checks, 0 failures** — the sphere, eyes and figure, forms and symbols, writing (whose reveal key shares the target
buffer), action sequences, 3D scenes, generated scenes and the model library (Lumen, the Fox walking) unaffected.

## Remaining limitations

- Animation is baked (≤ 15 fps, interpolated) and limited to 6 MB a clip; one clip at a time; no blending between clips,
  no retargeting or motion capture (out of scope).
- Morph targets: POSITION only (normals are not used by the sampler); sparse morph accessors are supported.
- Visibility is decided on the rest pose: a surface hidden at rest but exposed in motion (inside a closed mouth that
  opens) has no particles.
- Frame-rate headroom was not measurable on this display-capped machine; lower-end hardware, a real (non-headless)
  fullscreen, Windows and Linux were not tested.
- Koromon and Agumon are simplified procedural likenesses; they are not distributed and the rights holders' permission
  would be needed for any public use.
