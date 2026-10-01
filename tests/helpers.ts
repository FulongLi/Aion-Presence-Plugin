import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PresenceLink } from "../src/host/hub/link";
import { createAionServer } from "../src/host/mcp/server";
import { VisualResolver } from "../src/host/resolver";

export const PAGE = "<!doctype html><title>Aion Presence</title><main id=presence></main>";
export const tempHome = () => mkdtempSync(join(tmpdir(), "aion-test-"));

/** A 1×1 PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export const MCP_APPS_CAPABILITIES = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };

/** The Aion MCP server and a client over an in-memory transport, with its own runtime directory. */
/** A resolver that never reaches the network: unit tests pass their own providers, or get "nothing found". */
export const offlineResolver = () => new VisualResolver({ env: {}, imageProviders: [], terrainProviders: [] });

export async function connectAion(options: {
  home?: string; capabilities?: Record<string, unknown>; env?: NodeJS.ProcessEnv; resolver?: VisualResolver; now?: () => Date;
} = {}) {
  const home = options.home ?? tempHome();
  const link = new PresenceLink({ home, port: 0, page: () => PAGE });
  const opened: string[] = [];
  const server = createAionServer({
    link, page: () => PAGE, version: "0.0.0-test", env: { ...options.env }, resolver: options.resolver ?? offlineResolver(), now: options.now,
    openWindow: async url => { opened.push(url); return true; },
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-host", version: "1.0.0" }, { capabilities: (options.capabilities ?? {}) as never });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const close = async () => { await client.close(); await link.close(); };
  return { client, server, link, home, opened, call, close };
}
