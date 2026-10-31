import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaudeProfileHook, installClaudeProfileHook, claudeProfileHookTarget, runClaudeProfileHook } from "../src/cli/claude-profile-hook.ts";
import type { ClaudeHome } from "../src/cli/claude-homes.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const options = { script: "/fixture/package/claude-profile-hook.ts", runtime: "/fixture/bun" };
function fixture(create = true) {
  const root = mkdtempSync(join(tmpdir(), "ahub-profile-hook-")); roots.push(root);
  const home: ClaudeHome = { path: join(root, "selected-home"), exists: create, sources: ["environment"] };
  if (create) mkdirSync(home.path, { mode: 0o700 });
  const file = join(home.path, "settings.json");
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  return { root, home, file, write, read };
}

test("profile installation preserves unrelated hooks and statusLine, writes0600 and is idempotent", () => {
  const f = fixture(), caller = { matcher: "Read", hooks: [{ type: "command", command: "caller-hook" }] };
  const before = { statusLine: { type: "command", command: "caller-status" }, hooks: { PreToolUse: [caller], Stop: [{ hooks: [{ type: "command", command: "caller-stop" }] }] }, permissions: { defaultMode: "default" } };
  f.write(before);
  const contents = readFileSync(f.file, "utf8"), listing = readdirSync(f.home.path);
  expect(checkClaudeProfileHook(f.home, options).state).toBe("missing");
  expect(readFileSync(f.file, "utf8")).toBe(contents);
  expect(readdirSync(f.home.path)).toEqual(listing);
  expect(installClaudeProfileHook(f.home, options)).toMatchObject({ state: "installed", changed: true });
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  const written = f.read();
  expect(written.statusLine).toEqual(before.statusLine);
  expect(written.permissions).toEqual(before.permissions);
  expect(written.hooks.Stop).toEqual(before.hooks.Stop);
  expect(written.hooks.PreToolUse[0]).toEqual(caller);
  expect(written.hooks.PreToolUse[1]).toEqual({ matcher: "*", hooks: [{ type: "command", command: "'/fixture/bun' '/fixture/package/claude-profile-hook.ts' --run", timeout: 5 }] });
  expect(checkClaudeProfileHook(f.home, options)).toMatchObject({ state: "installed", reason: expect.stringContaining("does not prove live") });
  expect(installClaudeProfileHook(f.home, options)).toMatchObject({ state: "installed", changed: false });
  expect(readdirSync(f.home.path)).toEqual(["settings.json"]);
});

test("only exact managed entries are normalized, preserving other wildcard hook commands", () => {
  const f = fixture();
  installClaudeProfileHook(f.home, options);
  const written = f.read(), managed = written.hooks.PreToolUse[0];
  const other = { matcher: "*", hooks: [{ type: "command", command: "another-script --run", timeout: 5 }] };
  written.hooks.PreToolUse = [managed, other, { hooks: managed.hooks, matcher: "*" }];
  f.write(written);
  expect(checkClaudeProfileHook(f.home, options).state).toBe("missing");
  expect(installClaudeProfileHook(f.home, options)).toMatchObject({ state: "installed", changed: true });
  expect(f.read().hooks.PreToolUse).toEqual([other, managed]);
});

test("an explicitly selected missing home is the only directory created", () => {
  const f = fixture(false);
  expect(checkClaudeProfileHook(f.home, options).state).toBe("missing");
  expect(existsSync(f.home.path)).toBe(false);
  expect(installClaudeProfileHook(f.home, options)).toMatchObject({ state: "installed", changed: true });
  expect(readdirSync(f.root)).toEqual(["selected-home"]);
  const unobserved = { ...f.home, path: join(f.root, "not-selected"), sources: [] };
  expect(installClaudeProfileHook(unobserved, options).state).toBe("refused");
  expect(existsSync(unobserved.path)).toBe(false);
  const missingParent = { ...f.home, path: join(f.root, "missing-parent", "nested") };
  expect(installClaudeProfileHook(missingParent, options).state).toBe("refused");
  expect(existsSync(join(f.root, "missing-parent"))).toBe(false);
});

