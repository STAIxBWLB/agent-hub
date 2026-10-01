import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, USER, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { assign, currentRouting, detectSignals, loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { Briefs, parseRows } from "../src/memory/brief.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";

class FakePeer extends BasePeer {
  got: Envelope[] = [];
  async deliver(envs: Envelope[]) {
    this.got.push(...envs);
  }
  async start() {
    this.setState("idle");
  }
  async stop() {}
  set(s: PeerState) {
    this.setState(s);
  }
}
const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const tick = () => new Promise((r) => setTimeout(r, 15));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const PII = "patient 900101-1234567 needs a follow-up";

async function setup(peerIds = ["claude", "codex", "kimi", "local"], observations?: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-tasks-"));
  const bus = new Bus({ batchMs: 0 });
  const peers = Object.fromEntries(peerIds.map((id) => [id, new FakePeer(id)]));
  for (const p of Object.values(peers)) {
    bus.add(p);
    await p.start();
  }
  const mem = startFakeMemWorker(observations);
  cleanup.push(mem.stop);
  const memory = new MemoryClient(mem.url);
  const notices: string[] = [];
  const shared: string[] = [];
  const told: string[] = [];
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", memory, briefs: new Briefs(memory, "agent-hub"), notify: (l) => notices.push(l), share: (by, line) => shared.push(`${by}|${line}`), tell: (peer, line) => told.push(`${peer}|${line}`) });
  const saves = () => mem.calls.filter((c) => c.path === "/api/memory/save").map((c) => c.body as any);
  return { dir, bus, peers, board, tasks, notices, shared, told, mem, saves };
}

test("board: moves are validated, history records who did what, the file outlives the process", () => {
  const file = join(mkdtempSync(join(tmpdir(), "agenthub-board-")), "hub.db");
  const board = new Board(file);
  const t = board.propose("claude", { title: "add a flag", class: "implement", refs: { paths: ["src/a.ts"] } });
  expect(t).toMatchObject({ id: 1, state: "proposed", owner: null, rejections: 0, refs: { paths: ["src/a.ts"] } });
  expect(() => board.update(1, "codex", "done", { state: "in_review" })).toThrow(/cannot move to in_review/);
  board.update(1, "codex", "accepted", { state: "in_progress", owner: "codex" });
  board.update(1, "codex", "done", { state: "in_review", refs: { commit: "abc" } }, "flag added");
  expect(() => board.update(1, "codex", "x", { state: "proposed" })).toThrow();
  expect(() => board.update(9, "codex", "x", {})).toThrow(/no task #9/);
  board.close();
  const again = new Board(file).get(1)!;
  expect(again.state).toBe("in_review");
  expect(again.refs).toEqual({ paths: ["src/a.ts"], commit: "abc" });
  expect(again.history.map((h) => `${h.by}:${h.event}`)).toEqual(["claude:proposed", "codex:accepted", "codex:done"]);
});

test("assignment: preference order, idle before busy, paused/offline/detached skipped, explicit owner, local_allowed, long_context, pii", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-routing-"));
  const routing = loadRouting(dir);
  const all = { claude: "idle", codex: "idle", kimi: "idle", local: "idle" } as const;
  const task = (cls: any, signals: string[] = []) => ({ class: cls, signals });
  expect(assign(task("implement"), all, routing)).toMatchObject({ owner: "local", reviewer: "claude" });
  expect(assign(task("implement"), { ...all, codex: "busy" }, routing).owner).toBe("local");
  expect(assign(task("implement"), { codex: "busy", claude: "idle" }, routing).owner).toBe("codex"); // busy beats nobody
  expect(assign(task("implement"), { ...all, codex: "paused", kimi: "offline" }, routing).owner).toBe("local");
  expect(assign(task("implement"), all, routing, { exclude: ["codex", "kimi"] }).owner).toBe("local");
  expect(assign(task("implement"), all, routing, { candidates: ["kimi"] }).owner).toBe("kimi");
  expect(assign(task("implement"), all, routing, { candidates: ["ghost"] }).owner).toBeUndefined();
  expect(assign(task("review"), all, routing)).toMatchObject({ owner: "claude" });
  expect(assign(task("plan"), all, routing, { candidates: ["local"] }).owner).toBeUndefined(); // local_allowed = false
  expect(assign(task("bulk_edit", ["long_context"]), all, routing).owner).toBe("kimi"); // long_context still skips local/Pi
  expect(assign(task("implement"), { codex: "idle", claude: "idle" }, routing).reviewer).toBe("claude");
  expect(assign(task("implement"), all, routing, { candidates: ["claude"] }).reviewer).toBe("codex"); // never reviews its own work

  const pii = assign(task("implement", ["pii"]), all, routing);
  expect(pii).toMatchObject({ owner: "local", reviewer: "user", route: "sy/coding" });
  expect(assign(task("implement", ["pii"]), { claude: "idle", codex: "idle" }, routing).owner).toBeUndefined();
  expect(assign(task("plan", ["pii"]), all, routing).owner).toBeUndefined(); // pii + a class local may not take: nobody
  expect(pii.trace.join("\n")).toContain("candidate codex: skipped, pii: on-prem peers only");

  writeFileSync(join(dir, "big.txt"), "x".repeat(400_000));
  expect(detectSignals({ title: "t", detail: "", refs: { paths: ["big.txt"] } }, routing, dir)).toEqual(["long_context"]);
  expect(detectSignals({ title: "record of 900101-1234567", detail: "", refs: {} }, routing, dir)).toEqual(["pii"]);
  expect(detectSignals({ title: "plain", detail: "", refs: { paths: ["missing.txt"] } }, routing, dir)).toEqual([]);
});

test("propose -> assigned by class -> accept -> done -> review envelope -> approved; only the owner and the reviewer may act", async () => {
  const { tasks, peers, board, saves } = await setup();
  const t = await tasks.propose("claude", { title: "add --json to ahub status", class: "implement", refs: { paths: ["src/cli/main.ts"] } });
  await tick();
  expect(t).toMatchObject({ owner: "local", reviewer: "claude", state: "proposed" });
  const offer = peers.local!.got.at(-1)!;
  expect(offer).toMatchObject({ from: HUB, kind: "task", priority: "important", refs: { task: "1" } });
  expect(offer.body).toContain("Task #1 [implement] add --json to ahub status");
  expect(offer.body).toContain("hub_task_done {id: 1, summary: what changed, why, and the check you ran with its result, refs}");
  expect(peers.kimi!.got).toHaveLength(0);

  expect(() => tasks.accept("kimi", 1)).toThrow(/only its owner \(local\)/);
  tasks.accept("local", 1);
  await expect(tasks.review("claude", 1, "approved")).rejects.toThrow(/cannot move/);
  await tasks.done("local", 1, "flag added, tests pass", { commit: "abc123" });
  await tick();
  const ask = peers.claude!.got.at(-1)!;
  expect(ask.kind).toBe("review");
  expect(ask.body).toContain("commit abc123");
  await expect(tasks.review("codex", 1, "approved")).rejects.toThrow(/only its reviewer/);
  await tasks.review("claude", 1, "approved", "clean");
  await tick();
  expect(board.get(1)!.state).toBe("approved");
  expect(peers.local!.got.at(-1)!.body).toContain("approved by claude");
  // notes: done and the verdict, not proposed or accepted
  expect(saves().map((s) => s.metadata.kind)).toEqual(["finding", "decision"]);
  expect(saves()[0].metadata).toMatchObject({ peer: "local", task: 1 });
});

test("changes_requested twice escalates to the next attached peer in escalate_to, with the review notes", async () => {
  const { tasks, peers, board, notices } = await setup();
  await tasks.propose("claude", { title: "fix the parser", class: "implement" });
  tasks.accept("local", 1);
  await tasks.done("local", 1, "v1");
  const once = await tasks.review("claude", 1, "changes_requested", "edge case missing");
  expect(once).toMatchObject({ state: "in_progress", owner: "local", rejections: 1 });
  await tasks.done("local", 1, "v2");
  const twice = await tasks.review("claude", 1, "changes_requested", "still wrong");
  await tick();
  expect(twice).toMatchObject({ state: "in_progress", owner: "codex", rejections: 0 });
  expect(peers.codex!.got.at(-1)!.body).toContain("edge case missing");
  expect(peers.local!.got.at(-1)!.body).toContain("moved to codex");
  expect(notices.some((n) => n.includes("escalated from local to codex"))).toBe(true);
  expect(board.get(1)!.history.map((h) => h.event)).toContain("escalated");
});

test("a decline reaches the next peer in the class list; a task that is in review or approved cannot change hands", async () => {
  const { tasks, peers, board } = await setup();
  await tasks.propose("claude", { title: "implement the thing", class: "implement" });
  expect(board.get(1)!.owner).toBe("local");
  const next = await tasks.decline("local", 1, "busy with the release");
  await tick();
  expect(next).toMatchObject({ owner: "codex", state: "proposed" });
  expect(peers.codex!.got.at(-1)!.body).toContain("Task #1");
  expect(tasks.explain(1).join("\n")).toContain("owner candidate local: skipped, excluded");

  tasks.accept("codex", 1);
  await tasks.done("codex", 1, "done", { paths: "src/thing.ts" } as any); // a model sent a string where the schema says array
  await tick();
  expect(board.get(1)).toMatchObject({ state: "in_review", refs: { paths: ["src/thing.ts"] } });
  expect(peers.claude!.got.at(-1)!.body).toContain("paths src/thing.ts"); // the review still went out
  for (const op of [() => tasks.decline("kimi", 1), () => tasks.escalate("user", 1), () => tasks.assignTo(1, "codex")]) {
    await expect(op()).rejects.toThrow(/can no longer change hands/);
  }
});

test("a second rejection escalates to the next configured peer", async () => {
  const { tasks, peers, notices } = await setup();
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  for (const note of ["too long", "still too long"]) {
    await tasks.done("kimi", 1, "v");
    await tasks.review("claude", 1, "changes_requested", note);
  }
  await tick();
  expect(peers.codex!.got.at(-1)!.body).toContain("Task #1");
  expect(notices.at(-1)).toContain("escalated from kimi to codex");
  expect((await tasks.done("codex", 1, "v3")).state).toBe("in_review"); // and the task is not stuck
});

test("a second rejection with no available escalation peer still reaches the owner", async () => {
  const { tasks, peers, notices, board } = await setup(["claude", "kimi"]);
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  for (const note of ["too long", "still too long"]) {
    await tasks.done("kimi", 1, "v");
    await tasks.review("claude", 1, "changes_requested", note);
  }
  await tick();
  expect(board.get(1)!.owner).toBe("kimi");
  expect(peers.kimi!.got.at(-1)!.body).toContain("still too long");
  expect(notices.at(-1)).toContain("stays with kimi");
  expect((await tasks.done("kimi", 1, "v3")).state).toBe("in_review");
});

test("routing.toml is re-read when it changes; a half-saved file keeps the last good policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-rt-"));
  Bun.spawnSync(["mkdir", "-p", join(dir, ".agenthub")]);
  const file = join(dir, ".agenthub", "routing.toml");
  const write = (text: string, when: number) => (writeFileSync(file, text), Bun.spawnSync(["touch", "-t", `2026010100${String(when).padStart(2, "0")}`, file]));
  write('[local]\nfixed_model = "one"\n', 1);
  expect(currentRouting(dir).local.fixed_model).toBe("one");
  write('[local]\nfixed_model = "two"\n', 2);
  expect(currentRouting(dir).local.fixed_model).toBe("two");
  const lines: string[] = [];
  write("[local\nfixed_model =", 3);
  expect(currentRouting(dir, (l) => lines.push(l)).local.fixed_model).toBe("two");
  expect(lines[0]).toContain("keeping the previous policy");
});

