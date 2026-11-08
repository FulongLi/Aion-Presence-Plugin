# v0.9.0 development report: the 3D Particle Model Library

Branch `feat/v0.9-particle-model-library`, cut from `main` at the v0.8 merge. Not merged, not tagged. How it works:
[MODEL-LIBRARY.md](../MODEL-LIBRARY.md); the catalogue: [MODEL-CATALOGUE.md](../MODEL-CATALOGUE.md).

## What works (with its evidence)

| Capability | Evidence |
| --- | --- |
| Import of GLB, glTF (+ its files), OBJ (+ MTL and textures), STL; refusal of URLs, relative paths, FBX/BLEND (with the export hint), malformed and over-limit files | `tests/v09-models.test.ts` (library import, refusals) |
| A universal converter: geometry with node transforms and skins, area-weighted seeded sampling, colour detail, hidden-surface removal, texture and vertex colours, baked light, normalization | unit tests (area share 0.10 ± 0.02 for a 1 : 9 pair; nested cube → 0 inner particles; texture colours), `npm run models:measure` |
| Recognisable characters as particles | real-renderer screenshots: [Lumen](../media/v0.9.0/lumen-original.png), [silver](../media/v0.9.0/lumen-silver.png), [Fox](../media/v0.9.0/fox.png) |
| Sphere → model, ordered (correspondence) | mean grain travel about half of an arbitrary order (unit test); [transformation frames](../media/v0.9.0/sphere-to-lumen.png) |
| Model → model without returning to the sphere | smoke: Lumen → Fox phases stay `holding`, `crossing` true; [frames](../media/v0.9.0/lumen-to-fox.png); controller unit test |
| Original colours ↔ Aion silver, in place | smoke: the same `visual.revision`; teal share of lit pixels 84 % → silver 100 % (WebGPU); 66 % → 100 % (canvas) |
| Rotation, zoom, reset | `set_scene_view` on a model (smoke, MCP test) |
| The model's own animation | the Fox's Walk clip baked through its skeleton; screen motion 2.96 vs 0.03 still (WebGPU), 0.40 vs 0.01 (canvas); [frame](../media/v0.9.0/fox-walking.png); unit tests for channels and baking |
| Natural-language selection and switching | `show_model` through MCP: names, "another one", colours, clips, find, import, remove; registry: other languages, Pokédex numbers, typos |
| Honest refusals | an uninstalled or unknown model fails with references and the import path; the presentation on show is unchanged (MCP test and smoke) |
| Catalogue of Pokémon references | 626 references, 236 characters, 23 restricted, all `catalogued`, third-party design, never redistributable (catalogue test, `npm run models:catalogue`) |
| Existing capabilities unaffected | `npm run check` (442 tests); `npm run smoke -- --offline --only=renderers,visuals,v4,v41,v43,v44,v05,v45,models`: **381 checks, 0 failures** on both renderers (incl. v43 writing, whose reveal key moved into the target vec4); [canvas Fox](../media/v0.9.0/fox-canvas.png) |
| Tool budget | 36 tools, 59,992 B by Codex's measure (target 60,000 B); all exposed |

## Measurements

Conversion (Node, development Mac; once per model, detail and clip, then cached):

| Model | Triangles | 50,000 particles | Textures | Bundle |
| --- | --- | --- | --- | --- |
| Fox | 576 | 0.21 s | 22 ms (1024²) | 488 KB (+5.7 MB with a 20-frame clip) |
| Lumen | 25,832 | 0.70 s | — | 488 KB |
| Avocado (CC0, local test) | 682 | 0.24 s | 0.24 s (2048², 1 of 3 used) | 488 KB |
| A Beautiful Game (CC BY 4.0, local stress test) | 1,499,072 | 1.7 s | 3.1 s (13 × 2048² JPEG at 1024) | 488 KB |

Optimisations made from these numbers: JPEG textures decoded at ≤ 1024 px with a scaled IDCT and a flat-block shortcut
(790 → 226 ms per 2048² texture); only colour textures decoded; the BVH built with quickselect instead of sorting
(3.2 → 0.7 s for 1.5 M triangles). The stress model went from 14.7 s to 4.9 s in all. Cached loads: 4–7 ms.

Registry: 628 entries load in 21 ms on the first `show_model` call; resolving a name takes about 7 ms. Nothing of the
catalogue is read at startup or sent to the renderer.

Renderer (headless Chrome on the development Mac, `npm run smoke -- --only=models`): 16.7 ms per frame (the display's
60 Hz) with a model formed at tier 2 (20,000 particles) on WebGPU and with 4,000 particles on the canvas fallback.
GPU memory: the per-grain target data grew from 20 to 48 bytes (target vec4, look vec4, previous vec4) — 2.4 MB at the
50,000-particle ceiling, 1.4 MB more than v0.8. Transition smoothness is shown, not scored: the frames are in the GIF and
the contact sheets; the morph timings are 2.4 s (form), 2.2 s (model → model), 1.8 s (return).

## What remains experimental

- **Animation**: skinned glTF clips only, baked (≤ 15 fps, ≤ 6 MB a clip) and looped; no morph targets, no blending
  between clips, colours do not animate. Verified with the Fox only — no Pokémon model with clips was available to test.
- **Hidden-surface removal** uses 14 escape directions: a point visible only through a narrow gap can be dropped, and an
  open model (no back faces) keeps both sides of thin parts.
- **Restricted detection** is a text heuristic over titles, tags and descriptions; it is deliberately cautious and flags
  some genuine fan models.
- **Canvas fallback** colours are batched to 4 bits a channel over 4,000 particles: recognisable, not refined.

## Asset licensing limitations

- No Pokémon model was downloaded, bundled or rendered. Sketchfab downloads require an account, and the characters'
  designs belong to Nintendo / Creatures Inc. / GAME FREAK inc.; a modeller's CC licence does not cover them. The
  catalogue therefore holds references only. A user may import one they downloaded for private use; Aion never fetches it.
- Bundled: Lumen (Aion's own) and the Khronos Fox (CC0 model, CC BY 4.0 rigging/animation and conversion — credited in
  its manifest, on screen and in THIRD-PARTY-NOTICES). Avocado and A Beautiful Game were used locally for measurement only
  and are not in the repository.
- free3d.com and CGTrader offer no public search API and were not scraped; their models are not catalogued.
- Questions for counsel are in [LICENSING.md](../LICENSING.md) (item 9).

## Not verified

- A real Codex conversation choosing `show_model` from natural language (`npm run scene:eval`-style run): only the MCP
  path and the Skill's worked examples were tested.
- WebGPU on other GPUs and browsers, Windows and Linux; real displays above 60 Hz; the 35k–50k-particle tiers (the
  headless run stayed at tier 2).
- Any model larger than the stress test, or with KTX2/WebP/Draco (refused by design).
