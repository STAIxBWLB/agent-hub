import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote as packageShellQuote } from "../src/cli/shell-quote.ts";
import { FakeOrcaCompanionHost, type OrcaCompanionFixtureWorkspace } from "./helpers/orca-companion-host.ts";
import { FakeOrcaCompanionCli, type OrcaCompanionFixtureCliResponse } from "./fakes/orca-companion-cli.ts";

// #1198 O1 over the O0 fixtures (#789): the chooser, the identity binding and the entry points, with no Orca, no ahub and no network. The plugin folder is plain .mjs that Orca loads as is, so it is
// imported dynamically and typed here by the shape the tests rely on.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `ahub-orca-${name}-`))); dirs.push(dir); return dir; };

// The plugin folder is plain .mjs (Orca loads it as is, with no build), so it has no declarations; the tests rely on the shapes asserted below.
// @ts-ignore TS7016: untyped plain JavaScript by design
const companion: any = await import("../integrations/orca/src/companion.mjs");
// @ts-ignore TS7016: untyped plain JavaScript by design
const worker: any = await import("../integrations/orca/src/worker.mjs");

/** The O0 fake offers four methods and no `terminal.create`; this wrapper adds that one method, recorded here and nowhere else, and leaves the O0 file unchanged. */
class TestHost {
  readonly terminals: { workspaceId: string; title?: string; command?: string }[] = [];
  readonly calls: string[] = [];
  terminalCreate = true;
  duringWorkspaceOpen: (() => Promise<void>) | undefined;
  constructor(readonly fake: FakeOrcaCompanionHost) {}
  has(method: string) { return method === "terminal.create" ? this.terminalCreate : this.fake.has(method); }
  async call(method: string, params?: unknown) {
    this.calls.push(method);
    if (method === "terminal.create") {
      if (!this.terminalCreate) throw new Error("unknown_method");
      this.terminals.push(structuredClone(params) as { workspaceId: string });
      return { terminalId: "t-1" };
    }
    const result = await this.fake.call(method, params);
    if (method === "workspace.open") await this.duringWorkspaceOpen?.();
    return result;
  }
}

const SPACED = (base: string) => { const dir = join(base, "my project $(touch NEVER) `x` & 'quoted' ; é"); mkdirSync(dir, { recursive: true }); return dir; };
function setup(overrides: { settings?: Record<string, unknown>; ahub?: OrcaCompanionFixtureCliResponse[]; rows?: (root: string, other: string) => OrcaCompanionFixtureWorkspace[]; syntheticState?: boolean } = {}) {
  const base = temp("ws"), root = SPACED(base), other = join(base, "other"); mkdirSync(other);
  const rows = (overrides.rows ?? ((r, o) => [
    { id: "ws-a", kind: "worktree", name: "same name", path: r, branch: "same-branch", hostId: "local" },
    { id: "ws-b", kind: "worktree", name: "same name", path: o, branch: "same-branch", hostId: "local" },
  ]))(root, other);
  const fake = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.list", "workspace.readContext", "workspace.open", "shell.openExternal"], surface: "worker",
    capabilities: ["workspace:read", "workspace:write"], workspaces: rows, syntheticState: { agents: ["agent-1"], worktrees: ["wt-1"], terminals: ["term-1"] } });
  const host = new TestHost(fake);
  const cli = new FakeOrcaCompanionCli({ hostId: "local", scripted: overrides.ahub ?? [{ stdout: "Dashboard opened. The session expires in one hour; run ahub ui to reopen it.\n", exitCode: 0 }] });
  const logs: string[] = [], settingsReads: number[] = [];
  const instance = worker.createCompanion({ host, readSettings: async () => { settingsReads.push(1); return overrides.settings ?? { localHostIds: "local" }; }, spawnCli: cli.run, log: (line: string) => logs.push(line) });
  return { base, root, other, rows, fake, host, cli, logs, settingsReads, instance, snapshot: (id: string, root_: string, hostId: string | null = "local", kind = "worktree") => ({ id, hostId, root: root_, kind }) };
}

