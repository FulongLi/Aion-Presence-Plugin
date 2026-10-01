# Aion Presence

**A visual embodiment layer for Codex.** Codex remains the intelligence: it reasons, reads, edits, tests and
builds. Aion becomes its body: a quiet particle presence that reflects what Codex is really doing and
presents what it produces.

```text
Codex  = intelligence (reasoning, coding, tools, conversation, voice)
Aion   = embodiment   (state, body language, visual presentation)
```

Aion is not another AI model, assistant or personality. In plugin mode it makes **no model API calls and
needs no API key**: no `OPENAI_API_KEY`, no Realtime or Live session, no second subscription, no speech-to-text
or text-to-speech of its own. Everything Aion shows comes from the Codex session you are already using.

Aion is the visual presence of **Intelligent Presence**, created by **Spirit Connect**, led by **Fulong**.

## What it does

```text
"Open Aion."  →  Aion appears (embedded in the host, or in its companion window)
              →  you keep working with Codex as usual, typing or speaking
              →  Aion reflects real work: thinking · reading · editing · testing · building
              →  Codex finishes something  →  Aion presents it   ✓  48 / 48 tests passed
              →  Aion returns to its body and rests
```

- **Two persistent bodies**: the original particle **Sphere** and the minimal **Particle Figure**. A temporary
  visual always forms out of, and returns to, whichever body is chosen (figure → Orion → figure).
- **The body becomes information**: Aion's own procedural forms (Tao: yin-yang, the lines, the eight trigrams,
  the bagua; astronomy: Orion, Ursa Major, Cassiopeia, Scorpius, Leo, Cygnus, the Pleiades; astrology: the
  zodiac and planetary signs; symbols: check, cross, exclamation, arrows…), short text and numbers, and images.
- **Concise presentation of Codex output**: results (title, summary, status, a few details), short text, code
  excerpts, file-change summaries, SVG diagrams and local images. Logs never go into Aion; details stay in Codex.
- **Restrained body language** for each state, inherited from SCF Presence: minimal, abstract, non-gendered,
  never a game avatar.

## How it works

```text
┌──────────────────────────── Codex (the host AI) ────────────────────────────┐
│ conversation · reasoning · tools · voice                                    │
│   ├─ skill  aion-presence      when and how to use the body (restraint)     │
│   ├─ MCP    aion-presence      open_presence · set_presence_state · show_…  │
│   └─ hooks  aion-hook.mjs      UserPromptSubmit · Pre/PostToolUse · Stop …  │
└───────────────┬──────────────────────────────────────┬──────────────────────┘
                │ MCP (stdio)                          │ hook events (loopback HTTP)
                ▼                                      ▼
┌─────────────────────── Host Adapter (Node, local) ──────────────────────────┐
│ MCP server ─► presence hub (127.0.0.1, per-user token)                      │
│                 store: activity · persistent body · presentation · gesture  │
│                 hook interpreter · images (local only) · SSE · long-poll    │
└───────────────┬──────────────────────────────────────┬──────────────────────┘
                │ MCP Apps (ui:// resource,            │ companion window
                │ presence_sync via the host)          │ (server-sent events)
                ▼                                      ▼
┌──────────────────────── Presence Surface (one page) ────────────────────────┐
│ PresenceView ─► Aion Core (identity · state · body · figure · presentation) │
│              ─► particle renderer (WebGPU, canvas fallback) · visual forms   │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Where | What |
| --- | --- | --- |
| **Aion Core** | `src/core`, `src/visual` | Identity (one frozen manifest), activity state machine and gestures, persistent body, Particle Figure skeleton/layout/poses, the semantic presence signal, the presentation model and store, visual forms and target sampling. Host-agnostic and pure. |
| **Particle renderer** | `src/render` | SCF Presence's WebGPU particle body (compute physics, presence field, figure, morphing, bloom) with adaptive quality, plus a Canvas 2D fallback. It knows nothing about hosts. |
| **Host Adapter** | `src/host` | The MCP server and tools, the presence hub, the hook interpreter, host capability detection, local image intake. |
| **MCP** | `plugins/aion-presence/mcp.json` | A local stdio server, bundled with all its dependencies. |
| **Skill** | `plugins/aion-presence/skills/aion-presence` | Teaches Codex that Aion is its body, when to use it, and to stay quiet otherwise. |
| **Hooks** | `plugins/aion-presence/hooks/hooks.json` | Lightweight command hooks that turn real Codex activity into state. |
| **Presence Surface** | `src/surface` | One self-contained page: the MCP Apps resource *and* the companion window. |

More detail: [docs/architecture.md](docs/architecture.md).

### Presentation modes and an honest limitation

Embedded and fullscreen presentation depend on what the host supports:

- **Embedded** when the host declares MCP Apps support (the `io.modelcontextprotocol/ui` extension with the
  `text/html;profile=mcp-app` type). Aion renders inside the host and asks for fullscreen only through the
  host's declared display modes (`ui/request-display-mode`).
- **Companion** otherwise: `open_presence` opens a local Presence window (a chrome-less Chromium app window when
  one is installed, else your default browser), driven by the same state. Fullscreen there is the browser's own
  (press **F**).

At the time of writing, Codex runs plugin skills, MCP servers and hooks, but its MCP Apps rendering is an
experimental feature flag (`enable_mcp_apps`) that is off by default. With a default Codex, Aion therefore
uses the **companion window**. Aion never pretends a capability exists: the embedded path is taken only when the
host declares it, and `open_presence` reports which mode it used. Both modes are verified in a real browser by
`npm run smoke` (the embedded one through a minimal MCP Apps host built from the official `AppBridge`).

## Install locally in Codex

Requirements: Node 22+ on your `PATH`, a Codex with plugins (the CLI, the IDE extension or the ChatGPT/Codex
desktop app), and for the full body a browser with WebGPU (current Chrome, Edge or Safari; other browsers get
the canvas fallback).

```bash
git clone https://github.com/FulongLi/Aion-Presence-Plugin.git
```

```bash
cd Aion-Presence-Plugin && npm install
```

```bash
npm run setup -- --install
```

`setup` builds the runtime, validates the plugin, registers this repository as the local marketplace
`aion-presence-dev` and installs `aion-presence@aion-presence-dev`. Without `--install` it prints the two
commands instead:

```bash
codex plugin marketplace add /path/to/Aion-Presence-Plugin
```

```bash
codex plugin add aion-presence@aion-presence-dev
```

(The ChatGPT desktop app ships a CLI at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`;
`setup` finds it automatically.) Then:

