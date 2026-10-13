# Aion Presence: architecture

Aion Presence separates **who does the work** from **how it is seen**. The host agent (Codex today) is the
intelligence. Aion is SCF Presence's Presence with its AI transport replaced by the host:

```text
SCF:     OpenAI Realtime / GPT-Live ─► Presence Core
Plugin:  Codex (the host agent)     ─► Host Adapter ─► Presence Core ─► particle renderer ─► Presence Surface
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
| `figure/` | Figure 2.0: skeleton, the clean particle layout (strokes, head ring, joint beads), poses with two-bone IK (`pose.ts`), and the Expressive Motion System (`motion.ts`: eased keyframe clips, per-state tracks, gestures, the explanation cue). See [FIGURE.md](FIGURE.md). |
| `eyes/` | Aion Eyes (v0.4.1 cartoon design): one luminous shape per eye, bound by direction and share of the outline's reach (`layout.ts`, with its CPU reference), expressions as shapes, spring-driven motion with entries, tempo, blinks and saccades (`expression.ts`). See [EYES.md](EYES.md). |
| `colors.ts` | Aion's colours (v0.4.1): parsing (English and Chinese names, presets, hex), the particle palette (Aion Silver exact; others scaled, saturated and lifted to read on black), the accent. See [COLORS.md](COLORS.md). |
| `audio.ts` | `HostAudioSource`, the seam for real assistant audio: `NO_HOST_AUDIO`, or Codex's voice through the native bridge (v0.4.2, `surface/audioVisual.ts`). |
| `presentationRouter.ts` | The Presentation Router: BODY, CARD or HYBRID for each presentation, from its kind, size, origin and fidelity needs, an optional preference (`auto` by default) and the surface's capabilities. Pure policy; deterministic overrides of clearly bad requests. |
| `presentation.ts`, `store.ts` | What can be presented (form, text, result, image with fit, size and origin, terrain with its elevation, clock, number, symbol, emoji, artifact), routed; separate body and card lifetimes (SCF's hold times for the body, counted as time formed); a new topic retires temporary cards; the revisioned store. |
| `visual/` | Visual forms (Tao, celestial, symbols), target sampling incl. SCF's 2.5D height-field sampler, intent-driven `normalizeImage` (portrait band, map, object, logo; the heritage oval, `oval.ts`), height-field codec, SVG checks, validators, the Visual Action controller. |
| `visual/geo/` | Geography (v0.4.1), pure and shared: equal-area projections and frames (`projection.ts`), spherical extents — the primary part of a scattered region, windows (`extent.ts`), map geometry projected, densified and clipped, with its `AMP1` codec (`map.ts`), and `markerWorldPoint`, a place's position on a formed map or terrain through the samplers' own geometry (`markers.ts`). See [MAPS.md](MAPS.md). |
| `audio/` (v0.4.2) | The Audio Analysis Engine (`analyzer.ts`: the only FFT; loudness, 32 log bands, onsets, beats, voice), the common feature format, the feature bus, the source policy (`route.ts`), the music detector, settings and the compact wire form. Pure. See [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md). |
| `music/` (v0.4.2) | The Music Library: theory (pitch, rhythm, scales), notation (staff positions, the validated score, audio-clock scheduling), lessons in English and Chinese, practice questions, and the body's music symbols (Bravura outlines). Pure. See [MUSIC.md](MUSIC.md). |
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
- **MCP server** (`mcp/server.ts`): SCF's visual vocabulary plus the host tools; SCF's tuned descriptions;
  `greeting.due` once per newly opened Presence; app-only tools only for MCP Apps hosts.
- **Geography** (`geo/`, v0.4.1): the bundled offline world (Natural Earth: countries, named parts, Chinese names,
  groups, a gazetteer), region and place resolution (offline first, then Nominatim/Photon, markers bounded to the view),
  the map builder (focus, borders, neighbours). The resolver caches regions and places; terrain uses the same regions.
- **Visual Resolver** (`resolver/`): SCF's resolver moved from the browser into Node. `net.ts` is the only path to
  the network: HTTPS to a fixed allowlist, no redirects, timeouts, byte limits, type and magic-byte checks, an
  identifying User-Agent. Images: curated local assets (the Spirit Connect logo), then Wikipedia → Commons →
  Openverse by intent, ranked as in SCF, dimensions checked from the header. Terrain: the region (see Geography) → its
  equal-area frame → AWS terrarium tiles (decoded exactly by a small PNG decoder) resampled into that frame → SCF's height
  field, carrying its frame → compact bytes. Results become
  local media; the surface never contacts a remote host.
- **Hooks** (`hooks/`): event → activity, own tools ignored, `Stop` after `responding` → complete.
- **Audio bridge** (`audio/bridge.ts`, v0.4.2): the hub's end of the macOS Aion Audio Bridge — a private Unix socket, the
  shared analyser at 60 Hz, features out as `event: audio` on the companion stream. Started only when the user asks.
- **Music** (`music.ts`, v0.4.2): tool arguments → validated scores, note facts, lesson moves, answers.
- **First run** (`firstRun.ts`): a marker in plugin data; the first session after installation opens the
  companion window once (`autoOpen`: first-run | always | never).

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

Places marked on a map or terrain are drawn by `markers.ts` on an overlay above the particles (glowing grains, a pulse,
a crisp label; pins on terrain) at the screen position the renderer's `project()` gives their coordinates, every frame;
marker changes never re-form the visual. Aion's colours arrive in the snapshot: the renderer eases its palette
(`render/palette.ts`, WebGPU uniforms and the canvas fallback alike) and the accent becomes a CSS variable.

Browser fullscreen, window sizing and gestures live only in the surface adapter (`immersive.ts`), never in Aion
Core or the renderer.

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