test("AC1: selection is by exact id; two workspaces with the same name and branch are told apart, and a name or branch never selects", async () => {
  const s = setup();
  const listed = await s.instance.list();
  expect(listed.ok).toBe(true);
  expect(listed.rows.map((r: any) => [r.id, r.selectable, r.root])).toEqual([["ws-a", true, s.root], ["ws-b", true, s.other]]);
  expect((await s.instance.bind({ id: "ws-b" })).binding).toEqual({ id: "ws-b", hostId: "local", root: s.other, kind: "worktree" });
  for (const nameLike of ["same name", "same-branch", "", "WS-A"]) expect(await s.instance.bind({ id: nameLike })).toMatchObject({ ok: false });
  expect(await s.instance.bind({ id: "same name", name: "same name" })).toMatchObject({ ok: false, refusal: "bad_request" });
  expect(await s.instance.open({ kind: "dashboard", snapshot: { id: "same name", hostId: "local", root: s.root, kind: "worktree" } })).toMatchObject({ ok: false, refusal: "missing" });
  expect(s.cli.calls).toHaveLength(0);
});

test("AC1: duplicate, missing, truncated, malformed and changed identity each fail visibly and run nothing", async () => {
  const s = setup();
  const snap = s.snapshot("ws-a", s.root);
  const refused = async (expected: string) => {
    const r = await s.instance.open({ kind: "dashboard", snapshot: snap });
    expect(r).toMatchObject({ ok: false, refusal: expected });
    expect(typeof r.guidance).toBe("string"); expect(r.guidance.length).toBeGreaterThan(10);
    expect(s.cli.calls).toHaveLength(0); expect(s.host.terminals).toHaveLength(0); expect(s.fake.openedWorkspaceIds).toEqual([]);
  };
  // missing: the workspace was removed since the person selected it
  s.fake.setRoster([s.rows[1]!]); await refused("missing");
  // truncated: the inventory is partial, so no row can be told apart safely
  s.fake.setRoster(s.rows, true); await refused("truncated");
  // duplicate id: the O0 host itself refuses to list, which the companion reads as no inventory; the pure reader refuses it by name
  s.fake.setRoster([s.rows[0]!, { ...s.rows[1]!, id: "ws-a" }]); await refused("inventory_unavailable");
  expect(companion.readInventory({ workspaces: [s.rows[0], { ...s.rows[1], id: "ws-a" }], truncated: false })).toMatchObject({ ok: false, refusal: "duplicate" });
  // malformed rows, including a non-boolean truncated flag and a row missing a field
  for (const bad of [{ workspaces: [{ ...s.rows[0], path: "" }], truncated: false }, { workspaces: [{ id: "x" }], truncated: false }, { workspaces: [s.rows[0]] }, { workspaces: "no", truncated: false }, null, []]) {
    expect(companion.readInventory(bad)).toMatchObject({ ok: false });
  }
  // changed: the same id now sits at another root, kind or host
  s.fake.setRoster([{ ...s.rows[0]!, path: s.other }, s.rows[1]!]); await refused("changed");
  s.fake.setRoster([{ ...s.rows[0]!, kind: "folder" }, s.rows[1]!]); await refused("changed");
  s.fake.setRoster([{ ...s.rows[0]!, hostId: "other-host" }, s.rows[1]!]); await refused("remote");
});

