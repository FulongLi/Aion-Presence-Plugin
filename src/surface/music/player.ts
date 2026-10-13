import { AudioAnalyzer, DIGITAL_SOURCE } from "../../audio/analyzer";
import type { AudioFeatures } from "../../audio/features";
import { noteAt, schedule, type ScheduledNote } from "../../music/notation/score";
import type { PlaybackRequest } from "../../core/store";

/**
 * The Music Library's playback (v0.4.2): Web Audio on this device, A4 = 440 Hz, equal temperament. Every note is
 * scheduled ahead on the audio clock (never on animation frames), and the highlight reads the same clock — corrected
 * for the output's latency — so each note lights up as it is heard. The graph ends in an AnalyserNode before the
 * speakers, so the Audio Analysis Engine hears exactly what is played, without the microphone or any loopback.
 *
 *   note: oscillator (piano-like partials) ─► low-pass that closes as the note decays ─► envelope
 *       ─► master volume ─► compressor ─► analyser ─► speakers
 *
 * Browsers only let a page sound after a click: until then a request waits ("blocked") and starts at the first click.
 */
export type PlaybackState = "playing" | "blocked" | "finished" | "stopped" | "failed";

/** Relative strength of the partials (a soft, piano-like timbre). */
const PARTIALS = [0, 1, 0.42, 0.2, 0.11, 0.05, 0.025];
/** Seconds between a request and its first note (scheduling ahead keeps the timing exact). */
export const LOOKAHEAD = 0.12;

export interface PlayerPosition { id: number; presentation?: string; index: number | null; finished: boolean }

