# Aion Presence: architecture

Aion Presence separates **who does the work** from **how it is seen**. The host agent (Codex today) is the
intelligence. Aion is SCF Presence's Presence with its AI transport replaced by the host:

```text
SCF:     OpenAI Realtime / GPT-Live ─► Presence Core
Plugin:  Codex (the host agent)     ─► Host Adapter ─► Presence Core ─► particle renderer ─► Presence Surface
```

The whole, end to end:

```text
┌──────────────────────────── Codex (the host AI) ────────────────────────────┐
│ conversation · reasoning · tools · voice                                    │
│   ├─ skill  aion-presence      identity, greeting, visual intent, restraint │
│   ├─ MCP    aion-presence      open_presence · show_portrait · show_terrain…│
│   └─ hooks  aion-hook.mjs      UserPromptSubmit · Pre/PostToolUse · Stop …  │
└───────────────┬──────────────────────────────────────┬──────────────────────┘
                │ MCP (stdio)                          │ hook events (loopback HTTP)
                ▼                                      ▼
┌─────────────────────── Host Adapter (Node, local) ──────────────────────────┐
│ MCP server ─► presence hub (127.0.0.1, per-user token)                      │
│   Visual Resolver: Wikipedia · Commons · Openverse · OSM · elevation tiles  │
│   (only names and places are sent; results checked and kept as local media)│
└───────────────┬──────────────────────────────────────┬──────────────────────┘
                │ MCP Apps (embedded)                  │ companion window (SSE)
                ▼                                      ▼
┌──────────────────────── Presence Surface (one page) ────────────────────────┐
│ Presence engine: host state + local listening (VAD) ─► Aion Core            │
│ particle renderer (WebGPU, canvas fallback) · visual forms · samplers       │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Aion Core (`src/core`, `src/visual`)

| Module | Role |
| --- | --- |
| `identity.ts` | The canonical facts (Aion · Intelligent Presence · Spirit Connect · Fulong), frozen. A test checks the literals appear nowhere else in `src`. |
| `state.ts` | Activity: `idle listening thinking working reading editing testing building responding presenting complete error`; gestures `greeting` and `acknowledging`; `speaking` only from real host audio. Deterministic. |
| `signal.ts` | `PresenceEngine` (SCF's engine, transport replaced): the host's activity is the base; local voice → `listening` (short pauses between phrases keep the turn open); a finished turn → a short inferred `thinking`; real host audio → `speaking`; a bounded echo guard (while Codex answers and while that sound continues, never for a stale state). The user's loudness reaches the renderer whenever Aion really listens, also while a visual is formed. Diagnostics: the latest frame and the echo reason. |
| `listening/` | SCF's `VoiceActivityDetector` and `EmphasisDetector` (unchanged), `MicFrame`, `rms`. Pure numbers. |
| `guidance.ts` | The greeting (from the identity), onboarding examples backed by real tools, SCF's greeting gate (waits for the body and a quiet moment). |
| `body.ts` | Persistent body: sphere, figure or eyes, each layer with its own eased weight, so any change is one particle transition. |
| `figure/` | Figure 3.0 (v0.4.4): limbs drawn as continuous curves through the skeleton's anchors (`layout.ts limbCurve`), a chest anchor for a bending torso, and restrained secondary motion (`secondary.ts`). Figure 2.0: skeleton, the clean particle layout (strokes, head ring, joint beads), poses with two-bone IK (`pose.ts`), and the Expressive Motion System (`motion.ts`: eased keyframe clips, per-state tracks, gestures, the explanation cue). See [FIGURE.md](FIGURE.md). |
| `eyes/` | Aion Eyes (v0.4.1 cartoon design): one luminous shape per eye, bound by direction and share of the outline's reach (`layout.ts`, with its CPU reference), expressions as shapes, spring-driven motion with entries, tempo, blinks and saccades (`expression.ts`). See [EYES.md](EYES.md). |
| `colors.ts` | Aion's colours (v0.4.1): parsing (English and Chinese names, presets, hex), the particle palette (Aion Silver exact; others scaled, saturated and lifted to read on black), the accent. See [COLORS.md](COLORS.md). |
| `audio.ts` | `HostAudioSource`, the seam for real assistant audio: `NO_HOST_AUDIO`, or Codex's voice through the native bridge (v0.4.2, `surface/audioVisual.ts`). |
| `presentationRouter.ts` | The Presentation Router: BODY, CARD or HYBRID for each presentation, from its kind, size, origin and fidelity needs, an optional preference (`auto` by default) and the surface's capabilities. Pure policy; deterministic overrides of clearly bad requests. |
| `presentation.ts`, `store.ts` | What can be presented (form, text, result, image with fit, size and origin, terrain with its elevation, clock, number, symbol, emoji, artifact), routed; separate body and card lifetimes (SCF's hold times for the body, counted as time formed); a new topic retires temporary cards; the revisioned store. |
| `visual/` | Visual forms (Tao, celestial, symbols), target sampling incl. SCF's 2.5D height-field sampler, intent-driven `normalizeImage` (portrait band, map, object, logo; the heritage oval, `oval.ts`), height-field codec, SVG checks, validators, the Visual Action controller. |
| `visual/geo/` | Geography (v0.4.1), pure and shared: equal-area projections and frames (`projection.ts`), spherical extents — the primary part of a scattered region, windows (`extent.ts`), map geometry projected, densified and clipped, with its `AMP1` codec (`map.ts`), and `markerWorldPoint`, a place's position on a formed map or terrain through the samplers' own geometry (`markers.ts`). See [MAPS.md](MAPS.md). |
| `audio/` (v0.4.2) | The Audio Analysis Engine (`analyzer.ts`: the only FFT; loudness, 32 log bands, onsets, beats, voice), the common feature format, the feature bus, the source policy (`route.ts`), the music detector, settings and the compact wire form. Pure. See [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md). |
| `music/` (v0.4.2) | The Music Library: theory (pitch, rhythm, scales), notation (staff positions, the validated score, audio-clock scheduling), lessons in English and Chinese, practice questions, and the body's music symbols (Bravura outlines). Pure. See [MUSIC.md](MUSIC.md). |
| `writing/` (v0.4.4) | The Chinese Writing Pack's pure core: the block-compressed resource container (`pack/container.ts`), the lossless codec of Hanzi Writer character data (`hanzi/codec.ts`), outline geometry and validation shared by the build, the host and the page (`hanzi/geometry.ts`), simplified ↔ traditional classification (`hanzi/variants.ts`), the pack's identity and pinned upstream sources (`hanzi/sources.ts`). See [CHINESE-WRITING.md](CHINESE-WRITING.md). |
| `animation/` (v0.4.3) | The Animation Core (`timeline.ts`: playback anchored to the clock, easing, keyframes, segments; `control.ts`: one control vocabulary), the Stroke Animation Engine (`stroke/`: the data model, the path processor, curated packs, the writing timeline) and the Scene Sequencer (`scene/`: approved motion primitives compiled onto Figure 2.0, five demos). Pure. See [ANIMATION.md](ANIMATION.md) and [STROKE-ANIMATION.md](STROKE-ANIMATION.md). |
| `visual/scene3d/` | The 3D Scene Engine: the scene schema, its strict validator, presets, the Three.js geometry builder and the surface/edge particle sampler (`mesh3d` targets). See [SCENES.md](SCENES.md). |

### Precedence

```text
greeting  >  presenting (the body itself has become a visual)  >  acknowledging · offering  >  speaking (real audio)  >  activity
activity = local listening, if the user is heard and the host is resting or thinking
         = inferred thinking, after a finished turn while the host rests (≤ 6 s, until the host confirms)
         = the host's activity otherwise: responding, real work (never hidden by the user's voice), idle
