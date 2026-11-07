import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewerPrintPeer, type ReviewerFailure, type ReviewerLaunch } from "../src/adapters/reviewer-print.ts";
import type { ReviewerPolicyProbe } from "../src/adapters/reviewer-policy-watch.ts";
import { stopOwnedProcess } from "../src/hub/child-process.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const wait = async (condition: () => boolean, label: string) => {
  const end = performance.now() + 5000;
  while (!condition() && performance.now() < end) await Bun.sleep(5);
  if (!condition()) throw new Error(`fixture barrier not reached: ${label}`);
};
class Probe implements ReviewerPolicyProbe {
  readonly checks: ReturnType<typeof deferred<boolean>>[] = [];
  stops = 0;
  joined = false;
  stopFailures = 0;
  settleOnStop = true;
  stopGate?: ReturnType<typeof deferred<void>>;
  check(): Promise<boolean> { const check = deferred<boolean>(); this.checks.push(check); return check.promise; }
  async stop(): Promise<void> {
    this.stops++;
    if (this.stopFailures > 0) { this.stopFailures--; throw new Error("fixture worker join refused"); }
    await this.stopGate?.promise;
    this.joined = true;
    if (this.settleOnStop) for (const check of this.checks) check.resolve(true);
  }
}
class ControlledPeer extends ReviewerPrintPeer { expire(): void { this.onWatchdog(); } }
const request = (task = 1) => newEnvelope(HUB, `Review fixture task #${task}`, { kind: "review", to: ["fixture-review"], refs: { task: String(task), commit: "a".repeat(40), reviewRevision: "7" } });
interface Profile {
  task?: number;
  session: string;
  path: string;
  ready: string;
  finish: string;
  overflow: string;
  probe: Probe;
  factoryCalls: number;
  probeStarted: boolean;
  nativeFailures: number;
  nativeAttempts: number;
  nativeStopped: boolean;
  child?: ChildProcess;
  cleaned: number;
  released: number;
  finished: number;
}
const fixtures: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of fixtures.splice(0).reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "owned reviewer policy fixture cleanup failed");
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reviewer-policy-lifecycle-"));
  const profiles: Profile[] = [], events: string[] = [], receipts: DeliveryReceipt[] = [], diagnostics: string[] = [];
  const mcp: { task: number; current: () => boolean; closed: boolean; profile?: Profile }[] = [];
  const unavailable: { failure: ReviewerFailure; cleaned: boolean; joined: boolean; nativeStopped: boolean }[] = [];
  const flags = { stopBeforeSpawn: false, factoryFailure: false };
  let preSpawnStop: Promise<void> | undefined;
  const peer = new ControlledPeer("fixture-review", {
    cwd: root, mcpConfig: "{}", systemPrompt: "fixture role", watchdogMs: 10000,
    backend: { id: "fixture", taskMcp: true, prepare: async context => {
      const path = join(root, `profile-${profiles.length}`); mkdirSync(path, { mode: 0o700 });
      const profile: Profile = { task: context.task, session: context.sessionId, path, ready: join(path, "ready.json"), finish: join(path, "finish"), overflow: join(path, "overflow"),
        probe: new Probe(), factoryCalls: 0, probeStarted: false, nativeFailures: 0, nativeAttempts: 0, nativeStopped: false, cleaned: 0, released: 0, finished: 0 };
      profiles.push(profile);
      const session = mcp.findLast(row => row.task === context.task && !row.profile); if (session) session.profile = profile;
      const program = `import{existsSync,writeFileSync}from'node:fs';
const input=await new Response(Bun.stdin.stream()).text();writeFileSync(${JSON.stringify(profile.ready)},JSON.stringify({bytes:Buffer.byteLength(input)}));
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(profile.overflow)})){clearInterval(timer);process.stdout.write('x'.repeat(256*1024+1)+'\\n');setInterval(()=>{},1000)}
else if(existsSync(${JSON.stringify(profile.finish)})){clearInterval(timer);process.stdout.write(JSON.stringify({type:'done'})+'\\n')}},5);`;
      const launch: ReviewerLaunch = { command: [process.execPath, "-e", program], args: [], cwd: path, envMode: "replace", env: { HOME: path, TMPDIR: path, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        isolation: { backend: "fixture", version: "fixture", binary: process.execPath, profile: "isolated fixture only", readOnly: true, strictMcp: true, ephemeral: true, evidence: ["synthetic lifecycle proof, no native/model proof"] },
        current: () => {
          if (context.task !== undefined && flags.stopBeforeSpawn) {
            flags.stopBeforeSpawn = false;
            preSpawnStop = peer.stop("fixture stop at the last pre-spawn fence");
            void preSpawnStop.catch(() => {});
          }
          return true;
        },
        watchCurrent: true,
        startPolicyWatch: () => {
          profile.factoryCalls++;
          if (flags.factoryFailure) throw new Error("FACTORY_PRIVATE_PATH_CANARY");
          profile.probeStarted = true; events.push(`watch-start:${profile.session}`); return profile.probe;
        },
        stop: async child => {
          profile.child = child; profile.nativeAttempts++;
          if (profile.nativeFailures > 0) { profile.nativeFailures--; throw new Error("fixture native stop refused before any signal"); }
          await stopOwnedProcess(child, { group: true, termMs: 250, killMs: 1000 });
          profile.nativeStopped = true; events.push(`native-joined:${profile.session}`);
        },
        cleanup: () => {
          if (profile.cleaned) return;
          if (context.task !== undefined && (profile.probeStarted && !profile.probe.joined || profile.child && !profile.nativeStopped)) throw new Error("fixture refuses profile cleanup before owned resource join");
          rmSync(path, { recursive: true }); profile.cleaned++; events.push(`profile-cleaned:${profile.session}`);
        },
      };
      return launch;
    } },
    verdictSince: () => true,
    taskMcp: (task, current) => { const record = { task, current, closed: false }; mcp.push(record); return { config: "{}", close: () => { record.closed = true; events.push(`mcp-closed:${task}`); } }; },
    inputReleased: context => { const profile = profiles.find(row => row.session === context.sessionId)!; profile.released++; events.push(`input-released:${profile.session}`); },
    inputFinished: context => { const profile = profiles.find(row => row.session === context.sessionId)!; profile.finished++; events.push(`input-finished:${profile.session}`); },
    onUnavailable: failure => {
      const profile = profiles.findLast(row => row.task === failure.task)!;
      unavailable.push({ failure, cleaned: profile.cleaned === 1, joined: profile.probe.joined, nativeStopped: profile.nativeStopped });
      events.push(`fallback:${profile.session}`); return true;
    },
    log: line => diagnostics.push(line),
  });
  peer.onDelivery = receipt => { receipts.push(receipt); events.push(`delivery:${receipt.state}`); };
  fixtures.push(async () => {
    flags.factoryFailure = false; flags.stopBeforeSpawn = false;
    for (const profile of profiles) {
      profile.nativeFailures = 0; profile.probe.stopFailures = 0; profile.probe.settleOnStop = true;
      profile.probe.stopGate?.resolve(undefined); for (const check of profile.probe.checks) check.resolve(true);
    }
    let failure: unknown;
    try { await peer.stop(); } catch (error) { failure = error; }
    // Every fallback signal uses the original owned ChildProcess, never a discovered PID.
    for (const profile of profiles) if (profile.child) await stopOwnedProcess(profile.child, { group: true });
    rmSync(root, { recursive: true, force: true });
    if (failure) throw failure;
  });
  const active = () => profiles.filter(profile => profile.task !== undefined);
  const running = async (index = 0) => {
    await wait(() => !!active()[index] && existsSync(active()[index]!.ready), "native input/readiness");
    const profile = active()[index]!;
    await wait(() => profile.probe.checks.length > 0, "first periodic check");
    return profile;
  };
  return { root, peer, profiles, active, running, events, receipts, mcp, unavailable, diagnostics, flags, get preSpawnStop() { return preSpawnStop; } };
}

