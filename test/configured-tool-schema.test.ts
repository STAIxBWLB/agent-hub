import { expect, test } from "bun:test";
import { CONDUCTOR_TOOLS, TASK_TOOLS, configuredToolContext, projectConductorTools, projectToolList } from "../src/hub/hub-tools.ts";

const targets = (tools: typeof CONDUCTOR_TOOLS) => (tools.find(tool => tool.name === "hub_peer_start")!.inputSchema.properties.peer as { enum: string[] }).enum;

test("configured conductor schemas are project-local and never mutate the builtin catalog", () => {
  const before = structuredClone(CONDUCTOR_TOOLS), first = projectConductorTools(["fixture", "fixture-second"]), second = projectConductorTools(["other"]);
  expect(targets(first)).toEqual([...targets(CONDUCTOR_TOOLS), "fixture", "fixture-second"]);
  expect(targets(second)).toEqual([...targets(CONDUCTOR_TOOLS), "other"]);
  expect(targets(second)).not.toContain("fixture"); expect(CONDUCTOR_TOOLS).toEqual(before);
  for (const tool of CONDUCTOR_TOOLS) if (tool.name !== "hub_peer_start") expect(first.find(row => row.name === tool.name)).toBe(tool);
  expect(projectConductorTools()).toBe(CONDUCTOR_TOOLS);
  expect(targets(projectConductorTools(targets(CONDUCTOR_TOOLS)))).toEqual(targets(CONDUCTOR_TOOLS));
});

test("malformed or excessive project target metadata cannot add native ids", () => {
  for (const value of [null, "fixture", ["user"], ["fixture", "fixture"], ["bad id"], Array(257).fill("fixture")]) expect(projectConductorTools(value)).toBe(CONDUCTOR_TOOLS);
});

test("ordinary project publication context and full tool-list identity remain unchanged", () => {
  for (const status of [{}, { configuredAdapters: [] }, { startablePeers: ["fixture"], readOnlyPeers: ["fixture-check"] }]) expect(configuredToolContext(status, "fixture-check")).toEqual({});
  const tools = [...TASK_TOOLS, ...CONDUCTOR_TOOLS];
  expect(projectToolList(tools)).toBe(tools); expect(projectToolList(tools, false)).toBe(tools);
});

test("configured read-only publication exposes only communication, reads and review", () => {
  const status = { configuredAdapters: ["fixture"], startablePeers: ["fixture", "fixture-check"], readOnlyPeers: ["fixture-check"] };
  const context = configuredToolContext(status, "fixture-check");
  expect(context).toEqual({ startPeers: ["fixture", "fixture-check"], readOnly: true });
  expect(configuredToolContext(status, "fixture")).toEqual({ startPeers: ["fixture", "fixture-check"], readOnly: false });
  const names = ["hub_send", "hub_inbox", "hub_delivery_done", "hub_review", "hub_task_show", "hub_task_list", "hub_memory_search", "hub_memory_show", "hub_memory_graph", "hub_status"];
  const tools = [...names, "hub_task_done", "hub_task_accept", "hub_task_propose", "hub_remember", "hub_peer_start", "hub_task_assign"].map(name => ({ name }));
  expect(projectToolList(tools, context.readOnly).map(tool => tool.name)).toEqual(names);
  expect(tools).toHaveLength(names.length + 6);
});

test("incomplete configured-project metadata withholds writes and never invents extra start targets", () => {
  for (const status of [
    { configuredAdapters: ["fixture"] },
    { configuredAdapters: ["fixture"], startablePeers: ["bad id"], readOnlyPeers: [] },
    { configuredAdapters: ["fixture"], startablePeers: ["fixture"], readOnlyPeers: "fixture-check" },
  ]) expect(configuredToolContext(status, "fixture-check")).toEqual({ readOnly: true });
});
