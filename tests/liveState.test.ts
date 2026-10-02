import assert from "node:assert/strict";
import { test } from "node:test";
import { Aion } from "../src/core/aion";
import { gestureTarget, solvePose } from "../src/core/figure/pose";
import { EmphasisDetector } from "../src/core/listening/emphasis";
import type { MicFrame, MicInput } from "../src/core/listening/frame";
import { VoiceActivityDetector } from "../src/core/listening/vad";
import { engineDefaults, PresenceEngine } from "../src/core/signal";
import type { ActivityState, AionState } from "../src/core/state";
import type { StoreClock } from "../src/core/store";
import { pickEvent } from "../src/host/hooks/forward";
import { estimateSpeechSeconds, SPEECH_MAX_SECONDS } from "../src/host/hooks/speech";
import { ANSWER_TAIL, PresenceHub } from "../src/host/hub/hub";
import { hookEventSchema } from "../src/host/hub/protocol";
import { tempHome } from "./helpers";

/**
 * The live state pipeline, end to end without a browser: a scripted microphone through SCF's real VAD, the
 * Presence engine, Aion's state machine and the figure; and the hub's turn lifecycle with the Stop hook.
 */
class ScriptedMic implements MicInput {
  readonly vad = new VoiceActivityDetector();
  readonly emphasis = new EmphasisDetector();
  rms = 0.002;
  read(dt: number): MicFrame {
    const vad = this.vad.sample(this.rms, dt);
    return { voiced: vad.voiced, level: vad.level, utterance: vad.utterance, emphasis: this.emphasis.sample(vad.level, vad.voiced, vad.utterance, dt), rms: this.rms };
  }
}

function surface() {
  let host: ActivityState = "idle";
  let presenting = false;
  const mic = new ScriptedMic();
  const aion: Aion = new Aion({ activity: () => engine.activity, presenting: () => presenting, signal: () => engine.signal });
  const engine = new PresenceEngine({ state: () => aion.currentState, host: () => host });
  engine.setMicrophone(mic);
  let now = 0;
  const states = new Set<AionState>();
  const activities: ActivityState[] = [];
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      now += 1 / 60; engine.sample(1 / 60, now); aion.sample(1 / 60, now);
      states.add(aion.currentState);
      if (activities.at(-1) !== engine.activity) activities.push(engine.activity);
    }
    return { activity: engine.activity, state: aion.currentState };
  };
  return { mic, engine, aion, run, states, activities, host: (state: ActivityState) => { host = state; }, present: (value: boolean) => { presenting = value; } };
}
const speech = 0.06, silence = 0.002;

test("a visual on the body never silences listening: the formed visual follows the user's loudness", () => {
  const s = surface();
  s.run(1);
  s.present(true);
  s.mic.rms = speech;
  const heard = s.run(1.2);
  assert.equal(heard.state, "presenting", "the body keeps presenting");
  assert.equal(heard.activity, "listening", "but Aion is listening");
  assert.ok(s.engine.signal.userAmplitude > 0.1, "and the user's loudness reaches the renderer");
});

test("pauses between phrases keep Aion listening: no flicker to thinking, no repeated nod", () => {
  const s = surface();
  s.run(1);
  for (let phrase = 0; phrase < 4; phrase++) {
    s.mic.rms = speech; s.run(1.1);
    s.mic.rms = silence; s.run(0.5);
  }
  assert.deepEqual(s.activities, ["idle", "listening"], "one continuous turn");
  assert.ok(!s.states.has("acknowledging") && !s.states.has("thinking"));
  s.run(1.5);
  assert.equal(s.engine.activity, "thinking", "a real end of turn still starts a thought");
});

test("a stale responding (a turn end that never arrived) stops silencing the microphone", () => {
  const s = surface();
  s.run(1);
  s.host("responding");
  s.mic.rms = speech;
  s.run(3);
  assert.equal(s.engine.activity, "responding");
  assert.equal(s.engine.echo, "responding");
  s.mic.rms = silence;
  s.run(engineDefaults.respondingEchoMax);
  s.mic.rms = speech;
  assert.equal(s.run(1.2).activity, "responding", "real work states still outrank the voice (responding is not listenable)");
  assert.equal(s.engine.echo, "none", "but the voice is no longer treated as Codex's own");
  assert.equal(s.engine.userVoiced, true);
});

