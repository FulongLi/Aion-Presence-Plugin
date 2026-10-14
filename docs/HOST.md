# What the host allows: capabilities and limitations

Aion never pretends a capability exists. This is what the current hosts and browsers actually expose, as checked
for v0.3 (Codex CLI 0.159.2, bundled with the ChatGPT desktop app; Chrome 154; macOS 26), and what Aion does with it.

## Assistant audio (real "speaking")

| Question | Answer |
| --- | --- |
| Does Codex expose the assistant's audio (a MediaStream, amplitude, timing) to plugins? | **No.** Codex's voice (`realtime_conversation`) runs in a native runtime inside the Codex process; the hooks, MCP and Skill interfaces carry no audio, level or voice-lifecycle signal. |
| Is frequency-reactive GPT speech possible today? | **No.** It needs real assistant audio. |
| What does Aion do instead? | `responding` is a semantic animation (the body visibly answers; no amplitude, no spectrum, no lip sync). The Stop hook reports only how long the final answer takes to say (from its length; the text never leaves the hook), and the body keeps answering for that long. |
| Where does real audio plug in? | `HostAudioSource` (src/core/audio.ts). A host that exposes assistant audio needs one adapter; the engine then drives SCF's audio-reactive speech motion and echo guard. |

Aion never starts its own voice or model session to obtain audio.

**v0.4 findings** (Codex CLI 0.162, ChatGPT desktop 26.1007, macOS 26.6; details in [AUDIO-BRIDGE.md](AUDIO-BRIDGE.md)):

- The Codex **app-server** protocol now has `thread/realtime/outputAudio/delta` (EXPERIMENTAL): the assistant's
  output audio as PCM chunks, sent to app-server clients. That is the right source for real speech motion, once it
  is stable and a plugin may observe it. Plugins (MCP, hooks, Skill) still receive no audio.
- **Core Audio process taps** (macOS 14.2+) can capture one app's output in isolation, with about 50 ms latency and
  1–2 % CPU, after the user grants "System Audio Recording Only". A standalone prototype is in
  `experiments/audio-bridge/`. It is not part of the plugin and is not yet verified against Codex Voice itself.
- ScreenCaptureKit can do the same with a broader permission (screen recording). Not used.

**v0.4.2** (codex-cli 0.162.0-alpha.17.2, ChatGPT desktop with Codex 155, macOS 26.6): the app-server's output audio is
delivered only to its own client over a private pipe (and not at all in the WebRTC transport), so plugins still get
no audio from the host. The Core Audio bridge is integrated as the capture adapter (`native/audio-bridge/`,
`set_audio_visualizer` source `codex`): when the user asks for it and macOS allows it, Codex's real voice becomes a
`HostAudioSource` and Aion speaks with it. Not yet verified against a real Codex voice session; until a capture is
streaming, `responding` stays semantic. See [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md).

**v0.4.3** (codex-cli 0.162.0-alpha.17.2): Codex Voice Sync makes the bridge path a remembered choice that reconnects by
itself whenever Aion is open (see [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md)). Still not verified against a real voice session.

## Speech output controls (v0.4.3)

| Question | Answer |
| --- | --- |
| Can a plugin set Codex's speech rate, prosody, pause length or volume? | **No.** The app-server protocol of codex-cli 0.162.0-alpha.17.2 (generated schema, checked for this release) has no rate, speed, prosody, pause or volume parameter for realtime voice. |
| Voice selection? | The protocol lists realtime voices (`RealtimeVoice`, `RealtimeVoicesList`: alloy, ash, ballad, cedar, coral, marin, sage, shimmer, verse …) for **app-server clients** — the desktop app's own UI. MCP servers, hooks and Skills cannot set it. |
| What does Aion do? | Narration guidance in the Skill: calmer, shorter, unhurried replies with natural pauses, per context (conversation, storytelling, music teaching, writing, animations). It changes what is said and its pacing, not the synthesis. The Skill tells Codex never to claim it changed the voice's speed or the voice itself; those are Codex's own voice settings. |
| Slowing the audio down? | Not done: stretching playback would distort the voice, and the audio is not Aion's to alter. |

## Echo without host audio

Without the host's audio, Aion cannot tell Codex's voice from the user's when both come from the room. It is
conservative: while Codex is `responding` (and while that sound continues without a pause afterwards, at most 20 s),
the microphone is not taken as the user. A `responding` state that never ended stops counting after 45 s, so it can
never block listening indefinitely. With headphones there is no echo at all. Real barge-in detection needs real host
audio; Codex's own interrupt (the Interrupt hook) still ends an answer at once.

## Embedded (MCP Apps) mode

| Question | Answer |
| --- | --- |
| Does Codex render MCP Apps? | Not by default: `enable_mcp_apps` is "under development" and off in Codex 0.159.2. With a default Codex, Aion uses the companion window. Aion decides from what the host declares, never from a guess. |
| Fullscreen when embedded? | Aion asks the host for its `fullscreen` display mode (MCP Apps `ui/request-display-mode`). The host decides and may refuse; Aion then carries on inline. |
| Does embedded fullscreen hide the host's composer, voice controls or overlays? | **Not necessarily, and Aion does not try.** The MCP Apps specification does not define it; a host may keep its own UI above the view. That is the host's UI and is respected. |

## Companion (browser) mode

| Question | Answer |
| --- | --- |
| Foreground? | A newly launched app window comes to the front and fills the screen. A page cannot raise its own window later (`window.focus()` from the background is ignored, and Aion never loops on it). When Chrome reports the open window hidden (minimized, or occluded as Chrome judges it), "Open Aion" launches a new window in front and the old one closes itself. Chrome does not always report a covered window as hidden (in testing, a window covered by another Chrome window stayed "visible"), and focus is no substitute (a pending permission prompt takes it from a window that is in front), so in that case Aion stays where it is rather than churning windows; `open_presence` says it is already open on screen. |
| Always on top? | **Not available** in a normal browser. Aion does not simulate it. |
| Window size? | When Chrome is already running it ignores size flags for the new window, so the page sizes its own app window to the available screen (allowed for app windows; menu bar and dock stay). |
| True fullscreen? | **Needs one user gesture.** Browsers only enter fullscreen from a click or key press. Aion shows one quiet "Enter Presence"; that click requests fullscreen synchronously (and starts audio). No flag or trick bypasses this. |
| Does fullscreen survive visuals? | Yes. Visual transformations never leave it. |
| Can the user leave? | Always: Esc (or the browser's own control). Aion respects it and never re-enters by itself; F or the corner control returns to fullscreen. |
| Default browser not Chromium? | The page opens in the default browser; fullscreen still works from the click, without app-window sizing. |

## Microphone

Requested once, when Presence opens; one browser permission. Refused: Aion keeps working, says so once, and never
asks again by itself. The AnalyserNode fallback (browsers without MediaStreamTrackProcessor) may wait for a first
click (autoplay policy); Enter Presence provides it. See [MICROPHONE.md](MICROPHONE.md) for the real-device check.

## What needs the user

- Trusting the Codex hooks once (`/hooks`), for real work states and the answer tail. Without them the Skill sets the
  main states and `responding` settles after 30 s.
- Allowing the microphone once.
- One click on Enter Presence for true fullscreen in the companion.
