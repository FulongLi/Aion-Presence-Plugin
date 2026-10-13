# Audio-reactive presence (v0.4.2)

Aion moves with **real sound**: the user's voice, Codex's own spoken voice, music played on the computer and the
Music Library's own notes. Every source is reduced to the same small set of features by one analyser, a policy
decides which source drives which part of the body, and the body answers through the existing particle physics: the
sphere deforms with the sound, or the particles re-form as a **circular audio spectrum**. Nothing is recorded,
stored, transcribed or sent, and no model hears anything: Codex stays the intelligence.

## Status: verified and experimental

| Capability | Status | Evidence |
| --- | --- | --- |
| Audio Analysis Engine (FFT, log bands, loudness, noise floor, AGC, smoothing, onsets, beats, voice activity) | **Verified** | Unit tests on exact signals (`tests/v42.test.ts`); the same code in the page and the hub |
| Circular particle spectrum and audio-driven sphere (WebGPU and canvas) | **Verified** | Smoke test in Chrome: ring forms on detected music; bass reaches out at the bottom, treble at the top; calm in silence; back to the sphere |
| Music Library playback driving the body (internal source) | **Verified** | Smoke: route `playback`, sphere field 1.0 while the scale plays; microphone suppressed |
| Bridge socket → hub analysis → event stream → surface → renderer | **Verified with a stand-in app** | Smoke (`scripts/lib/fakeBridge.ts` streams generated music/speech over the real socket) |
| Microphone spectrum while listening | **Verified in Chrome's capture device** | Existing listening smoke (fake device); physical microphone: run [MICROPHONE.md](MICROPHONE.md) |
| macOS process tap of another app (Core Audio) | **Verified on this Mac (probe)** | `afplay` tapped: real samples (peak 0.095 at 12 % volume), 10.7 ms buffers, 21.3 ms device latency, 0.4 % CPU |
| Real app → real bridge → hub → features (`npm run audio:verify -- --play-loops`) | **Pending a permission** | The rebuilt bridge waits for macOS's System Audio Recording consent (see below) |
| Shared browser tab (`getDisplayMedia`) | **Implemented, not automated** | Needs the user's click and the browser's picker; cannot be scripted |
| **Codex Voice → Aion** | **Not yet verified** | Needs a person speaking with Codex in voice mode while `npm run audio:verify -- --codex` runs |
| Automatic music detection | **Measured, conservative** | Real music (Apple Loops) and system voices; see the table below. Speech over a music bed reads as music |

Without a verified capture, Codex's answer keeps the **semantic** `responding` animation (no invented amplitude or
spectrum); the diagnostics line says which is in use (`hostAudio codex-bridge` and `speaking yes` only with real
frames).

## Architecture

```text
 Audio source                         capture adapter                           where it is analysed
 ─────────────────────────────────    ────────────────────────────────────────  ──────────────────────
 user's microphone                    MicrophoneListener (src/surface/microphone.ts)   the page
 a browser tab the user shares        TabAudioCapture (src/surface/capture.ts)         the page
 the Music Library's playback         MusicPlayer's AnalyserNode (src/surface/music)   the page
 Codex's voice · another Mac app      Aion Audio Bridge (native/audio-bridge) ─unix socket─► NativeAudioBridge   the hub
                                                       │
                                                       ▼
                         AudioAnalyzer (src/audio/analyzer.ts) — the only FFT in Aion
                         RMS · FFT (Hann) · 32 log bands · bass/mid/treble · flux → onset, beat
                         centroid · flatness · speech share · voice activity · silence
                                                       │  AudioFeatures (src/audio/features.ts)
                                                       ▼
                         Audio Feature Bus (src/audio/bus.ts)  ◄── hub event stream (`event: audio`, wire.ts)
                                                       │
                         Source policy (src/audio/route.ts) + MusicDetector (src/audio/detector.ts)
                                                       │
                         AudioVisualizer (src/surface/audioVisual.ts): eases the ring and the sphere field
                                                       │  AudioVisualFrame
                                                       ▼
                         Particle renderer: ring layer (render/physics/ring.ts) · sphere field (physics/audioField.ts)
                         canvas fallback from the CPU reference (render/ring.ts)
                         Codex's voice also reaches PresenceEngine as a real HostAudioSource → `speaking`
```

- **One analyser.** `AudioAnalyzer` is pure arithmetic (no DOM, no audio API) and runs unchanged in the page and in
  the hub. The macOS bridge no longer computes a spectrum of its own (it did in the v0.4 experiment): it sends
  samples over a private socket and the hub analyses them. Samples live only in a short ring buffer and are
  overwritten; only features leave the analyser.
- **Common format.** `AudioFeatures`: `level` (perceived loudness above the noise floor, 0–1), `rms`, 32 `bands`,
  `bass`/`mid`/`treble`, `onset`, `beat`, `centroid`, `flatness`, `speech` share, `voice`, `silent`. On the wire
  (hub → page) a frame is about 120 bytes: ten quantised numbers and one byte per band; no field can carry audio.
