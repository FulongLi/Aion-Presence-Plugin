import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NO_HOST_AUDIO } from "../src/core/audio";
import { AION_BODIES, AionBody, bodyTransition, PERSISTENT_BODIES, resolveBodyForm } from "../src/core/body";
import { createFigureLayout, FIGURE_KINDS, figurePoint, packAnchors, unpackAnchors } from "../src/core/figure/layout";
import { FigureAnimator, gestureTarget, NEUTRAL_POSE, solvePose } from "../src/core/figure/pose";
import { ANCHOR, ANCHOR_COUNT, ANCHORS, FIGURE_SCALE, PROPORTIONS } from "../src/core/figure/skeleton";
import { AION_IDENTITY, embodimentStatement } from "../src/core/identity";
import { FIELD_TARGETS, SemanticPresence } from "../src/core/signal";
import { ACTIVITY_STATES, AION_STATES, AionStateMachine, GESTURE_SECONDS, isActivityState, sanitizeState, type AionState } from "../src/core/state";

// ── Identity ─────────────────────────────────────────────────────────────────────────────────────────

test("Aion's identity is one canonical, frozen manifest", () => {
  assert.deepEqual({ ...AION_IDENTITY }, {
    name: "Aion", product: "Intelligent Presence", creatorCompany: "Spirit Connect", leadCreator: "Fulong", nature: "interactive AI presence",
  });
  assert.ok(Object.isFrozen(AION_IDENTITY));
});

test("identity strings live only in the manifest; everything else reads them from it", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|html|css)$/.test(name)) files.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  const canonical = join("src", "core", "identity.ts");
  for (const literal of ["Fulong", "Intelligent Presence", "Spirit Connect"]) {
    const holders = files.filter(file => readFileSync(file, "utf8").includes(literal)).map(file => file.slice(file.indexOf("src")));
    assert.deepEqual(holders, [canonical], `${literal} appears only in ${canonical}`);
  }
});

test("in plugin mode Aion is the host's body, never a second model or personality", () => {
  const statement = embodimentStatement("Codex");
  assert.match(statement, /not a separate AI model or assistant/);
  assert.match(statement, /Codex does the reasoning and the work/);
  for (const fact of [AION_IDENTITY.name, AION_IDENTITY.product, AION_IDENTITY.creatorCompany, AION_IDENTITY.leadCreator]) assert.ok(statement.includes(fact), fact);
});

// ── State ────────────────────────────────────────────────────────────────────────────────────────────

test("the host's activity states are exactly the plugin vocabulary", () => {
  assert.deepEqual([...ACTIVITY_STATES], ["idle", "listening", "thinking", "working", "reading", "editing", "testing", "building", "responding", "presenting", "complete", "error"]);
  for (const state of ACTIVITY_STATES) assert.ok(isActivityState(state));
  for (const bad of ["speaking", "greeting", "excited", "", 3, null]) assert.equal(isActivityState(bad), false, String(bad));
});

test("a Codex turn maps to Aion's state: idle → thinking (with a nod) → reading → editing → testing → complete → idle", () => {
  const machine = new AionStateMachine();
  const at = (activity: string, now: number, presenting = false) => machine.update({ activity, presenting }, now);
  assert.equal(at("idle", 0), "idle");
  assert.equal(at("thinking", 1), "acknowledging", "taking up a new task gets one small nod");
  assert.equal(at("thinking", 1 + GESTURE_SECONDS.acknowledging + 0.01), "thinking");
  assert.equal(at("reading", 3), "reading", "no nod between work states");
  assert.equal(at("editing", 4), "editing");
  assert.equal(at("testing", 5), "testing");
  assert.equal(at("testing", 6, true), "presenting", "a presentation outranks work");
  assert.equal(at("complete", 8), "complete");
  assert.equal(at("idle", 14), "idle");
  assert.equal(at("error", 15), "error");
});

test("gestures are one-shot; invalid states fall back to idle; speaking only comes from real host audio", () => {
  const machine = new AionStateMachine();
  machine.trigger("greeting");
  assert.equal(machine.update({ activity: "idle", presenting: false }, 0), "greeting");
  assert.equal(machine.update({ activity: "idle", presenting: true }, 1), "greeting", "the greeting completes");
  assert.equal(machine.update({ activity: "idle", presenting: false }, GESTURE_SECONDS.greeting + 0.01), "idle");
  assert.equal(machine.update({ activity: "dancing", presenting: false }, 20), "idle");
  assert.equal(machine.update({ activity: "idle", presenting: false, speaking: true }, 21), "speaking");
  assert.equal(sanitizeState("excited"), "idle");
  machine.force("nonsense");
  assert.equal(machine.update({ activity: "thinking", presenting: false }, 30), "idle", "a forced invalid state is idle");
  machine.force(null);
  assert.ok(AION_STATES.every(state => sanitizeState(state) === state));
});

