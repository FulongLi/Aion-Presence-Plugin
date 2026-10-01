import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSkills } from "../scripts/lib/pluginPackage";
import { greetingLine, greetingLineChinese, ONBOARDING_EXAMPLES, onboardingGuidance, onboardingLine } from "../src/core/guidance";
import { AION_IDENTITY } from "../src/core/identity";
import { ACTIVITY_STATES } from "../src/core/state";
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from "../src/host/mcp/server";
import * as schemas from "../src/host/schemas";
import { visualForms } from "../src/visual/forms";

const skill = discoverSkills().find(item => item.name === "aion-presence")!;

/** The input schema of each tool, as the MCP server registers it. */
const INPUTS: Record<string, { safeParse(value: unknown): { success: boolean } }> = {
  open_presence: schemas.openPresenceInput, set_presence_state: schemas.setPresenceStateInput, set_body_form: schemas.setBodyFormInput,
  show_image: schemas.showImageInput, show_portrait: schemas.showPortraitInput, show_terrain: schemas.showTerrainInput, show_form: schemas.showFormInput,
  show_clock: schemas.showClockInput, show_number: schemas.showNumberInput, show_text: schemas.showTextInput, show_symbol: schemas.showSymbolInput,
  show_emoji: schemas.showEmojiInput, show_result: schemas.showResultInput, show_artifact: schemas.showArtifactInput, show_visual_form: schemas.showVisualFormInput,
};

test("the Aion Presence skill is discoverable with a trigger-oriented description", () => {
  assert.ok(skill, "skills/aion-presence/SKILL.md");
  assert.equal(skill.dir, "aion-presence");
  assert.ok(skill.description.length >= 80 && skill.description.length <= 1024);
  assert.match(skill.description, /open, see or talk to Aion/);
  assert.match(skill.description, /what someone or something looks like, the terrain of a place/, "it triggers on natural visual questions too");
  assert.match(skill.description, /not another AI model/);
});

test("the skill teaches that Codex is the intelligence and Aion is its body", () => {
  assert.match(skill.body, /\*\*you, the Codex agent\*\*/);
  assert.match(skill.body, /not\*\* a second AI, assistant or personality/);
  assert.match(skill.body, /no model calls and needs no API key/);
  assert.match(skill.body, /never try to start a voice session/);
  assert.match(skill.body, /never records, stores, uploads or transcribes anything/);
  assert.match(skill.body, /treat it as your persistent visual body, not as an occasional debug renderer/);
});

test("the skill states the canonical identity facts exactly", () => {
  for (const fact of [AION_IDENTITY.name, AION_IDENTITY.product, AION_IDENTITY.creatorCompany, AION_IDENTITY.leadCreator]) {
    assert.ok(skill.body.includes(fact), fact);
  }
});

test("the skill only names tools and states that exist, and teaches every tool", () => {
  const named = new Set([...skill.body.matchAll(/`([a-z]+_[a-z_]+)`/g)].map(match => match[1]).filter(name => /^(?:show|set|open|clear)_/.test(name)));
  for (const name of named) assert.ok((TOOL_NAMES as readonly string[]).includes(name), `${name} is a real tool`);
  for (const name of TOOL_NAMES.filter(name => name !== "show_visual_form")) assert.ok(named.has(name), `${name} is taught`);
  const states = [...skill.body.matchAll(/`(idle|listening|thinking|working|reading|editing|testing|building|responding|presenting|complete|error)`/g)].map(match => match[1]);
  for (const state of states) assert.ok((ACTIVITY_STATES as readonly string[]).includes(state), `${state} is a real state`);
});

test("greeting: once per newly opened Presence, from the canonical facts, in the user's language", () => {
  assert.match(skill.body, /`greeting\.due: true`/);
  assert.match(skill.body, /If `greeting\.due` is false, Aion was already\s+open: do not greet again/);
  assert.match(skill.body, /start in English when\s+the language is unknown/);
  for (const line of [greetingLine(), greetingLineChinese()]) {
    for (const fact of [AION_IDENTITY.name, AION_IDENTITY.creatorCompany]) assert.ok(line.includes(fact), fact);
    assert.match(line, /Codex/);
  }
  assert.match(greetingLine(), /^Hi, I'm Aion, an interactive AI presence created by Spirit Connect\. I'm the visual body for this Codex session\./);
  assert.match(greetingLine(), /talk to me naturally, ask me to show you people, places, forms or ideas, or simply work with Codex as usual/);
});

