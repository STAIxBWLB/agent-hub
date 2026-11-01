import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IMPLEMENTER_HUB_TOOL_NAMES, STUDY_TOOLS, TASK_TOOL_NAMES, TASK_TOOLS, projectToolList } from "../src/hub/hub-tools.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

// #601: the guidance an agent reads must name only tools that exist, and no tool or role text may let an agent approve a campaign.
const roles = readdirSync("templates/roles/research").map(name => ({ name, text: readFileSync(join("templates/roles/research", name), "utf8") }));
const profile = JSON.parse(readFileSync("templates/profiles/research.json", "utf8")) as { role_text: Record<string, string> };
const guidance = [...roles.map(role => role.text), ...Object.values(profile.role_text)].join("\n");

test("every hub_study_* name in the research guidance is a published tool", () => {
  const named = new Set(guidance.match(/hub_study_[a-z_]+/g) ?? []);
  expect(named.size).toBeGreaterThan(0);
  for (const name of named) { expect(TASK_TOOL_NAMES.has(name), `${name} is not a published tool`).toBe(true); expect(STUDY_TOOLS.has(name)).toBe(true); }
  for (const name of STUDY_TOOLS) expect(TASK_TOOLS.some(tool => tool.name === name)).toBe(true);
});

test("no study tool approves, closes or attests, and the guidance says only the person approves", () => {
  for (const tool of TASK_TOOLS.filter(tool => STUDY_TOOLS.has(tool.name))) expect(tool.name).not.toMatch(/approve|close|attest/);
  expect(TASK_TOOLS.some(tool => /^hub_study_(approve|close)/.test(tool.name))).toBe(false);
  expect(guidance.toLowerCase()).toContain("only the person approves");
  expect(guidance).not.toMatch(/hub_study_approve|hub_study_close/);
});

test("who may call which tool: a read-only project keeps show only, and an implementer child gets show and handoff, never draft or revise", () => {
  const names = (list: { name: string }[]) => list.filter(tool => STUDY_TOOLS.has(tool.name)).map(tool => tool.name).sort();
  expect(names(projectToolList(TASK_TOOLS, true))).toEqual(["hub_study_show"]);
  expect(names(projectToolList(TASK_TOOLS, false))).toEqual([...STUDY_TOOLS].sort());
  expect(IMPLEMENTER_HUB_TOOL_NAMES.filter(name => STUDY_TOOLS.has(name)).sort()).toEqual(["hub_study_handoff", "hub_study_show"]);
});

test("the shell: a campaign may be read from an agent shell, never approved, closed, drafted or revised", () => {
  expect(classifyPeerCommand("study", ["show", "rc-0123456789ab"])).toBe("allowed");
  for (const sub of ["approve", "close", "draft", "revise"]) expect(classifyPeerCommand("study", [sub, "rc-0123456789ab", "1"])).toBe("console");
});
