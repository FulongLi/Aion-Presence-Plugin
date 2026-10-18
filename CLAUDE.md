# Working on Aion Presence

Aion Presence is a Codex plugin: Codex is the intelligence, Aion is its visual body (a particle presence, cards and
generated 3D scenes). "One Intelligence. One Scene Model. Multiple Visual Representations." Read
[docs/architecture.md](docs/architecture.md) before changing structure.

## Rules

1. **Preserve existing functionality.** Do not remove or redesign working features without a clear, stated reason.
   Extend what exists (Scene IR, patches, the card tools) rather than adding parallel systems.
2. **Maintain documentation.** After every meaningful change: add to [CHANGELOG.md](CHANGELOG.md) (under the version
   in progress), update the relevant file in `docs/`, and update README only when user-facing information changes.
3. **Keep README concise** (about 150 lines). New detail goes into `docs/`, linked from README's documentation table.
   Never append version histories or long feature lists to README.
4. **Keep versions consistent.** `package.json`, `package-lock.json` (both entries), `plugins/aion-presence/plugin.json`
   and the CHANGELOG move together; `npm run plugin:validate` checks the manifests. A card application's own manifest
   version changes when its protocol or behaviour changes.
5. **Preserve history.** Never rewrite published history, force-push `main`, or move or delete a release tag
   (`v0.4.5` exists). Release tags are created only with the owner's approval (pushing a `v*` tag publishes a release).
6. **Respect the license.** Do not remove, weaken or silently change [LICENSE](LICENSE) (a draft pending legal review),
   copyright or attribution notices, or third-party licenses (`plugins/aion-presence/THIRD-PARTY-NOTICES.md`,
   `packs/chinese-writing/`). Never describe Aion as open source. Keep `plugins/aion-presence/LICENSE` identical to
   the root LICENSE.
7. **Test before completion.** Run what the change touches — at least `npm run check` (lint, typecheck, tests,
   runtime check, plugin validation) and `npm run mcp:budget`; for anything visible, `npm run smoke` (or
   `-- --only=<section>`) and look at real renderer output. Report results honestly, failures included.
8. **Avoid unnecessary dependencies.** Prefer the existing stack (three.js and its examples, zod, the MCP SDK). No new
   AI services, model calls or API keys — Aion never has its own model.
9. **Prioritise the user's experience**: real behaviour in the real renderer over additional demonstrations.
10. **Commit discipline.** Small, logically grouped commits with clear messages. Work on a branch from latest `main`
    (`feat/vX.Y.Z-topic`), open a pull request, and never merge into `main` or publish a release without the owner's
    approval.
11. **Accurate claims.** Never report a capability, visual result, performance number or test as successful without
    evidence (command output, screenshots, measured numbers). Say what was not verified.

## Practicalities

- **Build the runtime and commit it.** `plugins/aion-presence/runtime/` is committed (users install without building).
  After source changes run `npm run build`; CI's `runtime:check` fails if it differs. `npm run dev` rebuilds an
  unminified runtime — run `npm run build` again before committing.
- **Tool metadata budget.** Aion's MCP tool metadata is measured against Codex's budget (`npm run mcp:budget`, about
  57.6 KB used). Do not add tools or lengthen descriptions without measuring; prefer extending existing tools with
  validated data (see [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md)).
- **Security boundaries.** Scene documents are data, never code; validate in the MCP server, the hub and the card.
  Cards run in an opaque-origin sandbox and only propose changes (the hub decides). See
  [docs/CARD-SECURITY.md](docs/CARD-SECURITY.md).
- **iCloud.** If the checkout lives in iCloud Drive, evicted files make tools hang. Materialise them with
  `find node_modules -flags +dataless -type f -print0 | xargs -0 -P 24 -n 40 cat > /dev/null`; delete stray
  `* 2.*` duplicates in `runtime/`.
- **Real-Codex checks.** `npm run codex:verify` (installation) and `npm run scene:eval` (natural-language scene
  generation; uses the owner's Codex account). Keep the distinction between unit tests, fixture-based browser tests,
  real Codex runs and human-observed demonstrations ([docs/SCENE-GENERATION-TESTS.md](docs/SCENE-GENERATION-TESTS.md)).
- **Starring.** The README invites a GitHub star; never star the repository or use anyone's GitHub credentials for it.
