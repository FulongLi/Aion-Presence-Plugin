import { NO_HOST_AUDIO, SPECTRUM_BANDS, type HostAudioSource } from "./audio";
import { FocusImpulse } from "./focus";
import type { MicInput } from "./listening/frame";
import { sanitizeState, type ActivityState, type AionState } from "./state";

export const PRESENCE_MODES = ["idle", "listening", "thinking", "speaking"] as const;
export type PresenceMode = typeof PRESENCE_MODES[number];

/**
 * The only thing the particle runtime knows about what Aion is doing. Every field is already smoothed and
 * bounded; the renderer never sees the host, MCP, hooks, tools or the microphone.
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
  /** Local microphone loudness while the user is heard (0 when no microphone). */
  userAmplitude: number;
  /** Host assistant audio loudness, only from a real HostAudioSource. */
  assistantAmplitude: number;
  /** Transient contraction impulse (a stressed word, an acknowledgement, a completion). */
  acousticFocus: number;
  /** Host assistant audio spectrum, one value per band. */
  assistantBands: Float32Array;
  /** Semantic answering (Codex is responding, no audio): a slow, even swell. 0…1, never an amplitude. */
  responding: number;
}

export interface PresenceSignalSource {
  sample(dt: number, now: number): PresenceSignal;
}

export const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function createSignal(): PresenceSignal {
  return {
    mode: "idle", energy: 0.08, focus: 0, warmth: 0.35, thinking: 0,
    userAmplitude: 0, assistantAmplitude: 0, acousticFocus: 0,
    assistantBands: new Float32Array(SPECTRUM_BANDS), responding: 0,
  };
}

interface FieldTarget { mode: PresenceMode; energy: number; warmth: number; focus: number; thinking: number; responding?: number }

/**
 * How each state reads on the sphere's field, in the vocabulary the original Presence tuned (idle, listening,
 * thinking and speaking keep their values). Work states are kinds of thinking with different intensity:
 * reading is calm and inward, testing is held still, building and working stir more. Responding is warm and a
 * little lifted, with its own gentle swell. Completion warms the body; an error cools and quiets it. Nothing
 * here is decorative motion: the field only changes when the state does.
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
  // Semantic answering: speaking's warmth and a little of its energy, never its audio-driven motion.
  responding: { mode: "idle", energy: 0.22, warmth: 0.5, focus: 0.05, thinking: 0.06, responding: 1 },
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

/** Host activities the user's voice may take over as listening: resting, or still thinking about the prompt. */
const LISTENABLE: readonly ActivityState[] = ["idle", "listening", "thinking", "complete", "error"];
/** Host activities after which a finished utterance is inferred to start a thought (SCF's offline rule). */
const RESTING: readonly ActivityState[] = ["idle", "listening", "complete", "error"];

export const engineDefaults = {
  /** Host assistant audio louder than this is audible speech. */
  audibleLevel: 0.035,
  /** Silence that ends an audible speaking turn. */
  speakingRelease: 0.55,
  /** Microphone activity is ignored this long after real host audio ends (speaker echo, SCF). */
  echoGuard: 0.4,
  /**
   * Without real host audio, Codex's voice may still be playing after its turn ends; the microphone is
   * ignored this long after responding (an echo hold), so Aion does not hear Codex as the user.
   */
  echoHold: 2.5,
  /** A user utterance this long is treated as a conversational turn. */
  minTurn: 0.5,
  /** An inferred thinking lasts at most this long unless the host confirms or replaces it. */
  inferredThinking: 6,
};
export type EngineConfig = typeof engineDefaults;

const approach = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

export interface EngineInputs {
  /** Aion's current state (gestures and presenting included): it chooses the field. */
  state: () => AionState;
  /** The host's activity, as the hub reports it. */
  host?: () => ActivityState;
  /** Real host assistant audio; NO_HOST_AUDIO today. */
  audio?: HostAudioSource;
}

/**
 * The Presence engine (SCF's PresenceEngine, with the AI transport replaced by the host):
 *
 *   host activity (hooks, the agent) ─► thinking · reading · editing · testing · building · responding · complete
 *   local microphone VAD ───────────► listening (immediate), focus, user amplitude; a finished utterance → thinking
 *   real host audio, if ever exposed ► speaking, amplitude, spectrum (SCF's speech motion)
 *
 * The microphone is a local signal only: the engine reads loudness and voice activity, never audio. Echo: with
 * real host audio, the microphone is ignored while it is audible and briefly after (SCF). Without it, the
 * engine is conservative instead: while Codex is responding, and for `echoHold` after, the user's voice does not
 * take over, so Codex's own voice from the speakers is not mistaken for the user. (Real barge-in needs real
 * host audio; it is not claimed.)
 */