test("the semantic presence reads state only: no host audio means no amplitude, ever", () => {
  let state: AionState = "idle";
  const presence = new SemanticPresence(() => state, NO_HOST_AUDIO);
  let now = 0;
  const run = (seconds: number) => { let s = presence.sample(0, now); for (let i = 0; i < seconds * 60; i++) { now += 1 / 60; s = presence.sample(1 / 60, now); } return s; };
  for (const next of AION_STATES) {
    state = next;
    const signal = run(3);
    const target = FIELD_TARGETS[next];
    assert.ok(Math.abs(signal.energy - target.energy) < 0.01 && Math.abs(signal.thinking - target.thinking) < 0.02, `${next} settles`);
    assert.equal(signal.assistantAmplitude, 0);
    assert.equal(signal.userAmplitude, 0);
    assert.ok(signal.assistantBands.every(value => value === 0));
    assert.notEqual(signal.mode, "speaking");
  }
  assert.ok(FIELD_TARGETS.error.warmth < FIELD_TARGETS.idle.warmth && FIELD_TARGETS.complete.warmth > FIELD_TARGETS.idle.warmth);
});

test("a real host audio adapter is the only way the body speaks", () => {
  const presence = new SemanticPresence(() => "idle", { name: "test", read: () => ({ amplitude: 0.6, bands: new Array(16).fill(0.5) }) });
  let signal = presence.sample(0, 0);
  for (let i = 1; i < 30; i++) signal = presence.sample(1 / 60, i / 60);
  assert.equal(signal.mode, "speaking");
  assert.ok(signal.assistantAmplitude > 0.5 && signal.assistantBands[3] === 0.5);
});

// ── Body ─────────────────────────────────────────────────────────────────────────────────────────────

test("the sphere remains the default body and the figure can be selected by id or plain name", () => {
  assert.deepEqual([...AION_BODIES], ["sphere", "figure"]);
  assert.deepEqual(PERSISTENT_BODIES.map(body => body.id), [...AION_BODIES]);
  const body = new AionBody();
  assert.equal(body.form, "sphere");
  for (const [name, id] of [["figure", "figure"], ["a human form", "figure"], ["Humanoid", "figure"], ["人形", "figure"],
    ["the sphere", "sphere"], ["球体", "sphere"], ["Sphere.", "sphere"]] as const) assert.equal(resolveBodyForm(name), id, name);
  for (const name of ["dragon", "", "<script>", 42, "a".repeat(80)]) assert.equal(resolveBodyForm(name), null, String(name));
  assert.equal(body.set("figure"), true);
  assert.equal(body.set("figure"), false, "already the figure");
  assert.equal(body.set("dragon" as never), false);
  let level = 0;
  for (let t = 0; t < bodyTransition.seconds + 0.2; t += 1 / 60) level = body.sample(1 / 60);
  assert.equal(level, 1);
  assert.equal(body.transitioning, false);
  body.set("sphere");
  for (let t = 0; t < bodyTransition.seconds + 0.2; t += 1 / 60) level = body.sample(1 / 60);
  assert.equal(level, 0);
});

// ── Figure geometry (from SCF Presence) ───────────────────────────────────────────────────────────────

const finite = (values: ArrayLike<number>) => Array.from(values).every(Number.isFinite);

test("the skeleton has every required anchor", () => {
  const required = ["head", "neck", "shoulderLeft", "shoulderRight", "elbowLeft", "elbowRight", "handLeft", "handRight",
    "spine", "hipLeft", "hipRight", "kneeLeft", "kneeRight", "footLeft", "footRight"];
  assert.deepEqual([...ANCHORS].sort(), required.sort());
  assert.ok(ANCHOR_COUNT <= 16, "anchor indices fit the 4-bit packing");
});

