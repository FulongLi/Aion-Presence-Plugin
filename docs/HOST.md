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

**Desktop audio capture** (a future native shell): macOS can capture system or app audio (ScreenCaptureKit), but it
needs a screen-recording-class permission and would capture whatever is playing, not only the assistant. It is not
used and not required; if ever added, it would be opt-in, explained, and only reduced to loudness locally.

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
