import { AionBody, type AionBodyId } from "./body";
import { EyesAnimator, isEyeExpression, type EyeExpression } from "./eyes/expression";
import { ATTENTIVE_TILT, CONCERN, DROWSY, gestureClip, NOD, PLEASED, PONDER, SHRUG, SURPRISE, type Clip, type FigureGesture } from "./figure/motion";
import { FigureAnimator } from "./figure/pose";
import { AION_IDENTITY } from "./identity";
import type { PresenceSignal } from "./signal";
import { AionStateMachine, type ActivityState, type AionGesture, type AionState } from "./state";

/** What the particle runtime reads each frame for the persistent body. */
export interface BodyFrame {
  /** Weight of the figure layer (0: sphere, 1: figure). */
  level: number;
  /** World-space skeleton anchors, vec4 per anchor (see figure/skeleton.ts). */
  anchors: Float32Array;
  /** Weight of the eyes layer (0: none, 1: eyes). */
  eyes: number;
  /** The two eyes' live shape, EYE_PARAMS floats per eye (see eyes/layout.ts). */
  eyeParams: Float32Array;
  /** Accumulated turn of the faint halo around the head (radians); it turns only while thinking. */
  orbit: number;
}
export interface BodySource { sample(dt: number, now: number, calm: boolean): BodyFrame }

export interface AionInputs {
  /** The host's activity, as exposed (see state.ts). */
  activity(): ActivityState;
  /** A presentation is forming or held. */
  presenting(): boolean;
  /** The presence signal, already sampled this frame (the halo turns with its thinking). */
  signal(): PresenceSignal;
}

/**
 * Aion: identity (who), state (what it is doing) and body (which form it occupies), kept apart. The
 * runtime samples it once per frame as the body source; the surface only calls setBody and gesture.
 * Nothing here knows about WebGPU, MCP or the host.
 */
export class Aion implements BodySource {
  readonly identity = AION_IDENTITY;
  readonly body = new AionBody();
  readonly state = new AionStateMachine();
  readonly figure = new FigureAnimator();
  readonly eyes = new EyesAnimator();
  /** Where the eyes should look (gaze, shape units), e.g. toward a card that just appeared; null: their own gaze. */
  look: { at: [number, number]; until: number } | null = null;
  private orbit = 0;
  private readonly frame: BodyFrame;
  private clock = 0;

  constructor(private readonly inputs: AionInputs) {
    this.figure.sample(0, "idle", 0);
    this.eyes.sample(0, "idle", 0);
    this.frame = { level: 0, anchors: this.figure.anchors, eyes: 0, eyeParams: this.eyes.params, orbit: 0 };
  }

  get currentState(): AionState { return this.state.state; }
  get currentBody(): AionBodyId { return this.body.form; }

  /** Changes the persistent body; false when it already is that body. */
  setBody(form: AionBodyId) { return this.body.set(form); }

  gesture(name: AionGesture) { this.state.trigger(name); }

  /**
   * An expression or gesture asked for by name ("look happy", "wave"). Each body shows it in its own way: the eyes
   * wear the expression (a gesture becomes its nearest expression), the figure acts it out (an expression becomes its
   * nearest movement), the sphere answers with a brief inward gathering. Unknown names are ignored.
   */
  express(request: { expression?: EyeExpression; gesture?: FigureGesture; seconds?: number }) {
    const seconds = request.seconds ?? 4;
    const expression = request.expression && isEyeExpression(request.expression) ? request.expression : undefined;
    const fromGesture: Partial<Record<FigureGesture, EyeExpression>> = {
      wave: "happy", jump: "happy", surprise: "surprised", shrug: "confused", think: "thinking", "look-around": "curious", point: "curious", step: "curious", turn: "curious",
    };
    const eyes = expression ?? (request.gesture ? fromGesture[request.gesture] : undefined);
    if (eyes) this.eyes.express(eyes, request.gesture && !expression ? 2.5 : seconds);
    if (request.gesture === "nod") this.eyes.nod();
    if (request.gesture === "wave") this.eyes.blink();
    if (request.gesture === "point") this.look = { at: [0.34, 0.04], until: this.clock + 2.5 };
    const fromExpression: Partial<Record<EyeExpression, Clip>> = {
      happy: PLEASED, surprised: SURPRISE, curious: ATTENTIVE_TILT("left"), confused: SHRUG, thinking: PONDER("left"),
      sleepy: DROWSY, attentive: NOD, concerned: CONCERN,
    };
    const clip = request.gesture ? gestureClip(request.gesture) : expression ? fromExpression[expression] : undefined;
    if (clip) this.figure.cue(clip);
    if ((clip || eyes) && this.body.form === "sphere") this.state.trigger("acknowledging");
  }

  /** The eyes glance at something for a few seconds (gaze in shape units: +x toward the viewer's right). */
  glance(at: [number, number], seconds = 2.5) { this.look = { at, until: this.clock + seconds }; }

  sample(dt: number, now: number, calm = false): BodyFrame {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    this.clock += step;
    const signal = this.inputs.signal();
    const state = this.state.update({ activity: this.inputs.activity(), presenting: this.inputs.presenting(), speaking: signal.mode === "speaking" }, now);
    this.frame.level = this.body.sample(step);
    this.frame.eyes = this.body.eyes;
    // Each body's motion is only computed while any of it is visible.
    if (this.frame.level > 0 || this.body.form === "figure") {
      this.figure.sample(step, state, now - this.state.since, signal.assistantAmplitude, calm, signal.userAmplitude);
    }
    if (this.look && this.clock > this.look.until) this.look = null;
    if (this.frame.eyes > 0 || this.body.form === "eyes") {
      this.eyes.sample(step, state, now - this.state.since, { listen: signal.userAmplitude, amplitude: signal.assistantAmplitude, calm, look: this.look?.at ?? null });
    }
    this.orbit = (this.orbit + step * 0.35 * signal.thinking * (calm ? 0.3 : 1)) % (Math.PI * 2);
    this.frame.orbit = this.orbit;
    return this.frame;
  }
}