test("decline moves on; nobody left keeps it proposed with a notice; the console can assign", async () => {
  const { tasks, notices, board } = await setup(["codex", "kimi"]);
  await tasks.propose("user", { title: "bulk rename", class: "bulk_edit" }); // peers: local, kimi -> kimi
  expect(board.get(1)!.owner).toBe("kimi");
  const after = await tasks.decline("kimi", 1, "no capacity");
  expect(after).toMatchObject({ owner: null, state: "proposed" });
  expect(notices.at(-1)).toContain("ahub task assign 1");
  expect((await tasks.assignTo(1, "codex")).owner).toBe("codex");
  expect((await tasks.assignTo(1, "ghost")).owner).toBe("codex"); // a failed console assign leaves the task where it was
  tasks.accept("codex", 1);
  await tasks.done("codex", 1, "renamed");
  await expect(tasks.done("codex", 1, "again")).rejects.toThrow(/already approved/);
  await expect(tasks.propose("user", { title: "x", class: "nope" })).rejects.toThrow(/class must be one of/);
});

test("a PII task stays on-prem: local only, private envelopes, console review, redacted views, nothing to claude-mem", async () => {
  const { tasks, peers, board, mem, bus, notices } = await setup(undefined, { claude: ["1 10:00a decision patient follow-up policy"] });
  const tapped: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && tapped.push(e.env));
  const t = await tasks.propose("claude", { title: PII, class: "implement", detail: "call 010-1234" });
  await tick();
  expect(t).toMatchObject({ owner: "local", reviewer: "user", signals: ["pii"] });
  for (const id of ["claude", "codex", "kimi"]) expect(peers[id]!.got).toHaveLength(0);
  expect(peers.local!.got[0]).toMatchObject({ private: true, to: ["local"] });
  expect(peers.local!.got[0]!.body).toContain("900101-1234567"); // the on-prem worker gets the real text
  expect(tapped.every((e) => e.private)).toBe(true);
  expect(notices.join("\n")).not.toContain("900101");
  expect(JSON.stringify(tasks.publicView(board.get(1)!))).not.toContain("900101");

  tasks.accept("local", 1);
  await tasks.done("local", 1, "record updated for 900101-1234567");
  expect(board.get(1)!.state).toBe("in_review");
  expect(notices.at(-1)).toContain("ahub review 1");
  await tasks.review("user", 1, "approved");
  await expect(tasks.remember("local", { text: "note", task: 1 })).rejects.toThrow(/PII task are not saved/);
  expect(mem.calls).toHaveLength(0); // no search, no timeline, no save

  // what the worker says about it is private on the bus, so the board keeps it for `ahub task show`
  bus.publish({ ...peers.local!.got[0]!, id: "answer-1", from: "local", to: ["user"], body: "Refused: connect the VPN for 900101-1234567" });
  expect(board.get(1)!.history.at(-1)).toMatchObject({ by: "local", event: "answer", note: "Refused: connect the VPN for 900101-1234567" });

  // a digest that mixes a PII task with an ordinary one is a PII turn as a whole, whichever comes first
  await tasks.propose("claude", { title: "ordinary bulk edit", class: "bulk_edit" });
  await tick();
  const ordinary = peers.local!.got.find((e) => e.refs?.task === "2")!;
  const secret = peers.local!.got.find((e) => e.refs?.task === "1")!;
  expect(tasks.turnPolicy([ordinary, secret])).toMatchObject({ pii: true, route: "sy/fast" });
  expect(tasks.turnPolicy([ordinary])).toMatchObject({ pii: false });
});

