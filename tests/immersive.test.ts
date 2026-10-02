import assert from "node:assert/strict";
import { test } from "node:test";
import { PresenceHub } from "../src/host/hub/hub";
import { browserLaunch } from "../src/host/surface";
import { connectAion, MCP_APPS_CAPABILITIES, tempHome } from "./helpers";

/**
 * Immersive mode on the host side: "Open Aion" asks for the cleanest Aion-only view the environment permits, and
 * reports honestly what that is. (The browser side — Enter Presence, true fullscreen, Esc — is in the smoke test.)
 */
type Open = {
  surface: { mode: string; open: boolean }; window_opened: boolean; fullscreen: string;
  immersive: { requested: boolean; path: string; needs_gesture: boolean }; message: string;
};
const structured = (result: unknown) => (result as { structuredContent: Open }).structuredContent;

test("Open Aion in the companion: a foreground app window that offers fullscreen at the first click", async () => {
  const aion = await connectAion();
  try {
    const opened = structured(await aion.call("open_presence", { display: "immersive" }));
    assert.equal(opened.surface.mode, "companion");
    assert.equal(opened.window_opened, true);
    assert.deepEqual(opened.immersive, { requested: true, path: "companion-fullscreen", needs_gesture: true });
    assert.match(opened.message, /one click on Enter Presence makes it fullscreen/);
    assert.equal((await aion.link.run(backend => backend.state())).hub.display, "immersive");
  } finally { await aion.close(); }
  const other = await connectAion();
  try {
    const calm = structured(await other.call("open_presence", {}));
    assert.deepEqual(calm.immersive, { requested: false, path: "none", needs_gesture: false });
  } finally { await other.close(); }
});

test("Open Aion in an MCP Apps host asks the host for fullscreen, and says the host decides", async () => {
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  try {
    const opened = structured(await aion.call("open_presence", { display: "immersive" }));
    assert.equal(opened.surface.mode, "embedded");
    assert.equal(opened.window_opened, false);
    assert.deepEqual(opened.immersive, { requested: true, path: "host-fullscreen", needs_gesture: false });
    assert.match(opened.message, /the host decides; its own composer may stay visible/);
    assert.deepEqual(aion.opened, []);
  } finally { await aion.close(); }
});

