import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Registry } from "../src/hub/registry.ts";
import { realPath } from "../src/hub/project.ts";
import { USER, HUB } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { approvalBinding } from "../src/hub/task-approval.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const roster: Record<string, boolean> = {};
  const root = mkdtempSync(join(tmpdir(), "ahub-adopt-merge-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0, rostered: peer => roster[peer] !== false });
  const calls: string[][] = [], notices: string[] = [], roles: Record<string, "conductor"[]> = { claude: ["conductor"] };
  let config = sdlcConfig({ mode: "enforce", required_checks: ["gate"], auto_merge: "on" });
  let privateTurn = false, sessionCurrent = true, hold = false, onRead: ((index: number) => void) | undefined;
  const world = { head: HEAD, state: "MERGED", checks: [{ name: "gate", conclusion: "SUCCESS" }], unavailable: false, review: "APPROVED" as string | null, requests: [] as unknown[] | undefined, threads: [] as { isResolved: boolean }[] | undefined, threadsComplete: true, requestsComplete: true, checksComplete: true, commitHead: undefined as string | undefined, errors: undefined as unknown[] | undefined };
  const gh: SdlcGh = async args => {
    calls.push(args);
    expect(args[0] === "api" && args[1] === "graphql").toBe(true);
    expect(args.some(arg => arg.includes("mutation"))).toBe(false);
    onRead?.(calls.length);
    if (world.unavailable) return { code: 1, stdout: "PRIVATE_PROVIDER_ERROR" };
    return { code: 0, stdout: JSON.stringify({ errors: world.errors, data: { repository: { pullRequest: {
      headRefOid: world.head, state: world.state, reviewDecision: world.review, isDraft: false, mergeCommit: { oid: OTHER },
      commits: { nodes: [{ commit: { oid: world.commitHead ?? world.head, statusCheckRollup: { contexts: { nodes: world.checks, pageInfo: { hasNextPage: !world.checksComplete } } } } }] },
      reviewRequests: { nodes: world.requests, pageInfo: { hasNextPage: !world.requestsComplete } },
      reviewThreads: { nodes: world.threads, pageInfo: { hasNextPage: !world.threadsComplete } },
    } } } }) };
  };
  const tasks = new Tasks({ board, bus, roles, cwd: root, project: "fixture", repository: "owner/repo", routing: () => loadRouting(root), notify: line => notices.push(line),
    privateTurn: () => privateTurn, sweepHeld: () => hold, requestAuthority: () => () => sessionCurrent ? undefined : "session changed; reconnect and retry ahub sdlc adopt-merge",
    sdlc: { config: () => config, gh } });
  const task = board.propose(USER, { title: "PRIVATE_TITLE", class: "implement" });
  board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "kimi", refs: { commit: HEAD }, sdlc: { repo: "owner/repo", pr: 7, stage: "build" } });
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, board, bus, roster, tasks, roles, calls, world, notices, id: task.id,
    setRead: (fn: typeof onRead) => { onRead = fn; }, setPrivate: () => { privateTurn = true; }, revokeSession: () => { sessionCurrent = false; },
    hold: () => { hold = true; }, config: (value: Record<string, unknown>) => { config = sdlcConfig(value); } };
}
function important(f: ReturnType<typeof fixture>) {
  f.board.update(f.id, USER, "done", { state: "in_review" });
  f.board.update(f.id, USER, "changes_requested", { state: "changes_requested" }, undefined, { reviewFindings: { head: HEAD, items: [{ id: "safety", pass: "bugs", severity: "important", disposition: "open", rationale: "PRIVATE_FINDING" }] } });
}
async function refused(f: ReturnType<typeof fixture>, reason: string, by = USER, pr: unknown = 7) {
  const before = f.board.get(f.id)!;
  await expect(f.tasks.adoptMerge(by, f.id, pr)).rejects.toThrow(reason);
  expect(f.board.get(f.id)).toEqual(before);
  expect(f.notices).toHaveLength(0);
}

