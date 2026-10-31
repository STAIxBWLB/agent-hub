import { expect, test } from "bun:test";
import { autonomyPreset } from "../src/hub/autonomy.ts";
import { autonomyEnvironment, runAutonomy } from "../src/cli/autonomy.ts";

test("one person confirmation follows the concrete preview; refusal writes nothing", async () => {
  const calls: string[] = [], printed: string[] = [];
  const ports = { environment: "terminal", print: (line: string) => printed.push(line), ask: async () => { expect(printed).toContain("permission_modes.codex: never-ask (next peer start)"); return "n"; }, request: async (message: Record<string, unknown>) => { calls.push(String(message.action)); return { ok: true, confirmation: "preview-token", lines: ["permission_modes.codex: never-ask (next peer start)"] }; } };
  await runAutonomy(["on"], ports);
  expect(calls).toEqual(["preview"]);
  ports.ask = async () => "y";
  await runAutonomy(["on"], ports);
  expect(calls).toEqual(["preview", "preview", "on"]);
});

test("--yes is one explicit on confirmation, not a generic flag accepted on off or status", async () => {
  const calls: Record<string, unknown>[] = [];
  const ports = { environment: "headless", print: () => {}, ask: async () => { throw new Error("unexpected ask"); }, request: async (message: Record<string, unknown>) => { calls.push(message); return { ok: true, confirmation: "preview-token" }; } };
  await runAutonomy(["on", "--yes"], ports);
  expect(calls.map(call => call.action)).toEqual(["preview", "on"]);
  expect(calls[1]!.confirmed).toBe(true);
  expect(calls[1]!.confirmation).toBe("preview-token");
  expect(await runAutonomy(["off", "--yes"], ports)).toContain("usage:");
  expect(await runAutonomy(["on", "--all-projects"], ports)).toContain("usage:");
});

test("status JSON and current environment are explicit; default output is readable lines", async () => {
  const printed: string[] = [];
  const ports = { environment: "orca", print: (line: string) => printed.push(line), ask: async () => null, request: async () => ({ ok: true, status: { environment: "orca", peers: [] }, lines: ["Project autonomy, environment: orca"] }) };
  await runAutonomy(["status"], ports);
  expect(printed).toEqual(["Project autonomy, environment: orca"]);
  await runAutonomy(["status", "--json"], ports);
  expect(JSON.parse(printed[1]!)).toEqual({ environment: "orca", peers: [] });
  expect(autonomyEnvironment({ ORCA_WORKTREE_ID: "x", CI: "1" }, true)).toBe("orca");
  expect(autonomyEnvironment({ CI: "1" }, false)).toBe("ci");
  expect(autonomyEnvironment({}, false)).toBe("headless");
});

test("new environment detection is preset data rather than a native-name branch", () => {
  const preset = structuredClone(autonomyPreset());
  preset.environments.remote = { ...preset.environments.headless, aliases: [], detect: { priority: 20, variable: "REMOTE_EXECUTION" } };
  for (const kind of Object.values(preset.kinds)) kind.start.remote = kind.start.headless;
  expect(autonomyEnvironment({ REMOTE_EXECUTION: "1" }, false, preset)).toBe("remote");
});
