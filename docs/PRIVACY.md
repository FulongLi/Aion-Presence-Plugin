# Privacy and security

Aion makes **no model API calls and needs no API key**: no `OPENAI_API_KEY`, no Realtime or Live session, no second
subscription, no speech-to-text or text-to-speech of its own. Everything Aion says, Codex says.

- **No credentials**: no OpenAI key, ChatGPT or Codex token is read, stored or requested.
- **Network**: the hub listens on `127.0.0.1` only (per-user token, loopback `Host` check). Countries, continents, their
  named parts and about 1,250 cities are known offline (Natural Earth, bundled). When Codex asks for a portrait, picture,
  terrain or a place the offline world does not know, the MCP process sends only the name, search phrase or region to
  public data providers on a fixed allowlist (Wikipedia, Wikimedia Commons, Wikidata, Openverse, OpenStreetMap
  Nominatim, Photon, the public AWS elevation tiles), identifying itself by User-Agent. Downloads are size-limited and
  checked by their bytes before the surface sees them; the surface itself never contacts a remote host. Repository and
  conversation content is never sent anywhere. An optional keyed image search (`AION_PRESENCE_BRAVE_SEARCH_KEY`) is off
  unless you set it.
- **Routes (v0.6)**: a routing service receives only the coordinates of the places (by default FOSSGIS e.V.'s public
  Valhalla server, at most one request a second; or your own Valhalla, or OpenRouteService with your own key, sent only
  to it); place names go to the geocoders as for markers. The Route Explorer's map tiles come from OpenStreetMap's tile
  servers through Aion's hub, only for the area being viewed, and are cached in the plugin data directory as OSM's
  policy asks (`AION_PRESENCE_TILES=off` turns them off). Like any map, the routing and tile servers see your IP address
  and which area is looked at. Aion never reads your location. [ROUTE-EXPLORER.md](ROUTE-EXPLORER.md)
- **First-run welcome (v0.6)**: one marker file (`welcome-complete`, a date) in the plugin data directory; nothing else.
- **Rendering**: presented content is rendered as text (never as HTML), images only through `<img>` or as particles.
  Cards and the Presentation Router run locally; card contents are never sent anywhere.
- **Interactive cards**: only registered applications run, each in a sandboxed frame with an opaque origin and no
  network; they never see the hub token, cannot reach the hub or any tool, and receive models only as validated,
  self-contained bytes. A card can only *propose* a change to a generated scene (v0.5.1: the user's move, rotate,
  resize, undo, redo); the hub validates it as a patch against the revision it was made from, or refuses it.
  [CARD-SECURITY.md](CARD-SECURITY.md)
- **Generated scenes are data, never code**: a Scene IR document has no field that can carry code, markup, a shader or
  a URL; it is validated in the MCP server, the hub and the sandboxed card, bounded (48 KB, 256 objects, 600,000
  triangles, 60,000 particles), and a failed change leaves the previous scene on show. Repair attempts are bounded
  (three per request).
- **3D objects in the body** are validated strictly (known fields and names, bounded numbers, at most 24 objects, 256
  after repeats, 80,000 triangles, 16 KB). No 3D asset is ever fetched.
- **Microphone**: analysed in the Presence window only, as loudness and voice activity. Never recorded, stored,
  uploaded or transcribed; refusing it is fine. [MICROPHONE.md](MICROPHONE.md)
- **Sound**: every source is reduced to loudness and frequency bands on this device; nothing is recorded, stored, sent
  or transcribed. A browser tab is shared only through the browser's own picker. Codex's voice and other apps' sound
  are captured only when you ask, by the macOS Aion Audio Bridge (built locally, with macOS's System Audio Recording
  permission), which talks only to the local hub over a private socket. [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md),
  [AUDIO-BRIDGE.md](AUDIO-BRIDGE.md)
- **Lifecycle hooks** print nothing, always exit 0 and never block a tool. They forward only the event name, the tool
  name, for shell tools the start of the command line, and at the end of a turn one number (how many seconds the final
  answer takes to say). [HOST.md](HOST.md)
