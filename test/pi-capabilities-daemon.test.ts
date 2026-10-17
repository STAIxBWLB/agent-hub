import { startFakeModelServer } from "./fakes/model-server.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG, type DaemonOptions } from "../src/hub/daemon.ts";
import { Board, type Task } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import type { CheckRequest, RunReceipt, RunnerOptions, RunnerState } from "../src/hub/check-runner.ts";
import { CHECK_IMAGE } from "../src/hub/check-runner.ts";
import { randomUUID } from "node:crypto";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
class Peer extends BasePeer {
  received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envelopes: Envelope[]) { this.received.push(...envelopes); }
}
async function fixture(extra: { caps?: Record<string, string[]>; fetch?: NonNullable<DaemonOptions["boundedTools"]>["fetchSpec"]; available?: boolean; availability?: (signal?: AbortSignal) => Promise<RunnerState>; staleDeliver?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-capability-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/owner/project.git"]]) {
    const r = hubGitSync(["-C", root, ...args], { encoding: "utf8" }); if (r.status) throw new Error("fixture git failed");
  }
  const stateDir = join(root, "state"), records = new Map<string, RunReceipt>(), completions = new Map<string, (r: RunReceipt) => void>();
  let runnerOptions!: RunnerOptions, fetches = 0, cancelled = 0, consumed = 0, probes = 0;
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, native: false, enabled: false }, snapshots: { enabled: false, keep: 1 },
      experiments: extra.staleDeliver ? { stale_notices: "deliver" } : undefined,
      local: { ...DEFAULT_CONFIG.local, deny: [...DEFAULT_CONFIG.local.deny, "private/"] }, capabilities: extra.caps ?? {} },
    boundedTools: {
      specAvailable: async () => { probes++; return { available: true }; },
      fetchSpec: extra.fetch ?? (async (repo, n, opts) => { fetches++; const body = "complete spec\nlast line"; if (!await opts.screen(`safe title\n${body}`)) throw new Error("spec withheld by privacy policy"); return { number: n, title: "safe title", body, state: "open", updated_at: "2026-10-17", html_url: `https://github.com/${repo}/issues/${n}` }; }),
      runner: options => {
        runnerOptions = options;
        return {
          available: extra.availability ?? (async () => ({ available: extra.available ?? true, reason: "fake unavailable" })), sweep: async () => [], stopAll: async () => {},
          start: (request: CheckRequest) => {
            const run = randomUUID();
            records.set(run, { ...request, run, status: "running", sha: "a".repeat(40), tree: "b".repeat(40), lockfile: "c".repeat(64), excluded: 0, dependency_files: 10,
              runner: "container", image: CHECK_IMAGE, platform: "linux/arm64 (apple-container fake)", container: `agenthub-check-${run}`, hub_pid: 42, hub_signature: "private signature", created: Date.now(),
              exit: null, timed_out: false, cancelled: false, interrupted: false, duration_ms: 1, tail: "", output_bytes: 0, truncated: false, output_withheld: false });
            return { run, done: new Promise<RunReceipt>(resolve => completions.set(run, resolve)) };
          },
          result: async run => { const r = records.get(run); return r ? { ...r } : undefined; },
          consumeOutput: async () => { consumed++; }, cancel: async () => { cancelled++; },
          markStale: async run => { const r = records.get(run); if (r) r.status = "stale"; },
        };
      },
    },
  });
  cleanups.push(() => daemon.stop());
  const board = new Board(join(stateDir, "hub.db")); cleanups.push(() => board.close());
  const peers: Record<string, Peer> = {};
  for (const name of ["codex", "kimi", "pi"]) { const peer = new Peer(name); peers[name] = peer; daemon.bus.add(peer); await peer.start(); }
  const clients = new Map<string, ControlClient>();
  const call = async (by: string, op: string, args: Record<string, unknown>) => {
    let client = clients.get(by);
    if (!client) { client = await ControlClient.connect(stateDir, by === "user" ? { role: "console" } : { role: "tools", peer: by }); clients.set(by, client); cleanups.push(() => client!.close()); }
    return client.request({ t: "task", op, args });
  };
  const task = (patch: Partial<Task> = {}) => {
    const t = board.propose("user", { title: patch.title ?? "work #418", class: "implement", detail: patch.detail ?? "complete assigned contract", refs: { branch: "main" }, ...(patch.external ? { external: patch.external } : {}) });
    return board.update(t.id, "user", "accepted", { owner: "codex", reviewer: "kimi", state: "in_progress", ...patch });
  };
  const complete = async (run: string, patch: Partial<RunReceipt> = {}) => {
    const r = records.get(run)!; Object.assign(r, { status: "finished", exit: 0, ...patch });
    await runnerOptions.onResult?.({ ...r }); completions.get(run)?.({ ...r });
  };
  return { root, stateDir, daemon, board, task, call, peers, records, complete, options: () => runnerOptions,
    counts: () => ({ fetches, cancelled, consumed, probes }) };
}

