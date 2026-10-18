# The Aion Card Bridge protocol (v1)

The only channel between the Aion page and an interactive card. Source: `src/cards/protocol.ts` (schema and
validation), `src/surface/cards/bridge.ts` (page side), `src/cards/runtime/main.ts` (card side).

## Channel

1. The page creates the sandboxed frame (`srcdoc`, `sandbox="allow-scripts"`) and a `MessageChannel`.
2. After the frame loads, the page posts **one** window message to the frame —
   `{ aion: "card-port", v: 1, instance, app }` with `port2` transferred. The target origin is `"*"` because the frame's
   origin is opaque; the port is useless to anyone else.
3. The runtime accepts that message once, only if `event.source === parent`, and ignores every later window message.
4. From then on both sides speak only over the port. The page never listens to window messages from the frame.

## Envelope

```json
{ "v": 1, "instance": "c3k9…", "type": "EXECUTE_COMMAND", "id": "r1f", "payload": { "command": "focus", "value": "moon" } }
```

| Field | |
| --- | --- |
| `v` | protocol version (1) |
| `instance` | the card instance (`/^c[a-z0-9]{8,24}$/`); messages for any other instance are refused as stale |
| `type` | one of the types below |
| `id` | on requests: a request id (`/^r[a-z0-9]{1,24}$/`) |
| `re` | on `RESULT`: the id it answers |
| `payload` | an object, validated per type |

Card → Aion messages must be plain JSON (no functions, binary data or cycles) and at most 64 KB.

## Aion → card

| Type | Payload | Notes |
| --- | --- | --- |
| `INITIALIZE` | `app, config, state?, layout, reducedMotion, theme {base, accent}, limits` | config checked against the manifest |
| `LOAD_ASSET` | `asset {id, name, kind: "model", bytes, sha256}, data: ArrayBuffer` | needs `model-assets`; bytes transferred, never a URL |
| `SET_STATE` | `state` | restores declared state (a window opened later) |
| `SET_CAMERA` | `view?, focus?` | needs `camera` |
| `EXECUTE_COMMAND` | `command, value?` | an application command from the manifest (universal ones have their own messages) |
| `PAUSE` / `RESUME` | `reason: user \| codex \| hidden` | `hidden` suspends / wakes |
| `RESIZE` | `width, height, layout` | |
| `RESET` | `{}` | |
| `DISPOSE` | `{}` | the card releases everything, answers `DISPOSED`, closes its port |

Every request carries an `id`; the card answers with `RESULT {ok, problem?}` and `re`. Requests time out after 4 s
(INITIALIZE and LOAD_ASSET get the manifest's load time); a `RESULT` that answers nothing is dropped. Before answering,
the runtime flushes pending state, so whoever waits for the answer already has the new state.

## Card → Aion

| Type | Payload | Capability |
| --- | --- | --- |
| `READY` | `app, version` (must match the manifest) | — |
| `LOADING` | `phase, progress 0…1` | — |
| `STATE_CHANGED` | `state` (declared keys and types only) | — |
| `SELECTION_CHANGED` | `objectId \| null, name?, kind?, properties? (≤ 24), screen? {x, y} 0…1` | `selection` |
| `INTERACTION` | `kind: pointer-down \| pointer-up \| wheel \| key \| escape \| focus \| blur` | `interaction-events` |
| `ERROR` | `code, message, fatal` | — |
| `RESOURCE_STATUS` | `fps, frameMs, drawCalls, triangles, geometries, textures, programs, rendering, heapMB?` | `resource-status` |
| `DISPOSED` | `geometries, textures, urls, loops` (what is left) | — |
| `RESULT` | `ok, problem?` with `re` | — |
| `EDIT` (v0.5.1) | `request` (`/^u[a-z0-9]{4,32}$/`), `base` (revision), and `action: "transform", id, position?, rotation?, scale?` or `action: "undo" \| "redo"` | `scene-documents` |

`EDIT` is a *proposal*: the user moved, turned or resized an object with the card's transform tool, or pressed Undo or
Redo. The page forwards it in its next card report (`edit`); the hub validates it again (the object exists, the base
revision exists) and applies it as one scene command — a `transform` patch labelled "(by hand)", or undo/redo — against
`base`, so a stale proposal is refused. The card shows the change only when the resulting revision arrives as
`LOAD_SCENE`; a refused one returns the object to the document's transform. `LOAD_SCENE` carries `history {undo, redo}`
(v0.5.1) so the card's Undo and Redo buttons reflect the hub's history.

`screen` is given only when the application knows exactly where the object is; the figure then points at it.
Otherwise Aion turns toward the card as a whole — it never invents coordinates.

## Limits

| | |
| --- | --- |
| Message size (card → Aion) | 64 KB |
| Rate (card → Aion) | burst 120, then 40 a second; beyond that dropped; 400 drops cut the card off (`card-flooding`) |
| Command timeout | 4 s |
| Commands kept in the hub | the newest 16 |
| Card reports (page → hub) | 96 KB, burst 40 then 12 a second per window (HTTP 429 beyond) |

## Example: a selection

```json
{ "v": 1, "instance": "c3k9…", "type": "SELECTION_CHANGED",
  "payload": { "objectId": "assembly/core", "name": "Magnetic Core", "kind": "Part",
               "properties": { "Part Number": "DEMO-CORE-EI96", "Bounding size": "96 × 79.8 × 32 mm" },
               "screen": { "x": 0.52, "y": 0.47 } } }
```

The page validates it, reports it to the hub (`POST /api/card`, validated again), the figure points at `screen`, and
`inspect_interactive_card` returns it to Codex.
