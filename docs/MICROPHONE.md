# Checking listening on a real microphone

Aion listens **locally**: the Presence window reads the microphone, reduces each block of samples to one loudness
number (RMS) and a voice/no-voice decision, and lets the body react. Nothing is recorded, stored, uploaded or
transcribed, and no model hears it. This page is the procedure for checking the whole chain on a physical device,
step by step, so a failure can be located exactly.

```text
getUserMedia → MediaStream → MicrophoneListener → RMS → VAD → PresenceEngine → activity "listening"
            → PresenceSignal (focus, userAmplitude) → sphere field / figure pose
```

## 1. Open Aion with diagnostics

Say "Open Aion" to Codex, then add `&debug=1` to the companion window's address (or open the `url` from the
`open_presence` result with `&debug=1`). For development, `npm run dev` prints the debug address.

The readout, one line per stage (the same lines print in a terminal with `npm run diagnose`, which stays readable
while the window is fullscreen; nothing leaves the machine):

```text
surface   companion · live · immersive offered · fullscreen off
renderer  webgpu · 20000 particles · effects on · 16.7 ms · frame 1234
mic       ready · permission granted · track-processor · audio running · MacBook Air Microphone (Built-in)
vad       rms 0.0410 · floor 0.0060 · voice · level 0.63 · echo none
activity  host idle → effective listening
state     listening · body sphere · userAmplitude 0.63 · responding 0.00 · speaking no · hostAudio none
visual    sphere · card none · revision 12
hooks     active
```

## 2. Grant the microphone

The page asks once, when Presence opens. Allow it. `mic ready · permission granted` confirms it.

| `mic` says | Meaning | What to do |
| --- | --- | --- |
| `requesting` | The browser's prompt is still waiting | Answer the prompt in the Aion window (it may need the window in front). |
| `denied · permission denied` | Refused for this address | Allow it in the site settings for `127.0.0.1` (lock icon), then reload. Aion keeps working without it. |
| `unavailable` | No device, or the OS blocks the browser | macOS: System Settings → Privacy & Security → Microphone → enable the browser. |
| `ready · … · analyser · audio suspended` | The fallback path waits for a first click (autoplay policy) | Click Enter Presence (or anywhere in the window). |
| `ready · … · track-processor · audio starting` | No samples have arrived yet | Check the selected input device in the OS. |

## 3. Speak

Speak normally from where you sit.

## 4. RMS follows your voice

`vad rms` rises while you speak (typically 0.02–0.3) and falls back near the `floor` (0.001–0.01 in a quiet room)
when you stop. If it never moves, the stream is silent: check the OS input device and level.

## 5. The VAD hears voice

`vad … voice` while you speak, `quiet` after about half a second of silence. `level` follows your loudness (0–1).
If RMS moves but the VAD stays `quiet`, the floor may have calibrated on your voice: stay quiet for a second after
opening, then speak.

## 6. The effective activity becomes listening

`activity host idle → effective listening`. If the host is busy, real work wins: `host editing → effective
editing` is correct (your voice never hides real work). `echo responding` or `echo answer-tail` means the voice is
being treated as Codex's own answer from the speakers (while Codex answers, and until its sound pauses); with
headphones there is no such echo.

## 7. The body visibly responds

`state listening` and `userAmplitude` above 0 while you speak:

- **Sphere**: it gathers inward, calms, brightens slightly, and a soft ripple travels inward with your loudness.
- **Figure**: it leans in, tilts its head and makes small nods that follow your loudness.

If a visual is formed (`state presenting`), `effective listening` and `userAmplitude` still show it, and the formed
visual shimmers with your voice. A card never stops the body listening.

When you stop for about a second, `effective thinking` follows (Aion turns to think until Codex picks up the turn).

## Automated checks

- `npm test` runs the VAD, engine and state machine on scripted loudness (tests/liveState.test.ts).
- `npm run smoke` plays a speech-like signal through Chrome's capture device into the real page and checks every
  stage above, including that the body visibly gathers (scripts/smoke.ts, `listening`).

Neither replaces this procedure on a physical microphone: run it after any change to the listening path.