test("bounded spec is current owner/reviewer only, strict input and non-PII/non-backlog (#418)", async () => {
  const f = await fixture(), task = f.task();
  for (const by of ["codex", "kimi"]) {
    const reply = await f.call(by, "hub_task_spec", { id: task.id });
    expect(reply.ok).toBe(true); expect(JSON.parse(reply.text).specs[0].body).toBe("complete spec\nlast line");
  }
  for (const args of [{ id: String(task.id) }, { id: task.id, repo: "foreign/repo" }, { id: 0 }]) expect((await f.call("codex", "hub_task_spec", args)).ok).toBe(false);
  expect((await f.call("pi", "hub_task_spec", { id: task.id })).ok).toBe(false);
  const backlog = f.board.propose("user", { title: "backlog #418", class: "implement", backlog: true });
  expect((await f.call("codex", "hub_task_spec", { id: backlog.id })).ok).toBe(false);
  expect(f.counts().fetches).toBe(2);
});

test("capability narrowing and PII context refuse before spec fetch/check execution (#418)", async () => {
  const f = await fixture({ caps: { codex: [] } }), t = f.task();
  expect((await f.call("codex", "hub_task_spec", { id: t.id })).error).toContain("spec_read");
  expect((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).error).toContain("check_run");
  expect(f.counts().fetches).toBe(0); expect(f.records.size).toBe(0);
  const g = await fixture(); const safe = g.task();
  g.task({ title: "private 900101-1234567", signals: ["pii"] });
  expect((await g.call("codex", "hub_task_spec", { id: safe.id })).error).toContain("PII turn");
  expect((await g.call("codex", "hub_check_start", { id: safe.id, check: "typecheck" })).ok).toBe(false);
  expect(g.counts().fetches).toBe(0); expect(g.records.size).toBe(0);
});

test("spec rechecks owner after fetch and whole-result privacy/cap before response (#418)", async () => {
  let change: (() => void) | undefined;
  const f = await fixture({ fetch: async (_repo, n) => { change?.(); return { number: n, title: "safe", body: "private/key.txt", state: "open", updated_at: "now", html_url: "https://github.com/owner/project/issues/418" }; } });
  const t = f.task();
  expect((await f.call("codex", "hub_task_spec", { id: t.id })).error).toBe("spec withheld by privacy policy");
  change = () => { f.board.update(t.id, "user", "moved", { owner: "kimi" }); };
  expect((await f.call("codex", "hub_task_spec", { id: t.id })).ok).toBe(false);
  const g = await fixture({ fetch: async (_repo, n) => ({ number: n, title: "safe", body: "x".repeat(45000), state: "open", updated_at: "now", html_url: `https://github.com/owner/project/issues/${n}` }) });
  const combined = g.task({ title: "#418 #419" });
  expect((await g.call("codex", "hub_task_spec", { id: combined.id })).error).toBe("too large");
});

