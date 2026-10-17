import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { PiToolReceipts } from "../src/pi/tool-receipts.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { CHECK_IMAGE, ContainerRunner, type CheckRequest, type ContainerCommand, type RunnerOptions } from "../src/hub/check-runner.ts";
const roots: string[] = [];
const runners: ContainerRunner[] = [];
afterEach(async () => { for (const r of runners.splice(0)) await r.stopAll(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture(options: Partial<RunnerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "ahub-check-runner-")); roots.push(root);
  const project = join(root, "project"); await mkdir(project);
  const git = (args: string[]) => { const r = hubGitSync(["-C", project, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git(["init"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  await mkdir(join(project, "test")); await writeFile(join(project, "test/example.test.ts"), "test('ok',()=>{});\n");
  await writeFile(join(project, "bun.lock"), "fixture lock\n"); await writeFile(join(project, "denied.txt"), "withheld");
  git(["add", "."]); git(["commit", "-m", "fixture"]);
  await mkdir(join(project, "node_modules/.bin"), { recursive: true }); await writeFile(join(project, "node_modules/tool.js"), "tool"); await symlink("../tool.js", join(project, "node_modules/.bin/tool"));
  const calls: string[][] = [];
  const command: ContainerCommand = async (args, opts) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "1.5.0" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: JSON.stringify([{id:'agenthub-check',configuration:{name:'agenthub-check',mode:'hostOnly'}}]) };
    if (args[0] === "list") return { code: 0, stdout: "[]" };
    if (args[0] === "exec") { opts?.output?.(Buffer.from("fixture passed\n")); return { code: 0, stdout: "" }; }
    return { code: 0, stdout: "" };
  };
  const runner = new ContainerRunner({ projectDir: project, stateDir: join(root, "state"), storageDir: join(root, "storage"), projectKey: "fixture", enabled: true, isDenied: p => p === "denied.txt", signature: () => "fixture-signature", command, ...options }); runners.push(runner);
  const request: CheckRequest = { task: 1, owner: "pi", generation: 2, updated: 3, ref: "HEAD", check: "test", files: ["test/example.test.ts"] };
  return { root, project, runner, request, calls, git, command };
}
test("copies exact committed blobs, safe deps, and executes only fixed isolated argv", async () => {
  const f = await fixture(); const sha = f.git(["rev-parse", "HEAD"]);
  await writeFile(join(f.project, "test/example.test.ts"), "dirty change");
  let checked = false;
  const original = f.command;
  const inspect: ContainerCommand = async (args, opts) => {
    if (args[0] === "cp") {
      const source = args[1]!.slice(0, -2);
      expect(await readFile(join(source, "test/example.test.ts"), "utf8")).toBe("test('ok',()=>{});\n");
      expect(await Bun.file(join(source, "denied.txt")).exists()).toBe(false);
      expect(await readFile(join(source, "node_modules/.bin/tool"), "utf8")).toBe("tool"); checked = true;
    }
    return original(args, opts);
  };
  const runner = new ContainerRunner({ projectDir: f.project, stateDir: join(f.root, "state2"), storageDir: join(f.root, "storage2"), projectKey: "fixture", enabled: true, isDenied: p => p === "denied.txt", signature: () => "sig", command: inspect }); runners.push(runner);
  const { run, done } = runner.start(f.request); const r = await done;
  expect(checked).toBe(true); expect(r.sha).toBe(sha); expect(r.excluded).toBe(1); expect(r.dependency_files).toBe(4); expect(r.exit).toBe(0); expect(r.tail).toBe("fixture passed");
  expect(r.image).toBe(CHECK_IMAGE); expect(r.platform).toContain("linux/arm64");
  const args = f.calls.find(c => c[0] === "run")!;
  expect(args).toContain("--no-dns"); expect(args).toContain("agenthub-check"); expect(args).toContain("--cpus"); expect(args).toContain("--memory"); expect(args).toContain(CHECK_IMAGE); expect(args.some(p => p.includes("mount"))).toBe(false);
  expect(f.calls.find(c => c[0] === "exec")!.slice(-3)).toEqual(["bun", "test", "test/example.test.ts"]);
  expect(await Bun.file(join(f.root, "storage2/fixture", run, "src/bun.lock")).exists()).toBe(false);
  expect(await runner.result(run)).toMatchObject({ task: 1, owner: "pi", generation: 2, updated: 3, exit: 0 });
  await runner.consumeOutput(run); expect(await Bun.file(join(f.root, "storage2/fixture", run, "output.log")).exists()).toBe(false);
});
test("failing test remains failed; bounded output preserves last lines", async () => {
  const f = await fixture({ command: async (args, options) => {
    if (args[0] === "list") return { code: 0, stdout: "[]" };
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{id:'agenthub-check',configuration:{name:'agenthub-check',mode:'hostOnly'}}]) };
    if (args[0] === "exec") { options?.output?.(Buffer.alloc(1_100_000, "x")); options?.output?.(Buffer.from("\nlast line\n")); return { code: 7, stdout: "" }; }
    return { code: 0, stdout: "1.5.0" };
  } });
  const r = await f.runner.start(f.request).done;
  expect(r.exit).toBe(7); expect(r.truncated).toBe(true); expect(r.output_bytes).toBeGreaterThan(1_048_576); expect(Buffer.byteLength(r.tail)).toBeLessThanOrEqual(4096); expect(r.tail).toContain("last line");
  expect((await Bun.file(join(f.root, "storage/fixture", r.run, "output.log")).stat()).size).toBe(1_048_576);
});
test.each(["../test/x.test.ts", "test/../x.test.ts", "test/x.test.ts --help", "/test/x.test.ts", "test/.//x.test.ts"])("rejects unauthorized file %s before effects", async file => {
  const f = await fixture(); expect(() => f.runner.start({ ...f.request, files: [file] })).toThrow("invalid test files"); expect(f.calls).toEqual([]);
});
test("missing opt-in and unavailable runtime fail closed without run", async () => {
  const disabled = await fixture({ enabled: false }); expect(() => disabled.runner.start(disabled.request)).toThrow("not enabled");
  const f = await fixture({ command: async () => { throw new Error("missing"); } });
  expect(await f.runner.available()).toMatchObject({ available: false }); expect((await f.runner.start(f.request).done).error).toContain("runner unavailable");
});
test.each(["symlink", "submodule"])("refuses source %s even at a denied path", async kind => {
  const f = await fixture({ isDenied: () => true });
  if (kind === "symlink") { await symlink("/etc/passwd", join(f.project, "link")); f.git(["add", "link"]); }
  else f.git(["update-index", "--add", "--cacheinfo", `160000,${f.git(["rev-parse", "HEAD"])},module`]);
  f.git(["commit", "-m", "unsafe entry"]);
  expect((await f.runner.start(f.request).done).error).toContain("symlink or submodule"); expect(f.calls.some(c => c[0] === "run")).toBe(false);
});
test("dependency escaping link, differing lockfile and unavailable test refuse", async () => {
  const f = await fixture(); await symlink("/etc/passwd", join(f.project, "node_modules/escape"));
  expect((await f.runner.start(f.request).done).error).toContain("escaping symlink"); await rm(join(f.project, "node_modules/escape"));
  await writeFile(join(f.project, "bun.lock"), "changed"); expect((await f.runner.start(f.request).done).error).toContain("lockfile differs");
  expect((await f.runner.start({ ...f.request, files: ["test/missing.test.ts"] }).done).error).toContain("test file unavailable"); expect(f.calls.some(c => c[0] === "run")).toBe(false);
});
test("unverified network refuses before container creation", async () => {
  const f = await fixture({ command: async args => ({ code: 0, stdout: args[0] === "network" ? '{"internal":false}' : "1.5.0" }) });
  expect((await f.runner.start(f.request).done).error).toContain("network isolation unverified");
});
test("cancel, timeout and stop clear container and shared heavy slot; queue bounded", async () => {
  let entered!: () => void; const running = new Promise<void>(r => { entered = r; });
  const f = await fixture({ timeoutMs: 2000, command: async (args, options) => {
    if (args[0] === "list") return { code: 0, stdout: "[]" };
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{id:'agenthub-check',configuration:{name:'agenthub-check',mode:'hostOnly'}}]) };
    if (args[0] === "exec") { entered(); return new Promise(r => { if (options?.signal?.aborted) r({ code: null, stdout: "" }); else options?.signal?.addEventListener("abort", () => r({ code: null, stdout: "" }), { once: true }); }); }
    return { code: 0, stdout: "1.5.0" };
  } });
  const first = f.runner.start(f.request); await running;
  const second = f.runner.start(f.request), third = f.runner.start(f.request);
  expect(() => f.runner.start(f.request)).toThrow("busy");
  await f.runner.cancel(first.run); expect((await first.done).cancelled).toBe(true);
  await f.runner.stopAll(); expect((await second.done).interrupted).toBe(true); expect((await third.done).interrupted).toBe(true);
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(false);
  const timeout = await fixture({ timeoutMs: 5, command: async (args, opts) => {
    if (args[0] === "list") return { code: 0, stdout: "[]" };
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{id:'agenthub-check',configuration:{name:'agenthub-check',mode:'hostOnly'}}]) };
    if (args[0] === "exec") return new Promise(r => opts?.signal?.addEventListener("abort", () => r({ code: null, stdout: "" }), { once: true }));
    return { code: 0, stdout: "1.5.0" };
  } });
  expect((await timeout.runner.start(timeout.request).done).timed_out).toBe(true);
});
test("live shared heavy slot prevents snapshot; cancellation releases waiting run", async () => {
  const f = await fixture({ lockWaitMs: 0 }); const lock = join(f.project, ".git/ahub-heavy.lock"); await mkdir(lock); await writeFile(join(lock, "owner"), `${process.pid} gate`);
  const r = await f.runner.start(f.request).done; expect(r.error).toContain("heavy slot held"); expect(await readFile(join(lock, "owner"), "utf8")).toBe(`${process.pid} gate`);
  expect(f.calls.some(c => c[0] === "run")).toBe(false);
});
test("sweep cleans only matching dead identity and leaves live, unknown and other-project runs", async () => {
  const f = await fixture(); const r = await f.runner.start(f.request).done;
  const calls: string[][] = []; let listed = false;
  const labels = { "agenthub.project": "fixture", "agenthub.run": r.run, "agenthub.hub": `${r.hub_pid}:${r.hub_signature}` };
  const runner = new ContainerRunner({ projectDir: f.project, stateDir: join(f.root, "state"), storageDir: join(f.root, "storage"), projectKey: "fixture", enabled: true, isDenied: () => false, signature: () => "new", liveness: () => "gone", command: async args => {
    calls.push(args); const firstList = !listed; if (args[0] === "list") listed = true; return { code: 0, stdout: args[0] === "list" ? !firstList ? "[]" : JSON.stringify([{ id: r.container, labels }, { id: "other", labels: { "agenthub.project": "other" } }, { id: "unknown", labels: { "agenthub.project": "fixture" } }]) : "" };
  } }); runners.push(runner);
  expect(await runner.sweep()).toHaveLength(1); expect(calls.filter(c => c[0] === "kill").map(c => c[1])).toEqual([r.container]); expect(await runner.result(r.run)).toMatchObject({ interrupted: true, exit: null });
});
test("cleanup uncertainty retains the shared heavy slot and refuses a passing verdict", async () => {
  let container = "";
  const f = await fixture({ command: async (args, options) => {
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{ id: "agenthub-check", configuration: { name: "agenthub-check", mode: "hostOnly" } }]) };
    if (args[0] === "run") container = args[args.indexOf("--name") + 1]!;
    if (args[0] === "list") return { code: 0, stdout: JSON.stringify([{ id: container }]) };
    if (args[0] === "exec") options?.output?.(Buffer.from("success"));
    return { code: 0, stdout: "1.5.0" };
  } });
  const r = await f.runner.start(f.request).done;
  expect(r.exit).toBeNull(); expect(r.error).toContain("cleanup unconfirmed"); expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(true);
});
test("receipt retention keeps newest 200 and output retention expires at 24 hours", async () => {
  const f = await fixture(); const original = await f.runner.start(f.request).done;
  const old = { ...original, created: Date.now() - 86_400_001 };
  await writeFile(join(f.root, "state/checks", `${old.run}.json`), JSON.stringify(old));
  await f.runner.sweep(); expect(await Bun.file(join(f.root, "storage/fixture", old.run, "output.log")).exists()).toBe(false);
  const runner = new ContainerRunner({ projectDir: f.project, stateDir: join(f.root, "state"), storageDir: join(f.root, "storage"), projectKey: "fixture", enabled: false, isDenied: () => false }); runners.push(runner);
  for (let i = 0; i < 201; i++) {
    const run = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    await writeFile(join(f.root, "state/checks", `${run}.json`), JSON.stringify({ ...original, run, container: `agenthub-check-${run}`, created: Date.now() + i }));
  }
  await runner.sweep();
  const files = await readdir(join(f.root, "state/checks")); expect(files.filter(p => p.endsWith(".json"))).toHaveLength(200);
});
test("disabled non-Git projects do no probing and enabled non-Git fails unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ahub-runner-nongit-")); roots.push(root);
  let calls = 0;
  const options: RunnerOptions = { projectDir: root, stateDir: join(root, "state"), storageDir: join(root, "storage"), projectKey: "fixture", enabled: false, isDenied: () => false, signature: () => "sig", command: async () => { calls++; throw new Error("must not call"); } };
  const disabled = new ContainerRunner(options); runners.push(disabled);
  expect(await disabled.available()).toEqual({ available: false, reason: "not enabled" }); expect(calls).toBe(0);
  const enabled = new ContainerRunner({ ...options, enabled: true }); runners.push(enabled);
  expect(await enabled.available()).toEqual({ available: false, reason: "git source unavailable" }); expect(calls).toBe(0);
});
test.each(["network", "run", "cp", "exec"])("binding lost after %s await becomes durable stale with no agent delivery", async stage => {
  let current = true, deliveries = 0;
  const calls: string[] = [];
  const f = await fixture({ isCurrent: () => current, onResult: () => { deliveries++; }, command: async args => {
    calls.push(args[0]!);
    if (args[0] === stage) current = false;
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{ id: "agenthub-check", configuration: { name: "agenthub-check", mode: "hostOnly" } }]) };
    return { code: 0, stdout: args[0] === "list" ? "[]" : "1.5.0" };
  } });
  const handle = f.runner.start(f.request); const r = await handle.done;
  expect(r.status).toBe("stale"); expect(r.exit).toBeNull(); expect(deliveries).toBe(0);
  expect(await f.runner.result(r.run)).toMatchObject({ status: "stale", exit: null });
  if (stage === "network") expect(calls).not.toContain("run");
  if (stage === "run" || stage === "cp") expect(calls).not.toContain("exec");
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(false);
});
test("explicit stale mark aborts active work, preserves person receipt and exposes safe live ids", async () => {
  let entered!: () => void; const running = new Promise<void>(r => { entered = r; }); let delivered = 0;
  const f = await fixture({ onResult: () => { delivered++; }, command: async (args, options) => {
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{ id: "agenthub-check", configuration: { name: "agenthub-check", mode: "hostOnly" } }]) };
    if (args[0] === "exec") { entered(); return new Promise(r => options?.signal?.addEventListener("abort", () => r({ code: null, stdout: "" }), { once: true })); }
    return { code: 0, stdout: args[0] === "list" ? "[]" : "1.5.0" };
  } });
  const active = f.runner.start(f.request); await running;
  const queued = f.runner.start(f.request);
  expect(f.runner.activeRun).toBe(active.run); expect(f.runner.queuedRuns).toEqual([queued.run]);
  await f.runner.markStale(queued.run); await f.runner.markStale(active.run);
  expect((await active.done).status).toBe("stale"); expect((await queued.done).status).toBe("stale"); expect(delivered).toBe(0);
  expect(await f.runner.result(active.run)).toMatchObject({ status: "stale", exit: null }); expect(f.runner.activeRun).toBeUndefined(); expect(f.runner.queuedRuns).toEqual([]);
});
test("availability cache reports original probe time and refreshes at its exact bound", async () => {
  let now = 1000;
  const f = await fixture({ now: () => now });
  expect(await f.runner.available()).toMatchObject({ available: true, checkedAt: 1000 });
  const probes = f.calls.length;
  now = 60_999;
  expect(await f.runner.available()).toMatchObject({ available: true, checkedAt: 1000 }); expect(f.calls.length).toBe(probes);
  now = 61_000;
  expect(await f.runner.available()).toMatchObject({ available: true, checkedAt: 61_000 }); expect(f.calls.length).toBeGreaterThan(probes);
});
test.each(["wrong mode", "wrong name", "unparseable"])("existing %s network advertises unavailable without VM or mutation", async problem => {
  let now = 5000;
  const calls: string[][] = [];
  const configuration = { name: problem === "wrong name" ? "other" : "agenthub-check", mode: problem === "wrong mode" ? "nat" : "hostOnly" };
  const f = await fixture({ now: () => now, command: async args => {
    calls.push(args); return { code: 0, stdout: args[0] === "network" ? problem === "unparseable" ? "invalid" : JSON.stringify([{ id: "agenthub-check", configuration }]) : "1.5.0" };
  } });
  expect(await f.runner.available()).toEqual({ available: false, reason: "network isolation unverified", checkedAt: 5000 });
  const probes = calls.length; now = 55_000;
  expect(await f.runner.available()).toMatchObject({ available: false, checkedAt: 5000 }); expect(calls).toHaveLength(probes);
  expect((await f.runner.start(f.request).done).error).toContain("network isolation unverified");
  expect(calls.some(c => ["run", "create", "exec"].includes(c[0]!))).toBe(false);
});
test("absent internal network remains potentially available without creating it during probe", async () => {
  const calls: string[][] = [];
  const f = await fixture({ command: async args => { calls.push(args); return { code: args[0] === "network" ? 1 : 0, stdout: "1.5.0" }; } });
  expect(await f.runner.available()).toMatchObject({ available: true }); expect(calls.every(c => c[0] !== "network" || c[1] === "inspect")).toBe(true);
});
test.each(["git", "container"])("refuses repository PATH %s shim without executing host code", async name => {
  const f = await fixture();
  const bin = join(f.project, "bin"); await mkdir(bin);
  const marker = join(f.root, "shim-executed");
  await writeFile(join(bin, name), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const runner = new ContainerRunner({ projectDir: f.project, stateDir: join(f.root, "shim-state"), storageDir: join(f.root, "shim-storage"), projectKey: "fixture", enabled: true, isDenied: () => false, signature: () => "sig" }); runners.push(runner);
    const state = await runner.available();
    expect(state.available).toBe(false); expect(state.reason).toContain(name === "git" ? "git source unavailable" : "container unavailable");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
});

test("marking a completed failing check stale preserves its observed exit status", async () => {
  let original!: ContainerCommand;
  const f = await fixture({ command: async (args, options) => args[0] === "exec" ? { code: 17, stdout: "" } : original(args, options) });
  original = f.command;
  const handle = f.runner.start(f.request);
  expect((await handle.done).exit).toBe(17);
  await f.runner.markStale(handle.run);
  expect(await f.runner.result(handle.run)).toMatchObject({ status: "stale", exit: 17 });
});
test("cancelling queued work settles immediately and frees capacity while active check stays held", async () => {
  let entered!: () => void;
  const running = new Promise<void>(r => { entered = r; });
  const notices: string[] = [], calls: string[][] = [];
  const f = await fixture({ onResult: receipt => { notices.push(receipt.run); }, command: async (args, options) => {
    calls.push(args);
    if (args[0] === "network") return { code: 0, stdout: JSON.stringify([{ id: "agenthub-check", configuration: { name: "agenthub-check", mode: "hostOnly" } }]) };
    if (args[0] === "exec") { entered(); return new Promise(r => options?.signal?.addEventListener("abort", () => r({ code: null, stdout: "" }), { once: true })); }
    return { code: 0, stdout: args[0] === "list" ? "[]" : "1.5.0" };
  } });
  const active = f.runner.start(f.request); await running;
  const cancelled = f.runner.start(f.request), retained = f.runner.start(f.request);
  let settled = false; void cancelled.done.then(() => { settled = true; });
  const heavyOwner = await readFile(join(f.project, ".git/ahub-heavy.lock/owner"), "utf8");
  const before = calls.length;
  await f.runner.cancel(cancelled.run);
  expect(settled).toBe(true);
  expect(await cancelled.done).toMatchObject({ cancelled: true, status: "finished", exit: null });
  expect(await f.runner.result(cancelled.run)).toMatchObject({ cancelled: true, status: "finished", exit: null });
  expect(f.runner.activeRun).toBe(active.run); expect(f.runner.queuedRuns).toEqual([retained.run]);
  expect(calls).toHaveLength(before); expect(await readFile(join(f.project, ".git/ahub-heavy.lock/owner"), "utf8")).toBe(heavyOwner);
  const replacement = f.runner.start(f.request);
  expect(f.runner.queuedRuns).toEqual([retained.run, replacement.run]);
  expect(notices.filter(run => run === cancelled.run)).toHaveLength(1);
  await f.runner.cancel(cancelled.run); expect(notices.filter(run => run === cancelled.run)).toHaveLength(1);
  await f.runner.cancel(retained.run); await f.runner.cancel(replacement.run); await f.runner.cancel(active.run); await active.done;
});

function manualClock() {
  let now = 1000, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, ms: number) => {
    const key = ++id; timers.set(key, { at: now + ms, callback });
    return () => { timers.delete(key); };
  };
  return { now: () => now, schedule, advance(ms: number) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  } };
}

