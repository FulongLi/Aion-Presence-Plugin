import type { AnimationSpec } from "./sequence";

/**
 * The first library of action sequences (v0.4.3). Each is an ordinary AnimationSpec — the same declarative data Codex
 * may write — so they double as examples and building blocks.
 */
export const DEMO_SEQUENCES = {
  // v0.4.4 Demo A: natural walking — weight shifting over each foot, arms swinging against the legs, the upper body leading,
  // slowing before it stops and settling.
  "walk-and-stop": {
    title: "Walk and stop",
    start: { x: -1.05, facing: "right" },
    actions: [{ do: "walk", to: 0.75 }, { do: "face", toward: "viewer" }],
  },
  // v0.4.4 Demo B: thinking — it notices a question, pauses, tilts its head, a hand to its chin, then gets it ("?" → "!").
  "thinking": {
    title: "Thinking it over",
    start: { x: -0.22, facing: "viewer" },
    objects: [{ id: "question", type: "question", x: 0.32, size: "medium" }],
    actions: [{ do: "notice", object: "question" }, { do: "think", about: "question" }, { do: "gesture", name: "nod" }],
  },
  // v0.4.4 Demo C: exploring — a box; it notices it, approaches cautiously, examines it, touches it, watches it react.
  "exploring": {
    title: "Exploring a box",
    start: { x: -1.0, facing: "right" },
    objects: [{ id: "box", type: "box", x: 0.4, size: "small" }],
    actions: [{ do: "notice", object: "box" }, { do: "examine", object: "box" }, { do: "touch", object: "box" }, { do: "gesture", name: "nod" }, { do: "face", toward: "viewer" }],
  },
  "jump-over-obstacle": {
    title: "Jump over a box",
    start: { x: -1.05, facing: "right" },
    objects: [{ id: "box", type: "box", x: 0.05, size: "medium" }],
    actions: [{ do: "jump", over: "box" }, { do: "face", toward: "viewer" }],
  },
  "pick-up-object": {
    title: "Pick up a ball",
    start: { x: -0.75, facing: "right" },
    objects: [{ id: "ball", type: "ball", x: 0.2, size: "large" }],
    actions: [{ do: "pick-up", object: "ball" }, { do: "face", toward: "viewer" }],
  },
  "explain-diagram": {
    title: "Explain a diagram",
    start: { x: -0.6, facing: "viewer" },
    objects: [{ id: "diagram", type: "panel", x: 0.72, size: "medium" }],
    actions: [
      { do: "walk", to: -0.02, speed: "brisk" }, { do: "face", toward: "viewer" }, { do: "point", at: "diagram" },
      { do: "walk", to: -0.6, speed: "brisk" }, { do: "face", toward: "viewer" },
    ],
  },
  "surprised-reaction": {
    title: "Surprised reaction",
    start: { x: -0.35, facing: "right" },
    objects: [{ id: "ball", type: "ball", x: 0.32, size: "medium", from: 1.75 }],
    actions: [{ do: "wait", seconds: 0.3 }, { do: "react", to: "ball" }, { do: "face", toward: "viewer" }],
  },
} as const satisfies Record<string, AnimationSpec>;

export type DemoName = keyof typeof DEMO_SEQUENCES;
export const DEMO_NAMES = Object.keys(DEMO_SEQUENCES) as DemoName[];
