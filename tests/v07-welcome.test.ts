import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseVoice, WelcomeNarration, welcomeScript, narrationDefaults, type VoiceInfo, type NarrationInputs } from "../src/core/welcomeNarration";
import { PresenceHub } from "../src/host/hub/hub";
import { hubCommandSchema } from "../src/host/hub/protocol";

/**
 * v0.7 Task 1: the spoken first-run welcome — its script, the voice it chooses, and its lifecycle (a pure state machine;
 * the real renderer and the real synthesizer are exercised by `npm run smoke -- --only=welcome` and
 * `npm run welcome:speech`).
 */
const quiet: NarrationInputs = { bodyReady: true, busy: false, speech: true };
const settle = narrationDefaults.settleMs + 10;

test("v0.7 welcome script: four short sentences, English and Chinese, Codex's companion, never a second AI", () => {
  for (const language of ["en", "zh"] as const) {
    const script = welcomeScript(language);
    assert.equal(script.length, 4);
    const all = script.join(" ");
    assert.match(all, /Aion/);
    assert.match(all, /Codex/);
    assert.doesNotMatch(all, /another AI|second AI|独立的 AI/);
  }
  // About 15–25 s at a natural rate (≈ 2.6 English words a second; ≈ 4.5 Chinese characters a second).
  const words = welcomeScript("en").join(" ").split(/\s+/).length;
  assert.ok(words >= 35 && words <= 60, `${words} words`);
  const chars = welcomeScript("zh").join("").replace(/[\s，。、a-zA-Z]/g, "").length;
  assert.ok(chars >= 50 && chars <= 100, `${chars} characters`);
});

test("v0.7 voice: an on-device voice in the user's language, region first, enhanced first, never a network or novelty voice", () => {
  const voices: VoiceInfo[] = [
    { name: "Google US English", lang: "en-US", localService: false },
    { name: "Albert", lang: "en-US", localService: true },
    { name: "Daniel", lang: "en-GB", localService: true },
    { name: "Samantha", lang: "en-US", localService: true, default: true },
    { name: "Ava (Premium)", lang: "en-US", localService: true },
    { name: "Tingting", lang: "zh-CN", localService: true },
    { name: "Sinji", lang: "zh-HK", localService: true },
    { name: "Google 普通话（中国大陆）", lang: "zh-CN", localService: false },
  ];
  assert.equal(chooseVoice(voices, "en", "en-US")?.name, "Ava (Premium)");
  assert.equal(chooseVoice(voices.filter(v => !/Ava/.test(v.name)), "en", "en-US")?.name, "Samantha");
  assert.equal(chooseVoice(voices.filter(v => !/Ava|Samantha/.test(v.name)), "en", "en-GB")?.name, "Daniel");
  assert.equal(chooseVoice(voices, "zh", "zh-CN")?.name, "Tingting");
  assert.equal(chooseVoice(voices, "zh", "zh-HK")?.name, "Sinji");
  assert.equal(chooseVoice(voices.filter(v => v.localService === false || v.lang.startsWith("en")), "zh", "zh-CN"), null, "only a network voice: none");
  assert.equal(chooseVoice([{ name: "Albert", lang: "en-US", localService: true }], "en"), null, "a novelty voice is never Aion's");
});

test("v0.7 narration: waits for the body and a quiet moment, speaks, and completes as spoken only at the end", () => {
  const n = new WelcomeNarration();
  n.due(0);
  assert.deepEqual(n.tick({ ...quiet, bodyReady: false }, 100), {});
  assert.deepEqual(n.tick(quiet, 200), {}, "settles first (the greeting wave)");
  assert.deepEqual(n.tick({ ...quiet, busy: true }, 900), {}, "Codex is answering: it waits");
  assert.deepEqual(n.tick(quiet, 1_000), {});
  assert.deepEqual(n.tick(quiet, 1_000 + settle), { speak: true });
  assert.equal(n.phase, "starting");
  n.started(); n.spokeSentence(0);
  assert.equal(n.phase, "speaking");
  assert.equal(n.sentence, 0);
  n.spokeSentence(3);
  assert.deepEqual(n.ended(), { complete: "spoken" });
  assert.equal(n.phase, "finished");
  assert.deepEqual(n.ended(), {}, "once");
});

test("v0.7 narration: autoplay refusal offers Listen and is not completed; the gesture then speaks", () => {
  const n = new WelcomeNarration();
  n.due(0);
  n.tick(quiet, 0); n.tick(quiet, settle);
  assert.equal(n.phase, "starting");
  assert.deepEqual(n.failed(settle + 50, true), { cancel: true });
  assert.equal(n.phase, "offered");
  assert.equal(n.completed, null, "a refusal is never taken for a welcome that was heard");
  assert.deepEqual(n.listen(settle + 5_000, true), { cancel: true, speak: true });
  n.started();
  assert.deepEqual(n.ended(), { complete: "spoken" });

  // No start event at all within the limit: the same (some engines stay silent instead of reporting).
  const m = new WelcomeNarration();
  m.due(0); m.tick(quiet, 0); m.tick(quiet, settle);
  assert.deepEqual(m.tick(quiet, settle + narrationDefaults.startMs + 10), { cancel: true });
  assert.equal(m.phase, "offered");
  assert.equal(m.completed, null);
});

