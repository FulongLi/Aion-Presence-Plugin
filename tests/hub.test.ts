import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { PresenceHub } from "../src/host/hub/hub";
import { PresenceLink } from "../src/host/hub/link";
import type { HubSnapshot } from "../src/host/hub/protocol";
import { HUB_FILE, TOKEN_FILE } from "../src/host/paths";
import { PAGE, PNG, tempHome } from "./helpers";

async function startHub(home = tempHome()) {
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE });
  await hub.start();
  const token = readFileSync(join(home, TOKEN_FILE), "utf8");
  const port = Number(new URL(hub.url).port);
  return { hub, home, token, port };
}

/** A raw HTTP request, so the Host header can be set like a browser or an attacker would. */
function raw(port: number, path: string, options: { method?: string; host?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: { host: options.host ?? `127.0.0.1:${port}`, ...(body ? { "content-type": "application/json" } : {}), ...options.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the hub listens on loopback only, writes a private discovery file and keeps one token per user", async () => {
  const { hub, home, token } = await startHub();
  try {
    assert.match(hub.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const discovery = JSON.parse(readFileSync(join(home, HUB_FILE), "utf8"));
    assert.equal(discovery.hub, hub.id);
    assert.equal(discovery.url, hub.url);
    assert.equal(JSON.stringify(discovery).includes(token), false, "the discovery file never holds the token");
    assert.equal(statSync(join(home, TOKEN_FILE)).mode & 0o077, 0, "the token is readable by its owner only");
    assert.match(token, /^[a-f0-9]{48}$/);
  } finally { await hub.stop(); }
  const again = await startHub(home);
  try { assert.equal(again.token, token, "a restarted hub keeps the companion address valid"); } finally { await again.hub.stop(); }
});

test("every route needs the token and a loopback Host (no other site, no DNS rebinding)", async () => {
  const { hub, token, port } = await startHub();
  try {
    assert.equal((await raw(port, "/")).status, 403);
    assert.equal((await raw(port, `/?token=${"0".repeat(48)}`)).status, 403);
    assert.equal((await raw(port, `/?token=${token}`, { host: "evil.example:80" })).status, 403);
    assert.equal((await raw(port, `/?token=${token}`, { host: `attacker.test:${port}` })).status, 403);
    const page = await raw(port, `/?token=${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.body, PAGE);
    assert.match(String(page.headers["content-security-policy"]), /connect-src 'self'/);
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal((await raw(port, "/health", { headers: { "x-aion-token": token }, host: `localhost:${port}` })).status, 200);
  } finally { await hub.stop(); }
});

test("commands over HTTP are validated again, whoever sends them", async () => {
  const { hub, token, port } = await startHub();
  try {
    const post = (body: unknown) => raw(port, `/api/command?token=${token}`, { method: "POST", body });
    assert.equal((await post({ type: "activity", state: "testing" })).status, 200);
    assert.equal(hub.snapshot().activity.state, "testing");
    for (const bad of [{ type: "activity", state: "dancing" }, { type: "body", body: "dragon" }, { type: "eval", code: "x" },
      { type: "present", content: { kind: "text", text: "<b>\u202e</b>" } }, { type: "present", content: { kind: "form", form: "../../etc", label: "x" } }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(hub.snapshot().activity.state, "testing");
  } finally { await hub.stop(); }
});

test("companion windows receive every change over server-sent events, and are counted as viewers", async () => {
  const { hub, token } = await startHub();
  const controller = new AbortController();
  try {
    const response = await fetch(`${hub.url}events?token=${token}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<HubSnapshot> => {
      for (;;) {
        const match = /event: snapshot\ndata: (.*)\n\n/.exec(buffer);
        if (match) { buffer = buffer.slice(match.index + match[0].length); return JSON.parse(match[1]); }
        const { value } = await reader.read();
        buffer += decoder.decode(value);
      }
    };
    assert.equal((await next()).hub.viewers, 1);
    hub.apply({ type: "body", body: "figure" });
    assert.equal((await next()).body, "figure");
    hub.apply({ type: "present", content: { kind: "text", text: "Done" } });
    assert.equal((await next()).presentation?.kind, "text");
  } finally { controller.abort(); await hub.stop(); }
});

test("embedded views and other processes can long-poll for the next revision", async () => {
  const { hub } = await startHub();
  try {
    const now = hub.snapshot();
    const immediate = await hub.waitFor(now.revision - 1, hub.id, 5_000);
    assert.equal(immediate.revision, now.revision, "an older revision returns at once");
    const otherHub = await hub.waitFor(now.revision, "another-hub", 5_000);
    assert.equal(otherHub.hub.id, hub.id, "a different hub id returns at once");
    const waiting = hub.waitFor(now.revision, hub.id, 5_000);
    setTimeout(() => hub.apply({ type: "activity", state: "building" }), 30);
    assert.equal((await waiting).activity.state, "building");
    const started = Date.now();
    await hub.waitFor(hub.snapshot().revision, hub.id, 50);
    assert.ok(Date.now() - started < 1_000, "the wait is bounded");
  } finally { await hub.stop(); }
});

test("media is served only by id, as its sniffed type, sandboxed", async () => {
  const { hub, token, port } = await startHub();
  try {
    const ref = hub.addMedia(PNG, "image/png");
    const response = await raw(port, `/media/${ref.id}?token=${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.match(String(response.headers["content-security-policy"]), /sandbox/);
    assert.equal((await raw(port, `/media/m${"0".repeat(18)}?token=${token}`)).status, 404);
    assert.equal((await raw(port, `/media/${ref.id}`)).status, 403);
    assert.equal((await raw(port, `/api/media?token=${token}`, { method: "POST", body: { mime: "image/png", data: Buffer.from("<script>").toString("base64") } })).status, 400);
  } finally { await hub.stop(); }
});

test("several Codex sessions drive one Aion; when the hub's owner goes, the next session takes over", async () => {
  const home = tempHome();
  const first = new PresenceLink({ home, port: 0, page: () => PAGE });
  const second = new PresenceLink({ home, port: 0, page: () => PAGE });
  try {
    assert.equal((await first.connect()).kind, "local");
    assert.equal((await second.connect()).kind, "remote", "the second session finds the running hub");
    await second.run(backend => backend.apply({ type: "activity", state: "editing" }));
    assert.equal((await first.run(backend => backend.state())).activity.state, "editing", "one shared presence");
    const ref = await second.run(backend => backend.addMedia(PNG, "image/png"));
    assert.deepEqual((await first.run(backend => backend.media(ref.id)))?.data, PNG);
    await first.close();
    const after = await second.run(backend => backend.apply({ type: "activity", state: "testing" }));
    assert.equal(second.current?.kind, "local", "the remaining session became the hub");
    assert.equal(after.activity.state, "testing");
  } finally { await first.close(); await second.close(); }
});
