import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSkills } from "../scripts/lib/pluginPackage";
import { AION_IDENTITY } from "../src/core/identity";
import { TOOL_NAMES } from "../src/host/mcp/server";
import { ACTIVITY_STATES } from "../src/core/state";

const skill = discoverSkills().find(item => item.name === "aion-presence")!;

test("the Aion Presence skill is discoverable with a trigger-oriented description", () => {
  assert.ok(skill, "skills/aion-presence/SKILL.md");
  assert.equal(skill.dir, "aion-presence");
  assert.ok(skill.description.length >= 80 && skill.description.length <= 1024);
  assert.match(skill.description, /open, see or talk to Aion/);
  assert.match(skill.description, /not another AI model/);
});

test("the skill teaches that Codex is the intelligence and Aion is its body", () => {
  assert.match(skill.body, /\*\*you, the Codex agent\*\*/);
  assert.match(skill.body, /not\*\* a second AI, assistant or personality/);
  assert.match(skill.body, /no model calls and needs no API key/);
  assert.match(skill.body, /never try to start a microphone or voice session/);
});

test("the skill states the canonical identity facts exactly", () => {
  for (const fact of [AION_IDENTITY.name, AION_IDENTITY.product, AION_IDENTITY.creatorCompany, AION_IDENTITY.leadCreator]) {
    assert.ok(skill.body.includes(fact), fact);
  }
});

test("the skill only names tools and states that exist", () => {
  const named = new Set([...skill.body.matchAll(/`([a-z_]+)`/g)].map(match => match[1]).filter(name => /_/.test(name) && !name.startsWith("window_")));
  for (const name of named) assert.ok((TOOL_NAMES as readonly string[]).includes(name), `${name} is a real tool`);
  for (const name of ["open_presence", "set_presence_state", "show_result", "show_image", "show_artifact", "show_visual_form", "set_body_form", "show_text", "clear_presentation"]) {
    assert.ok(named.has(name), `${name} is taught`);
  }
  const states = [...skill.body.matchAll(/`(idle|listening|thinking|working|reading|editing|testing|building|presenting|complete|error|[a-z]+ing)`/g)].map(match => match[1]);
  for (const state of states) assert.ok((ACTIVITY_STATES as readonly string[]).includes(state), `${state} is a real state`);
});

test("the skill asks for restraint and honesty about host capabilities", () => {
  assert.match(skill.body, /Do \*\*not\*\* call `set_presence_state` for those/);
  assert.match(skill.body, /Never claim Aion is fullscreen, or embedded, unless the result\s+says so/);
  assert.match(skill.body, /Never dump terminal output/);
  assert.match(skill.body, /Do not call Aion tools for internal steps/);
});
