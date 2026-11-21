import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, type ToolContext } from "../src/local/tools.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

test("host guard sees full reads and can refuse before file mutation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "edit-guard-"));
  try {
    const file = join(cwd, "a.txt"); writeFileSync(file, "before\n");
    const reads: boolean[] = [];
    const ctx: ToolContext = { cwd, deny: [], sandboxProfile: "", permit: async () => true, send: () => "sent",
      editGuard: { read: (_file, _bytes, full) => { reads.push(full); }, write: () => { throw new PreEffectToolRefusal("stale; re-read"); }, written: () => {}, shell: () => undefined } };
    expect(await runTool("read", JSON.stringify({ path: "a.txt" }), ctx)).toContain("before");
    expect(reads).toEqual([true]);
    expect(await runTool("write", JSON.stringify({ path: "a.txt", content: "after" }), ctx)).toContain("stale; re-read");
    expect(readFileSync(file, "utf8")).toBe("before\n");
    await runTool("read", JSON.stringify({ path: "a.txt", limit: 1 }), ctx);
    expect(reads).toEqual([true, false]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("route and OCC guards refuse only their admitted pre-effect cases", async () => {
  const { editGuard } = await import("../src/hub/edit-guard.ts");
  const cwd = mkdtempSync(join(tmpdir(), "edit-guard-facts-"));
  try {
    const file = join(cwd, "a.txt"); writeFileSync(file, "before\n");
    let receipt: { sha256: string; scope: "full" | "partial"; turnId: string; ownerEpoch?: string } | undefined;
    const facts = { recordRead: (_peer: string, _task: number, _path: string, row: typeof receipt) => { receipt = row; }, readReceipt: () => receipt };
    let arm: "baseline" | "route_guard" | "occ_guard" = "baseline", live = true;
    const guard = editGuard({ root: cwd, peer: "local", task: 1, turn: "one", ownerEpoch: "owner-1", arm: () => arm, current: () => live, facts: facts as never });
    guard.write(file); guard.shell("echo x > a.txt");
    arm = "route_guard";
    expect(() => guard.shell("echo x > a.txt")).toThrow("shell write refused");
    guard.shell("python -c 'open(\"a.txt\",\"w\").write(\"x\")'");
    arm = "occ_guard";
    expect(() => guard.write(file)).toThrow("blind or stale");
    guard.read(file, readFileSync(file), true); guard.write(file);
    const nextOwner = editGuard({ root: cwd, peer: "local", task: 1, turn: "two", ownerEpoch: "owner-2", arm: () => arm, current: () => live, facts: facts as never });
    expect(() => nextOwner.write(file)).toThrow("blind or stale");
    writeFileSync(file, "changed\n");
    expect(() => guard.write(file)).toThrow("current sha256");
    live = false; expect(() => guard.read(file, Buffer.from("changed\n"), true)).toThrow("authority changed");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a new native session does not inherit read receipts", async () => {
  const { Facts } = await import("../src/hub/facts.ts");
  const cwd = mkdtempSync(join(tmpdir(), "edit-guard-session-"));
  try {
    const facts = new Facts({ root: cwd, tmp: join(cwd, "tmp"), instance: "test", scope: () => undefined, peers: () => [], nameable: () => true });
    facts.session("local", "first");
    facts.recordRead("local", 1, "a.txt", { sha256: "a".repeat(64), scope: "full", turnId: "turn" });
    facts.session("local", "second");
    expect(facts.readReceipt("local", 1, "a.txt")).toBeUndefined();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("host shell guard refuses before starting a classified command", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "edit-guard-shell-"));
  try {
    const file = join(cwd, "a.txt"); writeFileSync(file, "before");
    const ctx: ToolContext = { cwd, deny: [], sandboxProfile: "", permit: async () => true, send: () => "sent",
      editGuard: { read: () => {}, write: () => undefined, written: () => {}, shell: () => { throw new PreEffectToolRefusal("shell write refused"); } } };
    expect(await runTool("bash", JSON.stringify({ command: "echo after > a.txt" }), ctx)).toContain("shell write refused");
    expect(readFileSync(file, "utf8")).toBe("before");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("edit governance configuration is closed and opt-in", async () => {
  const { parseEditGovernance } = await import("../src/hub/edit-guard.ts");
  const { DEFAULT_CONFIG } = await import("../src/hub/daemon.ts");
  expect(DEFAULT_CONFIG.edit_governance?.arm).toBe("baseline");
  expect(parseEditGovernance({ arm: "occ_guard" })).toEqual({ arm: "occ_guard" });
  expect(() => parseEditGovernance({ arm: "occ_guard", extra: true })).toThrow();
  expect(() => parseEditGovernance({ arm: "unknown" })).toThrow();
});

test("edit enforcement is ignored in tracked config and accepted in untracked local config", async () => {
  const { loadConfig } = await import("../src/hub/daemon.ts");
  const { mkdirSync } = await import("node:fs");
  const cwd = mkdtempSync(join(tmpdir(), "edit-guard-config-"));
  try {
    expect(Bun.spawnSync(["git", "-C", cwd, "init", "-q"]).exitCode).toBe(0);
    mkdirSync(join(cwd, ".agenthub"));
    const value = JSON.stringify({ edit_governance: { arm: "route_guard" } });
    writeFileSync(join(cwd, ".agenthub", "config.json"), value);
    expect(Bun.spawnSync(["git", "-C", cwd, "add", "-f", ".agenthub/config.json"]).exitCode).toBe(0);
    expect(loadConfig(cwd).edit_governance?.arm).toBe("baseline");
    writeFileSync(join(cwd, ".agenthub", "config.local.json"), value);
    expect(loadConfig(cwd).edit_governance?.arm).toBe("route_guard");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
