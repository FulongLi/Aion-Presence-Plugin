import assert from "node:assert/strict";
import { test } from "node:test";
import { Aion } from "../src/core/aion";
import type { HostAudioSource } from "../src/core/audio";
import { gestureTarget, NEUTRAL_POSE, solvePose } from "../src/core/figure/pose";
import { EmphasisDetector } from "../src/core/listening/emphasis";
import type { MicFrame, MicInput } from "../src/core/listening/frame";
import { VoiceActivityDetector } from "../src/core/listening/vad";
import { planPresentation } from "../src/core/presentation";
import { engineDefaults, FIELD_TARGETS, PresenceEngine } from "../src/core/signal";
import type { ActivityState } from "../src/core/state";
import type { StoreClock } from "../src/core/store";
import { PresenceHub } from "../src/host/hub/hub";
import { VisualActionController } from "../src/visual/controller";
import { tempHome } from "./helpers";

/**
 * A microphone made of a loudness schedule, run through SCF's real VAD and emphasis detectors: the same path
 * as the browser listener, minus the audio device.
 */
class ScriptedMic implements MicInput {
  readonly vad = new VoiceActivityDetector();
  readonly emphasis = new EmphasisDetector();
  rms = 0.002;
  read(dt: number): MicFrame {
    const vad = this.vad.sample(this.rms, dt);
    return { voiced: vad.voiced, level: vad.level, utterance: vad.utterance, emphasis: this.emphasis.sample(vad.level, vad.voiced, vad.utterance, dt) };
  }
}

/** One Aion on a surface: host activity in, effective activity and Aion state out, at 60 frames a second. */
function surface(options: { audio?: HostAudioSource } = {}) {
  let host: ActivityState = "idle";
  let presenting = false;
  const mic = new ScriptedMic();
  const aion: Aion = new Aion({ activity: () => engine.activity, presenting: () => presenting, signal: () => engine.signal });
  const engine = new PresenceEngine({ state: () => aion.currentState, host: () => host, audio: options.audio });
  engine.setMicrophone(mic);
  let now = 0;
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) { now += 1 / 60; engine.sample(1 / 60, now); aion.sample(1 / 60, now); }
    return { activity: engine.activity, state: aion.currentState };
  };
  return {
    mic, engine, aion, run,
    host: (state: ActivityState) => { host = state; },
    present: (value: boolean) => { presenting = value; },
  };
}

const speech = 0.06, silence = 0.002;

test("idle → the user speaks → listening → they stop → thinking (inferred), then the host takes over", () => {
  const s = surface();
  assert.equal(s.run(1).activity, "idle", "the VAD calibrates on a quiet room");
  s.mic.rms = speech;
  const heard = s.run(1.2);
  assert.equal(heard.activity, "listening");
  assert.equal(heard.state, "listening");
  assert.ok(s.engine.signal.focus > 0.5 && s.engine.signal.userAmplitude > 0, "the body gathers and follows the voice");
  s.mic.rms = silence;
  assert.equal(s.run(0.9).activity, "listening", "a pause between phrases keeps Aion listening");
  const after = s.run(0.6);
  assert.equal(after.activity, "thinking", "a finished utterance starts a thought");
  s.host("thinking"); // UserPromptSubmit arrives
  assert.equal(s.run(0.5).activity, "thinking");
  s.host("reading");
  assert.equal(s.run(0.5).activity, "reading", "real work replaces the inferred thought at once");
});

test("an inferred thought is short-lived when the host never confirms it", () => {
  const s = surface();
  s.run(1); s.mic.rms = speech; s.run(1.2); s.mic.rms = silence; s.run(1.5);
  assert.equal(s.engine.activity, "thinking");
  assert.equal(s.run(engineDefaults.inferredThinking).activity, "idle");
});

test("a Codex turn: thinking → reading → editing → testing → responding → complete → idle", () => {
  let time = 0;
  const timers: { at: number; run: () => void }[] = [];
  const clock: StoreClock = {
    now: () => time,
    schedule(callback, ms) { const timer = { at: time + ms, run: callback }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; },
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
  const hub = new PresenceHub({ home: tempHome(), port: 0, page: () => "", clock });
  const seen: string[] = [];
  const note = () => { const state = hub.snapshot().activity.state; if (seen.at(-1) !== state) seen.push(state); };
  const hook = (event: Record<string, string>) => { hub.hook({ hook_event_name: "", ...event } as never); note(); };
  note();
  hook({ hook_event_name: "UserPromptSubmit" });
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "rg -n render src" }); hook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "rg -n render src" });
  hook({ hook_event_name: "PreToolUse", tool_name: "apply_patch" }); hook({ hook_event_name: "PostToolUse", tool_name: "apply_patch" });
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash", command: "npm test" }); hook({ hook_event_name: "PostToolUse", tool_name: "Bash", command: "npm test" });
  advance(1_500); note();
  // The Skill: just before the final answer, once.
  hub.apply({ type: "activity", state: "responding" }); note();
  // Aion's own tool calls are not work: they never move the state.
  hook({ hook_event_name: "PreToolUse", tool_name: "mcp__aion-presence__set_presence_state" });
  hook({ hook_event_name: "Stop" });
  advance(6_500); note();
  assert.deepEqual(seen, ["idle", "thinking", "reading", "editing", "testing", "thinking", "responding", "complete", "idle"]);
});

