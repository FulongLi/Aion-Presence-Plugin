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
| `signal.ts` | `PresenceEngine` (SCF's engine, transport replaced): the host's activity is the base; local voice → `listening`; a finished utterance → a short inferred `thinking`; real host audio → `speaking`; an echo guard. It produces the field signal the renderer reads, including the semantic `responding` swell. |
| `listening/` | SCF's `VoiceActivityDetector` and `EmphasisDetector` (unchanged), `MicFrame`, `rms`. Pure numbers. |
| `guidance.ts` | The greeting (from the identity), onboarding examples backed by real tools, SCF's greeting gate (waits for the body and a quiet moment). |
| `body.ts`, `figure/` | Persistent body (sphere, figure), skeleton, layout, poses (work states, a restrained semantic `responding`). |
| `audio.ts` | `HostAudioSource`, the seam for a host that someday exposes assistant audio. Today: `NO_HOST_AUDIO`. |
| `presentation.ts`, `store.ts` | What can be presented (form, text, result, image with fit, terrain, clock, number, symbol, emoji, artifact), SCF's hold times (counted as time formed), and the revisioned store. |
| `visual/` | Visual forms (Tao, celestial, symbols), target sampling incl. SCF's 2.5D height-field sampler, intent-driven `normalizeImage` (portrait band, map, object, logo), height-field codec, SVG checks, validators, the Visual Action controller. |

### Precedence

```text
greeting gesture  >  presenting (a visual on show)  >  acknowledging  >  speaking (real audio)  >  activity
activity = local listening, if the user is heard and the host is resting or thinking
         = inferred thinking, after an utterance while the host rests (≤ 6 s, until the host confirms)
         = the host's activity otherwise (real work is never hidden by the user's voice)
```

Echo: with real host audio, SCF's guard (no listening while audible and 0.4 s after). Without it, the engine is
conservative: no listening while Codex is `responding` and for 2.5 s after, so Codex's voice from the speakers is
not taken for the user. Real barge-in needs real host audio and is not claimed.

## Particle renderer (`src/render`)

SCF Presence's WebGPU body, kept intact: compute physics at 120 Hz (presence field, pointer pusher, spring), the
figure rest layer, staggered morph and body weights, microdisc material, bloom, adaptive quality (effects shed
before density). One addition: a `responding` uniform drives a slow, even swell in the presence force (no
amplitude, no spectrum), mirrored in the Canvas 2D fallback.

## Host Adapter (`src/host`)

```text
Codex ──stdio──► MCP server ──► PresenceLink ──► PresenceHub (in this process, or another Aion MCP process)
                     └──► Visual Resolver ──https──► public data (allowlist)
Codex hooks ──► aion-hook.mjs ──loopback HTTP──► PresenceHub
```

- **Presence hub** (`hub/`): state on `127.0.0.1` with a per-user token and loopback `Host` check; SSE for
  companion windows, long-poll for embedded views, media by id, hook intake. Every command is re-validated.
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
`PresenceView` drives Aion Core from snapshots, resolves body visuals (forms, glyphs, emoji from the system font,
images framed by their fit, height fields), shows the panel for long content, and runs local listening:
`microphone.ts` (SCF's `MicrophoneListener`) is the only file that opens the microphone; it reduces each block of
samples to one RMS number and nothing else leaves it. Refused or unavailable, Aion follows the host's states.

## Plugin package and distribution (`plugins/aion-presence`)

A portable Agent Plugins package: `plugin.json` (with `extensions.com.openai.interface`), `mcp.json`, `skills/`,
`hooks/hooks.json`, `assets/` and the built `runtime/`. The runtime is **committed**, so a Git install needs no
build; `npm run runtime:check` (CI) fails if it differs from what the sources build. The repository's
marketplace is `spirit-connect`: `codex plugin marketplace add FulongLi/Aion-Presence-Plugin` then
`codex plugin add aion-presence@spirit-connect`. `scripts/install.mjs` is the one-command fallback;
`npm run release` builds a reproducible archive.

## Extension points

- **Real host audio**: a `HostAudioSource`; the engine then drives SCF's speech motion and echo guard.
- **Another host**: a transport in `src/surface/transports` and, if it is not an MCP client, an adapter that sends
  hub commands.
- **Another visual pack**: one more entry in `VISUAL_FORM_PACKS`. Another image source: one more provider.
