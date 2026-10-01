import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";
import { summarize } from "../src/hub/report.ts";
import { startFakeModelServer } from "./fakes/model-server.ts";

const clean: (() => unknown)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await Bun.sleep(10);
  expect(f()).toBe(true);
};
async function hub(modelUrl?: string, snapshots = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-reliability-"));
  clean.push(() => rmSync(cwd, { recursive: true, force: true }));
  if (snapshots) {
    for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base"]]) {
      expect(Bun.spawnSync(["git", "-C", cwd, ...args]).exitCode).toBe(0);
    }
  }
  const stateDir = join(cwd, ".agenthub", "state");
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: {
    ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    snapshots: { enabled: snapshots, keep: 20 },
    ...(modelUrl ? { omniroute: { urls: [modelUrl], access_hosts: [] } } : {}),
  } });
  clean.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  clean.push(() => console_.close());
  const notices: string[] = [];
  console_.onPush = (m) => { if (m.t === "notice") notices.push(m.line); };
  console_.send({ t: "tail" });
  const op = (op: string, args: unknown) => console_.request({ t: "task", op, args });
  return { cwd, stateDir, daemon, console_, notices, op };
}
class Peer extends BasePeer {
  held = false;
  mode: "completed" | "failed_safe" | "needs_review" = "completed";
  calls = 0;
  work?: () => void;
  got: Envelope[][] = [];
  finish?: () => void;
  async start() { this.setState("idle"); }
  async deliver(envs: Envelope[], id?: string) {
    this.setState("busy"); this.calls++; this.got.push(envs);
    this.onDelivery?.({ id: id!, state: "accepted" });
    const work = this.work; this.work = undefined; work?.();
    this.finish = () => {
      this.onDelivery?.({ id: id!, state: this.mode, reason: "provider unavailable" });
      this.setState("idle");
    };
    if (!this.held) setTimeout(() => this.finish?.(), 1);
  }
  async stop() { this.setState("offline"); }
}
async function attach(daemon: Awaited<ReturnType<typeof startDaemon>>, id: string) {
  const p = new Peer(id); daemon.bus.add(p); await p.start(); return p;
}

test("#95 an idle peer without work pauses without paying for a checkpoint turn", async () => {
  const h = await hub(); const p = await attach(h.daemon, "codex");
  await h.console_.request({ t: "budget", set: { peer: "codex", used: 0.95, resetsInMs: 3600000 } });
  await until(() => h.daemon.bus.stateOf("codex") === "paused");
  expect(p.calls).toBe(0);
  expect(readFileSync(join(h.stateDir, "hub.log"), "utf8")).toContain("no open work, no checkpoint");
});

test("#95 a reviewer with a pending review still receives a checkpoint", async () => {
  const h = await hub(); const owner = await attach(h.daemon, "kimi"); const reviewer = await attach(h.daemon, "codex");
  await h.op("hub_task_propose", { title: "reviewable work", class: "implement", owner: "kimi" });
  await until(() => owner.state === "idle" && owner.calls === 1);
  await h.op("hub_task_accept", { id: 1 }); await h.op("hub_task_done", { id: 1, summary: "done" });
  await until(() => reviewer.state === "idle" && reviewer.calls > 0);
  const before = reviewer.calls;
  await h.console_.request({ t: "budget", set: { peer: "codex", used: 0.95, resetsInMs: 3600000 } });
  await until(() => reviewer.calls > before);
  expect(reviewer.got.flat().some((e) => e.kind === "budget")).toBe(true);
  const tools = await ControlClient.connect(h.stateDir, { role: "tools", peer: "codex" });
  await tools.request({ t: "task", op: "hub_checkpoint", args: { summary: "pending review" } }); tools.close();
});

test("#90 an uncertain delivery announces its hold once and assignment/explain identify it", async () => {
  const h = await hub(); const p = await attach(h.daemon, "kimi"); p.mode = "needs_review";
  await h.console_.request({ t: "send", to: ["kimi"], body: "uncertain work" });
  await until(() => h.daemon.bus.queueSummary("kimi").needsReview === 1);
  const id = h.daemon.bus.queueSummary("kimi").heldBy!;
  await h.op("hub_task_propose", { title: "queued followup", class: "implement", owner: "kimi" });
  const assigned = await h.op("task_assign", { id: 1, peer: "kimi" });
  expect(assigned.text).toContain(`held by needs_review ${id}`);
  expect((await h.op("route_explain", { id: 1 })).text).toContain(id);
  const status = await h.console_.request({ t: "status" });
  expect(status.status.peers.kimi.heldBy).toBe(id);
  expect(h.notices.filter((n) => n.includes(`queue held by needs_review ${id}`))).toHaveLength(1);
  expect(h.notices.find((n) => n.includes(`queue held by needs_review ${id}`))).toContain(`ahub queue resolve ${id}`);
});

