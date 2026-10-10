# Aion Audio Bridge (experimental)

A standalone macOS proof of concept. It captures one app's audio output with a Core Audio process tap and reduces
it to loudness, 16 spectrum bands and voice activity. **It is not part of the Aion Presence plugin.** The
feasibility report, with measurements, is in [docs/AUDIO-BRIDGE.md](../../docs/AUDIO-BRIDGE.md).

```bash
./build.sh
```

```bash
open -W -n --stdout /tmp/aion-bridge.jsonl "build/Aion Audio Bridge.app" --args list
```

```bash
open -W -n --stdout /tmp/aion-bridge.jsonl "build/Aion Audio Bridge.app" --args tap --bundle com.openai.codex --seconds 30
```

- Requires macOS 14.2+ and Xcode command-line tools.
- The first `tap` asks for "System Audio Recording Only" (Privacy & Security). Without it, the tap hears silence.
- Nothing is recorded, stored, uploaded or transcribed. Output is feature frames only:
  `{"t":1.02,"rms":0.0125,"level":0.35,"voice":true,"bands":[16 values 0…1]}`.
