import { resampleBands } from "../audio/bands";
import { AudioFeatureBus } from "../audio/bus";
import { MusicDetector } from "../audio/detector";
import type { AudioFeatures, AudioSourceKind } from "../audio/features";
import { routeAudio, type AudioRoute, type SourceState } from "../audio/route";
import { DEFAULT_AUDIO_SETTINGS, INTENSITY_GAIN, type AudioSettings } from "../audio/settings";
import { SPECTRUM_BANDS, type HostAudioFrame, type HostAudioSource } from "../core/audio";
import type { AudioVisualFrame, AudioVisualSource } from "../render";
import { RING_BANDS } from "../render/ring";

/**
 * Sound for Aion's body, on one surface. Every source publishes its features to the bus (the microphone, a shared tab
 * and the Music Library's playback from this page; Codex's voice and other apps' sound from the hub). Each frame the
 * policy (audio/route.ts) chooses who drives what, external sources pass through the music detector, and the ring
 * and the sphere's audio field ease in and out as one particle transition (Sphere → Spectrum → Sphere).
 *
 * Codex's own voice reaches the presence engine as a real HostAudioSource (`hostAudio`): Aion speaks with it, and
 * the engine's echo guard keeps it from being taken for the user.
 */
export const RING_TRANSITION_SECONDS = 2.2;
const ease = (x: number) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10);

export class AudioVisualizer implements AudioVisualSource {
  readonly bus = new AudioFeatureBus();
  settings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
  route: AudioRoute = routeAudio({ settings: DEFAULT_AUDIO_SETTINGS, sources: {}, sincePlayback: Infinity });
  /** Music detection on the sources the user shared (never Codex, never the microphone, never Aion's own music). */
  readonly detectors = { system: new MusicDetector(), tab: new MusicDetector() };
  private readonly frame: AudioVisualFrame = { ring: 0, layout: 0, sphere: 0, gain: 1, level: 0, bass: 0, mid: 0, treble: 0, beat: 0, bands: new Float32Array(RING_BANDS) };
  private ringProgress = 0;
  private layout = 0;
  private sphere = 0;
  private lastPlayback = -Infinity;
  private readonly hostFrame: HostAudioFrame = { amplitude: 0, bands: new Float32Array(SPECTRUM_BANDS) };

  /** `clock`: seconds, monotonic (the page's). */
  constructor(private readonly clock: () => number = () => performance.now() / 1000) {}

  /** A source's features arrived (this page measured them, or the hub sent them). */
  publish(source: AudioSourceKind, features: AudioFeatures) {
    const now = this.clock();
    if (source === "music" && !features.silent) this.lastPlayback = now;
    this.bus.publish(source, features, now);
  }

  /** The states the policy sees, with each shared source's music decision. */
  private sources(now: number, dt: number): Partial<Record<AudioSourceKind, SourceState>> {
    const out: Partial<Record<AudioSourceKind, SourceState>> = {};
    for (const kind of ["microphone", "codex", "system", "tab", "music"] as const) out[kind] = this.bus.state(kind, now);
    for (const kind of ["system", "tab"] as const) {
      const features = this.bus.get(kind, now);
      if (features) out[kind]!.music = this.detectors[kind].sample(features, dt);
      else this.detectors[kind].reset();
    }
    return out;
  }

  sample(elapsed: number): AudioVisualFrame {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const now = this.clock();
    this.route = routeAudio({ settings: this.settings, sources: this.sources(now, dt), sincePlayback: now - this.lastPlayback });
    const f = this.frame, route = this.route;
    const driver = route.ring ?? route.sphere;
    const features = driver ? this.bus.get(driver, now) : null;
    // The ring re-forms over the same time a body does; the layout and the sphere's field ease more quickly.
    const step = dt / RING_TRANSITION_SECONDS;
    this.ringProgress = route.ring ? Math.min(1, this.ringProgress + step) : Math.max(0, this.ringProgress - step);
    const k = 1 - Math.exp(-dt * 3);
    this.layout += ((route.layout === "hybrid" ? 1 : 0) - this.layout) * k;
    const sphereTarget = route.sphere === "microphone" ? 0.45 : route.sphere ? 1 : 0;
    this.sphere += (sphereTarget - this.sphere) * k;
    f.ring = ease(this.ringProgress); f.layout = this.layout; f.sphere = this.sphere;
    f.gain = INTENSITY_GAIN[this.settings.intensity];
    // Features follow the source closely (it is already smoothed); without one they fall away.
    const fall = Math.exp(-dt * 4);
    if (features) {
      f.level = features.level; f.bass = features.bass; f.mid = features.mid; f.treble = features.treble; f.beat = features.beat;
      resampleBands(features.bands, f.bands);
    } else {
      f.level *= fall; f.bass *= fall; f.mid *= fall; f.treble *= fall; f.beat *= fall;
      for (let i = 0; i < f.bands.length; i++) f.bands[i] *= fall;
    }
    return f;
  }

  /** Aion's own music is audible: the microphone hears the speakers, not the user. */
  get playbackAudible() { return this.route.suppressMicrophone; }

  /** Codex's real voice, for the presence engine: its loudness and spectrum, or nothing (never invented). */
  readonly hostAudio: HostAudioSource = {
    name: "codex-bridge",
    read: () => {
      if (!this.settings.enabled || this.route.ignoreCodex) return null;
      const features = this.bus.get("codex", this.clock());
      if (!features || features.silent) return null;
      this.hostFrame.amplitude = features.level;
      resampleBands(features.bands, this.hostFrame.bands as Float32Array);
      return this.hostFrame;
    },
  };
}
