import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { CompletionStore } from "../src/hub/completions-store.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";

// #1054 T3 with fake adapters: the real daemon and control protocol, peers whose turns the test ends by hand. AC1 to AC5.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A peer whose turn stays busy until the test ends it, so a turn end is explicit. */
class Manual extends BasePeer {
  readonly got: Envelope[] = [];
  /** A hub-owned headless peer, so the person's `ahub stop` reaches it. */
  readonly hubOwned = true;
  readonly form = "headless" as const;
  private pending: string | undefined;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) {
    this.got.push(...envs);
    this.pending = id;
    if (id) this.onDelivery?.({ id, state: "accepted" });
    this.setState("busy");
  }
  /** The turn ends: the delivery completes and the peer is idle. */
  end() { const id = this.pending; this.pending = undefined; this.setState("idle"); if (id) this.onDelivery?.({ id, state: "completed" }); }
}

const until = async (condition: () => boolean, label: string) => { for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10); if (!condition()) throw new Error(`timed out waiting for ${label}`); };

async function rig(options: { keep?: { cwd: string }; peers?: string[]; checks?: Record<string, string | number>; store?: (store: CompletionStore) => CompletionStore } = {}) {
  const cwd = options.keep?.cwd ?? realPath(mkdtempSync(join(tmpdir(), "ahub-completions-d-")));
  if (!options.keep) cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  if (!options.keep) { gitProject(cwd); writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n'); }
  const daemon = await startDaemon({ cwd, stateDir, projectId: "completions-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, questionSweepMs: 50, ...(options.store ? { completionStore: options.store } : {}),
    config: { ...DEFAULT_CONFIG, ...(options.checks ? { checks: { ...DEFAULT_CONFIG.checks, ...options.checks } } : {}), batch_ms: 0, questions: { ttl_s: 86_400, wait_ms: { codex: 60_000, pi: 60_000, local: 60_000 } }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const peers: Record<string, Manual> = {};
  for (const id of options.peers ?? ["codex", "pi"]) { peers[id] = new Manual(id); daemon.bus.add(peers[id]); await peers[id].start(); }
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const clients: ControlClient[] = [person];
  const agent = async (peer: string) => { const c = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: cwd }); clients.push(c); return c; };
  const events = () => readEvents(join(stateDir, "events.jsonl"));
  const completions = () => events().flatMap(e => e.type === "completion" ? [e] : []);
  const rows = () => { const probe = new CompletionStore(join(stateDir, "hub.db")); try { return probe.list(); } finally { probe.close(); } };
  const say = (to: string, body = "please do the thing") => person.request({ t: "send", body, to: [to] });
  const close = async () => { for (const c of clients) c.close(); await daemon.stop(); };
  cleanup.push(close);
  return { cwd, stateDir, daemon, peers, person, agent, events, completions, rows, say, close };
}
const ASK = { questions: [{ id: "q", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };

test("a person's message to a peer opens a run, and its turn ending with nothing pending creates exactly one completion", async () => {
  const f = await rig();
  expect((await f.say("codex")).ok).toBe(true);
  await until(() => f.peers.codex!.state === "busy", "the turn");
  expect(f.completions()).toEqual([]);
  f.peers.codex!.end();
  await until(() => f.completions().length === 1, "the completion");
  expect(f.completions()[0]).toMatchObject({ peer: "codex", outcome: "done" });
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ peer: "codex", outcome: "done", private: false });
});

test("AC1 a turn that ends while a continuation is queued creates no completion until the continuation's turn settles", async () => {
  const f = await rig();
  await f.say("codex", "first");
  await until(() => f.peers.codex!.state === "busy", "the first turn");
  await f.say("codex", "second");                                            // queues behind the busy turn: it will start a continuation
  f.peers.codex!.end();                                                      // turn 1 ends, and the queued message starts turn 2 at once
  await until(() => f.peers.codex!.got.length === 2, "the continuation delivery");
  await Bun.sleep(120);
  expect(f.completions()).toEqual([]);                                       // the run is still working
  f.peers.codex!.end();
  await until(() => f.completions().length === 1, "the one completion");
  await Bun.sleep(120);
  expect(f.completions()).toHaveLength(1);
});

test("AC2 an open question keeps the run in needs-input; answering it and the next settle create exactly one completion", async () => {
  const f = await rig();
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  const agent = await f.agent("codex");
  void agent.request({ t: "task", op: "hub_ask", args: ASK });
  const openQuestions = async () => ((await f.person.request({ t: "questions" })).questions as { set: string }[]).length;
  for (let i = 0; i < 300 && await openQuestions() === 0; i++) await Bun.sleep(10);       // the row exists before the turn is allowed to end
  expect(await openQuestions()).toBe(1);
  f.peers.codex!.end();                                                      // the turn ends while the question is open
  await Bun.sleep(150);
  expect(f.completions()).toEqual([]);                                       // needs input, not done
  const open = (await f.person.request({ t: "questions" })).questions as { set: string }[];
  expect(open).toHaveLength(1);
  await f.person.request({ t: "answer", questionSet: open[0]!.set, surface: "console", answers: [{ questionId: "q", optionIds: ["a"] }] });
  await until(() => f.completions().length === 1, "the completion after the answer");
  await Bun.sleep(120);
  expect(f.completions()).toHaveLength(1);
});

test("AC3 a completion check the peer owns keeps the run working after its turn ends, and the check's end settles it", async () => {
  const gate = join(tmpdir(), `ahub-completions-gate-${crypto.randomUUID()}`);
  cleanup.push(() => rmSync(gate, { force: true }));
  const f = await rig({ checks: { timeout_s: 600, implement: `while [ ! -e ${gate} ]; do sleep 0.05; done` } });
  // a task codex owns: its check is queued by hub_task_done and runs until the gate file exists
  await f.person.request({ t: "task", op: "hub_task_propose", args: { title: "owned work", class: "implement", owner: "codex" } });
  const codex = await f.agent("codex");
  await codex.request({ t: "task", op: "hub_task_accept", args: { id: 1 } });
  await until(() => f.peers.codex!.state === "busy", "the task assignment turn");
  f.peers.codex!.end();                                                      // the hub's own assignment turn: no person started it, so it is no run
  await until(() => f.peers.codex!.state === "idle", "the idle peer");
  expect(f.rows()).toEqual([]);
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the person's turn");
  const done = await codex.request({ t: "task", op: "hub_task_done", args: { id: 1, summary: "finished" } });
  expect(String(done.text), JSON.stringify(done)).toContain("its check is queued or running");
  f.peers.codex!.end();                                                      // the turn ends while the check still runs
  await Bun.sleep(250);
  expect(f.completions()).toEqual([]);                                       // working: the check is the peer's own
  writeFileSync(gate, "go");                                                 // the check finishes
  await until(() => f.completions().length === 1, "the completion once the check ended");
  expect(f.completions()[0]).toMatchObject({ peer: "codex", outcome: "done" });
});

test("AC4 an explicit person Stop creates no completion, and a stopped peer leaves no open run for a restart to turn into one", async () => {
  const f = await rig({ peers: ["local", "codex"] });
  await f.say("local");
  await until(() => f.peers.local!.state === "busy", "the turn");
  const stopped = await f.person.request({ t: "peer_stop", peer: "local" });
  expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
  await until(() => f.peers.local!.state === "offline", "the stop");
  await Bun.sleep(150);
  expect(f.completions()).toEqual([]);
  expect(f.rows()).toEqual([]);
  const probe = new CompletionStore(join(f.stateDir, "hub.db"));
  try { expect(probe.openRuns()).toEqual([]); } finally { probe.close(); }      // no row is left for a restart to turn into an interrupted completion
});

test("AC4 a run that settles while the peer's budget is paused ends without a completion: a budget pause stays a budget need", async () => {
  const f = await rig();
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  const budget = (f.daemon as unknown as { bus: unknown }).bus;
  void budget;
  // a persisted pause record is what `budget.record(peer)` reads; write one the way the coordinator does
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(f.stateDir, "hub.db"));
  db.run("INSERT OR REPLACE INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES ('codex', ?, ?, 'five_hour window', '', 0, '[]')", [Date.now(), Date.now() + 3_600_000]);
  db.close();
  f.peers.codex!.end();
  await Bun.sleep(250);
  expect(f.completions()).toEqual([]);
  const probe = new CompletionStore(join(f.stateDir, "hub.db"));
  try { expect(probe.openRuns()).toEqual([]); expect(probe.list()).toEqual([]); } finally { probe.close(); }
});

test("an agent-to-agent delivery starts no run, so its turn creates no completion", async () => {
  const f = await rig();
  const claude = await f.agent("pi");
  await claude.request({ t: "send", body: "hello codex", to: ["codex"] });
  await until(() => f.peers.codex!.state === "busy", "the turn");
  f.peers.codex!.end();
  await Bun.sleep(200);
  expect(f.completions()).toEqual([]);
});

test("AC5 a hub restart mid-run creates one interrupted completion, and repeated restarts never make a second", async () => {
  const f = await rig();
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  const { cwd, stateDir } = f;
  const config = { ...DEFAULT_CONFIG };
  void config;
  // the hub goes down with the run open (its row is in hub.db), and comes back up three times
  await f.close();
  cleanup.length = 0;
  const outcomes: number[] = [];
  for (let restart = 0; restart < 3; restart++) {
    const again = await rig({ keep: { cwd } });
    await until(() => again.completions().length >= 1, `the interrupted completion after restart ${restart + 1}`);
    outcomes.push(again.completions().length);
    await again.close();
    cleanup.length = 0;
  }
  expect(outcomes).toEqual([1, 1, 1]);
  const probe = new CompletionStore(join(stateDir, "hub.db"));
  try { expect(probe.list().map(c => c.outcome)).toEqual(["interrupted"]); } finally { probe.close(); }
});

test("a recovery target without the completions feature is refused while a run is open or a completion is unread, and the label is advertised", async () => {
  expect(DAEMON_FEATURES).toContain("completions");
  const f = await rig();
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  const without = DAEMON_FEATURES.filter(feature => feature !== "completions");
  const instanceId = ((await f.person.request({ t: "status" })).status as { instanceId: string }).instanceId;
  const inspect = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: instanceId, targetFeatures: without });
  expect(JSON.stringify(inspect)).toContain("completions");
});