test("briefs: matching observations ride with the task; the same peer is not shown the same id twice", async () => {
  const { tasks, peers } = await setup(undefined, { claude: ["65001 10:00a decision switchyard sidecar fallback design"] });
  await tasks.propose("claude", { title: "harden the switchyard sidecar", class: "implement" });
  await tick();
  const first = peers.local!.got.at(-1)!.body;
  expect(first).toContain("Memory brief");
  expect(first).toContain("#65001 10:00a decision switchyard sidecar fallback design");
  expect(first).toContain("#65002"); // the timeline neighbour
  await tasks.assignTo(1, "local");
  await tick();
  expect(peers.local!.got.at(-1)!.body).not.toContain("#65001");
  await tasks.assignTo(1, "kimi");
  await tick();
  expect(peers.kimi!.got.at(-1)!.body).toContain("#65001"); // a different peer has not seen it

  expect(parseRows("| #12 | 9:00 AM | ◆ | A title | ~10 |\nnoise\n| ID | Time |\n| #13 | 9:01 AM | ○ | B <- **ANCHOR** | ~5 |")).toEqual([
    { id: 12, time: "9:00 AM", type: "◆", title: "A title" },
    { id: 13, time: "9:01 AM", type: "○", title: "B" },
  ]);
  expect(parseRows(undefined)).toEqual([]);
});

test("hub_remember carries peer, kind and task; with the worker down the board works and says memory is unavailable", async () => {
  const { tasks, saves, mem } = await setup();
  await tasks.propose("claude", { title: "t", class: "implement" });
  expect(await tasks.remember("codex", { text: "use bun:sqlite, not a server", kind: "decision", task: 1 })).toBe("saved to shared memory; the other agents get it with their next message");
  expect(saves().at(-1)).toMatchObject({ text: "use bun:sqlite, not a server", project: "agent-hub", metadata: { peer: "codex", kind: "decision", task: 1 } });
  mem.stop();
  expect(await tasks.remember("codex", { text: "x" })).toBe("memory worker unavailable; nothing saved");
  tasks.accept("local", 1);
  expect((await tasks.done("local", 1, "done")).state).toBe("in_review");
});

test("budget pause: open work goes to local first through the constraints, reviews move on, PII gets no handoff text", async () => {
  const { tasks, peers, board, bus } = await setup();
  await tasks.propose("claude", { title: "implement parser", class: "implement", owner: "codex" }); // #1 explicit cloud owner
  await tasks.propose("user", { title: "plan the release", class: "plan", owner: "codex" }); // #2 -> codex, local not allowed
  await tasks.propose("claude", { title: "note for 900101-1234567", class: "implement" }); // #3 pii -> local
  await tasks.propose("user", { title: "kimi's change", class: "implement", owner: "kimi" }); // #4, reviewer claude
  tasks.accept("codex", 1);
  tasks.accept("kimi", 4);
  await tasks.done("kimi", 4, "done by kimi");
  await tick();

  bus.pause("codex");
  const moved = await tasks.reassignForPause("codex", "I was halfway through the tokenizer; tests in test/parser.test.ts fail on unicode");
  await tick();
  expect(moved).toEqual([
    { id: 1, title: "#1 implement parser", to: "local", role: "owner" },
    { id: 2, title: "#2 plan the release", to: "claude", role: "owner" }, // never local: local_allowed = false
  ]);
  const handed = peers.local!.got.find((e) => e.refs?.task === "1")!;
  expect(handed.body).toContain("Handoff from the previous owner:\nI was halfway through the tokenizer");
  expect(board.get(1)).toMatchObject({ owner: "local", state: "proposed" });
  expect(board.get(1)!.history.map((h) => h.event)).toEqual(expect.arrayContaining(["released", "reassigned"]));

  bus.pause("claude"); // claude was reviewing #4 (in review) and now owns #2
  const second = await tasks.reassignForPause("claude", "ctx");
  await tick();
  expect(second.find((m) => m.id === 4)).toMatchObject({ role: "reviewer", to: null }); // codex is paused too: nobody left

  // with codex back, the replacement reviewer is codex, never the task's own owner, and gets the full request
  bus.resume("codex");
  board.update(4, "hub", "test setup", { reviewer: "claude" });
  const third = await tasks.reassignForPause("claude", undefined);
  await tick();
  expect(third.find((m) => m.id === 4)).toMatchObject({ role: "reviewer", to: "codex" });
  const ask = peers.codex!.got.at(-1)!;
  expect(ask.kind).toBe("review");
  expect(ask.body).toContain("Done by kimi: done by kimi");
  expect(ask.body).toContain("claude was reviewing this and is paused");
  bus.pause("codex");
  expect(second.find((m) => m.id === 2)).toMatchObject({ role: "owner", to: null });

  // a PII task that has to move keeps its text and gets no peer-written handoff
  bus.resume("codex");
  bus.resume("claude");
  await tasks.reassignForPause("local", "SECRET-HANDOFF-TEXT");
  await tick();
  expect(board.get(3)!.owner).toBeNull(); // only local may hold it
  expect(JSON.stringify(Object.values(peers).flatMap((p) => p.got))).not.toContain("SECRET-HANDOFF-TEXT-for-pii");
  expect(Object.values(peers).filter((p) => p.id !== "local").flatMap((p) => p.got).some((e) => e.body.includes("900101"))).toBe(false);
});

