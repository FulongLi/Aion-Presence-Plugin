# Development

Rules for contributors and coding agents are in [CLAUDE.md](../CLAUDE.md). Architecture: [architecture.md](architecture.md).

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` rebuilds the runtime on every change and runs a presence hub with the companion surface (it prints the
address). `npm run scene -- show tests/fixtures/scenes/solar-system.json` then shows a generated scene in it through the
real MCP tools (`patch`, `undo`, `inspect`, … as well).

## Commands

| Command | |
| --- | --- |
| `npm test` | Unit and integration tests (no network) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run build` | The self-contained runtime in `plugins/aion-presence/runtime/` (committed) |
| `npm run runtime:check` | Fails if the committed runtime differs from what the sources build |
| `npm run plugin:validate -- --runtime` | Agent Plugins schema, paths, skills, hooks, marketplace, versions, license files |
| `npm run check` | lint, typecheck, tests, runtime check, validation |
| `npm run smoke` | The surface in headless Chrome, both renderers: every presentation kind, cards, generated scenes (patches checked by pixels, selection, undo, refusals, cleanup and timings). `-- --offline` skips lookups; `-- --only=v05` one section; `-- --only=terrain` real terrain, styles and routes (v0.5.2) |
| `npm run showcase` | The visual review: records each demo in the real renderer through the real MCP tools (`-- --list`, `-- <names>`, `-- --headed`, `-- --canvas`) |
| `npm run scene -- <command>` | Drive a running Aion's generated scene by hand (show, patch, undo, redo, revert, inspect, card commands) |
| `npm run scene:eval` | Natural-language scene generation with the real Codex CLI, measured from request to confirmed render (uses your Codex account; [SCENE-GENERATION-TESTS.md](SCENE-GENERATION-TESTS.md)) |
| `npm run codex:verify` | A from-scratch Git install and the one-command fallback with the real Codex CLI, in throwaway homes; `-- --live` also reads `ALL_TOOLS` in a real conversation (one turn of your account) |
| `npm run mcp:budget` · `npm run codex:tools` | Aion's tool metadata against its budget and Codex's own plugin budget · what your Codex receives from every MCP server, the Aion version it runs, and how many Aion tools a new conversation gets ([MCP-TOOLS.md](MCP-TOOLS.md)) |
| `npm run audio:eval` | The music detector on real recordings on this Mac |
| `npm run audio-bridge:install` | Builds the macOS Aion Audio Bridge into `~/.aion-presence/audio-bridge` |
| `npm run audio:verify -- --play-loops` / `-- --codex` | Real-device check of the bridge |
| `npm run geo:coverage` · `npm run geo:build -- <dir>` | Geography against live services · rebuild the bundled world from Natural Earth ([MAPS.md](MAPS.md)) |
| `npm run sim:verify` | v0.8: the simulation benchmarks against the installed FreeCAD, Gmsh and Elmer — analytic references at every mesh size, timings, a large mesh ([SIMULATION.md](SIMULATION.md)); `npm run smoke -- --only=sim` shows them in the real renderer |
| `sh scripts/sim/build-elmer.sh` | Builds Elmer FEM into `~/.aion-sim/elmer` without sudo (micromamba + conda-forge toolchain, official source) |
| `npm run route:verify` | v0.6: the acceptance routes against the real routing service and elevation model; evidence in `docs/media/v0.6.0/routes.json` ([ROUTE-EXPLORER.md](ROUTE-EXPLORER.md)) |
| `npm run chinese:build` · `chinese:export` · `chinese:coverage` | Rebuild, export and re-verify the Chinese Writing Pack |
| `npm run writing:sheet` | Contact sheets of every curated letter, digit and symbol |
| `npm run cards:models` · `cards:earth-mask` | Regenerate the CAD viewer's transformer · the Earth–Moon land mask |
| `npm run notices` | Regenerate `plugins/aion-presence/THIRD-PARTY-NOTICES.md` |
| `npm run release` | The reproducible installable archive in `dist/` |

After changing sources, run `npm run build` and commit the runtime (CI checks it; `npm run dev` leaves an unminified
build behind).

## Environment

`AION_PRESENCE_SURFACE=companion|embedded` (v0.6: companion is the default; embedded restores v0.5's choice where the host
renders MCP Apps), `AION_PRESENCE_BROWSER=default|chrome|none`, `AION_PRESENCE_PORT` (47231),
`AION_PRESENCE_HOME`, `AION_PRESENCE_AUTO_OPEN=first-run|always|never`, `AION_PRESENCE_DEBUG=1` (open the companion with
diagnostics; `npm run diagnose` prints them). On the companion URL: `&debug=1` for diagnostics (surface, fullscreen,
microphone, VAD, host → effective activity, route, card, hooks), `&renderer=canvas` for the fallback, `&mic=0` to skip
listening.

Routes (v0.6): `AION_ROUTING_PROVIDER=valhalla|openrouteservice`, `AION_ROUTING_VALHALLA_URL` (your own Valhalla, e.g.
`http://localhost:8002`), `AION_ROUTING_ORS_KEY` (your OpenRouteService key; never commit it), `AION_PRESENCE_TILES=off`.
`npm run route:verify` plans the acceptance routes against the real service. For looking at real renderer output while
driving the tools by hand: `npx tsx scripts/route/live.ts` (a real Aion on port 47300; `curl -s localhost:47301/call -d
'{"name":"plan_route","args":{…}}'`; development only, never shipped).

## Releases

Versions move together in `package.json`, `package-lock.json` and `plugins/aion-presence/plugin.json`, with a
[CHANGELOG](../CHANGELOG.md) entry. Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes a GitHub
Release and refuses a tag that differs from `package.json` — tags are created only with the owner's approval.