1. **Restart Codex** (or the desktop app) so it loads the plugin.
2. **Trust the hooks.** Codex does not run plugin hooks until you review and trust them; accept when asked, or
   use `/hooks` in Codex. Without hooks Aion still works; Codex then reports major phases itself.
3. **Check the tools**: `codex mcp list` shows `aion-presence`; in a session, the nine Aion tools are available.
4. Say **"Open Aion."** Then work as usual, for example "Run the tests and show me the result."

Codex may ask you to approve each Aion tool call. They only change Aion's display, so you can allow them for
the session, or set an approval policy for this server in `~/.codex/config.toml`, for example:

```toml
[plugins."aion-presence@aion-presence-dev".mcp_servers.aion-presence]
default_tools_approval_mode = "approve"
```

Installing straight from GitHub (`codex plugin marketplace add FulongLi/Aion-Presence-Plugin`) is not supported
yet: the runtime is built locally rather than committed, so a git-sourced install would have no `runtime/`.
Publishing built releases is the next milestone.

After changing the plugin, run `npm run setup -- --install` again: Codex runs its own installed copy (in
`~/.codex/plugins/cache/`), not this checkout.

To verify an installation from scratch without touching your Codex configuration:

```bash
npm run codex:verify
```

It installs the plugin with the real Codex CLI into a throwaway `CODEX_HOME`, checks that Codex lists the MCP
server and the skill, and exercises the installed copy (tools, companion surface, a result, a real hook event).

## The MCP tools

| Tool | Purpose |
| --- | --- |
| `open_presence` | Open Aion (embedded or companion), optionally as the figure or fullscreen. Reports the mode actually used and whether hooks are active. |
| `set_presence_state` | `idle · listening · thinking · working · reading · editing · testing · building · presenting · complete · error`, with an optional short label. |
| `set_body_form` | `sphere` or `figure`: the persistent body. |
| `show_visual_form` | One of Aion's procedural forms by id or name ("yin yang", "Orion", "Leo zodiac sign", "check"). |
| `show_text` | Short text: ≤ 16 plain characters become the body itself; longer text stands beside it. |
| `show_image` | A local image (absolute path, `file://` or `data:image`), as particles or framed. Remote URLs are never fetched. |
| `show_result` | A concise outcome: title, summary, status (✓ ✕ ! or info), up to 8 detail lines. |
| `show_artifact` | A code excerpt, text, a list, a file-change summary, an SVG diagram or a local image. |
| `clear_presentation` | Return to the persistent body now. |

