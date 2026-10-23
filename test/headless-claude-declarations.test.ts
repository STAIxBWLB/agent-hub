import { expect, test } from "bun:test";
import { assertDefinitionCoherence, assertNativeCapabilityScope, createProjectAdapterCatalog, definitionOf, type AdapterDefinition } from "../src/adapters/registry.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { instanceLaunchArguments } from "../src/cli/launch.ts";
import { runClaudeEntry } from "../src/adapters/definitions/native-cli-entry-claude.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";

const writer = { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/claude-worker" };
const validate = (entry: unknown) => validateInstances({ "claude-worker": entry }, createProjectAdapterCatalog());

test("#525 headless Claude declaration selects only the owned writer variant and preserves terminal/reviewer forms", () => {
  const base = definitionOf("claude")!;
  for (const roles of [["implementer"], ["implementer", "verifier"]]) for (const permission_mode of [undefined, "ask", "ask-when-needed"]) {
    const instances = validate({ ...writer, roles, ...(permission_mode ? { permission_mode } : {}) });
    const selected = definitionOf("claude-worker", instances)!;
    expect(selected).toBe(base.headlessVariant!);
    expect(selected.transport).toBe("hub-native");
    expect(selected.identity.mcp).toBe("env");
    expect(selected.start.daemonPort).toBe("claude-implementer");
    expect(selected.session.freshOnRestore).toBe(false);
    expect(selected.session.launchRecord).toBeUndefined();
    expect(selected.budget?.account).toBe("claude");
  }
  expect(definitionOf("claude")).toBe(base);
  const { start_mode: _start, ...terminal } = writer;
  expect(definitionOf("claude-worker", validate(terminal))).toBe(base);
  const review = validate({ kind: "claude", roles: ["reviewer"], start_mode: "headless" });
  expect(definitionOf("claude-worker", review)).toBe(base.reviewerVariant!);
  expect(base.reviewerVariant!.session.freshOnRestore).toBe(true);
});

test("#525 headless Claude refuses missing roots, never-ask, planner and reviewer mixtures", () => {
  const { worktree: _worktree, ...missingRoot } = writer;
  expect(() => validate(missingRoot)).toThrow("needs its own worktree");
  expect(() => validate({ ...writer, permission_mode: "never-ask" })).toThrow("permits only ask or ask-when-needed");
  for (const roles of [["implementer", "planner"], ["implementer", "reviewer"], ["verifier"], ["planner"]]) {
    expect(() => validate({ ...writer, roles })).toThrow();
  }
  expect(() => validate({ ...writer, review_mode: "fresh" })).toThrow("fresh requires reviewer-only");
});

test("#525 headless writer capabilities cannot be claimed by external or configured definitions", () => {
  const base = definitionOf("claude")!, variant = base.headlessVariant!;
  expect(() => assertDefinitionCoherence(variant)).not.toThrow();
  expect(() => assertNativeCapabilityScope(variant)).not.toThrow();
  const foreign = { ...base, headlessVariant: variant } as AdapterDefinition;
  expect(() => assertNativeCapabilityScope(foreign)).toThrow("restricted to fixed builtin");
  const foreignPort = { ...variant, kind: "fixture" } as AdapterDefinition;
  expect(() => assertNativeCapabilityScope(foreignPort)).toThrow("claude-implementer");
  expect(() => assertDefinitionCoherence({ ...base, headlessVariant: base })).toThrow("headless hub-native factory");
});

test("#525 ahub claude headless writer is a hub start with no native launch arguments", () => {
  const instances = validate(writer);
  expect(instanceLaunchArguments("claude", ["--as", "claude-worker"], instances)).toEqual({ instance: "claude-worker", args: [], hubStarted: true });
  expect(instanceLaunchArguments("claude", ["--as=claude-worker", "--print-command"], instances).hubStarted).toBe(true);
  expect(() => instanceLaunchArguments("claude", ["--as", "claude-worker", "--continue"], instances)).toThrow("headless implementer the hub runs per task");
  const reviewers = validate({ kind: "claude", roles: ["reviewer"], start_mode: "headless" });
  expect(() => instanceLaunchArguments("claude", ["--as", "claude-worker", "--continue"], reviewers)).toThrow("headless reviewer the hub runs per review");
});

test("#525 native Claude entry starts the hub writer without touching terminal helpers", async () => {
  const instances = validate(writer), requests: unknown[] = [], output: unknown[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { output.push(...values); };
  try {
    await runClaudeEntry({ instance: "claude-worker", hubStarted: true, args: [], projectConfig: () => ({ instances }), definition: definitionOf("claude-worker", instances),
      connect: async () => ({ request: async (input: unknown) => { requests.push(input); return (input as { t: string }).t === "status" ? { status: {} } : { ok: true }; }, close: () => {} }),
      fail: (message: string) => { throw new Error(message); }, helpers: new Proxy({}, { get: () => { throw new Error("terminal path touched"); } }),
    } as unknown as NativeCliEntryContext);
  } finally { console.log = original; }
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ t: "start", peer: "claude-worker" });
  expect(output.join(" ")).toContain("headless implementer the hub runs per task");
});
