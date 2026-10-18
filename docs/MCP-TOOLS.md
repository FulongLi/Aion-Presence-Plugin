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