for (const change of ["root", "host", "kind", "truncated", "missing", "settings"] as const) test(`terminal creation rechecks identity and context after workspace.open yields: ${change}`, async () => {
  const settings = { localHostIds: "local" }, s = setup({ settings });
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  s.host.duringWorkspaceOpen = async () => { entered(); await held; };
  const opening = s.instance.open({ kind: "console", snapshot: s.snapshot("ws-a", s.root) });
  try {
    await opened;
    expect(s.host.terminals).toEqual([]);
    const row = s.rows[0]!;
    if (change === "root") s.fake.setRoster([{ ...row, path: s.other }]);
    else if (change === "host") s.fake.setRoster([{ ...row, hostId: "other-host" }]);
    else if (change === "kind") s.fake.setRoster([{ ...row, kind: "folder" }]);
    else if (change === "truncated") s.fake.setRoster(s.rows, true);
    else if (change === "missing") s.fake.setRoster([s.rows[1]!]);
    else settings.localHostIds = "other-host";
    release();
    const result = await opening;
    const refusal = change === "host" || change === "settings" ? "remote" : change === "truncated" || change === "missing" ? change : "changed";
    expect(result).toMatchObject({ ok: false, refusal });
    expect(result.guidance).toBe(companion.REFUSALS[refusal]);
    expect(s.host.calls).toEqual(["workspace.list", "workspace.open", "workspace.list"]);
    expect(s.settingsReads).toHaveLength(2);
    expect(s.host.terminals).toEqual([]); expect(s.cli.calls).toEqual([]);
    expect(s.fake.openedWorkspaceIds).toEqual(["ws-a"]);
  } finally { release(); await opening; }
});

test("a selection snapshot with extra, missing or odd fields is refused before anything is read", async () => {
  const s = setup();
  const good = s.snapshot("ws-a", s.root);
  for (const bad of [{ ...good, extra: 1 }, { id: "ws-a", hostId: "local", root: s.root }, { ...good, root: "" }, { ...good, kind: "other" }, [], null, "ws-a", { ...good, id: `a${"b".repeat(600)}` }]) {
    expect(await s.instance.open({ kind: "dashboard", snapshot: bad })).toMatchObject({ ok: false, refusal: "bad_request" });
  }
  for (const input of [{ kind: "approve", snapshot: good }, { kind: "dashboard" }, { snapshot: good }, { kind: "dashboard", snapshot: good, extra: true }, undefined, "dashboard"]) {
    expect(await s.instance.open(input)).toMatchObject({ ok: false, refusal: "bad_request" });
  }
  expect(s.cli.calls).toHaveLength(0); expect(s.host.calls).toEqual([]);
});

test("a host id the person has not declared local is never run on this Mac, and a missing host id needs the person's say-so", async () => {
  const remote = setup({ rows: (r) => [{ id: "ws-r", kind: "worktree", name: "n", path: r, branch: null, hostId: "ssh-box" }] });
  expect((await remote.instance.list()).rows[0]).toMatchObject({ selectable: false, refusal: "remote" });
  expect(await remote.instance.open({ kind: "dashboard", snapshot: remote.snapshot("ws-r", remote.root, "ssh-box") })).toMatchObject({ ok: false, refusal: "remote" });
  const none = setup({ rows: (r) => [{ id: "ws-n", kind: "worktree", name: "n", path: r, branch: null, hostId: null }], settings: { localHostIds: "local" } });
  expect((await none.instance.list()).rows[0]).toMatchObject({ selectable: false, refusal: "host_unknown" });
  const trusted = setup({ rows: (r) => [{ id: "ws-n", kind: "worktree", name: "n", path: r, branch: null, hostId: null }], settings: { trustNullHostAsLocal: true } });
  expect((await trusted.instance.list()).rows[0]).toMatchObject({ selectable: true });
  // the root must be a real folder on this machine: a path that does not exist, or a relative one, never binds
  const ghost = setup({ rows: () => [{ id: "g", kind: "worktree", name: "n", path: "/no/such/folder/anywhere", branch: null, hostId: "local" }, { id: "rel", kind: "worktree", name: "n", path: "relative/dir", branch: null, hostId: "local" }] });
  expect((await ghost.instance.list()).rows.map((r: any) => r.refusal)).toEqual(["unreal_root", "unreal_root"]);
  // a symlinked root binds to its real target, and a later retarget of the link is a changed identity
  const linked = setup();
  const link = join(linked.base, "link"); symlinkSync(linked.root, link);
  linked.fake.setRoster([{ ...linked.rows[0]!, path: link }]);
  const bound = await linked.instance.bind({ id: "ws-a" });
  expect(bound.binding.root).toBe(linked.root);
  rmSync(link); symlinkSync(linked.other, link);
  expect(await linked.instance.open({ kind: "dashboard", snapshot: bound.binding })).toMatchObject({ ok: false, refusal: "changed" });
  expect(linked.cli.calls).toHaveLength(0);
});

