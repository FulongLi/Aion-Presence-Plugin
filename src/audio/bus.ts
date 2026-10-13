import { copyFeatures, createFeatures, type AudioFeatures, type AudioSourceKind } from "./features";
import type { SourceState } from "./route";

/**
 * The Audio Feature Bus: the latest features of every source, wherever they were measured (in the page, or in the hub
 * and sent over the event stream), with when they arrived. Readers ask for a source's features and whether it is
 * connected and sounding; nothing else is kept (one frame per source, overwritten).
 */
export const BUS_STALE_SECONDS = 1.2;

interface Entry { features: AudioFeatures; at: number; connected: boolean }

export class AudioFeatureBus {
  private readonly entries = new Map<AudioSourceKind, Entry>();

  /** A new frame from a source (copied). `now` in seconds. */
  publish(source: AudioSourceKind, features: AudioFeatures, now: number) {
    const entry = this.entries.get(source);
    if (entry) { copyFeatures(features, entry.features); entry.at = now; entry.connected = true; }
    else this.entries.set(source, { features: copyFeatures(features, createFeatures(features.bands.length)), at: now, connected: true });
  }

  /** A source opened or closed without a frame (e.g. capture granted but silent, or stopped). */
  setConnected(source: AudioSourceKind, connected: boolean, now: number) {
    const entry = this.entries.get(source);
    if (entry) { entry.connected = connected; entry.at = now; if (!connected) { entry.features.silent = true; entry.features.level = 0; entry.features.bands.fill(0); } }
    else if (connected) this.entries.set(source, { features: createFeatures(32), at: now, connected });
  }

  /** The latest features of a source, or null when it has none fresh. */
  get(source: AudioSourceKind, now: number): AudioFeatures | null {
    const entry = this.entries.get(source);
    return entry && entry.connected && now - entry.at < BUS_STALE_SECONDS ? entry.features : null;
  }

  state(source: AudioSourceKind, now: number): SourceState {
    const entry = this.entries.get(source);
    const fresh = !!entry && now - entry.at < BUS_STALE_SECONDS;
    return { connected: !!entry?.connected && fresh, sounding: !!entry?.connected && fresh && !entry.features.silent };
  }
}
