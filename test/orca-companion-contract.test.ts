import { expect, test } from "bun:test";
import { FakeOrcaCompanionHost, type FakeOrcaCompanionHostOptions, type OrcaCompanionFixtureWorkspace } from "./helpers/orca-companion-host.ts";
import { FakeOrcaCompanionCli, type OrcaCompanionFixtureCliCall } from "./fakes/orca-companion-cli.ts";

const path = "/opaque root with spaces/$(NEVER_EXECUTE); & 'quoted'";
const workspaces: OrcaCompanionFixtureWorkspace[] = [
  { id: "workspace-a", kind: "worktree", name: "same display name", path, branch: "same-branch", hostId: null },
  { id: "workspace-b", kind: "folder", name: "same display name", path: "C:\\opaque project\\$(NEVER_EXECUTE) & folder", branch: null, hostId: "host-b" },
];
function host(options: Partial<FakeOrcaCompanionHostOptions> = {}) {
  return new FakeOrcaCompanionHost({ offeredMethods: ["workspace.list", "workspace.readContext", "workspace.open", "shell.openExternal"], surface: "worker",
    capabilities: ["workspace:read", "workspace:write"], workspaces, ...options });
}
const call = (extra: Partial<OrcaCompanionFixtureCliCall> = {}): OrcaCompanionFixtureCliCall => ({
  executable: "/nonexistent fixture tool/ahub; $(NEVER_EXECUTE)", argv: ["--project", path, "status", "--json"], cwd: path, hostId: null, timeoutMs: 1000, maxOutputBytes: 1024, ...extra,
});