test("AC6: a path with spaces and shell metacharacters is only ever the working directory, never an argument; ui gets no --json", async () => {
  const s = setup();
  const result = await s.instance.open({ kind: "dashboard", snapshot: s.snapshot("ws-a", s.root) });
  expect(result).toEqual({ ok: true, status: "opened" });
  expect(s.cli.calls).toHaveLength(1);
  const call = s.cli.calls[0]!;
  expect(call.executable).toBe("ahub");
  expect(call.argv).toEqual(["ui"]);
  expect(call.argv).not.toContain("--json"); expect(call.argv.join(" ")).not.toContain("--json");
  expect(call.cwd).toBe(s.root);
  expect(call.cwd).toContain("$(touch NEVER)");
  expect(call.timeoutMs).toBe(15_000); expect(call.maxOutputBytes).toBe(8192);
  expect(existsSync(join(s.root, "NEVER"))).toBe(false);
  // console and family console create a terminal whose command is fixed words; no project text is in it, and quoting is the package's own
  for (const [kind, command, title] of [["console", "'ahub' 'console'", "ahub console"], ["family", "'acon' 'ui'", "acon (family console)"]] as const) {
    const r = await s.instance.open({ kind, snapshot: s.snapshot("ws-a", s.root) });
    expect(r).toEqual({ ok: true, status: "terminal_created" });
    expect(s.host.terminals.at(-1)).toEqual({ workspaceId: "ws-a", title, command });
    expect(command).not.toContain("NEVER");
  }
  expect(s.fake.openedWorkspaceIds).toEqual(["ws-a", "ws-a"]);
  expect(companion.shellQuote("it's $(x)")).toBe(packageShellQuote("it's $(x)"));
  for (const probe of ["", "a b", "'", "''", "$(x)", "`x`", "a\nb", "é", "\\", "a;b&c|d"]) expect(companion.shellQuote(probe)).toBe(packageShellQuote(probe));
});

test("AC6: an invalid CLI response opens nothing, and its text is never returned or logged", async () => {
  const link = "http://127.0.0.1:43111/auth?ticket=SECRET-TICKET-1";
  const cases: [string, OrcaCompanionFixtureCliResponse, string][] = [
    ["empty output", { stdout: "", exitCode: 0 }, "unrecognized_output"],
    ["unrelated text", { stdout: "something else entirely\n", exitCode: 0 }, "unrecognized_output"],
    ["two links", { stdout: `Open this one-time link within 60 seconds:\n${link}\n${link}2\n`, exitCode: 0 }, "unrecognized_output"],
    ["a remote host link", { stdout: "http://example.com:8080/auth?ticket=SECRET-TICKET-2\n", exitCode: 0 }, "unrecognized_output"],
    ["a link with credentials", { stdout: "http://user:pw@127.0.0.1:43111/x\n", exitCode: 0 }, "unrecognized_output"],
    ["a non-http scheme", { stdout: "file:///etc/passwd\n", exitCode: 0 }, "unrecognized_output"],
    ["https to loopback", { stdout: "https://127.0.0.1:43111/x\n", exitCode: 0 }, "unrecognized_output"],
    ["a link without a port", { stdout: "http://127.0.0.1/x\n", exitCode: 0 }, "unrecognized_output"],
    ["opened and a link together", { stdout: `Dashboard opened. x\n${link}\n`, exitCode: 0 }, "unrecognized_output"],
    ["a failing exit with a link", { stdout: `${link}\n`, exitCode: 1 }, "cli_failed"],
    ["a timeout", { stdout: "", exitCode: 0, durationMs: 60_000 }, "cli_timeout"],
    ["too much output", { stdout: "x".repeat(20_000), exitCode: 0 }, "cli_output_too_large"],
  ];
  for (const [label, response, refusal] of cases) {
    const s = setup({ ahub: [response] });
    const r = await s.instance.open({ kind: "dashboard", snapshot: s.snapshot("ws-a", s.root) });
    expect(r, label).toMatchObject({ ok: false, refusal });
    const everything = JSON.stringify(r) + s.logs.join("\n");
    expect(everything, label).not.toContain("SECRET-TICKET"); expect(everything, label).not.toContain("passwd"); expect(everything, label).not.toContain("pw@");
  }
  // an absent executable and a thrown error are closed refusals too
  const missing = setup();
  const gone = worker.createCompanion({ host: missing.host, readSettings: async () => ({ localHostIds: "local" }), spawnCli: async () => { throw Object.assign(new Error("spawn ahub ENOENT /private/path"), { code: "ENOENT" }); }, log: (l: string) => missing.logs.push(l) });
  const r = await gone.open({ kind: "dashboard", snapshot: missing.snapshot("ws-a", missing.root) });
  expect(r).toMatchObject({ ok: false, refusal: "cli_missing" });
  expect(JSON.stringify(r) + missing.logs.join("\n")).not.toContain("/private/path");
});

