# v0.4.2 visual review

From the real renderer (Chrome, WebGPU), produced by
`npm run showcase -- music-staff music-middle-c music-scale music-figure spectrum codex-voice-sim listening-spectrum`, which
drives the page through the **real MCP tools** (as Codex calls them). Animations are filmed frames at their real pace
(every second frame kept), assembled by `scripts/media/gif.py`; the full recordings are `.e2e/showcase/*.webm`.

**What is real and what is a stand-in.** The notation, the playback, the lessons, the figure and the renderer are real.
In the sound demos, everything after the macOS capture is real — the hub's socket, the shared analyser, the event
stream, the source policy and detector, the ring and the sphere field — but the sound itself comes from a stand-in for
the Aion Audio Bridge app (`scripts/lib/fakeBridge.ts`, generated music and a speech-like signal), and the listening
demo uses Chrome's fake microphone. **None of this footage is Codex's own voice**: that path is not yet verified.

| File | Shows |
| --- | --- |
| [music.png](music.png) | Demo A–C: lesson 1's lines and spaces lit; lesson 2's treble clef — the card's clef, line 2 and G4 lit while the body forms a treble clef (hybrid); the same step in Chinese; middle C on its ledger line; the C major scale |
| [treble-clef.gif](treble-clef.gif) | The sphere re-forming as a treble clef (Bravura's outline) beside the notation |
| [music-scale.gif](music-scale.gif) | Demo C: the scale played; each note lights the moment it is heard, the sphere moving with the playback's own sound |
| [music-figure.gif](music-figure.gif) | Figure 2.0 turns to the lit G on line 2 and explains it, then points at each note of the scale as it sounds |
| [spectrum.png](spectrum.png) | Demo F/H: sphere; detected music → circular spectrum; bass-heavy (the bottom reaches out) vs treble-heavy (the top); hybrid, expressive; blue particles while the analysis runs; back to the sphere; speech through the bridge path; listening |
| [spectrum.gif](spectrum.gif) | Sphere → spectrum (one particle transition), bass, treble, spectrum → sphere |
| [voice.gif](voice.gif) | A speech-like signal through the bridge path driving the speaking sphere (a stand-in for Codex's voice) |