// Stop is reentrant from the fixed current() port, after admission but before OwnedPrintChild's spawn callback.
test("stop before onSpawn starts no probe and releases no review input", async () => {
  const f = fixture(); await f.peer.start(); f.flags.stopBeforeSpawn = true;
  await f.peer.deliver([request()], "pre-spawn-stop");
  await wait(() => f.preSpawnStop !== undefined, "pre-spawn stop requested"); await f.preSpawnStop;
  const profile = f.active()[0]!;
  expect(profile.factoryCalls).toBe(0); expect(profile.released).toBe(0);
  expect(f.peer.reviewToken(1)).toBeUndefined(); expect(f.peer.state).toBe("offline");
  expect(profile.cleaned).toBe(1); expect(f.unavailable).toEqual([]);
}, 20000);

test("policy factory failure revokes before input release and never prints its error", async () => {
  const f = fixture(); await f.peer.start(); f.flags.factoryFailure = true;
  await f.peer.deliver([request()], "factory-failure");
  await wait(() => f.peer.state === "idle", "factory failure cleanup");
  const profile = f.active()[0]!;
  expect(profile.factoryCalls).toBe(1); expect(profile.probeStarted).toBe(false); expect(profile.released).toBe(0);
  expect(profile.nativeStopped).toBe(true); expect(profile.cleaned).toBe(1);
  expect(f.receipts.some(row => row.state === "needs_review" && row.reason === "review policy changed")).toBe(true);
  expect(f.diagnostics.join("\n")).not.toContain("FACTORY_PRIVATE_PATH_CANARY");
}, 20000);