test("AC6: the one-time link is returned once as a transient value, never logged, stored or put in an argument", async () => {
  const link = "http://127.0.0.1:43111/auth?ticket=ONE-TIME-TICKET-9";
  const s = setup({ ahub: [{ stdout: `Open this one-time link within 60 seconds:\n${link}\n`, exitCode: 0 }] });
  const r = await s.instance.open({ kind: "dashboard", snapshot: s.snapshot("ws-a", s.root) });
  expect(r).toEqual({ ok: true, status: "link", url: link });
  expect(s.logs.join("\n")).not.toContain("ONE-TIME-TICKET");
  expect(s.logs).toEqual(["entry.open: ok"]);
  expect(JSON.stringify(s.cli.calls)).not.toContain("ONE-TIME-TICKET");
  expect(JSON.stringify(s.host.calls)).not.toContain("ONE-TIME-TICKET");
  // the worker never asks the host for storage or secrets, so there is nowhere the link could be kept
  expect(s.host.calls.filter(m => /^(storage|secrets)\./.test(m))).toEqual([]);
  expect(readFileSync(join(import.meta.dir, "../integrations/orca/src/worker.mjs"), "utf8")).not.toMatch(/storage\.(set|get)|secrets\./);
  // The worker cannot open it: shell.openExternal is a panel and editor method, and the host refuses it to a worker whatever the gesture.
  await expect(s.fake.call("shell.openExternal", { url: link }, { userGesture: true })).rejects.toMatchObject({ code: "not_permitted" });
  expect(s.fake.externalNavigation).toEqual([]);
  // The panel opens it, and only on a click (a gesture): without one the host refuses, with one the link is opened exactly once.
  const panel = new FakeOrcaCompanionHost({ offeredMethods: ["shell.openExternal"], surface: "panel", capabilities: [], workspaces: s.rows });
  await expect(panel.call("shell.openExternal", { url: link })).rejects.toMatchObject({ code: "not_permitted" });
  expect(panel.externalNavigation).toEqual([]);
  expect((await panel.call("shell.openExternal", { url: link }, { userGesture: true })).opened).toBe(true);
  expect(panel.externalNavigation).toEqual([link]);
  // A browser client has no desktop external navigation at all: there the companion shows `ahub ui` to run instead of a link.
  const browser = new FakeOrcaCompanionHost({ offeredMethods: ["shell.openExternal"], surface: "panel", capabilities: [], workspaces: s.rows, desktop: false });
  expect(browser.has("shell.openExternal")).toBe(false);
});

test("logs hold a handler name and a closed code, never a path, a name or output", async () => {
  const s = setup({ ahub: [{ stdout: "garbage with /private/secret path\n", exitCode: 0 }] });
  await s.instance.list(); await s.instance.bind({ id: "ws-a" });
  await s.instance.open({ kind: "dashboard", snapshot: s.snapshot("ws-a", s.root) });
  await s.instance.open({ kind: "dashboard", snapshot: s.snapshot("nope", s.root) });
  expect(s.logs).toEqual(["workspaces.list: ok", "workspace.bind: ok", "entry.open: unrecognized_output", "entry.open: missing"]);
  for (const line of s.logs) expect(line).toMatch(/^[a-z.]+: [a-z_]+$/);
});

