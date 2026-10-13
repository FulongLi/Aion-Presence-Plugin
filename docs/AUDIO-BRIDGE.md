# Native Audio Bridge (macOS)

> **v0.4.2: integrated.** The bridge moved from `experiments/` to `native/audio-bridge/` and is now the capture adapter
> for Codex's voice and other applications' sound (`set_audio_visualizer` sources `codex` and `system`). It no longer
> computes features itself: it streams samples over a private Unix socket to the hub, where the shared Audio Analysis
> Engine analyses them; only features reach the renderer. How it fits: [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md). The
> v0.4 feasibility report follows, unchanged except where marked; its measurements still describe the tap.
>
> | | v0.4.2 |
> | --- | --- |
> | Build and install | `npm run audio-bridge:install` → `~/.aion-presence/audio-bridge/Aion Audio Bridge.app` (or `AION_AUDIO_BRIDGE`) |
> | Commands | `list` · `stream --socket PATH --nonce HEX (--bundle ID \| --name APP \| --pid N \| --system)` · `probe (…) [--seconds S]` |
> | Protocol | Once the tap really runs (macOS may first ask for permission): `AION-PCM1 <nonce> <rate>\n`, then `[UInt32 LE count][count × Float32 LE]` mono frames; count 0 is a keep-alive every 0.5 s. The hub never writes; a watchdog sees the socket close and the app exits at once, even while it waits for permission |
> | Who starts it | The hub, only when the user asks (`set_audio_visualizer`), through LaunchServices (`open -g -n`) so macOS asks this app for permission |
> | Verified | A real process tap (`afplay`): real samples, 10.7 ms buffers, 21.3 ms device latency, 0.4 % CPU. The socket → hub → surface path with a stand-in app (smoke) |
> | Not yet verified | Codex Voice itself (needs a person speaking: `npm run audio:verify -- --codex`); the full real-app path through the hub on this Mac is waiting for the rebuilt app's System Audio Recording permission |

**Question.** Can Aion move with the real frequency content of GPT/Codex's spoken voice, rather than the semantic
`responding` animation, without a second model, voice session or API key?

**Short answer.** Yes on macOS, with two caveats. A Core Audio process tap captures one app's output reliably, in
isolation, with about 50 ms latency and about 1–2 % of one CPU core. It requires a separately signed helper and the
user's "System Audio Recording" permission. It has **not yet been checked against Codex Voice itself** (that needs
someone speaking to Codex). The Codex host also has an *official* path: its app-server streams the assistant's
output audio (experimental). That path should be tested before an OS-level capture ships. The bridge is therefore an
experiment in `experiments/audio-bridge/` (v0.4.2: integrated from `native/audio-bridge/`; see above). Without a
verified capture the plugin keeps the semantic `responding` animation.

Tested on macOS 26.6.2 (25G83), Apple silicon, ChatGPT desktop 26.1007 with Codex CLI 0.162.0-alpha.17.2.

## Approaches

| Approach | What it captures | Permission | Isolation | Verdict |
| --- | --- | --- | --- | --- |
| **Codex app-server `thread/realtime/outputAudio/delta`** | The assistant's own output audio as PCM chunks (`data`, `sampleRate`, `numChannels`), per thread | None beyond Codex | Exact (it *is* the assistant) | **Preferred**, but EXPERIMENTAL in the protocol and only sent to app-server clients. Also, a `thread/realtime/sdp` notification suggests a WebRTC mode in which audio may never pass through the app-server. Not attempted: attaching a second client to the user's running daemon would touch live sessions. |
| **Core Audio process tap** (`AudioHardwareCreateProcessTap`, macOS 14.2+) | One or more processes' mixed output, before the output device | "System Audio Recording Only" | Per process (verified) | **Works.** Prototype built and measured (below). |
| ScreenCaptureKit audio (`SCStream`, `capturesAudio`, app filter; macOS 13+) | An application's audio alongside a screen/window stream | Screen Recording (screen *and* audio) | Per application | Works in principle, but asks for a broader permission (the screen) than needed. Not pursued. |
| MCP / hooks / Skill | — | — | — | No audio or level signal (unchanged since v0.3; see [HOST.md](HOST.md)). |

## The prototype

`experiments/audio-bridge/AionAudioBridge.swift`, built by `experiments/audio-bridge/build.sh` into a small,
ad-hoc-signed app bundle (`Aion Audio Bridge.app`, `LSUIElement`, `NSAudioCaptureUsageDescription`).

```text
Codex Voice ─► macOS audio output ─► process tap (private, unmuted, mono mixdown of the chosen processes)
            ─► private aggregate device ─► IO block (audio thread)
            ─► RMS · 1024-point FFT (vDSP, Hann) → 16 log-spaced bands (SCF's edges, 60 Hz–18 kHz) · voice activity
            ─► JSON lines at 30 Hz: {"t","rms","level","voice","bands":[16]}  ─► (future) HostAudioSource
```