for (const outcome of ["false", "error"] as const) test(`periodic ${outcome} revokes generation and waits for cleanup before fallback`, async () => {
  const f = fixture(); await f.peer.start(); await f.peer.deliver([request()], `policy-${outcome}`);
  const profile = await f.running(); expect(f.peer.reviewToken(1)).toBeDefined();
  if (outcome === "false") profile.probe.checks[0]!.resolve(false); else profile.probe.checks[0]!.reject(new Error("WORKER_PRIVATE_ERROR_CANARY"));
  await wait(() => f.peer.state === "idle", "policy failure settlement");
  expect(f.peer.reviewToken(1)).toBeUndefined(); expect(profile.probe.joined).toBe(true);
  expect(profile.nativeStopped).toBe(true); expect(profile.cleaned).toBe(1); expect(profile.finished).toBe(1);
  expect(f.unavailable).toHaveLength(1);
  expect(f.unavailable[0]).toMatchObject({ cleaned: true, joined: true, nativeStopped: true });
  expect(f.mcp[0]!.current()).toBe(false);
  expect(f.receipts.some(row => row.state === "needs_review" && row.reason === "review policy changed")).toBe(true);
  expect(f.diagnostics.join("\n")).not.toContain("WORKER_PRIVATE_ERROR_CANARY");
}, 20000);

test("same-task batch replacement waits for the old check and ignores its retired result", async () => {
  const f = fixture(); await f.peer.start(); await f.peer.deliver([request(), request()], "same-task-batch");
  const first = await f.running(); const token = f.peer.reviewToken(1); first.probe.settleOnStop = false;
  writeFileSync(first.finish, "finish first child");
  await wait(() => first.probe.stops > 0 && first.nativeStopped, "old native exit and watcher stop");
  expect(f.active()).toHaveLength(1); expect(f.peer.reviewToken(1)).toBeUndefined(); expect(first.cleaned).toBe(0);
  first.probe.checks[0]!.resolve(false);
  const second = await f.running(1); const replacement = f.peer.reviewToken(1);
  expect(replacement).toBeDefined(); expect(replacement).not.toBe(token);
  first.probe.checks[0]!.reject(new Error("retired duplicate result")); first.probe.checks[0]!.resolve(true);
  expect(f.peer.reviewToken(1)).toBe(replacement); expect(f.peer.state).toBe("busy"); expect(f.unavailable).toEqual([]);
  writeFileSync(second.finish, "finish replacement"); await wait(() => f.peer.state === "idle", "replacement completion");
  expect(first.finished).toBe(1); expect(second.finished).toBe(1);
  expect(f.receipts.filter(row => row.state === "completed")).toHaveLength(1);
}, 20000);