test("when the host does not offer an inventory or terminal creation, the person gets a manual command and nothing is run", async () => {
  const noList = setup(); noList.host.fake.setEnabled(true);
  const old = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.readContext"], surface: "worker", capabilities: ["workspace:read"], workspaces: noList.rows });
  const inst = worker.createCompanion({ host: new TestHost(old), readSettings: async () => ({ localHostIds: "local" }), spawnCli: noList.cli.run });
  expect(await inst.list()).toMatchObject({ ok: false, refusal: "not_offered" });
  expect(await inst.open({ kind: "dashboard", snapshot: noList.snapshot("ws-a", noList.root) })).toMatchObject({ ok: false, refusal: "inventory_unavailable" });
  const s = setup(); s.host.terminalCreate = false;
  const r = await s.instance.open({ kind: "console", snapshot: s.snapshot("ws-a", s.root) });
  expect(r).toMatchObject({ ok: false, refusal: "not_offered", command: "'ahub' 'console'" });
  expect(s.host.terminals).toEqual([]); expect(s.cli.calls).toHaveLength(0);
});

test("an invalid ahub executable setting is refused, and a valid one is used as the executable, never as a shell string", async () => {
  for (const bad of ["ahub", "relative/ahub", "/usr/bin/not-ahub", "/x/ahub; rm -rf /", "/x/ahub\n"]) {
    const s = setup({ settings: { localHostIds: "local", ahubPath: bad } });
    expect(await s.instance.open({ kind: "dashboard", snapshot: s.snapshot("ws-a", s.root) })).toMatchObject({ ok: false, refusal: "invalid_setting" });
    expect(await s.instance.list()).toMatchObject({ ok: false, refusal: "invalid_setting" });
    expect(s.cli.calls).toHaveLength(0);
  }
  const good = setup({ settings: { localHostIds: "local", ahubPath: "/opt/with space/bin/ahub" } });
  await good.instance.open({ kind: "dashboard", snapshot: good.snapshot("ws-a", good.root) });
  expect(good.cli.calls[0]).toMatchObject({ executable: "/opt/with space/bin/ahub", argv: ["ui"] });
});

