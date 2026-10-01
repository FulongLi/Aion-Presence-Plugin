import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT, REPO_ROOT } from "../scripts/lib/pluginPackage";
import { ALLOWED_HOSTS } from "../src/host/resolver/net";

/**
 * Hard architectural requirement: in plugin mode Codex is the intelligence, so Aion makes no model API call,
 * needs no API key and has no realtime or live session of its own — and never imports the standalone
 * Presence's session code. The microphone is analysed locally only, in one place, for body language. The only
 * network beyond the loopback hub is public data (pictures, places, elevation) from an explicit allowlist.
 */
const files = (dir: string, pattern: RegExp): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path, pattern) : pattern.test(name) ? [path] : [];
});
const source = files(join(REPO_ROOT, "src"), /\.(ts|html|css)$/);
const read = (path: string) => readFileSync(path, "utf8");
const rel = (path: string) => relative(REPO_ROOT, path);

const FORBIDDEN = [
  /api\.openai\.com/i, /OPENAI_API_KEY/, /\/v1\/(?:realtime|responses|live|audio|chat)\b/, /chat\/completions/, /client_secrets/,
  /RTCPeerConnection/, /\bgpt-(?:live|realtime|4o|5)/i, /from ["']openai["']/,
  // No speech-to-text, text-to-speech or recording of any kind.
  /MediaRecorder/, /SpeechRecognition/, /speechSynthesis/, /SpeechSynthesisUtterance/,
];

test("no plugin source talks to a model API, asks for a key, records, transcribes or speaks", () => {
  for (const file of source) {
    const text = read(file);
    for (const pattern of FORBIDDEN) assert.equal(pattern.test(text), false, `${rel(file)} matches ${pattern}`);
  }
});

test("the microphone is opened in exactly one file, which analyses it locally and sends, stores and plays nothing", () => {
  const opening = source.filter(file => /getUserMedia/.test(read(file))).map(rel);
  assert.deepEqual(opening, ["src/surface/microphone.ts"]);
  const microphone = read(join(REPO_ROOT, "src/surface/microphone.ts"));
  for (const pattern of [/\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /postMessage/, /localStorage/, /indexedDB/, /\.destination\b/, /createMediaStreamDestination/]) {
    assert.doesNotMatch(microphone, pattern, `the microphone module never uses ${pattern}`);
  }
  assert.match(microphone, /source\.connect\(analyser\); \/\/ Never connected to the speakers\./);
  // The rest of the surface only receives the numbers the listener computes.
  const view = read(join(REPO_ROOT, "src/surface/view.ts"));
  assert.doesNotMatch(view, /getFloatTimeDomainData|copyTo\(/);
});

test("plugin mode never imports the standalone Realtime/Live session code", () => {
  const imports = source.flatMap(file => [...read(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => ({ file, specifier: match[1] })));
  assert.ok(imports.length > 50, "the scan sees the import graph");
  for (const { file, specifier } of imports) {
    assert.doesNotMatch(specifier, /(?:^|\/)(?:realtime|live|voice|server\/(?:realtimeToken|liveSession)|api\/(?:realtime|live))(?:\/|$)/,
      `${rel(file)} imports ${specifier}`);
  }
  for (const dir of ["realtime", "live", "voice"]) assert.equal(existsSync(join(REPO_ROOT, "src", dir)), false, `src/${dir} does not exist`);
});

test("network: the loopback hub, plus public data through one guarded module with an explicit allowlist", () => {
  const fetching = source.filter(file => /\bfetch\b\s*\)?\s*\(|new EventSource\(|new WebSocket\(|XMLHttpRequest/.test(read(file))).map(rel).sort();
  assert.deepEqual(fetching, [
    "src/host/hooks/forward.ts", "src/host/hub/link.ts", "src/host/resolver/net.ts", "src/surface/transports/companion.ts",
  ].sort());
  assert.match(read(join(REPO_ROOT, "src/host/hooks/forward.ts")), /\^http:\\\/\\\/127\\\.0\\\.0\\\.1/);
  assert.match(read(join(REPO_ROOT, "src/host/hub/link.ts")), /\^http:\\\/\\\/127\\\.0\\\.0\\\.1/);
  assert.match(read(join(REPO_ROOT, "src/host/hub/hub.ts")), /listen\(port, "127\.0\.0\.1"/);
  // The allowlist is public data only: encyclopedias, open image search, geocoders, elevation tiles (and an optional
  // keyed image search the user must enable). No model or AI API.
  const hosts = ALLOWED_HOSTS.map(String).join(" ");
  assert.doesNotMatch(hosts, /openai|anthropic|googleapis|azure|chatgpt|huggingface|cohere|mistral/i);
  assert.deepEqual(ALLOWED_HOSTS.map(String), [
    String(/^[a-z][a-z-]{1,11}\.wikipedia\.org$/), "commons.wikimedia.org", "upload.wikimedia.org", "thumb.wikimedia.org", "api.openverse.org",
    "nominatim.openstreetmap.org", "photon.komoot.io", "s3.amazonaws.com", "api.search.brave.com", "imgs.search.brave.com",
  ]);
  // The surface (embedded or companion) never reaches a remote host: it only talks to its own hub or host.
  for (const file of source.filter(path => rel(path).startsWith("src/surface/"))) assert.doesNotMatch(read(file), /https?:\/\/(?!127\.0\.0\.1)/, rel(file));
});

test("no dependency is a model SDK", () => {
  const manifest = JSON.parse(read(join(REPO_ROOT, "package.json")));
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const name of deps) assert.doesNotMatch(name, /^(?:openai|@openai\/|@anthropic-ai\/|@google\/genai|ai$|@ai-sdk\/)/, name);
});

test("the built runtime contains no model API either", { skip: !existsSync(join(PLUGIN_ROOT, "runtime", "aion-mcp.mjs")) && "run npm run build" }, () => {
  for (const file of ["aion-mcp.mjs", "aion-hook.mjs", "presence.html"]) {
    const text = read(join(PLUGIN_ROOT, "runtime", file));
    for (const pattern of FORBIDDEN.slice(0, 8)) assert.equal(pattern.test(text), false, `runtime/${file} matches ${pattern}`);
  }
});