test("the neutral pose is a standing figure in normalized bounds, symmetric, with preserved limb lengths", () => {
  const p = solvePose(NEUTRAL_POSE);
  assert.ok(finite(p));
  const at = (name: keyof typeof ANCHOR) => [p[ANCHOR[name] * 3], p[ANCHOR[name] * 3 + 1], p[ANCHOR[name] * 3 + 2]];
  for (const name of ANCHORS) for (const value of at(name)) assert.ok(Math.abs(value) <= 1, `${name} within bounds`);
  assert.ok(at("head")[1] + PROPORTIONS.headRadius < 1 && at("footLeft")[1] > -1);
  assert.ok(at("shoulderLeft")[0] > 0 && at("shoulderRight")[0] < 0, "the figure faces the viewer");
  const length = (a: keyof typeof ANCHOR, b: keyof typeof ANCHOR) => Math.hypot(...at(a).map((value, k) => value - at(b)[k]));
  const waving = solvePose(gestureTarget("greeting", 1.2));
  const wave = (a: keyof typeof ANCHOR, b: keyof typeof ANCHOR) => Math.hypot(...[0, 1, 2].map(k => waving[ANCHOR[a] * 3 + k] - waving[ANCHOR[b] * 3 + k]));
  assert.ok(Math.abs(wave("shoulderRight", "elbowRight") - length("shoulderRight", "elbowRight")) < 0.02, "the upper arm keeps its length");
  assert.ok(waving[ANCHOR.handRight * 3 + 1] > waving[ANCHOR.shoulderRight * 3 + 1], "greeting raises one hand above the shoulder");
});

test("every state's pose is valid, bounded and subtle: body language, not a game avatar", () => {
  const animator = new FigureAnimator();
  const neutral = solvePose(NEUTRAL_POSE);
  for (const state of AION_STATES) {
    for (let t = 0; t < 3; t += 0.1) {
      const anchors = animator.sample(0.1, state, t, 0.8);
      assert.ok(finite(anchors), `${state} finite`);
      for (let i = 0; i < ANCHOR_COUNT; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(anchors[i * 4 + k]) <= FIGURE_SCALE, `${state} bounded`);
    }
    // Only the greeting and presenting (and its brief gesture toward a card) move a hand far; every other state stays near neutral.
    if (state !== "greeting" && state !== "presenting" && state !== "offering") {
      const pose = solvePose(gestureTarget(state, 0.5, 1));
      for (let i = 0; i < pose.length; i++) assert.ok(Math.abs(pose[i] - neutral[i]) < 0.12, `${state} is restrained`);
    }
  }
  assert.ok(finite(new FigureAnimator().sample(Number.NaN, "nonsense" as never, Number.NaN, Number.NaN)), "bad input stays finite");
});

test("work states are distinguishable from one another, but only slightly", () => {
  const hands = (state: AionState) => { const p = solvePose(gestureTarget(state, 2)); return [p[ANCHOR.handLeft * 3], p[ANCHOR.handLeft * 3 + 1], p[ANCHOR.handRight * 3], p[ANCHOR.handRight * 3 + 1]]; };
  const states: AionState[] = ["thinking", "reading", "working", "editing", "testing", "building"];
  for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++) {
    const a = hands(states[i]), b = hands(states[j]);
    assert.ok(a.some((value, k) => Math.abs(value - b[k]) > 0.005), `${states[i]} ≠ ${states[j]}`);
  }
});

test("the particle layout is a valid, bounded figure at every quality tier", () => {
  const count = 12_000;
  const layout = createFigureLayout(count);
  const animator = new FigureAnimator();
  const kinds = new Set<number>();
  for (const [state, t] of [["idle", 0], ["greeting", 1.2], ["presenting", 1], ["editing", 2]] as const) {
    const anchors = animator.sample(1, state, t);
    for (let i = 0; i < count; i += 7) {
      const { position, tone, kind } = figurePoint(layout, i, anchors, { clock: t * 3, orbit: 1.2, thinking: 0.6 });
      kinds.add(kind);
      assert.ok(finite(position) && Number.isFinite(tone));
      assert.ok(Math.abs(position[0]) < 2 && Math.abs(position[1]) < 2 && Math.abs(position[2]) < 2);
    }
  }
  assert.deepEqual([...kinds].sort(), Object.values(FIGURE_KINDS).sort(), "every component is present");
  const prefix = new Set<number>();
  for (let i = 0; i < 6000; i++) prefix.add(unpackAnchors(layout.bind[i * 4]).kind);
  assert.equal(prefix.size, Object.keys(FIGURE_KINDS).length, "the smallest tier still draws the whole figure");
  assert.deepEqual(unpackAnchors(packAnchors(14, 3, 0, 9, 6)), { a: 14, b: 3, c: 0, d: 9, kind: 6 });
  assert.deepEqual(createFigureLayout(500).bind, createFigureLayout(500).bind, "deterministic");
});
