# Interactive cards (v0.4.5)

An **interactive card** is a small, registered application that runs beside Aion's particle body in an isolated
frame: the user turns, zooms and clicks it directly; Codex opens, controls and inspects it through three MCP tools.
Aion stays present the whole time — the body steps aside, turns toward the card, and returns when it closes.

Two applications ship with v0.4.5:

| Application | What it is | Docs |
| --- | --- | --- |
| `earth-moon` | Earth's rotation, the Moon's orbit and synchronous rotation, with educational scaling | [EARTH-MOON.md](EARTH-MOON.md) |
| `cad-viewer` | A glTF/GLB engineering model viewer: orbit, select, metadata, hide, isolate, fit | [CAD-VIEWER.md](CAD-VIEWER.md) |

Related: [CARD-BRIDGE.md](CARD-BRIDGE.md) (the protocol), [CARD-SECURITY.md](CARD-SECURITY.md) (isolation and asset
security), [MCP-TOOLS.md](MCP-TOOLS.md) (tool metadata budget).

## Architecture

```
Codex ──MCP──► Aion MCP server ──► hub (state: presentation + card) ──snapshots──► Presence page
   show_interactive_card            validates against the manifest                      │
   control_interactive_card         queues numbered commands                            ▼
   inspect_interactive_card  ◄────  card reports (state, selection, acks) ◄──  Interactive Card Host
                                                                                        │  MessageChannel
                                                                                        ▼  (Card Bridge)
                                                                          sandboxed frame (opaque origin)
                                                                          card runtime → Earth–Moon | CAD viewer
                                                                                         └─ Three.js viewer engine
```

The pieces are separate on purpose:

