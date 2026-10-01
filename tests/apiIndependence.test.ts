import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT, REPO_ROOT } from "../scripts/lib/pluginPackage";

/**
 * Hard architectural requirement: in plugin mode Codex is the intelligence, so Aion makes no model API call,
 * needs no API key, opens no microphone and has no realtime or live session of its own — and never imports
 * the standalone Presence's session code.
 */
const files = (dir: string, pattern: RegExp): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path, pattern) : pattern.test(name) ? [path] : [];
});
const source = files(join(REPO_ROOT, "src"), /\.(ts|html|css)$/);
const read = (path: string) => readFileSync(path, "utf8");

const FORBIDDEN = [
  /api\.openai\.com/i, /OPENAI_API_KEY/, /\/v1\/(?:realtime|responses|live|audio|chat)\b/, /chat\/completions/, /client_secrets/,
  /RTCPeerConnection/, /getUserMedia/, /\bgpt-(?:live|realtime|4o|5)/i, /from ["']openai["']/,
];

test("no plugin source talks to a model API, asks for a key or opens a microphone", () => {
  for (const file of source) {
    const text = read(file);
    for (const pattern of FORBIDDEN) assert.equal(pattern.test(text), false, `${relative(REPO_ROOT, file)} matches ${pattern}`);
  }
});

test("plugin mode never imports the standalone Realtime/Live session code", () => {
  const imports = source.flatMap(file => [...read(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => ({ file, specifier: match[1] })));
  assert.ok(imports.length > 50, "the scan sees the import graph");
  for (const { file, specifier } of imports) {
    assert.doesNotMatch(specifier, /(?:^|\/)(?:realtime|live|voice|audio\/microphone|server\/(?:realtimeToken|liveSession)|api\/(?:realtime|live))(?:\/|$)/,
      `${relative(REPO_ROOT, file)} imports ${specifier}`);
  }
  for (const dir of ["realtime", "live", "voice"]) assert.equal(existsSync(join(REPO_ROOT, "src", dir)), false, `src/${dir} does not exist`);
});

test("the only network the plugin uses is its own loopback hub", () => {
  const fetching = source.filter(file => /\bfetch\(|new EventSource\(|new WebSocket\(/.test(read(file))).map(file => relative(REPO_ROOT, file)).sort();
  assert.deepEqual(fetching, [
    "src/host/hooks/forward.ts", "src/host/hub/link.ts", "src/surface/transports/companion.ts",
  ].sort());
  assert.match(read(join(REPO_ROOT, "src/host/hooks/forward.ts")), /\^http:\\\/\\\/127\\\.0\\\.0\\\.1/);
  assert.match(read(join(REPO_ROOT, "src/host/hub/link.ts")), /\^http:\\\/\\\/127\\\.0\\\.0\\\.1/);
  assert.match(read(join(REPO_ROOT, "src/host/hub/hub.ts")), /listen\(port, "127\.0\.0\.1"/);
});

test("no dependency is a model SDK", () => {
  const manifest = JSON.parse(read(join(REPO_ROOT, "package.json")));
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const name of deps) assert.doesNotMatch(name, /^(?:openai|@openai\/|@anthropic-ai\/|@google\/genai|ai$|@ai-sdk\/)/, name);
});

test("the built runtime contains no model API either", { skip: !existsSync(join(PLUGIN_ROOT, "runtime", "aion-mcp.mjs")) && "run npm run build" }, () => {
  for (const file of ["aion-mcp.mjs", "aion-hook.mjs", "presence.html"]) {
    const text = read(join(PLUGIN_ROOT, "runtime", file));
    for (const pattern of FORBIDDEN) assert.equal(pattern.test(text), false, `runtime/${file} matches ${pattern}`);
  }
});