test("#89 exhausted task deliveries escalate and three failures exclude the peer until completion", async () => {
  const h = await hub(); const p = await attach(h.daemon, "local"); p.mode = "failed_safe";
  const k = await attach(h.daemon, "kimi");
  await h.op("hub_task_propose", { title: "give up", class: "implement", owner: "local" });
  await until(() => h.notices.some((n) => n.includes("undeliverable to local")), 6000);
  expect(JSON.parse((await h.op("task_show", { id: 1 })).text).owner).toBe("kimi");
  for (let i = 0; i < 2; i++) {
    await h.console_.request({ t: "send", to: ["local"], body: `failure ${i}` });
    await until(() => summarize(readEvents(join(h.stateDir, "events.jsonl"))).messages.undeliverable >= i + 2, 6000);
  }
  expect(h.daemon.bus.failingPeers().local).toContain("provider unavailable");
  expect((await h.op("route_explain", { class: "implement", title: "next" })).text).toContain("skipped, failing:");
  p.mode = "completed";
  await h.console_.request({ t: "send", to: ["local"], body: "recovered" });
  await until(() => !h.daemon.bus.failingPeers().local);
  expect(k.calls).toBeGreaterThan(0);
}, 20000);

test("#89 local refuses absent and unserved gateways; #93 idle replacement changes the next model and busy refuses", async () => {
  const absent = await hub();
  expect((await absent.console_.request({ t: "start", peer: "local" })).error).toContain("no model gateway");
  const model = startFakeModelServer({ key: "k" }); clean.push(model.stop);
  const previous = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "k";
  clean.push(() => { if (previous === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = previous; });
  const h = await hub(model.url);
  expect((await h.console_.request({ t: "start", peer: "local", args: { model: "missing/model" } })).error).toContain("not served");
  expect((await h.console_.request({ t: "start", peer: "local", args: { model: "vllm/x" } })).ok).toBe(true);
  expect((await h.console_.request({ t: "start", peer: "local" })).already).toBe(true);
  expect((await h.console_.request({ t: "start", peer: "local", args: { model: "vllm/next" } })).model).toBe("vllm/next");
  let finish!: () => void;
  model.state.script = async () => { await new Promise<void>((r) => finish = r); return { content: "done" }; };
  await h.console_.request({ t: "send", to: ["local"], body: "use the new model" });
  await until(() => !!finish);
  expect(model.requests.at(-1)?.body.model).toBe("vllm/next");
  expect((await h.console_.request({ t: "start", peer: "local", args: { model: "vllm/x" } })).error).toBe("local is busy; retry when it is idle");
  finish(); await until(() => h.daemon.bus.stateOf("local") === "idle");
  await h.console_.request({ t: "pause", peer: "local" });
  model.state.healthy = false;
  const refusedResume = await h.console_.request({ t: "resume", peer: "local" });
  expect(refusedResume.ok).toBe(false);
  expect(h.daemon.bus.stateOf("local")).toBe("paused");
  model.state.healthy = true;
  expect((await h.console_.request({ t: "resume", peer: "local" })).ok).toBe(true);
  expect(h.daemon.bus.stateOf("local")).toBe("idle");
  model.state.script = () => ({ content: "task done" });
  const beforeTask = model.requests.length;
  await h.op("hub_task_propose", { title: "use the pinned model for a task too", class: "implement", owner: "local" });
  await until(() => model.requests.length > beforeTask);
  expect(model.requests.at(-1)?.body.model).toBe("vllm/next");
});

test("#89 inventory membership cannot mask a provider credential failure", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new URL(req.url).pathname.endsWith("/models") ? Response.json({ data: [{ id: "served-but-broken" }] }) : new Response("secret provider detail", { status: 401 }) });
  clean.push(() => server.stop(true));
  const before = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "k";
  clean.push(() => { if (before === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = before; });
  const h = await hub(`http://127.0.0.1:${server.port}/v1`);
  const result = await h.console_.request({ t: "start", peer: "local", args: { model: "served-but-broken" } });
  expect(result.ok).toBe(false); expect(result.error).toContain("not usable"); expect(result.error).not.toContain("secret provider detail");
  expect(h.daemon.bus.peers.has("local")).toBe(false);
});