| Concern | Where |
| --- | --- |
| Application registration | `src/cards/registry.ts` (`CardRegistry`, the built-ins), `src/core/cards.ts` (the host's registry) |
| Manifest validation | `src/cards/manifest.ts` |
| Lifecycle | `src/cards/lifecycle.ts` (pure state machine) |
| Presentation | `src/core/presentation.ts` (`kind: "interactive"`), `src/core/presentationRouter.ts`, `src/surface/view.ts` |
| Communication | `src/cards/protocol.ts` (schema), `src/surface/cards/bridge.ts` (page side), `src/cards/runtime/main.ts` (card side) |
| State | `src/cards/state.ts` (hub's card), `src/core/store.ts` (`cardCommand`, `cardReport`), `src/host/hub/hub.ts` (`POST /api/card`) |
| Rendering | `src/cards/runtime/engine.ts` (`ViewerEngine`, Three.js WebGL2) |
| Assets | `src/cards/assets/gltf.ts` (policy, packing), `src/host/cardAssets.ts` (sources) |
| User interaction | `src/surface/cards/host.ts` (universal controls), each application's own controls |
| Codex tools | `src/host/mcp/server.ts` (`show_/control_/inspect_interactive_card`, app-only `presence_card`) |

Nothing application-specific runs in Aion's main render loop. The page only creates the frame, owns the bridge,
draws the universal controls and frames the body; everything an application draws happens inside its frame.

The card runtime (`src/cards/runtime`) is built as its own bundle (Three.js WebGL, the applications) and embedded in
`presence.html` **as a string** that only ever becomes a sandboxed frame's `srcdoc` (`scripts/build.ts`). Ordinary
cards (text, images, maps, music, writing, results, code, artifacts) are unchanged and never load it.

## The Presentation Router

An interactive card is a presentation of kind `interactive` (`app`, `instance`, `title`, `layout`, `config`, an
optional validated `asset`). The router's policy:

- **auto → CARD** (reason `interactive`): the application occupies the card workspace; the body stays alive beside it.
- **hybrid → HYBRID** only when the application's manifest declares a particle form (`hybrid`: a validated 3D scene;
  Earth–Moon has one, the CAD viewer does not). The body forms it for a moment while the card stays.
- **body → CARD**: an application is never particles alone.

Lifetime: until the user closes it, a replacement presentation is requested, Codex closes it (`close` or
`clear_presentation`), or the owning hub ends. A new prompt does not shorten it (other cards end within 15 s of a new
topic). `hold_seconds` sets an explicit lifetime. Showing the **same application** again keeps the card and its
instance — e.g. a new model loads into the open viewer.

## Layouts

| Layout | The card | Aion's body |
| --- | --- | --- |
| `compact` | beside Aion (≈ 46 % of the width) | steps left, a little smaller |
| `expanded` (default) | ≈ 74 % of the width, 90 % of the height | in a slim strip on the left |
| `fullscreen` | ≈ 87 % of the width, the full height | small at the left edge |

The card's own fullscreen button also asks the browser (companion window) or the host (MCP Apps display mode) for
fullscreen — of the **whole** Aion page, so the body stays visible beside the card. Browsers require a user gesture
for that, so Codex's `fullscreen` command changes the layout only (the tool result says so). Escape leaves fullscreen.
On narrow screens the card sits below the body.

## Universal controls

Every card has the same bar: **pause / resume**, **reset**, **expand / collapse**, **fullscreen / exit**, **close**,
plus loading progress, a status line, an error state with **Retry**, and the unsupported-device state (no WebGL 2:
the card says so; it never substitutes a static picture). Application controls live inside the frame. Keys typed in
the frame stay in the frame; Aion's own `F` shortcut ignores keys from the card's controls.

## Lifecycle

```
registered ─launch→ loading ─ready→ ready ─activate→ active ⇄ paused
                       ↑                     ↓  ↑       ↓ ↑
                     retry / reload        suspend / wake (page hidden)
any live state ─fail→ error ─retry→ loading;  any ─dispose→ disposing ─disposed→ disposed (final)
```

- **loading**: the frame is created, the runtime receives its port and `INITIALIZE`, the application allocates and
  reports progress (`LOADING`), the model (if any) is fetched, hash-checked and transferred (`LOAD_ASSET`).
- **active**: rendering and permitted animation run.
- **paused**: simulation time stops; frames are drawn only on demand (the user can still turn the view).
- **suspended** (page hidden): nothing is drawn at all; waking returns to active or paused, whichever it was.
- **disposing → disposed**: animation loops stop, listeners are removed, pending work is cancelled, geometries,
  materials, textures, environment maps and object URLs are released, the WebGL context is lost on purpose, the port is
  closed and the frame removed. The frame reports what it left (`DISPOSED`); the smoke test requires zero.

## State

The hub keeps the card (`HubSnapshot.card`) independent of any DOM: application, instance, title, layout, lifecycle,
the application's **declared** state (validated against its manifest), the selection, the loaded asset, the latest
error and resource counters, and the last 16 commands with their acknowledgements. Animation frames are never
streamed: applications coalesce state to a few messages a second, the page coalesces reports.

- **Ownership**: Codex's intent enters as commands (numbered, queued in the hub); the card is authoritative for what
  it actually shows (state, selection) and reports it back; the user's own actions in the card change state the same
  way. A window that opens later restores state rather than replaying old commands.
- **Instances**: one card at a time; a new card replaces the old one safely; closing invalidates its instance; the hub
  refuses reports about any other instance (409), so delayed messages from a disposed card, or from before a hub
  restart, can never touch the current card.
- **No automatic turns**: a click in the card does not start an AI turn — no host offers that without undocumented
  APIs. The selection is stored; Codex reads it with `inspect_interactive_card` when the user asks.

## MCP integration

| Tool | Purpose |
| --- | --- |
| `show_interactive_card` | Launch (or update) a registered application: `app`, `model` (CAD), `layout`, `presentation`, `settings`, `title`, `hold_seconds`. Waits briefly for the card to report, and says honestly whether it is running, still starting, failed, or not displayed (Aion closed). |
| `control_interactive_card` | A universal action or an application command with its value, checked against the manifest. Waits for the card's acknowledgement and says whether it was confirmed, refused, or not displayed. |
| `inspect_interactive_card` | Application, lifecycle, layout, state, selection (with metadata), model, error, resources and the accepted commands. |
| `presence_card` (app-only) | The embedded MCP Apps view's card report. Only the view calls it; the card never reaches any tool. |

Schemas are compact (one flat object each; settings are validated per manifest on the host), and every tool is listed
without the JSON Schema dialect line: 32 tools, 57.6 KB in all — the v0.4.4 budget holds (`npm run mcp:budget`).

In an **MCP Apps** host the card is nested inside Aion's view; the view talks to its host with the official ext-apps
bridge (`presence_sync`, `presence_media`, `presence_card`), and the card talks only to the view over the Card Bridge.
The card is not an MCP Apps view itself and assumes nothing about the host.

## Performance and resource management

Measured by `npm run smoke -- --only=v45` (headless Chrome on an Apple-silicon Mac, 1440 × 900; numbers in
`docs/media/v0.4.5/performance.json`):

| | WebGPU body | Canvas body |
| --- | --- | --- |
| Earth–Moon card ready (tool call → active, textures generated) | ≈ 0.98 s | ≈ 0.98 s |
| CAD viewer ready with the transformer | ≈ 0.28 s | ≈ 0.27 s |
| Open → active → close, averaged over 12 cards | ≈ 1.08 s | ≈ 1.07 s |
| Body and card together | 60 fps + 60 fps | 60 fps + 60 fps |
| Card: draw calls, textures, geometries, JS heap | 8, 6, 11, ≈ 6.7 MB | same |
| Left behind after 14 cards | 0 geometries, 0 textures, 0 URLs, 0 loops, no WebGL warnings | same |

GPU utilization itself is not measurable from the page. The policies behind those numbers:

- **render on demand**: the CAD viewer draws only when something changes; the Earth–Moon card draws continuously only
  while time runs; damping keeps drawing only while the view still glides;
- **paused** cards advance nothing; **hidden** pages suspend cards entirely; closed cards release everything;
- the card's pixel ratio is capped at 2; textures are generated once per card; geometry is shared within a card;
- while the user drags a large (expanded or fullscreen) card, Aion's body caps itself at 30 fps (its physics keeps its
  fixed step and adaptive quality ignores those frames); it returns to full rate a moment after the user lets go. The
  body's audio-reactive behaviour is never switched off;
