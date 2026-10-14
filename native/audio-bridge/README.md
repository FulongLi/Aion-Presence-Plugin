# Aion Audio Bridge (macOS)

The capture adapter for Codex's spoken voice and other applications' sound (v0.4.2; follow mode v0.4.3). A Core Audio process tap
(macOS 14.2+) captures one application's output (all of its processes) or the whole system mix, privately and
unmuted, and streams the samples to the local Aion hub over a Unix socket. The hub analyses them with the shared
Audio Analysis Engine; nothing is recorded, stored, sent or transcribed. See
[docs/AUDIO-REACTIVE.md](../../docs/AUDIO-REACTIVE.md) and [docs/AUDIO-BRIDGE.md](../../docs/AUDIO-BRIDGE.md).

```bash
npm run audio-bridge:install
```

```bash
npm run audio:verify -- --play-loops
```

- Requires macOS 14.2+ and the Xcode command-line tools. The app is ad-hoc signed; macOS asks once for "System Audio
  Recording Only" (Privacy & Security → Screen & System Audio Recording). Rebuilding asks again.
- The hub starts it only when the user asks Aion to react to Codex's voice or another app's sound, and it exits as
  soon as the hub closes its socket.
- `list` (audio clients) and `probe … --seconds S` (a summary: peak, callbacks, latency, CPU; no samples leave it)
  help check a setup by hand: `open -W -n --stdout /tmp/aion-bridge.txt "native/audio-bridge/build/Aion Audio Bridge.app" --args list`.

## Follow mode (v0.4.3)

`stream … --follow` (the hub always passes it): when no process of the app plays audio yet, the bridge writes
`AION-WAIT1 <nonce>\n` and waits for one, notified by Core Audio (`kAudioHardwarePropertyProcessObjectList`), never
polling. While streaming it exits when the set of tapped processes changes (an audio helper restarting, a new one for a
voice session) or when the default output device changes; the hub then reconnects with backoff (Codex Voice Sync). A
rebuilt bridge is a new ad-hoc signature: macOS asks for System Audio Recording again after `npm run audio-bridge:install`.
