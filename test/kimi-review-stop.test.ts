import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopKimiReview } from "../src/adapters/kimi-review.ts";
import { stopOwnedProcess, trackGroup } from "../src/hub/child-process.ts";

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) await Bun.sleep(5);
  expect(ready()).toBe(true);
}
function childFixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-stop-")), ready = join(root, "ready"), term = join(root, "term"), lock = join(root, "kimi-code.lock");
  const child = spawn(process.execPath, ["-e", `const {writeFileSync}=require('node:fs');process.on('SIGTERM',()=>writeFileSync(${JSON.stringify(term)},'TERM received'));writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { detached: true, stdio: "ignore" });
  child.once("spawn", () => trackGroup(child)); child.once("error", () => {});
  const cleanup = async () => {
    rmSync(lock, { recursive: true, force: true });
    await stopOwnedProcess(child, { group: true, termMs: 50, killMs: 1000 });
    rmSync(root, { recursive: true, force: true });
  };
  return { root, ready, term, lock, child, cleanup };
}

test("Kimi locked refresh gets SIGTERM grace without SIGKILL until the lock clears", async () => {
  const f = childFixture();
  mkdirSync(f.lock);
  try {
    await waitUntil(() => existsSync(f.ready));
    const started = Date.now();
    await expect(stopKimiReview(f.child, [f.lock], 120)).rejects.toThrow("graceful stop incomplete");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await waitUntil(() => existsSync(f.term));
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
  } finally { await f.cleanup(); }
});

test("Kimi refresh lock clearing during TERM grace completes verified group teardown", async () => {
  const f = childFixture(); mkdirSync(f.lock);
  try {
    await waitUntil(() => existsSync(f.ready));
    const stopped = stopKimiReview(f.child, [f.lock], 2000); stopped.catch(() => {});
    await waitUntil(() => existsSync(f.term));
    expect(f.child.exitCode).toBeNull(); expect(f.child.signalCode).toBeNull();
    rmSync(f.lock, { recursive: true });
    await stopped;
    await waitUntil(() => f.child.exitCode !== null || f.child.signalCode !== null);
    expect(() => process.kill(-f.child.pid!, 0)).toThrow();
  } finally { await f.cleanup(); }
});

test("Kimi without a refresh lock tears down its group without waiting for lock grace", async () => {
  const f = childFixture();
  try {
    await waitUntil(() => existsSync(f.ready));
    const started = Date.now();
    await stopKimiReview(f.child, [f.lock], 10000);
    expect(Date.now() - started).toBeLessThan(5000);
    await waitUntil(() => f.child.exitCode !== null || f.child.signalCode !== null);
    expect(() => process.kill(-f.child.pid!, 0)).toThrow();
  } finally { await f.cleanup(); }
});
