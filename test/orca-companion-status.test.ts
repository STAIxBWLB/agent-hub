import { afterEach, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeOrcaCompanionHost, type OrcaCompanionFixtureWorkspace } from "./helpers/orca-companion-host.ts";
import { FakeOrcaCompanionCli, type OrcaCompanionFixtureCliResponse } from "./fakes/orca-companion-cli.ts";

// #1198 O2 over the O0 fixtures and the O1 worker: the read-only status projection, its distinct states, the private-output boundary and the stale-binding refusals. Terminal focus is NOT
// tested because it is not built: O0 recorded terminalIdToCliHandle "unproven", and a test of an unproven mapping would only prove the mapping the test invented.
const dirs: string[] = [];
// #1260: one test pins the clock, so every test in this file ends on the real one.
afterEach(() => { setSystemTime(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `ahub-orca-${name}-`))); dirs.push(dir); return dir; };
// @ts-ignore TS7016: untyped plain JavaScript by design
const status: any = await import("../integrations/orca/src/status.mjs");
// @ts-ignore TS7016: untyped plain JavaScript by design
const worker: any = await import("../integrations/orca/src/worker.mjs");

/** The shape `ahub status --json` prints (src/cli/output.ts StatusOutput), with private text planted where the real one holds free text. */
const SECRET = { title: "PATIENT-RECORDS-TITLE", doing: "editing /Users/secret/ward7.txt", note: "TOPSECRET-NOTE", ticket: "ticket=ONE-TIME-9" };
const REAL = () => JSON.stringify({
  version: "0.33.0", pid: 4242, controlPort: 4601, cwd: "/Users/secret/project", uiOrigin: "http://127.0.0.1:4650",
  tasks: { proposed: 2, in_progress: 1, in_review: 1, approved: 40, cancelled: 3 },
  peers: {
    codex: { state: "busy", queued: 2, doing: SECRET.doing, statusNotice: SECRET.note, context: { source: "x" } },
    claude: { state: "idle", queued: 0 },
    kimi: { state: "offline", queued: 0, attached: false },
  },
  personRun: [7], crash: [SECRET.note], mainCheckout: SECRET.title, agentDrift: [{ id: "codex", version: "9.9.9", state: "drift", receipt: "/Users/secret/receipt" }],
  schedules: [{ id: "nightly", class: "plan", queue: "q", next: 1, state: "ok", error: SECRET.note }], taskStalls: [{ task: 3, cause: { kind: "peer", peer: "codex", code: SECRET.ticket } }],
});

/**
 * The clock the projection is judged on: the epoch #1358's CI read as a real `fetchedAt`, 1794246524650, whose digits contain the 4-digit port a bare canary used to assert
 * absent. Pinned instead of read from the wall clock, so the proof that the canary no longer collides with a timestamp does not depend on the time of day.
 */
const FIXED_NOW = 1_794_246_524_650;

class TestHost {
  readonly calls: string[] = [];
  constructor(readonly fake: FakeOrcaCompanionHost) {}
  has(method: string) { return method === "terminal.create" || this.fake.has(method); }
  async call(method: string, params?: unknown) { this.calls.push(method); if (method === "terminal.create") return { terminalId: "t" }; return this.fake.call(method, params); }
}
function setup(statusResponse: OrcaCompanionFixtureCliResponse, extra: Partial<{ rows: (r: string) => OrcaCompanionFixtureWorkspace[]; settings: Record<string, unknown> }> = {}) {
  const base = temp("ws"), root = join(base, "proj with space $(x)"); mkdirSync(root);
  const rows = (extra.rows ?? (r => [{ id: "ws-a", kind: "worktree", name: "n", path: r, branch: null, hostId: "local" }]))(root);
  const fake = new FakeOrcaCompanionHost({ offeredMethods: ["workspace.list", "workspace.readContext", "workspace.open", "shell.openExternal"], surface: "worker", capabilities: ["workspace:read", "workspace:write"], workspaces: rows,
    syntheticState: { agents: ["a"], worktrees: ["w"], terminals: ["t"] } });
  const host = new TestHost(fake), cli = new FakeOrcaCompanionCli({ hostId: "local", scripted: [statusResponse] });
  const logs: string[] = [];
  // The O0 fake CLI returns stdout, stderr and the exit code. The real port (realSpawnCli) turns stderr into one boolean and drops it, so this port does the same with the same prefix test: the
  // companion only ever sees what the real port gives it. The last test pins the real port itself against scripts.
  const port = async (call: any) => { const r = await cli.run(call); return { ...r, stderr: "", stderrSaysNoHub: r.stderr.startsWith("ahub: no hub running for ") }; };
  const instance = worker.createCompanion({ host, readSettings: async () => extra.settings ?? { localHostIds: "local" }, spawnCli: port, log: (l: string) => logs.push(l) });
  return { base, root, fake, host, cli, logs, instance, snapshot: { id: "ws-a", hostId: "local", root, kind: "worktree" } };
}

