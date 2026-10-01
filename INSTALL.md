# Installing Aion Presence

## For Codex (an agent installing this plugin)

If the user asks you to install this repository (https://github.com/FulongLi/Aion-Presence-Plugin) as a Codex
plugin, or says "Install Aion Presence":

1. **Check Codex.** Run `codex --version` and `codex plugin marketplace add --help`. If `codex` is not on the
   PATH, look for `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (macOS desktop app) or
   `/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex`. Plugins need a Codex with
   `codex plugin`. Node 22 or newer must be on the PATH (`node --version`): the plugin's runtime runs on it.
2. **Install with the simplest supported path** — two commands, no clone, no npm, no build (the built runtime
   is part of the repository):

   ```bash
   codex plugin marketplace add FulongLi/Aion-Presence-Plugin
   ```

   ```bash
   codex plugin add aion-presence@spirit-connect
   ```

   If the Git install is not possible (no network to GitHub, an older Codex), clone the repository and run
   the one-command fallback inside it, which does the same and verifies it:

   ```bash
   node scripts/install.mjs
   ```

3. **Verify**: `codex plugin list --json` shows `aion-presence@spirit-connect` installed and enabled, and
   `codex mcp list` shows the `aion-presence` server. (`node scripts/install.mjs` checks both itself.)
4. **Do not ask the user to run commands** you can run yourself. Never ask for an API key, a token or a
   login: Aion needs none.
5. **Tell the user only what Codex genuinely requires**, in one or two sentences:
   - "Restart Codex once to load Aion."
   - "When Codex asks, trust Aion's hooks: Aion uses Codex lifecycle hooks only to reflect states such as
     reading, editing, testing and building." (Aion works without them, with fewer automatic states.)
6. **After the restart**, Aion opens by itself once (the first session after installation). From then on the
   user says **"Open Aion"** and you call `open_presence`, and introduce Aion once if `greeting.due` is true.

Updating later: `codex plugin marketplace upgrade spirit-connect`, then `codex plugin add aion-presence@spirit-connect`.
Removing: `codex plugin remove aion-presence@spirit-connect` and `codex plugin marketplace remove spirit-connect`.

## For people

Ask Codex: **"Install Aion Presence from https://github.com/FulongLi/Aion-Presence-Plugin"**. Codex does the
rest. Then restart Codex once, trust the hooks when asked, and Aion appears. Afterwards just say "Open Aion".

To do it by hand instead, run the two `codex plugin` commands above (or `node scripts/install.mjs` in a clone),
then restart Codex.

| Option | |
| --- | --- |
| `node scripts/install.mjs --github [--ref <ref>]` | Register GitHub instead of the clone (Codex keeps its own snapshot) |
| `node scripts/install.mjs --dry-run` | Check Node, Codex and the source; change nothing |
| `node scripts/install.mjs --json` | Machine-readable result (for agents) |

A v0.1 development install (`aion-presence@aion-presence-dev`) is replaced automatically.

## What Codex may still ask

- **Restart once**: Codex loads newly installed plugins when it starts.
- **Trust the hooks**: Codex does not run plugin hooks until you trust them (`/hooks`).
- **Approve tool calls**: Codex may ask before the first Aion tool calls. They only change what Aion shows (and,
  for portraits, pictures and terrain, look up public data), so you can allow them for the session, or set
  `default_tools_approval_mode = "approve"` under
  `[plugins."aion-presence@spirit-connect".mcp_servers.aion-presence]` in `~/.codex/config.toml`.
- **The microphone**: Aion's window asks once. Allowing it lets Aion look attentive while you talk; the sound is
  analysed on your device only and never recorded, stored or sent. Refusing is fine.

## First run and auto-open

The first Codex session after installation opens Aion's window once. To change that, create
`settings.json` in the plugin's data directory with `{ "autoOpen": "first-run" | "always" | "never" }`, or set
`AION_PRESENCE_AUTO_OPEN`.