- `list` shows every Core Audio client: pid, bundle id, name, whether it is playing now.
- `tap --pid N` or `tap --bundle ID` (that app and all of its helpers mixed together, e.g. `com.openai.codex`).
- Only features leave the process. No audio is written, sent, transcribed or kept. The tap is **private** (no
  other app sees it) and **unmuted** (the user still hears everything).

### Results

| Check | Result |
| --- | --- |
| Identify the Codex audio processes | `com.openai.codex` (ChatGPT, the desktop app) and `com.openai.codex.helper` ("Codex (Service)", ×2) are registered Core Audio clients. `tap --bundle com.openai.codex` attaches to all three. |
| Capture without permission | The tap runs (561 callbacks of 512 frames in 6 s) but **every sample is 0**. A command-line binary has no usage description, so macOS cannot even ask. Silence, not an error. |
| Capture with permission | From the app bundle, after macOS's permission prompt: real levels (peak RMS 0.017 at 15 % playback volume), voice detected in 67–81 % of frames during speech, voiced harmonics in the low bands. |
| Process isolation | Synthetic speech in process A (tapped) and a 5 kHz tone in process B (not tapped), playing at the same time: band 13 (4.8–6.8 kHz) stayed at **0.00** for the whole run, while A's bands followed its syllables. |
| Assistant vs microphone | A process tap is the process's *output*; the microphone is a different device and is never opened. The user's voice cannot enter it unless the tapped app plays it back. |
| Latency | 512-frame buffers at 48 kHz (10.7 ms) + aggregate input latency and safety offset (21.3 ms) + feature framing (≤ 33 ms, 16.7 ms on average) ≈ **49 ms** before the renderer. |
| CPU | **1.1–1.7 %** of one core while audio flows, about **0.2 %** while the tapped apps are silent (no IO callbacks run then). |
| Start-up | The first start after building took a few seconds (the permission check). Later starts are immediate. |
| Codex Voice | **Not yet verified.** It needs a person speaking with Codex while `tap --bundle com.openai.codex` runs (see "Verify with Codex Voice"). |

## Permissions

- macOS asks once, per app bundle: **System Settings → Privacy & Security → Screen & System Audio Recording →
  System Audio Recording Only**. The prompt shows the usage description. Denying it simply yields silence.
- An ad-hoc signature is identified by its code hash, so rebuilding may ask again. A shipped bridge would need a
  stable Developer ID signature (and notarization) so the permission survives updates.
- The permission is the user's to grant. Aion never asks for it by itself, and it is never required: without it,
  Aion keeps its semantic `responding` animation.

## Verify with Codex Voice

```bash
experiments/audio-bridge/build.sh
```

```bash
open -W -n --stdout /tmp/aion-codex-voice.jsonl "experiments/audio-bridge/build/Aion Audio Bridge.app" --args tap --bundle com.openai.codex --seconds 30
```

Speak to Codex in voice mode during those 30 seconds. `voice: true` frames with moving bands while Codex answers,
and silence otherwise, confirm it. If Codex's voice is played by a process outside the `com.openai.codex` family,
`list` (run while it speaks) shows which one is `playing`.

## Known limitations

- macOS only. The OS-level path needs a signed helper app and a user-granted permission.
- A tap hears **everything** the tapped app plays (notification sounds, a video in the same app), not only the
  assistant. The app-server path does not have this problem.
- Codex Voice specifically is unverified (above). Its playback process may differ between versions.
- Echo: with real assistant audio, the existing echo guard (`PresenceEngine`, SCF's) applies directly. That is an
  improvement over today's conservative semantic guard.

## Integration plan (v0.4; v0.4.2 implemented it, with a socket instead of HTTP and the analysis in the hub)

1. Host: the bridge (or, preferably, an app-server client that subscribes to `thread/realtime/outputAudio/delta`
   and reduces each chunk to the same features in memory) posts `{level, bands, voice}` frames to the hub on
   loopback, with the hub token (`POST /api/host-audio`, validated like every hub command, rate-limited).
2. Hub: forwards the latest frame to surfaces on the existing SSE stream. Frames are never stored.
3. Surface: a `HostAudioSource` adapter (`src/core/audio.ts`'s seam) returns those frames. `PresenceEngine` then
   switches to `speaking`, and SCF's audio-reactive speech motion and echo guard take over. Nothing else changes.
4. Without frames (no bridge, no permission, a muted app), `NO_HOST_AUDIO` remains and `responding` is semantic.

No second OpenAI session, no API key, no speech-to-text and no recording in any of these steps.