```

A card is not "presenting": the body beside it keeps listening and answering (a brief `offering` gesture turns
it toward a new card). While the body is formed into a visual, listening still reaches it: the effective activity
and the user's loudness are kept, and the formed visual shimmers with the voice.

Echo: with real host audio, SCF's guard (no listening while audible and 0.4 s after). Without it, the engine is
conservative: no listening while Codex is `responding`, for 1.2 s after, and as long as the sound it was already
hearing continues without a 0.6 s pause (at most 20 s), so Codex's voice from the speakers is not taken for the
user. A `responding` older than 45 s no longer counts as echo. Real barge-in needs real host audio and is not
claimed; Codex's Interrupt hook still ends an answer.

### The answer tail

Codex's text answer ends long before its voice does. The Skill sets `responding` just before the final reply;
the Stop hook reduces the final message to the seconds it takes to say (about 2.6 words or 4.2 CJK characters a
second; code and links are not counted; the text never leaves the hook); the hub keeps `responding` for what is
left of that (1.5–45 s), then `complete`. A new prompt, an interruption or any new state ends it at once.

## Particle renderer (`src/render`)

SCF Presence's WebGPU body, kept intact: compute physics at 120 Hz (presence field, pointer pusher, spring), the
figure rest layer, staggered morph and body weights, microdisc material, bloom, adaptive quality (effects shed
before density). Additions, mirrored in the Canvas 2D fallback:

- **Listening**: a deeper gather, an inward ripple that follows the user's loudness (at a frequency the body's
  spring passes; syllable-rate changes would be filtered out), and a slightly brighter body.
- **Writing** (v0.4.3): a writing target's grains carry reveal keys (one more storage buffer, 7 of 8 in compute); a few
  uniforms reveal the strokes in order and move the pen's cluster (`physics/writing.ts`, CPU reference `render/writing.ts`).
- **Responding** (semantic; no amplitude, no spectrum): part of the breath gives way to a travelling swell on the
  outer shell, a second swell out of step with it, a slow current around the vertical axis and a faint warm light.
  The figure answers with breathing, torso, shoulder and head movement and hands that articulate now and then
  (irregular envelopes, never a loop). Measured on the real renderer by the smoke test.
- **Formed visuals** keep a little life: their ripple deepens while Aion answers or listens.
- **Three bodies** (v0.4): the rest position is `mix(mix(sphere, figure, bFigure), eyes, bEyes)` with a staggered
  weight per grain for each layer. The figure and eye bindings share one storage buffer (four vec4 per particle),
  so the compute stage stays within WebGPU's default eight storage buffers. The figure takes none of the sphere's
  field (its strokes stay precise).
- **Sound** (v0.4.2): a ring layer over the persistent body (`physics/ring.ts`, CPU reference `render/ring.ts`): the
  same grains re-form as a circular particle spectrum (bass at the bottom, treble at the top) around a small core; and
  an audio field on the sphere (`physics/audioField.ts`). Both are driven by one `AudioVisualFrame` per frame and are
  zero without sound.
- **3D objects** (v0.4): `formedTarget()` turns a formed target by yaw, pitch and zoom (identity for flat
  visuals). While it is 3D, tone follows depth and the ripple is reduced. The orbit controller
  (`interaction/orbit.ts`) turns it slowly and lets the user drag, zoom and reset; `toWorld()` maps a screen point
  to the body's plane (the figure points at a card's term with it).

## Host Adapter (`src/host`)

```text
Codex ──stdio──► MCP server ──► PresenceLink ──► PresenceHub (in this process, or another Aion MCP process)
                     └──► Visual Resolver ──https──► public data (allowlist)