test.each(["run", "cp"])("silent slow %s gets its own bounded allowance beyond the old 15s limit", async stage => {
  const clock = manualClock(); let original!: ContainerCommand, allowance = 0;
  const f = await fixture({ now: clock.now, schedule: clock.schedule, command: async (args, options) => {
    if (args[0] === stage) {
      allowance = options?.timeoutMs ?? 15_000;
      let killed = false;
      const cancel = clock.schedule(() => { killed = true; }, allowance);
      clock.advance(20_000); cancel();
      return { code: killed ? null : 0, stdout: "" };
    }
    return original(args, options);
  } }); original = f.command;
  expect(await f.runner.start(f.request).done).toMatchObject({ exit: 0, timed_out: false });
  expect(allowance).toBe(stage === "run" ? 120_000 : 180_000);
});

test("start and transfer share one cumulative deadline, even when transport returns late success after abort", async () => {
  const clock = manualClock(); let original!: ContainerCommand;
  const allowances: number[] = [];
  const f = await fixture({ now: clock.now, schedule: clock.schedule, timeoutMs: 30_000, command: async (args, options) => {
    if (args[0] === "run" || args[0] === "cp") {
      allowances.push(options?.timeoutMs ?? 15_000);
      clock.advance(20_000); // Deliberately ignore abort and return success; the runner must fence the next stage.
      return { code: 0, stdout: "" };
    }
    return original(args, options);
  } }); original = f.command;
  const receipt = await f.runner.start(f.request).done;
  expect(receipt).toMatchObject({ timed_out: true, exit: null });
  expect(allowances).toEqual([30_000, 10_000]);
  expect(f.calls.some(args => args[0] === "exec")).toBe(false);
  expect(f.calls.some(args => args[0] === "kill")).toBe(true);
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(false);
});

