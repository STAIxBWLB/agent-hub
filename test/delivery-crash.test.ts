import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, readControl } from "../src/hub/control-client.ts";

const ROOT = join(import.meta.dir, "..");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(10);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

type Runtime = { stateDir: string; marker: string; process: Bun.Subprocess };
async function startRuntime(options: { noPeer?: boolean; stateDir?: string } = {}): Promise<Runtime> {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "agenthub-delivery-crash-"));
  const marker = join(stateDir, "runtime-events.jsonl");
  const projectId = "delivery-crash-project";
  const args = ["run", join(ROOT, "test/fakes/delivery-runtime.ts"), "--state-dir", stateDir, "--cwd", ROOT, "--project-id", projectId, "--marker", marker];
  if (options.noPeer) args.push("--no-peer");
  const child = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  const result = { stateDir, marker, process: child };
  cleanup.push(async () => {
    if (!child.killed) { child.kill(); await child.exited; }
    rmSync(stateDir, { recursive: true, force: true });
  });
  await until(() => !!readControl(stateDir), "daemon control manifest");
  await until(() => events(result).some((e) => e.type === "daemon-ready"), "runtime startup");
  return result;
}

function events(runtime: Runtime): Record<string, any>[] {
  try { return readFileSync(runtime.marker, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.pid === runtime.process.pid); } catch { return []; }
}

async function consoleClient(stateDir: string): Promise<ControlClient> {
  return ControlClient.connect(stateDir, { role: "console", projectId: "delivery-crash-project", projectRoot: ROOT });
}

async function crash(runtime: Runtime): Promise<void> {
  runtime.process.kill(9);
  await runtime.process.exited;
}

async function restart(runtime: Runtime, noPeer = true): Promise<Runtime> {
  await crash(runtime);
  // SIGKILL leaves the old manifest behind; remove only these test-owned
  // discovery files so startup polling cannot reconnect to the dead port.
  rmSync(join(runtime.stateDir, "status.json"), { force: true });
  rmSync(join(runtime.stateDir, "control-token"), { force: true });
  return startRuntime({ noPeer, stateDir: runtime.stateDir });
}

test("crash preserves paused queued delivery metadata and replays it once after the same peer returns", async () => {
  const first = await startRuntime();
  const console_ = await consoleClient(first.stateDir);
  expect((await console_.request({ t: "pause", peer: "claude" })).ok).toBe(true);
  const firstSent = await console_.request({ t: "send", to: ["claude"], body: "[IMPORTANT] replay me" });
  const secondSent = await console_.request({ t: "send", to: ["claude"], body: "[STATUS] keep this after restart" });
  expect(firstSent.ok).toBe(true);
  expect(secondSent.ok).toBe(true);
  const before = await console_.request({ t: "queue", op: "list", peer: "claude" });
  expect(before.ok).toBe(true);
  expect(before.deliveries).toHaveLength(2);
  expect(before.deliveries.map((row: any) => row.state)).toEqual(["queued", "queued"]);
  expect(before.deliveries.map((row: any) => row.important)).toEqual([true, false]);
  console_.close();

  const recovered = await restart(first, true);
  const after = await consoleClient(recovered.stateDir);
  const restored = await after.request({ t: "queue", op: "list", peer: "claude" });
  expect(restored.deliveries).toHaveLength(2);
  expect(restored.deliveries.map((row: any) => row.state)).toEqual(["queued", "queued"]);
  expect(restored.deliveries.map((row: any) => row.important)).toEqual([true, false]);
  const peer = await ControlClient.connect(recovered.stateDir, { role: "peer", peer: "claude", projectId: "delivery-crash-project", projectRoot: ROOT });
  const delivered: any[] = [];
  peer.onPush = (msg) => { if (msg.t === "deliver") delivered.push(msg); };
  expect((await after.request({ t: "resume", peer: "claude" })).ok).toBe(true);
  await until(() => delivered.length === 1, "one replayed delivery");
  expect(delivered[0].envs.map((env: any) => env.body)).toEqual(["replay me", "keep this after restart"]);
  expect((await after.request({ t: "queue", op: "list", peer: "claude" })).deliveries.every((row: any) => ["dispatching", "accepted"].includes(row.state))).toBe(true);
  peer.close();
  after.close();
});

test("a killed handoff becomes needs_review, blocks later work, and resolves idempotently without redelivery", async () => {
  const first = await startRuntime();
  const console_ = await consoleClient(first.stateDir);
  const sent = await console_.request({ t: "send", to: ["claude"], body: "[IMPORTANT] uncertain execution" });
  expect(sent.ok).toBe(true);
  await until(() => events(first).some((e) => e.type === "deliver"), "dispatch handoff");
  const pending = await console_.request({ t: "queue", op: "list", peer: "claude" });
  expect(["dispatching", "accepted"]).toContain(pending.deliveries[0].state);
  const recovered = await restart(first, true);
  const after = await consoleClient(recovered.stateDir);
  const review = await after.request({ t: "queue", op: "list", peer: "claude" });
  expect(review.deliveries[0].state).toBe("needs_review");
  expect(events(recovered).filter((e) => e.type === "deliver")).toHaveLength(0);
  const id = review.deliveries[0].id;
  const revision = review.deliveries[0].revision;
  const later = await after.request({ t: "send", to: ["claude"], body: "blocked until reviewed" });
  expect(later.ok).toBe(true);
  expect((await after.request({ t: "queue", op: "list", peer: "claude" })).deliveries.map((row: any) => row.state)).toEqual(["needs_review", "queued"]);

  const resolved = await after.request({ t: "queue", op: "resolve", id, revision, action: "completed", reason: "operator verified the external effect" });
  expect(resolved.ok).toBe(true);
  expect(resolved.delivery.state).toBe("completed");
  const repeated = await after.request({ t: "queue", op: "resolve", id, revision: resolved.delivery.revision, action: "completed", reason: "operator verified the external effect" });
  expect(repeated.ok).toBe(true);
  const peer = await ControlClient.connect(recovered.stateDir, { role: "peer", peer: "claude", projectId: "delivery-crash-project", projectRoot: ROOT });
  const delivered: any[] = [];
  peer.onPush = (msg) => { if (msg.t === "deliver") delivered.push(msg); };
  await until(() => delivered.length === 1, "later queued delivery");
  expect(delivered[0].envs[0].body).toBe("blocked until reviewed");
  expect(events(first).filter((e) => e.type === "deliver")).toHaveLength(1);
  peer.close();
  after.close();
  console_.close();
});