test("responding: Codex's own voice from the speakers does not flip Aion to listening", () => {
  const s = surface();
  s.run(1);
  s.host("responding");
  s.run(0.5);
  s.mic.rms = speech; // the speakers play Codex's answer
  assert.equal(s.run(2).activity, "responding", "no self-listening while Codex answers");
  assert.equal(s.engine.userVoiced, false);
  s.host("complete");
  assert.notEqual(s.run(1).activity, "listening", "nor right after it (the echo hold)");
  s.mic.rms = silence; s.run(1);
  s.mic.rms = speech;
  assert.equal(s.run(1.5).activity, "listening", "once the hold has passed, the user is heard again");
});

test("state precedence: the user's voice never hides real work, and a visual outranks listening", () => {
  const s = surface();
  s.run(1);
  s.host("editing");
  s.mic.rms = speech;
  assert.equal(s.run(1.5).activity, "editing");
  s.host("idle");
  assert.equal(s.run(0.6).activity, "listening");
  s.present(true);
  assert.equal(s.run(0.5).state, "presenting");
});

test("without a microphone (permission denied), Aion follows the host's states exactly", () => {
  const s = surface();
  s.engine.setMicrophone(null);
  for (const state of ["thinking", "reading", "responding", "complete", "idle"] as const) {
    s.host(state);
    assert.equal(s.run(0.3).activity, state);
  }
});

test("responding is semantic: a gentle field and figure motion, never a made-up amplitude or spectrum", () => {
  const s = surface();
  s.host("thinking"); s.run(2);
  s.host("responding");
  const { state } = s.run(3);
  assert.equal(state, "responding");
  assert.equal(s.engine.signal.mode, "idle", "speaking mode only comes from real host audio");
  assert.ok(s.engine.signal.responding > 0.9, "the response swell is on");
  assert.equal(s.engine.signal.assistantAmplitude, 0);
  assert.ok(s.engine.signal.assistantBands.every(value => value === 0));
  assert.ok(s.engine.signal.warmth > FIELD_TARGETS.idle.warmth);
  s.host("complete"); s.run(3);
  assert.ok(s.engine.signal.responding < 0.05, "and it ends with the answer");
  // The figure answers with slow hand, head and torso movement: clearly alive, and still restrained — well under
  // half of the presenting gesture's reach (0.29) and far from the greeting's wave.
  const neutral = solvePose(NEUTRAL_POSE);
  const poses = Array.from({ length: 240 }, (_, k) => solvePose(gestureTarget("responding", k * 0.25)));
  for (const pose of poses) for (let i = 0; i < pose.length; i++) assert.ok(Math.abs(pose[i] - neutral[i]) < 0.16, "restrained");
  assert.ok(poses.some((pose, k) => k && pose.some((value, i) => Math.abs(value - poses[0][i]) > 0.004)), "it moves");
});

test("real host audio, when a host exposes it, is speaking — and its echo guard still applies", () => {
  let amplitude = 0;
  const s = surface({ audio: { name: "test-host", read: () => amplitude ? { amplitude, bands: new Array(16).fill(amplitude) } : null } });
  s.run(1);
  amplitude = 0.5;
  s.mic.rms = speech;
  const speaking = s.run(1);
  assert.equal(s.engine.signal.mode, "speaking");
  assert.equal(speaking.state, "speaking");
  assert.notEqual(speaking.activity, "listening", "its own voice is not the user");
  assert.ok(s.engine.signal.assistantAmplitude > 0.3);
});

test("persistent body: figure → portrait → figure, figure → terrain → figure, sphere → Orion → sphere", async () => {
  const media = { id: `m${"a".repeat(18)}`, mime: "image/jpeg", bytes: 100 };
  const visuals = [
    { body: "figure" as const, content: { kind: "image" as const, media, mode: "particles" as const, fit: "portrait" as const, alt: "Nikola Tesla" } },
    { body: "figure" as const, content: { kind: "terrain" as const, media: { ...media, mime: "application/vnd.aion.heightfield" }, style: "terrain" as const, label: "United Kingdom" } },
    { body: "sphere" as const, content: { kind: "form" as const, form: "astronomy.orion", label: "Orion" } },
  ];
  for (const { body, content } of visuals) {
    const aion = new Aion({ activity: () => "idle", presenting: () => controller.presenting, signal: () => new PresenceEngine({ state: () => "idle" }).signal });
    const controller = new VisualActionController<unknown>(async () => ({ visual: { kind: "points", style: "celestial", layout: { points: [{ x: 0, y: 0, weight: 1, radius: 0.1, tone: 1 }], strokes: [], dust: 0 } }, hold: 1, label: "x" }));
    aion.setBody(body);
    const plan = planPresentation(content);
    assert.notEqual(plan.body.type, "none", `${content.kind} becomes the body itself`);
    await controller.submit(plan.body);
    let now = 0;
    const run = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) { now += 1 / 60; controller.sample(1 / 60); aion.sample(1 / 60, now); } };
    run(2);
    assert.equal(controller.phase, "holding");
    assert.equal(aion.currentBody, body);
    run(4);
    assert.equal(controller.phase, "sphere", "the visual returned");
    assert.equal(aion.currentBody, body, `${body} → ${content.kind} → ${body}`);
    assert.equal(aion.body.level, body === "figure" ? 1 : 0);
  }
});
