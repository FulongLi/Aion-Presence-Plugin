# Changelog

All notable changes to Aion Presence. Dates are when the change reached the repository's default line of development
(the merge date of its pull request). Only **v0.4.5** is a tagged GitHub release; the other versions were merged as
development versions without a release tag. Details live in [docs/](docs/); this file stays brief.

## [0.5.1] — Unreleased (in review)

Generative experience refinement and project governance. Development branch `feat/v0.5.1-generative-refinement`.

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