test("triage: a task without a class gets one from the hub's model, recorded in its history; PII goes to the model only on campus", async () => {
  const base = await setup();
  const asked: string[] = [];
  let onCampus = true;
  const tasks = new Tasks({
    board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: () => {},
    triage: { classify: async (title) => (asked.push(title), title.includes("unclear") ? undefined : "bulk_edit"), onCampus: async () => onCampus },
  });
  const t = await tasks.propose("claude", { title: "rename foo to bar everywhere" });
  expect(t).toMatchObject({ class: "bulk_edit", owner: "local" });
  expect(t.history.map((h) => h.event)).toContain("triaged");
  expect((await tasks.propose("claude", { title: "explicit", class: "test" })).class).toBe("test");
  expect(asked).toEqual(["rename foo to bar everywhere"]); // a named class is never second-guessed
  await expect(tasks.propose("claude", { title: "unclear thing" })).rejects.toThrow(/class is required/);

  onCampus = false;
  await expect(tasks.propose("claude", { title: "update the record of 900101-1234567" })).rejects.toThrow(/class is required/);
  expect(asked.some((a) => a.includes("900101"))).toBe(false); // its text never went to a model across Cloudflare
  onCampus = true;
  expect((await tasks.propose("claude", { title: "update the record of 900101-1234567" })).owner).toBe("local");
  await expect(base.tasks.propose("claude", { title: "no triage configured" })).rejects.toThrow(/class is required/);
});

test("route explain runs the assignment code: same owner, skipped candidates named", async () => {
  const { tasks, peers } = await setup();
  peers.codex!.set("offline");
  const lines = tasks.explain({ title: "rename things", class: "implement" });
  expect(lines.join("\n")).toContain("owner candidate codex: skipped, offline");
  expect(lines).toContain("owner: local");
  expect((await tasks.propose("claude", { title: "rename things", class: "implement" })).owner).toBe("local");
  expect(tasks.explain(1)[0]).toContain("#1 rename things (proposed, owner local)");
});

test("notes: fail is a kind, an unknown kind is a finding, every saved note is shared once, PII text is neither saved nor shared", async () => {
  const { tasks, saves, shared, notices } = await setup();
  await tasks.remember("codex", { title: "WAL mode", text: "breaks the test runner:\nthe db stays locked", kind: "fail" });
  await tasks.remember("kimi", { text: "the fake ACP server echoes", kind: "gossip" });
  expect(saves().map((s) => s.metadata.kind)).toEqual(["fail", "finding"]);
  expect(shared).toEqual(["codex|note from codex [fail]: WAL mode: breaks the test runner: the db stays locked", "kimi|note from kimi [finding]: the fake ACP server echoes"]);
  expect(notices).toContain("note from codex [fail]: WAL mode: breaks the test runner: the db stays locked");

  await expect(tasks.remember("codex", { text: PII, kind: "fail" })).rejects.toThrow(/matches a PII pattern/);
  await expect(tasks.remember("codex", { title: PII, text: "call back" })).rejects.toThrow(/matches a PII pattern/);
  expect(saves()).toHaveLength(2);
  expect(shared).toHaveLength(2);
});

test("a claim: naming yourself as owner starts the task in progress with its reviewer, and no offer comes back to you", async () => {
  const { tasks, peers, board, notices } = await setup();
  const t = await tasks.propose("codex", { title: "retry backoff", class: "implement", owner: "codex", refs: { paths: ["src/hub/bus.ts"] } });
  await tick();
  expect(t).toMatchObject({ owner: "codex", reviewer: "claude", state: "in_progress" });
  expect(board.get(1)!.history.map((h) => `${h.by}:${h.event}`)).toEqual(["codex:proposed", "codex:assigned", "codex:accepted"]);
  expect(peers.codex!.got).toHaveLength(0);
  expect(notices).toContain("task #1 retry backoff claimed by codex");
  // naming someone else is still an offer
  await tasks.propose("claude", { title: "docs", class: "implement", owner: "kimi" });
  await tick();
  expect(board.get(2)!.state).toBe("proposed");
  expect(peers.kimi!.got.at(-1)!.kind).toBe("task");
});

test("overlaps: open tasks of other owners on the same paths or a directory of them; the newcomer hears it, the other owner is not interrupted", async () => {
  const { tasks, peers, notices } = await setup();
  await tasks.propose("kimi", { title: "hub refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/"] } });
  const codex = await tasks.propose("codex", { title: "retry backoff", class: "implement", owner: "codex", refs: { paths: ["./src/hub/bus.ts", "README.md"] } });
  expect(tasks.overlaps(codex)).toBe("Overlaps #1 (owner kimi) on ./src/hub/bus.ts. Settle it with that owner via hub_send before editing those paths.");
  expect(tasks.overlaps(codex, false)).toBe("Overlaps #1 (owner kimi) on ./src/hub/bus.ts. codex is told to settle it.");
  expect(notices).toContain("task #2 retry backoff (codex): Overlaps #1 (owner kimi) on ./src/hub/bus.ts. codex is told to settle it.");

  const elsewhere = await tasks.propose("codex", { title: "x", class: "implement", owner: "codex", refs: { paths: ["src/hubx/a.ts"] } });
  const noPaths = await tasks.propose("codex", { title: "y", class: "implement", owner: "codex" });
  const sameOwner = await tasks.propose("kimi", { title: "z", class: "implement", owner: "kimi", refs: { paths: ["src/hub/envelope.ts"] } });
  expect([elsewhere, noPaths, sameOwner].map((t) => tasks.overlaps(t))).toEqual(["", "", ""]);

  // routed to another peer: the overlap rides in the offer
  await tasks.propose("claude", { title: "bus docs", class: "implement", owner: "local", refs: { paths: ["src/hub/bus.ts"] } });
  await tick();
  const offer = peers.local!.got.at(-1)!.body;
  expect(offer).toContain("Overlaps #1 (owner kimi) on src/hub/bus.ts; #2 (owner codex) on src/hub/bus.ts.");
  expect(peers.kimi!.got).toHaveLength(0);

  // a PII task is on neither side
  // nobody can take it yet: whoever does is told when it is assigned
  const unowned = await tasks.propose("claude", { title: "nobody", class: "implement", owner: "offline-peer", refs: { paths: ["src/hub/a.ts"] } });
  expect(unowned.owner).toBeNull();
  expect(tasks.overlaps(unowned, false)).toBe("Overlaps #1 (owner kimi) on src/hub/a.ts. Whoever takes it is told to settle it.");
  // the project root holds everything
  const root = await tasks.propose("claude", { title: "format all", class: "implement", owner: "claude", refs: { paths: ["./"] } });
  expect(tasks.overlaps(root)).toContain("#1 (owner kimi) on ./");
  const pii = await tasks.propose("claude", { title: PII, class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
  expect(pii).toMatchObject({ id: 9, owner: "local" });
  expect(tasks.overlaps(codex)).not.toContain("#9");
  expect(tasks.overlaps(pii)).toBe("");
});