test("the audible tail of an answer is not the user; the user after a pause is", () => {
  const s = surface();
  s.run(1);
  s.host("responding");
  s.mic.rms = speech; // Codex's voice from the speakers
  s.run(2);
  s.host("complete"); // the turn ended while the voice still plays
  assert.notEqual(s.run(4).activity, "listening", "the answer still playing is not the user");
  assert.equal(s.engine.echo, "answer-tail");
  s.mic.rms = silence; s.run(1.2);
  s.mic.rms = speech;
  assert.equal(s.run(1).activity, "listening", "after a pause, the user is heard");
  // The tail never lasts forever, even when the room never goes quiet.
  const t = surface();
  t.run(1); t.host("responding"); t.mic.rms = speech; t.run(1); t.host("idle");
  t.run(engineDefaults.echoTailMax + 1);
  assert.equal(t.engine.echo, "none");
});

test("diagnostics: the engine reports the latest microphone frame and the echo reason", () => {
  const s = surface();
  s.run(1); s.mic.rms = 0.041; s.run(1);
  assert.equal(s.engine.lastFrame?.rms, 0.041);
  assert.equal(s.engine.lastFrame?.voiced, true);
  assert.equal(s.engine.echo, "none");
  s.engine.setMicrophone(null);
  s.run(0.1);
  assert.equal(s.engine.lastFrame, null);
});

test("the figure listens visibly: amplitude-linked lean and nods, restrained", () => {
  const quiet = solvePose(gestureTarget("listening", 1, 0, 0));
  const loud = solvePose(gestureTarget("listening", 1, 0, 1));
  const moved = Math.max(...quiet.map((value, i) => Math.abs(value - loud[i])));
  assert.ok(moved > 0.01 && moved < 0.1, `the voice moves the figure a little (${moved.toFixed(3)})`);
});

test("the figure answers visibly and never as a loop", () => {
  const poses = Array.from({ length: 40 }, (_, k) => solvePose(gestureTarget("responding", 1 + k * 0.25)));
  const spread = (i: number) => Math.max(...poses.map(p => p[i])) - Math.min(...poses.map(p => p[i]));
  const hands = Math.max(...Array.from({ length: poses[0].length }, (_, i) => spread(i)));
  assert.ok(hands > 0.03, `clearly moving (${hands.toFixed(3)})`);
  // The same moment one apparent "period" later is not the same pose.
  for (const period of [1 / 0.47, 1 / 0.31, 1 / 0.17]) {
    const a = solvePose(gestureTarget("responding", 3)), b = solvePose(gestureTarget("responding", 3 + period));
    assert.ok(a.some((value, i) => Math.abs(value - b[i]) > 0.002), `not periodic at ${period.toFixed(2)} s`);
  }
});

// ── The turn lifecycle in the hub ─────────────────────────────────────────────────────────────────────

function fakeClock() {
  let time = 0;
  const timers: { at: number; run: () => void }[] = [];
  const clock: StoreClock = {
    now: () => time,
    schedule(callback, ms) { const timer = { at: time + ms, run: callback }; timers.push(timer); return () => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); }; },
  };
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1); time = next.at; next.run();
    }
    time = end;
  };
  return { clock, advance };
}

test("Stop: an answer still being said keeps Aion answering for as long as it takes, then completes", () => {
  const { clock, advance } = fakeClock();
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "", clock });
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.apply({ type: "activity", state: "responding" });
  advance(2_000);
  hub.hook({ hook_event_name: "Stop", speech_seconds: 14 });
  assert.equal(hub.snapshot().activity.state, "responding");
  advance(11_000);
  assert.equal(hub.snapshot().activity.state, "responding", "about 12 s of the answer were left to say");
  advance(1_500);
  assert.equal(hub.snapshot().activity.state, "complete");
  advance(7_000);
  assert.equal(hub.snapshot().activity.state, "idle");
});