test("exec gets only the deadline remaining after cold start and copy", async () => {
  const clock = manualClock(); let original!: ContainerCommand, allowance = 0;
  const f = await fixture({ now: clock.now, schedule: clock.schedule, command: async (args, options) => {
    if (args[0] === "run") clock.advance(100_000);
    if (args[0] === "cp") clock.advance(160_000);
    if (args[0] === "exec") allowance = options?.timeoutMs ?? 0;
    return original(args, options);
  } }); original = f.command;
  expect(await f.runner.start(f.request).done).toMatchObject({ exit: 0, timed_out: false });
  expect(allowance).toBe(340_000);
});

test.each(["run", "cp"])("cancellation during silent %s fences late success and cleans the container", async stage => {
  let original!: ContainerCommand, entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const f = await fixture({ command: async (args, options) => {
    if (args[0] === stage) {
      signal = options?.signal; entered();
      await new Promise<void>(resolve => { finish = resolve; });
      return { code: 0, stdout: "" };
    }
    return original(args, options);
  } }); original = f.command;
  const handle = f.runner.start(f.request); await started;
  await f.runner.cancel(handle.run); expect(signal?.aborted).toBe(true); finish();
  expect(await handle.done).toMatchObject({ cancelled: true, exit: null });
  expect(f.calls.some(args => args[0] === "exec")).toBe(false);
  expect(f.calls.some(args => args[0] === "kill")).toBe(true);
  expect(await Bun.file(join(f.project, ".git/ahub-heavy.lock/owner")).exists()).toBe(false);
});