// issue #6: claims that do not fail on a field the caller cannot know, overlaps the earlier owner sees, owners that are gone.
test("a self-claim without a class and without a triage answer is implementation; a proposal for someone else still needs one", async () => {
  const { tasks, board } = await setup();
  const t = await tasks.propose("kimi", { title: "add set()", owner: "kimi", refs: { paths: ["src/cache.ts"] } });
  expect(t).toMatchObject({ class: "implement", owner: "kimi", state: "in_progress" });
  expect(board.get(t.id)!.history.map((h) => h.event)).toContain("class defaulted");
  await expect(tasks.propose("claude", { title: "docs", owner: "kimi" })).rejects.toThrow(/class is required/);
});

test("the earlier owner is told of an overlap through a ride-along line; the newcomer's claim is unchanged", async () => {
  const { tasks, told, peers } = await setup();
  await tasks.propose("kimi", { title: "hub refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub"] } });
  await tasks.propose("codex", { title: "retry backoff", class: "implement", owner: "codex", refs: { paths: ["src/hub/bus.ts"] } });
  await tick();
  expect(told).toEqual(["kimi|note from hub [finding]: task #2 (owner codex) now overlaps your #1 on src/hub/bus.ts; codex is told to settle it"]);
  expect(peers.kimi!.got).toHaveLength(0); // no envelope, no turn
  await tasks.propose("codex", { title: "elsewhere", class: "implement", owner: "codex", refs: { paths: ["docs/x.md"] } });
  expect(told).toHaveLength(1);
});

test("an owner that is gone loses its open tasks to a peer that can take them, and keeps them when nobody can", async () => {
  const { tasks, board, peers, notices } = await setup(["claude", "codex", "kimi"]);
  const t = await tasks.propose("kimi", { title: "half done", class: "implement", owner: "kimi" });
  peers.kimi!.set("offline");
  const moved = await tasks.releaseFromGone("kimi", 31);
  expect(moved).toEqual([{ id: t.id, title: `#${t.id} half done`, to: "codex" }]);
  const after = board.get(t.id)!;
  expect(after.owner).toBe("codex");
  expect(after.history.map((h) => `${h.event}:${h.note ?? ""}`)).toContain("released:owner kimi offline for 31 min");

  const u = await tasks.propose("codex", { title: "codex only", class: "implement", owner: "codex" });
  peers.codex!.set("offline");
  peers.claude!.set("offline");
  expect(await tasks.releaseFromGone("codex", 45)).toEqual([]);
  expect(board.get(u.id)!.owner).toBe("codex");
  expect(board.get(u.id)!.state).toBe("in_progress");
  expect(board.get(u.id)!.history.map((h) => h.event)).not.toContain("released");
  expect(notices.some((l) => l.includes("could not be released"))).toBe(false);
});

test("a released owner is told on its next delivery; a peer back online keeps its work", async () => {
  const { tasks, board, peers, told } = await setup(["claude", "codex", "kimi"]);
  const t = await tasks.propose("kimi", { title: "half done", class: "implement", owner: "kimi" });
  expect(await tasks.releaseFromGone("kimi", 31)).toEqual([]); // kimi is still attached and idle
  peers.kimi!.set("offline");
  await tasks.releaseFromGone("kimi", 31);
  expect(board.get(t.id)!.owner).toBe("codex");
  expect(told).toContain(`kimi|note from hub [decision]: task #${t.id} moved to codex while you were offline; stop working on it`);
});

test("a release re-reads each task: one reassigned by the console meanwhile stays where it went", async () => {
  const ctx = await setup(["claude", "codex", "kimi"]);
  const slow = new Tasks({ board: ctx.board, bus: ctx.bus, routing: () => loadRouting(ctx.dir), cwd: ctx.dir, project: "agent-hub", notify: () => {}, briefs: { forTask: async () => (await new Promise((r) => setTimeout(r, 60)), undefined) } as any });
  const a = await slow.propose("kimi", { title: "first", class: "implement", owner: "kimi" });
  const b = await slow.propose("kimi", { title: "second", class: "implement", owner: "kimi" });
  ctx.peers.kimi!.set("offline");
  const run = slow.releaseFromGone("kimi", 31);
  await tick(); // the first task's brief lookup is in flight
  await slow.assignTo(b.id, "claude");
  await run;
  expect(ctx.board.get(a.id)!.owner).toBe("codex");
  expect(ctx.board.get(b.id)!.owner).toBe("claude");
});

test("tasks of the owner being released are no one to settle an overlap with", async () => {
  const { tasks, peers, told } = await setup(["claude", "codex", "kimi"]);
  await tasks.propose("kimi", { title: "one", class: "implement", owner: "kimi", refs: { paths: ["src/hub"] } });
  await tasks.propose("kimi", { title: "two", class: "implement", owner: "kimi", refs: { paths: ["src/hub/bus.ts"] } });
  peers.kimi!.set("offline");
  await tasks.releaseFromGone("kimi", 31);
  await tick();
  const offers = peers.codex!.got.filter((e) => e.kind === "task").map((e) => e.body);
  expect(offers).toHaveLength(2);
  expect(offers.some((b) => b.includes("owner kimi"))).toBe(false);
  expect(told.filter((l) => l.includes("overlaps"))).toEqual([]);
});