test("AC4: a real-shaped status projects to ids, counts and closed states only; every free-text field is dropped", async () => {
  setSystemTime(new Date(FIXED_NOW));
  const s = setup({ stdout: REAL(), exitCode: 0 });
  const r = await s.instance.status({ snapshot: s.snapshot });
  expect(r).toMatchObject({ ok: true, state: "running", version: "0.33.0", missing: [] });
  expect(r.tasks).toEqual({ approved: 40, cancelled: 3, in_progress: 1, in_review: 1, proposed: 2 });
  expect(r.peers).toEqual([{ id: "claude", state: "idle", queued: 0, attached: true }, { id: "codex", state: "busy", queued: 2, attached: true }, { id: "kimi", state: "offline", queued: 0, attached: false }]);
  const text = JSON.stringify(r) + s.logs.join("\n");
  // #1260: a millisecond epoch is 13 digits, so a bare 4-digit port can land inside `fetchedAt` by accident and did in #1358's CI. Each port is therefore checked where a copied field
  // would carry it (its key, or host:port: forms no epoch can imitate), and as a number wherever it appears in the projection. The two lines before them are the removal proof: the
  // pinned epoch is in the scanned text and holds the old bare canary "4650", so a bare canary would fail here on every run rather than once in a while.
  expect(text).toContain(String(FIXED_NOW));
  expect(String(FIXED_NOW)).toContain("4650");
  for (const planted of [...Object.values(SECRET), "/Users/secret", '"pid":4242', '"controlPort":4601', "127.0.0.1:4650", "9.9.9", "receipt", "nightly"]) expect(text, planted).not.toContain(planted);
  const numbers = (node: unknown): number[] => typeof node === "number" ? [node] : node && typeof node === "object" ? Object.values(node).flatMap(numbers) : [];
  expect(numbers(r).filter(n => n === 4242 || n === 4601 || n === 4650)).toEqual([]);
  expect(Object.keys(r).sort()).toEqual(["ageMs", "fetchedAt", "missing", "ok", "peers", "state", "tasks", "version"]);
  expect(s.cli.calls).toHaveLength(1);
  expect(s.cli.calls[0]).toMatchObject({ executable: "ahub", argv: ["status", "--json"], cwd: s.root });
  expect(s.logs).toEqual(["status.read: ok"]);
});

test("AC4: offline, an older hub, a partial reading, a stale one and an unknown-age one stay distinct states", async () => {
  // offline: ahub's own no-hub line and exit 1. The stderr text is never returned, only the fact.
  const off = setup({ stdout: "", stderr: "ahub: no hub running for /Users/secret/project/.agenthub/state (run: ahub up)\n", exitCode: 1 });
  const offline = await off.instance.status({ snapshot: off.snapshot });
  expect(offline).toMatchObject({ ok: true, state: "offline", version: null, tasks: null, peers: null });
  expect(JSON.stringify(offline) + off.logs.join("")).not.toContain("secret");
  // an older hub: it answers, but without the fields this projection needs
  const oldHub = setup({ stdout: JSON.stringify({ pid: 1, cwd: "/x", somethingNew: true }), exitCode: 0 });
  expect(await oldHub.instance.status({ snapshot: oldHub.snapshot })).toMatchObject({ ok: true, state: "unavailable_version", version: null, tasks: null, peers: null });
  // partial: some fields are there, and the missing ones are named, never shown as 0
  const part = setup({ stdout: JSON.stringify({ version: "0.33.0", tasks: { proposed: 1 } }), exitCode: 0 });
  const partial = await part.instance.status({ snapshot: part.snapshot });
  expect(partial).toMatchObject({ ok: true, state: "partial", version: "0.33.0", tasks: { proposed: 1 }, peers: null, missing: ["peers"] });
  const noTasks = setup({ stdout: JSON.stringify({ version: "0.33.0", peers: { codex: { state: "idle" } } }), exitCode: 0 });
  const missingTasks = await noTasks.instance.status({ snapshot: noTasks.snapshot });
  expect(missingTasks).toMatchObject({ state: "partial", tasks: null, missing: ["tasks"] });
  expect(missingTasks.peers).toEqual([{ id: "codex", state: "idle", queued: null, attached: true }]);
  // stale and unknown age are judged from the clock the panel holds, not from the hub
  const fresh = status.projectStatus(JSON.parse(REAL()), 1_000, 1_000 + 59_000), old = status.projectStatus(JSON.parse(REAL()), 1_000, 1_000 + 61_000), none = status.projectStatus(JSON.parse(REAL()), Number.NaN, 5);
  expect([fresh.state, old.state, none.state]).toEqual(["running", "stale", "unknown"]);
  expect(status.ageReading({ ...fresh, ok: true, fetchedAt: 1_000 }, 1_000 + 120_000).state).toBe("stale");
  expect(status.ageReading({ ok: true, state: "offline", fetchedAt: 1_000 }, 9e9).state).toBe("offline");
  // all of them are different words
  expect(new Set([offline.state, "unavailable_version", partial.state, old.state, none.state, "running"]).size).toBe(6);
});

