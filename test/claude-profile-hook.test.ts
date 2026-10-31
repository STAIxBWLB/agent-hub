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

test("a managed session with both per-launch and installed profile hooks delivers PreToolUse exactly once", async () => {
  const { sessionSettings } = await import("../src/cli/launch.ts");
  const { PROTOCOL } = await import("../src/hub/control-client.ts");
  const f = fixture(), stateDir = join(f.root, "state"), user = join(f.root, "user"), hubHome = join(f.root, "hub"), temporary = join(f.root, "tmp"), bin = join(f.root, "bin");
  for (const directory of [stateDir, user, hubHome, temporary, bin]) mkdirSync(directory, { mode: 0o700 });
  symlinkSync(process.execPath, join(bin, "bun"));
  const identity = { projectId: "fixture-project", instanceId: "fixture-instance", cwd: f.root };
  const facts: Record<string, unknown>[] = [];
  const token = "fixture-profile-hook-token";
  const server = Bun.serve<{ authenticated: boolean }>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (request.headers.has("Origin")) return new Response("origin refused", { status: 403 });
      return server.upgrade(request, { data: { authenticated: false } }) ? undefined : new Response("upgrade required", { status: 400 });
    },
    websocket: { message(ws, raw) {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.t === "hello") {
        if (message.token !== token || message.role !== "tools" || message.peer !== "claude") { ws.close(4401, "fixture authentication refused"); return; }
        ws.data.authenticated = true;
        ws.send(JSON.stringify({ t: "welcome", rid: message.rid, ...identity }));
      } else if (ws.data.authenticated && message.t === "facts") {
        facts.push(message);
        ws.send(JSON.stringify({ ok: true, rid: message.rid, permission: "ask", projectRoot: f.root, text: "fixture hook context" }));
      } else ws.close(4401, "fixture request refused");
    } },
  });
  try {
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, ...identity }), { mode: 0o600 });
    writeFileSync(join(stateDir, "control-token"), token, { mode: 0o600 });
    const generated = JSON.parse(sessionSettings(undefined, { script: join(import.meta.dir, "../src/cli/facts-hook.ts"), stateDir, purpose: "permission" }));
    f.write(generated);
    expect(installClaudeProfileHook(f.home)).toMatchObject({ state: "installed", changed: true });
    const entries = f.read().hooks.PreToolUse as { hooks: { command: string; timeout: number }[] }[];
    const commands = entries.flatMap(entry => entry.hooks);
    expect(commands).toHaveLength(2);
    expect(commands.every(command => command.timeout === 5)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${server.port}`, { headers: { Origin: "https://fixture.invalid" } })).status).toBe(403);
    const env: NodeJS.ProcessEnv = {
      HOME: user, CLAUDE_CONFIG_DIR: f.home.path, AGENTHUB_HOME: hubHome, AMEM_HOME: join(f.root, "memory"), TMPDIR: temporary,
      PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: "/dev/null",
      AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: f.root, AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: identity.instanceId, AGENTHUB_LAUNCH_ID: "fixture-managed-launch",
    };
    const input = Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fixture-session", tool_name: "Bash", tool_input: { command: "fixture-only" } }));
    const outputs: string[] = [];
    for (const command of commands) {
      // exec/env preserves each generated command while making the timed child the actual hook process.
      const child = Bun.spawn(["/bin/sh", "-c", `exec /usr/bin/env ${command.command}`], { cwd: f.root, env, stdin: input, stdout: "pipe", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, stderr).toBe(0);
        outputs.push(stdout);
      } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    }
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ t: "facts", phase: "pre", tool: "Bash", nativeLaunchId: "fixture-managed-launch" });
    expect(outputs.filter(output => output.includes("fixture hook context"))).toHaveLength(1);
    expect(outputs.filter(output => output === "")).toHaveLength(1);
  } finally { server.stop(true); }
}, 20000);


test("first-use default home can be created privately, but a disappeared observed default is refused", () => {
  const f = fixture(false), home: ClaudeHome = { ...f.home, sources: ["default"] };
  expect(checkClaudeProfileHook({ ...home, exists: true }, options).state).toBe("refused");
  expect(existsSync(home.path)).toBe(false);
  expect(installClaudeProfileHook(home, options)).toMatchObject({ state: "installed", changed: true });
  expect(statSync(home.path).mode & 0o777).toBe(0o700);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
});
