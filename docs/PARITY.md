# Presence parity: SCF Presence Realtime → Aion Presence Plugin

This is the tracking document for porting the mature Presence experience of
[SCF-Presence-Realtime](https://github.com/FulongLi/SCF-Presence-Realtime) (the reference, read-only) into this
plugin while keeping Codex as the intelligence.

```text
SCF:     OpenAI Realtime / GPT-Live ─► Presence Core
Plugin:  Codex (the host agent)     ─► Presence Core
```

**Do not redesign Presence. Port Presence. Replace only its AI transport.**

- Audited against SCF `origin/main` at `44fe4e6` (2026-10-01) and this repository at `a01db2f` (v0.1.0 MVP).
- Paths: SCF `src/…` on the left; plugin `src/…` on the right.
- *Final state* is only set to **parity** once the behaviour is implemented **and** covered by a test or the
  browser smoke run. Until then it says **pending**.

## Legend

| Plugin current state | Meaning |
| --- | --- |
| **present** | Ported and behaving as in SCF (verified line by line or by tests). |
| **partial** | Ported, but part of the behaviour or quality is missing. |
| **missing** | Not in the plugin. |
| **incompatible** | Deliberately excluded in plugin mode (it belongs to SCF's AI transport). |

## Matrix

### Identity, state and body

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Aion identity | `aion/identity.ts` frozen manifest | **present** (`core/identity.ts`, + embodiment statement) | Keep; greeting line built from it. | pending |
| Sphere | `particle/sphere/createSphere.ts`, `ParticleRuntime` | **present** (identical) | Keep. | pending |
| Particle Figure | `aion/figure/{skeleton,layout}.ts`, `physics/figure.ts` | **present** (identical) | Keep. | pending |
| Figure gestures | `aion/figure/pose.ts` greeting / acknowledging / speaking | **present** (+ work-state poses) | Add a restrained semantic `responding` pose; keep greeting. | pending |
| Idle | `PresenceEngine` field targets, idle pose | **present** | Keep. | pending |
| Listening | local mic VAD → `listening` mode, focus, user amplitude, listening pose | **partial**: pose and field exist but nothing drives them (no microphone) | Port the microphone pipeline (below); local VAD drives listening. | pending |
| Thinking | backend turn events → `thinking` | **present** via hooks (`UserPromptSubmit`) | Also infer a short thinking after a finished local utterance (SCF offline rule). | pending |
| Responding / speaking | real assistant audio → `speaking` (amplitude, spectrum, speech motion) | **missing**: no host audio, and no semantic response state (Aion looks idle while Codex answers) | New semantic `responding` state (Skill-driven), distinct from audio-driven `speaking`; `HostAudioSource` kept for real audio. | pending |
| Reading | — (plugin only) | **present** (hooks) | Keep. | pending |
| Editing | — (plugin only) | **present** (hooks) | Keep. | pending |
| Testing | — (plugin only) | **present** (hooks) | Keep. | pending |
| Building | — (plugin only) | **present** (hooks) | Keep. | pending |
| Completion | — (plugin only) | **present** (`Stop` hook → complete → idle) | Keep; `responding` → complete → idle. | pending |
| Error | — (plugin only) | **present** | Keep. | pending |
| Pointer interaction | `particle/interaction/pointer.ts`, pusher physics | **present** (identical) | Keep. | pending |
| Morphing | `visual-actions/controller.ts`, `physics/morph.ts`, `morphBlend.ts` | **present** (controller generic over requests) | Keep; restore SCF hold times per visual kind. | pending |
| Persistent body return | body rest layer under every visual | **present** | Keep; test figure → portrait / terrain / Orion → figure. | pending |
| Adaptive quality | `particle/quality.ts` | **present** (+ effects shed first) | Keep. | pending |

### Visuals

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Portrait | `show_portrait` → Wikipedia → web → Openverse → Commons; `normalizeImage(…, "portrait")` head-and-shoulders crop; portrait sampling | **missing** (no lookup); local images always sampled as *object* — the Nikola Tesla regression | Port the resolver chain server-side; `show_portrait`; portrait intent carried to the surface so it uses the portrait crop and sampling. | pending |
| General image | `show_image(query, intent)` → curated local assets → provider chain by intent → ranked → downloaded → normalized | **partial**: local files / data URLs only | `show_image` takes exactly one of `source` (local) or `query` (+ `intent`); remote bytes validated server-side and handed over as local media. | pending |
| Terrain | `show_terrain` → Nominatim/Photon → AWS terrarium tiles → height field (masked, smoothed, percentile-normalized) → 2.5D hillshaded relief | **missing** (`points.ts` had the height-field sampler removed) | Port geocoding, tiles, a Node PNG decoder for exact elevations, `buildHeightField`, and the 2.5D sampler; styles terrain/topography/relief/heightmap. | pending |
| Clock | `show_clock` → canvas glyph, local time, result tells the model the time | **missing** (only via `show_text`) | `show_clock({ time? })`; the result reports the local time. | pending |
| Number | `show_number` (≤ 12 chars, validated) | **partial** (via `show_text`) | `show_number({ value })`. | pending |
| Text | `show_text` (≤ 16 chars as glyphs) | **present** (+ longer text beside the body) | Keep, with SCF's description. | pending |
| Symbol | `show_symbol` (12 symbols, canvas paths) | **partial**: check, cross, exclamation… as an ink form pack; no tool | `show_symbol({ symbol })` over the symbol pack, covering SCF's 12 names. | pending |
| Emoji | `show_emoji` → system emoji font raster → emoji sampling; one-grapheme validation | **missing** (the sampler style exists, unused) | Port the emoji rasterizer and validation; `show_emoji`. | pending |
| Tao | `visual-forms/tao` (yin-yang, lines) | **present** (identical) | Keep. | pending |
| Trigrams | `visual-forms/tao/trigrams.ts` | **present** (identical) | Keep. | pending |
| Bagua | `visual-forms/tao` (earlier / later heaven) | **present** (identical) | Keep. | pending |
| Constellations | `visual-forms/celestial/astronomy` | **present** (identical) | Keep. | pending |
| Zodiac | `visual-forms/celestial/astrology` | **present** (identical) | Keep. | pending |
| Visual hold / return | `HOLD_SECONDS` per action, controller return | **partial**: plugin holds differ (form 12 s, image 16 s) | SCF hold times for SCF visuals. | pending |
| Image normalization | `transforms/crop.ts` by intent (portrait band, map untrimmed, object trim) | **partial** (`visual/image.ts`: two styles, not driven by intent) | Port `normalizeImage(image, intent)`. | pending |
| Curated local assets | `sources/localAssets.ts` (Spirit Connect logo, logo normalization) | **missing** | Port the matcher; the logo ships in the plugin's assets. | pending |

### Conversation

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Greeting | `aion/greeting.ts` gate (ready + quiet → greet once), `greetingLine`, wave gesture | **partial**: wave on open; no spoken/text introduction; no quiet gate | Gesture waits for a quiet moment; `open_presence` reports a greeting due once per new Presence session; the Skill gives the canonical introduction. | pending |
| Onboarding | `aion/guidance.ts` examples backed by tools, `onboardingGuidance` | **missing** | Port as Skill guidance; examples tested against the real tool schemas. | pending |
| Natural-language visual intent | `voice/visualGuidance.ts`, tuned tool descriptions | **missing** (one-line descriptions) | Port tool descriptions and rules into the MCP tools and a Visual Intent Policy in the Skill. | pending |
| Local microphone analysis | `audio/microphone/MicrophoneListener.ts` (track processor / analyser, local only) | **missing** (deliberately removed in v0.1) | Port; only RMS leaves the audio thread; no recording, storage, upload or STT. | pending |
| RMS / VAD | `audio/analyser.ts` `rms`, `microphone/vad.ts` | **missing** | Port as is. | pending |
| Voice emphasis | `microphone/emphasis.ts` → focus impulse | **missing** | Port as is. | pending |
| Echo guard | `PresenceEngine`: mic ignored while assistant audio is audible and 0.4 s after | **missing** | Semantic guard: no listening during `responding` and a short hold after; pluggable for real host audio. | pending |
| Mic permission fallback | `controller.ts` mic states (prompt / denied / unavailable) | n/a | Request on open; denied → semantic host states only. | pending |

### Surfaces, host and distribution

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Embedded surface | — (SCF is a web app) | **present** (MCP Apps, only when declared) | Keep; declare the microphone permission (feature-detected). | pending |
| Companion surface | — | **present** (Chromium app window) | Keep. | pending |
| Fullscreen | browser fullscreen | **present** (host display modes / browser API) | Keep. | pending |
| Codex hooks | — | **present** | Add the new tools to Aion's own-tool list; `responding` precedence. | pending |
| Codex Skill | — | **present** | Rewrite: identity, embodiment, greeting, onboarding, responding, Visual Intent Policy, restraint. | pending |
| MCP | — | **present** (9 tools) | SCF tool vocabulary restored; existing tools kept. | pending |
| Direct installation | — | **missing**: runtime not committed, so a Git install has no runtime | Commit the built runtime (CI keeps it in sync); `codex plugin marketplace add FulongLi/Aion-Presence-Plugin`. | pending |
| First-run launch | — | **missing** | First-run marker in plugin data; the first session opens Aion once. | pending |

### Intentionally excluded (not ported)

| SCF | Why |
| --- | --- |
| `src/realtime/*`, `src/live/*`, `src/voice/{webrtc,client,backend}.ts` | The AI transport. Codex is the intelligence. |
| `src/server/{realtimeToken,liveSession}.ts`, `src/app/api/{realtime,live}` | OpenAI sessions and keys. Plugin mode makes zero model API calls. |
| `src/audio/assistant.ts`, `src/audio/spectrum.ts` analysis of the model's own audio | No assistant audio exists in plugin mode; `HostAudioSource` is the seam for a host that exposes it. |
| `src/promo/*`, `src/particle/formation.ts`, `scripts/promo/*` | Promo film infrastructure. |
| `src/dev/debugPanel.ts` | Replaced by the surface's `?debug=1` line. |
