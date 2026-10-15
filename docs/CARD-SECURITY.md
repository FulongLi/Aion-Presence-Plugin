# Interactive cards: isolation and asset security (v0.4.5)

Interactive cards run application code. The design keeps that code away from everything else Aion holds: the page,
the hub and its token, the local file system, the network and the MCP tools.

## Who can run what

- Only **registered** applications run (`src/cards/registry.ts`). Their code is part of Aion's own build (the card
  runtime); Codex can name an application, never supply one. No MCP argument carries HTML, JavaScript or a URL to a
  card: `show_interactive_card` takes an application id from a fixed list, settings checked against the manifest's
  declared types, a bundled model name or a local model path (read and validated on the host).
- A manifest cannot widen its own permissions: unknown capabilities (`network`, `filesystem`, …), unknown permissions,
  limits above Aion's ceilings, unknown fields and universal command names make it invalid, and it is never registered.
  Each capability unlocks exactly the bridge messages it names; anything else is refused.

## The frame

| Property | Effect |
| --- | --- |
| `sandbox="allow-scripts"` (no `allow-same-origin`) | an **opaque origin**: no cookies, no `localStorage`/IndexedDB, no access to the parent's DOM, no same-origin requests to the hub |
| no `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`, `allow-pointer-lock`, `allow-downloads` | it cannot navigate Aion, open windows, submit forms, show dialogs or download |
| `allow=""` | no feature permissions (camera, microphone, fullscreen, …) |
| `referrerpolicy="no-referrer"`, plus the page's `Referrer-Policy: no-referrer` | `document.referrer` is empty: the page URL (which carries the token) never reaches the frame |
| `srcdoc` with its own CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'` | no network at all (no fetch, XHR, WebSocket, workers, nested frames); images only from its own `blob:` URLs. The page's CSP is inherited as well — both apply |

The smoke test probes this **from inside the frame**: `self.origin` is `"null"`, `document.referrer` is empty,
`parent.location` throws, `localStorage` throws, `fetch` to the hub and to the internet both fail; the frame's
document does not contain the token. Aion's own page CSP is unchanged (a `srcdoc` frame needs no `frame-src`).

## The channel

- One `MessagePort`, handed to the frame once; the runtime accepts it only from `parent`, only once.
- The page never listens to window messages from the frame: forged `postMessage`s to the parent are ignored (the smoke
  test posts 3,000 of them).
- Every message is validated on arrival (`parseFromCard` / `parseToCard`): version, instance (stale instances are
  refused), type, capability, payload against the manifest, size (64 KB) and plain JSON only. There is no message
  type that runs code, and no generic "call a tool" message.
- Rate limits: a token bucket per card; a card that floods is cut off. Requests time out.
- The frame never sees the hub token. Card reports reach the hub **through the page** (which holds the token) or the
  MCP Apps view's app-only `presence_card` tool; the hub validates them again against the current card and manifest
  and refuses other instances (409), malformed reports (400), oversized bodies (413) and floods (429).
- A card cannot invoke host tools: it has no channel to the MCP server, and the page maps its messages to nothing but
  the card's own state.

## Rendering what a card says

Names, metadata and properties from a model or a card are data. Every surface renders them with `textContent`
(the card runtime and the page's card host contain no `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or
`new Function` — a test checks), and they are cleaned (one line, no control or bidirectional characters, bounded).

## Asset security

Models reach a card only as validated bytes, never as paths or URLs:

1. **Sources** (`src/host/cardAssets.ts`): a bundled model by name, or a `.glb`/`.gltf` file the user named by absolute
   path (`file://` allowed). Remote URLs are refused (`remote-model-not-supported`); nothing is downloaded.
2. **Dependencies**: a `.gltf`'s buffers and images are read only from its own folder (the resolved real path must stay
   inside it — `..`, absolute paths, schemes and symbolic links leading out are refused as `external-dependency`) and
   packed into one self-contained GLB. Embedded `data:` URIs are moved into the binary chunk.
3. **Policy** (`src/cards/assets/gltf.ts`), checked on the host and again by the hub before storing:
   - GLB header, chunk lengths and JSON; glTF 2.0;
   - no external URIs; images PNG or JPEG, at most 4096 px a side, at most 64;
   - required extensions only from a list the loader implements without extra decoders (Draco, meshopt, KTX2/basis,
     WebP/AVIF textures are refused with `unsupported-extension`);
   - buffer views and accessors inside their buffers; a node tree without cycles or shared children, depth ≤ 64;
   - at most 16 MB, 2,000,000 triangles, 10,000 nodes, 4,000 meshes, 512 materials, 20,000 accessors.
4. **Integrity**: the host computes the model's SHA-256; the page fetches the bytes, checks length and hash, and only
   then transfers them to the frame (`LOAD_ASSET`). A mismatch is reported (`asset-integrity`) and nothing loads.
5. **In the frame**: the loader parses the bytes; its URL hook refuses anything but the model's own `blob:` images
   (any other request is counted and reported as `external-request-blocked`); textures load through `<img>` from
   `blob:` URLs, which the runtime counts and the loader revokes. Load time is bounded (the manifest's
   `maxLoadSeconds`), and the triangle count is checked again after parsing.
6. **Cleanup**: model bytes live in the hub's bounded in-memory media store (no temporary files); closing a card
   disposes everything the model created.

Scripts embedded in model metadata or extensions are never executed: glTF extras are data, shown as text.

## Tests

`tests/v45.test.ts` covers the twelve required checks: unregistered applications cannot run; HTML/JS cannot be
injected through MCP arguments; malformed messages are rejected; obsolete instances are ignored (bridge and hub); the
frame cannot get the token (static check, plus the smoke probes); applications cannot invoke host tools (no channel;
command and message types are closed sets); external assets are blocked (packer and policy); oversized assets are
refused; malformed or hostile glTF is refused; disposal works after errors (`retry`, the lifecycle, the smoke cycles);
manifests cannot request undeclared capabilities; flooding is cut off (bridge) or refused (hub).