test("AC4: observed merge approves and releases dependents without a reviewer verdict, gh merge or cleanup", async () => {
  const f = fixture();
  const child = f.board.propose(USER, { title: "dependent", class: "answer", deps: [f.id] });
  const result = await f.tasks.adoptMerge(USER, f.id, 7);
  expect(result).toEqual({ task: f.id, state: "approved" });
  const now = f.board.get(f.id)!;
  expect(now.state).toBe("approved");
  expect(now.history.at(-1)).toMatchObject({ by: USER, event: "merged outside the hub", note: `PR #7 merged outside the hub at ${HEAD}` });
  expect(now.history.some(entry => entry.event === "approved")).toBe(false);
  expect(now.sdlc?.reviewedHead).toBeUndefined(); expect(now.sdlc?.merge).toBeUndefined();
  expect(f.board.get(child.id)!.history.some(entry => entry.event === "ready")).toBe(true);
  expect(f.calls).toHaveLength(1);
  expect(f.notices.join("\n")).not.toContain("PRIVATE_TITLE");
  const count = f.calls.length;
  await expect(f.tasks.adoptMerge(USER, f.id, 7)).rejects.toThrow("open active task");
  expect(f.calls).toHaveLength(count);
});

test("explicit PR binds an unlinked merged artifact only in the established task repository", async () => {
  const f = fixture(); f.board.update(f.id, USER, "unlinked PR", { sdlc: { repo: "owner/repo", stage: "build" } });
  await f.tasks.adoptMerge(USER, f.id, 7);
  expect(f.board.get(f.id)!.sdlc).toMatchObject({ repo: "owner/repo", pr: 7 });
  expect(f.board.get(f.id)!.sdlc?.reviewedHead).toBeUndefined();
});
test("repository URL and checkout path aliases share the task's repository identity", async () => {
  for (const alias of ["https://github.com/owner/repo.git", "path"]) {
    const f = fixture(); f.board.update(f.id, USER, "repository alias", { refs: { repo: alias === "path" ? f.root : alias } });
    await f.tasks.adoptMerge(USER, f.id, 7);
    expect(f.board.get(f.id)!.state).toBe("approved");
  }
});
test("known-zero review coverage permits adoption without a GitHub reviewer verdict", async () => {
  const f = fixture(); f.world.review = null; await f.tasks.adoptMerge(USER, f.id, 7);
  expect(f.board.get(f.id)!.history.some(entry => entry.event === "approved")).toBe(false);
});
test("unknown, incomplete or open PR review evidence refuses with a next step", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.world.threads = undefined; },
    (f: ReturnType<typeof fixture>) => { f.world.threadsComplete = false; },
    (f: ReturnType<typeof fixture>) => { f.world.threads = [{ isResolved: false }]; },
    (f: ReturnType<typeof fixture>) => { f.world.requests = undefined; },
    (f: ReturnType<typeof fixture>) => { f.world.requests = [{}]; },
    (f: ReturnType<typeof fixture>) => { f.world.review = "CHANGES_REQUESTED"; },
  ]) {
    const f = fixture(); mutate(f); await refused(f, "before retrying ahub sdlc adopt-merge");
  }
});

test("partial check/request pages, GraphQL errors and a mismatched head commit never establish evidence", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.world.checksComplete = false; },
    (f: ReturnType<typeof fixture>) => { f.world.requestsComplete = false; },
    (f: ReturnType<typeof fixture>) => { f.world.commitHead = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.world.errors = [{ message: "PRIVATE_REMOTE_ERROR" }]; },
  ]) {
    const f = fixture(); mutate(f); await refused(f, "ahub sdlc adopt-merge");
  }
});

test("one coherent snapshot catches a same-head check rerun or a head move during the read", async () => {
  const rerun = fixture(); rerun.setRead(() => { rerun.world.checks = [{ name: "gate", conclusion: "IN_PROGRESS" }]; });
  await refused(rerun, "required check gate: pending"); expect(rerun.calls).toHaveLength(1);
  const pushed = fixture(); pushed.setRead(() => { pushed.world.head = OTHER; }); await refused(pushed, "last recorded full head");
});
test("adoption cannot revive a withdrawn historical reviewer approval binding", async () => {
  const f = fixture(); f.board.update(f.id, USER, "done", { state: "in_review" });
  f.board.update(f.id, "kimi", "approved", { state: "approved", sdlc: { repo: "owner/repo", pr: 7, stage: "merge", reviewedHead: HEAD } }, undefined, { reviewedHead: HEAD });
  f.board.update(f.id, "kimi", "changes_requested", { state: "changes_requested" }, undefined, undefined, f.board.get(f.id)!.history.length);
  // The owner resumed work; the historical reviewer verdict remains a historical fact.
  f.board.update(f.id, "codex", "accepted", { state: "in_progress" });
  await f.tasks.adoptMerge(USER, f.id, 7);
  const now = f.board.get(f.id)!;
  expect(now.history.filter(entry => entry.event === "approved")).toHaveLength(1);
  expect(approvalBinding(now)).toBeUndefined();
});