test("no prompt or reply text reaches hub.db completion rows, the log or events.jsonl", async () => {
  const f = await rig();
  await f.say("codex", "TOPSECRET-PROMPT-TEXT");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  f.peers.codex!.end();
  await until(() => f.completions().length === 1, "the completion");
  const { readFileSync } = await import("node:fs");
  // The bus already logs a message it routes (its own line, not this feature's), so the sinks this feature writes are checked: events.jsonl and every completion log line.
  expect(readFileSync(join(f.stateDir, "events.jsonl"), "utf8")).not.toContain("TOPSECRET-PROMPT-TEXT");
  expect(readFileSync(join(f.stateDir, "hub.log"), "utf8").split("\n").filter(line => /\bcompletion\b/i.test(line))).toEqual([]);
  const probe = new CompletionStore(join(f.stateDir, "hub.db"));
  try { expect(JSON.stringify(probe.list())).not.toContain("TOPSECRET-PROMPT-TEXT"); } finally { probe.close(); }
  expect(Object.keys(f.completions()[0]!).sort()).toEqual(["at", "id", "ms", "outcome", "peer", "type", "v"]);
});

test("a person-started run whose local worker stops at its step ceiling is stored `limit`, never `done`, and a run that concludes on its own is `done`", async () => {
  const prior = process.env.OMNIROUTE_API_KEY; process.env.OMNIROUTE_API_KEY = "completions-fixture-key";
  cleanup.push(() => { if (prior === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prior; });
  const { startFakeModelServer, toolCall } = await import("./fakes/model-server.ts");
  const model = startFakeModelServer({ key: "completions-fixture-key", script: body => {
    const wantsLoop = String(body.messages.findLast(message => message.role === "user")?.content).includes("LOOP");
    return wantsLoop ? { content: "still going", tool_calls: [toolCall("read", { path: "nowhere.txt" })] } : { content: "all done" };
  } });
  cleanup.push(model.stop);
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-completions-limit-"))), stateDir = join(cwd, "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, local: { ...DEFAULT_CONFIG.local, max_steps: 2 }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [model.url], access_hosts: [] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "start", peer: "local", args: { model: "vllm/test" } })).ok).toBe(true);
  const completions = () => readEvents(join(stateDir, "events.jsonl")).flatMap(e => e.type === "completion" ? [e] : []);
  await client.request({ t: "send", body: "LOOP forever", to: ["local"] });
  await until(() => completions().length === 1, "the looping run's completion");
  expect(completions()[0]).toMatchObject({ peer: "local", outcome: "limit" });
  await until(() => daemon.bus.stateOf("local") === "idle", "the local worker idle");
  await client.request({ t: "send", body: "just answer", to: ["local"] });
  await until(() => completions().length === 2, "the second run's completion");
  expect(completions()[1]).toMatchObject({ peer: "local", outcome: "done" });
}, 30_000);