test("v0.7 narration: no on-device voice — a short text stands in, counted as read only after a while on screen", () => {
  const n = new WelcomeNarration();
  n.due(0);
  assert.deepEqual(n.tick({ ...quiet, speech: false }, 10), {});
  assert.equal(n.phase, "text");
  assert.deepEqual(n.tick({ ...quiet, speech: false }, 1_000), {});
  assert.deepEqual(n.tick({ ...quiet, speech: false }, narrationDefaults.readMs + 20), { complete: "read" });
  // A synthesizer that fails after the user's own click: text, never "spoken".
  const m = new WelcomeNarration();
  m.due(0); m.tick(quiet, 0); m.tick(quiet, settle); m.failed(settle + 10, true);
  m.listen(settle + 100, true);
  assert.deepEqual(m.failed(settle + 200, true), { cancel: true });
  assert.equal(m.phase, "text");
  assert.equal(m.completed, null);
});

test("v0.7 narration: Skip, Replay, a visual request, a new turn and closing the window", () => {
  // Skip while speaking stops the voice and completes as skipped.
  const a = new WelcomeNarration();
  a.due(0); a.tick(quiet, 0); a.tick(quiet, settle); a.started();
  assert.deepEqual(a.skip(), { cancel: true, complete: "skipped" });
  // Replay after it finished speaks again; it is already complete, so nothing new is remembered.
  const b = new WelcomeNarration();
  b.due(0); b.tick(quiet, 0); b.tick(quiet, settle); b.started(); b.ended();
  assert.deepEqual(b.listen(10_000, true), { cancel: true, speak: true });
  b.started();
  assert.deepEqual(b.ended(), {});
  // A visual request while speaking: the user has started.
  const c = new WelcomeNarration();
  c.due(0); c.tick(quiet, 0); c.tick(quiet, settle); c.started();
  assert.deepEqual(c.interrupt("visual"), { cancel: true, complete: "started" });
  // A visual request before it spoke: also started (no voice to stop).
  const d = new WelcomeNarration();
  d.due(0);
  assert.deepEqual(d.interrupt("visual"), { complete: "started" });
  // A new conversation turn while it speaks: it stops (heard, so complete as interrupted); while waiting it just waits.
  const e = new WelcomeNarration();
  e.due(0);
  assert.deepEqual(e.interrupt("conversation"), {});
  assert.equal(e.phase, "waiting");
  e.tick(quiet, 0); e.tick(quiet, settle); e.started();
  assert.deepEqual(e.interrupt("conversation"), { cancel: true, complete: "interrupted" });
  // Closing the window before a word was spoken: stopped, not remembered (the next first launch speaks it).
  const f = new WelcomeNarration();
  f.due(0); f.tick(quiet, 0); f.tick(quiet, settle);
  assert.deepEqual(f.interrupt("closed"), { cancel: true });
  assert.equal(f.completed, null);
  // Closing while it speaks: heard, so remembered (a returning user does not hear it again).
  const g = new WelcomeNarration();
  g.due(0); g.tick(quiet, 0); g.tick(quiet, settle); g.started(); g.spokeSentence(1);
  assert.deepEqual(g.interrupt("closed"), { cancel: true, complete: "interrupted" });
  // Codex busy for too long: Listen is offered instead of waiting forever.
  const h = new WelcomeNarration();
  h.due(0);
  h.tick({ ...quiet, busy: true }, narrationDefaults.busyMs + 1);
  assert.equal(h.phase, "offered");
});

test("v0.7 hub: the welcome's outcome is validated and remembered; a returning user is not welcomed again", () => {
  assert.equal(hubCommandSchema.safeParse({ type: "welcome", done: true, outcome: "spoken" }).success, true);
  assert.equal(hubCommandSchema.safeParse({ type: "welcome", done: true, outcome: "heard-it-maybe" }).success, false);
  const home = mkdtempSync(join(tmpdir(), "aion-v07-welcome-"));
  const hub = new PresenceHub({ home, port: 0, page: () => "<p>", bridge: { locate: () => null } });
  assert.equal(hub.snapshot().hub.welcome, true);
  hub.apply({ type: "welcome", done: true, outcome: "spoken" });
  assert.equal(hub.snapshot().hub.welcome, false);
  assert.ok(existsSync(join(home, "welcome-complete")));
  assert.match(readFileSync(join(home, "welcome-complete"), "utf8"), / spoken\n$/);
  assert.equal(new PresenceHub({ home, port: 0, page: () => "<p>", bridge: { locate: () => null } }).snapshot().hub.welcome, false, "a Codex restart does not repeat it");
});