// issue #7: a configured check decides whether a done task goes to review or back to its owner.
async function checked(result: { code: number | null; timedOut: boolean; interrupted?: boolean; tail: string }) {
  const ctx = await setup(["claude", "codex", "kimi"]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ran: string[] = [];
  const tasks = new Tasks({
    board: ctx.board, bus: ctx.bus, routing: () => loadRouting(ctx.dir), cwd: ctx.dir, project: "agent-hub", notify: (l) => ctx.notices.push(l), memory: new MemoryClient(ctx.mem.url),
    check: (cls) => (cls === "implement" ? "make test" : undefined),
    runCheck: async (command) => (ran.push(command), await gate, result),
  });
  return { ...ctx, tasks, ran, release };
}

test("a passing check sends the task to review with the command and its tail", async () => {
  const { tasks, board, peers, ran, release, saves } = await checked({ code: 0, timedOut: false, tail: "12 pass" });
  const t = await tasks.propose("codex", { title: "fix", class: "implement", owner: "codex" });
  const pending = await tasks.done("codex", t.id, "fixed the parser");
  expect(pending.state).toBe("in_progress");
  expect(tasks.isChecking(t.id)).toBe(true);
  await expect(tasks.done("codex", t.id, "again")).rejects.toThrow(/check is still running/);
  release();
  await until(() => board.get(t.id)!.state === "in_review");
  expect(ran).toEqual(["make test"]);
  const review = peers.claude!.got.find((e) => e.kind === "review")!;
  expect(review.body).toContain("fixed the parser\nCheck: make test -> exit 0\n12 pass");
  expect(board.get(t.id)!.history.map((h) => h.event)).toEqual(expect.arrayContaining(["done (checking)", "check passed", "done"]));
  // The output reaches the reviewer only: shared memory gets the summary and the outcome, nothing nobody screened.
  await until(() => saves().some((s) => s.text.startsWith("Task #1 done by codex")));
  const saved = saves().find((s) => s.text.startsWith("Task #1 done by codex"))!.text;
  expect(saved).toContain("Check: make test -> exit 0");
  expect(saved).not.toContain("12 pass");
});

test("a failing check keeps the task with its owner, tells it what failed, and asks no reviewer", async () => {
  const { tasks, board, peers, notices, release } = await checked({ code: 2, timedOut: false, tail: "1 fail: parser" });
  const t = await tasks.propose("codex", { title: "fix", class: "implement", owner: "codex" });
  await tasks.done("codex", t.id, "fixed");
  release();
  await until(() => board.get(t.id)!.history.some((h) => h.event === "check failed"));
  expect(board.get(t.id)!.state).toBe("in_progress");
  expect(peers.claude!.got.some((e) => e.kind === "review")).toBe(false);
  expect(peers.codex!.got.at(-1)!.body).toBe("Task #1: its check failed.\n$ make test -> exit 2\n1 fail: parser\nFix it and call hub_task_done again.");
  expect(notices.at(-1)).toBe("task #1 fix: its check failed (make test -> exit 2); it stays with codex");
  expect(tasks.isChecking(t.id)).toBe(false);
});

test("a class without a check completes at once; a task that moved on during its check only records the result", async () => {
  const { tasks, board, release } = await checked({ code: 1, timedOut: true, tail: "" });
  const docs = await tasks.propose("codex", { title: "docs", class: "summarize", owner: "codex" });
  expect((await tasks.done("codex", docs.id, "written")).state).not.toBe("in_progress");
  const t = await tasks.propose("codex", { title: "fix", class: "implement", owner: "codex" });
  await tasks.done("codex", t.id, "fixed");
  await tasks.escalate(USER, t.id, "by hand");
  release();
  await until(() => board.get(t.id)!.history.some((h) => h.event === "check finished late"));
  expect(board.get(t.id)!.history.find((h) => h.event === "check finished late")!.note).toBe("make test -> timed out");
});

test("a task that left and came back does not take its old check's result; its owner is asked to mark it done again", async () => {
  const { tasks, board, peers, release } = await checked({ code: 0, timedOut: false, tail: "" });
  const t = await tasks.propose("codex", { title: "fix", class: "implement", owner: "codex" });
  await tasks.done("codex", t.id, "fixed");
  await tasks.escalate(USER, t.id, "by hand");
  const other = board.get(t.id)!.owner!;
  expect(other).not.toBe("codex");
  // Its check's result will not reach whoever took it meanwhile, so it is not promised one.
  await expect(tasks.done(other, t.id, "mine now")).rejects.toThrow(/a check from before it changed hands is still running; call hub_task_done again/);
  await tasks.assignTo(t.id, "codex");
  expect(board.get(t.id)).toMatchObject({ state: "in_progress", owner: "codex" });
  await expect(tasks.done("codex", t.id, "again")).rejects.toThrow(/its check is still running; its result comes as a task message/);
  release();
  await until(() => board.get(t.id)!.history.some((h) => h.event === "check finished late"));
  expect(board.get(t.id)!.state).toBe("in_progress");
  expect(peers.claude!.got.some((e) => e.kind === "review")).toBe(false);
  expect(peers.codex!.got.at(-1)!.body).toContain("finished after the task changed hands (make test -> exit 0). Call hub_task_done again");
});

test("the console user's done runs the check too; a hub stop interrupts it without a verdict", async () => {
  const passed = await checked({ code: 0, timedOut: false, tail: "" });
  const t = await passed.tasks.propose("codex", { title: "fix", class: "implement", owner: "codex" });
  await passed.tasks.done(USER, t.id, "closed by hand");
  passed.release();
  await until(() => passed.board.get(t.id)!.state === "in_review");

  const stopped = await checked({ code: null, timedOut: false, interrupted: true, tail: "" });
  const u = await stopped.tasks.propose("codex", { title: "fix", class: "implement", owner: "codex" });
  await stopped.tasks.done("codex", u.id, "fixed");
  const told = stopped.peers.codex!.got.length;
  stopped.release();
  await until(() => stopped.board.get(u.id)!.history.some((h) => h.event === "check interrupted"));
  expect(stopped.board.get(u.id)!.state).toBe("in_progress");
  expect(stopped.board.get(u.id)!.history.at(-1)!.note).toBe("make test -> interrupted by a hub stop");
  expect(stopped.peers.codex!.got).toHaveLength(told);
  expect(stopped.tasks.isChecking(u.id)).toBe(false);
});

// issue #31: a plan with the claim or the accept, and a notice to overlapping owners when the work is done.
const completedNotices = (p: FakePeer) => p.got.filter((e) => e.from === HUB && e.body.includes(" is done and touches your open #"));

test("a plan comes with a claim or an accept, normalized like refs, and replaces the old one", async () => {
  const { tasks, board } = await setup();
  const claim = await tasks.propose("kimi", {
    title: "cache", owner: "kimi",
    // what a model may send: a lone string, junk items, an unknown key
    plan: { paths: "src/cache.ts", symbols: ["Cache.set", 7, "  "], signatures: ["set(key: string, value: V): void"], extra: ["x"] } as any,
  });
  expect(board.get(claim.id)!.plan).toEqual({ paths: ["src/cache.ts"], symbols: ["Cache.set"], signatures: ["set(key: string, value: V): void"] });
  const offered = await tasks.propose("claude", { title: "docs", class: "implement", owner: "codex" });
  expect(board.get(offered.id)!.plan).toEqual({});
  tasks.accept("codex", offered.id, { paths: ["docs/cache.md"], insertion_points: ["after the Usage heading"] });
  expect(board.get(offered.id)!.plan).toEqual({ paths: ["docs/cache.md"], insertion_points: ["after the Usage heading"] });
  expect(JSON.parse(JSON.stringify(board.get(offered.id)))).toHaveProperty("plan.paths", ["docs/cache.md"]); // what ahub task show prints
});

test("an overlapping owner gets the plan as a ride-along line and no turn; a symbol overlaps across files", async () => {
  const { tasks, told, peers, notices } = await setup();
  await tasks.propose("kimi", { title: "bus refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/bus.ts"] }, plan: { symbols: ["Bus.publish"] } });
  const offered = await tasks.propose("claude", { title: "retry", class: "implement", owner: "codex" });
  await tick();
  expect(told).toEqual([]); // no paths yet: nothing overlaps
  const accepted = tasks.accept("codex", offered.id, { paths: ["src/hub/retry.ts"], symbols: ["Bus.publish"], signatures: ["publish(env: Envelope, retries?: number): void"] });
  expect(tasks.overlaps(accepted)).toBe("Overlaps #1 (owner kimi) on symbol Bus.publish. Settle it with that owner via hub_send before editing those paths.");
  expect(told).toEqual([
    "kimi|note from hub [finding]: task #2 (owner codex) now overlaps your #1 on symbol Bus.publish; codex is told to settle it. Its plan (full: hub_task_list): paths: src/hub/retry.ts | symbols: Bus.publish | signatures: publish(env: Envelope, retries?: number): void",
  ]);
  expect(notices).toContain("task #2 retry (codex): Overlaps #1 (owner kimi) on symbol Bus.publish. codex is told to settle it.");
  await tick();
  expect(peers.kimi!.got).toHaveLength(0);
  // A second plan on the same overlap tells the other owner again, but the console has already been warned.
  tasks.accept("codex", offered.id, { paths: ["src/hub/bus.ts"], symbols: ["Bus.publish"] });
  expect(told).toHaveLength(2);
  expect(notices.filter((l) => l.includes("Overlaps"))).toHaveLength(1);
});

