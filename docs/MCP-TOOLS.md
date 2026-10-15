# MCP tools: discovery and reliability (v0.4.4)

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
| Tool metadata (tools/list JSON) | 302,010 B | **61,744 B** (29 tools) |
| Largest tool | 28,091 B (`show_scene`) | 4,988 B |
| Output schemas | 29 × 7.9 KB | none (structured results are still returned; the tests check them) |
| `show_scene`, `play_animation` input | per-type unions (19 KB, 4.4 KB) | one flat object each, validated strictly in the handler |
| Writing catalogue in the description | 19 characters listed | none: a lookup in the pack (`show_stroke_animation` takes any text) |

- A budget (`src/host/mcp/budget.ts`: 64 KB in all, 5 KB a tool) is enforced by the tests and by `npm run mcp:budget`.
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
