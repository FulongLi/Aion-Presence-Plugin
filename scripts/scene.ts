import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAionServer } from "../src/host/mcp/server";
import { PresenceLink } from "../src/host/hub/link";
import { REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run scene -- <command>`: drive the generative scene of a running Aion (by default `npm run dev`'s hub, in
 * .e2e/dev-home) through the real MCP tools, exactly as Codex calls them — for looking at a scene by hand, and for the
 * manual natural-language procedure in docs/SCENE-GENERATION-TESTS.md.
 *
 *   show <file.json> [body|card|hybrid]   show_interactive_card with that Scene IR document
 *   patch <json>                          control_interactive_card patch (from the current revision)
 *   undo | redo | revert | inspect        the rest of the scene actions; inspect prints the full document
 *   <action> [value]                      any other card command (select, set-view, set-speed, close…)
 *
 * The tool's text is printed as Codex would read it. AION_PRESENCE_HOME picks another Aion.
 */
const home = process.env.AION_PRESENCE_HOME ?? join(REPO_ROOT, ".e2e", "dev-home");
const page = () => readFileSync(join(REPO_ROOT, "plugins", "aion-presence", "runtime", "presence.html"), "utf8");
const link = new PresenceLink({ home, page });
const server = createAionServer({ link, page, version: "dev", openWindow: async () => false });
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "aion-scene", version: "1.0.0" }, { capabilities: {} });
await client.connect(clientSide);
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  console.log(`${result.isError ? "✗" : "✓"} ${name}\n${result.content.map(c => c.text).join("\n")}\n`);
  return result;
};
const revision = async () => {
  const inspected = await client.callTool({ name: "inspect_interactive_card", arguments: {} }) as { structuredContent?: { card?: { scene?: { revision?: number } } } };
  return inspected.structuredContent?.card?.scene?.revision;
};

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "show": {
      const scene = JSON.parse(readFileSync(resolve(rest[0]), "utf8"));
      await call("show_interactive_card", { app: "generative-scene", scene, ...(rest[1] ? { presentation: rest[1] } : {}) });
      break;
    }
    case "patch": await call("control_interactive_card", { action: "patch", patch: JSON.parse(rest.join(" ")), revision: await revision() }); break;
    case "undo": case "redo": case "revert": await call("control_interactive_card", { action: command }); break;
    case "inspect": await call("inspect_interactive_card", { full: true }); break;
    case undefined: console.log("usage: npm run scene -- show <file.json> [body|card|hybrid] | patch <json> | undo | redo | revert | inspect | <command> [value]"); break;
    default: {
      const value = rest[0] === undefined ? undefined : Number.isFinite(Number(rest[0])) ? Number(rest[0]) : rest[0] === "true" ? true : rest[0] === "false" ? false : rest[0];
      await call("control_interactive_card", { action: command, ...(value !== undefined ? { value } : {}) });
    }
  }
} finally {
  await client.close();
  await link.close();
}
