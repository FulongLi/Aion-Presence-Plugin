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

## Lifecycle hooks

| Codex event | Aion |
| --- | --- |
| `UserPromptSubmit` | thinking (with a small acknowledging nod) |
| `PreToolUse` | editing · reading · testing · building · working, by tool and command |
| `PostToolUse` | back to thinking after a short settle |
| `Stop` | complete, then rest — after `responding`, Aion keeps answering for as long as the answer takes to say |
| `Interrupt`, `SessionEnd` | idle |

The hook prints nothing, always exits 0 and never blocks a tool. It forwards only the event name, the tool name,
for shell tools the start of the command line, and at the end of a turn one number: how many seconds the final
answer takes to say (computed from its length inside the hook; the text itself is never forwarded). Without trusted
hooks Aion still works; the Skill then sets the main states itself.

## Surfaces and immersive mode

- **Companion** (the default on every host since v0.6): a chrome-less Chromium app window (else the default browser)
  that opens in the foreground and sizes itself to the screen. Browsers allow true fullscreen only from a user gesture, so it offers
  one quiet **Enter Presence**; after that click Aion stays fullscreen for the whole session (visuals never leave
  it). Esc always exits and is respected; **F** returns.
- **Embedded** only when the user asks for it (`surface: "embedded"`) and the host declares MCP Apps support
  (`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`). Immersive asks the host for its fullscreen display
  mode; the host decides, and its own composer or voice controls may stay visible — that is the host's UI, not
  something Aion fights.

Codex currently runs plugin skills, MCP servers and hooks, but its MCP Apps rendering (`enable_mcp_apps`) is under
development and off by default, so with a default Codex Aion uses the companion window. Aion never pretends a
capability exists; `open_presence` reports the mode and the immersive path it used. What every host and browser
actually allows — assistant audio, fullscreen, foreground, always-on-top — is in this page.

## v0.6: Aion's own window and the first-run welcome

**Own window by default.** "Open Aion" opens (or reuses) Aion's companion window on every host. Embedding is a request
(`surface: "embedded"`, or `AION_PRESENCE_SURFACE=embedded` for the v0.5 behaviour); a host without MCP Apps gets the
window instead, and the result says so. A host that renders MCP Apps still shows the `open_presence` view in the
conversation (the tool declares it); that view shows "Aion is open in its own window." rather than a second Aion.

**One window.** Before launching a window, the Aion process tells the shared hub (`launching`, for 20 s, until a
window connects); another conversation's "Open Aion" meanwhile waits for that window instead of opening another
(`open_presence` says "already opening"). An open window is reused; one hidden behind others or minimized is replaced
by a new foreground window and closes itself (as since v0.4).

**Lifecycle**, as tested (`tests/v06.test.ts`, `tests/immersive.test.ts`, `npm run smoke`):

| Situation | Behaviour |
| --- | --- |
| First installation, first session | the window opens by itself once (first run, since v0.3) with the welcome |
| "Open Aion" after that | the window opens without the welcome; Codex greets once |
| Repeated "Open Aion" | no second window; "already open" (or brought forward if hidden) |
| Window closed, then "Open Aion" | a new window |
| Codex restarted while Aion is closed | the hub starts again; the token is kept, so an old window reconnects |
| Hub briefly unreachable | the window rests ("Resting · I'll be back…") and reconnects by itself every 2 s |
| Microphone permission denied | Aion keeps working without listening, says so once |
| Several conversations at once | one hub, one window (the launch guard) |
| No browser can be launched | `window_opened: false` and the address to open |
| Embedded asked for on an MCP Apps host | embedded, as before |

Fullscreen still needs the user's click (Enter Presence); closing the window and Esc are always the user's.

**The welcome.** The first time Aion's window opens, a short panel below the living body: "Welcome to Aion Presence —
Your ideas, brought into view.", one paragraph (Aion is Codex's visual companion), three example requests that work in
this build (terrain, a route, a generated solar system), **Get started** and **Skip**. The window cannot send a request
to Codex (no host offers that), so a click copies the example (or selects it to copy). It steps aside by itself as soon
as Codex shows something, and is remembered as seen after a few seconds on screen (`welcome-complete` in the plugin data
directory; nothing else is stored). Returning users never see it again unless they ask ("Show me the introduction
again" → `open_presence` with `welcome: true`). English or Chinese, by the window's language. No narration: Codex says
one or two sentences of greeting (`greeting.line`) and does not list the examples.

