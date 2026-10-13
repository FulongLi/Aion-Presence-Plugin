import { AudioAnalyzer, DIGITAL_SOURCE } from "../audio/analyzer";
import type { AudioFeatures } from "../audio/features";

/**
 * A browser tab's sound, shared by the user (v0.4.2): the only other place the page asks for audio. The browser shows
 * its own picker; the user chooses a tab and leaves "Share tab audio" on. Nothing is shared without that choice, and it
 * cannot be asked for without a click in Aion's window. The picture the browser also insists on is stopped at once;
 * the sound is reduced to features by the shared analyser and discarded — never played, recorded, stored or sent.
 *
 * Some browsers also offer the whole system's sound here (Chrome on Windows and ChromeOS); macOS offers only tabs.
 */
export type TabCaptureState = "off" | "requesting" | "connected" | "denied" | "unavailable" | "ended";

interface AudioFrame { numberOfFrames: number; sampleRate: number; copyTo(destination: Float32Array, options: { planeIndex: number; format: "f32-planar" }): void; close(): void }
type TrackProcessor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioFrame> };

export class TabAudioCapture {
  state: TabCaptureState = "off";
  /** The tab's title as the browser reports it (diagnostics only). */
  label = "";
  private stream: MediaStream | null = null;
  private analyzer: AudioAnalyzer | null = null;
  private reader?: ReadableStreamDefaultReader<AudioFrame>;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private window?: Float32Array<ArrayBuffer>;

  constructor(private readonly onChange: (state: TabCaptureState) => void = () => {}) {}

  /** Only from a click: the browser's picker opens. */
  async start(): Promise<TabCaptureState> {
    if (this.state === "requesting" || this.state === "connected") return this.state;
    const media = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (options: unknown) => Promise<MediaStream> };
    if (!window.isSecureContext || !media?.getDisplayMedia) return this.set("unavailable");
    this.set("requesting");
    let stream: MediaStream;
    try {
      stream = await media.getDisplayMedia({
        video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        selfBrowserSurface: "exclude", systemAudio: "include", preferCurrentTab: false,
      });
    } catch (error) {
      return this.set(error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unavailable");
    }
    for (const track of stream.getVideoTracks()) track.stop();
    const track = stream.getAudioTracks()[0];
    if (!track) { for (const t of stream.getTracks()) t.stop(); return this.set("denied"); }
    this.stream = stream;
    this.label = track.label;
    track.addEventListener("ended", () => { if (this.stream === stream) { this.stop(); this.set("ended"); } }, { once: true });
    const Processor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;
    if (Processor) {
      this.reader = new Processor({ track }).readable.getReader();
      void this.pump(this.reader);
    } else {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser); // Analysed only; never played.
      this.context = context; this.analyser = analyser; this.window = new Float32Array(analyser.fftSize);
      this.analyzer = new AudioAnalyzer(context.sampleRate, DIGITAL_SOURCE);
      void context.resume().catch(() => {});
    }
    return this.set("connected");
  }

  private async pump(reader: ReadableStreamDefaultReader<AudioFrame>) {
    let buffer = new Float32Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        try {
          if (buffer.length < value.numberOfFrames) buffer = new Float32Array(value.numberOfFrames);
          const view = buffer.subarray(0, value.numberOfFrames);
          value.copyTo(view, { planeIndex: 0, format: "f32-planar" });
          if (!this.analyzer || this.analyzer.sampleRate !== value.sampleRate) this.analyzer = new AudioAnalyzer(value.sampleRate, DIGITAL_SOURCE);
          this.analyzer.push(view);
        } finally { value.close(); }
      }
    } catch { /* the track stopped */ }
  }

  /** The latest features (null while nothing is shared). */
  features(dt: number, sensitivity = 0.5): AudioFeatures | null {
    if (this.state !== "connected" || !this.analyzer) return null;
    if (this.analyser && this.window && this.context) {
      this.analyser.getFloatTimeDomainData(this.window);
      this.analyzer.pushWindow(this.window, dt * this.context.sampleRate);
    }
    this.analyzer.sensitivity = sensitivity;
    return this.analyzer.analyze(dt);
  }

  stop() {
    void this.reader?.cancel().catch(() => {});
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => {});
    this.stream = null; this.reader = undefined; this.context = undefined; this.analyser = undefined; this.window = undefined;
    this.analyzer?.reset(); this.analyzer = null;
    if (this.state === "connected" || this.state === "requesting") this.set("off");
  }

  private set(state: TabCaptureState) { this.state = state; this.onChange(state); return state; }
}