test("the real child-process port: fixed argv, no shell, the folder as cwd only, no ORCA_ variable, a timeout and a byte cap", async () => {
  const base = temp("real"), folder = SPACED(base);
  const script = join(base, "ahub"); 
  writeFileSync(script, `#!/bin/sh\nif [ -n "$ORCA_PROBE" ]; then echo "leaked $ORCA_PROBE"; exit 3; fi\nif [ "$1" != "ui" ] || [ "$#" -ne 1 ]; then echo "bad args $*"; exit 4; fi\nprintf 'cwd=%s\\n' "$PWD" >> "${base}/seen.txt"\necho "Dashboard opened. ok"\n`);
  chmodSync(script, 0o755);
  process.env.ORCA_PROBE = "must-not-reach-the-child";
  try {
    const ok = await worker.realSpawnCli({ executable: script, argv: ["ui"], cwd: folder, hostId: null, timeoutMs: 5000, maxOutputBytes: 4096 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    expect(ok.stdout).toContain("Dashboard opened.");
    expect(readFileSync(join(base, "seen.txt"), "utf8").trim()).toBe(`cwd=${folder}`);
    expect(existsSync(join(folder, "NEVER"))).toBe(false);
  } finally { delete process.env.ORCA_PROBE; }
  // a hostile argument is one opaque word: no shell is involved, so nothing is expanded
  writeFileSync(script, `#!/bin/sh\nprintf '%s' "$1"\n`); chmodSync(script, 0o755);
  const hostile = await worker.realSpawnCli({ executable: script, argv: ["$(touch " + join(base, "PWNED") + ")"], cwd: folder, hostId: null, timeoutMs: 5000, maxOutputBytes: 4096 });
  expect(hostile.stdout).toBe("$(touch " + join(base, "PWNED") + ")"); expect(existsSync(join(base, "PWNED"))).toBe(false);
  // the cap and the timeout
  writeFileSync(script, `#!/bin/sh\nhead -c 100000 /dev/zero | tr '\\0' x\n`); chmodSync(script, 0o755);
  const big = await worker.realSpawnCli({ executable: script, argv: [], cwd: folder, hostId: null, timeoutMs: 5000, maxOutputBytes: 1024 });
  expect(big.truncated).toBe(true); expect(big.stdout.length).toBeLessThanOrEqual(1024);
  writeFileSync(script, `#!/bin/sh\nsleep 30\n`); chmodSync(script, 0o755);
  const started = Date.now();
  const slow = await worker.realSpawnCli({ executable: script, argv: [], cwd: folder, hostId: null, timeoutMs: 300, maxOutputBytes: 1024 });
  expect(slow.timedOut).toBe(true); expect(slow.exitCode).toBeNull(); expect(Date.now() - started).toBeLessThan(5000);
  await expect(worker.realSpawnCli({ executable: join(base, "does-not-exist"), argv: [], cwd: folder, hostId: null, timeoutMs: 1000, maxOutputBytes: 1024 })).rejects.toMatchObject({ code: "ENOENT" });
});

test("the manifest asks for exactly the host methods the worker uses and nothing broader", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../integrations/orca/orca-plugin.json"), "utf8"));
  expect(manifest.manifestVersion).toBe(2); expect(manifest.execution).toBe("trusted-worker"); expect(manifest.pluginApi).toBe(1);
  expect(manifest.capabilities.map((c: { kind: string }) => c.kind).sort()).toEqual(["settings:own", "terminal:send", "workspace:read", "workspace:write"]);
  for (const forbidden of ["agent:launch", "agent:read", "terminal:read", "secrets:own", "storage:own", "notifications:show", "appearance:write"]) expect(manifest.capabilities.map((c: { kind: string }) => c.kind)).not.toContain(forbidden);
  expect(manifest.contributes.hooks).toBeUndefined(); expect(manifest.contributes.events).toBeUndefined(); expect(manifest.contributes.commands).toBeUndefined();
  const source = readFileSync(join(import.meta.dir, "../integrations/orca/src/worker.mjs"), "utf8");
  const used = [...new Set([...source.matchAll(/host\.(?:call|has)\("([a-z.A-Z]+)"/g)].map(m => m[1]))].sort();
  expect(used).toEqual(["settings.get", "terminal.create", "workspace.list", "workspace.open"].filter(m => used.includes(m)));
  for (const verb of ["approve", "assign", "complete", "retry", "stop", "upgrade", "task", "agent.launch", "terminal.sendText"]) expect(source, verb).not.toMatch(new RegExp(`host\\.call\\("[^"]*${verb.replace(".", "\\.")}`));
  // `--json` is forbidden on `ahub ui` (it prints a link, not JSON). It is allowed on `ahub status` (O2). So: no argv that holds both "ui" and "--json", in the source or at runtime.
  expect(source).not.toMatch(/\[\s*"ui"\s*,[^\]]*--json/);
  const noComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(noComments(readFileSync(join(import.meta.dir, "../integrations/orca/src/companion.mjs"), "utf8"))).not.toMatch(/--json/);
});

test("the panel keeps nothing: no storage, no innerHTML of CLI or workspace text, and the link is dropped after use or expiry", () => {
  // The code is checked, not its comments: strip `//` comments first (the page's own comment says it uses no localStorage).
  const html = readFileSync(join(import.meta.dir, "../integrations/orca/panel/index.html"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|storage\.set|secrets\./);
  expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  expect(html).toContain("textContent");
  expect(html).toContain("dropLink()");
  expect(html).toMatch(/LINK_LIVES_MS\s*=\s*55_000/);
  expect(html).not.toMatch(/console\.(log|info|debug)/);
});
