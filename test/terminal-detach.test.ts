import { expect, test } from "bun:test";
import { inspectSavedTerminal, type CommandResult, type CommandRunner, type TerminalBinding } from "../src/cli/terminal-recovery.ts";

const launch = { packageEntrypoint: "/fixture/main.js", command: "recorded immutable session command", argv: [], env: {} };
const binding: TerminalBinding = { peer: "pi", handle: "term-saved", incarnationId: "inc-saved", worktreeId: "work-saved", projectRoot: "/fixture/project", sessionId: "session-saved", sessionFile: "/fixture/pi-session.jsonl", launch, launchMetadata: launch };
const terminal = (patch: Record<string, unknown> = {}) => ({ handle: binding.handle, incarnationId: binding.incarnationId, worktreeId: binding.worktreeId, worktreePath: binding.projectRoot, connected: true, orphaned: false, ...patch });
const ok = (result: unknown): CommandResult => ({ status: 0, result: { ok: true, result } });
const stale = (stderr = false): CommandResult => ({ status: 1, [stderr ? "stderr" : "stdout"]: JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }) });
function fixture(show: CommandResult | (() => never), inventory: CommandResult = ok({ terminals: [] })) {
  const calls: readonly string[][] = [];
  const runner: CommandRunner = async argv => {
    (calls as string[][]).push([...argv]);
    if (argv[1] === "show") return typeof show === "function" ? show() : show;
    if (argv[1] === "list") return inventory;
    throw new Error("unexpected terminal mutation");
  };
  return { calls, inspect: () => inspectSavedTerminal(binding, { runner, orcaExecutable: "never-executed" }) };
}

test("#463 exact saved terminal distinguishes present, positively orphaned and disconnected-only unknown", async () => {
  expect((await fixture(ok({ terminal: terminal() })).inspect()).state).toBe("present");
  expect((await fixture(ok({ terminal: terminal({ orphaned: true, connected: false }) })).inspect()).state).toBe("orphaned");
  expect((await fixture(ok({ terminal: terminal({ connected: false }) })).inspect()).state).toBe("unknown");
});

test("#463 orphaned flag never overrides a changed terminal identity", async () => {
  for (const patch of [{ handle: "term-replacement" }, { incarnationId: "inc-replacement" }, { worktreeId: "work-replacement" }, { worktreePath: "/different/project" }]) {
    const f = fixture(ok({ terminal: terminal({ ...patch, orphaned: true }) }));
    expect((await f.inspect()).state).toBe("changed");
    expect(f.calls).toHaveLength(1);
  }
});

test("#463 typed stale handles prove missing only through a complete empty inventory", async () => {
  for (const stderr of [false, true]) {
    const f = fixture(stale(stderr));
    expect((await f.inspect()).state).toBe("missing");
    expect(f.calls.map(argv => argv[1])).toEqual(["show", "list"]);
  }
});

test("#463 stale handle with a retained handle or incarnation is never missing", async () => {
  for (const entry of [terminal({ incarnationId: "new-incarnation" }), terminal({ handle: "renamed-handle" }), terminal()]) {
    expect((await fixture(stale(), ok({ terminals: [entry] })).inspect()).state).not.toBe("missing");
  }
});

test("#463 missing classification refuses truncated, malformed or duplicate terminal inventories", async () => {
  for (const inventory of [
    ok({ terminals: [], truncated: true }), ok({}), ok({ terminals: "unreadable" }), ok({ terminals: [null] }),
    ok({ terminals: [{}] }), ok({ terminals: [terminal({ handle: "unrelated", incarnationId: "other-inc" }), terminal({ handle: "unrelated", incarnationId: "duplicate-inc" })] }),
    ok({ terminals: [terminal({ handle: "other-a", incarnationId: "duplicated" }), terminal({ handle: "other-b", incarnationId: "duplicated" })] }),
    { status: 0, stdout: "not JSON" }, { status: 1, stderr: "permission denied" },
  ]) expect((await fixture(stale(), inventory).inspect()).state).toBe("unknown");
});

test("#463 ordinary command failures and malformed show metadata are unknown, never proof of a closed terminal", async () => {
  for (const show of [
    { status: 1, stderr: "permission denied" }, { status: 1, stdout: "missing terminal" }, { status: 0, stdout: "not JSON" },
    ok({}), ok({ terminal: {} }), ok({ terminal: terminal({ incarnationId: undefined }) }),
    () => { throw new Error("terminal command timed out; private diagnostic"); },
  ]) {
    const f = fixture(show);
    const result = await f.inspect();
    expect(result.state).toBe("unknown"); expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  }
});

test("#463 saved-terminal evidence inspection performs read-only commands and preserves its binding", async () => {
  const before = JSON.stringify(binding), f = fixture(stale(), ok({ terminals: [terminal({ handle: "unrelated", incarnationId: "unrelated-inc" })] }));
  expect((await f.inspect()).state).toBe("missing");
  expect(f.calls.map(argv => [...argv])).toEqual([["terminal", "show", "--terminal", binding.handle, "--json"], ["terminal", "list", "--json"]]);
  expect(JSON.stringify(binding)).toBe(before);
});
