import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
async function startRuntime(options: { noPeer?: boolean; stateDir?: string; kimi?: boolean; pi?: boolean | "enabled"; autoResume?: boolean } = {}): Promise<Runtime> {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "agenthub-delivery-crash-"));
  const marker = join(stateDir, "runtime-events.jsonl");
  const projectId = "delivery-crash-project";
  const args = ["run", join(ROOT, "test/fakes/delivery-runtime.ts"), "--state-dir", stateDir, "--cwd", ROOT, "--project-id", projectId, "--marker", marker];
  if (options.noPeer) args.push("--no-peer");
  if (options.kimi) args.push("--kimi");
  if (options.autoResume) args.push("--auto-resume");
  if (options.pi) args.push(options.pi === "enabled" ? "--pi-enabled" : "--pi");
  const child = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "ignore", stderr: "inherit" });
  const result = { stateDir, marker, process: child };
  cleanup.push(async () => {
    if (!child.killed) { child.kill(); await child.exited; }
    rmSync(stateDir, { recursive: true, force: true });
  });
  await until(() => !!readControl(stateDir), "daemon control manifest");
  // The runtime attaches its claude peer after the daemon is up; a console send before that finds no such peer.
  await until(() => events(result).some((e) => e.type === (options.noPeer ? "daemon-ready" : "peer-ready")), "runtime startup");
  if (options.kimi) await until(() => events(result).some((e) => e.type === "kimi-started"), "kimi start");
  if (options.pi === true) await until(() => events(result).some((e) => e.type === "pi-started"), "pi start");
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

// issue #37: after kill -9 the hub says what died, resumes what it launched itself, and tells each peer what was lost.
test("after a crash: sessions are resumed with the same identity, the report says what to reattach, and the loss notice matches the journal", async () => {
  const first = await startRuntime({ kimi: true });
  const console_ = await consoleClient(first.stateDir);
  expect((await console_.request({ t: "send", to: ["claude"], body: "[IMPORTANT] in flight when the hub dies" })).ok).toBe(true);
  await until(() => events(first).some((e) => e.type === "deliver"), "dispatch to claude");
  const recorded = JSON.parse(readFileSync(join(first.stateDir, "sessions.json"), "utf8"));
  expect(recorded.peers.map((p: any) => p.peer).sort()).toEqual(["claude", "kimi"]);
  expect(recorded.peers.find((p: any) => p.peer === "kimi").meta.sessionId).toBe("s1");
  console_.close();

  await crash(first);
  rmSync(join(first.stateDir, "status.json"), { force: true });
  rmSync(join(first.stateDir, "control-token"), { force: true });
  const second = await startRuntime({ noPeer: true, stateDir: first.stateDir, autoResume: true });
  const after = await consoleClient(second.stateDir);
  const log = () => readFileSync(join(second.stateDir, "hub.log"), "utf8");
  await until(() => log().includes("crash recovery: kimi resumed"), "kimi resumed");
  expect(readFileSync(join(second.stateDir, "acp-load.txt"), "utf8")).toBe("s1"); // session/load, not a new session
  expect(log()).toContain("crash recovery: the previous hub run stopped without shutting down; 1 deliveries it had in flight are in needs_review (ahub queue list)");
  expect(log()).toContain("crash recovery: claude: the Claude Code plugin reconnects by itself while that session is still open");
  const status = await after.request({ t: "status" });
  expect(status.status.peers.kimi.state).toBe("idle");
  expect(status.status.crash).toContain("kimi resumed: kimi: session s1 can be loaded again (ACP session/load)");
  expect(JSON.parse(readFileSync(join(second.stateDir, "sessions.json"), "utf8")).peers.find((p: any) => p.peer === "kimi").meta.sessionId).toBe("s1");

  // claude comes back: the loss notice names the delivery the journal holds in needs_review
  const review = (await after.request({ t: "queue", op: "list", peer: "claude" })).deliveries[0];
  expect(review.state).toBe("needs_review");
  const peer = await ControlClient.connect(second.stateDir, { role: "peer", peer: "claude", projectId: "delivery-crash-project", projectRoot: ROOT });
  const delivered: any[] = [];
  peer.onPush = (msg) => { if (msg.t === "deliver") delivered.push(msg); };
  expect((await after.request({ t: "queue", op: "resolve", id: review.id, revision: review.revision, action: "completed", reason: "checked by hand" })).ok).toBe(true);
  expect((await after.request({ t: "send", to: ["claude"], body: "[IMPORTANT] next" })).ok).toBe(true);
  await until(() => delivered.length > 0, "next delivery");
  const bodies = delivered[0].envs.map((e: any) => e.body).join("\n");
  expect(bodies).toContain("The hub stopped unexpectedly");
  expect(bodies).toContain(`- delivery ${review.id} from user`);
  expect(bodies).not.toContain("in flight when the hub dies"); // ids and senders, never the text
  peer.close();
  after.close();
});

test("a run that recovered from a crash removes the session record on a clean stop, so the next start is no crash", async () => {
  const first = await startRuntime();
  await crash(first);
  rmSync(join(first.stateDir, "status.json"), { force: true });
  rmSync(join(first.stateDir, "control-token"), { force: true });
  const second = await startRuntime({ noPeer: true, stateDir: first.stateDir }); // nothing attaches to rewrite the record
  await until(() => readFileSync(join(second.stateDir, "hub.log"), "utf8").includes("crash recovery: claude:"), "crash report");
  second.process.kill("SIGTERM");
  await second.process.exited;
  expect(existsSync(join(second.stateDir, "sessions.json"))).toBe(false);
});

// issue #68: a running hub records Pi's session file, and after kill -9 the next run loads that same session.
test("after a crash, a headless Pi is resumed on the session file the dead run recorded", async () => {
  const first = await startRuntime({ noPeer: true, pi: true });
  expect(events(first).find((e) => e.type === "pi-started")?.ok).toBe(true);
  await until(() => {
    try { return !!JSON.parse(readFileSync(join(first.stateDir, "sessions.json"), "utf8")).peers.find((p: any) => p.peer === "pi")?.meta.sessionFile; } catch { return false; }
  }, "pi in the session record");
  const recorded = JSON.parse(readFileSync(join(first.stateDir, "sessions.json"), "utf8")).peers.find((p: any) => p.peer === "pi").meta;
  expect(recorded.sessionId).toBe("fake-session");
  await crash(first);
  rmSync(join(first.stateDir, "status.json"), { force: true });
  rmSync(join(first.stateDir, "control-token"), { force: true });
  const second = await startRuntime({ noPeer: true, stateDir: first.stateDir, autoResume: true, pi: "enabled" }); // recovery starts it
  const log = () => readFileSync(join(second.stateDir, "hub.log"), "utf8");
  await until(() => log().includes("crash recovery: pi resumed"), "pi resumed");
  const after = await consoleClient(second.stateDir);
  expect((await after.request({ t: "status" })).status.peers.pi.state).toBe("idle");
  after.close();
  const now = JSON.parse(readFileSync(join(second.stateDir, "sessions.json"), "utf8")).peers.find((p: any) => p.peer === "pi").meta;
  expect([now.sessionId, now.sessionFile]).toEqual([recorded.sessionId, recorded.sessionFile]);
});
