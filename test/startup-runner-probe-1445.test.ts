import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import type { RunnerState } from "../src/hub/check-runner.ts";

// #1445 step 2: the first runner probe (about 8 s on a remote runner) no longer holds daemon startup. The settled state must equal the one a
// blocking start gives, so the fixtures assert both: a probe that is slow leaves startup done and the runner "in progress" until it settles,
// and a probe that is fast is already settled when startup returns. Nothing here measures wall-clock time: a probe held open by the test
// proves the ordering, and the test's own timeout is only a hang guard.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function start(availability: (signal?: AbortSignal) => Promise<RunnerState>) {
  const root = mkdtempSync(join(tmpdir(), "ahub-startup-probe-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/owner/project.git"]]) {
    if (hubGitSync(["-C", root, ...args], { encoding: "utf8" }).status) throw new Error("fixture git failed");
  }
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, native: false, enabled: false }, snapshots: { enabled: false, keep: 1 } },
    boundedTools: {
      specAvailable: async () => ({ available: true }),
      runner: () => ({ available: availability, sweep: async () => [], stopAll: async () => {}, start: () => { throw new Error("not used"); },
        result: async () => undefined, consumeOutput: async () => {}, cancel: async () => {}, markStale: async () => {} }) as never,
    } });
  cleanups.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  const tests = async () => (await client.request({ t: "status" })).status.taskCapabilities.pi as { tests: boolean; testsReason: string };
  return { daemon, tests };
}

test("a slow first runner probe does not hold startup, and the runner becomes available when it settles", async () => {
  let settle!: (value: RunnerState) => void, calls = 0;
  const f = await start(() => { calls++; return new Promise<RunnerState>(resolve => { settle = resolve; }); });
  // Startup returned while the probe is still open.
  expect(calls).toBe(1);
  expect(await f.tests()).toMatchObject({ tests: false, testsReason: "runner unavailable: runner probe in progress" });
  expect(calls).toBe(1); // a status read joins the in-flight probe; it never starts a second one
  settle({ available: true, checkedAt: Date.now() });
  await Bun.sleep(0);
  expect(await f.tests()).toMatchObject({ tests: true });
  expect(calls).toBe(1);
});

test("a fast first runner probe is settled before startup returns, as with a blocking start", async () => {
  const f = await start(async () => ({ available: true, checkedAt: Date.now() }));
  expect(await f.tests()).toMatchObject({ tests: true });
  const g = await start(async () => ({ available: false, reason: "service stopped", checkedAt: Date.now() }));
  expect(await g.tests()).toMatchObject({ tests: false, testsReason: "runner unavailable: service stopped" });
});

test("a first probe that fails leaves the runner unavailable with the fixed reason and never fails startup", async () => {
  const f = await start(async () => { throw new Error("private diagnostic"); });
  const state = await f.tests();
  expect(state.tests).toBe(false);
  expect(state.testsReason).toBe("runner unavailable: container unavailable");
  expect(state.testsReason).not.toContain("private diagnostic");
});

test("daemon stop aborts a first probe that is still open", async () => {
  let signal: AbortSignal | undefined, release!: () => void;
  const f = await start(signal_ => { signal = signal_; return new Promise<RunnerState>(resolve => { release = () => resolve({ available: true }); }); });
  expect(signal?.aborted).toBe(false);
  const stopping = f.daemon.stop();
  await Bun.sleep(0);
  expect(signal?.aborted).toBe(true);
  release(); await stopping;
});