test("disabled, malformed and oversized settings are refused unchanged without exposing their content", () => {
  for (const value of [{ disableAllHooks: true }, { disableAllHooks: "true" }, { hooks: [] }, { hooks: { PreToolUse: {} } }]) {
    const f = fixture(); f.write(value);
    const before = readFileSync(f.file, "utf8");
    expect(checkClaudeProfileHook(f.home, options).state).toBe("refused");
    expect(installClaudeProfileHook(f.home, options)).toMatchObject({ state: "refused", changed: false });
    expect(readFileSync(f.file, "utf8")).toBe(before);
  }
  const f = fixture(); writeFileSync(f.file, "sensitive-invalid-settings", { mode: 0o600 });
  expect(JSON.stringify(checkClaudeProfileHook(f.home, options))).not.toContain("sensitive-invalid");
  expect(installClaudeProfileHook(f.home, options).state).toBe("refused");
  writeFileSync(f.file, " ".repeat(1024 * 1024 + 1));
  expect(installClaudeProfileHook(f.home, options).state).toBe("refused");
});

test("symlinked, hardlinked and writable settings or selected directories are refused", () => {
  const f = fixture(), target = join(f.root, "other-settings.json");
  writeFileSync(target, "{}", { mode: 0o600 }); symlinkSync(target, f.file);
  expect(installClaudeProfileHook(f.home, options).state).toBe("refused");
  rmSync(f.file); linkSync(target, f.file);
  expect(installClaudeProfileHook(f.home, options).state).toBe("refused");
  rmSync(f.file); f.write({}); chmodSync(f.file, 0o666);
  expect(installClaudeProfileHook(f.home, options).state).toBe("refused");
  chmodSync(f.file, 0o600); chmodSync(f.home.path, 0o777);
  expect(installClaudeProfileHook(f.home, options).state).toBe("refused");
  chmodSync(f.home.path, 0o700);
  const alias = join(f.root, "alias"); symlinkSync(f.home.path, alias);
  expect(installClaudeProfileHook({ ...f.home, path: alias }, options).state).toBe("refused");
  expect(readFileSync(target, "utf8")).toBe("{}");
});

test("fallback sends only with explicit state and peer and without any managed launch marker", async () => {
  const f = fixture(), admitted = { HOME: f.root, AGENTHUB_STATE_DIR: join(f.root, "state"), AGENTHUB_PEER_ID: "claude-review" };
  const calls: unknown[] = [], transport = async (...args: [string, string, string]) => { calls.push(args); return "hook-output"; };
  for (const env of [{ HOME: f.root }, { AGENTHUB_STATE_DIR: admitted.AGENTHUB_STATE_DIR }, { ...admitted, AGENTHUB_STATE_DIR: "relative" }, { ...admitted, AGENTHUB_PEER_ID: "../claude" }, { ...admitted, AGENTHUB_LAUNCH_ID: "managed-launch" }, { ...admitted, AGENTHUB_LAUNCH_ID: "" }]) {
    expect(claudeProfileHookTarget(env)).toBeUndefined();
    expect(await runClaudeProfileHook("{}", env, transport)).toBeUndefined();
  }
  expect(calls).toEqual([]);
  expect(await runClaudeProfileHook("{}", admitted, transport)).toBe("hook-output");
  expect(calls).toEqual([["{}", admitted.AGENTHUB_STATE_DIR, "claude-review"]]);
  expect(await runClaudeProfileHook("{}", admitted, async () => { throw new Error("sensitive-native-error"); })).toBeUndefined();
  expect(await runClaudeProfileHook("x".repeat(1024 * 1024 + 1), admitted, transport)).toBeUndefined();
  expect(calls).toHaveLength(1);
});