export class PresenceEngine implements PresenceSignalSource {
  readonly signal: PresenceSignal = createSignal();
  readonly focusImpulse = new FocusImpulse();
  mic: MicInput | null = null;
  /** The effective activity: the host's, with local listening and inferred thinking layered on. */
  activity: ActivityState = "idle";
  /** The local microphone hears the user right now (after the echo guard). */
  userVoiced = false;
  private readonly host: () => ActivityState;
  private readonly audio: HostAudioSource;
  private last: AionState = "idle";
  private sounding = false;
  private quiet = 0;
  private speakingEnded = -Infinity;
  private respondingSeen = -Infinity;
  private thinkingUntil = -Infinity;
  private lastHost: ActivityState = "idle";

  constructor(private readonly inputs: EngineInputs, private readonly config: EngineConfig = engineDefaults) {
    this.host = inputs.host ?? (() => "idle");
    this.audio = inputs.audio ?? NO_HOST_AUDIO;
  }

  /** Attaches (or with null, detaches) the local microphone analysis. */
  setMicrophone(input: MicInput | null) { this.mic = input; if (!input) this.userVoiced = false; }

  sample(elapsed: number, now: number): PresenceSignal {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const c = this.config;
    const s = this.signal;
    const host = this.host();
    if (host !== this.lastHost) {
      // The host moved on (a prompt arrived, work began): an inferred thought gives way to the real state.
      if (!RESTING.includes(host)) this.thinkingUntil = -Infinity;
      this.lastHost = host;
    }
    if (host === "responding") this.respondingSeen = now;

    // Real host audio: an audible gate with a release, so syllable gaps do not flicker (SCF).
    const frameAudio = this.audio.read(now);
    const level = frameAudio ? clamp01(frameAudio.amplitude) : 0;
    if (level > c.audibleLevel) { this.quiet = 0; this.sounding = true; }
    else if (this.sounding) {
      this.quiet += dt;
      if (this.quiet > c.speakingRelease) { this.sounding = false; this.speakingEnded = now; }
    }

    // The microphone, minus anything that may be Codex's own voice.
    const frame = this.mic?.read(dt) ?? null;
    const echo = this.sounding || now - this.speakingEnded < c.echoGuard
      || host === "responding" || now - this.respondingSeen < c.echoHold;
    const voiced = Boolean(frame?.voiced) && !echo;
    if (this.userVoiced && !voiced && !echo && (frame?.utterance ?? 0) >= c.minTurn && RESTING.includes(host)) {
      this.thinkingUntil = now + c.inferredThinking;
    }
    this.userVoiced = voiced;
    if (frame?.emphasis && voiced) this.focusImpulse.trigger(frame.emphasis, now);

    this.activity = voiced && LISTENABLE.includes(host) ? "listening"
      : RESTING.includes(host) && now < this.thinkingUntil ? "thinking"
        : host;
    if (this.activity === "listening") this.thinkingUntil = -Infinity;

    const state = sanitizeState(this.inputs.state());
    if (state !== this.last) {
      const impulse = IMPULSES[state];
      if (impulse) this.focusImpulse.trigger(impulse, now);
      this.last = state;
    }
    const target = FIELD_TARGETS[state];
    s.mode = this.sounding ? "speaking" : target.mode;
    s.energy = approach(s.energy, target.energy, 2, dt);
    s.warmth = approach(s.warmth, target.warmth, 2, dt);
    s.focus = approach(s.focus, target.focus, target.focus > s.focus ? 3.5 : 2.2, dt);
    s.thinking = approach(s.thinking, target.thinking, target.thinking > s.thinking ? 2.2 : 3, dt);
    s.responding = approach(s.responding, target.responding ?? 0, (target.responding ?? 0) > s.responding ? 1.5 : 2.5, dt);
    const user = state === "listening" && voiced ? clamp01(frame?.level ?? 0) : 0;
    s.userAmplitude = approach(s.userAmplitude, user, user > s.userAmplitude ? 20 : 7, dt);
    s.assistantAmplitude = approach(s.assistantAmplitude, this.sounding ? level : 0, 18, dt);
    const decay = Math.exp(-dt * 6);
    for (let i = 0; i < s.assistantBands.length; i++) {
      s.assistantBands[i] = this.sounding && frameAudio?.bands && level > 0 ? clamp01(frameAudio.bands[i]) : s.assistantBands[i] * decay;
    }
    s.acousticFocus = this.focusImpulse.sample(now);
    return s;
  }
}

/** The engine without a microphone or host activity: the field follows Aion's state alone (v0.1's semantic presence). */
export class SemanticPresence extends PresenceEngine {
  constructor(state: () => AionState, audio: HostAudioSource = NO_HOST_AUDIO) { super({ state, audio }); }
}