export class MusicPlayer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyzer: AudioAnalyzer | null = null;
  private wave: PeriodicWave | null = null;
  private window: Float32Array<ArrayBuffer> | null = null;
  private current: { id: number; presentation?: string; notes: ScheduledNote[]; end: number; sources: OscillatorNode[]; gains: GainNode[] } | null = null;
  private pending: PlaybackRequest | null = null;

  constructor(private readonly onState: (id: number, state: PlaybackState) => void = () => {}) {}

  /** Whether sound may start now (a click has allowed it). */
  get allowed() { return this.context?.state === "running"; }

  private ensure(): AudioContext {
    if (this.context) return this.context;
    const context = new AudioContext({ latencyHint: "interactive" });
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14; compressor.ratio.value = 3; compressor.attack.value = 0.005; compressor.release.value = 0.2;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
    master.connect(compressor).connect(analyser).connect(context.destination);
    const real = new Float32Array(PARTIALS.length), imag = new Float32Array(PARTIALS);
    this.wave = context.createPeriodicWave(real, imag, { disableNormalization: false });
    Object.assign(this, { context, master, analyser, analyzer: new AudioAnalyzer(context.sampleRate, DIGITAL_SOURCE), window: new Float32Array(analyser.fftSize) });
    return context;
  }

  /** Called on every click and key press: lets sound start, and starts a request that was waiting for it. */
  unlock() {
    const context = this.ensure();
    if (context.state !== "running") void context.resume().then(() => { if (this.pending) { const request = this.pending; this.pending = null; void this.play(request); } }).catch(() => {});
    else if (this.pending) { const request = this.pending; this.pending = null; void this.play(request); }
  }

  async play(request: PlaybackRequest): Promise<PlaybackState> {
    this.stop(false);
    if (request.stop || !request.events.length) { this.onState(request.id, "stopped"); return "stopped"; }
    let context: AudioContext;
    try { context = this.ensure(); } catch { this.onState(request.id, "failed"); return "failed"; }
    if (context.state !== "running") {
      // Without a click the browser keeps the context suspended: try briefly, then wait for the click.
      await Promise.race([context.resume().catch(() => {}), new Promise(resolve => setTimeout(resolve, 250))]);
      if ((context.state as AudioContextState) !== "running") { this.pending = request; this.onState(request.id, "blocked"); return "blocked"; }
    }
    const origin = context.currentTime + LOOKAHEAD;
    const notes = schedule(request.events, request.tempo, origin);
    const volume = Math.max(0, Math.min(1, request.volume));
    this.master!.gain.setValueAtTime(volume * 0.55, context.currentTime);
    const sources: OscillatorNode[] = [], gains: GainNode[] = [];
    for (const note of notes) {
      if (note.frequency === null) continue;
      const voice = this.voice(context, note.frequency, note.at, note.until);
      sources.push(voice.source); gains.push(voice.gain);
    }
    const end = notes.length ? notes[notes.length - 1].until : origin;
    this.current = { id: request.id, ...(request.presentation ? { presentation: request.presentation } : {}), notes, end, sources, gains };
    this.onState(request.id, "playing");
    return "playing";
  }

  /** One note: a piano-like tone with a quick attack, a pitch-dependent decay, a darkening low-pass and a short release. */
  private voice(context: AudioContext, frequency: number, at: number, until: number) {
    const source = context.createOscillator();
    source.setPeriodicWave(this.wave!);
    source.frequency.setValueAtTime(frequency, at);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass"; filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(Math.min(16_000, frequency * 9), at);
    filter.frequency.setTargetAtTime(Math.min(12_000, frequency * 3), at + 0.02, 0.35);
    const gain = context.createGain();
    // Lower notes ring longer, as on a piano.
    const decay = Math.max(0.35, Math.min(2.2, 1.1 * Math.pow(440 / frequency, 0.35)));
    const peak = 0.9 * Math.min(1, Math.pow(523 / frequency, 0.25));
    const release = Math.max(at + 0.06, until - 0.015);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.006);
    gain.gain.setTargetAtTime(peak * 0.3, at + 0.006, decay);
    gain.gain.setTargetAtTime(0, release, 0.045);
    source.connect(filter).connect(gain).connect(this.master!);
    source.start(at);
    source.stop(release + 0.4);
    return { source, gain };
  }

  /** Stops what is playing, with a short fade (never a click). */
  stop(report = true) {
    const current = this.current, context = this.context;
    this.pending = null;
    if (!current || !context) return;
    const now = context.currentTime;
    for (const gain of current.gains) { gain.gain.cancelScheduledValues(now); gain.gain.setTargetAtTime(0, now, 0.02); }
    for (const source of current.sources) { try { source.stop(now + 0.15); } catch { /* already stopped */ } }
    this.current = null;
    if (report) this.onState(current.id, "stopped");
  }

  /**
   * What is being heard now: the audio clock minus the output latency (getOutputTimestamp when the browser offers it),
   * so the highlight follows the speakers rather than the scheduler.
   */
  position(): PlayerPosition | null {
    const current = this.current, context = this.context;
    if (!current || !context) return null;
    const stamp = context.getOutputTimestamp?.();
    const heard = stamp?.contextTime && stamp.contextTime > 0 ? stamp.contextTime + Math.max(0, (performance.now() - (stamp.performanceTime ?? performance.now())) / 1000)
      : context.currentTime - (context.outputLatency || context.baseLatency || 0);
    const note = noteAt(current.notes, heard);
    const finished = heard >= current.end;
    if (finished) { this.current = null; this.onState(current.id, "finished"); }
    return { id: current.id, ...(current.presentation ? { presentation: current.presentation } : {}), index: finished ? null : note?.index ?? null, finished };
  }

  /** The features of what is playing, measured from the graph itself (null when nothing has played). */
  features(dt: number): AudioFeatures | null {
    if (!this.analyser || !this.analyzer || !this.window || !this.context) return null;
    this.analyser.getFloatTimeDomainData(this.window);
    this.analyzer.pushWindow(this.window, dt * this.context.sampleRate);
    return this.analyzer.analyze(dt);
  }

  dispose() { this.stop(false); void this.context?.close().catch(() => {}); this.context = null; }
}
