# Aion Presence: architecture

Aion Presence separates **who does the work** from **how it is seen**. The host agent (Codex today) is the
intelligence. Aion is a presentation layer with four parts, and only the Host Adapter knows that a host exists.

```text
Aion Core ──── Presence Surface ──── Host Adapter ──── Plugin Package
(pure)         (browser)             (Node)            (what Codex installs)
```

## Aion Core (`src/core`, `src/visual`)

| Module | Role |
| --- | --- |
| `identity.ts` | The canonical facts (Aion · Intelligent Presence · Spirit Connect · Fulong), frozen. A test checks the literals appear nowhere else in `src`. `embodimentStatement()` states the plugin role: Aion is the host's body, never a second model. |
| `state.ts` | Host activity: `idle listening thinking working reading editing testing building presenting complete error`; gestures `greeting` (once per opening) and `acknowledging` (a new task after rest); `speaking` only from real host audio. Deterministic. |
| `body.ts` | The persistent body (`sphere`, `figure`) and its eased transition. |
| `figure/` | The Particle Figure: 15-anchor skeleton, particle layout bound to it, pose solver and per-state body language (restrained: every non-gesture pose stays within a small distance of neutral, which a test enforces). |
| `signal.ts` | `SemanticPresence`: state → the field signal the renderer reads (energy, warmth, focus, thinking, impulses). It replaces SCF's microphone-driven PresenceEngine. Without real host audio there is no amplitude, so nothing is lip-synced or faked. |
| `audio.ts` | `HostAudioSource`, the seam for a host that someday exposes its assistant audio. Today: `NO_HOST_AUDIO`. |
| `presentation.ts` | What can be presented (form, text, result, image, artifact), bounds, cleaning, hold times, and `planPresentation()`: what the body itself becomes vs. what stands beside it. |
| `store.ts` | `PresenceStore`: the revisioned state every surface renders, with timing (holds expire, `complete` settles, forgotten work states expire). |
| `visual/` | Visual forms (registry plus the Tao, celestial and symbol packs), target sampling (`points.ts`), image normalization and the Visual Action controller (form → hold → return to the persistent body). |

## Particle renderer (`src/render`)

SCF Presence's WebGPU body, kept intact: compute-shader physics at a fixed 120 Hz step (presence field, pointer
pusher, spring), the figure rest layer, staggered morph and body weights, microdisc material, bloom. The runtime
reads three sources (presence signal, morph, body) and an optional framing; it never sees a host.

**Adaptive quality** keeps SCF's frame-time controller (hysteresis, probation, device ranges) and adds one rule:
a slow window first sheds the secondary effects (bloom, pixel ratio above 1); only further slow windows reduce the
particle count. Climbing back, density returns first and effects last.

**Fallback**: without WebGPU (or after a lost device) a Canvas 2D body draws the same particles from the CPU
reference of each GPU expression, at lower density. `createRenderer()` chooses the renderer and reports why.

## Host Adapter (`src/host`)

```text
Codex ──stdio──► MCP server ──► PresenceLink ──► PresenceHub (in this process, or another Aion MCP process)
Codex hooks ──► aion-hook.mjs ──loopback HTTP──► PresenceHub
```

- **Presence hub** (`hub/hub.ts`): the one place state lives while Aion is open. It listens on `127.0.0.1`
  (port 47231 if free) and every route requires the per-user token and a loopback `Host` header. Routes: the
  surface page, `/events` (SSE), `/api/state` (long-poll), `/api/command`, `/api/media`, `/media/:id`,
  `/api/hook`, `/health`.
- **PresenceLink** (`hub/link.ts`): several Codex sessions may each run the MCP server. The first one to need the
  hub starts it and writes `hub.json`; the others use it over HTTP; if its owner exits, the next call takes over.
- **MCP server** (`mcp/server.ts`): nine tools with strict schemas, a shared structured output, the `ui://`
  presence resource, and two app-only tools registered only for MCP Apps hosts.