test("onboarding examples are backed by real tools whose arguments pass the real schemas", () => {
  assert.ok(ONBOARDING_EXAMPLES.length >= 4);
  for (const example of ONBOARDING_EXAMPLES) {
    assert.ok((TOOL_NAMES as readonly string[]).includes(example.tool), `${example.tool} exists`);
    assert.equal(INPUTS[example.tool].safeParse(example.args).success, true, `${example.tool} ${JSON.stringify(example.args)}`);
    if (example.tool === "show_form") assert.ok(visualForms.lookup(String(example.args.form)), `${example.args.form} is a form`);
    assert.ok(skill.body.includes(`"${example.ask}" (\`${example.tool}\`)`), `the skill offers "${example.ask}" with ${example.tool}`);
  }
  assert.match(onboardingGuidance(), /Never recite a feature list/);
  assert.ok(onboardingLine().split("Ask me").length - 1 <= 4, "two to four examples, not a list");
  assert.match(skill.body, /"What can you do\?"/);
  assert.match(skill.body, /"怎么玩？", "你能做什么？"/);
});

test("Visual Intent Policy: natural requests map to the right tool, with arguments the tool accepts", () => {
  const rows = [...skill.body.matchAll(/^\| "([^"]+)" \| `([a-z_]+)` `(\{[^`]*\})` \|$/gm)].map(match => ({ say: match[1], tool: match[2], args: JSON.parse(match[3]) as Record<string, unknown> }));
  const expected: [string, string][] = [
    ["What did Nikola Tesla look like?", "show_portrait"], ["Show me Nikola Tesla.", "show_portrait"],
    ["What is the terrain of the UK like?", "show_terrain"], ["Show me Scotland's topography.", "show_terrain"],
    ["What does Orion look like?", "show_form"], ["Show me the yin-yang.", "show_form"],
    ["What time is it?", "show_clock"], ["Show me 42%.", "show_number"], ["Take a human form.", "set_body_form"],
  ];
  for (const [say, tool] of expected) {
    const row = rows.find(item => item.say === say);
    assert.ok(row, `the policy covers "${say}"`);
    assert.equal(row.tool, tool, say);
  }
  for (const row of rows) {
    assert.equal(INPUTS[row.tool].safeParse(row.args).success, true, `${row.tool} ${JSON.stringify(row.args)}`);
    if (row.tool === "show_form") assert.ok(visualForms.lookup(String(row.args.form)), String(row.args.form));
  }
  assert.match(skill.body, /the user does not need to say "show me" or name a tool/);
  assert.match(skill.body, /do not only describe it/);
  // The tool descriptions carry the same intent (SCF's tuned wording), so the mapping works from the tool list alone.
  assert.match(TOOL_DESCRIPTIONS.show_portrait, /What did Nikola Tesla look\s+like\?/);
  assert.match(TOOL_DESCRIPTIONS.show_terrain, /What is the terrain of Scotland like\?/);
  assert.match(TOOL_DESCRIPTIONS.show_form(), /What does Orion look like\?.*Show me the yin-yang/);
  assert.match(TOOL_DESCRIPTIONS.show_clock, /what time it is/);
  assert.match(TOOL_DESCRIPTIONS.set_body_form, /take a human form/);
  assert.match(TOOL_DESCRIPTIONS.show_form(), /astronomy\.orion/);
});

test("responding: once, immediately before the final answer", () => {
  assert.match(skill.body, /`\{ "state": "responding" \}` \*\*once, immediately before\*\* the final reply/);
  assert.match(skill.body, /Do not call\s+it per sentence/);
});

test("the skill asks for restraint, privacy in lookups and honesty about host capabilities", () => {
  assert.match(skill.body, /Do \*\*not\*\* call `set_presence_state` for those/);
  assert.match(skill.body, /Never claim Aion is fullscreen, or embedded, unless the result\s+says so/);
  assert.match(skill.body, /Never dump terminal output/);
  assert.match(skill.body, /Do not call Aion tools for internal steps/);
  assert.match(skill.body, /most\s+replies need none/);
  assert.match(skill.body, /never put code, file contents or personal data in a query/);
  assert.match(skill.body, /Aion uses Codex lifecycle hooks only\s+to reflect states such as reading, editing, testing and building/);
});