- **Not on the render thread.** Capture runs on the audio thread or a stream reader; the page analyses once per
  rendered frame (0.03 ms for the 2048-point FFT and features); the hub analyses at 60 Hz in its own process. The renderer
  receives a handful of uniforms per frame; nothing is read back from the GPU.

### Frequency analysis

| Step | Choice |
| --- | --- |
| Window | Hann, 2048 samples (43 ms at 48 kHz; 23 Hz bins) |
| Bands | 32 log-spaced bands, 40 Hz – 16 kHz (equal width in octaves); bands narrower than a bin interpolate the spectrum |
| Normalisation | dB, +3 dB/octave tilt above 1 kHz (so treble shows beside bass), per-band minimum-statistics noise floor, an adaptive spectral reference (42 dB range) |
| Loudness | RMS in dB above a noise floor (minimum over the last 8 s); automatic gain: the reference jumps to a new peak and sinks 3.5 dB/s, never below −38 dBFS (so a whisper is never blown up) |
| Noise floor | Microphone: clamped to −80…−46 dBFS (a steady room is never sound). Digital sources (bridge, tab, playback): up to −72 dBFS, so quiet music still counts |
| Smoothing | Attack 30 ms, release 200 ms (bands); 25/280 ms (level) |
| Silence | Below the gate for 0.35 s, or no samples for 0.25 s |
| Onsets and beats | Positive spectral flux against its own running mean and spread; a beat is a strong onset at least 0.28 s after the last |
| Voice activity | Loud enough and ≥ 50 % of energy in 150 Hz – 4 kHz, with 60 ms attack and 300 ms hangover |

Frequency analysis is not pitch recognition: Aion does not claim to know which notes are playing from the spectrum.
The Music Library knows its notes because it plays them (see [MUSIC.md](MUSIC.md)).

## Source management (`src/audio/route.ts`)

Pure policy, tested rule by rule:

1. **Aion's own music** is analysed straight from its playback graph. While it sounds and for 0.6 s after, the
   microphone is not taken for the user (`echo playback`), and Codex's tap is ignored (embedded in the Codex app,
   Codex's own process plays Aion's notes): one sound is never analysed twice. A lesson never becomes the spectrum
   by itself; the notation stays.
2. **Codex's voice** (bridge) drives the speaking body through `PresenceEngine` (real `HostAudioSource`): `speaking`,
   SCF's speech motion, and the echo guard that keeps it from being taken for the user. It never forms the ring
   unless the user explicitly chose `source: codex` with a spectrum mode.
3. **External music** (another app, a shared tab) forms the ring when asked (`spectrum`, `hybrid`) or, in `auto`,
   when the detector has heard sustained music; otherwise it moves the sphere gently.