Every tool has a strict input schema and returns the same structured output (state, body, presentation,
surface mode, hooks). Hosts that render MCP Apps also get two app-only tools (`presence_sync`,
`presence_media`) that only the embedded view calls; other hosts never see them.

## Lifecycle hooks

| Codex event | Aion |
| --- | --- |
| `UserPromptSubmit` | thinking (with a small acknowledging nod) |
| `PreToolUse` | editing (patches, edits) · reading (reads, searches, read-only shell) · testing (test runners) · building (build tools) · working (anything else) |
| `PostToolUse` | back to thinking after a short settle, without flicker between tools |
| `Stop` | complete, then rest (an error Codex reported is kept) |
| `Interrupt`, `SessionEnd` | idle |
| `SessionStart` | nothing visible; it only notes that hooks run |

The hook prints nothing and always exits 0. It never blocks, rewrites or comments on a tool call, and it is not a
policy hook. When Aion is not open it does nothing beyond noting that it ran. When Aion is open, it forwards only
the event name, the tool name and, for shell tools, the start of the command line. Aion's own tools never change
its state.

## Privacy and security

- No credentials of any kind: no OpenAI key, no ChatGPT or Codex token is read, stored or requested.
- Nothing leaves your machine. The hub listens on `127.0.0.1` only, requires a per-user token (stored with mode
  0600) and a loopback `Host` header. Repository contents are never sent anywhere.
- Images come only from local files or `data:` URLs and are checked by their bytes; Aion fetches no URLs.
- Presented content is rendered as text (never as HTML), and images only through `<img>`.
- The runtime state lives in the plugin data directory Codex provides (`PLUGIN_DATA`), or
  `AION_PRESENCE_HOME`.

## Development

```bash
npm run dev
```

Rebuilds the runtime on change and runs a hub with the companion surface (it prints the URL; add `&debug=1`
for diagnostics, `&renderer=canvas` for the fallback). `npm run dev -- --demo` also plays a scripted Codex turn.

| Command | |
| --- | --- |
| `npm test` | Unit and integration tests (Node test runner) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run build` | The self-contained runtime in `plugins/aion-presence/runtime/` |
| `npm run plugin:validate` | Agent Plugins schema, paths, skills, hooks and marketplace checks (`-- --runtime` also requires the build) |
| `npm run smoke` | The surface in headless Chrome: WebGPU and canvas, companion and embedded |
| `npm run codex:verify` | Clean install with the real Codex CLI in a throwaway `CODEX_HOME` |
| `npm run check` | lint, typecheck, tests, build, validation |

Environment: `AION_PRESENCE_SURFACE=companion` (always use the companion window), `AION_PRESENCE_BROWSER=default|chrome|none`,
`AION_PRESENCE_PORT` (default 47231), `AION_PRESENCE_HOME`.

### Repository layout

```text
plugins/aion-presence/   the plugin root (what Codex installs)
  plugin.json              portable Agent Plugins manifest + extensions.com.openai interface
  mcp.json                 the local stdio MCP server
  skills/aion-presence/    the Codex skill
  hooks/hooks.json         lifecycle hooks
  assets/                  icon and logo
  runtime/                 built by npm run build (not committed)
.agents/plugins/marketplace.json   the repo marketplace for local testing
src/core      Aion Core            src/render    particle renderer
src/visual    visual forms         src/host      MCP server, hub, hooks
src/surface   Presence surface     scripts/      build, setup, validation, smoke, codex:verify
```

The plugin root is its own directory because Codex copies it into its plugin cache on install; sources and
`node_modules` stay outside, and the runtime is bundled with every dependency.

## Relationship to SCF Presence Realtime

Aion Presence reuses SCF Presence Realtime's Aion identity, body, Particle Figure, particle renderer, adaptive
quality, visual forms, sampling and morph lifecycle, so the Presence looks and moves the same. It deliberately
does **not** include SCF's Realtime/GPT-Live sessions, API-key handling, WebRTC, microphone pipeline or web image
search: in plugin mode, Codex is the brain. A standalone voice mode would be a separate adapter, disabled by
default; it is not part of this plugin.