test("a failed completion write leaves the run open and a later settle succeeds; a quiet stop whose write fails keeps the run too", async () => {
  let failing = true, attempts = 0;
  const f = await rig({ peers: ["local", "codex"], store: store => {
    const settle = store.settle.bind(store), dropRun = store.dropRun.bind(store);
    store.settle = (...args) => { attempts++; if (failing) throw new Error("database is locked"); return settle(...args); };
    store.dropRun = (...args) => { if (failing) throw new Error("database is locked"); return dropRun(...args); };
    return store;
  } });
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  f.peers.codex!.end();
  await until(() => attempts >= 1, "the settle attempt");
  await Bun.sleep(150);
  expect(f.completions()).toEqual([]);                                       // the write threw: nothing was claimed
  const open = () => { const s = new CompletionStore(join(f.stateDir, "hub.db")); try { return s.openRuns(); } finally { s.close(); } };
  expect(open()).toHaveLength(1);                                            // and the durable row is still the run's, not a false interrupted
  failing = false;
  // the next callback that can change a fact retries the very same run: a queue change is one
  await f.say("codex", "again");
  await until(() => f.peers.codex!.state === "busy", "the continuation turn");
  f.peers.codex!.end();
  await until(() => f.completions().length === 1, "the completion once the store works");
  await Bun.sleep(150);
  expect(f.completions()).toHaveLength(1);
  expect(open()).toEqual([]);
  // a quiet stop whose write fails leaves the run tracked, so it is not silently lost either
  failing = true;
  await f.say("local");
  await until(() => f.peers.local!.state === "busy", "the local turn");
  const refused = await f.person.request({ t: "peer_stop", peer: "local" });
  expect(refused.ok, JSON.stringify(refused)).toBe(true);
  expect(open()).toHaveLength(1);
  failing = false;
  expect(f.completions()).toHaveLength(1);
}, 30_000);

