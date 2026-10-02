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
| `body.ts`, `figure/` | Persistent body (sphere, figure), skeleton, layout, poses (work states, a restrained semantic `responding`). |
| `audio.ts` | `HostAudioSource`, the seam for a host that someday exposes assistant audio. Today: `NO_HOST_AUDIO`. |
| `presentationRouter.ts` | The Presentation Router: BODY, CARD or HYBRID for each presentation, from its kind, size, origin and fidelity needs, an optional preference (`auto` by default) and the surface's capabilities. Pure policy; deterministic overrides of clearly bad requests. |
| `presentation.ts`, `store.ts` | What can be presented (form, text, result, image with fit, size and origin, terrain with its elevation, clock, number, symbol, emoji, artifact), routed; separate body and card lifetimes (SCF's hold times for the body, counted as time formed); a new topic retires temporary cards; the revisioned store. |
| `visual/` | Visual forms (Tao, celestial, symbols), target sampling incl. SCF's 2.5D height-field sampler, intent-driven `normalizeImage` (portrait band, map, object, logo), height-field codec, SVG checks, validators, the Visual Action controller. |

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
- **Visual Resolver** (`resolver/`): SCF's resolver moved from the browser into Node. `net.ts` is the only path to
  the network: HTTPS to a fixed allowlist, no redirects, timeouts, byte limits, type and magic-byte checks, an
  identifying User-Agent. Images: curated local assets (the Spirit Connect logo), then Wikipedia → Commons →
  Openverse by intent, ranked as in SCF, dimensions checked from the header. Terrain: Nominatim/Photon → AWS
  terrarium tiles (decoded exactly by a small PNG decoder) → SCF's height field → compact bytes. Results become
  local media; the surface never contacts a remote host.
- **Hooks** (`hooks/`): event → activity, own tools ignored, `Stop` after `responding` → complete.
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
  exposes one today (see [HOST.md](HOST.md)).
- **A desktop shell** (e.g. Tauri): the same page and renderer, one more surface adapter for window, always-on-top
  and fullscreen controls the browser cannot offer.
- **Another host**: a transport in `src/surface/transports` and, if it is not an MCP client, an adapter that sends
  hub commands.
- **Another visual pack**: one more entry in `VISUAL_FORM_PACKS`. Another image source: one more provider.
