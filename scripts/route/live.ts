import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PresenceLink } from "../../src/host/hub/link";
import { createAionServer } from "../../src/host/mcp/server";

/**
 * Development only (never shipped): a real Aion — the built page, the real resolver, routing and tiles — with a hub on
 * a fixed port and a loopback control port to call its MCP tools, for looking at real renderer output while driving it:
 *
 *   npx tsx scripts/route/live.ts [--port 47300] [--home DIR]
 *   curl -s localhost:47301/call -d '{"name":"plan_route","args":{"from":"Glasgow","to":"Edinburgh","mode":"cycling"}}'
 *
 * The companion address (with its token) is printed and served at GET /url.
 */
const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const port = Number(arg("port") ?? 47300);
const home = arg("home") ?? mkdtempSync(join(tmpdir(), "aion-live-"));
const page = () => readFileSync(join("plugins", "aion-presence", "runtime", "presence.html"), "utf8");
const link = new PresenceLink({ home, port, page, bridge: { locate: () => null } });
const server = createAionServer({ link, page, version: "0.6.0-live", assetsDir: join("plugins", "aion-presence", "assets"), openWindow: async () => false });
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "aion-live", version: "1.0.0" });
await client.connect(clientSide);
await link.run(backend => backend.state());
console.log(`home ${home}`);
console.log(`surface ${link.current?.surfaceUrl}`);
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", async () => {
    try {
      if (req.url === "/url") { res.end(link.current?.surfaceUrl ?? ""); return; }
      if (req.url === "/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(await link.run(backend => backend.state()))); return; }
      const { name, args } = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { name: string; args?: Record<string, unknown> };
      const result = await client.callTool({ name, arguments: args ?? {} });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
}).listen(port + 1, "127.0.0.1", () => console.log(`control http://127.0.0.1:${port + 1}/call`));