Codex hooks ──► aion-hook.mjs ──loopback HTTP──► PresenceHub
```

- **Presence hub** (`hub/`): state on `127.0.0.1` with a per-user token and loopback `Host` check; SSE for
  companion windows (each with its own id), long-poll for embedded views, media by id, hook intake, the answer
  tail, and companion windows' reports about themselves (focused, fullscreen, visible — nothing else) so "Open
  Aion" knows whether to bring a new window forward (the old one retires). Every command is re-validated.
- **MCP server** (`mcp/server.ts`): SCF's visual vocabulary plus the host tools; SCF's tuned descriptions; v0.4.4 keeps the
  tool metadata inside a budget (`mcp/budget.ts`, [MCP-TOOLS.md](MCP-TOOLS.md));
  `greeting.due` once per newly opened Presence; app-only tools only for MCP Apps hosts.
- **Geography** (`geo/`, v0.4.1): the bundled offline world (Natural Earth: countries, named parts, Chinese names,
  groups, a gazetteer), region and place resolution (offline first, then Nominatim/Photon, markers bounded to the view),
  the map builder (focus, borders, neighbours). The resolver caches regions and places; terrain uses the same regions.
- **Visual Resolver** (`resolver/`): SCF's resolver moved from the browser into Node. `net.ts` is the only path to
  the network: HTTPS to a fixed allowlist, no redirects, timeouts, byte limits, type and magic-byte checks, an
  identifying User-Agent. Images: curated local assets (the Spirit Connect logo), then Wikipedia → Commons →
  Openverse by intent, ranked as in SCF, dimensions checked from the header. An article without a lead image falls
  back to the image its Wikidata item names (only the item id is sent); a portrait never takes something named after
  the person (a museum, a company, a statue). Terrain: the region (see Geography) → its
  equal-area frame → AWS terrarium tiles (decoded exactly by a small PNG decoder) resampled into that frame → SCF's height
  field, carrying its frame → compact bytes. Results become
  local media; the surface never contacts a remote host.
- **Routes** (`route/`, v0.6): routing providers (Valhalla by default — FOSSGIS's public server under its fair-use
  policy, or the user's own — and OpenRouteService with the user's key; `providers.ts`), elevation along a path from the
  terrain tiles (`elevation.ts`), the planner that turns places into one validated GeoRoute (`planner.ts`,
  `src/visual/geo/route.ts`), and OpenStreetMap map tiles for the card, fetched only as viewed and cached by OSM's policy
  (`tiles.ts`, served by the hub at `GET /tile/z/x/y` only around the open route). [ROUTE-EXPLORER.md](ROUTE-EXPLORER.md)
- **FreeCAD** (`cad/`, v0.7): `freecad.ts` finds FreeCAD's `freecadcmd` and supervises one worker process per MCP server
  (`plugins/aion-presence/cad/aion_freecad_worker.py`: requests on stdin, responses on fd 3, FreeCAD transactions);
  `commands.ts` is the strict schema of `cad_model`'s actions; `preview.ts` turns the worker's per-feature tessellation
  into a GLB for the CAD viewer; `desktop.ts` hands a saved document to the FreeCAD application. [FREECAD.md](FREECAD.md)
- **Hooks** (`hooks/`): event → activity, own tools ignored, `Stop` after `responding` → complete.
- **Audio bridge** (`audio/bridge.ts`, v0.4.2): the hub's end of the macOS Aion Audio Bridge — a private Unix socket, the
  shared analyser at 60 Hz, features out as `event: audio` on the companion stream. Started only when the user asks.
- **Codex Voice Sync** (`audio/voiceSync.ts`, v0.4.3): the user's remembered opt-in; the hub connects Codex's voice while
  a companion window is open and reconnects with bounded backoff (policy in `src/audio/voiceSync.ts`).
- **Writing** (`writing/`, v0.4.4): the Chinese Writing Pack read lazily from the installed plugin (`chinesePack.ts`), and the
  Writing Education Core's lookup (`resolve.ts`): text → a writing source (Chinese characters with their data, simplified ↔
  traditional; English letters and words; curated symbols), with the dictionary's facts for Codex.
- **Music** (`music.ts`, v0.4.2): tool arguments → validated scores, note facts, lesson moves, answers.
- **First run** (`firstRun.ts`): a marker in plugin data; the first session after installation opens the
  companion window once (`autoOpen`: first-run | always | never). v0.6: Aion's own window is the default surface
  everywhere (`surface.ts`; embedded only on request); the hub carries a launch guard so several conversations open one
  window, and the first-run welcome's state (`welcome-complete`), which the window shows (`src/surface/welcome.ts`). v0.7:
  the window speaks it — `src/core/welcomeNarration.ts` (script, voice choice, lifecycle) and
  `src/surface/welcomeSpeech.ts` (the browser's on-device synthesizer).

## Presence Surface (`src/surface`)

One page, built into a single HTML file, is both the MCP Apps resource and the companion page.
`PresenceView` drives Aion Core from snapshots, renders each presentation by its route — body visuals (forms,
glyphs, emoji from the system font, images framed by their fit, height fields) through the Visual Action
controller, cards through `card.ts` (the original picture, never the particle raster; a shaded relief from the
real height field for terrain) — and runs local listening: `microphone.ts` (SCF's `MicrophoneListener`) is the only
file that opens the microphone; it reduces each block of samples to one RMS number and nothing else leaves it.
Refused or unavailable, Aion follows the host's states and says so once.

```text
Aion Core (state, engine, body, Presentation Router)  ·  Aion Renderer (WebGPU, canvas)
                         │
                  Surface Adapter
     ├── MCP Apps        transports/mcpApps.ts — host display modes
     ├── Browser companion  transports/companion.ts + immersive.ts — app window, Enter Presence, fullscreen
     └── Desktop (future)   a native shell: one more transport with its own window controls
