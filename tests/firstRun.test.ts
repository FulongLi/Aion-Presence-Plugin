import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { autoOpenSetting, firstRunDone, markFirstRun, SETTINGS_FILE, shouldAutoOpen } from "../src/host/firstRun";
import { PresenceHub } from "../src/host/hub/hub";
import { connectAion, tempHome } from "./helpers";

test("first run: Aion opens by itself once after installation, then only when asked", () => {
  const home = tempHome();
  assert.equal(autoOpenSetting(home, {}), "first-run");
  assert.equal(shouldAutoOpen(home, {}), true, "the first session opens Aion");
  markFirstRun(home);
  assert.equal(firstRunDone(home), true);
  assert.equal(shouldAutoOpen(home, {}), false, "never a new window on every session");
});

test("the auto-open setting: settings.json or AION_PRESENCE_AUTO_OPEN (always, never)", () => {
  const home = tempHome();
  markFirstRun(home);
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ autoOpen: "always" }));
  assert.equal(shouldAutoOpen(home, {}), true);
  assert.equal(shouldAutoOpen(home, { AION_PRESENCE_AUTO_OPEN: "never" }), false, "the environment wins");
  writeFileSync(join(home, SETTINGS_FILE), JSON.stringify({ autoOpen: "sometimes" }));
  assert.equal(autoOpenSetting(home, {}), "first-run", "an unknown value is the default");
  assert.equal(shouldAutoOpen(tempHome(), { AION_PRESENCE_AUTO_OPEN: "never" }), false);
});

test("after a first-run opening, Codex still introduces Aion the first time the user opens it", async () => {
  const aion = await connectAion();
  try {
    await aion.link.run(backend => backend.apply({ type: "open", greet: true, introduce: true }));
    assert.equal((await aion.link.run(backend => backend.state())).hub.introduction, true);
    const first = (await aion.call("open_presence") as { structuredContent: { greeting: { due: boolean } } }).structuredContent;
    assert.equal(first.greeting.due, true);
    assert.equal((await aion.link.run(backend => backend.state())).hub.introduction, false, "introduced once");
  } finally { await aion.close(); }
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "" });
  assert.equal(hub.snapshot().hub.introduction, false);
});