4. **The microphone** is listening (the engine's job, unchanged); its spectrum adds a little detail to the listening
   sphere (field weight 0.45). It becomes the ring only if the user chooses the microphone and the spectrum.

A source that is not connected drives nothing. Host state (thinking, responding) never switches the spectrum off.
Device changes and lost permissions end a capture (the track ends, the bridge's socket closes) and the source
simply stops driving the body.

## Visual modes

| Mode | What the body does |
| --- | --- |
| `auto` (default) | The sphere for speech (the user's voice, Codex's voice); the circular spectrum only for sustained external music the user shared |
| `sphere` | Always the sphere, moved by the active source: breathing with loudness, beat pulses, waves whose height follows the band at each latitude (bass at the bottom pole), a mid-band ripple, a fine treble shiver, a little more light. Bounded: it stays a sphere |
| `spectrum` | About 30 % of the particles stay as a small core that swells with the bass; the rest form a ring of particle bars: bass at the bottom, treble at the top, mirrored left and right. Low frequencies swell the whole ring and make the tallest, slowest bars; mids send a ripple round it; treble adds fast shimmer at the tips. Particles flow slowly round the ring and ride the spectrum's outline |
| `hybrid` | The full sphere (93 %) inside a lighter ring |

Transitions use the body's own morph language: a per-grain stagger and the same 2.2 s eased re-forming as sphere →
eyes → figure. `intensity` scales every audio-driven motion (subtle 0.55, balanced 1, expressive 1.6) and
`sensitivity` lowers or raises the gate (16 → 4 dB above the floor). Colours come from `set_colors` and change
without interrupting the analysis. Reduced motion calms the audio motion to 30 %.

## Automatic music detection

`MusicDetector` uses four measurable properties of the last 6 s (deep loudness dips, continuity, a 60–180 bpm pulse,
energy outside the speech band) with confidence thresholds (enter ≥ 0.66 held 3.5 s; leave ≤ 0.42 held 3 s, or 2.2 s
of silence). It runs only on sources the user shared (system audio, a tab); never on Codex, the microphone or the
Music Library.

Measured with `npm run audio:eval` on this Mac (real recordings decoded from Apple Loops; speech from macOS's system
voices, English and Chinese; nothing kept):

| Material | Result |
| --- | --- |
| Full tracks (a beat, a bass and a melodic part layered from one genre pack), 13 | **13/13** became the spectrum, after 7.1 s |
| Single loops (one instrument or beat), 24 | 16/24 (sparse solo parts — a lone guitar or piano — often do not) |
| Speech, 13 voices | **13/13 never switched** |
| Speech over a music bed 18 dB down (a podcast), 8 | **0/8 stayed speech**: a bed with a beat reads as music |
| Sound effects (traffic, drills, crowds), 8 | 4/8 switched (sustained noise looks like music) |

So: shared music becomes the spectrum reliably; plain speech never does; **talk over background music is treated as
music**, and so is sustained noise. Human speech was not available for the measurement (system voices only). Explicit
modes (`spectrum`, `sphere`) avoid any classification.

## Capturing Codex's voice

Investigated in order of preference:

1. **The host's own audio stream.** The Codex app-server protocol has `thread/realtime/outputAudio/delta`
   (EXPERIMENTAL: PCM chunks with sample rate and channels), checked again against `codex-cli 0.162.0-alpha.17.2`'s
   generated schema. It is delivered only to the app-server's client — in the desktop app, its own Electron process
   over a private stdio pipe — and in the WebRTC transport (`thread/realtime/sdp`) the audio never passes through the
   app-server at all. MCP servers, hooks and Skills receive no audio. Not available to a plugin.
2. **The macOS Aion Audio Bridge** (Core Audio process tap; [AUDIO-BRIDGE.md](AUDIO-BRIDGE.md)): taps
   `com.openai.codex` and its helpers (the Chromium `AudioService` helper that plays the voice is
   `com.openai.codex.helper`). Private, unmuted, mono; ~50 ms to the hub. This is the integrated path.
3. **Browser capture.** A tab's audio needs the user's pick in the browser's own dialog (`getDisplayMedia`); on macOS
   browsers offer tabs only, not other apps. Microphone permission never grants playback audio.

## Permissions and privacy

| Source | Asks | Where it is analysed | Leaves the device |
| --- | --- | --- | --- |
| Microphone | The browser's microphone prompt (once) | The page | Nothing |
| Shared tab | The browser's share picker, after a click on "Share tab audio" | The page | Nothing |
| Music Library playback | Nothing (one click lets a page sound) | The page | Nothing |
| Codex's voice, other apps | Only when the user asks (`set_audio_visualizer`); macOS's "System Audio Recording Only" for the bridge app | The hub, on loopback | Nothing |

- No capture starts by itself; capture sources are never remembered across sessions (only mode, intensity and
  sensitivity are, in `audio.json`). "Stop listening to system audio" ends the capture at once.
- The bridge talks only to the hub, over a Unix socket in a fresh 0700 directory with a one-time nonce; the hub
  re-validates every frame; the event stream carries features only. Tests check that the capture code has no
  network, storage or playback path (`tests/v42.test.ts`, `tests/apiIndependence.test.ts`).
- A small indicator shows a captured source while (and only while) it is really connected.

## Performance

- Analysis: one 2048-point FFT and the feature pipeline per source per frame, **0.03 ms** (measured in Node on Apple
  silicon); a 60 Hz analysis loop in Node, timer overhead included, about 1.8 % of one core. The bridge app itself:
  0.4 % of a core while audio flows (probe).
- Latency, tap to body: 10.7 ms buffer + 21.3 ms device + ≤ 16.7 ms analysis frame + loopback event stream (< 2 ms)
  + one render frame ≈ **50–70 ms**, under the 100 ms target. Page sources (microphone, tab, playback) skip the bridge.
- The ring and the sphere field are a few uniforms and per-grain expressions in the existing compute and material
  passes: no extra pass, no read-back; adaptive quality, WebGPU and the canvas fallback are unchanged.

## Verify on a real device

```bash
npm run audio-bridge:install
```

```bash
npm run audio:verify -- --play-loops --screenshots .e2e/audio-verify
```

```bash
npm run audio:verify -- --codex --seconds 40
```

The second plays a track layered from Apple Loops with `afplay` and checks that the real tap reaches Aion as features
(and screenshots the body). The third needs you: start a voice conversation with Codex and speak during the 40
seconds; `verdict: Codex's voice reached Aion as real features` confirms the Codex Voice path. The first time, macOS
asks to allow **System Audio Recording** for "Aion Audio Bridge"; rebuilding the app asks again (ad-hoc signature).

## Known limitations

- Codex Voice synchronisation is implemented end to end but **not yet verified** with a real voice session.
- The bridge is macOS 14.2+ only, built locally (`npm run audio-bridge:install`, Xcode command-line tools), ad-hoc
  signed: a shipped bridge needs a Developer ID signature so the permission survives updates.
- A process tap hears everything that app plays (a notification sound in Codex, a video in the same app).
- The embedded MCP Apps view receives no hub event stream: bridge sources (Codex, other apps) animate the companion
  window only; the microphone, tabs and the Music Library work in both.
- Automatic music detection treats speech over a music bed, and some sustained noise, as music (measured above).
- The ring and sphere-field geometry is tuned by eye on Apple silicon; a visual review may want other proportions.
