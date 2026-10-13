import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoreClock } from "../../core/store";
import type { BridgeStatus, VoiceSyncState } from "../../audio/settings";
import {
  CLOSE_GRACE_SECONDS, DEFAULT_VOICE_SYNC, decideVoiceSync, describeVoiceSync, permissionFrom, STABLE_SECONDS, VOICE_SYNC_PERMISSIONS,
  type VoiceSyncDecision, type VoiceSyncPreference,
} from "../../audio/voiceSync";
import { VOICE_SYNC_FILE } from "../paths";
import type { NativeAudioBridge } from "./bridge";

/**
 * The hub's Codex Voice Sync (v0.4.3): carries out the policy of audio/voiceSync.ts with the one native bridge.
 *
 *   a companion window connects ─► (opted in?) ─► capture Codex's voice ─► features to every window
 *   the last window closes ─► after a short grace, the capture stops (nothing is captured for nobody)
 *   the bridge fails or Codex's audio processes change ─► reconnect after 1, 2, 4 … 32 s, then stop until reopened
 *
 * It never starts a capture on its own initiative before the user opted in, never preempts another app's sound the user
 * chose, and is the only place that starts a capture without a tool call. The choice lives in voice-sync.json (0600).
 */
export interface VoiceSyncHost {
  bridge: NativeAudioBridge;
  clock: StoreClock;
  home: string;
  /** Sound response is on (the user's audio settings). */
  audioEnabled(): boolean;
  /** Companion windows connected now. */
  viewers(): number;
  /** The state changed (for the snapshot). */
  changed(state: VoiceSyncState): void;
}

export class VoiceSyncController {
  preference: VoiceSyncPreference;
  private attempts = 0;
  private open = false;
  private cancelRetry: (() => void) | null = null;
  private cancelClose: (() => void) | null = null;
  private cancelStable: (() => void) | null = null;
  private decision: VoiceSyncDecision = { action: "none", reason: "not started" };

  constructor(private readonly host: VoiceSyncHost) {
    this.preference = loadVoiceSync(host.home);
  }

  get state(): VoiceSyncState {
    const unavailable = this.preference.enabled ? this.host.bridge.unavailable() : null;
    return {
      enabled: this.preference.enabled, permission: this.preference.permission, status: describeVoiceSync(this.preference, this.host.bridge.status, this.decision),
      ...(unavailable ? { unavailable } : {}),
    };
  }

  /**
   * The user's choice: on (connect now if Aion is open; an explicit request also asks again after an unanswered
   * prompt), or off (disconnect).
   */
  set(enabled: boolean) {
    const permission = enabled && this.preference.permission === "unanswered" ? "unknown" : this.preference.permission;
    this.save({ ...this.preference, enabled, permission, updatedAt: this.host.clock.now() });
    this.attempts = 0;
    this.evaluate();
  }

  /** The number of connected windows changed. */
  viewersChanged() {
    const open = this.host.viewers() > 0;
    if (open) {
      this.cancelClose?.(); this.cancelClose = null;
      // Opening Aion again is a fresh start for reconnection.
      if (!this.open) this.attempts = 0;
      this.open = true;
      this.evaluate();
    } else if (this.open && !this.cancelClose) {
      this.cancelClose = this.host.clock.schedule(() => { this.cancelClose = null; this.open = false; this.evaluate(); }, CLOSE_GRACE_SECONDS * 1000);
    }
  }

  /** The bridge's status changed (from its onStatus). */
  bridgeChanged(status: BridgeStatus) {
    const permission = permissionFrom(this.preference.permission, status, this.host.bridge.heard);
    if (permission !== this.preference.permission && this.preference.enabled) this.save({ ...this.preference, permission });
    // A capture that keeps running is a real connection: the backoff starts over.
    this.cancelStable?.(); this.cancelStable = null;
    if (status.source === "codex" && status.state === "streaming") {
      this.cancelStable = this.host.clock.schedule(() => { this.cancelStable = null; this.attempts = 0; }, STABLE_SECONDS * 1000);
    }
    this.evaluate();
  }

  /** The first real sample arrived: macOS lets Codex's audio through. */
  heard() {
    if (this.preference.enabled && this.preference.permission !== "granted") this.save({ ...this.preference, permission: "granted" });
    this.publish();
  }

  /** Re-reads the inputs and acts (also after sound settings change). */
  evaluate() {
    const decision = decideVoiceSync({
      preference: this.preference, audioEnabled: this.host.audioEnabled(), open: this.open, bridge: this.host.bridge.status, attempts: this.attempts,
    });
    this.decision = decision;
    switch (decision.action) {
      case "connect":
        this.cancelRetry?.(); this.cancelRetry = null;
        void this.host.bridge.start({ source: "codex" });
        break;
      case "retry":
        if (!this.cancelRetry) {
          this.attempts++;
          this.cancelRetry = this.host.clock.schedule(() => {
            this.cancelRetry = null;
            // Still wanted? The same rules decide again at that moment.
            const again = decideVoiceSync({ preference: this.preference, audioEnabled: this.host.audioEnabled(), open: this.open, bridge: this.host.bridge.status, attempts: this.attempts - 1 });
            if (again.action === "retry" || again.action === "connect") void this.host.bridge.start({ source: "codex" });
          }, decision.afterSeconds * 1000);
        }
        break;
      case "disconnect":
        this.cancelRetry?.(); this.cancelRetry = null;
        if (this.host.bridge.status.source === "codex") this.host.bridge.stop();
        break;
      case "none":
        if (!this.preference.enabled || !this.open) { this.cancelRetry?.(); this.cancelRetry = null; }
        break;
    }
    this.publish();
  }

  dispose() {
    this.cancelRetry?.(); this.cancelClose?.(); this.cancelStable?.();
    this.cancelRetry = this.cancelClose = this.cancelStable = null;
  }

  private publish() { this.host.changed(this.state); }

  private save(preference: VoiceSyncPreference) {
    this.preference = preference;
    saveVoiceSync(this.host.home, preference);
  }
}

/** The remembered choice (voice-sync.json in Aion's data directory); off when absent or unreadable. */
export function loadVoiceSync(home: string): VoiceSyncPreference {
  try {
    const saved = JSON.parse(readFileSync(join(home, VOICE_SYNC_FILE), "utf8")) as Partial<VoiceSyncPreference>;
    return {
      enabled: saved.enabled === true,
      permission: (VOICE_SYNC_PERMISSIONS as readonly unknown[]).includes(saved.permission) ? saved.permission! : "unknown",
      updatedAt: typeof saved.updatedAt === "number" && Number.isFinite(saved.updatedAt) ? saved.updatedAt : 0,
    };
  } catch { return { ...DEFAULT_VOICE_SYNC }; }
}

export function saveVoiceSync(home: string, preference: VoiceSyncPreference) {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, VOICE_SYNC_FILE), JSON.stringify(preference, null, 2), { mode: 0o600 });
  } catch { /* the choice still applies while this hub runs */ }
}