```

Sound and music (v0.4.2): `audioVisual.ts` gathers every source's features (the microphone, a shared tab via
`capture.ts`, the Music Library's `music/player.ts`, and the hub's bridge features) and applies the source policy;
`music/notation.ts` engraves scores with VexFlow and Bravura for the music card; the player schedules notes on the
audio clock and the card lights each as it is heard.

Writing (v0.4.3): `writing.ts` drives the renderer's writing uniforms from the playback in the snapshot, and the card's
stroke-order diagram (`strokeCard.ts`) follows the same moment; an action sequence makes the figure perform while
`scene.ts` draws its objects on an overlay at projected positions.

v0.6: a route is drawn by the same overlay (`markers.ts`): a luminous line through `markerWorldPoint` at the terrain's
relief, A and B, and the Route Explorer card's highlight, section and pointer (the card's `CURSOR` reaches the page
directly). The view keeps a terrain formed when the next presentation forms the same height field (a route planned on
it, reversed, or closed), so the land is never formed again for these.

Places marked on a map or terrain are drawn by `markers.ts` on an overlay above the particles (glowing grains, a pulse,
a crisp label; pins on terrain) at the screen position the renderer's `project()` gives their coordinates, every frame;
marker changes never re-form the visual. Aion's colours arrive in the snapshot: the renderer eases its palette
(`render/palette.ts`, WebGPU uniforms and the canvas fallback alike) and the accent becomes a CSS variable.

Browser fullscreen, window sizing and gestures live only in the surface adapter (`immersive.ts`), never in Aion
Core or the renderer.

Interactive cards (v0.4.5): `cards/host.ts` is the Interactive Application Container — it creates a sandboxed frame
(opaque origin, no network) from the card runtime (`src/cards/runtime`, a separate Three.js WebGL bundle embedded as a
string), hands it one MessagePort (`cards/bridge.ts`, validated against `src/cards/protocol.ts`), drives the lifecycle
(`src/cards/lifecycle.ts`), draws the universal controls and reports meaningful state to the hub (`POST /api/card`, or
the app-only `presence_card` tool when embedded). The hub keeps the card (`src/cards/state.ts`) beside the
presentation; the view frames the body by the card's layout and points toward the selected object when the application
reports exactly where it is. See [CARDS.md](CARDS.md).

## The Generative Visual Engine (`src/scene`, v0.5)

A renderer-independent Scene IR (`ir.ts`) that Codex writes as data, validated strictly (`validate.ts`), changed only
by transactional patches (`patch.ts`) with revisions and history (`history.ts`, kept by the hub's store on the card),
animated by a pure, frame-rate-independent engine (`animation.ts`), checked against what the runtime can honestly do
(`capabilities.ts`), and routed to the body, a card or both by Presentation Router 2.0 (`router.ts`). Two adapters render
it: the particle adapter (`particleAdapter.ts`, into the body's own 3D scenes) and the `generative-scene` card
(`src/cards/apps/generativeScene`: a reconciling Scene Compiler on the v0.4.5 ViewerEngine). The card receives
revisions over the Card Bridge (`LOAD_SCENE`, gated by the `scene-documents` capability) and confirms what it built.
See [GENERATIVE-VISUAL-ENGINE.md](GENERATIVE-VISUAL-ENGINE.md).

## Plugin package and distribution (`plugins/aion-presence`)

A portable Agent Plugins package: `plugin.json` (with `extensions.com.openai.interface`), `mcp.json`, `skills/`,
`hooks/hooks.json`, `assets/` and the built `runtime/`. The runtime is **committed**, so a Git install needs no
build; `npm run runtime:check` (CI) fails if it differs from what the sources build. The repository's
marketplace is `spirit-connect`: `codex plugin marketplace add FulongLi/Aion-Presence-Plugin` then
`codex plugin add aion-presence@spirit-connect`. `scripts/install.mjs` is the one-command fallback;
`npm run release` builds a reproducible archive.

## Extension points

- **Real host audio**: a `HostAudioSource`; the engine then drives SCF's speech motion and echo guard. No host
  exposes one to plugins today (see [HOST.md](HOST.md)). The v0.4 macOS experiment and its integration plan:
  [AUDIO-BRIDGE.md](AUDIO-BRIDGE.md).
- **Another body**: one entry in `PERSISTENT_BODIES`, one layer weight in `AionBody`, one rest function evaluated in
  compute, material and the canvas fallback.
- **Another 3D primitive**: one entry in the scene schema and validator, one builder case, its triangle bound.
- **A desktop shell** (e.g. Tauri): the same page and renderer, one more surface adapter for window, always-on-top
  and fullscreen controls the browser cannot offer.
- **Another host**: a transport in `src/surface/transports` and, if it is not an MCP client, an adapter that sends
  hub commands.
- **Another visual pack**: one more entry in `VISUAL_FORM_PACKS`. Another image source: one more provider.
- **Another interactive application** (v0.4.5): a manifest in `src/cards/registry.ts` and a module in
  `src/cards/runtime/apps.ts`; the router, bridge, hub and MCP tools take it unchanged ([CARDS.md](CARDS.md)).
- **Another scene geometry or animation** (v0.5): one entry in `src/scene/ir.ts`, its fields in `validate.ts` (and its
  triangle cost), a builder in `src/cards/apps/generativeScene/geometry.ts` or a case in `animation.ts`, and (if the
  body can form it) a case in `particleAdapter.ts`.
- **A computational or CAD backend** (v0.5, interface only): `src/scene/cad.ts`; its capabilities register as
  `compute:*` in the router ([FUTURE-CAD-INTEGRATION.md](FUTURE-CAD-INTEGRATION.md)).