test.each(["run", "cp"])("silent %s remains bounded by its own command cap", async stage => {
  const clock = manualClock(); let original!: ContainerCommand;
  const f = await fixture({ now: clock.now, schedule: clock.schedule, command: async (args, options) => {
    if (args[0] === stage) {
      const timeout = options?.timeoutMs ?? 15_000;
      let killed = false;
      const cancel = clock.schedule(() => { killed = true; }, timeout);
      clock.advance(timeout); cancel();
      return { code: killed ? null : 0, stdout: "" };
    }
    return original(args, options);
  } }); original = f.command;
  const receipt = await f.runner.start(f.request).done;
  expect(receipt.exit).toBeNull(); expect(receipt.timed_out).toBe(false);
  expect(receipt.duration_ms).toBe(stage === "run" ? 120_000 : 180_000);
  expect(receipt.error).toContain(stage === "run" ? "container start failed" : "container source transfer failed");
  expect(f.calls.some(args => args[0] === "exec")).toBe(false);
});

// Index-only fixtures retain both spellings even on a case-insensitive host filesystem.
test.each([
  ["Case.txt", "case.txt"], ["Dir/one.txt", "dir/two.txt"], ["FILE", "file/child.txt"],
  ["café.txt", "café.txt"], ["Straße.txt", "STRASSE.txt"],
  ["ß.txt", "ẞ.txt"], ["ß/one.txt", "ẞ/two.txt"],
])("snapshot refuses folded Git path collisions before staging writes: %s / %s", async (left, right) => {
  let screened = 0;
  const f = await fixture({ isDenied: () => { screened++; return false; } });
  f.git(["config", "core.precomposeunicode", "false"]);
  const oid = f.git(["rev-parse", "HEAD:bun.lock"]);
  for (const path of [left, right]) f.git(["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`]);
  f.git(["commit", "-m", "colliding git names"]);
  const receipt = await f.runner.start(f.request).done;
  expect(receipt.error).toContain("source path collision"); expect(receipt.exit).toBeNull();
  expect(screened).toBe(0); // No per-file staging loop began, including files sorted before the collision.
  expect(f.calls.some(args => args[0] === "run" || args[0] === "cp")).toBe(false);
});

test("receipt lookup distinguishes absent storage from malformed invalid and unreadable storage", async () => {
  const f = await fixture(), run = "12345678-1234-1234-1234-123456789abc", path = join(f.root, "state/checks", `${run}.json`);
  expect(await f.runner.result(run)).toBeUndefined();
  await mkdir(join(f.root, "state/checks"), { recursive: true });
  for (const text of ["{bad JSON", "{}", "null"]) {
    await writeFile(path, text);
    await expect(f.runner.result(run)).rejects.toThrow("check receipt unavailable");
  }
  await rm(path); await mkdir(path);
  await expect(f.runner.result(run)).rejects.toThrow("check receipt unavailable");
});

test.each(["--version", "system", "image", "network"])("stopAll owns and awaits independent availability during %s", async stage => {
  let original!: ContainerCommand, entered!: () => void, finish!: () => void, signal: AbortSignal | undefined;
  const calls: string[] = [], started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ command: async (args, options) => {
    calls.push(args[0]!);
    if (args[0] === stage) { signal = options?.signal; entered(); await new Promise<void>(resolve => { finish = resolve; }); }
    return original(args, options);
  } }); original = f.command;
  const availability = f.runner.available(); await started;
  let stopped = false; const stopping = f.runner.stopAll().then(() => { stopped = true; });
  await Bun.sleep(0); const before = calls.length;
  expect(stopped).toBe(false); expect(signal?.aborted).toBe(true);
  finish(); await stopping;
  expect((await availability).available).toBe(false);
  await f.runner.available(); await Bun.sleep(0);
  expect(calls).toHaveLength(before);
});