- **Surface decision** (`surface.ts`): embedded only when the client declares
  `extensions["io.modelcontextprotocol/ui"].mimeTypes` including `text/html;profile=mcp-app`; otherwise companion.
  An override can force companion, never embedded.
- **Hook interpreter** (`hooks/mapping.ts`): event, tool name and command line → activity, with a settle delay
  between tools and precedence for a specific state the agent set itself.
- **Media** (`media.ts`): local files and `data:` URLs only, sniffed by their bytes, kept in a bounded in-memory
  store.

## Presence Surface (`src/surface`)

One page, built into a single HTML file, is both the MCP Apps resource and the companion page:

```text
main.ts ─► transport ─► PresenceView ─► Aion Core + VisualActionController + panel
                                     └► createRenderer() (WebGPU or canvas)
```

- `CompanionTransport`: EventSource on the hub. Fullscreen is the browser's Fullscreen API (user gesture).
- `McpAppsTransport`: the official ext-apps `App`. State arrives by long-polling `presence_sync` through the
  host, images by `presence_media`, and fullscreen only through the host's declared display modes.
- `PresenceView`: activity → state, body → persistent body, gesture → greeting, presentation → a body visual
  (`planPresentation`) and/or the panel. When the panel opens, the renderer frames the body aside (camera view
  offset), so the background never shifts.

## Plugin Package (`plugins/aion-presence`)

A portable [Agent Plugins](https://agent-plugins.org/) package: `plugin.json` (with OpenAI's
`extensions.com.openai.interface`), `mcp.json` (`node ${PLUGIN_ROOT}/runtime/aion-mcp.mjs`), `skills/`,
`hooks/hooks.json` (Codex's default hook location), `assets/`, and the built `runtime/`. There is no
`.codex-plugin/plugin.json`: Codex reads the portable manifest directly (verified by `npm run codex:verify`),
and a second manifest would only drift.

## What came from SCF Presence Realtime

| Reused as is (imports adjusted) | Adapted | Not carried over |
| --- | --- | --- |
| `aion/body.ts`, `aion/figure/skeleton.ts`, `aion/figure/layout.ts`, `presence/focus.ts` | `aion/identity.ts` (+ embodiment statement), `aion/figure/pose.ts` (new work-state poses), `aion/index.ts` → `core/aion.ts` (activity inputs) | `realtime/*`, `live/*`, `voice/*`, `server/*`, `app/api/*`: sessions, keys, WebRTC, delegation |
| `particle/` physics, material, postfx, sphere, pointer, morphBlend, speechMotion, `config/particleDefaults.ts` | `particle/ParticleRuntime.ts` (no promo staging/formation, framing, bloom governed by quality), `particle/quality.ts` (effects shed first), `ParticleSystem.ts`/`material.ts` (formation removed) | `audio/*` microphone, VAD and analysis |
| `visual-forms/*` (registry, Tao, celestial) | `visual-actions/controller.ts` (generic requests, held until released), `visual-resolver/points.ts` (no terrain), `transforms/crop.ts` → `visual/image.ts` | `visual-resolver` web providers (Wikipedia, Commons, Openverse, terrain tiles, web search) |
| `visual-resolver/providers/glyphs.ts` text rasterizer | | `promo/*`, `dev/debugPanel.ts` |

Rewritten for the plugin: `core/state.ts` (activity states), `core/signal.ts` (semantic presence), `core/store.ts`,
`core/presentation.ts`, `core/audio.ts`, the whole Host Adapter, the surface view, panel and transports, the
symbol pack and the canvas fallback.

## Extension points

- **Another host**: a new transport in `src/surface/transports` and, if it is not an MCP client, an adapter
  that sends hub commands. Core and renderer do not change.
- **Real host audio**: a `HostAudioSource`; the presence then drives SCF's original speech motion.
- **Another visual pack**: one more entry in `VISUAL_FORM_PACKS`.
- **A standalone voice mode**: a separate adapter, disabled by default, outside plugin mode.
