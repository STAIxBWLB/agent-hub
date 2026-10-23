import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, type ToolContext, type ToolApproval } from "../src/local/tools.ts";
import { realPath } from "../src/hub/project.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-action-args-"))); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "existing.txt"), "before\n");
  const controller = new AbortController(), calls: unknown[][] = [];
  const ctx: ToolContext = { cwd, deny: [], sandboxProfile: "unused: every process operation is denied", signal: controller.signal,
    permit: async (...args) => { calls.push(args); return false; }, send: () => "unused" };
  return { cwd, ctx, calls, signal: controller.signal };
}

for (const [name, args] of [
  ["write", { path: "new.txt", content: "whole content", extra: { marker: "whole parsed input" } }],
  ["edit", { path: "existing.txt", old: "before", new: "after" }],
  ["bash", { command: "printf ran > command-marker", timeout_s: 1 }],
  ["git", { args: ["branch", "--delete", "fixture"] }],
] as const) test(`local ${name} gives the host the complete parsed call before its effect`, async () => {
  const f = fixture(), result = await runTool(name, JSON.stringify(args), f.ctx);
  expect(result).toContain("did not approve"); expect(f.calls).toHaveLength(1);
  const call = f.calls[0]!;
  expect(call[1]).toBe(name); expect(call[2]).toBe(f.signal); expect(call[6]).toEqual(args);
  if (name === "write" || name === "edit") { expect(call[3]).toBe(join(f.cwd, args.path)); expect(call[5]).toBe(args.path); }
  else { expect(call[3]).toBeUndefined(); expect(call[5]).toBeUndefined(); }
  expect(existsSync(join(f.cwd, "new.txt"))).toBe(false);
  expect(existsSync(join(f.cwd, "command-marker"))).toBe(false);
  expect(readFileSync(join(f.cwd, "existing.txt"), "utf8")).toBe("before\n");
});

test("legacy permit callbacks need no new argument handling and still authorize a guarded file write", async () => {
  const f = fixture(); f.ctx.permit = async () => true;
  expect(await runTool("write", JSON.stringify({ path: "legacy.txt", content: "legacy works" }), f.ctx)).toBe("wrote legacy.txt");
  expect(readFileSync(join(f.cwd, "legacy.txt"), "utf8")).toBe("legacy works");
});

for (const picked of [false, "expired", "aborted"] as const) test(`raw-argument forwarding cannot turn ${picked} into a truthy file authorization`, async () => {
  const f = fixture(); f.ctx.permit = async (...args): Promise<ToolApproval> => { expect(args[6]).toEqual({ path: "existing.txt", content: "changed" }); return picked; };
  expect(await runTool("write", JSON.stringify({ path: "existing.txt", content: "changed" }), f.ctx)).toContain("error:");
  expect(readFileSync(join(f.cwd, "existing.txt"), "utf8")).toBe("before\n");
});