test("AC4: PR not merged refuses", async () => { const f = fixture(); f.world.state = "OPEN"; await refused(f, "PR is not merged"); });
test("AC4: head mismatch refuses", async () => { const f = fixture(); f.world.head = OTHER; await refused(f, "last recorded full head"); });
test.each(["FAILURE", "IN_PROGRESS", "UNKNOWN", "MISSING"])("AC4: required check %s refuses with its name and a next step", async state => {
  const f = fixture(); f.world.checks = state === "MISSING" ? [] : [{ name: "gate", conclusion: state }];
  await refused(f, "required check gate:");
});
test("AC4: no configured required checks refuses", async () => { const f = fixture(); f.config({ mode: "enforce" }); await refused(f, "required checks unknown"); });
test("AC4: open Important finding refuses before GitHub", async () => { const f = fixture(); important(f); await refused(f, "open Important finding"); expect(f.calls).toHaveLength(0); });
test("AC4: non-conductor agents and HUB refuse before GitHub", async () => { for (const by of ["codex", HUB]) { const f = fixture(); await refused(f, "current configured conductor", by); expect(f.calls).toHaveLength(0); } });
test("current configured conductor is retained as the adoption actor", async () => {
  const f = fixture(); await f.tasks.adoptMerge("claude", f.id, 7);
  expect(f.board.get(f.id)!.history.at(-1)).toMatchObject({ by: "claude", event: "merged outside the hub" });
});
test("ambiguous or off-roster conductor refuses", async () => {
  const f = fixture(); f.roles.codex = ["conductor"]; await refused(f, "current configured conductor", "claude");
  const off = fixture(); off.roster.claude = false; await refused(off, "current configured conductor", "claude");
});
test("PR identity, missing full head and unreadable evidence refuse without provider text", async () => {
  const wrong = fixture(); await refused(wrong, "recorded artifact", USER, 8); expect(wrong.calls).toHaveLength(0);
  const missing = fixture(); missing.board.update(missing.id, USER, "head missing", { refs: { commit: undefined } }); await refused(missing, "no recorded full head");
  const repo = fixture(); repo.board.update(repo.id, USER, "repo mismatch", { refs: { repo: "other/repo", commit: HEAD } }); await refused(repo, "recorded artifact");
  const unknown = fixture(); unknown.world.unavailable = true; await refused(unknown, "restore GitHub access");
});
test("private task and turn refuse for the person and conductor before GitHub", async () => {
  for (const by of [USER, "claude"]) {
    const f = fixture(); f.board.update(f.id, USER, "private", { signals: ["pii"] }); await refused(f, "private task", by); expect(f.calls).toHaveLength(0);
    const turn = fixture(); turn.setPrivate(); await refused(turn, "private turn", by); expect(turn.calls).toHaveLength(0);
  }
});
test("every awaited gh read fences task flow, repository, head, findings, privacy, policy and current authority", async () => {
  const flips: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["task", f => { f.board.update(f.id, USER, "changed", {}); }],
    ["repository", f => { f.board.update(f.id, USER, "relinked", { sdlc: { repo: "other/repo", pr: 7, stage: "build" } }); }],
    ["head", f => { f.board.update(f.id, USER, "new head", { refs: { commit: OTHER } }); }],
    ["findings", important], ["privacy", f => { f.board.update(f.id, USER, "private", { signals: ["pii"] }); }],
    ["policy", f => { f.config({ mode: "enforce", required_checks: ["new-gate"] }); }],
    ["conductor", f => { f.roles.claude = []; }], ["session", f => { f.revokeSession(); }],
    ["private turn", f => { f.setPrivate(); }], ["hold", f => { f.hold(); }],
  ];
  for (const at of [1]) for (const [name, flip] of flips) {
    const f = fixture(); f.setRead(index => { if (index === at) flip(f); });
    await expect(f.tasks.adoptMerge("claude", f.id, 7), `${name} at read ${at}`).rejects.toThrow();
    expect(f.board.get(f.id)!.state).not.toBe("approved");
    expect(f.board.get(f.id)!.history.some(entry => entry.event === "merged outside the hub")).toBe(false);
    expect(f.calls.length).toBe(at);
  }
});
test("daemon-supplied currentness fence is rechecked after each read", async () => {
  const f = fixture(); let current = true;
  f.setRead(index => { if (index === 1) current = false; });
  await expect(f.tasks.adoptMerge(USER, f.id, 7, () => current ? undefined : "connection changed; reconnect and retry")).rejects.toThrow("connection changed");
  expect(f.board.get(f.id)!.state).toBe("in_progress");
});
test("CLI policy admits only conductor routing and refuses delegated person attribution", () => {
  expect(classifyPeerCommand("sdlc", ["adopt-merge", "1", "--pr", "7"])).toBe("conductor");
  expect(liveTestRefusal("sdlc", ["adopt-merge", "1", "--pr", "7"])).toBe(true);
});

