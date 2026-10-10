# Aion Presence v0.4: implementation plan

Baseline: v0.3.0 (`d2b5abe`), 165 tests green, runtime in sync, plugin valid. Branch: `feat/aion-presence-v4`.

## What the audit found

| Area | v0.3 | Consequence for v0.4 |
| --- | --- | --- |
| Persistent body | `AionBody` blends one layer: `bodyMorph` 0 (sphere) … 1 (figure) | Eyes need a second layer: per-body weights (figure, eyes), each staggered per grain, so any body → any body is one particle transition. |
| Figure particles | bone 24 %, ring 7 %, joint 5 %, veil 4 %, aura 14 %, halo 4 %, dust 42 % | Most grains are noise. 6 % of the sphere's turbulence also leaks into the figure and every grain wobbles. Reallocate to bones / head / joints; remove dust, halo, veil; drop the leak and the wobble. |
| Figure motion | `gestureTarget()` per state; sines and two envelopes; legs fixed | A new motion layer: keyframe clips with easing, anticipation and follow-through, a scheduler with real pauses, two-bone IK for hands and feet, stepping and jumping. The skeleton and the GPU binding stay. |
| Portrait | `rasterPoints(style "portrait")`: 4:5 crop, round vignette | Heritage = 3:4 crop (aspect kept) + a reusable elliptical mask with a soft edge + a silver particle outline. Classic unchanged. |
| Morph targets | static points, optional z-spin (`formedAngle`) | 3D needs yaw / pitch / zoom in `formedTarget()` (compute and material share it), a depth cue for tone, and a drag controller on the stage. |
| Visual targets | `raster2d`, `points`, `heightfield` | Add `mesh3d`: a validated primitive scene → Three.js geometry → surface + edge sampling. |
| Assistant audio | `HostAudioSource` seam, `NO_HOST_AUDIO` | The audio bridge plugs in there if, and only if, the experiment proves a permission-compliant capture of Codex's own output. |

## Order of work

1. **Visual refinement**: Heritage portrait (`src/visual/oval.ts`, `normalizeImage(…, { portraitStyle })`, `style` on `show_portrait` / `show_image`); Figure 2.0 particle layout. Real-renderer previews before going on.
2. **Expressive motion**: `src/core/figure/motion.ts` (clips, easing, IK, scheduler), state integration, the explanation choreography (a card with an emphasised term, the figure looks, tilts, points, explains, relaxes).
3. **Aion Eyes**: `src/core/eyes/` (layout, expressions, animator: blink, saccades, state mapping), GPU and canvas evaluation, three-way body blend, `express` tool for manual expressions.
4. **3D scene engine**: `src/visual/scene3d/` (schema + strict validator, presets, geometry builder on Three.js, sampler), `mesh3d` target, view uniforms, orbit controller, `show_scene` and `set_scene_view` tools, router (scene → BODY).
5. **Audio bridge experiment**: `experiments/audio-bridge/` (Swift, Core Audio process taps), feasibility report `docs/AUDIO-BRIDGE.md`. Integrate only if verified.
6. **Integration**: MCP tools, Skill, hub protocol, docs (README, architecture, PARITY, EYES, FIGURE, SCENES), version 0.4.0, runtime rebuilt.
7. **Review**: unit tests for every new module, smoke extended, `npm run showcase` recording the nine demos in the real renderer.

## Constraints kept

- One particle system, one morph engine, one Presence page. No second window, no SVG figure, no static eye images.
- No model calls, no keys, no remote 3D assets, no executable scene content.
- Canvas fallback evaluates the same CPU reference of every new GPU expression.
- v0.3 routes (BODY / CARD / HYBRID), tools and hold times unchanged unless stated.