/** A companion window connected to the hub over SSE, identified by its window id, that can report itself. */
async function companion(hub: PresenceHub, token: string, window: string) {
  const controller = new AbortController();
  const response = await fetch(`${hub.url}events?token=${token}&window=${window}`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: string[] = [];
  void (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value); for (const match of buffer.matchAll(/event: (\w+)\n/g)) events.push(match[1]); buffer = ""; } } catch { /* closed */ }
  })();
  const report = (state: { focused: boolean; fullscreen: boolean; visible?: boolean }) => fetch(`${hub.url}api/surface?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ window, visible: true, ...state }),
  });
  return { events, report, close: () => controller.abort() };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80));

test("a window hidden behind others is brought forward by a new window; the old one retires when it arrives", async () => {
  const aion = await connectAion({ relaunchQuietMs: 0 });
  await aion.call("open_presence", {});
  const token = aion.link.current!.surfaceUrl.split("token=")[1];
  const hub = (aion.link.current as unknown as { hub: PresenceHub }).hub;
  try {
    const old = await companion(hub, token, "oldwindow1");
    await old.report({ focused: false, fullscreen: false, visible: false });
    await settle();
    aion.opened.length = 0;
    const raised = structured(await aion.call("open_presence", { display: "immersive" }));
    assert.equal(raised.window_opened, true, "a new window comes to the front");
    assert.equal(aion.opened.length, 1);
    assert.ok(!old.events.includes("superseded"), "the old window stays until the new one is there");
    const fresh = await companion(hub, token, "newwindow1");
    await settle();
    assert.ok(old.events.includes("superseded"), "then it retires");
    assert.ok(!fresh.events.includes("superseded"));
    old.close(); fresh.close();
  } finally { await aion.close(); }
});

test("a window on screen or fullscreen is never relaunched (focus alone does not decide)", async () => {
  const aion = await connectAion();
  await aion.call("open_presence", {});
  const token = aion.link.current!.surfaceUrl.split("token=")[1];
  const hub = (aion.link.current as unknown as { hub: PresenceHub }).hub;
  try {
    for (const state of [{ focused: false, fullscreen: false, visible: true }, { focused: false, fullscreen: true, visible: false }]) {
      const window = await companion(hub, token, `win${state.fullscreen ? "fulls" : "shown"}`);
      await window.report(state);
      await settle();
      aion.opened.length = 0;
      const again = structured(await aion.call("open_presence", { display: "immersive" }));
      assert.equal(again.window_opened, false, JSON.stringify(state));
      assert.deepEqual(aion.opened, []);
      assert.match(again.message, state.fullscreen ? /already open in fullscreen/ : /already open on screen/);
      window.close();
      await settle();
    }
  } finally { await aion.close(); }
});

test("surface reports carry only focus, fullscreen and visibility, and need the token", async () => {
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "" });
  await hub.start();
  try {
    const token = hub.surfaceUrl.split("token=")[1];
    const post = (body: unknown, auth = true) => fetch(`${hub.url}api/surface${auth ? `?token=${token}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ window: "abcdefgh", focused: true, fullscreen: false, visible: true }, false)).status, 403);
    assert.equal((await post({ window: "abcdefgh", focused: true, fullscreen: false, visible: true, url: "x" })).status, 400, "nothing else is accepted");
    assert.equal((await post({ window: "abcdefgh", focused: true, fullscreen: false, visible: true })).status, 204);
    assert.deepEqual(hub.snapshot().hub.surface, { focused: false, visible: false, fullscreen: false }, "a report counts only for a connected window");
  } finally { await hub.stop(); }
});

test("the launcher asks for a maximized, foreground app window; fullscreen still needs the user's click", () => {
  const exists = (path: string) => path === "/Applications/Google Chrome.app";
  const immersive = browserLaunch("http://127.0.0.1:1/?token=x", "darwin", {}, exists, { immersive: true })!;
  assert.deepEqual(immersive.args, ["-na", "Google Chrome", "--args", "--app=http://127.0.0.1:1/?token=x", "--start-maximized"]);
  assert.ok(!immersive.args.some(arg => /kiosk|start-fullscreen|autoplay|use-fake-ui|auto-accept/.test(arg)), "no flag bypasses a browser permission or gesture");
  const calm = browserLaunch("http://127.0.0.1:1/?token=x", "darwin", {}, exists)!;
  assert.ok(calm.args.includes("--window-size=880,980"));
});

test("?debug=1 diagnostics reach `npm run diagnose` through the local hub, token-gated and strictly shaped", async () => {
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "" });
  await hub.start();
  try {
    const token = hub.surfaceUrl.split("token=")[1];
    const post = (body: unknown, auth = true) => fetch(`${hub.url}api/diagnostics${auth ? `?token=${token}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const lines = { mic: "ready · permission granted · track-processor · audio running", vad: "rms 0.0410 · floor 0.0060 · voice · level 0.63 · echo none" };
    assert.equal((await post({ window: "abcdefgh", lines }, false)).status, 403);
    assert.equal((await post({ window: "abcdefgh", lines: { mic: "x".repeat(300) } })).status, 400);
    assert.equal((await post({ window: "abcdefgh", lines, audio: "samples" })).status, 400, "nothing but labelled lines");
    assert.equal((await post({ window: "abcdefgh", lines })).status, 204);
    assert.equal((await fetch(`${hub.url}api/diagnostics`)).status, 403);
    const reported = await (await fetch(`${hub.url}api/diagnostics?token=${token}`)).json() as Record<string, { lines: unknown }>;
    assert.deepEqual(Object.keys(reported), ["abcdefgh"]);
    assert.deepEqual(reported.abcdefgh.lines, lines);
  } finally { await hub.stop(); }
});

test("a window launched moments ago is never replaced, even before it reports", async () => {
  const aion = await connectAion();
  try {
    await aion.call("open_presence", { display: "immersive" });
    const hub = (aion.link.current as unknown as { hub: PresenceHub }).hub;
    const window = await companion(hub, aion.link.current!.surfaceUrl.split("token=")[1], "loadingwin");
    await window.report({ focused: false, fullscreen: false, visible: false });
    await settle();
    aion.opened.length = 0;
    assert.equal(structured(await aion.call("open_presence", { display: "immersive" })).window_opened, false);
    assert.deepEqual(aion.opened, []);
    window.close();
  } finally { await aion.close(); }
});
