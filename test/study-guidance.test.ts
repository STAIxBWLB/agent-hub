import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IMPLEMENTER_HUB_TOOL_NAMES, STUDY_TOOLS, TASK_TOOL_NAMES, TASK_TOOLS, profileTaskTools, projectToolList } from "../src/hub/hub-tools.ts";
import { PROFILE_NAMES } from "../src/hub/profiles.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";

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

test("who may call which tool: a read-only project keeps show only, and an implementer child can record metadata but never draft or revise", () => {
  const names = (list: { name: string }[]) => list.filter(tool => STUDY_TOOLS.has(tool.name)).map(tool => tool.name).sort();
  // #615: owner-bound experiment metadata is an implementer write; campaign draft/revise remain planner-only, and read-only projects keep only show.
  expect(names(projectToolList(TASK_TOOLS, true))).toEqual(["hub_experiment_show", "hub_study_show"]);
  expect(names(projectToolList(TASK_TOOLS, false))).toEqual([...STUDY_TOOLS].sort());
  expect(IMPLEMENTER_HUB_TOOL_NAMES.filter(name => STUDY_TOOLS.has(name)).sort()).toEqual(["hub_experiment_record", "hub_experiment_show", "hub_study_handoff", "hub_study_show"]);
  for (const writer of ["hub_study_draft", "hub_study_revise"]) {
    expect(names(projectToolList(TASK_TOOLS, true))).not.toContain(writer);
    expect(IMPLEMENTER_HUB_TOOL_NAMES).not.toContain(writer);
  }
});

test("the shell: a campaign may be read from an agent shell, never approved, closed, drafted or revised", () => {
  expect(classifyPeerCommand("study", ["show", "rc-0123456789ab"])).toBe("allowed");
  for (const sub of ["approve", "close", "draft", "revise"]) expect(classifyPeerCommand("study", [sub, "rc-0123456789ab", "1"])).toBe("console");
  // #602: the experiments readback is a read too, in exactly its three closed forms; a stray flag or a mix is not an allowed read.
  expect(classifyPeerCommand("study", ["experiments", "--campaign", "rc-0123456789ab"])).toBe("allowed");
  expect(classifyPeerCommand("study", ["experiments", "--attempt", "ra-0123456789ab", "--json"])).toBe("allowed");
  expect(classifyPeerCommand("study", ["experiments", "--evil", "x"])).not.toBe("allowed");
  // a delegated live test (an agent borrowing the console) may read experiments, and still none of the person's study verdicts
  expect(liveTestRefusal("study", ["experiments", "--campaign", "rc-0123456789ab"])).toBe(false);
  for (const sub of ["approve", "close", "draft", "revise"]) expect(liveTestRefusal("study", [sub, "rc-0123456789ab", "1"])).toBe(true);
});


test("#615 experiment recording publishes the existing inert five-kind Tasks envelope without execution fields", () => {
  const matches = TASK_TOOLS.filter(tool => tool.name === "hub_experiment_record");
  expect(matches).toHaveLength(1);
  const tool = matches[0]!, schema = tool.inputSchema, kind = schema.properties.kind as { type: string; enum: string[] };
  expect(TASK_TOOL_NAMES.has(tool.name)).toBe(true); expect(STUDY_TOOLS.has(tool.name)).toBe(true);
  expect(IMPLEMENTER_HUB_TOOL_NAMES).toContain(tool.name);
  expect(projectToolList(TASK_TOOLS, false)).toContain(tool);
  expect(projectToolList(TASK_TOOLS, true).some(row => row.name === tool.name)).toBe(false);
  expect(schema.type).toBe("object"); expect(schema.required).toEqual(["kind"]); expect(schema.additionalProperties).toBe(false);
  expect(kind.type).toBe("string"); expect([...kind.enum].sort()).toEqual(["attempt", "event", "plan", "protocol", "receipt"]);
  expect(Object.keys(schema.properties).sort()).toEqual(["attempt", "attemptId", "event", "idempotencyKey", "kind", "plan", "protocol", "receipt", "signature", "taskId"]);
  for (const payload of ["protocol", "attempt", "event", "plan", "receipt"]) expect(schema.properties[payload], payload).toEqual({ type: "object" });
  expect(schema.properties.signature).toEqual({ type: "string" });
});

for (const profile of PROFILE_NAMES) {
  test(`#615 ${profile} profile preserves experiment protocol/plan/receipt schemas instead of substituting task-plan keys`, () => {
    const base = TASK_TOOLS.find(tool => tool.name === "hub_experiment_record")!;
    for (const tools of [profileTaskTools(profile), profileTaskTools(profile, ["intent", "build", "review"], true)]) {
      const tool = tools.find(row => row.name === base.name)!;
      expect(tool.inputSchema).toEqual(base.inputSchema);
      expect(tool.inputSchema.properties.plan).toEqual({ type: "object" });
      expect(projectToolList(tools, true).some(row => row.name === base.name)).toBe(false);
    }
  });
}