test("a done task tells the owners of overlapping open tasks what changed, and nobody else", async () => {
  const { tasks, peers } = await setup();
  await tasks.propose("kimi", { title: "bus refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/"] } });
  await tasks.propose("local", { title: "docs", class: "implement", owner: "local", refs: { paths: ["docs/"] } });
  const t = await tasks.propose("codex", { title: "retry", class: "implement", owner: "codex", refs: { paths: ["src/hub/bus.ts"] }, plan: { signatures: ["publish(env: Envelope, retries?: number): void"] } });
  await tasks.done("codex", t.id, "retries a failed delivery twice\nmore detail that stays out");
  await tick();
  expect(completedNotices(peers.kimi!).map((e) => e.body)).toEqual([
    "Task #3 (owner codex) is done and touches your open #1 on src/hub/bus.ts. Check your work against it before you go on.\nChanged files: src/hub/bus.ts\nNew or changed signatures: publish(env: Envelope, retries?: number): void\nSummary: retries a failed delivery twice",
  ]);
  expect(completedNotices(peers.kimi!)[0]).toMatchObject({ to: ["kimi"], kind: "task", refs: { task: "1" } });
  for (const id of ["claude", "codex", "local"]) expect(completedNotices(peers[id]!)).toEqual([]);
});

test("the completed-change notice waits for the check, and a failed check sends none", async () => {
  const fail = await checked({ code: 1, timedOut: false, tail: "1 fail" });
  await fail.tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const t = await fail.tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  await fail.tasks.done("codex", t.id, "done");
  expect(completedNotices(fail.peers.kimi!)).toEqual([]);
  fail.release();
  await until(() => fail.board.get(t.id)!.history.some((h) => h.event === "check failed"));
  await tick();
  expect(completedNotices(fail.peers.kimi!)).toEqual([]);

  const pass = await checked({ code: 0, timedOut: false, tail: "ok" });
  await pass.tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const u = await pass.tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  await pass.tasks.done("codex", u.id, "done");
  await tick();
  expect(completedNotices(pass.peers.kimi!)).toEqual([]);
  pass.release();
  await until(() => completedNotices(pass.peers.kimi!).length === 1);
});

test("nothing of a PII task's plan or completion reaches another peer, and a plan cannot bring PII into an ordinary task", async () => {
  const { tasks, told, peers, board } = await setup();
  await tasks.propose("kimi", { title: "bus refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/"] } });
  // a PII pattern in the plan alone makes the task a PII task
  const viaPlan = await tasks.propose("claude", { title: "ordinary title", class: "implement", plan: { paths: ["src/hub/bus.ts"], signatures: [PII] } });
  expect(viaPlan).toMatchObject({ owner: "local", signals: ["pii"] });
  const pii = await tasks.propose("claude", { title: PII, class: "implement" });
  tasks.accept("local", pii.id, { paths: ["src/hub/bus.ts"], symbols: ["Bus.publish"] });
  expect(told).toEqual([]);
  expect(tasks.publicView(board.get(pii.id)!)).toMatchObject({ plan: {}, refs: {} });
  await tasks.done("local", pii.id, `fixed ${PII}`);
  await tick();
  expect(completedNotices(peers.kimi!)).toEqual([]);
  expect(JSON.stringify(peers.kimi!.got)).not.toContain("900101");
  // an ordinary task's signals are fixed at proposal: a plan that matches a PII pattern is refused, not stored
  const plain = await tasks.propose("claude", { title: "plain", class: "implement", owner: "codex" });
  expect(() => tasks.accept("codex", plain.id, { signatures: [PII] })).toThrow(/PII pattern/);
  expect(board.get(plain.id)!.plan).toEqual({});
});

// Review of #48: model-written text stays one line, an empty plan replaces nothing, and an old board gains the column.
test("a plan path with a newline cannot forge a log line, and the overlap counts still match", async () => {
  const { tasks, notices } = await setup();
  await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src"] } });
  await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", plan: { paths: ["src/x.ts\n2026-10-01T00:00:00.000Z task #9 forged (codex): Overlaps #1 (owner kimi) on y. codex is told to settle it."] } });
  // a title with a newline is one line as well
  await tasks.propose("claude", { title: "c\n2026-10-01T00:00:00.000Z task #8 forged (claude): Overlaps #1 (owner kimi) on z. claude is told to settle it.", class: "implement", owner: "claude", refs: { paths: ["src/b.ts"] } });
  expect(notices.every((l) => !l.includes("\n"))).toBe(true); // no notice spans two lines, the proposal notices included
  const overlap = notices.filter((l) => l.endsWith("is told to settle it."));
  expect(overlap).toHaveLength(2);
  expect(overlap[0]).not.toContain("\n");
  const { parse } = await import("../scripts/overlaps.ts");
  expect(parse(notices.map((l) => `2026-10-01T00:00:00.000Z ${l}`).join("\n"))).toHaveLength(2);
});

test("accepting with plan null or {} keeps the plan and tells nobody again", async () => {
  const { tasks, board, told } = await setup();
  await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const t = await tasks.propose("claude", { title: "b", class: "implement", owner: "codex", plan: { paths: ["src/a.ts"], signatures: ["f(): void"] } });
  const before = told.length;
  tasks.accept("codex", t.id, null);
  tasks.accept("codex", t.id, {});
  expect(board.get(t.id)!.plan).toEqual({ paths: ["src/a.ts"], signatures: ["f(): void"] });
  expect(told).toHaveLength(before);
});

test("a board from before plans gains the column with its tasks intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-migrate31-"));
  const file = join(dir, "hub.db");
  const old = new Database(file, { create: true });
  old.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', class TEXT NOT NULL,
    owner TEXT, reviewer TEXT, state TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT '[]',
    rejections INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  old.run(`INSERT INTO tasks (title, class, owner, state, created, updated) VALUES ('kept', 'implement', 'kimi', 'in_progress', 1, 1)`);
  old.close();
  const board = new Board(file);
  expect(board.get(1)).toMatchObject({ title: "kept", owner: "kimi", state: "in_progress", plan: {} });
  board.close();
});

