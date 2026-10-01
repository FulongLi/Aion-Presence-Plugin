# Aion Presence

**A visual embodiment layer for Codex.** Codex remains the intelligence: it reasons, reads, edits, tests,
builds and talks with you. Aion becomes its body: a quiet particle presence that listens, reflects what Codex is
really doing, answers with it, and turns information into visual forms.

```text
Codex  = intelligence (reasoning, coding, tools, conversation, voice)
Aion   = embodiment   (listening, state, body language, visual presentation)
```

Aion is not another AI model, assistant or personality. It makes **no model API calls and needs no API key**: no
`OPENAI_API_KEY`, no Realtime or Live session, no second subscription, no speech-to-text or text-to-speech of its
own. Everything Aion says, Codex says.

Aion is an interactive AI presence of **Intelligent Presence**, created by **Spirit Connect**, led by **Fulong**.

## Install

Ask Codex: **"Install Aion Presence from https://github.com/FulongLi/Aion-Presence-Plugin"**. Codex follows
[INSTALL.md](INSTALL.md). By hand, it is two commands (no clone, no npm, no build — the runtime is committed):

```bash
codex plugin marketplace add FulongLi/Aion-Presence-Plugin
```

```bash
codex plugin add aion-presence@spirit-connect
```

Then **restart Codex once** and **trust the hooks** when Codex asks. Aion opens by itself on the first session
after installation; afterwards say **"Open Aion"**. Fallback from a clone: `node scripts/install.mjs` (one command,
built-ins only, verifies the install). Requirements: Node 22+ on the PATH and a Codex with plugins (the CLI, the
IDE extension or the ChatGPT/Codex desktop app); for the full body, a browser with WebGPU (others get a canvas
fallback).

## What it does

```text
"Open Aion."                 →  Aion appears, waves once; Codex introduces it
you speak                    →  Aion listens (locally); you stop → it turns to thinking
Codex works                  →  reading · editing · testing · building (from Codex's lifecycle hooks)
Codex answers                →  Aion answers with it (a quiet responding motion)
"What did Nikola Tesla look like?"   →  Aion forms his portrait, then returns to its body
"What is the terrain of Scotland like?" → Aion forms Scotland's real relief
"What does Orion look like?" →  Aion draws Orion from its own visual language
```

- **Two persistent bodies**: the original particle **Sphere** and the minimal **Particle Figure**. Every visual
  forms out of, and returns to, the chosen body (figure → Tesla → figure).
- **SCF Presence's visual language**: portraits and images of almost anything (looked up on open sources), real
  terrain from elevation data, Tao forms (yin-yang, lines, trigrams, bagua), constellations, zodiac and planetary
  signs, clocks, key numbers, short words, symbols and emoji.
- **Concise presentation of Codex's work**: results, short text, code excerpts, file-change summaries, SVG
  diagrams and local images. Logs never go into Aion.
- **Natural visual intent**: you never need to name a tool. The Skill and the tool descriptions (tuned in SCF
  Presence) let Codex show something whenever you ask to see it — and stay quiet otherwise.

## How it works

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

Details: [docs/architecture.md](docs/architecture.md). Parity with SCF Presence Realtime, capability by
capability: [docs/PARITY.md](docs/PARITY.md).

### Presentation modes

- **Embedded** when the host declares MCP Apps support (`io.modelcontextprotocol/ui` with
  `text/html;profile=mcp-app`); fullscreen only through the host's display modes.
- **Companion** otherwise: a chrome-less Chromium app window when one is installed, else the default browser.
  Fullscreen is the browser's own (press **F**).

Codex currently runs plugin skills, MCP servers and hooks, but its MCP Apps rendering is an experimental flag
that is off by default, so with a default Codex Aion uses the companion window. Aion never pretends a capability
exists; `open_presence` reports the mode it used.

## The MCP tools

