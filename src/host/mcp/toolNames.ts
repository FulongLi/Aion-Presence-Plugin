/**
 * Every tool the agent sees. The visual vocabulary is SCF Presence's (show_image, show_portrait, show_terrain,
 * show_form, show_clock, show_number, show_text, show_symbol, show_emoji, set_body_form, and return to the
 * body as clear_presentation); the plugin adds the host-facing tools (open_presence, set_presence_state,
 * show_result, show_artifact). show_visual_form is v0.1's name for show_form, kept so older clients work.
 * (No dependencies: the hook interpreter reads this list too.)
 */
export const TOOL_NAMES = [
  "open_presence", "set_presence_state", "set_body_form",
  "show_image", "show_portrait", "show_terrain", "show_form", "show_clock", "show_number", "show_text", "show_symbol", "show_emoji",
  "show_result", "show_artifact", "clear_presentation", "show_visual_form",
] as const;
export type ToolName = typeof TOOL_NAMES[number];

/** Tools only an embedded MCP Apps view calls. */
export const APP_TOOL_NAMES = ["presence_sync", "presence_media"] as const;