test("isolated checks bind source, owner and generation, expose only public receipt fields (#418)", async () => {
  const f = await fixture(), t = f.task();
  const started = await f.call("codex", "hub_check_start", { id: t.id, check: "test", files: ["test/server.test.ts"] });
  expect(started.ok).toBe(true); const { run } = JSON.parse(started.text);
  expect(f.records.get(run)).toMatchObject({ owner: "codex", task: t.id, ref: "main", updated: t.updated });
  expect(f.options().isCurrent?.(f.records.get(run)!)).toBe(true);
  await f.complete(run, { exit: 1, tail: "one failing test", output_bytes: 16 });
  const result = await f.call("codex", "hub_check_result", { run }); expect(result.ok).toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({ run, exit: 1, tail: "one failing test" });
  for (const field of ["generation", "revision", "owner", "ref", "hub_pid", "hub_signature", "container", "created", "dependency_files"]) expect(JSON.parse(result.text)[field]).toBeUndefined();
  expect(f.counts().consumed).toBe(1);
  expect((await f.call("kimi", "hub_check_result", { run })).ok).toBe(false);
  expect((await f.call("codex", "hub_check_result", { run, path: "/tmp" })).ok).toBe(false);
});

test("output is screened whole before result and completion envelope; stale runs are person-only (#418)", async () => {
  const f = await fixture(), t = f.task();
  const { run } = JSON.parse((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).text);
  await f.complete(run, { tail: "private/key.txt", error: "private/key.txt" });
  const result = JSON.parse((await f.call("codex", "hub_check_result", { run })).text);
  expect(result.tail).toBe(""); expect(result.error).toBeUndefined(); expect(result.output_withheld).toBe(true);
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8")).not.toContain("private/key.txt");
  const second = JSON.parse((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).text).run;
  f.board.update(t.id, "user", "changed", { owner: "kimi" });
  await f.complete(second, { tail: "must stay person-only" });
  expect(f.records.get(second)?.status).toBe("stale");
  expect((await f.call("codex", "hub_check_result", { run: second })).ok).toBe(false);
  f.task({ owner: "user", title: "private 900101-1234567", signals: ["pii"] });
  f.board.update(t.id, "user", "privacy changed", { signals: ["pii"] });
  expect((await f.call("user", "hub_check_result", { run: second })).ok).toBe(true);
});

test("native connection replacement invalidates checks and unavailable runner never starts (#418)", async () => {
  const f = await fixture(), t = f.task();
  const { run } = JSON.parse((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).text);
  await f.peers.codex!.stop();
  const replacement = new Peer("codex"); f.daemon.bus.add(replacement); await replacement.start();
  expect(f.options().isCurrent?.(f.records.get(run)!)).toBe(false);
  await f.complete(run); expect(f.records.get(run)?.status).toBe("stale");
  const g = await fixture({ available: false }), u = g.task();
  expect((await g.call("codex", "hub_check_start", { id: u.id, check: "typecheck" })).error).toContain("runner unavailable");
  expect(g.records.size).toBe(0);
});


test("check requests reject free commands, unsafe files and extra authority fields; cancel stays owner-scoped (#418)", async () => {
  const f = await fixture(), t = f.task();
  for (const args of [
    { id: t.id, check: "shell", command: "true" }, { id: t.id, check: "test" },
    { id: t.id, check: "test", files: ["test/../secret.test.ts"] }, { id: t.id, check: "typecheck", files: [] },
    { id: t.id, check: "typecheck", owner: "kimi" },
  ]) expect((await f.call("codex", "hub_check_start", args)).ok).toBe(false);
  expect(f.records.size).toBe(0);
  const { run } = JSON.parse((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).text);
  expect((await f.call("kimi", "hub_check_cancel", { run })).ok).toBe(false);
  expect((await f.call("codex", "hub_check_cancel", { run })).ok).toBe(true);
  expect(f.counts().cancelled).toBe(1);
  await f.complete(run, { cancelled: true });
});


