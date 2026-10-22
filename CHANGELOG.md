# Changelog

All notable changes to Aion Presence. Dates are when the change reached the repository's default line of development
(the merge date of its pull request). Only **v0.4.5** is a tagged GitHub release; the other versions were merged as
development versions without a release tag. Details live in [docs/](docs/); this file stays brief.

## [0.7.0] — Unreleased (in review)

A spoken first-run welcome, and FreeCAD as a real parametric CAD backend. Branch `feat/v0.7-spoken-welcome-freecad`.
Details: [docs/FREECAD.md](docs/FREECAD.md), [docs/HOST.md](docs/HOST.md#v07-the-spoken-welcome).

### Added
- **FreeCAD backend** (`cad_model`, one tool): Codex creates, opens and changes native `.FCStd` documents in the user's
  own FreeCAD (1.0+, found automatically or via `AION_FREECAD`), through a fixed worker script run by FreeCAD's
  `freecadcmd` over pipes (no port, no code from Codex or cards). Primitives, holes (parametric: they follow a box's
  size), constrained sketches, pads, pockets, booleans, fillets and chamfers (edge rules that survive changes),
  parameters, moves, visibility, appearance, delete, undo/redo, save (never over another file), STEP/STL export, a
  single-writer hand-off to the FreeCAD application and reload. Every change is a FreeCAD transaction, recomputed and
  checked; a failure is aborted and the previous valid model stays. Documents persist: each revision is saved in Aion's
  workspace, so a new MCP server (Codex may start one per turn) or a restart carries on, and undo/redo restore saved
  FreeCAD states. Without FreeCAD, `cad_model` says how to install it and nothing else changes.
- **FreeCAD → Aion**: each confirmed revision is tessellated per face, each face assigned (by geometry) to the feature
  that made it, and shown as a validated GLB in the CAD viewer — the selected hole is `Hole2`, FreeCAD's own id; "this
  part" is `"$selected"`.
- **Spoken welcome**: the first time Aion's window opens, Aion speaks four short sentences (English or Chinese) with an
  on-device system voice while its body takes the answering field (semantic, with each sentence's real onset — not lip
  sync). Skip, Replay, captions, "?" for the three examples; "Listen to the welcome" when the browser needs a click; a
  few lines of text when no on-device voice exists. It waits for Codex to finish answering, stops for a new turn or a
  visual, and is remembered only with a real outcome (`welcome-complete` records it).
- `tests/v07-welcome.test.ts`, `tests/v07-cad.test.ts` (unit, mocked backend, and real FreeCAD scenarios A–G);
  `npm run cad:verify`; `npm run welcome:speech`; smoke sections `welcome` (spoken) and `cad`; `scene:eval` scenario K
  (FreeCAD through the real Codex — its first run found that a new MCP server per turn lost the documents).

### Changed
- The welcome panel is gone: a title, a caption and small controls beneath the body. Codex no longer introduces Aion
  when the window speaks the welcome (Skill, `open_presence` result).
- CAD viewer 1.1.0: revisions of a document replace each other in place (camera, selection, hidden parts kept; a lost
  selection is reported), the card reports `document`/`revision`, and a `status` command shows FreeCAD's progress.
- The "Aion never speaks" rule has one documented exception: the fixed welcome, with an on-device voice
  (`tests/apiIndependence.test.ts`).
- Tool metadata: 34 tools, 58,636 B by Codex's measure; the internal target moves from 57,600 B (10 % inside Codex's
  64,000 B) to 59,000 B (≈ 8 %) for the one compact `cad_model` tool. All tools stay exposed.

## [0.6.0] — 2026-10-22

Route Explorer, Aion's own window and a first-run welcome. Branch `feat/v0.6-route-explorer-onboarding`. Details:
[docs/ROUTE-EXPLORER.md](docs/ROUTE-EXPLORER.md), [docs/HOST.md](docs/HOST.md#v06-aions-own-window-and-the-first-run-welcome).

### Added
- **Routes** (`plan_route`): real walking, cycling and hiking routes between places and waypoints, planned by a routing
  service over OpenStreetMap — by default FOSSGIS e.V.'s public Valhalla (one request a second, identified, coordinates
  only), or the user's own Valhalla, or OpenRouteService with the user's key. Follow-ups change the route on show
  (reverse, mode, waypoints, clear); failures say why and nothing is drawn. Codex never supplies route coordinates.
- **One geographic state**: a validated `GeoRoute` (`src/visual/geo/route.ts`) kept on the card with revisions, drawn by
  both views; elevation sampled along the real path from the AWS Terrain Tiles (smoothed, with hysteresis; rounded).