- the body (WebGPU) and the card (WebGL2) use separate contexts; neither depends on the other.

## Adding an application

1. **Manifest** (`src/cards/apps/<name>.manifest.ts`): id, name, version, entry, description, capabilities,
   permissions, config, commands, state, resources, display, cleanup, optional hybrid. Register it in
   `BUILTIN_CARD_APPS` (`src/cards/registry.ts`). `validateManifest` refuses unknown capabilities or permissions,
   limits above Aion's ceilings (`CARD_LIMITS`), universal command names, invalid value types and unknown fields.
2. **Module** (`src/cards/apps/<name>/app.ts`): a `CardAppFactory` returning a `CardApp` (see
   `src/cards/runtime/app.ts`) — `start`, `command`, optionally `loadAsset`, `setState`, `setCamera`, `flush`, and
   `pause`, `resume`, `suspend`, `reset`, `resize`, `status`, `dispose`. Build on `ViewerEngine`; emit state, selection,
   loading and errors through `ctx.emit`; render controls into `ctx.ui` with `textContent` only. Add it to
   `CARD_APP_FACTORIES` (`src/cards/runtime/apps.ts`).
3. **Pure logic** in its own module (like `earthMoon/model.ts`) so it can be unit-tested without a browser.
4. **Tests**: the manifest validates; its commands and state check; pure logic; a smoke section that opens it through
   the MCP tools, clicks, controls, closes it repeatedly and requires zero leftovers.

Nothing else changes: the router, the bridge, the hub, the MCP tools and the page take any registered application.

### Manifest example

```ts
export const WAVEFORM_MANIFEST = {
  id: "waveform-viewer", name: "Waveform viewer", version: "1.0.0", entry: "waveform-viewer",
  description: "Power-electronics waveforms: zoom, cursors and measurements.",
  capabilities: ["webgl", "selection", "camera", "interaction-events", "resource-status"],
  permissions: ["pointer", "keyboard"],
  config: { channel: { type: "enum", values: ["voltage", "current"] } },
  commands: { "set-timebase": { value: { type: "number", min: 1e-9, max: 10 }, description: "Seconds per division." } },
  state: { timebase: { type: "number", min: 0, max: 10 } },
  resources: { assets: [], maxAssetBytes: 0, maxTriangles: 200_000, maxTextures: 8, maxTextureSize: 2048, maxLoadSeconds: 10 },
  display: { minWidth: 360, minHeight: 240, layouts: ["compact", "expanded", "fullscreen"], defaultLayout: "expanded" },
  cleanup: { onClose: "dispose", onHidden: "suspend" },
} satisfies CardAppManifest;
```

### Value types

`none`, `boolean`, `number {min, max, integer?}`, `enum {values}`, `id` (object ids: a path of names), `text {max}`
(one clean line), `ids {max}`, `tree {max}` (a hierarchy of `{id, name, depth, visible}`).

## Error handling

- Application errors arrive as `ERROR {code, message, fatal}`; fatal ones put the card in `error` with Retry (a fresh
  frame and channel); others show in the status line for a moment and are reported to the hub.
- Model problems fail the tool call with a code and a readable detail (`model-invalid`, `model-too-large`,
  `external-dependency`, `unsupported-extension`, `remote-model-not-supported`, …) before anything reaches a card.
- A card that does not answer a request within 4 s gets a timeout acknowledgement; a card that floods the bridge is
  cut off with `card-flooding`.

## Testing conventions

- `tests/v45.test.ts`: registry, manifests, values, the bridge (correlation, timeouts, stale replies, flooding),
  lifecycle, hub state, the store's card, the router, hub endpoints (token, stale instances, size, rate), the glTF
  policy and packer, model sources, the Earth–Moon model, the land mask, the MCP tools, static security checks.
- `npm run smoke -- --only=v45,embedded`: both renderers, the real frame — isolation probed from inside it, forged
  window messages, clicks select, Codex controls, layouts, universal controls, Escape, 14 open/close cycles with zero
  leftovers, timings, a browser without WebGL, and a card inside a minimal MCP Apps host.
- `npm run showcase -- card-…`: the twelve review recordings (`docs/media/v0.4.5`).

## Known limitations

- A click in a card cannot start a Codex turn by itself (no documented host API); Codex inspects when asked.
- Fullscreen needs a user gesture in a browser; Codex's `fullscreen` fills Aion's space only.
- One interactive card at a time. With several companion windows, every window runs its own frame and applies the same
  commands; a user's clicks in one window are not mirrored into the others.
- In MCP Apps hosts whose policy blocks `blob:` images, model textures cannot load (the geometry still shows).
- The card runtime adds about 0.7 MB to `presence.html` (Three.js WebGL and the applications).