test("queued completion drops at delivery after same-ms task revision change, despite stale-notice ablation (#418)", async () => {
  const f = await fixture({ staleDeliver: true }), t = f.task();
  const { run } = JSON.parse((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).text);
  const bound = f.records.get(run)!;
  expect(bound.revision).toBe(t.history.length);
  f.daemon.bus.pause("codex");
  await f.complete(run, { tail: "must not reach the model after a task revision" });
  expect(f.daemon.bus.queued("codex")).toBeGreaterThan(0);
  const now = Date.now;
  try {
    Date.now = () => t.updated;
    f.board.update(t.id, "user", "refs changed at same millisecond", { refs: { branch: "different-source" } });
  } finally { Date.now = now; }
  expect(f.board.get(t.id)!.updated).toBe(t.updated);
  expect(f.options().isCurrent?.(bound)).toBe(false);
  f.daemon.bus.resume("codex");
  for (let attempt = 0; attempt < 100 && (f.daemon.bus.queued("codex") || f.records.get(run)?.status !== "stale"); attempt++) await Bun.sleep(5);
  expect(f.daemon.bus.queued("codex")).toBe(0);
  expect(f.records.get(run)?.status).toBe("stale");
  expect(f.peers.codex!.received.some(envelope => envelope.refs?.boundedCheck === run)).toBe(false);
  expect((await f.call("codex", "hub_check_result", { run })).ok).toBe(false);
});


test("queued completion screens raw tail again after the privacy policy changes (#418)", async () => {
  const f = await fixture(), t = f.task();
  const { run } = JSON.parse((await f.call("codex", "hub_check_start", { id: t.id, check: "typecheck" })).text);
  f.daemon.bus.pause("codex");
  await f.complete(run, { tail: "newly-private content" });
  mkdirSync(join(f.root, ".agenthub"), { recursive: true });
  const policy = readFileSync(join(import.meta.dir, "..", "templates", "routing.toml"), "utf8").replace(/^pii_patterns =.*$/m, `pii_patterns = [${JSON.stringify("(^|\\n)newly-private")}]`);
  writeFileSync(join(f.root, ".agenthub", "routing.toml"), policy);
  expect(f.options().isCurrent?.(f.records.get(run)!)).toBe(true);
  f.daemon.bus.resume("codex");
  for (let attempt = 0; attempt < 100 && (f.daemon.bus.queued("codex") || f.records.get(run)?.status !== "stale"); attempt++) await Bun.sleep(5);
  expect(f.daemon.bus.queued("codex")).toBe(0);
  expect(f.records.get(run)?.status).toBe("stale");
  expect(f.peers.codex!.received.some(envelope => envelope.refs?.boundedCheck === run)).toBe(false);
});


test("imported GitHub task reads its canonical assigned issue without textual references (#418)", async () => {
  const requested: { repo: string; issue: number }[] = [];
  const f = await fixture({ fetch: async (repo, issue) => {
    requested.push({ repo, issue });
    return { number: issue, title: "Complete imported contract", body: "All acceptance details", state: "open", updated_at: "now", html_url: `https://github.com/${repo}/issues/${issue}` };
  } });
  const task = f.task({ title: "Fix the workflow", detail: "Implement the full contract", refs: {},
    external: { provider: "github", repo: "owner/project", issue: 418, url: "https://github.com/owner/project/issues/418" } });
  const reply = await f.call("codex", "hub_task_spec", { id: task.id });
  expect(reply.ok).toBe(true);
  expect(requested).toEqual([{ repo: "owner/project", issue: 418 }]);
  expect(JSON.parse(reply.text).specs[0].body).toBe("All acceptance details");
});


test("person inspection keeps owner output until the owner reads its result (#418 rework)", async () => {
  const f = await fixture(), task = f.task();
  const { run } = JSON.parse((await f.call("codex", "hub_check_start", { id: task.id, check: "typecheck" })).text);
  await f.complete(run, { tail: "owner output" });
  expect((await f.call("user", "hub_check_result", { run })).ok).toBe(true);
  expect(f.counts().consumed).toBe(0);
  expect((await f.call("codex", "hub_check_result", { run })).ok).toBe(true);
  expect(f.counts().consumed).toBe(1);
});

