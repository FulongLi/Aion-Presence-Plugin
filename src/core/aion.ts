import { AionBody, type AionBodyId } from "./body";
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
  private orbit = 0;
  private readonly frame: BodyFrame;

  constructor(private readonly inputs: AionInputs) {
    this.figure.sample(0, "idle", 0);
    this.frame = { level: 0, anchors: this.figure.anchors, orbit: 0 };
  }

  get currentState(): AionState { return this.state.state; }
  get currentBody(): AionBodyId { return this.body.form; }

  /** Changes the persistent body; false when it already is that body. */
  setBody(form: AionBodyId) { return this.body.set(form); }

  gesture(name: AionGesture) { this.state.trigger(name); }

  sample(dt: number, now: number, calm = false): BodyFrame {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    const signal = this.inputs.signal();
    const state = this.state.update({ activity: this.inputs.activity(), presenting: this.inputs.presenting(), speaking: signal.mode === "speaking" }, now);
    this.frame.level = this.body.sample(step);
    // The figure's pose is only computed while any of it is visible.
    if (this.frame.level > 0 || this.body.form === "figure") {
      this.figure.sample(step, state, now - this.state.since, signal.assistantAmplitude, calm, signal.userAmplitude);
    }
    this.orbit = (this.orbit + step * 0.35 * signal.thinking * (calm ? 0.3 : 1)) % (Math.PI * 2);
    this.frame.orbit = this.orbit;
    return this.frame;
  }
}
