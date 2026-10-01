import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containedPath, discoverSkills, MARKETPLACE, PLUGIN_ROOT, validatePluginPackage } from "../scripts/lib/pluginPackage";

const read = (file: string) => JSON.parse(readFileSync(join(PLUGIN_ROOT, file), "utf8"));

test("the plugin package passes every static check", () => {
  const issues = validatePluginPackage();
  assert.deepEqual(issues.filter(issue => issue.level === "error"), []);
});

test("plugin.json is the canonical portable manifest with the Aion Presence identity", () => {
  const manifest = read("plugin.json");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "aion-presence");
  const ui = manifest.extensions["com.openai"].interface;
  assert.equal(ui.displayName, "Aion Presence");
  assert.equal(ui.developerName, "Spirit Connect");
  assert.equal(ui.category, "Developer Tools");
  assert.ok(ui.defaultPrompt.includes("Open Aion"));
});

test("there is one manifest: no divergent .codex-plugin overlay", () => {
  assert.throws(() => readFileSync(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json")));
});

test("mcp.json starts the bundled local server and asks for no credentials", () => {
  const config = read("mcp.json");
  const server = config.mcpServers["aion-presence"];
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${PLUGIN_ROOT}/runtime/aion-mcp.mjs"]);
  assert.equal(JSON.stringify(config).match(/OPENAI|API_KEY|apiKey|token/i), null);
});

test("the repo marketplace installs the plugin from a contained ./ path", () => {
  const market = JSON.parse(readFileSync(MARKETPLACE, "utf8"));
  const entry = market.plugins.find((item: { name: string }) => item.name === "aion-presence");
  assert.deepEqual(entry.source, { source: "local", path: "./plugins/aion-presence" });
  assert.equal(entry.category, "Developer Tools");
});

test("plugin-relative paths must start with ./ and stay inside the root", () => {
  assert.ok(containedPath(PLUGIN_ROOT, "./assets/icon.svg"));
  assert.equal(containedPath(PLUGIN_ROOT, "assets/icon.svg"), null);
  assert.equal(containedPath(PLUGIN_ROOT, "./../../package.json"), null);
  assert.equal(containedPath(PLUGIN_ROOT, "/etc/passwd"), null);
});

test("skill discovery follows the specification: immediate children holding SKILL.md only", () => {
  const root = mkdtempSync(join(tmpdir(), "aion-skills-"));
  mkdirSync(join(root, "skills", "one"), { recursive: true });
  writeFileSync(join(root, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: First.\n---\nDo one.\n");
  mkdirSync(join(root, "skills", "nested", "deeper"), { recursive: true });
  writeFileSync(join(root, "skills", "nested", "deeper", "SKILL.md"), "---\nname: deeper\ndescription: Hidden.\n---\nNo.\n");
  mkdirSync(join(root, "skills", "dir-named", "SKILL.md"), { recursive: true });
  assert.deepEqual(discoverSkills(root).map(skill => skill.name), ["one"]);
});

test("validation reports a broken package", () => {
  const root = mkdtempSync(join(tmpdir(), "aion-bad-"));
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Bad Name" }));
  const errors = validatePluginPackage({ root, marketplace: join(root, "none.json") }).filter(issue => issue.level === "error");
  assert.ok(errors.some(issue => issue.where === "plugin.json" && /pattern/.test(issue.message)));
  assert.ok(errors.some(issue => issue.where === "mcp.json"));
  assert.ok(errors.some(issue => issue.where === "skills/"));
});