test("pending availability refresh retains the last confirmed capability until its result (#418 rework)", async () => {
  const checkedAt = Date.now(); let calls = 0, settle!: (value: RunnerState) => void;
  const f = await fixture({ availability: async () => ++calls === 1 ? { available: true, checkedAt } : new Promise<RunnerState>(resolve => { settle = resolve; }) });
  const client = await ControlClient.connect(f.stateDir, { role: "console" }); cleanups.push(() => client.close());
  const originalNow = Date.now;
  try {
    Date.now = () => checkedAt + 60_001;
    expect((await client.request({ t: "status" })).status.taskCapabilities.pi.tests).toBe(true);
    expect(calls).toBe(2);
    settle({ available: false, reason: "service stopped", checkedAt: Date.now() });
    await Bun.sleep(0);
    expect((await client.request({ t: "status" })).status.taskCapabilities.pi.tests).toBe(false);
  } finally { Date.now = originalNow; }
});


test("direct local control start refreshes failed spec auth without restarting (#418 rework)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-lazy-local-")), project = join(root, "project"), bin = join(root, "bin");
  mkdirSync(project); mkdirSync(bin); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const authReady = join(root, "auth-ready");
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['auth','status','--hostname','github.com'])) process.exit(2); if (!require('node:fs').existsSync(${JSON.stringify(authReady)})) process.exit(4);`);
  chmodSync(join(bin, "gh"), 0o755);
  const previousPath = process.env.PATH, previousKey = process.env.OMNIROUTE_API_KEY;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  delete process.env.OMNIROUTE_API_KEY;
  const apiKeyFile = join(root, "fixture-api-key"); writeFileSync(apiKeyFile, "fixture-only-key");
  const model = startFakeModelServer({ key: "fixture-only-key" });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd: project, stateDir: join(project, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
        omniroute: { urls: [model.url], access_hosts: [], api_key_file: apiKeyFile }, snapshots: { enabled: false, keep: 1 } } });
    client = await ControlClient.connect(join(project, "state"), { role: "console" });
    const before = (await client.request({ t: "status" })).status;
    expect(before.taskCapabilities.local.spec).toBe(false);
    expect(await client.request({ t: "start", peer: "local", args: { model: "m" } })).toMatchObject({ ok: true });
    expect((await client.request({ t: "status" })).status.taskCapabilities.local.spec).toBe(false);
    writeFileSync(authReady, "ready");
    expect(await client.request({ t: "start", peer: "local", args: { model: "m" } })).toMatchObject({ ok: true });
    const after = (await client.request({ t: "status" })).status;
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.taskCapabilities.local.spec).toBe(true);
  } finally {
    client?.close(); await daemon?.stop(); model.stop();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previousKey;
  }
});


test("daemon stop aborts and awaits background runner refresh before resolving", async () => {
  const checkedAt = Date.now(); let calls = 0, finish!: () => void, signal: AbortSignal | undefined;
  const f = await fixture({ availability: async abort => {
    if (++calls === 1) return { available: true, checkedAt };
    signal = abort;
    await new Promise<void>(resolve => { finish = resolve; });
    return { available: true, checkedAt: Date.now() };
  } });
  const client = await ControlClient.connect(f.stateDir, { role: "console" }); cleanups.push(() => client.close());
  const originalNow = Date.now;
  let stopping: Promise<void> | undefined;
  try {
    Date.now = () => checkedAt + 60_001;
    await client.request({ t: "status" }); expect(calls).toBe(2);
    let stopped = false; stopping = f.daemon.stop().then(() => { stopped = true; });
    await Bun.sleep(0);
    expect(stopped).toBe(false); expect(signal?.aborted).toBe(true);
    await client.request({ t: "status" }); expect(calls).toBe(2);
  } finally { Date.now = originalNow; finish?.(); await stopping; }
  await Bun.sleep(0); expect(calls).toBe(2);
});
