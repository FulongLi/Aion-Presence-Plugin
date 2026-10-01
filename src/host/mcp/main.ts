import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import manifest from "../../../plugins/aion-presence/plugin.json" with { type: "json" };
import { PresenceLink } from "../hub/link";
import { createAionServer } from "./server";

/**
 * The plugin's MCP server over stdio (mcp.json starts it as `node ${PLUGIN_ROOT}/runtime/aion-mcp.mjs`).
 * The presence page sits next to this bundle in runtime/; in development it is read from the built runtime.
 * Diagnostics go to stderr only: stdout belongs to the MCP protocol.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pagePath = [process.env.AION_PRESENCE_PAGE, join(here, "presence.html"), join(here, "../../../plugins/aion-presence/runtime/presence.html")]
  .find((path): path is string => Boolean(path && existsSync(path)));
let page: string | null = null;
const readPage = () => (page ??= pagePath ? readFileSync(pagePath, "utf8") : "<!doctype html><title>Aion Presence</title><p>The presence surface is not built. Run npm run build.</p>");

const link = new PresenceLink({ page: readPage });
const server = createAionServer({ link, page: readPage, version: manifest.version });

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await link.close().catch(() => {});
  process.exit(0);
};
process.stdin.on("end", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await server.connect(new StdioServerTransport());