- **The route on the particle terrain**: a luminous line resting on the relief, A and B, the card's highlight, section
  and pointer at the same places. The terrain on show is reused when the route fits it; otherwise the route's own
  surroundings form. Changing or removing a route never re-forms the terrain.
- **Route Explorer card** (Card 2.0, `route-explorer` 1.0.0): OpenStreetMap map (tiles fetched by the hub only as viewed,
  cached by OSM's policy, never by the card), the route, an elevation profile linked to the map and the body, the
  figures; commands `show`, `section`, `point-at`, `clear-highlight`. Bridge: `LOAD_ROUTE`, `CURSOR`, `TILE_REQUEST`,
  `LOAD_TILE` under two new capabilities.
- **First-run welcome**: a short introduction with three example requests (copy to use), Get started / Skip, shown once
  per installation (`welcome-complete` in the plugin data) and again on request (`open_presence` `welcome`).
- `npm run route:verify` (the acceptance scenarios against the real service); smoke sections `welcome` and `v06`;
  `scene:eval` scenarios `journey` and `routes`; `tests/v06.test.ts`.

### Changed
- **Aion opens in its own window by default**, also in hosts that render MCP Apps; embedded only with `surface:
  "embedded"` (or `AION_PRESENCE_SURFACE=embedded`). An embedded view says so while Aion is in its own window.
- Several conversations asking to open Aion at once open one window (a hub-wide launch guard).
- Closing a route's card keeps its terrain; `mark_map` works on a route's terrain.
- Tool metadata: 33 tools, 57,536 B by Codex's measure (target 57,600 B): shared marker, hold and portrait parameter
  descriptions were shortened to make room for `plan_route`, with no change of meaning.

## [0.5.2] — 2026-10-19

Regression fix: terrain (and eight other tools) missing from Codex conversations. Branch `fix/v0.5.1-terrain-regression`.
Details: [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md#v052-the-terrain-regression).

### Fixed
- **`show_terrain` is available again in Codex.** Codex 0.163 charges each tool of a plugin's MCP server its model
  spec *plus the server's instructions* (cut at 1,000 B, repeated on every tool) against a 64,000-byte budget shared by
  plugin servers, and silently hides the tools that do not fit. Aion's 1.27 KB of instructions made its 32 tools cost
  86.8 KB, so a new conversation got only the first 23 (`clear_presentation` … `show_music`): `show_number`,
  `show_portrait`, `show_result`, `show_scene`, `show_stroke_animation`, `show_symbol`, `show_terrain`, `show_text` and
  `show_visual_form` were hidden, although `codex app-server` listed all 32. The instructions are now one line (83 B;
  the guidance they carried is in the skill): Codex's measure is 57.2 KB, every tool exposed. Present since v0.4.5.
- `show_form`'s description fits Codex's 1,000-byte cut (its form-id catalogue is written compactly), so Codex sees it whole.

### Added
- Codex's own measure in `npm run mcp:budget` and the tests (`codexExposureReport`, held 10 % inside the budget);
  `npm run codex:tools` reports the Aion version Codex runs and how many Aion tools a new conversation gets;
  `npm run codex:verify` checks Codex's measure, and with `--live` reads `ALL_TOOLS` in a real Codex conversation.
- `terrain-unavailable` says which stage failed: the elevation service (timeout, unreachable, HTTP status), an invalid
  tile, or the height field.

### Changed
- The skill: a real place's terrain or map is never a generated scene; if a tool is missing from `ALL_TOOLS`, say so
  rather than substitute another visual.

## [0.5.1] — 2026-10-18

Generative experience refinement and project governance. Branch `feat/v0.5.1-generative-refinement` (PR #13).

### Added
- **Bounded scene repair**: a refused scene or patch lists every independent problem (up to 8) with a fix hint, and
  counts the attempt; the third refusal tells Codex to stop and say so, further invalid attempts are refused without
  details. `version` and `sceneId`, when missing, are filled in and said. Probable mistakes on a valid scene (radians,
  a near-zero spin, an unreadable scale) come back as `Check:` notes.
- **Visual styles** (`environment.style`: scientific, engineering, minimal, presentation, cinematic) — studio
  reflections, three-point lighting, soft shadows and a ground, chosen from the scene's intent when not named.
- **Material presets** (metal, steel, aluminium, copper, gold, brass, plastic, rubber, glass, matte, ceramic,
  emissive, pcb, ferrite).
- **Direct manipulation**: Move, Rotate and Scale tools (W/E/R) and Undo/Redo in the generated-scene card. A finished
  drag is proposed to the hub (Card Bridge `EDIT`) and becomes a validated, revisioned patch labelled "(by hand)"; the
  card shows it only once confirmed.
- **Hybrid body sync**: when a change alters a hybrid scene's shape, the particle body re-forms the new arrangement
  for a moment beside the card.
- Codex guidance: planning steps, common mistakes and worked examples (`references/scene-examples.md`, all validated by
  tests); an explicit rule for requests to *calculate* or *simulate*.
- `npm run scene:eval` — natural-language generation with the real Codex CLI, measured from request to confirmed render;
  `npm run scene` — drive a running Aion's scene by hand. Results: [docs/SCENE-GENERATION-TESTS.md](docs/SCENE-GENERATION-TESTS.md).
- Governance: this changelog, [CLAUDE.md](CLAUDE.md), a draft personal-use [LICENSE](LICENSE) (not yet legally
  reviewed; see [docs/LICENSING.md](docs/LICENSING.md)), and an optional GitHub star invitation in the README.

### Improved
- Camera framing fits the drawn shapes (sampled vertices), keeps grown or moved scenes in view without turning the
  user's own view, and sets clipping planes from the scene's size.
- Labels avoid each other (below, above, right or left of their object; hidden rather than stacked) and adapt to light
  backdrops; the selected object is tinted and outlined; the inspector is sectioned (transform, material, motion, facts).
- `oscillate` on `scale` with an `axis` swings that direction only (a surface's amplitude).
- Capability reports: shadows and studio lighting are supported; bloom and refraction are reported as approximated.
- README rewritten to be short; detail moved to docs ([FEATURES](docs/FEATURES.md), [DEVELOPMENT](docs/DEVELOPMENT.md),
  [PRIVACY](docs/PRIVACY.md), [MCP-TOOLS](docs/MCP-TOOLS.md), [HOST](docs/HOST.md)).

### Fixed
- three.js warnings for materials created with an undefined `side` or `blending`.

## [0.5.0] — 2026-10-16

### Added
- **Generative Visual Engine**: Scene IR (20 geometries, 8 declarative animations), strict validation, transactional
  patches with revisions, undo/redo/revert, Presentation Router 2.0 (body, card or hybrid with reasons), a particle
  adapter, and the `generative-scene` Card 2.0 application — through the existing card tools, no new MCP tool.
- Capability detection that refuses computed results Aion cannot produce and labels illustrations.
- A defined boundary for future CAD/solver backends.

## [0.4.5] — 2026-10-15 (tag `v0.4.5`)

### Added
- **Interactive Cards (Card 2.0)**: isolated, sandboxed applications beside the body with a validated bridge.
- The Earth–Moon system and a glTF/GLB CAD viewer.

### Changed
- Repository consolidated onto `main`.

## [0.4.4] — 2026-10-15

### Added
- The Chinese Writing Pack (9,574 characters, offline), a shared writing core for Chinese, English and music handwriting,
  the music education pack, and Figure 3.0.

### Fixed
- Tool discovery: tool metadata reduced from 302 KB to within Codex's budget, so every tool is listed.

## [0.4.3] — 2026-10-14

### Added
- Stroke-by-stroke writing, short figure animations on one Animation Core, Storyteller Mode, local photographs as
  portraits, and Codex Voice Sync.

## [0.4.2] — 2026-10-13

### Added
- The Music Library (engraved notation, playback with lit notes, lessons) and the audio-reactive presence, including the
  macOS audio bridge for Codex's voice.

## [0.4.1] — 2026-10-11

### Added
- Heritage portraits by default, redesigned Aion Eyes, maps with markers for any region, global terrain, and remembered
  colours.

## [0.4.0] — 2026-10-10

### Added
- Visual identity and expressive embodiment: Aion Eyes, Figure 2.0 gestures and explanation, heritage portraits and
  genuine 3D objects.

## [0.3.0] — 2026-10-02

### Added
- Embodiment as Codex's presence, the Presentation Router (body, card, hybrid), live listening and responding states,
  and immersive mode.

## [0.2.0] — 2026-10-01

### Added
- Parity with SCF Presence Realtime's presence, conversational embodiment, and a one-step install.

## [0.1.0] — 2026-10-01

### Added
- The first plugin: Aion Core, the particle renderer, the MCP state bridge and presence hub, lifecycle hooks, and the
  presence surface in embedded and companion modes.