| Tool | Purpose |
| --- | --- |
| `open_presence` | Open Aion (embedded or companion). Reports the mode, whether hooks are active, and `greeting.due` once per newly opened Presence. |
| `set_presence_state` | `idle listening thinking working reading editing testing building responding presenting complete error`. |
| `set_body_form` | `sphere` or `figure`: the persistent body. |
| `show_portrait` | A real person's face, from public photos (Wikipedia first), framed head and shoulders. |
| `show_image` | A picture of almost anything: `query` (+ `intent`) looks it up on open sources; `source` shows a local file. |
| `show_terrain` | A real region's terrain from elevation data (terrain, topography, relief, heightmap). |
| `show_form` | Aion's own forms: Tao, trigrams, bagua, constellations, zodiac and planetary signs. (`show_visual_form`: the v0.1 name.) |
| `show_clock` · `show_number` · `show_text` · `show_symbol` · `show_emoji` | Local, instant glyphs. The clock result tells Codex the local time. |
| `show_result` · `show_artifact` | A concise outcome, or a code excerpt, list, file changes, SVG or local image beside the body. |
| `clear_presentation` | Return to the persistent body now. |

## Lifecycle hooks

| Codex event | Aion |
| --- | --- |
| `UserPromptSubmit` | thinking (with a small acknowledging nod) |
| `PreToolUse` | editing · reading · testing · building · working, by tool and command |
| `PostToolUse` | back to thinking after a short settle |
| `Stop` | complete (also after responding), then rest |
| `Interrupt`, `SessionEnd` | idle |

The hook prints nothing, always exits 0 and never blocks a tool. It forwards only the event name, the tool name
and, for shell tools, the start of the command line. Without trusted hooks Aion still works; the Skill then sets
the main states itself.

## Privacy and security

- **No credentials**: no OpenAI key, ChatGPT or Codex token is read, stored or requested.
- **Microphone**: analysed in the Presence window only, as loudness and voice activity, so Aion can look
  attentive. Never recorded, stored, uploaded or transcribed; refusing it is fine.
- **Network**: the hub listens on `127.0.0.1` only (per-user token, loopback `Host` check). When Codex asks for a
  portrait, picture or terrain, the MCP process sends only the name, search phrase or region to public data
  providers on a fixed allowlist (Wikipedia, Wikimedia Commons, Openverse, OpenStreetMap Nominatim, Photon, the
  public AWS elevation tiles), identifying itself by User-Agent. Downloads are size-limited and checked by their
  bytes before the surface sees them; the surface itself never contacts a remote host. Repository and
  conversation content is never sent anywhere. An optional keyed image search
  (`AION_PRESENCE_BRAVE_SEARCH_KEY`) is off unless you set it.
- Presented content is rendered as text (never as HTML), images only through `<img>` or as particles.

## Development

```bash
npm install
npm run dev
```

| Command | |
| --- | --- |
| `npm test` | Unit and integration tests (no network) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run build` | The self-contained runtime in `plugins/aion-presence/runtime/` (committed) |
| `npm run runtime:check` | Fails if the committed runtime differs from what the sources build |
| `npm run plugin:validate -- --runtime` | Agent Plugins schema, paths, skills, hooks, marketplace and versions |
| `npm run smoke` | The surface in headless Chrome: renderers, visuals, listening, embedded (`-- --offline` skips lookups) |
| `npm run codex:verify` | A from-scratch Git install and the one-command fallback with the real Codex CLI, in throwaway homes |
| `npm run release` | The reproducible installable archive in `dist/` |
| `npm run check` | lint, typecheck, tests, runtime check, validation |

After changing sources, run `npm run build` and commit the runtime (CI checks it). Environment:
`AION_PRESENCE_SURFACE=companion`, `AION_PRESENCE_BROWSER=default|chrome|none`, `AION_PRESENCE_PORT` (47231),
`AION_PRESENCE_HOME`, `AION_PRESENCE_AUTO_OPEN=first-run|always|never`. Add `&debug=1` to the companion URL for
diagnostics, `&renderer=canvas` for the fallback, `&mic=0` to skip listening.

## Relationship to SCF Presence Realtime

Aion Presence ports SCF Presence Realtime's Presence: identity, body, Particle Figure and gestures, the WebGPU
renderer and adaptive quality, visual forms, the Visual Resolver (portraits, images, terrain), glyphs and emoji,
the microphone/VAD/emphasis pipeline, greeting and onboarding, and the tuned tool descriptions. It replaces only
SCF's AI transport — Realtime/GPT-Live sessions, keys and WebRTC — with the Codex host. See
[docs/PARITY.md](docs/PARITY.md).
