# MCP tools: reference, discovery and reliability

## Tool reference

| Tool | Purpose |
| --- | --- |
| `open_presence` | Open Aion (embedded or companion); `display: "immersive"` for "Open Aion". Reports the mode, the immersive path, whether hooks are active, and `greeting.due` once per newly opened Presence. |
| `set_presence_state` | `idle listening thinking working reading editing testing building responding presenting complete error`. |
| `set_body_form` | `sphere`, `eyes` or `figure`: the persistent body. |
| `express` | An expression (neutral, attentive, thinking, curious, happy, surprised, confused, sleepy, concerned) or a gesture (wave, nod, point, shrug, surprise, jump, step, turn, look-around, think): the eyes wear it, the figure acts it out. |
| `show_portrait` | A real person's face, from public photos (Wikipedia first): a heritage oval particle portrait and the original photograph (hybrid). `style: "classic"`: the head-and-shoulders portrait. |
| `show_image` | A picture of almost anything: `query` (+ `intent`) looks it up on open sources; `source` shows a local file; `detail: true` keeps it exact. |
| `show_terrain` | A real region's terrain from elevation data (terrain, topography, relief, heightmap), any size from a mountain to a continent; `markers` pins places on it; `presentation: "hybrid"` adds a relief map card. |
| `show_map` | A map of a continent, country, part of one, state or city, with its neighbours, and `markers` at real coordinates (colour, label, highlight). |
| `mark_map` | Add, recolour, relabel, highlight or remove markers on the map or terrain on show, without forming it again. |
| `plan_route` | v0.6: a real walking, cycling or hiking route between places (and waypoints), planned by a routing service, drawn on the particle terrain beside the Route Explorer card; follow-ups (`reverse`, `mode`, `via`, `clear`) change the route on show. [ROUTE-EXPLORER.md](ROUTE-EXPLORER.md) |
| `set_colors` | Aion's base particle colour and accent colour (names in any language, presets, `#RRGGBB`), or `reset`; remembered. |
| `show_form` | Aion's own forms: Tao, trigrams, bagua, constellations, zodiac and planetary signs. (`show_visual_form`: the v0.1 name.) |
| `show_scene` | A genuine 3D object: a `preset` (pyramid, saturn, dna) or a validated `scene` of primitives (box, sphere, pyramid, cylinder, cone, torus, ring, line, tube, curve, helix). |
| `set_scene_view` | Turn, tilt or zoom the 3D object on show, stop its turn, or reset the view. |
| `show_stroke_animation` | Handwriting: a Chinese character or word (true outlines, `form` simplified/traditional, `highlight: "radical"`, `practice`), English letters, words and names, digits, music and maths symbols — written stroke by stroke beside a synchronized reference card. Never a guessed order. |
| `play_animation` · `control_animation` | Short scenes of Aion's flexible figure (walk, think, notice, examine, touch, jump, point …; demos `thinking`, `exploring` …) and control of any animation: pause, resume, replay, speed, next/previous stroke, repeat a stroke or a character, complete. |
| `show_music` · `play_music` · `music_lesson` | Engraved notation (clefs incl. alto, keys, ties, slurs, dynamics, bar lines; a glossary of 40 concepts), playback that lights each note, lessons in English and Chinese. |
| `set_audio_visualizer` | How Aion moves with sound (microphone, Codex Voice Sync, another app, a tab, Aion's own music). |
| `show_clock` · `show_number` · `show_text` · `show_symbol` · `show_emoji` | Local, instant glyphs. The clock result tells Codex the local time. `show_text` `emphasis` marks a term the figure points at. |
| `show_result` · `show_artifact` | A concise outcome, or a code excerpt, list, file changes, SVG or local image, in a card beside the body. |
| `show_interactive_card` · `control_interactive_card` · `inspect_interactive_card` | An interactive 3D application beside the body (`earth-moon`, `cad-viewer` with a bundled or local glTF/GLB model, v0.5's `generative-scene` with a Scene IR `scene`, routed to body, card or hybrid), kept until closed; universal actions (pause, resume, reset, expand, collapse, fullscreen, close), the app's commands, and for scenes `patch` (with `revision`), `undo`, `redo` and `revert`, each confirmed by the card; its state, selection, metadata and scene (with `full`, the whole document) as the user sees it. |
| `cad_model` | v0.7: one operation in the user's FreeCAD (create/open/save `.FCStd`, primitives, holes, sketches, pad, pocket, booleans, fillets, parameters, transform, undo/redo, export, hand-off); each confirmed revision is shown in the CAD viewer. `"$selected"` is the viewer's selection. Arguments: the Skill's FreeCAD reference. [FREECAD.md](FREECAD.md) |
| `simulate` | v0.8: one step of a finite-element study on the FreeCAD geometry (create, materials, boundary conditions, sources, mesh, validate, run, results and probes, show, sync, compare); Gmsh meshes, Elmer solves, the Simulation Card shows the fields. `"$selected"` is the face picked in the card. Arguments: the Skill's simulation reference. [SIMULATION.md](SIMULATION.md) |
| `clear_presentation` | Return to the persistent body now (also closes an interactive card). |

`show_image`, `show_portrait`, `show_terrain`, `show_map`, `show_text`, `show_result` and `show_artifact` accept `presentation`
(`auto` · `body` · `card` · `hybrid`); every result reports the route taken and why.

## Discovery and reliability (v0.4.4, v0.4.5)

## The report

With v0.4.3 installed, the figure tools worked, `show_stroke_animation` had been called successfully, yet some Codex chat
sessions did not have the writing tool: Codex said the skill described it but its tool list had no such entry.

## What was traced

Every step of the discovery path was checked against the user's own Codex (0.162.0-alpha.17.2, Codex Desktop), its
session rollouts and logs (read-only):

| Step | Finding |
| --- | --- |
| Source and runtime | `show_stroke_animation` is registered (29 tools). |
| Plugin installation | `~/.codex/plugins/cache/spirit-connect/aion-presence/0.4.3/`: runtime, skill and manifest present. |
| Codex's MCP layer | `codex app-server` → `mcpServerStatus/list` lists **all 29** Aion tools. The server, registration and naming are fine. |
| Session caching | One session (20:23) started before the 0.4.3 update (20:28) and read the 0.4.2 skill: a conversation keeps the tools it started with. |
| The model's tool list | In code mode Codex exposes MCP tools through `ALL_TOOLS`. In the failing session (started after the update) it held exactly **21** Aion tools — `clear_presentation` … `show_number` in alphabetical order. `show_portrait`, `show_result`, `show_scene`, `show_stroke_animation`, `show_symbol`, `show_terrain`, `show_text` and `show_visual_form` were missing. `tools.mcp__aion_presence__show_stroke_animation` was "not a function". |
| History | v0.4–v0.4.1 sessions (up to 22 tools) saw every Aion tool. |

Codex's binary contains a tool-metadata budget (`core/src/context/world_state/tools_budget.rs`, with
`tool_input_schema_max_bytes`, `deferred_tool_world_state`). No log line records the drop.

## Cause

> v0.5.2 correction: the mechanism was Codex's *plugin* budget, measured on Codex's own representation (which repeats the
> server's instructions on every tool) — see [v0.5.2: the terrain regression](#v052-the-terrain-regression). The
> v0.4.4 numbers below are tools/list sizes.

Aion's tool metadata outgrew what Codex keeps for one server. v0.4.3 sent **302,010 bytes** for 29 tools — on average 10.4
KB a tool, because every tool repeated the same 7.9 KB output schema (229 KB in all) — and Codex kept the alphabetical
prefix that fit (≈ 207 KB) and silently dropped the rest. The writing tool was not missing from the source, the plugin or
the server; the host's exposure cut it.

## Fix

| | v0.4.3 | v0.4.4 |
| --- | --- | --- |
| Tool metadata (tools/list JSON) | 302,010 B | **57,592 B** (29 tools) |
| Largest tool | 28,091 B (`show_scene`) | 4,489 B |
| Output schemas | 29 × 7.9 KB | none (structured results are still returned; the tests check them) |
| `show_scene`, `play_animation` input | per-type unions (19 KB, 4.4 KB) | one flat object each, validated strictly in the handler |
| Writing catalogue in the description | 19 characters listed | none: a lookup in the pack (`show_stroke_animation` takes any text) |

- A budget (`src/host/mcp/budget.ts`: 64 KB in all, 5 KB a tool) is enforced by `npm run mcp:budget`; the tests hold Aion 10 % inside it (57.6 KB, 4.5 KB a tool), because Codex measures its own representation, about 2 % larger.
- `npm run codex:verify` installs the plugin into a throwaway Codex and checks, through Codex's own app server, that all
  29 tools arrive and fit the budget.
- `npm run codex:tools` shows what *your* Codex receives from every MCP server (counts and sizes) and lists Aion's tools.
- The Skill tells Codex what to do if a tool still seems missing: search for it (`tools.tool_search`, or filter `ALL_TOOLS`
  for `aion_presence`) and call it by its full name; and that a conversation started before an update keeps the old list.

The 9,500-character writing catalogue never enters tool metadata: the tool takes the text and the host looks it up.

## Supported paths if the host hides a tool

1. Start a new conversation (or restart Codex) after updating Aion.
2. Ask in natural language; with v0.4.4's metadata every tool is exposed in the configurations tested.
3. If the host still filters tools (many other servers, a stricter budget), Codex can find the tool with `tool_search`
   ("aion writing") — the Skill says so.
4. `npm run codex:tools` shows whether Aion's tools reach Codex at all; if they do, the remaining limit is the host's.

## v0.4.5: three more tools inside the same budget

The interactive-card tools (`show_interactive_card`, `control_interactive_card`, `inspect_interactive_card`) added
about 3.9 KB. To keep the v0.4.4 budget (and its 10 % margin) without dropping anything:

- every tool is listed without its JSON Schema dialect line (`"$schema": "https://json-schema.org/draft/2020-12/schema"`,
  about 60 bytes a tool): MCP defines 2020-12 as the dialect when it is absent, so the meaning is unchanged
  (`compactSchema` in `src/host/mcp/budget.ts`; validation is still each tool's zod schema);
- the card tools take compact inputs (an app id from a list, one free `settings` record validated per manifest on the
  host, one `action` string validated against the open card's manifest);
- a few long descriptions and repeated parameter descriptions were shortened (no behaviour changed), and `show_scene`'s
  3-vectors are arrays of length 3 rather than tuples.

Result: **32 tools, 57,574 B** (largest 4,372 B), under the 57,600 B target the tests enforce. The app-only
`presence_card` tool (the embedded view's card report) is registered only for MCP Apps hosts, like `presence_sync`
and `presence_media`, and never appears in Codex's list.

## v0.5: generated scenes without a new tool

The Generative Visual Engine needed a way to send a scene, change it and read it back. A tool for every scene
operation would have cost several KB, so v0.5 extends the three card tools instead:

- `show_interactive_card` takes `scene` (a Scene IR document, typed only as an object in the schema: it is validated
  in full on the host, and its format is taught by the skill's `references/scene-ir.md`, which costs nothing per
  session) and `presentation` `auto` | `body` | `card` | `hybrid`;
- `control_interactive_card` takes `patch` (a list of operation objects) and `revision`, with the scene actions
  `patch`, `undo`, `redo` and `revert`;
- `inspect_interactive_card` takes `full` (the whole scene document);
- the three descriptions now list app commands once, in each card's own result, instead of in every session's tool
  list.

Result: **32 tools, 57,584 B** (largest 4,372 B), +10 B on v0.4.5, still under the 57,600 B target the tests enforce
(`npm run mcp:budget`). Tool discovery with the real Codex is checked by `npm run codex:verify`.

## v0.5.1: repair feedback without a new tool

Reliability work in v0.5.1 changed what the existing tools *return*, not their metadata (still 57,584 B): a refused
`show_interactive_card` scene or `control_interactive_card` patch lists every independent problem (up to 8), each with a
`→` hint, plus "Attempt n of 3"; after three refusals within five minutes further invalid attempts get `repair-limit`.
Patches are checked against the reported scene in the MCP server first (so hints are complete) and again,
authoritatively, in the hub. The user's own edits in the card travel over the Card Bridge (`EDIT`), not over MCP.


## v0.5.2: the terrain regression

### The report

With v0.5.1 installed, "Show me China's topography" got a map of China instead: Codex said the conversation had no Aion
terrain tool. Network, the terrain engine and the installation were not the cause.

### What was traced

| Layer | Finding |
| --- | --- |
| Source and runtime | `show_terrain` registered (32 tools); the installed 0.5.1 copy is byte-identical to the repository. |
| Codex's MCP layer | `codex app-server` → `mcpServerStatus/list` lists all 32 Aion tools (`npm run codex:tools`). |
| The conversation | The user's failing conversation started *after* the update (04:57, update 04:53). Its `ALL_TOOLS` held **23** Aion tools — `clear_presentation` … `show_music` in name order; `ALL_TOOLS.find(show_terrain)` → `undefined`; no `tool_search`. A v0.5.0 conversation on 2026-10-16 had the same 23: present since v0.4.5's 32 tools. |
| Reproduction | A fresh, isolated Codex 0.163.0-alpha.10.2 with only Aion installed: 23 of 32 (`ALL_TOOLS` read from the session rollout). |
| Codex's source | `codex-rs/core/src/mcp_tool_exposure.rs`: the tools of *plugin* MCP servers share `MAX_AGENT_PLUGIN_MCP_TOTAL_BYTES` = 64,000 (8,000 a tool), in name order; a tool that does not fit is registered `Hidden`. The bytes are `serde_json` of the tool's spec: a namespace whose description is the server's `instructions` (cut at 1,000 B, `core/src/tools/handlers/mcp.rs`) around the function, whose description has " This tool is part of plugin `Aion Presence`." appended (`codex-mcp/src/rmcp_client.rs`) and is cut at 1,000 B, with the schema reduced to the keywords Codex keeps (`tools/src/json_schema.rs`). |

### Cause

Aion's server instructions (1,267 B, cut to 1,000) were charged **once per tool**: about 32 KB on top of 54.6 KB of
specs. Codex's measure was 86,846 B; the first 23 tools used 63,008 B and `show_number` would have reached 64,777 B, so it
and every tool after it — `show_portrait`, `show_result`, `show_scene`, `show_stroke_animation`, `show_symbol`,
`show_terrain`, `show_text`, `show_visual_form` — were hidden from the model, silently. v0.4.4 had measured tools/list
(57.6 KB) and checked Codex's app server, which lists hidden tools too; neither layer could see this.

### Fix

| | v0.5.1 | v0.5.2 |
| --- | --- | --- |
| Server instructions | 1,267 B (embodiment, onboarding) | 83 B; the guidance is in the skill |
| Codex's measure | 86,846 B — 23 of 32 exposed | **57,211 B — all 32 exposed** (10.6 % inside 64,000) |
| tools/list | 57,584 B | 56,915 B |
| `show_form` description in Codex | cut at 1,000 B (half the form ids lost) | 967 B, whole |

- `src/host/mcp/budget.ts` models Codex's measure (`codexExposureReport`); `npm run mcp:budget` prints it, and the tests
  hold it under 57,600 B and reproduce the v0.5.1 cut (23, `show_number` first hidden).
- `npm run codex:tools` now tells you the Aion version your Codex runs and how many Aion tools a new conversation gets.
- `npm run codex:verify` checks Codex's measure; `-- --live` runs one real turn and reads `ALL_TOOLS`.
- `terrain-unavailable` results now say which stage failed (see [MAPS.md](MAPS.md#if-terrain-does-not-appear-v052)).

### Verified (2026-10-19, Codex 0.163.0-alpha.10.2, model gpt-6.1-sol)

- `npm run codex:verify -- --live`: installed from Git, a new conversation holds **32 of 32** Aion tools.
- Upgrade, in a throwaway Codex: v0.5.1 → new conversation 23 tools, `show_terrain` absent; `codex plugin marketplace
  upgrade` → 0.5.2 installed; the same conversation resumed with `codex exec resume`: 32; a new conversation: 32.
  (`marketplace upgrade` also replaced files without a version change; the version moved to 0.5.2 so an installed copy
  says whether it has the fix.) Codex Desktop, which keeps its MCP connections across a conversation, was not tested
  here: after updating, start a new conversation or restart Codex.
- `npm run scene:eval -- --only geo`: "Show me the terrain of Scotland." → `show_terrain` → formed; "Show me China's
  topography." → `show_terrain` (`style: "topography"`); "Show me the map of Scotland." → `show_map`; "…and mark
  Glasgow." → `show_terrain` with a Glasgow marker. No generated scene, image or substitute.

### Remaining limits

- The 64,000-byte budget is shared by every *plugin* MCP server, in name order. A plugin whose server name sorts before
  `aion-presence` and uses most of it would hide Aion's later tools again; `npm run codex:tools` lists such servers.
- Codex's measure is modelled from Codex's source (main, October 2026) and checked against the observed cut; a Codex
  release that changes its representation needs `npm run codex:verify -- --live` again.

## v0.6: `plan_route` inside the same budget

Routes needed a tool of their own: "Plan a cycling route from Glasgow to Edinburgh" must reach something named for it,
and its follow-ups (reverse, change the mode, add a waypoint, remove it) are route operations the host performs, not card
commands. Points and sections along the route (the highest point, a section in km) are the Route Explorer card's own
commands, through `control_interactive_card`, so they cost no metadata.

| | v0.5.2 | v0.6 |
| --- | --- | --- |
| Tools | 32 | **33** (`plan_route`: 1,258 B by Codex's measure) |
| Codex's measure | 57,211 B | **57,536 B** — all 33 exposed, 10.1 % inside 64,000 B (target 57,600 B) |
| tools/list | 56,915 B | 57,190 B |

To make room without dropping anything, descriptions repeated on several tools were shortened with no change of meaning:
the marker fields (`place`, `label`, `color`, `highlight`, on three tools), `hold_seconds` (16 tools), the portrait
`style` and the image `intent`. `open_presence` gained `welcome` and `surface: "embedded"` within a shorter description.
`route-explorer` is not offered by `show_interactive_card` (it shows only routes `plan_route` planned), which keeps that
enum unchanged. The v0.5.1 cut is still reproduced by the model (`tests/v052.test.ts`: with v0.5.1's 1,267-byte
instructions the 32 v0.5 tools would again be cut, now after 24 instead of 23 because of the shorter descriptions).

## v0.7: one compact tool for FreeCAD

Parametric CAD needed a tool of its own: creating a document is not a card command (no card is open yet), and its
operations are FreeCAD's, not the viewer's. Rather than one tool per operation, `cad_model` takes an `action` (an enum of
25) and an `args` object; the arguments of each action are validated by a strict schema in the MCP server
(`src/host/cad/commands.ts`) and documented in the Skill's `references/freecad.md` — the Skill costs no tool metadata.
The description says what it is and where the arguments are, nothing more.

| | v0.6 | v0.7 |
| --- | --- | --- |
| Tools | 33 | **34** (`cad_model`: 1,100 B by Codex's measure) |
| Codex's measure | 57,536 B | **58,636 B** — all 34 exposed, 8.4 % inside 64,000 B |
| tools/list | 57,190 B | 58,257 B |
| Internal target | 57,600 B (10 %) | **59,000 B (≈ 8 %)** |

The 10 % margin chosen in v0.4.4 would have required shortening other tools' tuned descriptions by about 1 KB; that
risks how Codex picks tools that work today, so v0.7 spends part of the margin instead and says so here. The order Codex
counts in is by name: `cad_model` sorts early, so a future tool that does not fit hides tools *after* it in name order
(`tests/v052.test.ts` checks the exposure). The v0.5.1 reproduction leaves `cad_model` out, as it leaves `plan_route`.


## v0.8: one compact tool for simulation

Simulation follows the same pattern: `simulate` takes an `action` (an enum of 18) and an `args` object validated per
action in the MCP server (`src/host/sim/commands.ts`), documented in the Skill's `references/simulation.md`; card
commands (field, section, probe…) go through the existing `control_interactive_card`, and the Simulation Card is not
offered by `show_interactive_card` (it only shows what `simulate` produced), so neither tool grew.

| | v0.7 | v0.8 |
| --- | --- | --- |
| Tools | 34 | **35** (`simulate`: 919 B by Codex's measure) |
| Codex's measure | 58,636 B | **59,555 B** — all 35 exposed, 6.9 % inside 64,000 B |
| tools/list | 58,257 B | 59,105 B |
| Internal target | 59,000 B (≈ 8 %) | **60,000 B (≈ 6 %)** — for the owner's review |

Any new tool would have crossed 59,000 B (a minimal one costs about 700 B); shortening tuned descriptions elsewhere was
again judged riskier than spending margin. The description was tightened to what the tool is and where its arguments
are. `simulate` sorts after `show_*` by name, so a future tool that does not fit hides tools after it in name order
(`set_*` and later); `tests/v052.test.ts` checks the exposure.
