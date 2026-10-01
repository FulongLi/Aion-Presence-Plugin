import { NO_HOST_AUDIO, SPECTRUM_BANDS, type HostAudioSource } from "./audio";
import { FocusImpulse } from "./focus";
import { sanitizeState, type AionState } from "./state";

export const PRESENCE_MODES = ["idle", "listening", "thinking", "speaking"] as const;
export type PresenceMode = typeof PRESENCE_MODES[number];

/**
 * The only thing the particle runtime knows about what Aion is doing. Every field is already smoothed and
 * bounded; the renderer never sees the host, MCP, hooks or tools.
 */
export interface PresenceSignal {
  mode: PresenceMode;
  /** Overall internal energy. */
  energy: number;
  /** Inward attention (listening coherence: the body gathers and holds still). */
  focus: number;
  /** Colour temperature of the body. */
  warmth: number;
  /** Internal turbulence and rotation (thinking, working). */
  thinking: number;
  /** User voice loudness while listening. Plugin mode never measures it: always 0. */
  userAmplitude: number;
  /** Host assistant audio loudness, only from a real HostAudioSource. */
  assistantAmplitude: number;
  /** Transient contraction impulse (an acknowledgement, a completion). */
  acousticFocus: number;
  /** Host assistant audio spectrum, one value per band. */
  assistantBands: Float32Array;
}

export interface PresenceSignalSource {
  sample(dt: number, now: number): PresenceSignal;
}

export const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function createSignal(): PresenceSignal {
  return {
    mode: "idle", energy: 0.08, focus: 0, warmth: 0.35, thinking: 0,
    userAmplitude: 0, assistantAmplitude: 0, acousticFocus: 0,
    assistantBands: new Float32Array(SPECTRUM_BANDS),
  };
}

interface FieldTarget { mode: PresenceMode; energy: number; warmth: number; focus: number; thinking: number }

/**
 * How each state reads on the sphere's field, in the vocabulary the original Presence tuned (idle, listening,
 * thinking and speaking keep their values). Work states are kinds of thinking with different intensity:
 * reading is calm and inward, testing is held still, building and working stir more. Completion warms the
 * body; an error cools and quiets it. Nothing here is decorative motion: the field only changes when the
 * state does.
 */
export const FIELD_TARGETS: Record<AionState, FieldTarget> = {
  idle: { mode: "idle", energy: 0.08, warmth: 0.35, focus: 0, thinking: 0 },
  listening: { mode: "listening", energy: 0.16, warmth: 0.4, focus: 0.9, thinking: 0 },
  thinking: { mode: "thinking", energy: 0.34, warmth: 0.38, focus: 0, thinking: 0.67 },
  reading: { mode: "thinking", energy: 0.2, warmth: 0.36, focus: 0.35, thinking: 0.3 },
  working: { mode: "thinking", energy: 0.3, warmth: 0.38, focus: 0, thinking: 0.5 },
  editing: { mode: "thinking", energy: 0.3, warmth: 0.4, focus: 0.15, thinking: 0.45 },
  testing: { mode: "thinking", energy: 0.22, warmth: 0.34, focus: 0.55, thinking: 0.2 },
  building: { mode: "thinking", energy: 0.34, warmth: 0.38, focus: 0, thinking: 0.55 },
  presenting: { mode: "idle", energy: 0.12, warmth: 0.45, focus: 0.2, thinking: 0 },
  complete: { mode: "idle", energy: 0.14, warmth: 0.55, focus: 0, thinking: 0 },
  error: { mode: "idle", energy: 0.05, warmth: 0.12, focus: 0.3, thinking: 0 },
  // Speaking mode itself only ever comes from real host audio (see sample()), never from a state.
  speaking: { mode: "idle", energy: 0.28, warmth: 0.55, focus: 0, thinking: 0 },
  greeting: { mode: "idle", energy: 0.12, warmth: 0.45, focus: 0.2, thinking: 0 },
  acknowledging: { mode: "listening", energy: 0.16, warmth: 0.4, focus: 0.3, thinking: 0 },
};

/** Impulses: a brief inward gathering when a task is taken up or finished. */
const IMPULSES: Partial<Record<AionState, number>> = { acknowledging: 0.55, complete: 0.7, error: 0.4 };

const approach = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

/**
 * Semantic Presence: turns Aion's current state (and real host audio, if a host ever exposes it) into the
 * one normalized signal the particle body reads. It replaces the standalone PresenceEngine, which measured a
 * microphone and the model's own voice: in plugin mode there is no microphone and no audio of Aion's own.
 */
export class SemanticPresence implements PresenceSignalSource {
  readonly signal: PresenceSignal = createSignal();
  readonly focusImpulse = new FocusImpulse();
  private last: AionState = "idle";
  constructor(private readonly state: () => AionState, private readonly audio: HostAudioSource = NO_HOST_AUDIO) {}

  sample(elapsed: number, now: number): PresenceSignal {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const state = sanitizeState(this.state());
    const s = this.signal;
    if (state !== this.last) {
      const impulse = IMPULSES[state];
      if (impulse) this.focusImpulse.trigger(impulse, now);
      this.last = state;
    }
    const target = FIELD_TARGETS[state];
    const frame = this.audio.read(now);
    const level = frame ? clamp01(frame.amplitude) : 0;
    s.mode = level > 0.035 ? "speaking" : target.mode;
    s.energy = approach(s.energy, target.energy, 2, dt);
    s.warmth = approach(s.warmth, target.warmth, 2, dt);
    s.focus = approach(s.focus, target.focus, target.focus > s.focus ? 3.5 : 2.2, dt);
    s.thinking = approach(s.thinking, target.thinking, target.thinking > s.thinking ? 2.2 : 3, dt);
    s.userAmplitude = 0;
    s.assistantAmplitude = approach(s.assistantAmplitude, level, 18, dt);
    const decay = Math.exp(-dt * 6);
    for (let i = 0; i < s.assistantBands.length; i++) {
      s.assistantBands[i] = frame?.bands && level > 0 ? clamp01(frame.bands[i]) : s.assistantBands[i] * decay;
    }
    s.acousticFocus = this.focusImpulse.sample(now);
    return s;
  }
}