test("adopt-merge control requests always reply to invalid arguments, missing task and unauthorized callers", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-adopt-control-")), stateDir = join(root, "state");
  mkdirSync(stateDir); writeFileSync(join(root, "package.json"), JSON.stringify({ name: "adopt-fixture", version: "1.0.0" }));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
    client = await ControlClient.connect(stateDir, { role: "console" });
    for (const pr of [0, -1, "7", undefined]) expect((await client.request({ t: "sdlc", op: "adopt-merge", id: 1, pr })).ok).toBe(false);
    expect(await client.request({ t: "sdlc", op: "adopt-merge", id: 999, pr: 7 })).toMatchObject({ ok: false });
    client.close(); client = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" });
    expect(await client.request({ t: "sdlc", op: "adopt-merge", id: 1, pr: 7 })).toMatchObject({ ok: false, error: expect.stringContaining("conductor") });
  } finally { client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI sends the exact task/PR request, prints approval and refuses invalid or delegated forms before adoption", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-adopt-cli-"))), stateDir = join(root, ".agenthub", "state"), calls: Record<string, unknown>[] = [];
  mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub", "config.json"), "{}");
  const registry = new Registry(join(root, "home", "registry.db")), project = registry.register(root, stateDir); registry.close();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("unexpected"); },
    websocket: { message(sock, raw) {
      const message = JSON.parse(String(raw));
      if (message.t === "hello") sock.send(JSON.stringify({ t: "welcome", rid: message.rid, ok: true, cwd: root, projectId: project.id, instanceId: "fixture" }));
      else { calls.push(message); sock.send(JSON.stringify({ rid: message.rid, ok: true, task: 1, state: "approved" })); }
    } } });
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: server.port, pid: process.pid, projectId: project.id, instanceId: "fixture" }));
  const cli = join(import.meta.dir, "../src/cli/main.ts");
  const run = async (args: string[], agent = false) => {
    const wrapper = join(root, `run-${crypto.randomUUID()}.ts`);
    writeFileSync(wrapper, `for (const key of Object.keys(process.env)) if (key.startsWith("AGENTHUB_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key === "CODEX_THREAD_ID") delete process.env[key];\nObject.assign(process.env, { HOME: ${JSON.stringify(root)}, AGENTHUB_HOME: ${JSON.stringify(join(root, "home"))}, ${agent ? 'AGENTHUB_PEER_ID: "codex",' : ""} });\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];\nawait import(${JSON.stringify(cli)});\n`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    const accepted = await run(["sdlc", "adopt-merge", "1", "--pr", "7"]);
    expect(accepted.code, accepted.stderr).toBe(0); expect(accepted.stdout).toContain("merged outside the hub; approved");
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ t: "sdlc", op: "adopt-merge", id: 1, pr: 7 });
    const invalid = await run(["sdlc", "adopt-merge", "1", "--pr", "bad"]);
    expect(invalid.code).toBe(1); expect(invalid.stderr).toContain("usage:"); expect(calls).toHaveLength(1);
    const delegated = await run(["--live-test", "sdlc", "adopt-merge", "1", "--pr", "7"], true);
    expect(delegated.code).toBe(1); expect(delegated.stderr).toContain("live-test"); expect(calls).toHaveLength(1);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