test("the answer tail is bounded, and a new prompt or an interruption ends it at once", () => {
  const { clock, advance } = fakeClock();
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "", clock });
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.apply({ type: "activity", state: "responding" });
  hub.hook({ hook_event_name: "Stop", speech_seconds: 120 });
  advance(ANSWER_TAIL.maxSeconds * 1000 + 100);
  assert.equal(hub.snapshot().activity.state, "complete", `at most ${ANSWER_TAIL.maxSeconds} s`);

  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.apply({ type: "activity", state: "responding" });
  hub.hook({ hook_event_name: "Stop", speech_seconds: 30 });
  advance(3_000);
  hub.hook({ hook_event_name: "Interrupt" });
  assert.equal(hub.snapshot().activity.state, "idle", "the user interrupted");
  advance(40_000);
  assert.equal(hub.snapshot().activity.state, "idle", "the old tail cannot come back");

  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.apply({ type: "activity", state: "responding" });
  hub.hook({ hook_event_name: "Stop", speech_seconds: 30 });
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  assert.equal(hub.snapshot().activity.state, "thinking", "a new prompt starts a new turn");
  advance(40_000);
  assert.notEqual(hub.snapshot().activity.state, "complete");
});

test("Stop without an answer (or a short one) completes as before", () => {
  const { clock } = fakeClock();
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "", clock });
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.hook({ hook_event_name: "Stop", speech_seconds: 20 });
  assert.equal(hub.snapshot().activity.state, "complete", "Codex never said it was answering: no tail is invented");
  hub.hook({ hook_event_name: "UserPromptSubmit" });
  hub.apply({ type: "activity", state: "responding" });
  hub.hook({ hook_event_name: "Stop", speech_seconds: 1 });
  assert.equal(hub.snapshot().activity.state, "complete");
});

test("the Stop hook forwards how long the answer takes to say — never the answer", () => {
  const message = "Nikola Tesla was a Serbian-American inventor. He had a slim build, dark hair parted in the middle and a thin moustache.";
  const event = pickEvent({ hook_event_name: "Stop", session_id: "s", last_assistant_message: message, turn_id: "t", stop_hook_active: false });
  assert.ok(event);
  assert.deepEqual(Object.keys(event).sort(), ["hook_event_name", "session_id", "speech_seconds"]);
  assert.ok(!JSON.stringify(event).includes("Tesla"));
  assert.ok(event.speech_seconds! > 5 && event.speech_seconds! < 12);
  assert.equal(hookEventSchema.parse({ ...event, last_assistant_message: message }).speech_seconds, event.speech_seconds);
  assert.ok(!("last_assistant_message" in hookEventSchema.parse({ ...event, last_assistant_message: message })), "the hub drops text even if sent");
  assert.equal(pickEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", last_assistant_message: message })?.speech_seconds, undefined);
});

test("speech duration: words and CJK characters count; code, links and markup do not", () => {
  assert.equal(estimateSpeechSeconds(""), 0);
  assert.equal(estimateSpeechSeconds(null), 0);
  const words = estimateSpeechSeconds("one two three four five six seven eight nine ten eleven twelve thirteen");
  assert.ok(words > 4 && words < 6);
  assert.ok(Math.abs(estimateSpeechSeconds("这是一个关于猎户座的回答") - 12 / 4.2) < 0.2);
  const withCode = estimateSpeechSeconds(`Here is the fix.\n\n\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\`\nSee https://example.com/a/b/c for more.`);
  assert.ok(withCode < 3, `code is not read aloud (${withCode})`);
  assert.equal(estimateSpeechSeconds("word ".repeat(10_000)), SPEECH_MAX_SECONDS);
});

test("answering continues through a visual: the formed visual keeps the answer's life", () => {
  const s = surface();
  s.run(1);
  s.present(true);
  s.host("responding");
  const shown = s.run(2.5);
  assert.equal(shown.state, "presenting", "the visual keeps the pose");
  assert.ok(s.engine.signal.responding > 0.8, "and the answer still reaches the renderer");
  s.host("complete");
  s.run(2.5);
  assert.ok(s.engine.signal.responding < 0.1);
});
