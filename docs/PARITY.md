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
- *Final state* names the test or check that proves it: **parity** (SCF behaviour, ported), **adapted** (the
  plugin architecture required a different mechanism; the difference is stated), **present** (plugin-only,
  kept and verified).

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
| Aion identity | `aion/identity.ts` frozen manifest | **present** (`core/identity.ts`, + embodiment statement) | Kept; greeting and Skill read the manifest. | **parity** — core.test (literals only in the manifest), skill.test |
| Sphere | `particle/sphere/createSphere.ts`, `ParticleRuntime` | **present** (identical) | Kept. | **parity** — smoke (WebGPU and canvas) |
| Particle Figure | `aion/figure/{skeleton,layout}.ts`, `physics/figure.ts` | **present** (identical) | Kept. | **parity** — smoke, core.test |
| Figure gestures | `aion/figure/pose.ts` greeting / acknowledging / speaking | **present** (+ work-state poses) | Greeting wave now waits for a quiet moment; restrained semantic `responding` pose added. | **parity** — core.test, conversation.test |
| Idle | `PresenceEngine` field targets, idle pose | **present** | Kept. | **parity** — core.test |
| Listening | local mic VAD → `listening` mode, focus, user amplitude, listening pose | **partial**: pose and field exist but nothing drives them (no microphone) | Local VAD drives listening through `PresenceEngine` (SCF's engine with the host as transport). | **parity** — conversation.test (real VAD), smoke (fake microphone) |
| Thinking | backend turn events → `thinking` | **present** via hooks (`UserPromptSubmit`) | Hooks, plus SCF's inferred thinking after a finished utterance (≤ 6 s). | **parity** — conversation.test |
| Responding / speaking | real assistant audio → `speaking` (amplitude, spectrum, speech motion) | **missing**: no host audio, and no semantic response state (Aion looks idle while Codex answers) | `responding` state (Skill), sphere swell and figure pose; `speaking` stays real-audio only via `HostAudioSource`. | **adapted** (no host audio exists) — conversation.test, smoke, codex:verify |
| Reading | — (plugin only) | **present** (hooks) | Kept. | **present** — hooks.test |
| Editing | — (plugin only) | **present** (hooks) | Kept. | **present** — hooks.test |
| Testing | — (plugin only) | **present** (hooks) | Kept. | **present** — hooks.test, codex:verify (real hook) |
| Building | — (plugin only) | **present** (hooks) | Kept. | **present** — hooks.test |
| Completion | — (plugin only) | **present** (`Stop` hook → complete → idle) | `Stop` after `responding` → complete → idle. | **present** — conversation.test |
| Error | — (plugin only) | **present** | Kept. | **present** — store.test |
| Pointer interaction | `particle/interaction/pointer.ts`, pusher physics | **present** (identical) | Kept. | **parity** — identical source |
| Morphing | `visual-actions/controller.ts`, `physics/morph.ts`, `morphBlend.ts` | **present** (controller generic over requests) | Kept; SCF hold times restored, counted as time formed. | **parity** — store.test, smoke |
| Persistent body return | body rest layer under every visual | **present** | Kept. | **parity** — conversation.test, smoke (figure → Tesla / UK terrain / Orion → figure) |
| Adaptive quality | `particle/quality.ts` | **present** (+ effects shed first) | Kept. | **parity** — render.test |

### Visuals

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Portrait | `show_portrait` → Wikipedia → web → Openverse → Commons; `normalizeImage(…, "portrait")` head-and-shoulders crop; portrait sampling | **missing** (no lookup); local images always sampled as *object* — the Nikola Tesla regression | Resolver chain ported (server side); `show_portrait`; fit carried to the surface → SCF crop and portrait sampling. | **parity** — resolver.test, visualTools.test, smoke, codex:verify (live Nikola Tesla; Einstein, da Vinci checked live) |
| General image | `show_image(query, intent)` → curated local assets → provider chain by intent → ranked → downloaded → normalized | **partial**: local files / data URLs only | `show_image` takes `query` (+ intent) or `source`; bytes checked server-side, handed over as local media. | **parity** — resolver.test, visualTools.test |
| Terrain | `show_terrain` → Nominatim/Photon → AWS terrarium tiles → height field (masked, smoothed, percentile-normalized) → 2.5D hillshaded relief | **missing** (`points.ts` had the height-field sampler removed) | Geocoding, tiles, exact PNG decode, height field, byte codec, 2.5D sampler restored. The approximate relief-image fallback is not ported (it needs JPEG decoding in Node). | **parity** (real elevation) — resolver.test, smoke, codex:verify (UK; Scotland, Wales, Swiss Alps, Grand Canyon checked live) |
| Clock | `show_clock` → canvas glyph, local time, result tells the model the time | **missing** (only via `show_text`) | `show_clock`; the result tells Codex the local time. | **parity** — visualTools.test, smoke |
| Number | `show_number` (≤ 12 chars, validated) | **partial** (via `show_text`) | `show_number` with SCF's validation (plus short units). | **parity** — visualTools.test, smoke |
| Text | `show_text` (≤ 16 chars as glyphs) | **present** (+ longer text beside the body) | Kept, SCF description. | **parity** — store.test, smoke |
| Symbol | `show_symbol` (12 symbols, canvas paths) | **partial**: check, cross, exclamation… as an ink form pack; no tool | `show_symbol` over the symbol pack (SCF's 12 names, drawn as ink forms rather than canvas glyphs). | **adapted** — visualTools.test |
| Emoji | `show_emoji` → system emoji font raster → emoji sampling; one-grapheme validation | **missing** (the sampler style exists, unused) | SCF's system-font rasterizer and grapheme validation; `show_emoji`. | **parity** — visualTools.test, smoke |
| Tao | `visual-forms/tao` (yin-yang, lines) | **present** (identical) | Kept. | **parity** — identical source, smoke |
| Trigrams | `visual-forms/tao/trigrams.ts` | **present** (identical) | Kept. | **parity** — identical source |
| Bagua | `visual-forms/tao` (earlier / later heaven) | **present** (identical) | Kept. | **parity** — identical source |
| Constellations | `visual-forms/celestial/astronomy` | **present** (identical) | Kept. | **parity** — identical source, smoke |
| Zodiac | `visual-forms/celestial/astrology` | **present** (identical) | Kept. | **parity** — identical source |
| Visual hold / return | `HOLD_SECONDS` per action, controller return | **partial**: plugin holds differ (form 12 s, image 16 s) | SCF holds per kind, counted as time formed. | **parity** — store.test |
| Image normalization | `transforms/crop.ts` by intent (portrait band, map untrimmed, object trim) | **partial** (`visual/image.ts`: two styles, not driven by intent) | SCF's `normalizeImage(image, intent)` ported (portrait, map, object, logo). | **parity** — visual.test, resolver.test |
| Curated local assets | `sources/localAssets.ts` (Spirit Connect logo, logo normalization) | **missing** | Matcher ported; the logo ships in `assets/brand/`. | **parity** — resolver.test, visualTools.test |

### Conversation

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Greeting | `aion/greeting.ts` gate (ready + quiet → greet once), `greetingLine`, wave gesture | **partial**: wave on open; no spoken/text introduction; no quiet gate | `greeting.due` once per newly opened Presence; wave gated on body + quiet; Codex introduces Aion. | **parity** (Codex speaks it) — visualTools.test, firstRun.test, codex:verify |
| Onboarding | `aion/guidance.ts` examples backed by tools, `onboardingGuidance` | **missing** | Examples backed by real tools; brief answers in the Skill and server instructions. | **parity** — skill.test (examples pass the real schemas) |
| Natural-language visual intent | `voice/visualGuidance.ts`, tuned tool descriptions | **missing** (one-line descriptions) | SCF descriptions in the tools; Visual Intent Policy in the Skill. | **parity** — skill.test (every policy row passes its tool's schema) |
| Local microphone analysis | `audio/microphone/MicrophoneListener.ts` (track processor / analyser, local only) | **missing** (deliberately removed in v0.1) | Ported unchanged; only RMS leaves the audio path; one file opens the microphone. | **parity** — apiIndependence.test, smoke |
| RMS / VAD | `audio/analyser.ts` `rms`, `microphone/vad.ts` | **missing** | Ported unchanged. | **parity** — identical source, conversation.test |
| Voice emphasis | `microphone/emphasis.ts` → focus impulse | **missing** | Ported unchanged. | **parity** — identical source |
| Echo guard | `PresenceEngine`: mic ignored while assistant audio is audible and 0.4 s after | **missing** | Semantic guard (responding + 2.5 s hold); SCF's audio guard when a host exposes audio. | **adapted** — conversation.test |
| Mic permission fallback | `controller.ts` mic states (prompt / denied / unavailable) | n/a | Requested on open; denied → host states only. | **parity** — conversation.test, smoke (refused context) |

### Surfaces, host and distribution

| Capability | SCF implementation | Plugin current state (v0.1) | Action taken | Final state |
| --- | --- | --- | --- | --- |
| Embedded surface | — (SCF is a web app) | **present** (MCP Apps, only when declared) | Kept; declares the microphone permission. | **present** — smoke (MCP Apps host) |
| Companion surface | — | **present** (Chromium app window) | Kept. | **present** — smoke, codex:verify |
| Fullscreen | browser fullscreen | **present** (host display modes / browser API) | Kept. | **present** — smoke |
| Codex hooks | — | **present** | Own tools derived from the tool list; responding precedence. | **present** — hooks.test, conversation.test, codex:verify |
| Codex Skill | — | **present** | Rewritten. | **present** — skill.test, codex:verify (in the model's skill list) |
| MCP | — | **present** (9 tools) | 16 tools: SCF vocabulary + host tools; v0.1 tools kept. | **present** — mcp.test, visualTools.test |
| Direct installation | — | **missing**: runtime not committed, so a Git install has no runtime | Runtime committed; `spirit-connect` marketplace; `scripts/install.mjs`; release archive. | **present** — codex:verify (Git install from a served HEAD, and the installer); GitHub itself pending a push |
| First-run launch | — | **missing** | Marker in plugin data; first session opens Aion once; introduction still due. | **present** — firstRun.test, codex:verify |

### Intentionally excluded (not ported)

| SCF | Why |
| --- | --- |
| `src/realtime/*`, `src/live/*`, `src/voice/{webrtc,client,backend}.ts` | The AI transport. Codex is the intelligence. |
| `src/server/{realtimeToken,liveSession}.ts`, `src/app/api/{realtime,live}` | OpenAI sessions and keys. Plugin mode makes zero model API calls. |
| `src/audio/assistant.ts`, `src/audio/spectrum.ts` analysis of the model's own audio | No assistant audio exists in plugin mode; `HostAudioSource` is the seam for a host that exposes it. |
| `src/promo/*`, `src/particle/formation.ts`, `scripts/promo/*` | Promo film infrastructure. |
| `src/dev/debugPanel.ts` | Replaced by the surface's `?debug=1` line. |

## Where exact SCF parity was not possible

| Area | Why | What the plugin does |
| --- | --- | --- |
| Speaking (audio-driven motion, speech accents, spectrum) | No host exposes assistant audio to plugins today. | Semantic `responding`; `HostAudioSource` takes real audio the day a host offers it. |
| Echo / barge-in | SCF compared the microphone with the model's own audio track. | Conservative semantic guard; no barge-in claimed. |
| Terrain relief-image fallback | It approximates height from a JPEG relief map, which would need a JPEG decoder in Node. | Real elevation only (the primary SCF path); unavailable data fails as `terrain-unavailable`. |
| Symbols | SCF drew them with canvas paths; the resolver now runs where there is no canvas. | The same 12 symbols as ink forms (SCF's own ink style). |
| Greeting voice | SCF's voice session spoke the line. | Codex gives the introduction in its own text or voice. |