test("AC4: a hostile or malformed status never reaches the projection as text, and unknown values are bounded or dropped", async () => {
  const hostile = JSON.stringify({ version: "0.33.0\n<script>", tasks: { "<b>x</b>": 1, proposed: -1 }, peers: { "Bad Id": { state: "idle" } } });
  const h = setup({ stdout: hostile, exitCode: 0 });
  const r = await h.instance.status({ snapshot: h.snapshot });
  expect(r).toMatchObject({ ok: true, state: "unavailable_version", version: null, tasks: null, peers: null });
  expect(JSON.stringify(r)).not.toContain("script");
  const odd = status.projectStatus({ version: "1.2.3", tasks: { proposed: 1 }, peers: { codex: { state: "<img onerror=x>", queued: "NaN" } } }, 0, 0);
  expect(odd.peers).toEqual([{ id: "codex", state: "unknown", queued: null, attached: true }]);
  const many = status.projectStatus({ version: "1.2.3", tasks: { a: 1 }, peers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { state: "idle" }])) }, 0, 0);
  expect(many.peers).toBeNull(); expect(many.missing).toContain("peers");
  for (const bad of ["", "not json", "[]", "null", "42", '"str"', "{"]) {
    const s = setup({ stdout: bad, exitCode: 0 });
    expect(await s.instance.status({ snapshot: s.snapshot }), bad).toMatchObject({ ok: false, refusal: "unrecognized_output" });
  }
});

test("failure cases: a missing executable, a failing run, a timeout and an oversize answer are closed refusals that carry no text", async () => {
  const failing = setup({ stdout: "boom with /Users/secret/path", stderr: "Error: /Users/secret/other", exitCode: 1 });
  expect(await failing.instance.status({ snapshot: failing.snapshot })).toMatchObject({ ok: false, refusal: "cli_failed" });
  expect(JSON.stringify(await setup({ stdout: "x", stderr: "ahub: something else /Users/secret", exitCode: 1 }).instance.status({ snapshot: failing.snapshot }))).not.toContain("secret");
  const slow = setup({ stdout: "", exitCode: 0, durationMs: 60_000 });
  expect(await slow.instance.status({ snapshot: slow.snapshot })).toMatchObject({ ok: false, refusal: "cli_timeout" });
  const big = setup({ stdout: "x".repeat(20_000), exitCode: 0 });
  expect(await big.instance.status({ snapshot: big.snapshot })).toMatchObject({ ok: false, refusal: "cli_output_too_large" });
  const base = setup({ stdout: "", exitCode: 0 });
  const gone = worker.createCompanion({ host: base.host, readSettings: async () => ({ localHostIds: "local" }), spawnCli: async () => { throw Object.assign(new Error("ENOENT /Users/secret"), { code: "ENOENT" }); }, log: (l: string) => base.logs.push(l) });
  const r = await gone.status({ snapshot: base.snapshot });
  expect(r).toMatchObject({ ok: false, refusal: "cli_missing" });
  expect(JSON.stringify(r) + base.logs.join("")).not.toContain("secret");
});