test("a hub restart while a budget-paused peer still has pending work drops its run without a completion, instead of reading it as interrupted", async () => {
  const f = await rig();
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  await f.say("codex", "queued behind the busy turn");                          // pending work the paused peer cannot drain
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(f.stateDir, "hub.db"));
  db.run("INSERT OR REPLACE INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES ('codex', ?, ?, 'five_hour window', '', 0, '[]')", [Date.now(), Date.now() + 3_600_000]);
  db.close();
  f.peers.codex!.end();                                                         // the turn ends, but the queued message keeps the run working, so it does not settle
  await Bun.sleep(200);
  expect(f.completions()).toEqual([]);
  const open = () => { const s = new CompletionStore(join(f.stateDir, "hub.db")); try { return s.openRuns().length; } finally { s.close(); } };
  expect(open()).toBe(1);                                                       // the row survives until the restart decides
  const { cwd } = f;
  await f.close(); cleanup.length = 0;
  const again = await rig({ keep: { cwd } });
  await Bun.sleep(250);
  expect(again.completions()).toEqual([]);                                      // no interrupted result for a budget need
  const probe = new CompletionStore(join(again.stateDir, "hub.db"));
  try { expect(probe.openRuns()).toEqual([]); expect(probe.list()).toEqual([]); } finally { probe.close(); }
  await again.close(); cleanup.length = 0;
}, 30_000);

test("a restart without a budget pause still settles the open run interrupted, once (the pause rule does not swallow ordinary runs)", async () => {
  const f = await rig();
  await f.say("codex");
  await until(() => f.peers.codex!.state === "busy", "the turn");
  const { cwd } = f;
  await f.close(); cleanup.length = 0;
  const again = await rig({ keep: { cwd } });
  await until(() => again.completions().length === 1, "the interrupted completion");
  expect(again.completions()[0]).toMatchObject({ peer: "codex", outcome: "interrupted" });
  await again.close(); cleanup.length = 0;
}, 30_000);
