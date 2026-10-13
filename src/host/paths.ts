import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Aion keeps its small local runtime files (the hub's address and token, the hook heartbeat). Codex
 * gives every plugin a persistent data directory and passes it to both the MCP server and hook commands as
 * PLUGIN_DATA, so they agree without configuration. AION_PRESENCE_HOME overrides it (development, tests);
 * outside a plugin host it falls back to ~/.aion-presence. Nothing here holds credentials or user content.
 */
export function presenceHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AION_PRESENCE_HOME || env.PLUGIN_DATA || join(homedir(), ".aion-presence");
}

export const HUB_FILE = "hub.json";
export const TOKEN_FILE = "token";
export const HOOK_HEARTBEAT_FILE = "hooks-seen";
/** Aion's colours, as the user chose them (base and accent). */
export const APPEARANCE_FILE = "appearance.json";
/** How Aion responds to sound (mode, intensity, sensitivity); never which sources it may capture. */
export const AUDIO_FILE = "audio.json";
/** Codex Voice Sync (v0.4.3): whether the user opted in to Aion following Codex's voice, and what macOS has shown. */
export const VOICE_SYNC_FILE = "voice-sync.json";
/** Hook events seen this recently mean the plugin's hooks are trusted and running. */
export const HOOKS_ACTIVE_MS = 30 * 60_000;
/** The companion surface's preferred local port (any free port is used when it is taken). */
export const DEFAULT_PORT = 47_231;