test("#91 concurrent edits of a task already moved to review notify both owners once with turn ids", async () => {
  const h = await hub(undefined, true); const k = await attach(h.daemon, "kimi"); const c = await attach(h.daemon, "codex");
  await h.op("hub_task_propose", { title: "first", class: "implement", owner: "kimi", refs: { paths: ["shared.txt"] } });
  await h.op("hub_task_propose", { title: "second", class: "implement", owner: "codex", refs: { paths: ["shared.txt"] } });
  await until(() => k.state === "idle" && c.state === "idle" && !h.daemon.bus.queued("kimi") && !h.daemon.bus.queued("codex"));
  await h.op("hub_task_accept", { id: 1 }); await h.op("hub_task_accept", { id: 2 });
  k.held = true; k.work = () => writeFileSync(join(h.cwd, "shared.txt"), "kimi");
  await h.console_.request({ t: "send", to: ["kimi"], body: "first edit" });
  await until(() => k.state === "busy");
  c.held = true; c.work = () => writeFileSync(join(h.cwd, "shared.txt"), "codex");
  await h.console_.request({ t: "send", to: ["codex"], body: "second edit" });
  await until(() => c.state === "busy");
  await h.op("hub_task_done", { id: 1, summary: "ready for review" });
  expect(JSON.parse((await h.op("task_show", { id: 1 })).text).state).toBe("in_review");
  c.held = false; c.finish!(); k.held = false; k.finish!();
  const file = join(h.stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "conflict" && e.concurrent));
  const concurrent = readEvents(file).filter((e) => e.type === "conflict" && e.concurrent);
  expect(concurrent).toHaveLength(1);
  expect(concurrent[0]).toMatchObject({ paths: ["shared.txt"], turns: expect.arrayContaining([expect.stringContaining("kimi#"), expect.stringContaining("codex#")]) });
  await until(() => k.got.flat().some((e) => e.body.includes("Concurrent edit:")) && c.got.flat().some((e) => e.body.includes("Concurrent edit:")));
  expect(summarize(readEvents(file)).conflicts).toBe(1);
});

test("#91 sequential overwrite of an in_review task is still a conflict", async () => {
  const h = await hub(undefined, true); const k = await attach(h.daemon, "kimi"); const c = await attach(h.daemon, "codex");
  await h.op("hub_task_propose", { title: "first", class: "implement", owner: "kimi" });
  await h.op("hub_task_propose", { title: "second", class: "implement", owner: "codex" });
  await until(() => k.state === "idle" && c.state === "idle" && k.calls > 0 && c.calls > 0);
  await h.op("hub_task_accept", { id: 1 }); await h.op("hub_task_accept", { id: 2 });
  k.work = () => writeFileSync(join(h.cwd, "shared.txt"), "kimi");
  await h.console_.request({ t: "send", to: ["kimi"], body: "first edit" });
  await until(() => k.state === "idle");
  await h.op("hub_task_done", { id: 1, summary: "ready for review" });
  await until(() => c.state === "idle" && !h.daemon.bus.queued("codex"));
  c.work = () => writeFileSync(join(h.cwd, "shared.txt"), "codex");
  await h.console_.request({ t: "send", to: ["codex"], body: "overwrite" });
  const file = join(h.stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "conflict"));
  expect(readEvents(file).find((e) => e.type === "conflict")).toMatchObject({ peer: "codex", other: 1, owner: "kimi", concurrent: false, paths: ["shared.txt"] });
});


test("#91 self-claims after both turns start still associate concurrent edits with their tasks", async () => {
  const h = await hub(undefined, true); const k = await attach(h.daemon, "kimi"); const c = await attach(h.daemon, "codex");
  k.held = true; c.held = true;
  await h.console_.request({ t: "send", to: ["kimi"], body: "claim your own work" });
  await h.console_.request({ t: "send", to: ["codex"], body: "claim your own work too" });
  await until(() => k.state === "busy" && c.state === "busy");
  for (const peer of ["kimi", "codex"]) {
    const tools = await ControlClient.connect(h.stateDir, { role: "tools", peer });
    const result = await tools.request({ t: "task", op: "hub_task_propose", args: { title: `${peer} self-claimed work`, class: "implement", owner: peer, refs: { paths: ["shared.txt"] } } });
    expect(result.text).toContain("in_progress"); tools.close();
  }
  writeFileSync(join(h.cwd, "shared.txt"), "kimi then codex");
  c.held = false; c.finish!(); k.held = false; k.finish!();
  const file = join(h.stateDir, "events.jsonl");
  await until(() => readEvents(file).some((e) => e.type === "conflict" && e.concurrent));
  expect(readEvents(file).filter((e) => e.type === "conflict" && e.concurrent)).toHaveLength(1);
  await until(() => k.got.flat().some((e) => e.body.includes("Concurrent edit:")) && c.got.flat().some((e) => e.body.includes("Concurrent edit:")));
});