test("queue saturation settles a real Pi refusal once and replays it after reopening", async () => {
  let original!: ContainerCommand, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ command: async (args, options) => {
    if (args[0] === "exec") { entered(); return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "" }), { once: true })); }
    return original(args, options);
  } }); original = f.command;
  const active = f.runner.start(f.request); await started;
  f.runner.start(f.request); f.runner.start(f.request);
  const file = join(f.root, "pi-ledger.db"); let ledger = new PiToolReceipts(file), attempts = 0;
  const start = async () => { attempts++; f.runner.start(f.request); return "unexpected admission"; };
  try {
    expect(await ledger.execute("session", "full", "hub_check_start", {}, start)).toBe("error: busy");
    await ledger.close(); ledger = new PiToolReceipts(file);
    expect(await ledger.execute("session", "full", "hub_check_start", {}, start)).toBe("error: busy");
    expect(attempts).toBe(1); expect(ledger.unsettled).toBe(false);
  } finally { await ledger.close(); await f.runner.stopAll(); await active.done; }
});

test("unreadable or malformed check storage stays uncertain in real Pi receipts and is never replayed", async () => {
  const f = await fixture(), file = join(f.root, "pi-ledger.db"), run = "12345678-1234-1234-1234-123456789abc";
  const path = join(f.root, "state/checks", `${run}.json`);
  let ledger = new PiToolReceipts(file), attempts = 0;
  // Same absence boundary as the daemon; result() storage errors must propagate past it.
  const read = async () => { attempts++; const receipt = await f.runner.result(run); if (!receipt) throw new PreEffectToolRefusal("check unavailable"); return JSON.stringify(receipt); };
  try {
    expect(await ledger.execute("session", "absent", "hub_check_result", { run }, read)).toBe("error: check unavailable");
    await mkdir(join(f.root, "state/checks"), { recursive: true });
    await writeFile(path, "{corrupt");
    expect(await ledger.execute("session", "corrupt", "hub_check_result", { run }, read)).toContain("outcome is uncertain");
    await rm(path); await mkdir(path);
    expect(await ledger.execute("session", "unreadable", "hub_check_result", { run }, read)).toContain("outcome is uncertain");
    await ledger.close(); ledger = new PiToolReceipts(file);
    const before = attempts;
    expect(await ledger.execute("session", "absent", "hub_check_result", { run }, read)).toBe("error: check unavailable");
    for (const id of ["corrupt", "unreadable"]) expect(await ledger.execute("session", id, "hub_check_result", { run }, read)).toContain("outcome is uncertain");
    expect(attempts).toBe(before); expect(ledger.unsettled).toBe(true);
  } finally { await ledger.close(); }
});