test("stale-binding cases: a changed, missing, remote or re-pointed workspace is refused before ahub is run, and nothing is replaced or opened", async () => {
  const s = setup({ stdout: REAL(), exitCode: 0 });
  const refused = async (expected: string) => {
    const r = await s.instance.status({ snapshot: s.snapshot });
    expect(r).toMatchObject({ ok: false, refusal: expected });
    expect(s.cli.calls).toHaveLength(0); expect(s.host.calls.filter(m => m === "workspace.open" || m === "terminal.create")).toEqual([]); expect(s.fake.openedWorkspaceIds).toEqual([]);
  };
  const row = { id: "ws-a", kind: "worktree" as const, name: "n", path: s.root, branch: null, hostId: "local" };
  s.fake.setRoster([]); await refused("missing");
  s.fake.setRoster([{ ...row, path: join(s.base, "elsewhere") }]); await refused("unreal_root");
  const other = join(s.base, "other"); mkdirSync(other);
  s.fake.setRoster([{ ...row, path: other }]); await refused("changed");
  s.fake.setRoster([{ ...row, hostId: "ssh-box" }]); await refused("remote");
  s.fake.setRoster([row], true); await refused("truncated");
  s.fake.setRoster([row, { ...row, id: "ws-b", path: other }]);
  // a snapshot of one project never reads another: asking for ws-a's status runs only in ws-a's folder
  const ok = await s.instance.status({ snapshot: s.snapshot });
  expect(ok.ok).toBe(true);
  expect(s.cli.calls.map(c => c.cwd)).toEqual([s.root]);
  // odd inputs are refused before anything is read
  for (const input of [undefined, {}, { snapshot: { ...s.snapshot, extra: 1 } }, { snapshot: s.snapshot, kind: "console" }, "x"]) expect(await s.instance.status(input)).toMatchObject({ ok: false, refusal: "bad_request" });
  expect(s.cli.calls).toHaveLength(1);
});

test("refresh is a user action only: no poller, no transcript read, no write, no new host method, and the manifest is unchanged", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, "..", "integrations/orca", rel), "utf8");
  const code = (text: string) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const worker_ = code(read("src/worker.mjs")), status_ = code(read("src/status.mjs")), panel = code(read("panel/index.html"));
  for (const [name, text] of [["worker", worker_], ["status", status_], ["panel", panel]] as const) {
    expect(text, name).not.toMatch(/setInterval|requestAnimationFrame|EventSource|WebSocket|fetch\(|XMLHttpRequest|writeFile|appendFile|readFile|createReadStream|\.sendText|terminal\.read|transcript/i);
  }
  // the panel's only timer is the one-time link's expiry; there is no recurring one
  expect(panel.match(/setTimeout\(/g)).toHaveLength(1);
  // status is reached from a click and nowhere else
  expect(panel.match(/ask\("status\.read"/g)).toHaveLength(1);
  expect(panel).toMatch(/\$\("statusbtn"\)\.addEventListener\("click", readStatus\)/);
  expect([...panel.matchAll(/readStatus\(\)/g)].length).toBe(1); // the declaration only: nothing calls it on load, focus or a timer
  // the host methods the worker uses are unchanged from O1, so the manifest asks for nothing new
  const used = [...new Set([...worker_.matchAll(/host\.(?:call|has)\("([a-z.A-Z]+)"/g)].map(m => m[1]))].sort();
  expect(used).toEqual(["settings.get", "terminal.create", "workspace.list", "workspace.open"]);
  expect(JSON.parse(read("orca-plugin.json")).capabilities.map((c: { kind: string }) => c.kind).sort()).toEqual(["settings:own", "terminal:send", "workspace:read", "workspace:write"]);
  // no terminal focus: nothing in the plugin calls `orca terminal switch` or maps a plugin terminal id to a CLI handle
  expect(worker_ + status_ + panel).not.toMatch(/terminal switch|"switch"|terminalId|--terminal|orca terminal/);
});

test("the real child port reports only a boolean about stderr and keeps none of it", async () => {
  const base = temp("real"), folder = join(base, "p q"); mkdirSync(folder);
  const script = join(base, "ahub");
  writeFileSync(script, `#!/bin/sh\necho "ahub: no hub running for /Users/secret/state (run: ahub up)" >&2\nexit 1\n`); chmodSync(script, 0o755);
  const off = await worker.realSpawnCli({ executable: script, argv: ["status", "--json"], cwd: folder, hostId: null, timeoutMs: 5000, maxOutputBytes: 4096 });
  expect(off).toMatchObject({ exitCode: 1, stderr: "", stdout: "", stderrSaysNoHub: true });
  expect(JSON.stringify(off)).not.toContain("secret");
  writeFileSync(script, `#!/bin/sh\necho "Error: /Users/secret/other" >&2\nexit 1\n`); chmodSync(script, 0o755);
  expect(await worker.realSpawnCli({ executable: script, argv: [], cwd: folder, hostId: null, timeoutMs: 5000, maxOutputBytes: 4096 })).toMatchObject({ exitCode: 1, stderr: "", stderrSaysNoHub: false });
  writeFileSync(script, `#!/bin/sh\nprintf '%s' '{"version":"1.0.0"}'\n`); chmodSync(script, 0o755);
  expect(await worker.realSpawnCli({ executable: script, argv: [], cwd: folder, hostId: null, timeoutMs: 5000, maxOutputBytes: 4096 })).toMatchObject({ exitCode: 0, stdout: '{"version":"1.0.0"}', stderrSaysNoHub: false });
});