test("native stop failure still joins the probe and keeps profile until explicit retry", async () => {
  const f = fixture(); await f.peer.start(); await f.peer.deliver([request()], "native-stop-failure");
  const profile = await f.running(); profile.nativeFailures = 1;
  await expect(f.peer.stop("person stop")).rejects.toThrow("fixture native stop refused");
  expect(profile.probe.joined).toBe(true); expect(profile.nativeStopped).toBe(false);
  expect(profile.child?.exitCode).toBeNull(); expect(profile.cleaned).toBe(0); expect(profile.finished).toBe(0);
  expect(existsSync(profile.path)).toBe(true); expect(f.peer.state).toBe("busy"); expect(f.peer.reviewToken(1)).toBeUndefined();
  await expect(f.peer.start()).rejects.toThrow();
  await f.peer.stop("retry owned stop");
  expect(profile.nativeStopped).toBe(true); expect(profile.cleaned).toBe(1); expect(profile.finished).toBe(1);
  expect(profile.probe.stops).toBe(1); expect(f.peer.state).toBe("offline");
}, 20000);

test("failed probe join retains owner and profile until explicit retry confirms cleanup once", async () => {
  const f = fixture(); await f.peer.start(); await f.peer.deliver([request()], "worker-stop-failure");
  const profile = await f.running(); profile.probe.stopFailures = 1;
  writeFileSync(profile.finish, "normal leader exit with failing worker join");
  await wait(() => profile.nativeStopped && profile.probe.stops === 1 && f.receipts.some(row => row.state === "needs_review"), "native exit and rejected worker join");
  expect(profile.probe.joined).toBe(false); expect(profile.cleaned).toBe(0); expect(profile.finished).toBe(0);
  expect(existsSync(profile.path)).toBe(true); expect(f.peer.state).toBe("busy"); expect(f.peer.reviewToken(1)).toBeUndefined();
  await expect(f.peer.start()).rejects.toThrow();
  await f.peer.stop("retry worker join");
  expect(profile.probe.joined).toBe(true); expect(profile.probe.stops).toBe(2);
  expect(profile.cleaned).toBe(1); expect(profile.finished).toBe(1); expect(f.peer.state).toBe("offline");
  await f.peer.stop(); expect(profile.cleaned).toBe(1); expect(profile.finished).toBe(1);
}, 20000);

for (const mode of ["normal", "watchdog", "output-limit"] as const) test(`${mode} joins watcher before final profile and input settlement`, async () => {
  const f = fixture(); await f.peer.start(); await f.peer.deliver([request()], `join-order-${mode}`);
  const profile = await f.running(); profile.probe.stopGate = deferred<void>();
  if (mode === "normal") writeFileSync(profile.finish, "normal exit");
  else if (mode === "watchdog") f.peer.expire();
  else writeFileSync(profile.overflow, "overflow frame");
  await wait(() => profile.probe.stops > 0, "watcher join started");
  expect(profile.probe.joined).toBe(false); expect(profile.cleaned).toBe(0); expect(profile.finished).toBe(0);
  expect(f.peer.state).toBe("busy"); expect(f.peer.reviewToken(1)).toBeUndefined();
  expect(f.unavailable).toEqual([]); expect(f.receipts.some(row => row.state === "completed")).toBe(false);
  expect(f.mcp[0]!.current()).toBe(false); // Authority revocation is immediate, before the asynchronous join.
  profile.probe.stopGate.resolve(undefined);
  await wait(() => f.peer.state === "idle", "joined final settlement");
  expect(profile.probe.joined).toBe(true); expect(profile.nativeStopped).toBe(true);
  expect(profile.cleaned).toBe(1); expect(profile.finished).toBe(1);
  expect(f.events.indexOf(`profile-cleaned:${profile.session}`)).toBeLessThan(f.events.indexOf(`input-finished:${profile.session}`));
  if (mode === "normal") expect(f.receipts.filter(row => row.state === "completed")).toHaveLength(1);
  else { expect(f.receipts.some(row => row.state === "needs_review")).toBe(true); expect(f.unavailable[0]).toMatchObject({ cleaned: true, joined: true, nativeStopped: true }); }
}, 20000);