// issue #34: dependencies and the ready queue.
test("a task that waits is offered to nobody and cannot be claimed or worked; approving the last dependency assigns it", async () => {
  const { tasks, board, peers, notices } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const b = await tasks.propose("claude", { title: "api", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id, b.id] });
  await tick();
  expect(board.get(c.id)).toMatchObject({ owner: null, state: "proposed", deps: [a.id, b.id] });
  expect(Object.values(peers).flatMap((p) => p.got).some((e) => e.refs?.task === String(c.id))).toBe(false);
  expect(notices).toContain(`task #${c.id} client waits for #${a.id}, #${b.id}; it is offered once they are approved`);
  // a claim of waiting work is refused with what blocks it, and creates nothing
  await expect(tasks.propose("kimi", { title: "client too", owner: "kimi", after: [a.id] })).rejects.toThrow(`would wait for #${a.id}, not approved yet: claim it once they are`);
  expect(board.list()).toHaveLength(3);
  // nobody works on it early, the console user included
  await expect(tasks.done(USER, c.id, "early")).rejects.toThrow(`waits for #${a.id}, #${b.id}`);
  await expect(tasks.assignTo(c.id, "kimi")).resolves.toMatchObject({ owner: null });
  expect(tasks.explain(c.id).at(-1)).toBe(`blocked: waits for #${a.id}, #${b.id} (not approved)`);

  // approve a: c still waits for b
  for (const t of [a]) {
    await tasks.done(board.get(t.id)!.owner!, t.id, "done");
    await tasks.review(board.get(t.id)!.reviewer!, t.id, "approved");
  }
  expect(board.get(c.id)!.owner).toBeNull();
  // approve b: c is ready and goes through assignment
  await tasks.done(board.get(b.id)!.owner!, b.id, "done");
  await tasks.review(board.get(b.id)!.reviewer!, b.id, "approved");
  await tick();
  const ready = board.get(c.id)!;
  expect(ready.owner).not.toBeNull();
  expect(ready.history.map((h) => h.event)).toEqual(expect.arrayContaining(["blocked", "ready", "assigned"]));
  expect(peers[ready.owner!]!.got.some((e) => e.kind === "task" && e.refs?.task === String(c.id))).toBe(true);
});

test("after names existing tasks only, so no cycle can form; ready lists proposed tasks with nothing left to wait for", async () => {
  const { tasks, board } = await setup();
  await expect(tasks.propose("claude", { title: "x", class: "implement", after: [99] })).rejects.toThrow("after: no task #99");
  await expect(tasks.propose("claude", { title: "x", class: "implement", after: ["two"] })).rejects.toThrow('after: "two" is not a task id');
  await expect(tasks.propose("claude", { title: "x", class: "implement", after: true })).rejects.toThrow("after: true is not a task id");
  const a = await tasks.propose("claude", { title: "a", class: "implement" });
  const b = await tasks.propose("claude", { title: "b", class: "implement", after: [a.id, a.id] });
  expect(board.get(b.id)!.deps).toEqual([a.id]);
  const ready = board.list("proposed").filter((t) => !tasks.waitsFor(t).length).map((t) => t.id);
  expect(ready).toEqual([a.id]);
  expect((await tasks.propose("claude", { title: "no deps", class: "implement", after: null })).deps).toEqual([]); // models send null for "none"
});

test("a dependency approved while a proposal waits for triage does not leave the new task blocked", async () => {
  const base = await setup();
  let answer!: (cls: "implement") => void;
  const tasks = new Tasks({
    board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: () => {},
    triage: { classify: () => new Promise((r) => (answer = r)), onCampus: async () => true },
  });
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const pending = tasks.propose("claude", { title: "client", after: [a.id] });
  await until(() => !!answer);
  await tasks.done(base.board.get(a.id)!.owner!, a.id, "done");
  await tasks.review(base.board.get(a.id)!.reviewer!, a.id, "approved");
  answer("implement");
  const c = await pending;
  expect(c.owner).not.toBeNull();
  expect(c.history.map((h) => h.event)).not.toContain("blocked");
});

test("dependents a stop cut off between an approval and their assignment are offered once the hub runs again", async () => {
  const { tasks, board, peers } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  await tasks.done(board.get(a.id)!.owner!, a.id, "done");
  board.update(a.id, board.get(a.id)!.reviewer!, "approved", { state: "approved" }); // saved, then the hub stopped
  expect(board.get(c.id)!.owner).toBeNull();
  await tasks.releaseReady();
  const ready = board.get(c.id)!;
  expect(ready.owner).not.toBeNull();
  expect(ready.history.map((h) => h.event).slice(-2)).toEqual(["ready", "assigned"]);
  expect(peers[ready.owner!]!.got.some((e) => e.kind === "task" && e.refs?.task === String(c.id))).toBe(true);
  // once per hub run: a ready task nobody could take is left to `ahub task assign`, not offered every minute
  board.update(c.id, HUB, "ready", { owner: null });
  await tasks.releaseReady();
  expect(board.get(c.id)!.owner).toBeNull();
});

test("a board from before plans and dependencies opens with its tasks intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-migrate-"));
  const file = join(dir, "hub.db");
  const old = new Database(file, { create: true });
  old.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', class TEXT NOT NULL,
    owner TEXT, reviewer TEXT, state TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT '[]',
    rejections INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  old.run(`INSERT INTO tasks (title, class, owner, state, refs, history, created, updated) VALUES ('kept', 'implement', 'kimi', 'in_progress', '{"paths":["a.ts"]}', '[]', 1, 1)`);
  old.close();
  const board = new Board(file);
  expect(board.get(1)).toMatchObject({ title: "kept", owner: "kimi", state: "in_progress", refs: { paths: ["a.ts"] }, plan: {}, deps: [] });
  board.close();
});

// Review of #48 (Copilot): a summary that matches a PII pattern stays out of the completed-change notice.
test("the completed-change notice leaves out a summary line and file names that match a PII pattern", async () => {
  const { tasks, peers } = await setup();
  await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/hub/bus.ts"] } });
  const t = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/hub/bus.ts"] } });
  await tasks.done("codex", t.id, `checked the record of ${PII}`, { paths: ["src/hub/bus.ts", "data/900101-1234567.json"] });
  await tick();
  const notice = completedNotices(peers.kimi!)[0]!.body;
  expect(notice.split("\n")).toContain("Changed files: src/hub/bus.ts"); // the PII-named file is left out
  expect(notice).not.toContain("900101");
  expect(notice).not.toContain("Summary:");
});

// Review of #48 (v5): a PII-matching path is named nowhere, the overlap line and the ride-along included.
test("an overlap on a path whose name matches a PII pattern does not name it", async () => {
  const { tasks, peers, told, notices } = await setup();
  await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["data/"] } });
  const t = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["data/900101-1234567.json"] } });
  await tasks.done("codex", t.id, "done", { paths: ["data/900101-1234567.json"] });
  await tick();
  const notice = completedNotices(peers.kimi!)[0]!.body;
  expect(notice).toContain("on a path whose name is withheld");
  expect(JSON.stringify([notice, told, notices])).not.toContain("900101");
  const { parse } = await import("../scripts/overlaps.ts");
  expect(parse(notices.map((l) => `2026-10-01T00:00:00.000Z ${l}`).join("\n"))).toHaveLength(1); // still counted
});