test("offered methods are explicit and an older host really rejects unknown methods", async () => {
  const old = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.readContext"], surface: "worker", capabilities: ["workspace:read"], workspaces });
  expect(old.has("workspace.list")).toBe(false); expect(old.has("workspace.open")).toBe(false);
  await expect(old.call("workspace.list")).rejects.toMatchObject({ code: "unknown_method" });
  await expect(old.call("workspace.open", { workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "unknown_method" });
  expect(old.openedWorkspaceIds).toEqual([]);
});
test("workspace list keeps exact identity, host, opaque roots and truncation", async () => {
  const fake = host();
  const listed = await fake.call("workspace.list");
  expect(listed).toEqual({ workspaces, truncated: false });
  listed.workspaces[0]!.path = "consumer mutation";
  expect((await fake.call("workspace.list")).workspaces[0]!.path).toBe(path);
  fake.setRoster([workspaces[1]!], true);
  expect(await fake.call("workspace.list")).toEqual({ workspaces: [workspaces[1]!], truncated: true });
});
test("readContext is nullable metadata and never invents workspace or host identity", async () => {
  const fake = host(); expect(await fake.call("workspace.readContext")).toBeNull();
  const context = { branch: "same-branch", displayName: "same display name", terminals: [{ id: "plugin-terminal-id", title: "ahub console" }] };
  fake.setContext(context);
  const result = await fake.call("workspace.readContext");
  expect(result).toEqual(context); expect(Object.keys(result!).sort()).toEqual(["branch", "displayName", "terminals"]);
  await expect(fake.call("workspace.open", { workspaceId: context.displayName })).rejects.toMatchObject({ code: "fixture_identity_missing" });
  await expect(fake.call("workspace.open", { workspaceId: context.branch })).rejects.toMatchObject({ code: "fixture_identity_missing" });
  expect(fake.openedWorkspaceIds).toEqual([]);
});
test("workspace open uses one exact ID and refuses name/branch/extra parameter selection", async () => {
  const fake = host();
  expect(await fake.call("workspace.open", { workspaceId: "workspace-b" })).toEqual({ opened: true });
  expect(fake.openedWorkspaceIds).toEqual(["workspace-b"]);
  for (const params of [{ name: "same display name" }, { branch: "same-branch" }, { workspaceId: "workspace-a", hostId: null }, {}]) {
    await expect(fake.call("workspace.open", params)).rejects.toMatchObject({ code: "invalid_params" });
  }
  expect(fake.openedWorkspaceIds).toEqual(["workspace-b"]);
});
test("missing and duplicate identities are explicit fixture refusals", async () => {
  const fake = host();
  await expect(fake.call("workspace.open", { workspaceId: "removed" })).rejects.toMatchObject({ code: "fixture_identity_missing" });
  fake.setRoster([{ ...workspaces[0]!, id: "" }]);
  await expect(fake.call("workspace.list")).rejects.toMatchObject({ code: "fixture_identity_missing" });
  fake.setRoster([workspaces[0]!, { ...workspaces[1]!, id: workspaces[0]!.id }]);
  await expect(fake.call("workspace.list")).rejects.toMatchObject({ code: "fixture_identity_ambiguous" });
  await expect(fake.call("workspace.open", { workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "fixture_identity_ambiguous" });
  expect(fake.openedWorkspaceIds).toEqual([]);
});
test("roster change is visible and a stale ID is never redirected to a matching name", async () => {
  const fake = host(); await fake.call("workspace.list"); fake.setRoster([{ ...workspaces[0]!, id: "replacement-id" }]);
  await expect(fake.call("workspace.open", { workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "fixture_identity_missing" });
  expect(fake.openedWorkspaceIds).toEqual([]);
});
for (const surface of ["panel", "editor"] as const) test(`workspace list and open remain worker-only on ${surface}`, async () => {
  const fake = host({ surface }); expect(fake.has("workspace.list")).toBe(false);
  await expect(fake.call("workspace.list")).rejects.toMatchObject({ code: "not_permitted" });
  await expect(fake.call("workspace.open", { workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "not_permitted" });
  expect(await fake.call("workspace.readContext")).toBeNull();
});
test("method availability grants no missing read/write capability", async () => {
  const readOnly = host({ capabilities: ["workspace:read"] }); expect(readOnly.has("workspace.open")).toBe(true);
  await expect(readOnly.call("workspace.open", { workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "capability_denied" });
  const denied = host({ capabilities: [] });
  await expect(denied.call("workspace.list")).rejects.toMatchObject({ code: "capability_denied" });
  await expect(denied.call("workspace.readContext")).rejects.toMatchObject({ code: "capability_denied" });
});
test("external navigation is frame-only, desktop-only and gesture-bound", async () => {
  const url = "https://example.invalid/existing-screen";
  await expect(host().call("shell.openExternal", { url }, { userGesture: true })).rejects.toMatchObject({ code: "not_permitted" });
  const frame = host({ surface: "panel", capabilities: [] });
  await expect(frame.call("shell.openExternal", { url })).rejects.toMatchObject({ code: "not_permitted" });
  expect(frame.externalNavigation).toEqual([]);
  expect(await frame.call("shell.openExternal", { url }, { userGesture: true })).toEqual({ opened: true });
  frame.setExternalResult({ opened: false, reason: "cancelled" });
  expect(await frame.call("shell.openExternal", { url }, { userGesture: true })).toEqual({ opened: false, reason: "cancelled" });
  expect(frame.externalNavigation).toEqual([url]);
  const browser = host({ surface: "editor", desktop: false });
  expect(browser.has("shell.openExternal")).toBe(false);
  await expect(browser.call("shell.openExternal", { url }, { userGesture: true })).rejects.toMatchObject({ code: "not_permitted" });
  for (const invalid of ["javascript:alert(1)", "file:///fixture", "not a URL"]) {
    await expect(frame.call("shell.openExternal", { url: invalid }, { userGesture: true })).rejects.toMatchObject({ code: "invalid_params" });
  }
});
test("folder workspace navigation has its own desktop limitation", async () => {
  const fake = host({ desktop: false });
  await expect(fake.call("workspace.open", { workspaceId: "workspace-b" })).rejects.toMatchObject({ code: "not_permitted" });
  expect(await fake.call("workspace.open", { workspaceId: "workspace-a" })).toEqual({ opened: true });
});
test("fixture exposes no invented terminal focus, creation or functional mutation method", async () => {
  const fake = host({ capabilities: ["workspace:read", "workspace:write", "terminal:send", "agent:launch"] });
  for (const method of ["terminal.focus", "terminal.switch", "terminal.create", "terminal.sendText", "agent.launch", "host.exec", "tasks.approve"]) {
    expect(fake.has(method)).toBe(false);
    await expect(fake.call(method, { terminalId: "plugin-terminal-id" })).rejects.toMatchObject({ code: "unknown_method" });
  }
  expect(fake.calls).toEqual([]); expect(fake.snapshot()).toEqual({ agents: [], worktrees: [], terminals: [] });
});
test("disabled fixture refuses calls while synthetic agent/worktree/terminal state stays intact", async () => {
  const state = { agents: ["running-agent"], worktrees: ["existing-worktree"], terminals: ["existing-terminal"] };
  const fake = host({ syntheticState: state }); const before = JSON.stringify(fake.snapshot()); fake.setEnabled(false);
  await expect(fake.call("workspace.list")).rejects.toMatchObject({ code: "consent_required" });
  await expect(fake.call("workspace.open", { workspaceId: "workspace-a" })).rejects.toMatchObject({ code: "consent_required" });
  expect(JSON.stringify(fake.snapshot())).toBe(before); expect(state).toEqual(fake.snapshot());
  expect(fake.calls).toEqual([]); expect(fake.openedWorkspaceIds).toEqual([]);
  fake.setEnabled(true); expect((await fake.call("workspace.list")).workspaces).toEqual(workspaces);
});

test("injected CLI port captures arrays and never executes opaque executable/path strings", async () => {
  const cli = new FakeOrcaCompanionCli({ hostId: null, scripted: [{ stdout: "{\"running\":true}", exitCode: 0 }] });
  const input = call(), argv = input.argv as string[];
  const answer = await cli.run(input); argv.push("caller mutation");
  expect(answer).toEqual({ stdout: '{"running":true}', stderr: "", exitCode: 0, timedOut: false, truncated: false });
  expect(cli.calls[0]).toEqual({ ...call(), argv: ["--project", path, "status", "--json"] });
  expect(cli.remainingScripts).toBe(0);
});
test("remote CLI host mismatch refuses instead of executing the remote path locally", async () => {
  const cli = new FakeOrcaCompanionCli({ hostId: null, scripted: [{ stdout: "unused", exitCode: 0 }] });
  await expect(cli.run(call({ hostId: "host-b", cwd: workspaces[1]!.path }))).rejects.toMatchObject({ code: "host_mismatch" });
  expect(cli.calls[0]!.hostId).toBe("host-b"); expect(cli.remainingScripts).toBe(1);
});
test("scripted CLI results preserve invalid/nonzero output and model timeout without a real timer", async () => {
  const cli = new FakeOrcaCompanionCli({ hostId: "host-b", scripted: [{ stdout: "not-json", stderr: "fixture error", exitCode: 7 }, { stdout: "partial", exitCode: 0, durationMs: 1001 }] });
  const first = await cli.run(call({ hostId: "host-b" })); expect(first.stdout).toBe("not-json"); expect(first.exitCode).toBe(7);
  const second = await cli.run(call({ hostId: "host-b" })); expect(second.timedOut).toBe(true); expect(second.exitCode).toBeNull();
  expect(cli.calls).toHaveLength(2);
  await expect(cli.run(call({ hostId: "host-b" }))).rejects.toMatchObject({ code: "unscripted" });
});
test("CLI output cap is combined UTF-8 bytes and does not invent a complete response", async () => {
  const cli = new FakeOrcaCompanionCli({ hostId: null, scripted: [{ stdout: "한글", stderr: "errors", exitCode: 0 }] });
  const answer = await cli.run(call({ maxOutputBytes: 4 }));
  expect(new TextEncoder().encode(answer.stdout + answer.stderr).length).toBeLessThanOrEqual(4);
  expect(answer.stdout).toBe("한"); expect(answer.truncated).toBe(true); expect(answer.timedOut).toBe(false);
});
test("disabling the host fixture cannot disable a separately injected command workflow", async () => {
  const fake = host(), cli = new FakeOrcaCompanionCli({ hostId: null, scripted: [{ stdout: "existing CLI still usable", exitCode: 0 }] });
  fake.setEnabled(false); expect((await cli.run(call())).exitCode).toBe(0);
  cli.setEnabled(false); await expect(cli.run(call())).rejects.toMatchObject({ code: "disabled" });
  expect(fake.snapshot()).toEqual({ agents: [], worktrees: [], terminals: [] });
});
