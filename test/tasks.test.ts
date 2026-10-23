import { sdlcConfig } from "../src/hub/sdlc.ts";
import { supersededDeliveryReason } from "../src/hub/delivery-superseded.ts";
import { Database } from "bun:sqlite";
import { MemoryStore, migrate, taskKey } from "@staix/agent-mem";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus, type BusEvent } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { HUB, newEnvelope, USER, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { assign, currentRouting, detectSignals, loadRouting, SPLIT_MIN } from "../src/hub/routing.ts";
import { DEFAULT_TASK_SWEEP } from "../src/hub/task-sweep.ts";
import { AssignmentSupersededError, AssignmentUndeliveredError, ESCALATE_AFTER, Tasks } from "../src/hub/tasks.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { Briefs, parseRows } from "../src/memory/brief.ts";
import { FakeMemoryClient as MemoryClient } from "./fakes/mem-worker.ts";
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
const clockCleanup: (() => void)[] = [];
afterEach(() => {
  try { for (const fn of cleanup.splice(0)) fn(); }
  finally {
    // Clock overrides can nest when one test creates several rigs; unwind only those in ownership order.
    for (const restore of clockCleanup.splice(0).reverse()) restore();
  }
});
const tick = () => new Promise((r) => setTimeout(r, 15));
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const PII = "patient 900101-1234567 needs a follow-up";

// These fixtures pin the escalation mechanics at two consecutive changes_requested; the
// configurable default (three, tasks.escalate_after) has its own tests below (#488).
const PIN_TWO = () => 2;

async function setup(peerIds = ["claude", "codex", "kimi", "local"], observations?: Record<string, string[]>, capabilities?: Record<string, import("../src/hub/routing.ts").PeerCapabilities>, wipLimit?: number) {
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
  const tasks = new Tasks({ ...(wipLimit === undefined ? {} : { wipLimit: () => wipLimit! }), escalateAfter: PIN_TWO, board, bus, ...(capabilities ? { capabilities: () => capabilities, repository: "STAIxBWLB/agent-hub" } : {}), routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", memory, briefs: new Briefs(memory, "agent-hub"), notify: (l) => notices.push(l), share: (by, line) => shared.push(`${by}|${line}`), tell: (peer, line) => told.push(`${peer}|${line}`) });
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
  expect(pii).toMatchObject({ owner: "local", reviewer: "user", route: "hub/stage" });
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
  // #197: stay_switch reads it on every model call; a broken file is parsed and logged once per change, not per call.
  for (let i = 0; i < 3; i++) expect(currentRouting(dir, (l) => lines.push(l)).local.fixed_model).toBe("two");
  expect(lines).toHaveLength(1);
});

test("decline moves on; nobody left keeps it proposed with a notice; the console can assign", async () => {
  const { tasks, notices, board } = await setup(["codex", "kimi"]);
  await tasks.propose("user", { title: "bulk rename", class: "bulk_edit" }); // peers: local, kimi -> kimi
  expect(board.get(1)!.owner).toBe("kimi");
  const after = await tasks.decline("kimi", 1, "no capacity");
  expect(after).toMatchObject({ owner: null, state: "proposed" });
  expect(notices.at(-1)).toContain("ahub task assign 1");
  expect((await tasks.assignTo(1, "codex")).owner).toBe("codex");
  await expect(tasks.assignTo(1, "ghost")).rejects.toThrow(/cannot assign task #1 to ghost: not attached/); // #601: says why
  expect(board.get(1)!.owner).toBe("codex"); // a failed console assign leaves the task where it was
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
  const mixed = tasks.turnPolicy([ordinary, secret]);
  expect(mixed).toMatchObject({ pii: true, fixedModel: "fast" });
  expect(mixed?.route).toBeUndefined();
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
  expect(await tasks.remember("codex", { text: "x" })).toBe("memory store unavailable; nothing saved");
  tasks.accept("local", 1);
  expect((await tasks.done("local", 1, "done")).state).toBe("in_review");
});

test("budget pause: open work goes to local first through the constraints, reviews move on, PII gets no handoff text", async () => {
  const { tasks, peers, board, bus } = await setup(undefined, undefined, undefined, 2);
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
  const { tasks, peers, notices } = await setup(undefined, undefined, undefined, 3);
  await tasks.propose("kimi", { title: "hub refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/"] } });
  const codex = await tasks.propose("codex", { title: "retry backoff", class: "implement", owner: "codex", refs: { paths: ["./src/hub/bus.ts", "README.md"] } });
  expect(tasks.overlaps(codex)).toBe("Overlaps #1 (owner kimi) on src/hub/bus.ts. Settle it with that owner via hub_send before editing those paths."); // stored in one spelling (#67)
  expect(tasks.overlaps(codex, false)).toBe("Overlaps #1 (owner kimi) on src/hub/bus.ts. codex is told to settle it.");
  expect(notices).toContain("task #2 retry backoff (codex): Overlaps #1 (owner kimi) on src/hub/bus.ts. codex is told to settle it.");

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
  expect(tasks.overlaps(root)).toContain("#1 (owner kimi) on .;"); // `./` is stored as `.` (#67)
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
  const { tasks, told, peers } = await setup(undefined, undefined, undefined, 2);
  await tasks.propose("kimi", { title: "hub refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub"] } });
  await tasks.propose("codex", { title: "retry backoff", class: "implement", owner: "codex", refs: { paths: ["src/hub/bus.ts"] } });
  await tick();
  expect(told).toEqual(["kimi|note from hub [finding]: task #2 (owner codex) now overlaps your #1 on src/hub/bus.ts; codex is told to settle it"]);
  expect(peers.kimi!.got).toHaveLength(0); // no envelope, no turn
  await tasks.propose("codex", { title: "elsewhere", class: "implement", owner: "codex", refs: { paths: ["docs/x.md"] } });
  expect(told).toHaveLength(1);
});

test("an owner that is gone loses its open tasks to a peer that can take them, and keeps them when nobody can", async () => {
  const { tasks, board, peers, notices } = await setup(["claude", "codex", "kimi"], undefined, undefined, 2);
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
  const ctx = await setup(["claude", "codex", "kimi"], undefined, undefined, 2);
  const slow = new Tasks({ wipLimit: () => 2, board: ctx.board, bus: ctx.bus, routing: () => loadRouting(ctx.dir), cwd: ctx.dir, project: "agent-hub", notify: () => {}, briefs: { forTask: async () => (await new Promise((r) => setTimeout(r, 60)), undefined) } as any });
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
  const { tasks, peers, told } = await setup(["claude", "codex", "kimi"], undefined, undefined, 2);
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
async function checked(result: { code: number | null; timedOut: boolean; interrupted?: boolean; tail: string }, wipLimit?: number) {
  const ctx = await setup(["claude", "codex", "kimi"]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ran: string[] = [];
  const tasks = new Tasks({ ...(wipLimit === undefined ? {} : { wipLimit: () => wipLimit! }),
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
  const { tasks, board, release } = await checked({ code: 1, timedOut: true, tail: "" }, 2);
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
  const { tasks, told, peers, board } = await setup(undefined, undefined, undefined, 2);
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
  expect(board.get(1)).toMatchObject({ title: "kept", owner: "kimi", state: "in_progress", plan: {}, reserved: null });
  board.close();
});

// issue #34: dependencies and the ready queue.
test("a task that waits is offered to nobody and cannot be claimed or worked; approving the last dependency assigns it", async () => {
  const { tasks, board, peers, notices } = await setup(undefined, undefined, undefined, 2);
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const b = await tasks.propose("claude", { title: "api", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id, b.id] });
  await tick();
  expect(board.get(c.id)).toMatchObject({ owner: null, state: "proposed", deps: [a.id, b.id] });
  expect(Object.values(peers).flatMap((p) => p.got).some((e) => e.refs?.task === String(c.id))).toBe(false);
  expect(notices).toContain(`task #${c.id} client waits for #${a.id}, #${b.id}; it is offered once they are approved`);
  // a claim of waiting work is kept as a reservation (#207): that task waits too, offered to nobody
  const claim = await tasks.propose("kimi", { title: "client too", owner: "kimi", after: [a.id] });
  expect(board.get(claim.id)).toMatchObject({ owner: null, reserved: "kimi", state: "proposed" });
  // nobody works on it early, the console user included; an assign only reserves it (#207)
  await expect(tasks.done(USER, c.id, "early")).rejects.toThrow(`waits for #${a.id}, #${b.id}`);
  expect(tasks.explain(c.id).at(-1)).toBe(`blocked: waits for #${a.id}, #${b.id} (not approved)`);
  await expect(tasks.assignTo(c.id, "kimi")).resolves.toMatchObject({ owner: null, reserved: "kimi" });

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

test("the sweep offers a cut-off dependent only once an attached peer can take it", async () => {
  const { tasks, board, peers } = await setup(["claude", "codex"]); // implement goes to codex, not claude
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  await tasks.done(board.get(a.id)!.owner!, a.id, "done");
  board.update(a.id, board.get(a.id)!.reviewer!, "approved", { state: "approved" }); // saved, then the hub stopped
  peers.codex!.set("offline"); // after the restart only claude is back
  await tasks.releaseReady();
  expect(board.get(c.id)!.history.at(-1)!.event).toBe("blocked"); // not offered, so not used up
  peers.codex!.set("idle");
  await tasks.releaseReady();
  expect(board.get(c.id)!.owner).toBe("codex");
});

// issue #207: a reserved owner for work that waits.
const approve = async (tasks: Tasks, board: Board, id: number) => {
  await tasks.done(board.get(id)!.owner!, id, "done");
  await tasks.review(board.get(id)!.reviewer!, id, "approved");
  await tick();
};

test("a waiting task proposed with an owner is offered to that owner when it is ready, not to the first idle peer", async () => {
  const { tasks, board, peers, notices } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  expect(board.get(a.id)!.owner).toBe("local"); // the first idle peer in the class order
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  expect(board.get(c.id)).toMatchObject({ owner: null, reserved: "codex", state: "proposed" });
  expect(notices).toContain(`task #${c.id} client waits for #${a.id}; it is offered to codex first once they are approved`);
  expect(tasks.explain(c.id).slice(-2)).toEqual([`blocked: waits for #${a.id} (not approved)`, "reserved owner codex: offered first once it is ready"]);
  await approve(tasks, board, a.id);
  expect(board.get(c.id)).toMatchObject({ owner: "codex", state: "proposed" });
  expect(peers.codex!.got.some((e) => e.kind === "task" && e.refs?.task === String(c.id))).toBe(true);
  expect(peers.local!.got.some((e) => e.refs?.task === String(c.id))).toBe(false);
  const explained = tasks.explain(c.id);
  expect(explained[0]).toBe(`task #${c.id} client (proposed, owner codex, reserved for codex)`);
  expect(explained).toContain("reserved owner codex: honored");
});

test("a reserved owner that is offline or paused is passed over with a notice; a PII task still goes only to local or nobody", async () => {
  for (const how of ["offline", "paused"] as const) {
    const { tasks, board, bus, peers, notices } = await setup();
    const a = await tasks.propose("claude", { title: "schema", class: "implement" });
    const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
    if (how === "offline") peers.codex!.set("offline");
    else bus.pause("codex");
    expect(tasks.explain(c.id)).toContain(`reserved owner codex: offered first once it is ready`);
    await approve(tasks, board, a.id);
    expect(board.get(c.id)).toMatchObject({ owner: "local", reserved: "codex" });
    expect(notices).toContain(`task #${c.id} client: its reserved owner codex is passed over (${how}); routing proceeds`);
    expect(board.get(c.id)!.history.at(-1)).toMatchObject({ event: "assigned", note: `to local; reserved owner codex passed over: ${how}` });
    expect(tasks.explain(c.id)).toContain(`reserved owner codex: not honored, ${how}; routing proceeds`);
  }
  for (const [peerIds, owner] of [[["claude", "codex", "kimi", "local"], "local"], [["claude", "codex", "kimi"], null]] as const) {
    const { tasks, board, notices } = await setup([...peerIds]);
    const a = await tasks.propose("claude", { title: "schema", class: "implement" });
    const p = await tasks.propose("claude", { title: "follow-up", detail: PII, class: "implement", owner: "codex", after: [a.id] });
    await approve(tasks, board, a.id);
    expect(board.get(p.id)).toMatchObject({ owner, reserved: "codex", reviewer: owner ? "user" : null });
    expect(notices).toContain(`task #${p.id} [pii]: its reserved owner codex is passed over (pii: on-prem peers only); routing proceeds`);
  }
});

test("a decline keeps the owner it was declined for out of every later reroute, the console's decline included", async () => {
  const { tasks, board, notices } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  expect(board.get(c.id)!.owner).toBe("codex");
  const moved = await tasks.decline(USER, c.id, "not this one");
  expect(moved).toMatchObject({ owner: "local", reserved: "codex" });
  expect(moved.history.findLast((h) => h.event === "declined")).toMatchObject({ by: USER, from: "codex" });
  // explain and assignment agree, and the next reroute does not hand it back either
  expect(tasks.explain(c.id)).toContain("reserved owner codex: not honored, excluded (declined or replaced); routing proceeds");
  expect(await tasks.decline("local", c.id)).toMatchObject({ owner: "kimi", reserved: "codex" });
  // the decline said it: no "passed over" notice for the peer that refused, then or on the later reroute
  expect(notices.filter((l) => l.includes("passed over"))).toEqual([]);
});

test("only a refusal keeps an escalated-from owner out: the hub's move after a failed delivery does not", async () => {
  const { tasks, board } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  const moved = await tasks.escalate(HUB, c.id, "Undeliverable to codex: app-server restarting", "delivery_failed");
  expect(moved.owner).toBe("kimi");
  expect(moved.history.findLast((h) => h.event === "escalated")!.from).toBeUndefined();
  expect(await tasks.decline("kimi", c.id)).toMatchObject({ owner: "codex" }); // the reservation is honored again
});

test("an owner the task was escalated away from stays out of later reroutes", async () => {
  const { tasks, board } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  for (let round = 0; round < 2; round++) {
    await tasks.done("codex", c.id, "done");
    await tasks.review("claude", c.id, "changes_requested", "again");
  }
  const escalated = board.get(c.id)!;
  expect(escalated.owner).toBe("kimi"); // escalate_to codex, kimi, claude: codex is the one it leaves
  expect(escalated.history.findLast((h) => h.event === "escalated")).toMatchObject({ owner: "kimi", from: "codex" });
  expect(await tasks.decline("kimi", c.id)).toMatchObject({ owner: "local", reserved: "codex" });
  expect(tasks.explain(c.id)).toContain("reserved owner codex: not honored, excluded (declined or replaced); routing proceeds");
});

test("a person's explicit assign is not blocked by past declines; the conductor's and a proposer's are", async () => {
  const { tasks, board, notices } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  await tasks.decline(USER, c.id, "not now");
  expect(board.get(c.id)!.owner).toBe("local");
  await expect(tasks.assignTo(c.id, "codex", "claude", true)).rejects.toThrow(/cannot assign task #\d+ to codex: excluded/); // #601: refused before any write
  expect(board.get(c.id)!.owner).toBe("local");
  expect(await tasks.assignTo(c.id, "codex")).toMatchObject({ owner: "codex" });
});

test("#601 naming an owner that cannot take the task says why instead of a silent no-op", async () => {
  const { tasks, board, peers } = await setup();
  peers.codex!.set("offline");
  const t = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex" });
  expect(t.owner).toBeNull();
  expect(tasks.namedOwnerNote(t, "codex", "claude")).toMatch(/^codex was not assigned \(offline\): no-eligible-peer; assign it again/);
  const before = board.get(t.id)!.history.length;
  await expect(tasks.assignTo(t.id, "codex", "claude", true)).rejects.toThrow(/cannot assign task #\d+ to codex: offline; assign again once it is attached/);
  expect(board.get(t.id)!.history.length).toBe(before); // refused before any write
  peers.codex!.set("idle");
  expect(await tasks.assignTo(t.id, "codex", "claude", true)).toMatchObject({ owner: "codex" });
  expect(tasks.namedOwnerNote(board.get(t.id)!, "codex", "claude")).toBeUndefined();
});

test("#601 a failed self-claim says why too", async () => {
  const { tasks } = await setup();
  const t = await tasks.propose("codex", { title: PII, class: "implement", owner: "codex" });
  expect(t.owner).toBeNull(); // a self-claim names only itself: routing refuses the cloud peer and offers nobody else
  expect(tasks.namedOwnerNote(t, "codex", "codex")).toMatch(/^codex was not assigned \(pii\)/);
});

test("#601 a proposer's assign over a stale reservation of a peer that declined goes through", async () => {
  const { tasks, board } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  expect(board.get(c.id)).toMatchObject({ owner: "codex", reserved: "codex" });
  await tasks.decline("codex", c.id, "not now");
  expect(await tasks.assignTo(c.id, "kimi", "claude", true)).toMatchObject({ owner: "kimi" });
});

test("a person's assign of a ready task drops the agent's reservation; the conductor's keeps it", async () => {
  const { tasks, board } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  expect(await tasks.assignTo(c.id, "local", "claude")).toMatchObject({ owner: "local", reserved: "codex" });
  expect(await tasks.assignTo(c.id, "kimi")).toMatchObject({ owner: "kimi", reserved: null });
  expect(await tasks.decline("kimi", c.id)).toMatchObject({ owner: "local" }); // routing, not back to codex
});

test("an owner released as gone is passed over for that release only; a release's own note keeps a passed-over reservation", async () => {
  const { tasks, board, peers } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await approve(tasks, board, a.id);
  tasks.accept("codex", c.id);
  peers.codex!.set("offline");
  await tasks.releaseFromGone("codex", 30);
  expect(board.get(c.id)!.owner).toBe("local");
  expect(board.get(c.id)!.history.at(-1)!.note).toBe("owner codex offline for 30 min"); // its own owner's release is no news
  // being offline is no refusal: back online, a later reroute honors the reservation again
  peers.codex!.set("idle");
  expect(await tasks.decline("local", c.id)).toMatchObject({ owner: "codex" });
  // another owner's release while the reserved owner is away: the release's note keeps it
  tasks.accept("codex", c.id);
  await tasks.decline("codex", c.id); // to local; codex refused it now
  const other = await tasks.propose("claude", { title: "other", class: "implement", owner: "kimi", after: [c.id] });
  board.update(c.id, "local", "accepted", { state: "in_progress" });
  board.update(c.id, "local", "done", { state: "in_review" });
  board.update(c.id, "claude", "approved", { state: "approved" });
  peers.kimi!.set("offline");
  await tasks.releaseReady(); // kimi is away: other goes to local
  expect(board.get(other.id)!.owner).toBe("local");
  tasks.accept("local", other.id);
  peers.local!.set("offline");
  await tasks.releaseFromGone("local", 30);
  expect(board.get(other.id)!.history.at(-1)!.note).toBe("owner local offline for 30 min; reserved owner kimi passed over: offline");
});

test("the idle sweep's owner suggestion says when it passes over the reservation", async () => {
  const base = await setup();
  const notices: string[] = [];
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (l) => notices.push(l), sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, unaccepted_min: 1, ladder_min: 1 } });
  // Its own reservation, honored: the idle owner being skipped is no news.
  const mine = base.board.update(base.board.propose("claude", { title: "mine", class: "implement", reserved: "codex" }).id, HUB, "assigned", { owner: "codex", reviewer: "claude" });
  // Reserved for kimi, who is away: the suggestion passes it over and says so. (Another owner: one notice per peer a sweep.)
  const made = base.board.propose("claude", { title: "client", class: "implement", reserved: "kimi" });
  const task = base.board.update(made.id, HUB, "assigned", { owner: "local", reviewer: "claude" });
  base.peers.kimi!.set("offline");
  const at = task.history.at(-1)!.at + 60_000;
  for (let step = 0; step < 3; step++) await tasks.sweep(at + step * 60_000);
  expect(notices.filter((l) => l.includes("passed over"))).toEqual([`task #${task.id} client: its reserved owner kimi is passed over (offline); routing proceeds`]);
  expect(notices.filter((l) => l.includes("reassignment suggestion")).map((l) => l.split(": ").at(-1))).toEqual(["local.", "codex."]);
  expect([base.board.get(mine.id)!.owner, base.board.get(task.id)!.owner]).toEqual(["codex", "local"]); // suggestions only
});

test("assigning a waiting task reserves it for that peer, and the release sweep offers it to them", async () => {
  const { tasks, board, peers } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", owner: "codex", after: [a.id] });
  await expect(tasks.assignTo(c.id, "kimi", "claude")).resolves.toMatchObject({ owner: null, reserved: "kimi" });
  expect(board.get(c.id)!.history.at(-1)).toMatchObject({ by: "claude", event: "reserved", note: "for kimi", reason: "manual" });
  board.update(a.id, "local", "accepted", { state: "in_progress" });
  board.update(a.id, "local", "done", { state: "in_review" });
  board.update(a.id, "claude", "approved", { state: "approved" }); // saved, then the hub stopped
  await tasks.releaseReady();
  expect(board.get(c.id)!.owner).toBe("kimi");
  expect(peers.kimi!.got.some((e) => e.kind === "task" && e.refs?.task === String(c.id))).toBe(true);
});

test("an approval and the sweep releasing the same dependents at once offer each of them once", async () => {
  const { tasks, board, peers } = await setup();
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c1 = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  const c2 = await tasks.propose("claude", { title: "server", class: "implement", after: [a.id] });
  await tasks.done(board.get(a.id)!.owner!, a.id, "done");
  const approving = tasks.review(board.get(a.id)!.reviewer!, a.id, "approved"); // now awaiting c1's brief
  const sweeping = tasks.releaseReady(); // takes c2 before the approval's loop gets to it
  await Promise.all([approving, sweeping]);
  await tick();
  for (const id of [c1.id, c2.id]) {
    const events = board.get(id)!.history.map((h) => h.event);
    expect([events.filter((e) => e === "ready").length, events.filter((e) => e === "assigned").length]).toEqual([1, 1]);
    expect(Object.values(peers).flatMap((p) => p.got).filter((e) => e.kind === "task" && e.refs?.task === String(id))).toHaveLength(1);
  }
});

// issue #67: outcomes credited to the right work, whatever spelling the paths came in.
test("a contradiction matches a file in any spelling, never `.`; a reassignment to the same owner keeps a catch", async () => {
  const { tasks, board } = await setup(["claude", "codex", "kimi"], undefined, undefined, 3);
  const outcomes = (id: number) => board.reviews({ task: id }).map((r) => `${r.implementer}/${r.reviewer}:${r.kind}`);
  expect((await tasks.propose("claude", { title: "p", class: "implement", refs: { paths: ["./src//a.ts", "src/a.ts", "docs/"] } })).refs.paths).toEqual(["src/a.ts", "docs"]);
  const a = await tasks.propose("codex", { title: "a", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  await tasks.done("codex", a.id, "done");
  await tasks.review("claude", a.id, "approved");
  const root = await tasks.propose("kimi", { title: "root", class: "implement", owner: "kimi", refs: { paths: ["."] } });
  await tasks.done("kimi", root.id, "x");
  await tasks.review(board.get(root.id)!.reviewer!, root.id, "changes_requested", "no");
  expect(outcomes(a.id)).toEqual(["codex/claude:approved"]); // `.` blames nobody
  const wide = await tasks.propose("codex", { title: "wide", class: "implement", owner: "codex", refs: { paths: ["."] } });
  await tasks.done("codex", wide.id, "done");
  await tasks.review("claude", wide.id, "approved");
  const wider = await tasks.propose("kimi", { title: "wider", class: "implement", owner: "kimi", refs: { paths: ["./"] } });
  await tasks.done("kimi", wider.id, "x");
  await tasks.review(board.get(wider.id)!.reviewer!, wider.id, "changes_requested", "no");
  expect(outcomes(wide.id)).toEqual(["codex/claude:approved"]); // not even an approval on `.` itself
  board.update(a.id, HUB, "reopened", { refs: { paths: ["./src/a.ts"] } }); // a row stored as written, before #67
  const same = await tasks.propose("kimi", { title: "same", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  await tasks.done("kimi", same.id, "x");
  await tasks.review(board.get(same.id)!.reviewer!, same.id, "changes_requested", "no");
  expect(outcomes(a.id)).toEqual(["codex/claude:approved", "codex/claude:contradicted"]);
  // changes requested on codex's work, then the console hands it to codex again: the catch is still codex's
  const b = await tasks.propose("claude", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/b.ts"] } });
  const reviewer = board.get(b.id)!.reviewer!;
  await tasks.done("codex", b.id, "try");
  await tasks.review(reviewer, b.id, "changes_requested", "no");
  await tasks.assignTo(b.id, "codex");
  expect(board.get(b.id)!.history.at(-1)).toMatchObject({ event: "reassigned", owner: "codex" });
  await tasks.done("codex", b.id, "again");
  await tasks.review(reviewer, b.id, "approved");
  expect(outcomes(b.id)).toEqual([`codex/${reviewer}:approved`, `codex/${reviewer}:caught`]);
});

test("a board written before #67 reads back unchanged: paths as written, history without owners (the recovery digest)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "agenthub-board-0100-")), "hub.db");
  const db = new Database(file);
  db.run("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT, class TEXT NOT NULL, owner TEXT, reviewer TEXT, state TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', signals TEXT NOT NULL DEFAULT '[]', rejections INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL, plan TEXT NOT NULL DEFAULT '{}', deps TEXT NOT NULL DEFAULT '[]')");
  const history = [{ at: 1, by: "claude", event: "proposed" }, { at: 2, by: "hub", event: "assigned", note: "to codex" }, { at: 3, by: "user", event: "reassigned", note: "to codex" }];
  db.query("INSERT INTO tasks (title, class, owner, state, refs, history, created, updated) VALUES ('old', 'implement', 'codex', 'proposed', ?, ?, 1, 3)").run(JSON.stringify({ paths: ["./src/a.ts"] }), JSON.stringify(history));
  db.close();
  const board = new Board(file);
  const once = JSON.stringify(board.list());
  board.close();
  const again = new Board(file);
  expect(JSON.stringify(again.list())).toBe(once);
  expect(again.get(1)!.refs.paths).toEqual(["./src/a.ts"]);
  expect(again.get(1)!.history).toEqual(history);
  again.close();
});

// issue #69: model-written text that matches a PII pattern stays on this machine, also on an ordinary task.
test("a done summary, review note or unmet item matching a PII pattern reaches neither claude-mem nor a cloud peer", async () => {
  const { tasks, board, peers, saves, notices } = await setup(["claude", "codex", "local"], undefined, undefined, 2);
  const t = await tasks.propose("claude", { title: "follow-up list", class: "implement", owner: "codex" });
  expect(board.get(t.id)!.reviewer).toBe("claude");
  await tasks.done("codex", t.id, `exported the list; ${PII}`);
  await tick();
  const review = peers.claude!.got.find((e) => e.kind === "review")!.body;
  expect(review).toContain(`Done by codex: [summary withheld: it matches a PII pattern; ahub task show ${t.id}]`);
  expect(review).not.toContain("900101");
  expect(board.get(t.id)!.history.find((h) => h.event === "done")!.note).toContain("900101"); // the console still reads it
  await tasks.review("claude", t.id, "changes_requested", "fine otherwise", [PII]);
  await tick();
  const told = peers.codex!.got.at(-1)!.body;
  expect(told).toContain(`[review note withheld: it matches a PII pattern; ahub task show ${t.id}]`);
  expect(told).not.toContain("900101");
  await until(() => saves().length > 0 || notices.some((n) => n.includes("not saved to shared memory")));
  await tick();
  expect(saves().some((s: any) => JSON.stringify(s).includes("900101"))).toBe(false);
  expect(notices).toContain(`task #${t.id}: a finding note was not saved to shared memory (it matches a PII pattern)`);
  expect(notices.some((n) => n.includes("900101"))).toBe(false);
  // the local worker gets the stub too: it runs an ordinary task's turn like any other; a summary without a match is
  // unchanged for everyone
  board.update(t.id, HUB, "reviewer changed", { reviewer: "local" });
  await tasks.done("codex", t.id, `again; ${PII}`);
  await tick();
  expect(peers.local!.got.filter((e) => e.kind === "review").at(-1)!.body).toContain("[summary withheld");
  expect(peers.local!.got.filter((e) => e.kind === "review").at(-1)!.body).not.toContain("900101");
  const plain = await tasks.propose("claude", { title: "plain", class: "implement", owner: "codex" });
  await tasks.done("codex", plain.id, "added the flag");
  await tick();
  expect(peers.claude!.got.filter((e) => e.kind === "review").at(-1)!.body).toContain("Done by codex: added the flag");
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

// issue #36: demotion from recorded outcomes, and the urgent-only handoff.
test("repeated failures in a class demote a peer there; the effect decays and successes outweigh it", async () => {
  const { tasks, board } = await setup(["claude", "codex", "kimi"]);
  const now = Date.now();
  board.recordOutcome("codex", "implement", false, now - 60_000);
  board.recordOutcome("codex", "implement", false, now - 30_000);
  expect(Object.keys(tasks.demoted("implement", now))).toEqual(["codex"]);
  const t = await tasks.propose("claude", { title: "x", class: "implement" });
  expect(t.owner).toBe("kimi");
  expect(tasks.explain(t.id).join("\n")).toContain("demoted for implement: codex");
  expect(tasks.demoted("implement", now + 3 * 86_400_000)).toEqual({});
  expect(tasks.demoted("test", now)).toEqual({});
  for (let i = 0; i < 3; i++) board.recordOutcome("codex", "implement", true, now);
  expect(tasks.demoted("implement", now)).toEqual({});
  // failures have to outweigh successes: a tie is no demotion
  board.recordOutcome("kimi", "test", false, now);
  board.recordOutcome("kimi", "test", false, now);
  board.recordOutcome("kimi", "test", true, now);
  board.recordOutcome("kimi", "test", true, now);
  expect(tasks.demoted("test", now)).toEqual({});
  // nothing older than the week demotion reads is kept
  board.recordOutcome("kimi", "test", true, now + 8 * 86_400_000);
  expect(board.outcomes("test", 0)).toHaveLength(1);
});

test("verdicts are recorded as outcomes of the owner: changes requested and a failed check count against, approval for", async () => {
  const { tasks, board } = await setup(["claude", "codex"]);
  const t = await tasks.propose("claude", { title: "y", class: "implement", owner: "codex" });
  await tasks.done("codex", t.id, "done");
  await tasks.review("claude", t.id, "changes_requested", "fix it");
  await tasks.done("codex", t.id, "again");
  await tasks.review("claude", t.id, "approved");
  expect(board.outcomes("implement", 0).map((o) => `${o.peer}:${o.ok}`)).toEqual(["codex:0", "codex:1"]);
  // a class without a reviewer is approved when done, and that counts for the owner too
  const r = await tasks.propose("claude", { title: "z", class: "review", owner: "codex" });
  await tasks.done("codex", r.id, "reviewed");
  expect(board.get(r.id)!.state).toBe("approved");
  expect(board.outcomes("review", 0).map((o) => `${o.peer}:${o.ok}`)).toEqual(["codex:1"]);
});

test("waiting out a short reset moves only urgent work", async () => {
  const { tasks, board } = await setup();
  const normal = await tasks.propose("claude", { title: "normal", class: "implement", owner: "codex" });
  const hot = await tasks.propose("claude", { title: "hotfix", class: "implement", owner: "codex", urgent: true });
  expect(board.get(hot.id)!.signals).toContain("urgent");
  expect((await tasks.reassignForPause("codex", undefined, true)).map((m) => m.id)).toEqual([hot.id]);
  expect(board.get(normal.id)!.owner).toBe("codex");
  expect(board.get(hot.id)!.owner).not.toBe("codex");
});

// issue #35: the review checklist, unmet items, and recorded review outcomes.
test("the review envelope carries a checklist against the plan and the check result; unmet items reach the owner", async () => {
  const { tasks, board, peers, release } = await checked({ code: 0, timedOut: false, tail: "12 pass" }, 2);
  const t = await tasks.propose("codex", { title: "cache", class: "implement", owner: "codex", plan: { signatures: ["set(key: string): void"] } });
  await tasks.done("codex", t.id, "added set");
  release();
  await until(() => board.get(t.id)!.state === "in_review");
  const review = peers.claude!.got.find((e) => e.kind === "review")!.body;
  expect(review).toContain("Checklist:\n- Map the changed signatures and call sites to the plan (signatures: set(key: string): void), and name each one that does not match.\n- Check result: make test -> exit 0\n- List what is unmet in hub_review's unmet, one item each.");
  await tasks.review("claude", t.id, "changes_requested", "close", ["set() does not take a value", "no test for overwrite"]);
  expect(board.get(t.id)!.history.find((h) => h.event === "changes_requested")!.note).toBe("close\nUnmet: set() does not take a value; no test for overwrite");
  await tick();
  expect(peers.codex!.got.at(-1)!.body).toContain("Unmet: set() does not take a value; no test for overwrite");
  // without a plan the detail is the contract, so the request carries it
  const bare = await tasks.propose("codex", { title: "evict", detail: "evict the oldest key when full", class: "implement", owner: "codex" });
  await tasks.done("codex", bare.id, "added evict");
  release();
  await until(() => board.get(bare.id)!.state === "in_review");
  const second = peers.claude!.got.filter((e) => e.kind === "review").at(-1)!.body;
  expect(second).toContain("Task detail:\nevict the oldest key when full\nChecklist:\n- Map the changed signatures and call sites to the task detail above,");
});

test("review outcomes: approvals, caught changes, contradicted approvals (once) and escalations are recorded per task", async () => {
  const { tasks, board } = await setup(["claude", "codex", "kimi"]);
  const a = await tasks.propose("codex", { title: "a", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  await tasks.done("codex", a.id, "first");
  await tasks.review("claude", a.id, "changes_requested", "no");
  await tasks.done("codex", a.id, "second");
  await tasks.review("claude", a.id, "approved");
  expect(board.reviews({ task: a.id }).map((r) => `${r.implementer}/${r.reviewer}:${r.kind}`)).toEqual(["codex/claude:approved", "codex/claude:caught"]);
  // later work on the same file fails review twice: claude's approval of a is contradicted, once
  const b = await tasks.propose("kimi", { title: "b", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  await tasks.done("kimi", b.id, "x");
  await tasks.review(board.get(b.id)!.reviewer!, b.id, "changes_requested", "broken");
  await tasks.done("kimi", b.id, "y");
  await tasks.review(board.get(b.id)!.reviewer!, b.id, "changes_requested", "still broken");
  expect(board.reviews({ task: a.id }).filter((r) => r.kind === "contradicted")).toHaveLength(1);
  expect(board.reviews({ task: b.id }).some((r) => r.kind === "escalated")).toBe(true);
  expect(tasks.reviewRecord("implement").codex!.claude).toEqual({ score: 0, n: 1 }); // one task reviewed, and contradicted
  expect(tasks.explain({ title: "c", class: "implement" }).join("\n")).toContain("review record with");
});

test("review outcomes are credited to the work they judged: blame needs the same file, a catch belongs to the owner it caught", async () => {
  const { tasks, board } = await setup(["claude", "codex", "kimi"], undefined, undefined, 2);
  const outcomes = (id: number) => board.reviews({ task: id }).map((r) => `${r.implementer}/${r.reviewer}:${r.kind}`);
  // an approval of src/a.ts is not contradicted by a failure on `.`, only by one on the same file
  const a = await tasks.propose("codex", { title: "a", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  await tasks.done("codex", a.id, "done");
  await tasks.review("claude", a.id, "approved");
  const wide = await tasks.propose("kimi", { title: "wide", class: "implement", owner: "kimi", refs: { paths: ["."] } });
  await tasks.done("kimi", wide.id, "x");
  await tasks.review(board.get(wide.id)!.reviewer!, wide.id, "changes_requested", "no");
  expect(outcomes(a.id)).toEqual(["codex/claude:approved"]);
  // changes requested twice on kimi's work, escalated, redone by someone else and approved: the catch was of kimi's work
  const b = await tasks.propose("claude", { title: "b", class: "implement", owner: "kimi", refs: { paths: ["src/b.ts"] } });
  const reviewer = board.get(b.id)!.reviewer!;
  for (const n of [1, 2]) {
    await tasks.done("kimi", b.id, `try ${n}`);
    await tasks.review(reviewer, b.id, "changes_requested", "no");
  }
  const next = board.get(b.id)!;
  expect(next.owner).not.toBe("kimi");
  await tasks.done(next.owner!, b.id, "redone");
  await tasks.review(reviewer, b.id, "approved");
  expect(outcomes(b.id)).toEqual([`kimi/${reviewer}:escalated`, `${next.owner}/${reviewer}:approved`]);
  // the hub escalating work nobody reviewed (a Pi failure) says nothing about its reviewer
  const c = await tasks.propose("claude", { title: "c", class: "implement", owner: "codex", refs: { paths: ["src/c.ts"] } });
  await tasks.escalate(HUB, c.id, "pi inference failed");
  expect(outcomes(c.id)).toEqual([]);
});

// issue #69: a budget handoff is model-written too.
test("a handoff that matches a PII pattern reaches the next owner as a stub", async () => {
  const { tasks, peers, bus } = await setup(["claude", "codex", "local"]);
  const t = await tasks.propose("claude", { title: "implement parser", class: "implement", owner: "codex" });
  tasks.accept("codex", t.id);
  bus.pause("codex");
  const [moved] = await tasks.reassignForPause("codex", `${"x".repeat(2980)} ${PII}`);
  await tick();
  const handed = peers[moved!.to!]!.got.find((e) => e.refs?.task === String(t.id))!.body;
  expect(handed).toContain("[handoff withheld: it matches a PII pattern");
  expect(handed).not.toContain("900101");
});


// issue #92: reviewer candidates also come from the config roles, and a task with no possible reviewer says so.
test("reviewer roles from config join the candidates; with nobody left, the notice and the facts say done approves directly", async () => {
  const base = await setup(["claude", "codex", "kimi", "local"]);
  const tasks = new Tasks({
    board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub",
    notify: (l) => base.notices.push(l), roles: { kimi: ["implementer", "reviewer"] },
  });
  base.peers.claude!.set("busy");
  const t = await tasks.propose("claude", { title: "add a flag", class: "implement", owner: "codex" });
  // claude (busy) and codex (the owner) are out: kimi reviews, from its role, not the review class
  expect(t.reviewer).toBe("kimi");
  expect(tasks.resultLine(t)).toBe(`task #${t.id}: proposed, owner codex, reviewer kimi`); // a reviewer: nothing added

  const none = await setup(["local", "kimi"]);
  const n = await none.tasks.propose("kimi", { title: "plain change", class: "implement" });
  expect(n).toMatchObject({ owner: "local", reviewer: null });
  const why = "no reviewer: done will approve directly (skipped: claude (not attached); codex (not attached))";
  expect(none.notices).toContain(`task #${n.id} plain change: ${why}`);
  expect(none.tasks.resultLine(n)).toBe(`task #${n.id}: proposed, owner local, reviewer none; ${why}`);
  await tick();
  expect(none.peers.local!.got.find((e) => e.refs?.task === String(n.id))!.body).toContain(`Facts: class implement; ${why}`);
});

// issues #89/#90: Tasks feeds failing and held into routing; the assign notices name the hold.
test("failing peers are skipped by assignment, and a held owner queue is named in the notice and the explanation", async () => {
  const base = await setup(["local", "codex", "claude"]);
  const tasks = new Tasks({
    board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub",
    notify: (l) => base.notices.push(l),
    failing: () => ({ local: "3 undeliverable deliveries" }),
    held: () => ({ codex: "needs_review delivery d7" }),
  });
  const t = await tasks.propose("claude", { title: "held work", class: "implement" });
  expect(t.owner).toBe("codex"); // local is failing, so it is skipped
  expect(base.notices).toContain(`task #${t.id} held work: codex's queue is held (needs_review delivery d7); the task arrives once the hold is resolved`);
  expect(tasks.resultLine(t)).toBe(`task #${t.id}: proposed, owner codex, reviewer claude; codex's queue is held (needs_review delivery d7); it receives the task once the hold is resolved`);
  const explained = tasks.explain(t.id).join("\n");
  expect(explained).toContain("owner candidate local: skipped, failing: 3 undeliverable deliveries");
  expect(explained).toContain("hold: codex's queue is held: needs_review delivery d7");
});

// issue #106: the completed-change notice is about the recipient's open task; it is dropped at delivery once that is closed.
async function staleRig(wipLimit?: number) {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-tasks-"));
  let relevant: (peer: string, env: Envelope) => boolean = () => true;
  const events: BusEvent[] = [];
  const bus = new Bus({ batchMs: 0, relevant: (peer, env) => relevant(peer, env) }); // the daemon binds it the same way
  bus.tap((e) => events.push(e));
  const peers = Object.fromEntries(["claude", "codex", "kimi"].map((id) => [id, new FakePeer(id)]));
  for (const p of Object.values(peers)) {
    bus.add(p);
    await p.start();
  }
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ ...(wipLimit === undefined ? {} : { wipLimit: () => wipLimit! }), board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {} });
  relevant = tasks.relevant;
  return { bus, peers, board, tasks, events, dir, rebind: (t: Tasks) => (relevant = t.relevant) };
}

test("a completed-change notice queued for a busy owner is dropped once that owner's task is done", async () => {
  const { peers, tasks, events } = await staleRig();
  const kimis = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const codexs = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  peers.kimi!.set("busy");
  await tasks.done("codex", codexs.id, "changed a"); // the notice waits in kimi's queue
  await tasks.done("kimi", kimis.id, "kimi's part"); // kimi finishes before it goes idle
  peers.kimi!.set("idle");
  await tick();
  expect(completedNotices(peers.kimi!)).toEqual([]);
  expect(events.filter((e) => e.t === "stale").map((e) => (e as { reason: string }).reason)).toEqual([`stale: task #${kimis.id} is no longer open for kimi`]);
});

test("the same notice is delivered while the owner's task is still open, and other task messages are never dropped", async () => {
  const { peers, tasks, board, events } = await staleRig();
  const kimis = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const codexs = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  peers.kimi!.set("busy");
  await tasks.done("codex", codexs.id, "changed a");
  peers.kimi!.set("idle");
  await tick();
  expect(completedNotices(peers.kimi!)).toHaveLength(1);
  // A message about a closed task that is not conditional (an approval) still reaches its owner after the task closed.
  peers.kimi!.set("busy");
  expect(board.get(kimis.id)!.reviewer).toBe("claude"); // the default routing in this rig
  await tasks.done("kimi", kimis.id, "done");
  await tasks.review("claude", kimis.id, "approved", "fine");
  expect(board.get(kimis.id)!.state).toBe("approved");
  peers.kimi!.set("idle");
  await tick();
  expect(peers.kimi!.got.some((e) => e.body.startsWith(`Task #${kimis.id} approved by claude`))).toBe(true);
  expect(events.some((e) => e.t === "stale")).toBe(false);
});

test("a notice to an owner who lost the task is dropped; check results, reviews and assignments about closed tasks are not", async () => {
  const { peers, tasks, board, bus, events } = await staleRig();
  const kimis = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const codexs = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  peers.kimi!.set("busy");
  await tasks.done("codex", codexs.id, "changed a"); // a completed-change notice for kimi's #a waits
  await tasks.assignTo(kimis.id, "claude"); // #a changes hands: the notice is about work kimi no longer owns
  peers.kimi!.set("idle");
  await tick();
  expect(completedNotices(peers.kimi!)).toEqual([]);
  expect(events.filter((e) => e.t === "stale").map((e) => (e as { peer: string }).peer)).toEqual(["kimi"]);
  // Workflow messages carry no condition, whatever their task's state by the time they arrive.
  peers.codex!.set("busy");
  expect(board.get(codexs.id)!.state).toBe("in_review"); // codex's own task is closed
  for (const [kind, body] of [["task", `Task #${codexs.id}: its check failed.`], ["review", `Review task #${codexs.id}`], ["task", `Task #${codexs.id} [implement] b`]] as const) {
    bus.publish(newEnvelope(HUB, body, { to: ["codex"], kind, refs: { task: String(codexs.id) } }));
  }
  peers.codex!.set("idle");
  await tick();
  expect(peers.codex!.got.map((e) => e.body.split("\n")[0])).toEqual([`Task #${codexs.id}: its check failed.`, `Review task #${codexs.id}`, `Task #${codexs.id} [implement] b`]);
});

test("after a restart, or once its record is evicted, a notice is delivered as before: its kind alone never makes it stale", async () => {
  const { peers, tasks, board, bus, dir, rebind } = await staleRig(2);
  const kimis = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const codexs = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  peers.kimi!.set("busy");
  await tasks.done("codex", codexs.id, "changed a");
  await tasks.done("kimi", kimis.id, "kimi's part");
  // A new hub run: the queue came back from the journal, the records did not.
  const restarted = new Tasks({ wipLimit: () => 2, board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {} });
  rebind(restarted);
  // An unrecorded notice about a closed task, kind task and all, is not guessed to be stale either.
  bus.publish(newEnvelope(HUB, `Task #${codexs.id} (owner codex) is done and touches your open #${kimis.id}`, { to: ["kimi"], kind: "task", refs: { task: String(kimis.id) } }));
  peers.kimi!.set("idle");
  await tick();
  expect(completedNotices(peers.kimi!)).toHaveLength(2);
  // Eviction: the newest 1024 records are kept; an evicted one is delivered like an unrecorded one.
  const first = await restarted.propose("claude", { title: "c", class: "implement", owner: "claude", refs: { paths: ["src/c.ts"] } });
  const second = await restarted.propose("claude", { title: "d", class: "implement", owner: "claude", refs: { paths: ["src/d.ts"] } });
  peers.claude!.set("busy");
  restarted.whileOpen("claude", first.id, "the oldest notice");
  for (let i = 0; i < 1024; i++) restarted.whileOpen("kimi", kimis.id, `filler ${i}`);
  restarted.whileOpen("claude", second.id, "the newest notice");
  for (const id of [first.id, second.id]) board.update(id, "claude", "done", { state: "approved" });
  peers.claude!.set("idle");
  await tick();
  const got = peers.claude!.got.map((e) => e.body);
  expect(got).toContain("the oldest notice");
  expect(got).not.toContain("the newest notice");
});

// issue #107: turn-free cohorts. Owners of overlapping tasks whose context paths are verified form a silent cohort; the
// member whose done completes the set integrates, and its next done counts only for the same target.
async function turnFreeRig(extra: Partial<ConstructorParameters<typeof Tasks>[0]> = {}, peerIds = ["claude", "codex", "kimi"]) {
  const ctx = await setup(peerIds);
  const told: string[] = [];
  // Every peer starts inside a native turn: its done is a tool call of that turn.
  const state = { capable: new Set(["claude", "codex", "kimi"]), working: new Set(peerIds), tree: "t1", offers: 0, acked: [] as string[], current: true };
  const tasks = new Tasks({ escalateAfter: PIN_TWO,
    board: ctx.board, bus: ctx.bus, routing: () => loadRouting(ctx.dir), cwd: ctx.dir, project: "agent-hub", notify: (l) => ctx.notices.push(l), tell: (peer, line) => told.push(`${peer}|${line}`), turnFree: () => true,
    capable: (p) => state.capable.has(p),
    idle: (p) => !state.working.has(p),
    treeHash: () => state.tree,
    integrationFacts: (p) => ({ id: `f${++state.offers}`, text: `facts for ${p}` }),
    ackFacts: (p, id) => void state.acked.push(`${p}:${id}`),
    factsCurrent: () => state.current,
    ...extra,
  });
  /** `peer`'s native turn ends, as the daemon reports it; `work` starts its next one (a tool call, a delivery). */
  const stop = (peer: string) => {
    state.working.delete(peer);
    tasks.cohorts.turnEnded(peer);
  };
  const work = (peer: string) => state.working.add(peer);
  // A clock the test moves: a done within two seconds of an integration request is a retry, not a check.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  clockCleanup.push(() => { Date.now = realNow; });
  const later = (ms = 3000) => (offset += ms);
  return { ...ctx, tasks, told, state, stop, work, later };
}
const pair = async (tasks: Tasks, a = "kimi", b = "codex") => {
  const first = await tasks.propose(a, { title: "multi-file edit", class: "implement", owner: a, refs: { paths: ["src/click/termui.py"] }, plan: { signatures: ["edit(filename: str | Iterable[str])"] } });
  const second = await tasks.propose(b, { title: "priority", class: "implement", owner: b, refs: { paths: ["src/click/termui.py"] } });
  return { first, second };
};

test("owners of overlapping tasks whose context paths are verified form one silent cohort; its texts carry plans, never a request to settle", async () => {
  const { tasks, told, notices } = await turnFreeRig();
  await tasks.propose("kimi", { title: "bus refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/bus.ts"] }, plan: { symbols: ["Bus.publish"], signatures: ["publish(env: Envelope): PeerId[]"] } });
  const offered = await tasks.propose("claude", { title: "retry", class: "implement", owner: "codex" });
  const accepted = tasks.accept("codex", offered.id, { paths: ["src/hub/retry.ts"], symbols: ["Bus.publish"] });
  expect(tasks.silentFor(accepted.id)).toBe(true);
  const forOwner = tasks.overlaps(accepted);
  expect(forOwner).toBe("Overlaps #1 (owner kimi) on symbol Bus.publish. Do not message that owner: you are in one turn-free cohort, the hub shows you their changes as you work and asks the last of you to finish to check the work against the others. #1's plan: symbols: Bus.publish | signatures: publish(env: Envelope): PeerId[]");
  expect(told).toEqual(["kimi|note from hub [finding]: task #2 (owner codex) now overlaps your #1 on symbol Bus.publish; do not message codex: you are in one turn-free cohort and the hub shows you its changes as you work. Its plan (full: hub_task_list): paths: src/hub/retry.ts | symbols: Bus.publish"]);
  expect(notices).toContain("task #2 retry (codex): Overlaps #1 (owner kimi) on symbol Bus.publish. codex works alongside without messages (turn-free).");
  for (const text of [forOwner, ...told, ...notices]) expect(text).not.toContain("via hub_send");
});

test("advisory fallback: an owner without a verified context path, a PII task, or turn-free off keeps messages, texts and notices as before", async () => {
  // kimi cannot be shown facts: the cohort is formed, but not silent.
  const unverified = await turnFreeRig();
  unverified.state.capable.delete("kimi");
  const { first, second } = await pair(unverified.tasks);
  expect(unverified.tasks.silentFor(second.id)).toBe(false);
  expect(unverified.tasks.overlaps(unverified.board.get(second.id)!)).toContain("Settle it with that owner via hub_send");
  expect(unverified.tasks.silenced("codex", "kimi")).toBeUndefined();
  unverified.peers.kimi!.set("busy");
  await unverified.tasks.done("codex", second.id, "changed termui");
  unverified.peers.kimi!.set("idle");
  await tick();
  expect(completedNotices(unverified.peers.kimi!)).toHaveLength(1); // the completed-change notice still goes
  expect((await unverified.tasks.done("kimi", first.id, "kimi done")).history.at(-1)!.event).toBe("done"); // no integration step
  // Turn-free off (configured advisory, or a PII task open): nothing is silent.
  const off = await turnFreeRig({ turnFree: () => false });
  const both = await pair(off.tasks);
  expect(off.tasks.silentFor(both.second.id)).toBe(false);
  expect(off.tasks.silenced("codex", "kimi")).toBeUndefined();
});

test("an owner without facts joining a silent cohort lifts its silence, and every member hears so", async () => {
  const { tasks, state, peers } = await turnFreeRig();
  const { second } = await pair(tasks);
  expect(tasks.silentFor(second.id)).toBe(true);
  state.capable.delete("claude");
  await tasks.propose("claude", { title: "docs", class: "implement", owner: "claude", refs: { paths: ["src/click/termui.py"] } });
  expect(tasks.silentFor(second.id)).toBe(false);
  await tick();
  for (const p of ["kimi", "codex"]) expect(peers[p]!.got.some((e) => e.body.includes("turn-free silence is lifted"))).toBe(true);
});

test("a member's messages are held back until it has stopped after its task closed; a settled member's new work is unaffected", async () => {
  const { tasks, stop, work, later } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  expect(tasks.silenced("kimi", "codex")?.members.size).toBe(2);
  expect(tasks.silenced("codex", "kimi")).toBeDefined();
  expect(tasks.silenced("kimi", "claude")).toBeUndefined(); // not a member
  await tasks.done("kimi", first.id, "kimi done"); // closed on the board, its turn still running
  expect(tasks.silenced("kimi", "codex")).toBeDefined(); // a late final answer is still the cohort's
  stop("kimi"); // its native turn ended: kimi has settled
  work("kimi"); // and started a new turn: the tool call of its next hub_send, say
  expect(tasks.silenced("kimi", "codex")).toBeUndefined(); // that turn is new work: a settlement is never undone
  expect(tasks.silenced("codex", "kimi")).toBeDefined(); // codex is still at work in the cohort
  await tasks.done("codex", second.id, "b"); // integration request
  later();
  expect((await tasks.done("codex", second.id, "b")).history.at(-1)!.event).toBe("done");
  stop("codex");
  work("codex");
  // Both settled: the cohort is over, and nothing between them is held back any more, in either direction.
  expect(tasks.cohorts.list()).toEqual([]);
  expect(tasks.silenced("codex", "kimi")).toBeUndefined();
  expect(tasks.silenced("kimi", "codex")).toBeUndefined();
});

test("the member whose done completes the set integrates: one request with its facts, then its done for the same target", async () => {
  const { tasks, board, state, stop, later } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  const early = await tasks.done("kimi", first.id, "edit takes several files\nmore");
  expect(early.history.at(-1)!.event).toBe("done"); // an earlier member is never held
  stop("kimi");
  const asked = await tasks.done("codex", second.id, "added process_priority");
  expect(asked.state).toBe("in_progress");
  expect(asked.history.at(-1)).toMatchObject({ event: "integration requested", by: HUB });
  expect(asked.history.at(-1)!.note).toBe([
    `Before task #${second.id} is recorded as done: you are the last of turn-free cohort #1 to finish. Check your work against the others' below, fix what conflicts, then call hub_task_done again.`,
    "The done counts once the files did not change between two calls and the others have stopped.",
    `- #${first.id} multi-file edit (owner kimi, in_review)`,
    "  changed files: src/click/termui.py",
    "  signatures: edit(filename: str | Iterable[str])",
    "  summary: edit takes several files",
    "facts for codex",
  ].join("\n"));
  // A done right after the request is a retry of a lost answer: the same request again, nothing acknowledged.
  expect((await tasks.done("codex", second.id, "retry")).history.filter((h) => h.event === "integration requested")).toHaveLength(1);
  expect(state.acked).toEqual([]);
  later();
  const recorded = await tasks.done("codex", second.id, "added process_priority, checked against #1");
  expect(recorded.history.slice(-2).map((h) => h.event)).toEqual(["integrated", "done"]);
  expect(state.acked).toEqual(["codex:f1"]); // the second done is the proof the request arrived
  expect(board.get(second.id)!.history.filter((h) => h.event === "integration requested")).toHaveLength(1);
});

test("an integrating cohort member's done keeps the staged lifecycle link through the integration write (#694)", async () => {
  const head = "a".repeat(40);
  const gh = async (args: string[]) => args[0] === "pr" && args[1] === "list" ? { code: 0, stdout: JSON.stringify([{ number: 692, headRefOid: head, headRefName: "feat/691" }]) } : { code: 1, stdout: "" };
  const { tasks, board, stop, later } = await turnFreeRig({ repository: "STAIxBWLB/agent-hub", sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh } });
  const first = await tasks.propose("kimi", { title: "multi-file edit", class: "implement", owner: "kimi", refs: { paths: ["src/click/termui.py"] } });
  const second = await tasks.propose("codex", { title: "Fix #691: priority", class: "implement", owner: "codex", refs: { paths: ["src/click/termui.py"] } });
  await tasks.done("kimi", first.id, "edit");
  stop("kimi");
  expect((await tasks.done("codex", second.id, "first try", { commit: head })).history.at(-1)!.event).toBe("integration requested");
  later();
  const recorded = await tasks.done("codex", second.id, "checked against #1", { commit: head });
  expect(recorded.history.slice(-2).map((h) => h.event)).toEqual(["integrated", "done"]);
  expect(board.get(second.id)!.sdlc).toMatchObject({ repo: "STAIxBWLB/agent-hub", issue: 691, pr: 692 });
});

test("the next done acknowledges the facts sent with the request before the target is judged", async () => {
  // Facts are current only once the latest offer is acknowledged, as with an integration offer that has no readback.
  const { tasks, state, stop, later } = await turnFreeRig({ factsCurrent: () => state.acked.at(-1) === `codex:f${state.offers}` });
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  stop("kimi");
  expect((await tasks.done("codex", second.id, "b")).history.at(-1)!.event).toBe("integration requested");
  later();
  const recorded = await tasks.done("codex", second.id, "b, checked");
  expect(recorded.history.slice(-2).map((h) => h.event)).toEqual(["integrated", "done"]);
  expect(state.acked).toEqual(["codex:f1"]);
});

test("two dones in one tick select exactly one integrating member", async () => {
  const { tasks, board } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  const [a, b] = await Promise.all([tasks.done("kimi", first.id, "a"), tasks.done("codex", second.id, "b")]);
  const asked = [a, b].filter((t) => t.history.at(-1)!.event === "integration requested");
  expect(asked.map((t) => t.id)).toEqual([second.id]);
  expect(board.get(first.id)!.history.at(-1)!.event).toBe("done");
});

test("edits between calls, owner replacement and a changed cohort move the target; a member still running blocks it", async () => {
  const { tasks, state, stop, later } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  await tasks.done("codex", second.id, "b"); // request 1
  // The member that integrates is not confirmed while kimi has not stopped since its done.
  later();
  let again = await tasks.done("codex", second.id, "b");
  expect(again.history.at(-1)!.note).toContain("integration request 2 of 3): kimi has not stopped since its done");
  stop("kimi");
  // Its own edits between two calls move the target: asked once more.
  state.tree = "t2";
  later();
  again = await tasks.done("codex", second.id, "b");
  expect(again.history.at(-1)!.note).toContain("integration request 3 of 3): the files changed since the last request");
  later();
  again = await tasks.done("codex", second.id, "b");
  expect(again.history.slice(-2).map((h) => h.event)).toEqual(["integrated", "done"]);
  // A new member joining before the confirm makes the integrating member an earlier finisher: it proceeds.
  const other = await turnFreeRig();
  const p2 = await pair(other.tasks);
  await other.tasks.done("kimi", p2.first.id, "a");
  await other.tasks.done("codex", p2.second.id, "b"); // request 1
  const third = await other.tasks.propose("claude", { title: "late", class: "implement", owner: "claude", refs: { paths: ["src/click/termui.py"] } });
  expect(other.tasks.cohorts.of(third.id)?.members.size).toBe(3);
  expect((await other.tasks.done("codex", p2.second.id, "b")).history.at(-1)!.event).toBe("done");
  other.stop("kimi");
  other.stop("codex");
  expect((await other.tasks.done("claude", third.id, "c")).history.at(-1)!.event).toBe("integration requested");
  // Owner replacement: the task changes hands, and the new owner's done is a new request.
  const moved = await turnFreeRig();
  const p3 = await pair(moved.tasks);
  await moved.tasks.done("kimi", p3.first.id, "a");
  await moved.tasks.done("codex", p3.second.id, "b"); // request 1, to codex
  await moved.tasks.assignTo(p3.second.id, "claude");
  const fresh = await moved.tasks.done("claude", p3.second.id, "b by claude");
  expect(fresh.history.at(-1)!.note).toContain("you are the last of turn-free cohort");
});

test("the integrating owner's own other task in the cohort never counts as a member still at work", async () => {
  const { tasks, stop, later } = await turnFreeRig({ wipLimit: () => 2 });
  const a = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/x.ts"] } });
  const b = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/x.ts"] } });
  const c = await tasks.propose("kimi", { title: "c", class: "implement", owner: "kimi", refs: { paths: ["src/x.ts"] } });
  expect(tasks.cohorts.of(c.id)?.members.size).toBe(3);
  await tasks.done("codex", b.id, "b");
  stop("codex");
  await tasks.done("kimi", a.id, "a"); // one turn: both of kimi's tasks
  expect((await tasks.done("kimi", c.id, "c")).history.at(-1)!.event).toBe("integration requested");
  later();
  expect((await tasks.done("kimi", c.id, "c, checked")).history.slice(-2).map((h) => h.event)).toEqual(["integrated", "done"]);
});

test("a done right after a request repeated after a confirmation is a retry; only a later one confirms", async () => {
  const results: Promise<number>[] = [];
  let release!: (code: number) => void;
  const { tasks, board, state, stop, later } = await turnFreeRig({
    check: (cls) => (cls === "implement" ? "make test" : undefined),
    runCheck: async () => ({ code: await (results.shift() ?? Promise.resolve(0)), timedOut: false, interrupted: false, tail: "" }),
  });
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  await until(() => board.get(first.id)!.state === "in_review");
  stop("kimi");
  await tasks.done("codex", second.id, "b"); // request 1
  later();
  results.push(new Promise<number>((r) => (release = r)));
  await tasks.done("codex", second.id, "b"); // confirmed; its check runs
  state.tree = "t2"; // the files change while it runs
  release(0);
  await until(() => board.get(second.id)!.history.some((h) => h.event === "check finished late"));
  later();
  expect((await tasks.done("codex", second.id, "b")).history.at(-1)!.note).toContain("integration request 2 of 3"); // asked again
  const retry = await tasks.done("codex", second.id, "b"); // right away: a retry, never a confirmation
  expect(retry.history.filter((h) => h.event === "integrated")).toHaveLength(1);
  expect(retry.history.at(-1)!.event).toBe("integration requested");
  later();
  const confirmed = await tasks.done("codex", second.id, "b, checked again"); // a later one, the files unchanged
  expect(confirmed.history.filter((h) => h.event === "integrated")).toHaveLength(2);
});

test("an unresolved outcome is final for its revision: the member's check counts, and nothing is asked again", async () => {
  const { tasks, board, later } = await turnFreeRig({
    check: (cls) => (cls === "implement" ? "true" : undefined),
    runCheck: async () => ({ code: 0, timedOut: false, interrupted: false, tail: "" }),
  });
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  await until(() => board.get(first.id)!.state === "in_review");
  for (let i = 0; i < 3; i++) {
    await tasks.done("codex", second.id, "b"); // kimi never stops
    later();
  }
  await tasks.done("codex", second.id, "b"); // unresolved, then its check
  await until(() => board.get(second.id)!.state === "in_review");
  expect(board.get(second.id)!.history.filter((h) => h.event === "integration unresolved")).toHaveLength(1);
  expect(board.get(second.id)!.history.some((h) => h.event === "check finished late")).toBe(false);
});

test("a member's writes count from when it was handed its task, before the overlap was found too", async () => {
  const windows: { peer: string; since: number; until?: number }[][] = [];
  const { tasks, stop } = await turnFreeRig({ treeHash: (_paths, w) => (windows.push(w), "t1") });
  const first = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/x.ts"] } });
  const handed = first.history.at(-1)!.at;
  const second = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/x.ts"] } }); // the cohort forms now
  await tasks.done("kimi", first.id, "a");
  stop("kimi");
  await tasks.done("codex", second.id, "b");
  expect(windows.at(-1)!.find((w) => w.peer === "kimi")!.since).toBeLessThanOrEqual(handed);
});

test("a member settling between the integrating member's calls keeps its writes in the target: nothing changed, nothing asked again", async () => {
  // What Facts.tree does with the windows: the files written by a member between joining and settling.
  const writes: { peer: string; file: string; at: number }[] = [];
  const treeHash = (_paths: string[], windows: { peer: string; since: number; until?: number }[]) =>
    [...new Set(writes.filter((w) => windows.some((x) => x.peer === w.peer && w.at >= x.since && (x.until === undefined || w.at <= x.until))).map((w) => w.file))].sort().join(",");
  const { tasks, stop, later } = await turnFreeRig({ treeHash });
  const { first, second } = await pair(tasks);
  writes.push({ peer: "kimi", file: "src/click/helper.py", at: Date.now() }); // outside the plan's paths
  await tasks.done("kimi", first.id, "a");
  await tasks.done("codex", second.id, "b"); // request 1, while kimi's turn still runs
  stop("kimi"); // kimi settles: its window closes, its file stays
  later();
  writes.push({ peer: "kimi", file: "src/other/next_task.py", at: Date.now() }); // its next work, after it settled
  expect((await tasks.done("codex", second.id, "b")).history.slice(-2).map((h) => h.event)).toEqual(["integrated", "done"]);
});

test("a cohort whose members have all settled is over: a peer leaving afterwards lifts nothing, and a reopen stays outside it", async () => {
  const { tasks, stop, later, notices } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  stop("kimi");
  await tasks.done("codex", second.id, "b");
  later();
  await tasks.done("codex", second.id, "b");
  stop("codex");
  // A reopen after the cohort was over stays outside it (withdraw collects it first, nothing else ran gc in between).
  await tasks.review("claude", first.id, "changes_requested", "fix it");
  expect(tasks.silenced("kimi", "codex")).toBeUndefined();
  expect(tasks.cohorts.of(first.id)).toBeUndefined();
  // A benchmark's teardown: a member's path is lost once the work is over. Nothing is lifted, nothing announced.
  expect(tasks.cohorts.lift("codex")).toEqual([]);
  expect(tasks.cohorts.lift("kimi")).toEqual([]);
  expect(notices.some((n) => n.includes("no longer silent"))).toBe(false);
});

test("an absolute path inside the project and its relative spelling are one place", async () => {
  const { tasks, dir } = await turnFreeRig();
  const a = await tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: [`${dir}/src/click/termui.py`] } });
  const b = await tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["./src/click/termui.py"] } });
  expect(tasks.cohorts.of(b.id)?.members.has(a.id)).toBe(true);
  const outside = await tasks.propose("claude", { title: "c", class: "implement", owner: "claude", refs: { paths: ["/elsewhere/src/click/termui.py"] } });
  expect(tasks.cohorts.of(outside.id)).toBeUndefined();
});

test("past three requests the outcome is unresolved, recorded with the done, never as integrated", async () => {
  const { tasks, notices, later } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  for (let i = 0; i < 3; i++) {
    await tasks.done("codex", second.id, "b"); // kimi never stops
    later();
  }
  const last = await tasks.done("codex", second.id, "b");
  expect(last.history.slice(-2).map((h) => h.event)).toEqual(["integration unresolved", "done"]);
  expect(last.history.some((h) => h.event === "integrated")).toBe(false);
  expect(notices.some((n) => n.includes("turn-free integration unresolved after 3 requests (kimi has not stopped since its done"))).toBe(true);
});

test("a failed check or a reopened review voids the member's intent; an integrating member's check counts only for its target", async () => {
  const checking = (results: Promise<number>[]) => ({
    check: (cls: string) => (cls === "implement" ? "make test" : undefined),
    runCheck: async () => ({ code: await (results.shift() ?? Promise.resolve(0)), timedOut: false, interrupted: false, tail: "" }),
  });
  // The files change while the integrating member's check runs: the check does not count, and the next done asks again.
  const moved: Promise<number>[] = [];
  let release!: (code: number) => void;
  const m = await turnFreeRig(checking(moved));
  const mp = await pair(m.tasks);
  await m.tasks.done("kimi", mp.first.id, "a");
  await until(() => m.board.get(mp.first.id)!.state === "in_review");
  m.stop("kimi");
  expect((await m.tasks.done("codex", mp.second.id, "b")).history.at(-1)!.event).toBe("integration requested");
  m.later();
  moved.push(new Promise<number>((r) => (release = r))); // codex's check: held
  await m.tasks.done("codex", mp.second.id, "b"); // confirmed; its check runs
  m.state.tree = "t2";
  release(0);
  await until(() => m.board.get(mp.second.id)!.history.some((h) => h.event === "check finished late"));
  expect(m.board.get(mp.second.id)!.history.find((h) => h.event === "check finished late")!.note).toContain("the integration target changed while it ran");
  m.later();
  expect((await m.tasks.done("codex", mp.second.id, "b")).history.at(-1)!.note).toContain("integration request 2 of 3): the files changed since the last request");
  // Another member's check fails after the integration was confirmed: that member is at work again and will integrate,
  // so the former integrating member is an earlier finisher again, and its own check counts.
  const results: Promise<number>[] = [];
  const { tasks, board, stop, later } = await turnFreeRig(checking(results));
  const { first, second } = await pair(tasks);
  results.push(new Promise<number>((r) => (release = r))); // kimi's check: held
  await tasks.done("kimi", first.id, "a"); // its check is running: its intent counts
  stop("kimi");
  expect((await tasks.done("codex", second.id, "b")).history.at(-1)!.event).toBe("integration requested");
  later();
  await tasks.done("codex", second.id, "b"); // confirmed; codex's check is queued behind kimi's
  release(1); // kimi's check fails: its intent is void, and the cohort moves on
  await until(() => board.get(second.id)!.state === "in_review");
  expect(board.get(second.id)!.history.some((h) => h.event === "check finished late")).toBe(false);
  // kimi fixes it: now its done completes the set again, and kimi integrates.
  const redo = await tasks.done("kimi", first.id, "a, fixed");
  expect(redo.history.at(-1)!.event).toBe("integration requested");
  // A reopened review voids an intent the same way.
  const review = await turnFreeRig();
  const p = await pair(review.tasks);
  await review.tasks.done("kimi", p.first.id, "a");
  await review.tasks.review("claude", p.first.id, "changes_requested", "fix it");
  expect(review.tasks.cohorts.of(p.first.id)!.intents.has(p.first.id)).toBe(false);
  expect((await review.tasks.done("codex", p.second.id, "b")).history.at(-1)!.event).toBe("done"); // kimi is at work again
});

test("after a restart an integration that was asked for is recorded as unresolved", async () => {
  const { tasks, board, dir, bus, notices } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  await tasks.done("codex", second.id, "b"); // request 1, then the hub stops
  const restarted = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: (l) => notices.push(l), turnFree: () => true });
  restarted.recoverIntegrations();
  expect(board.get(second.id)!.history.at(-1)).toMatchObject({ event: "integration unresolved", note: "the hub restarted before the integration was confirmed" });
  expect((await restarted.done("codex", second.id, "b")).history.at(-1)!.event).toBe("done");
});

test("after a restart the notices a silence held are replayed to the open member, with word that overlaps are settled by message again", async () => {
  const { tasks, board, dir, bus, notices, peers } = await turnFreeRig({}, ["claude", "codex", "kimi"]);
  const { first, second } = await pair(tasks);
  const third = await tasks.propose("claude", { title: "late", class: "implement", owner: "claude", refs: { paths: ["src/click/termui.py"] } });
  await tasks.done("kimi", first.id, "edit takes several files"); // held: kimi's notice never went out
  await tick();
  expect(completedNotices(peers.codex!)).toEqual([]);
  const restarted = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: (l) => notices.push(l), turnFree: () => true });
  restarted.replayHeld("codex");
  restarted.replayHeld("kimi"); // its task is closed: nothing for it
  await tick();
  const toCodex = peers.codex!.got.map((e) => e.body).find((b) => b.includes("the hub restarted"))!;
  expect(toCodex).toContain(`Task #${second.id}: the hub restarted, so overlaps with claude are settled via hub_send again`);
  expect(toCodex).toContain(`Task #${first.id} (owner kimi) is done and touches your open #${second.id}`);
  expect(peers.kimi!.got.some((e) => e.body.includes("the hub restarted"))).toBe(false);
  expect(third.owner).toBe("claude");
});

test("the console user is never asked to integrate, a PII task joins no cohort, and advisory never asks", async () => {
  const { tasks } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a done");
  expect((await tasks.done(USER, second.id, "by hand")).history.at(-1)!.event).toBe("done");
  // The console finishing an earlier member still records its intent: the last agent to finish integrates.
  const early = await turnFreeRig();
  const e = await pair(early.tasks);
  await early.tasks.done(USER, e.first.id, "kimi's part, by hand");
  early.stop("kimi");
  const asked = await early.tasks.done("codex", e.second.id, "b");
  expect(asked.history.at(-1)!.event).toBe("integration requested");
  expect(asked.history.at(-1)!.note).toContain(`- #${e.first.id} multi-file edit (owner kimi`);
  // A PII task, owned by the on-prem worker on the same file, joins no cohort (the daemon test covers the hub
  // switching to advisory while one is open).
  const pii = await turnFreeRig({}, ["claude", "codex", "kimi", "local"]);
  const secret = await pii.tasks.propose("claude", { title: "note for 900101-1234567", class: "implement", refs: { paths: ["src/click/termui.py"] } });
  expect(secret.owner).toBe("local");
  const p = await pair(pii.tasks);
  expect(pii.tasks.cohorts.of(secret.id)).toBeUndefined();
  expect([...pii.tasks.cohorts.of(p.second.id)!.members.keys()].sort()).toEqual([p.first.id, p.second.id]);
  const advisory = await setup(["claude", "codex", "kimi"]);
  await advisory.tasks.propose("kimi", { title: "a", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const c = await advisory.tasks.propose("codex", { title: "b", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  await advisory.tasks.done("kimi", 1, "a done");
  expect((await advisory.tasks.done("codex", c.id, "b done")).history.at(-1)!.event).toBe("done");
});

test("the last member still at work keeps the others' paths and plans in its facts after they finished; a finished member has none", async () => {
  const { tasks } = await turnFreeRig();
  const { first, second } = await pair(tasks);
  await tasks.done("kimi", first.id, "a");
  expect(tasks.factScope("kimi")).toBeUndefined();
  expect(tasks.factScope("codex")).toMatchObject({ paths: ["src/click/termui.py"], plans: [{ task: first.id, owner: "kimi", text: "signatures: edit(filename: str | Iterable[str])" }], task: { id: second.id } });
});

test("held notices replace the integration step that does not run: on a lift, for a done in a lost silence, and for the console", async () => {
  // Lifted after kimi's done: codex, still at work, gets kimi's completed-change notice with the lift.
  const lifted = await turnFreeRig();
  const a = await pair(lifted.tasks);
  await lifted.tasks.done("kimi", a.first.id, "edit takes several files");
  for (const c of lifted.tasks.cohorts.lift("kimi")) lifted.tasks.announceLift(c, "kimi's context path is no longer verified");
  await tick();
  const toCodex = lifted.peers.codex!.got.map((e) => e.body).find((b) => b.includes("silence is lifted"))!;
  expect(toCodex).toContain(`Task #${a.first.id} (owner kimi) is done and touches your open #${a.second.id}`);
  expect(lifted.peers.kimi!.got.some((e) => e.body.includes("silence is lifted"))).toBe(false); // its task is closed: no turn for it
  // Turn-free switched off before the last done (a PII task opened): the done carries the held notice instead.
  let on = true;
  const off = await turnFreeRig({ turnFree: () => on });
  const b = await pair(off.tasks);
  await off.tasks.done("kimi", b.first.id, "edit takes several files");
  on = false;
  expect((await off.tasks.done("codex", b.second.id, "b")).history.at(-1)!.event).toBe("done");
  expect(off.tasks.takeDoneNote(b.second.id)).toContain(`Overlapping work finished while you worked (no turn-free integration step ran):\nTask #${b.first.id} (owner kimi) is done`);
  // The console finishing the last task: the console hears it.
  const byHand = await turnFreeRig();
  const c = await pair(byHand.tasks);
  await byHand.tasks.done("kimi", c.first.id, "edit takes several files");
  await byHand.tasks.done(USER, c.second.id, "by hand");
  expect(byHand.notices.some((n) => n.includes(`done by the console; overlapping work finished meanwhile:\nTask #${c.first.id} (owner kimi) is done`))).toBe(true);
});

test("in a silent cohort only members' notices are held: an open task outside it still hears of the change", async () => {
  const { tasks, peers } = await turnFreeRig();
  const { second } = await pair(tasks);
  const outsider = await tasks.propose("claude", { title: "docs", class: "implement", owner: "claude", refs: { paths: ["docs/edit.md"] } });
  await tasks.done("codex", second.id, "changed termui and docs", { paths: ["src/click/termui.py", "docs/edit.md"] });
  await tick();
  expect(peers.claude!.got.some((e) => e.body.startsWith(`Task #${second.id} (owner codex) is done and touches your open #${outsider.id}`))).toBe(true);
  expect(completedNotices(peers.kimi!)).toEqual([]); // the member's is held
});

test("merging a silent cohort into one that is not lifts it, and its members hear so", async () => {
  const { tasks, state, peers } = await turnFreeRig();
  const { second } = await pair(tasks); // silent: kimi and codex on termui.py
  state.capable.delete("claude");
  await tasks.propose("claude", { title: "docs", class: "implement", owner: "claude", refs: { paths: ["docs/a.md"] } });
  await tasks.propose("claude", { title: "docs 2", class: "implement", owner: "kimi", refs: { paths: ["docs/a.md"] } }); // with claude: not silent
  expect(tasks.silentFor(second.id)).toBe(true);
  // A task on both files joins the two cohorts into one: claude cannot be shown facts, so the merged cohort speaks.
  await tasks.propose("claude", { title: "both", class: "implement", owner: "codex", refs: { paths: ["src/click/termui.py", "docs/a.md"] } });
  await tick();
  expect(tasks.silentFor(second.id)).toBe(false);
  expect(peers.codex!.got.some((e) => e.body.includes("silence is lifted"))).toBe(true);
});

test("a silent cohort publishes no completed-change notice: the integrating member checks instead", async () => {
  const { tasks, peers } = await turnFreeRig();
  const { second } = await pair(tasks);
  await tasks.done("codex", second.id, "changed termui");
  await tick();
  expect(completedNotices(peers.kimi!)).toEqual([]);
});

// issue #109: split observations are the tasks handed to a peer with the profile it has now, typed; the shadow prediction
// never changes assignment.
test("split observations: tasks handed out with the peer's current profile, claims and accepts made by the done left out of the stages, failures typed", async () => {
  let profile: string | undefined = "hub 0.12.5; kimi 2.1.1; turn-free";
  const { tasks, board } = await turnFreeRig({ ...({ splitProfile: () => profile }), wipLimit: () => 2 });
  let now = 1_800_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    for (let i = 0; i < 2; i++) {
      const t = await tasks.propose("claude", { title: `offered ${i}`, class: "implement", owner: "kimi" });
      now += 10_000;
      tasks.accept("kimi", t.id);
      now += 40_000;
      await tasks.done("kimi", t.id, "done");
      await tasks.review(board.get(t.id)!.reviewer!, t.id, "approved");
    }
    const quick = await tasks.propose("claude", { title: "done at once", class: "implement", owner: "kimi" });
    now += 5_000;
    await tasks.done("kimi", quick.id, "done"); // no separate accept: its stages are unknown
    await tasks.review(board.get(quick.id)!.reviewer!, quick.id, "approved");
    const failed = await tasks.propose("claude", { title: "failed", class: "implement", owner: "kimi" });
    await tasks.done("kimi", failed.id, "done");
    await tasks.review(board.get(failed.id)!.reviewer!, failed.id, "changes_requested", "no");
    const claim = await tasks.propose("kimi", { title: "claimed", class: "implement", owner: "kimi" });
    await tasks.done("kimi", claim.id, "done");
    await tasks.review(board.get(claim.id)!.reviewer!, claim.id, "approved"); // approved: left out as a claim, not as open work
    expect(tasks.splitObservations("implement", "kimi")).toEqual([
      { outcome: "approved", orient: 10_000, work: 40_000 },
      { outcome: "approved", orient: 10_000, work: 40_000 },
      { outcome: "approved" },
      { outcome: "failed" },
    ]);
    expect(tasks.splitObservations("review", "kimi")).toEqual([]);
  } finally {
    Date.now = realNow;
  }
  // Another profile (a new version of the hub or the agent) is another peer as far as the records go; none known, none.
  profile = "hub 0.12.6; kimi 2.1.1; turn-free";
  expect(tasks.splitObservations("implement", "kimi")).toEqual([]);
  profile = undefined;
  expect(tasks.splitObservations("implement", "kimi")).toEqual([]);
});

test("a split observation counts what happened from a hand-over to the next one: a decline is the decliner's, never the next owner's", async () => {
  const { tasks, board } = await turnFreeRig({ splitProfile: (p) => `hub 0.12.5; ${p} 1.0.0; turn-free` });
  const t = await tasks.propose("claude", { title: "declined first", class: "implement", owner: "codex" });
  await tasks.decline("codex", t.id, "not mine");
  const next = board.get(t.id)!;
  expect(next.owner).toBe("kimi");
  tasks.accept("kimi", t.id);
  await tasks.done("kimi", t.id, "done");
  await tasks.review(board.get(t.id)!.reviewer!, t.id, "approved");
  expect(tasks.splitObservations("implement", "kimi").map((o) => o.outcome)).toEqual(["approved"]);
  expect(tasks.splitObservations("implement", "codex")).toEqual([{ outcome: "failed" }]); // the decline is the decliner's
});

test("an escalation away is the previous owner's failure; work that waited for another task is routed when ready, and recorded", async () => {
  const recorded: { task: number; where: string }[] = [];
  const { tasks, board } = await turnFreeRig({ recordSplit: (task, _p, where) => recorded.push({ task, where }), splitProfile: (p) => `hub 0.12.5; ${p} 1.0.0; turn-free` , wipLimit: () => 2 });
  const t = await tasks.propose("claude", { title: "escalated", class: "implement", owner: "codex" });
  tasks.accept("codex", t.id);
  await tasks.escalate("user", t.id);
  const next = board.get(t.id)!.owner!;
  expect(next).not.toBe("codex");
  tasks.accept(next, t.id);
  await tasks.done(next, t.id, "done");
  await tasks.review(board.get(t.id)!.reviewer!, t.id, "approved");
  expect(tasks.splitObservations("implement", "codex")).toEqual([{ outcome: "failed" }]); // the escalation is codex's
  expect(tasks.splitObservations("implement", next).map((o) => o.outcome)).toEqual(["approved"]);
  // A task that waited for another is assigned by routing once that is approved: a routing record, as for fresh work.
  const first = await tasks.propose("claude", { title: "first", class: "implement", owner: "kimi" });
  await tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/d.ts"] } });
  const waiting = await tasks.propose("claude", { title: "after first", class: "implement", after: [first.id], refs: { paths: ["src/d.ts"] } });
  expect(board.get(waiting.id)!.owner).toBeFalsy();
  recorded.length = 0;
  await tasks.done("kimi", first.id, "done");
  await tasks.review(board.get(first.id)!.reviewer!, first.id, "approved");
  expect(board.get(waiting.id)!.owner).toBeTruthy();
  expect(recorded).toContainEqual({ task: waiting.id, where: "routing" });
});

test("the shadow prediction never changes assignment: routed and named work go where routing sends them; explain and the record show it", async () => {
  const recorded: { task: number; verdict: string; where: string }[] = [];
  const { tasks } = await turnFreeRig({ ...({ recordSplit: (task, p, where) => recorded.push({ task, verdict: p.verdict, where }), splitProfile: (p) => `hub 0.12.5; ${p} 1.0.0; turn-free` }), wipLimit: () => 5 });
  const kimiPart = await tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const routed = await tasks.propose("claude", { title: "routed part", class: "implement", refs: { paths: ["src/a.ts"] } });
  expect(routed.owner).toBe("codex"); // the configured order, whatever the records say
  // Routing chose the owner, and the overlapped task has not started: the prediction calibration reads.
  expect(recorded).toEqual([{ task: routed.id, verdict: "unknown", where: "routing" }, { task: routed.id, verdict: "unknown", where: "cohort" }]);
  const explained = tasks.explain(routed.id).join("\n");
  expect(explained).toContain("shadow split prediction (it never changes assignment):");
  expect(explained).toContain("codex: hub 0.12.5; codex 1.0.0; turn-free");
  expect(explained).toContain(`unknown: codex has 0 measured task(s) with this profile; ${SPLIT_MIN} are needed`);
  const named = await tasks.propose("claude", { title: "named part", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  expect(named.owner).toBe("codex");
  // Recorded where the overlap forms a cohort, named owner or not; a named owner is no routing decision.
  expect(recorded.slice(2)).toEqual([{ task: named.id, verdict: "unknown", where: "cohort" }]);
  // Once the overlapped task has started, routing records nothing for calibration: that owner is at work already.
  tasks.accept("kimi", kimiPart.id);
  recorded.length = 0;
  const late = await tasks.propose("claude", { title: "late part", class: "implement", refs: { paths: ["src/a.ts"] } });
  expect(recorded.filter((r) => r.where === "routing")).toEqual([]);
  expect(late.history.find((h) => h.event === "assigned")?.profile).toBe(`hub 0.12.5; ${late.owner} 1.0.0; turn-free`);
  // explain shows the prediction for the pair the record is about: the task's own owner.
  const kimiNamed = await tasks.propose("claude", { title: "kimi named", class: "implement", owner: "kimi", refs: { paths: ["src/b.ts"] } });
  await tasks.propose("claude", { title: "codex on b", class: "implement", owner: "codex", refs: { paths: ["src/b.ts"] } });
  expect(tasks.explain(kimiNamed.id).join("\n")).toContain("unknown: kimi has 1 other open task(s)"); // kimi's, not routing's pick
  // A reassignment after a decline, and a claim, are no routing decisions about fresh work.
  const fresh = await tasks.propose("claude", { title: "fresh part", class: "implement", refs: { paths: ["src/c.ts"] } });
  await tasks.propose("codex", { title: "claude on c", class: "implement", owner: "claude", refs: { paths: ["src/c.ts"] } });
  recorded.length = 0;
  await tasks.decline(fresh.owner!, fresh.id, "not mine");
  await tasks.propose("codex", { title: "codex claims c", class: "implement", owner: "codex", refs: { paths: ["src/c.ts"] } });
  expect(recorded.filter((r) => r.where === "routing")).toEqual([]);
  // Work routing gives back to its proposer is no hand-over the observations count, so no calibration record either.
  const own = await tasks.propose("codex", { title: "codex's own on c", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(own.owner).toBe("codex"); // the configured order; claude's task on src/c.ts has not started
  expect(recorded.filter((r) => r.where === "routing")).toEqual([]);
});

// issue #109: an owner goes busy as its task is delivered, so at routing time the overlapped task's owner is busy taking
// it; the routing record must not read that as "not available", or no calibration record could ever be known.
test("the routing record counts the overlapped task's owner as available while it is busy taking that task", async () => {
  class Taking extends BasePeer {
    async deliver() { this.setState("busy"); }
    async start() { this.setState("idle"); }
    async stop() {}
  }
  const dir = mkdtempSync(join(tmpdir(), "agenthub-tasks-"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "kimi"]) { const p = new Taking(id); bus.add(p); await p.start(); }
  const recorded: { where: string; trace: string[] }[] = [];
  const tasks = new Tasks({ board: new Board(join(dir, "hub.db")), bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {}, tell: () => {}, turnFree: () => true,
    splitProfile: (p) => `hub 0.12.5; ${p} 1.0.0; turn-free`, recordSplit: (_task, p, where) => recorded.push({ where, trace: p.trace }) });
  const a = await tasks.propose("claude", { title: "part a", class: "implement", refs: { paths: ["src/a.ts"] } });
  await Bun.sleep(20);
  expect(bus.stateOf(a.owner!)).toBe("busy"); // taking part a
  await tasks.propose("claude", { title: "part b", class: "implement", refs: { paths: ["src/a.ts"] } });
  const routing = recorded.find((r) => r.where === "routing");
  expect(routing).toBeDefined();
  expect(routing!.trace.join("\n")).not.toContain("not available");
});

// issue #115: busy is taking the task in question only in the turn that task started, or in which it was claimed.
test("a split prediction counts busy as taking a task only in the turn that task started or was claimed in", async () => {
  class Taking extends BasePeer {
    async deliver() { this.setState("busy"); }
    async start() { this.setState("idle"); }
    async stop() {}
    finish() { this.setState("idle"); }
    work() { this.setState("busy"); }
  }
  const rig = async (durable = false) => {
    const dir = mkdtempSync(join(tmpdir(), "agenthub-tasks-"));
    // The daemon's bus has a journal, which drains at the end of the publish, after persisting.
    const bus = new Bus({ batchMs: 0, ...(durable ? { journal: new DeliveryJournal({ file: join(dir, "journal.db"), projectRoot: dir, projectId: "p", instanceId: "i" }) } : {}) });
    const peers = Object.fromEntries(["claude", "codex", "kimi"].map((id) => [id, new Taking(id)]));
    for (const p of Object.values(peers)) { bus.add(p); await p.start(); }
    const recorded: { where: string; trace: string }[] = [];
    const tasks = new Tasks({ board: new Board(join(dir, "hub.db")), bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {}, tell: () => {}, turnFree: () => true,
      splitProfile: (p) => `hub 0.12.6; ${p} 1.0.0; turn-free`, recordSplit: (_task, p, where) => recorded.push({ where, trace: p.trace.join("\n") }) });
    const busy = async (peer: string) => { bus.publish(newEnvelope("claude", "a question first", { to: [peer] })); await Bun.sleep(20); };
    const routingTrace = () => recorded.find((r) => r.where === "routing")?.trace ?? "";
    return { bus, tasks, busy, routingTrace, peers, recorded, dir };
  };
  // The overlapped task's owner is busy with a question while that task waits in its queue: not taking it.
  const queued = await rig();
  await queued.busy("kimi");
  await queued.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  expect(queued.bus.queued("kimi")).toBe(1);
  const routed = await queued.tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(routed.owner).toBe("codex");
  expect(queued.routingTrace()).toContain("kimi is not available");
  // The routed peer is busy with a question when the record is taken (the task is sent after it): not available.
  const candidate = await rig();
  await candidate.busy("codex");
  await candidate.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  expect(candidate.bus.queued("kimi")).toBe(0); // kimi is busy taking its part: that one is available
  const other = await candidate.tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(other.owner).toBe("codex");
  expect(candidate.routingTrace()).toContain("codex is not available");
  // A task handed back to a peer that had it before is a new hand-over: until it is sent again, a busy peer is not taking it.
  const back = await rig();
  const part = await back.tasks.propose("claude", { title: "codex's part", class: "implement", owner: "codex", refs: { paths: ["src/c.ts"] } });
  await back.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  await back.tasks.assignTo(part.id, "claude");
  back.peers.codex!.finish();
  await back.busy("codex"); // busy with a question, nothing queued
  back.recorded.length = 0;
  await back.tasks.assignTo(part.id, "codex");
  expect(back.recorded.find((r) => r.where === "cohort")?.trace).toContain("codex is not available");
  // The turn the task started has ended (the task is still not started) and the owner is busy again: another turn.
  const ended = await rig();
  await ended.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  ended.peers.kimi!.finish();
  await ended.busy("kimi");
  await ended.tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(ended.routingTrace()).toContain("kimi is not available");
  // Still in the turn its task started, with a message queued behind it: still taking it.
  const behind = await rig();
  await behind.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  behind.bus.publish(newEnvelope("claude", "a status line", { to: ["kimi"] }));
  expect(behind.bus.queued("kimi")).toBe(1);
  // Paused and resumed within that turn: still the same turn.
  behind.bus.pause("kimi");
  behind.bus.resume("kimi");
  await behind.tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(behind.routingTrace()).toContain("unknown");
  expect(behind.routingTrace()).not.toContain("not available");
  // Its delivery held (a recovery), the task starts no turn; busy later is a turn of the peer's own.
  const held = await rig();
  held.bus.setRecoveryHold(true);
  await held.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  expect([held.bus.stateOf("kimi"), held.bus.queued("kimi")]).toEqual(["idle", 1]);
  held.peers.kimi!.work();
  await held.tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(held.routingTrace()).toContain("kimi is not available");
  // With the daemon's journal, the task that starts the turn is taken as well.
  const durable = await rig(true);
  await durable.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  expect([durable.bus.stateOf("kimi"), durable.bus.queued("kimi")]).toEqual(["busy", 0]);
  await durable.tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(durable.routingTrace()).toContain("unknown");
  expect(durable.routingTrace()).not.toContain("not available");
  // A claim in the turn the claimant is in, with a message queued behind that turn: it is taking what it claimed.
  const claimed = await rig();
  await claimed.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  await claimed.busy("codex");
  claimed.bus.publish(newEnvelope("claude", "a status line", { to: ["codex"] }));
  expect(claimed.bus.queued("codex")).toBe(1);
  await claimed.tasks.propose("codex", { title: "codex's part", class: "implement", owner: "codex", refs: { paths: ["src/c.ts"] } });
  const cohort = claimed.recorded.find((r) => r.where === "cohort")?.trace;
  expect(cohort).toBeDefined();
  expect(cohort).not.toContain("not available");
  // Claimed while paused in its turn (paused peers routed too) and resumed: `route explain` still reads it as taken.
  const paused = await rig();
  mkdirSync(join(paused.dir, ".agenthub"), { recursive: true });
  writeFileSync(join(paused.dir, ".agenthub", "routing.toml"), readFileSync(join(import.meta.dir, "..", "templates", "routing.toml"), "utf8").replace('budget_paused = "skip_peer"', 'budget_paused = "off"'));
  await paused.tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  await paused.busy("codex");
  paused.bus.pause("codex");
  const mine = await paused.tasks.propose("codex", { title: "codex's part", class: "implement", owner: "codex", refs: { paths: ["src/c.ts"] } });
  paused.bus.resume("codex");
  expect(mine.owner).toBe("codex");
  const explained = paused.tasks.explain(mine.id).join("\n");
  expect(explained).toContain("unknown");
  expect(explained).not.toContain("not available");
  // A peer that steers (Codex, Pi): its task is steered into the turn it is in, nothing is queued, and it is still not
  // taking it: that turn is about something else.
  class Steering extends Taking { async steer() {} }
  const dir = mkdtempSync(join(tmpdir(), "agenthub-tasks-"));
  const bus = new Bus({ batchMs: 0 });
  for (const p of [new Taking("claude"), new Taking("codex"), new Steering("kimi")]) { bus.add(p); await p.start(); }
  const recorded: { where: string; trace: string }[] = [];
  const tasks = new Tasks({ board: new Board(join(dir, "hub.db")), bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {}, tell: () => {}, turnFree: () => true,
    splitProfile: (p) => `hub 0.12.6; ${p} 1.0.0; turn-free`, recordSplit: (_task, p, where) => recorded.push({ where, trace: p.trace.join("\n") }) });
  bus.publish(newEnvelope("claude", "a question first", { to: ["kimi"] }));
  await Bun.sleep(20);
  await tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/c.ts"] } });
  expect([bus.stateOf("kimi"), bus.queued("kimi")]).toEqual(["busy", 0]); // steered, not queued
  await tasks.propose(USER, { title: "routed part", class: "implement", refs: { paths: ["src/c.ts"] } });
  expect(recorded.find((r) => r.where === "routing")?.trace).toContain("kimi is not available");
});

test("an approval offer with no peer is retried once codex returns, without timer noise while offline (#231)", async () => {
  const { tasks, board, peers, notices } = await setup(["claude", "codex"]);
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  await tasks.done("codex", a.id, "done");
  peers.codex!.set("offline");
  await tasks.review("claude", a.id, "approved");
  expect(board.get(c.id)).toMatchObject({ owner: null, reviewer: null, state: "proposed" });
  expect(board.get(c.id)!.history.at(-1)!.event).toBe("ready");
  const history = board.get(c.id)!.history, beforeNotices = [...notices];
  await tasks.releaseReady(); await tasks.releaseReady();
  expect(board.get(c.id)!.history).toEqual(history);
  expect(notices).toEqual(beforeNotices);
  peers.codex!.set("idle");
  await tasks.releaseReady(); await tick();
  expect(board.get(c.id)!.owner).toBe("codex");
  expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === String(c.id))).toHaveLength(1);
});

for (const event of ["ready", "assigned"] as const) {
  test(`a failed dependent ${event} write does not throw after approval or consume the offer (#231)`, async () => {
    const { tasks, board, peers, notices } = await setup(["claude", "codex"]);
    const a = await tasks.propose("claude", { title: "schema", class: "implement" });
    const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
    await tasks.done("codex", a.id, "done");
    const update = board.update.bind(board);
    board.update = (...args: Parameters<Board["update"]>) => {
      if (args[0] === c.id && args[2] === event) throw new Error(`injected ${event} write failure`);
      return update(...args);
    };
    try { await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ state: "approved" }); }
    finally { board.update = update; }
    expect(notices.some((line) => line.includes(`task #${c.id} client`) && line.includes(`injected ${event} write failure`))).toBe(true);
    expect(board.get(c.id)!.owner).toBeNull();
    await tasks.releaseReady(); await tick();
    expect(board.get(c.id)!.owner).toBe("codex");
    expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === String(c.id))).toHaveLength(1);
  });
}

for (const read of [1, 4]) {
  test(`dependent offer read ${read} failing after approval is reported and leaves the offer unused (#231)`, async () => {
    const { tasks, board, peers, notices } = await setup(["claude", "codex"]);
    const a = await tasks.propose("claude", { title: "schema", class: "implement" });
    const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
    await tasks.done("codex", a.id, "done");
    peers.codex!.set("offline"); // entry, ready update's two reads, then final owner check (no assignment write)
    const get = board.get.bind(board);
    let reads = 0;
    board.get = (id: number) => {
      if (id === c.id && ++reads === read) throw new Error(`injected offer read ${read} failure`);
      return get(id);
    };
    try { await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ state: "approved" }); }
    finally { board.get = get; }
    expect(reads).toBe(read); // read 4 must fail in finally, after both reads within the ready write
    const path = read === 4 ? "could not verify assignment" : "could not be assigned";
    expect(notices.some((line) => line.includes(`task #${c.id} client: ${path}`) && line.includes(`injected offer read ${read} failure`))).toBe(true);
    expect(board.get(c.id)!.owner).toBeNull();
    peers.codex!.set("idle");
    await tasks.releaseReady(); await tick();
    expect(board.get(c.id)!.owner).toBe("codex");
    expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === String(c.id))).toHaveLength(1);
  });
}

for (const path of ["ready", "catch", "finally"] as const) {
  test(`an offer's ${path} notification failing cannot escape a saved approval (#231)`, async () => {
    const base = await setup(["claude", "codex"]);
    let dependent = 0, failedNotices = 0;
    const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (line) => {
      const match = path === "ready" ? "is ready:" : path === "catch" ? "could not be assigned:" : "could not verify assignment:";
      if (line.includes(`task #${dependent} `) && line.includes(match)) { failedNotices++; throw new Error("notification board unavailable"); }
    } });
    const a = await tasks.propose("claude", { title: "schema", class: "implement" });
    const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] }); dependent = c.id;
    await tasks.done("codex", a.id, "done");
    const update = base.board.update.bind(base.board), get = base.board.get.bind(base.board);
    let reads = 0;
    if (path === "catch") base.board.update = (...args: Parameters<Board["update"]>) => {
      if (args[0] === c.id && args[2] === "ready") throw new Error("ready write unavailable");
      return update(...args);
    };
    if (path === "finally") {
      base.peers.codex!.set("offline");
      base.board.get = (id: number) => { if (id === c.id && ++reads === 4) throw new Error("final owner read unavailable"); return get(id); };
    }
    try { await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ state: "approved" }); }
    finally { base.board.update = update; base.board.get = get; }
    expect(failedNotices).toBe(1);
    if (path === "ready") expect(base.board.get(c.id)!.owner).toBe("codex");
    base.peers.codex!.set("idle");
    await tasks.releaseReady(); await tick();
    expect(base.board.get(c.id)!.owner).toBe("codex");
    expect(base.peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === String(c.id))).toHaveLength(1);
  });
}

for (const path of ["list", "waits"] as const) {
  test(`a dependent ${path} read failing after approval is reported without escaping and retries later (#231)`, async () => {
    const { tasks, board, peers, notices } = await setup(["claude", "codex"]);
    const a = await tasks.propose("claude", { title: "schema", class: "implement" });
    const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
    await tasks.done("codex", a.id, "done");
    const list = board.list.bind(board), get = board.get.bind(board);
    let scanning = false, failedReads = 0;
    board.list = (state) => {
      if (state === "proposed") {
        scanning = true;
        if (path === "list" && !failedReads++) throw new Error("dependent list unavailable");
      }
      return list(state);
    };
    if (path === "waits") board.get = (id) => {
      if (scanning && id === a.id && !failedReads++) throw new Error("dependency read unavailable");
      return get(id);
    };
    try { await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ state: "approved" }); }
    finally { board.list = list; board.get = get; }
    expect(failedReads).toBe(1);
    expect(notices.some((line) => line.includes("could not release dependents:") && line.includes(path === "list" ? "dependent list unavailable" : "dependency read unavailable"))).toBe(true);
    expect(board.get(c.id)!.owner).toBeNull();
    await tasks.releaseReady(); await tick();
    expect(board.get(c.id)!.owner).toBe("codex");
    expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === String(c.id))).toHaveLength(1);
  });
}

test("a throwing publish after the approval write returns the approved task and names the failure (#243)", async () => {
  const { tasks, board, bus, notices } = await setup(["claude", "codex"]);
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  await tasks.done("codex", a.id, "done");
  const publish = bus.publish.bind(bus);
  bus.publish = () => { throw new Error("delivery journal unavailable"); }; // a latched storage error
  try { await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ id: a.id, state: "approved" }); }
  finally { bus.publish = publish; }
  expect(board.get(a.id)!.state).toBe("approved");
  expect(notices.some((line) => line.includes(`task #${a.id}`) && line.includes("could not tell") && line.includes("delivery journal unavailable"))).toBe(true);
});

test("a throwing notify after a reviewer-less done returns the approved task (#243)", async () => {
  const base = await setup(["claude", "codex"]);
  let thrown = false;
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (line) => {
    if (!thrown && line.includes("no reviewer: approved")) { thrown = true; throw new Error("console unavailable"); }
  } });
  const t = await tasks.propose("claude", { title: "read the design", class: "review" });
  await expect(tasks.done("claude", t.id, "looks right")).resolves.toMatchObject({ id: t.id, state: "approved" });
  expect(thrown).toBe(true);
});

test("a throwing notify from note() after a done write returns the approved task (#243)", async () => {
  const base = await setup(["claude", "codex"]);
  let thrown = false;
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", memory: new MemoryClient(base.mem.url), notify: (line) => {
    if (!thrown && line.includes("note was not saved to shared memory")) { thrown = true; throw new Error("console unavailable"); }
  } });
  const t = await tasks.propose("claude", { title: "check the chart", class: "review" });
  // The summary matches a PII pattern, so note() takes its notify path after the done write.
  await expect(tasks.done("claude", t.id, PII)).resolves.toMatchObject({ id: t.id, state: "approved" });
  expect(thrown).toBe(true);
});

test("a second changes_requested returns the moved task when telling its old owner fails (#243)", async () => {
  const { tasks, board, bus, notices } = await setup();
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  await tasks.done("kimi", 1, "v");
  await tasks.review("claude", 1, "changes_requested", "too long");
  await tasks.done("kimi", 1, "v");
  const publish = bus.publish.bind(bus);
  // Only the note to the owner it left fails: the new owner's assignment is another path.
  bus.publish = (env) => { if (env.body.includes("Stop working on it")) throw new Error("delivery journal unavailable"); return publish(env); };
  try { await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1, owner: "codex", state: "in_progress" }); }
  finally { bus.publish = publish; }
  expect(board.get(1)!.owner).toBe("codex");
  expect(notices.some((line) => line.includes("could not tell kimi it moved to codex") && line.includes("delivery journal unavailable"))).toBe(true);
});

test("a second changes_requested returns the moved task when the escalation's assignment cannot publish (#276)", async () => {
  const { tasks, board, bus, peers, notices, saves } = await setup();
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  await tasks.done("kimi", 1, "v");
  await tasks.review("claude", 1, "changes_requested", "too long");
  await tasks.done("kimi", 1, "v");
  const kimiHeard = peers.kimi!.got.length;
  const publish = bus.publish.bind(bus);
  bus.publish = () => { throw new Error("delivery journal unavailable"); }; // a latched storage error
  try { await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1, owner: "codex", state: "in_progress" }); }
  finally { bus.publish = publish; }
  expect(board.get(1)!).toMatchObject({ owner: "codex", state: "in_progress" });
  // The saved escalation's guarded tail still ran: the console notice and the decision note landed, and the old
  // owner's stop message was attempted and its failure noticed (kimi heard nothing).
  expect(notices.some((line) => line.includes("escalated from kimi to codex"))).toBe(true);
  expect(notices.some((line) => line.includes("could not tell kimi it moved to codex") && line.includes("delivery journal unavailable"))).toBe(true);
  await until(() => saves().some((s) => typeof s.text === "string" && s.text.includes("escalated from kimi to codex")));
  expect(peers.kimi!.got.length).toBe(kimiHeard);
  expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === "1")).toHaveLength(0);
  // The notice says what is known: the move is saved, the delivery is not confirmed, what to check before resending.
  expect(notices.some((line) => line.includes("the move to codex is saved") && line.includes("delivery is not confirmed") && line.includes("ahub queue list --peer codex") && line.includes("ahub queue show") && line.includes("ahub task show 1") && line.includes("ahub task assign 1 codex"))).toBe(true);
  // The command it names delivers the task envelope.
  await tasks.assignTo(1, "codex", USER);
  expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === "1")).toHaveLength(1);
  expect(board.get(1)!.history.at(-1)!.event).toBe("reassigned");
});

test("a delivery_failed escalation whose assignment cannot publish runs the guarded tail and still throws (#276)", async () => {
  const { tasks, board, bus, peers, notices, saves } = await setup();
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  const kimiHeard = peers.kimi!.got.length;
  const publish = bus.publish.bind(bus);
  bus.publish = () => { throw new Error("delivery journal unavailable"); }; // a latched storage error
  // The hub's own escalation reason writes no `from` on the history entry: the tail must still run.
  try { await expect(tasks.escalate(HUB, 1, "Undeliverable to kimi: retries exhausted", "delivery_failed")).rejects.toThrow("delivery journal unavailable"); }
  finally { bus.publish = publish; }
  expect(board.get(1)!).toMatchObject({ owner: "codex" });
  expect(notices.some((line) => line.includes("escalated from kimi to codex"))).toBe(true);
  expect(notices.some((line) => line.includes("could not tell kimi it moved to codex") && line.includes("delivery journal unavailable"))).toBe(true);
  await until(() => saves().some((s) => typeof s.text === "string" && s.text.includes("escalated from kimi to codex")));
  expect(peers.kimi!.got.length).toBe(kimiHeard);
});

test("a ready offer whose assignment cannot publish is noticed as saved-but-unconfirmed, and the resend delivers (#297)", async () => {
  const { tasks, board, bus, peers, notices } = await setup(["claude", "codex"]);
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  await tasks.done("codex", a.id, "done");
  const publish = bus.publish.bind(bus);
  bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === String(c.id)) throw new Error("delivery journal unavailable"); return publish(env); };
  try { await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ state: "approved" }); }
  finally { bus.publish = publish; }
  // Board and notice agree: the move is saved, the delivery is not confirmed, and no notice says the move failed.
  expect(board.get(c.id)!.owner).toBe("codex");
  expect(notices.some((l) => l.includes(`task #${c.id} client`) && l.includes("delivery is not confirmed") && l.includes(`ahub task assign ${c.id} codex`))).toBe(true);
  expect(notices.some((l) => l.includes("could not be assigned"))).toBe(false);
  await tasks.assignTo(c.id, "codex", USER);
  expect(peers.codex!.got.filter((e) => e.kind === "task" && e.refs?.task === String(c.id))).toHaveLength(1);
});

test("a budget relay move whose assignment cannot publish is noticed as saved-but-unconfirmed, the relay goes on, and the resend delivers (#297)", async () => {
  const { tasks, board, bus, peers, notices } = await setup(undefined, undefined, undefined, 2);
  await tasks.propose("claude", { title: "write docs", class: "implement", owner: "kimi" });
  await tasks.propose("claude", { title: "write tests", class: "implement", owner: "kimi" });
  tasks.accept("kimi", 1);
  tasks.accept("kimi", 2);
  const publish = bus.publish.bind(bus);
  bus.publish = (env) => { if (env.kind === "task" && (env.refs?.task === "1" || env.refs?.task === "2")) throw new Error("delivery journal unavailable"); return publish(env); };
  let moved;
  try {
    moved = await tasks.reassignForPause("kimi", undefined);
  } finally {
    bus.publish = publish;
  }
  // Both moves are saved and recorded; the relay did not stop at the first failure.
  expect(board.get(1)!.owner).toBe("local"); // local first for a paused peer
  expect(board.get(2)!.owner).toBe("local");
  expect(moved).toEqual([
    { id: 1, title: "#1 write docs", to: "local", role: "owner" },
    { id: 2, title: "#2 write tests", to: "local", role: "owner" },
  ]);
  expect(notices.filter((l) => l.includes("delivery is not confirmed") && l.includes("ahub task assign"))).toHaveLength(2);
  expect(notices.some((l) => l.includes("task #1 write docs") && l.includes("ahub task assign 1 local"))).toBe(true);
  expect(notices.some((l) => l.includes("task #2 write tests") && l.includes("ahub task assign 2 local"))).toBe(true);
  await tasks.assignTo(1, "local", USER);
  await tasks.assignTo(2, "local", USER);
  expect(peers.local!.got.filter((e) => e.kind === "task" && e.refs?.task === "1")).toHaveLength(1);
  expect(peers.local!.got.filter((e) => e.kind === "task" && e.refs?.task === "2")).toHaveLength(1);
});

test("an offline relay move whose assignment cannot publish is noticed as saved-but-unconfirmed (#297)", async () => {
  const { tasks, board, bus, peers, notices, told } = await setup();
  await tasks.propose("claude", { title: "write docs", class: "implement", owner: "kimi" });
  tasks.accept("kimi", 1);
  peers.kimi!.set("offline");
  const publish = bus.publish.bind(bus);
  bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === "1") throw new Error("delivery journal unavailable"); return publish(env); };
  let moved;
  try {
    moved = await tasks.releaseFromGone("kimi", 5);
  } finally {
    bus.publish = publish;
  }
  const owner = board.get(1)!.owner!;
  expect(owner).not.toBe("kimi");
  expect(notices.some((l) => l.includes("task #1 write docs") && l.includes("delivery is not confirmed") && l.includes(`ahub task assign 1 ${owner}`))).toBe(true);
  expect(notices.some((l) => l.includes("could not be released"))).toBe(false);
  // The move is fact for the relay too: it is recorded, and the gone owner is told to stop (#297).
  expect(moved).toEqual([{ id: 1, title: "#1 write docs", to: owner }]);
  expect(told.some((l) => l.startsWith("kimi|") && l.includes(`moved to ${owner}`) && l.includes("stop working on it"))).toBe(true);
});

test("a console that throws in assignOwner's pre-write notices no longer fails a review whose verdict is saved (#297)", async () => {
  const base = await setup(["claude", "kimi"]); // no codex: nobody to escalate to
  const tasks = new Tasks({ escalateAfter: PIN_TWO, board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (line) => {
    if (line.includes("no peer can take it")) throw new Error("console unavailable");
    base.notices.push(line);
  } });
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  await tasks.done("kimi", 1, "v");
  await tasks.review("claude", 1, "changes_requested", "too long");
  await tasks.done("kimi", 1, "v2");
  // The second rejection escalates; nobody can take it, and the pre-write notice's throw must not fail the call.
  await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1, owner: "kimi" });
  expect(base.board.get(1)!.rejections).toBe(2);
});

test("a move made while the assignment's brief is being read is supersession and returns the current task (#297, #424)", async () => {
  const base = await setup();
  await base.tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  base.tasks.accept("kimi", 1);
  await base.tasks.done("kimi", 1, "v");
  await base.tasks.review("claude", 1, "changes_requested", "too long");
  await base.tasks.done("kimi", 1, "v2");
  // The escalation writes owner codex; while sendTask reads the brief, a console assign moves the task to local
  // and that delivery succeeds. The post-brief guard prevents a stale codex publish;
  // the former owner's independent stop message must remain deliverable.
  const briefs = { forTask: async () => { base.board.update(1, "user", "reassigned", { owner: "local" }, "console assign during the brief"); return undefined; } };
  const tasks = new Tasks({ escalateAfter: PIN_TWO, board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (l) => base.notices.push(l), briefs: briefs as never, memory: new MemoryClient(base.mem.url) });
  const publish = base.bus.publish.bind(base.bus), attempted: string[] = [];
  base.bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === "1" && (env.to ?? []).includes("codex")) { attempted.push(env.body); throw new Error("delivery journal unavailable"); } return publish(env); };
  try { await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1 }); }
  finally { base.bus.publish = publish; }
  expect(attempted).toEqual([]);
  // The superseding move stands; no stale success notice or decision note survives,
  // but the former owner must still stop and learn the current owner.
  expect(base.board.get(1)!.owner).toBe("local");
  expect(base.notices.some((l) => l.includes("delivery is not confirmed"))).toBe(false);
  expect(base.notices.some((l) => l.includes("escalated from kimi"))).toBe(false);
  expect(base.peers.kimi!.got.some(env => env.body.includes("moved to local") && env.body.includes("Stop working on it."))).toBe(true);
  await tick();
  expect(base.saves().filter((save) => save.text.includes("escalated from kimi"))).toEqual([]);
});

test("an AssignmentUndeliveredError serializes without the task's title or detail (#297)", async () => {
  const { tasks, bus } = await setup();
  await tasks.propose("claude", { title: "summarize the SECRET-MARKER log", class: "summarize", owner: "kimi", detail: "SECRET-DETAIL-MARKER" });
  const publish = bus.publish.bind(bus);
  bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === "1") throw new Error("delivery journal unavailable"); return publish(env); };
  let caught: unknown;
  try {
    await tasks.assignTo(1, "codex", USER);
  } catch (e) {
    caught = e;
  } finally {
    bus.publish = publish;
  }
  expect(caught).toBeInstanceOf(AssignmentUndeliveredError);
  const printed = JSON.stringify(caught);
  expect(printed).not.toContain("SECRET-MARKER");
  expect(printed).not.toContain("SECRET-DETAIL-MARKER");
  // What the callers use is still there.
  const err = caught as AssignmentUndeliveredError;
  expect(err.task.owner).toBe("codex");
  expect(err.message).toContain("delivery is not confirmed");
});

test("a failure between the assignment write and the delivery is the one notice and the typed error, on the ready offer (#297)", async () => {
  const { tasks, board, notices } = await setup(["claude", "codex"]);
  const a = await tasks.propose("claude", { title: "schema", class: "implement" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  await tasks.done("codex", a.id, "done");
  // overlapHits reads the board after the assignment write; a failure there is the same delivery failure (#297).
  (tasks as never as Record<string, unknown>).overlapHits = () => { throw new Error("board read failed mid-delivery"); };
  await expect(tasks.review("claude", a.id, "approved")).resolves.toMatchObject({ state: "approved" });
  expect(board.get(c.id)!.owner).toBe("codex");
  expect(notices.filter((l) => l.includes("delivery is not confirmed") && l.includes(`ahub task assign ${c.id} codex`))).toHaveLength(1);
  expect(notices.some((l) => l.includes("could not be assigned"))).toBe(false);
});

test("a failure between the assignment write and the delivery on the offline relay records the move and tells the gone owner (#297)", async () => {
  const { tasks, board, notices, told, peers } = await setup();
  await tasks.propose("claude", { title: "write docs", class: "implement", owner: "kimi" });
  tasks.accept("kimi", 1);
  peers.kimi!.set("offline");
  (tasks as never as Record<string, unknown>).overlapHits = () => { throw new Error("board read failed mid-delivery"); };
  const moved = await tasks.releaseFromGone("kimi", 5);
  const owner = board.get(1)!.owner!;
  expect(owner).not.toBe("kimi");
  expect(moved).toEqual([{ id: 1, title: "#1 write docs", to: owner }]);
  expect(notices.filter((l) => l.includes("delivery is not confirmed"))).toHaveLength(1);
  expect(told.some((l) => l.startsWith("kimi|") && l.includes("stop working on it"))).toBe(true);
});

test("a review whose escalation hits a failure between the write and the delivery returns the saved task with the notice (#297)", async () => {
  const { tasks, board, notices } = await setup();
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 1);
  await tasks.done("kimi", 1, "v");
  await tasks.review("claude", 1, "changes_requested", "too long");
  await tasks.done("kimi", 1, "v2");
  (tasks as never as Record<string, unknown>).overlapHits = () => { throw new Error("board read failed mid-delivery"); };
  await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1, owner: "codex", state: "in_progress" });
  expect(board.get(1)!.owner).toBe("codex");
  expect(notices.filter((l) => l.includes("delivery is not confirmed") && l.includes("ahub task assign 1 codex"))).toHaveLength(1);
  expect(notices.some((l) => l.includes("escalated from kimi to codex"))).toBe(true); // the tail ran
});

test("a throwing console on the passed-over notice does not fail a decline after its write (#297)", async () => {
  const base = await setup();
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (line) => {
    if (line.includes("is passed over")) throw new Error("console unavailable");
    base.notices.push(line);
  } });
  const a = await tasks.propose("claude", { title: "schema", class: "implement", owner: "codex" });
  const c = await tasks.propose("claude", { title: "client", class: "implement", after: [a.id] });
  await tasks.assignTo(c.id, "kimi", USER); // reserved while it waits
  expect(base.board.get(c.id)!.reserved).toBe("kimi");
  base.peers.kimi!.set("offline");
  await tasks.done("codex", a.id, "done");
  await tasks.review("claude", a.id, "approved"); // the offer assigns local (routing's first), passing over the reserved, offline kimi
  expect(base.board.get(c.id)!.owner).toBe("local");
  await expect(tasks.decline("local", c.id, "busy")).resolves.toMatchObject({ id: c.id });
  const after = base.board.get(c.id)!;
  expect(after.history.some((h) => h.event === "declined")).toBe(true);
  expect(after.owner).not.toBe("local");
});

test("a same-owner reassign, accept, done or approval during the brief is supersession and returns the current task (#297, #424)", async () => {
  for (const meanwhile of ["reassigned-same-owner", "accepted", "done", "approved"] as const) {
    const base = await setup();
    await base.tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
    base.tasks.accept("kimi", 1);
    await base.tasks.done("kimi", 1, "v");
    await base.tasks.review("claude", 1, "changes_requested", "too long");
    await base.tasks.done("kimi", 1, "v2");
    const briefs = {
      forTask: async () => {
        if (meanwhile === "reassigned-same-owner") base.board.update(1, "user", "reassigned", { owner: "codex" }, "assigned again and delivered");
        else if (meanwhile === "accepted") base.board.update(1, "codex", "accepted", { state: "in_progress" }, "accepted meanwhile");
        else if (meanwhile === "done") {
          base.board.update(1, "codex", "accepted", { state: "in_progress" }, "accepted meanwhile");
          base.board.update(1, "codex", "done", { state: "in_review" }, "done meanwhile");
        } else base.board.update(1, "claude", "approved", { state: "approved" }, "approved meanwhile");
        return undefined;
      },
    };
    const tasks = new Tasks({ escalateAfter: PIN_TWO, board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (l) => base.notices.push(l), briefs: briefs as never });
    const publish = base.bus.publish.bind(base.bus);
    base.bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === "1") throw new Error("delivery journal unavailable"); return publish(env); };
    try { await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1 }); }
    finally { base.bus.publish = publish; }
    expect(base.notices.some((l) => l.includes("delivery is not confirmed"))).toBe(false);
    expect(base.notices.some((l) => l.includes("escalated from kimi"))).toBe(true);
  }
});

test("a reviewer-only change during the brief keeps owner delivery and refreshes reviewer content (#424)", async () => {
  const base = await setup();
  const task = await base.tasks.propose("claude", { title: "reviewer refresh", class: "implement", owner: "kimi" });
  const briefs = { forTask: async () => { base.board.update(task.id, HUB, "reviewer changed", { reviewer: "local" }, "reviewer update"); return undefined; } };
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (l) => base.notices.push(l), briefs: briefs as never });
  await tasks.assignTo(task.id, "codex");
  expect(base.peers.codex!.got.at(-1)!.body).toContain("reviewer local");
});

test("the hub's own bookkeeping during the brief is not supersession: the notice and the typed error stand (#297)", async () => {
  for (const meanwhile of ["check finished late", "reviewer changed"] as const) {
    const base = await setup();
    await base.tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
    base.tasks.accept("kimi", 1);
    await base.tasks.done("kimi", 1, "v");
    await base.tasks.review("claude", 1, "changes_requested", "too long");
    await base.tasks.done("kimi", 1, "v2");
    // The escalation writes owner codex; while sendTask reads the brief, the hub records an entry that moves
    // nothing (a late check result, a reviewer change); the envelope to codex then throws.
    const briefs = {
      forTask: async () => {
        if (meanwhile === "check finished late") base.board.update(1, HUB, "check finished late", {}, "check passed (late)");
        else base.board.update(1, HUB, "reviewer changed", { reviewer: "local" }, "reviewer paused for quota");
        return undefined;
      },
    };
    const tasks = new Tasks({ escalateAfter: PIN_TWO, board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: (l) => base.notices.push(l), briefs: briefs as never });
    const publish = base.bus.publish.bind(base.bus);
    base.bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === "1") throw new Error("delivery journal unavailable"); return publish(env); };
    try { await expect(tasks.review("claude", 1, "changes_requested", "still too long")).resolves.toMatchObject({ id: 1, owner: "codex" }); }
    finally { base.bus.publish = publish; }
    expect(base.notices.filter((l) => l.includes("delivery is not confirmed") && l.includes("ahub task assign 1 codex"))).toHaveLength(1);
    expect(base.notices.some((l) => l.includes("escalated from kimi to codex"))).toBe(true);
  }
});

test("a second rejection whose escalation lifts a silent cohort returns the saved task when every publish fails (#297)", async () => {
  const { tasks, bus, board, notices, state } = await turnFreeRig();
  const first = await tasks.propose("kimi", { title: "bus refactor", class: "implement", owner: "kimi", refs: { paths: ["src/hub/bus.ts"] }, plan: { symbols: ["Bus.publish"], signatures: ["publish(env: Envelope): PeerId[]"] } });
  const offered = await tasks.propose("claude", { title: "retry", class: "implement", owner: "codex" });
  tasks.accept("codex", offered.id, { paths: ["src/hub/retry.ts"], symbols: ["Bus.publish"] });
  await tasks.done("kimi", first.id, "v");
  await tasks.review("claude", first.id, "changes_requested", "too long");
  await tasks.done("kimi", first.id, "v2");
  // The escalation hands the task to codex, whose context path is no longer verified: formCohort lifts the silent
  // cohort, and announceLift's "silence is lifted" envelopes are the publishes that fail here. At 5dc9d74
  // formCohort sat outside the try, so this throw escaped as a plain error with the move saved (#297).
  expect(tasks.silentFor(first.id)).toBe(true);
  state.capable.delete("codex");
  let forming = false;
  const cohortFailures: { owner: string | null; body: string }[] = [];
  const internal = tasks as unknown as { formCohort: (...args: any[]) => void };
  const form = internal.formCohort.bind(tasks);
  internal.formCohort = (...args) => { forming = true; try { form(...args); } finally { forming = false; } };
  const publish = bus.publish.bind(bus);
  bus.publish = env => {
    if (forming) cohortFailures.push({ owner: board.get(first.id)!.owner, body: env.body });
    throw new Error("delivery journal unavailable");
  };
  try { await expect(tasks.review("claude", first.id, "changes_requested", "still too long")).resolves.toMatchObject({ id: first.id, owner: "codex" }); }
  finally { bus.publish = publish; internal.formCohort = form; }
  expect(cohortFailures).toHaveLength(1);
  expect(cohortFailures[0]!.owner).toBe("codex"); // the assignment write happened before the failing cohort publish
  expect(cohortFailures[0]!.body).toContain("turn-free silence is lifted");
  expect(board.get(first.id)!.owner).toBe("codex");
  expect(notices.some((l) => l.includes("no longer silent"))).toBe(true); // the lift is what published
  expect(notices.filter((l) => l.includes("delivery is not confirmed") && l.includes(`ahub task assign ${first.id} codex`))).toHaveLength(1);
});

test("propose, assignTo, decline and a manual escalation each print exactly one console notice and keep their error (#297)", async () => {
  const { tasks, bus, notices, board } = await setup();
  const undelivered = () => notices.filter((l) => l.includes("delivery is not confirmed")).length;
  const failing = (id: string) => {
    const p = bus.publish.bind(bus);
    bus.publish = (env) => { if (env.kind === "task" && env.refs?.task === id) throw new Error("delivery journal unavailable"); return p(env); };
    return () => { bus.publish = p; };
  };
  // Each caller gets the typed error, not a plain one with the same message (#297).
  const undeliveredError = async (p: Promise<unknown>) => {
    const e = await p.catch((caught) => caught);
    expect(e).toBeInstanceOf(AssignmentUndeliveredError);
    expect((e as Error).message).toContain("delivery journal unavailable");
  };
  let restore = failing("1");
  try { await undeliveredError(tasks.propose("claude", { title: "write docs", class: "implement" })); } finally { restore(); }
  expect(undelivered()).toBe(1);
  await tasks.propose("claude", { title: "write docs", class: "implement", owner: "kimi" });
  tasks.accept("kimi", 2);
  restore = failing("2");
  try { await undeliveredError(tasks.assignTo(2, "codex", USER)); } finally { restore(); }
  expect(undelivered()).toBe(2);
  await tasks.propose("claude", { title: "write notes", class: "summarize", owner: "kimi" });
  tasks.accept("kimi", 3);
  restore = failing("3");
  try { await undeliveredError(tasks.decline("kimi", 3, "busy")); } finally { restore(); }
  expect(undelivered()).toBe(3);
  const owner = board.get(3)!.owner!;
  restore = failing("3");
  try { await undeliveredError(tasks.escalate(USER, 3, "by hand")); } finally { restore(); }
  expect(undelivered()).toBe(4);
  expect(owner).not.toBe("kimi");
});


test("manual escalation preserves typed undelivered evidence across late checks and reviewer bookkeeping (#297)", async () => {
  for (const meanwhile of ["check finished late", "reviewer changed"] as const) {
    const base = await setup();
    await base.tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" });
    base.tasks.accept("kimi", 1);
    const briefs = { forTask: async () => {
      base.board.update(1, HUB, meanwhile, meanwhile === "reviewer changed" ? { reviewer: "local" } : {}, meanwhile === "reviewer changed" ? "reviewer paused for quota" : "check passed (late)");
      return undefined;
    } };
    const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: line => base.notices.push(line), briefs: briefs as never });
    const attempted: Envelope[] = [];
    const publish = base.bus.publish.bind(base.bus);
    base.bus.publish = env => {
      attempted.push(env);
      if (env.kind === "task" && env.refs?.task === "1") throw new Error("delivery journal unavailable");
      return publish(env);
    };
    let caught: unknown;
    try { await tasks.escalate(USER, 1, "by hand").catch(error => { caught = error; }); }
    finally { base.bus.publish = publish; }
    expect(caught).toBeInstanceOf(AssignmentUndeliveredError);
    expect((caught as AssignmentUndeliveredError).task).toMatchObject({ id: 1, owner: "codex" });
    expect((caught as AssignmentUndeliveredError).task.history.some(entry => entry.event === meanwhile)).toBe(true);
    expect(base.board.get(1)!.owner).toBe("codex");
    expect(base.notices.filter(line => line.includes("delivery is not confirmed"))).toHaveLength(1);
    expect(base.notices.some(line => line.includes("ahub task assign 1 codex"))).toBe(true);
    expect(base.notices.some(line => line.includes("escalated from kimi to codex"))).toBe(true);
    expect(attempted.some(env => env.to?.includes("kimi") && env.body.includes("Stop working on it."))).toBe(true);
  }
});

async function rosterTaskFixture(ids = ["claude", "codex", "kimi", "local"], wipLimit?: number) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-roster-tasks-")), off = new Set<string>();
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0, rostered: peer => !off.has(peer) });
  const peers = Object.fromEntries(ids.map(id => [id, new FakePeer(id)]));
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const notices: string[] = [];
  const tasks = new Tasks({ ...(wipLimit === undefined ? {} : { wipLimit: () => wipLimit! }), board, bus, cwd: dir, project: "roster", routing: () => loadRouting(dir), notify: line => notices.push(line) });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, off, board, bus, peers, notices, tasks };
}

test("Tasks health feeds the catalog roster to assignment and route explain, with Pi allowed by the legacy callback (#315)", async () => {
  const f = await rosterTaskFixture(["claude", "codex", "kimi", "local", "pi"]);
  const initial = await f.tasks.propose(USER, { title: "legacy Pi preference", class: "implement" });
  expect(initial.owner).toBe("pi"); // do not infer pi.enabled in Tasks, or make Pi unconditionally off
  f.off.add("pi"); f.off.add("local"); f.off.add("codex");
  const next = await f.tasks.propose(USER, { title: "roster filtered routing", class: "implement" });
  expect(next).toMatchObject({ owner: "kimi", reviewer: "claude" });
  for (const peer of ["pi", "local", "codex"]) expect(f.tasks.explain(next.id).join("\n")).toContain(`owner candidate ${peer}: skipped, off roster`);
});

test("manual assignment refuses off-roster peers before ordinary assignment or waiting reservation writes (#315)", async () => {
  const f = await rosterTaskFixture();
  const ordinary = await f.tasks.propose(USER, { title: "ordinary", class: "implement", owner: "codex" });
  const dependency = await f.tasks.propose(USER, { title: "dependency", class: "review", owner: "claude" });
  const waiting = await f.tasks.propose(USER, { title: "waiting", class: "implement", owner: "codex", after: [dependency.id] });
  f.off.add("kimi");
  const before = f.board.list();
  await expect(f.tasks.assignTo(ordinary.id, "kimi")).rejects.toThrow("kimi is off roster");
  await expect(f.tasks.assignTo(waiting.id, "kimi", USER, true)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.list()).toEqual(before); expect(f.board.get(waiting.id)).toMatchObject({ owner: null, reserved: "codex" });
});

test("roster removal offers proposed and in-progress work to another peer through the shared relay (#315)", async () => {
  const f = await rosterTaskFixture(undefined, 2);
  const offered = await f.tasks.propose(USER, { title: "offered work", class: "implement", owner: "codex" });
  const running = await f.tasks.propose(USER, { title: "running work", class: "implement", owner: "codex" });
  f.tasks.accept("codex", running.id);
  const heard = f.peers.codex!.got.length;
  f.off.add("codex");
  const moved = await f.tasks.reassignForRoster("codex");
  expect(moved).toEqual([{ id: offered.id, title: "#1 offered work", to: "local", role: "owner" }, { id: running.id, title: "#2 running work", to: "local", role: "owner" }]);
  for (const id of [offered.id, running.id]) {
    expect(f.board.get(id)).toMatchObject({ owner: "local", state: "proposed", reviewer: "claude" });
    expect(f.board.get(id)!.history.at(-1)).toMatchObject({ event: "reassigned", reason: "manual", note: "roster removal of codex" });
  }
  expect(f.peers.codex!.got).toHaveLength(heard); // stop/tail never bypasses Bus roster admission
  expect(f.notices.filter(line => line.includes("moved from codex to local (off roster)"))).toHaveLength(2);
  expect(f.tasks.accept("local", running.id)).toMatchObject({ owner: "local", state: "in_progress" });
});

for (const state of ["proposed", "in_progress"] as const) test(`roster removal with no candidate retains the old owner and ${state} row exactly (#315)`, async () => {
  const f = await rosterTaskFixture(["codex"]);
  const task = await f.tasks.propose(USER, { title: "no replacement", class: "implement", owner: "codex" });
  if (state === "in_progress") f.tasks.accept("codex", task.id);
  const before = f.board.get(task.id)!; f.off.add("codex");
  expect(await f.tasks.reassignForRoster("codex")).toEqual([]);
  expect(f.board.get(task.id)).toEqual(before);
  expect(f.notices.at(-1)).toContain(`it stays with codex in ${state}`);
  expect(f.notices.at(-1)).toContain(`ahub task assign ${task.id} <peer>`);
});

test("roster removal with no on-prem candidate keeps PII work and only emits its public title (#315)", async () => {
  const f = await rosterTaskFixture();
  const task = await f.tasks.propose(USER, { title: PII, class: "implement", owner: "local" }); f.tasks.accept("local", task.id);
  const before = f.board.get(task.id)!; f.off.add("local"); const noticesBefore = f.notices.length;
  expect(await f.tasks.reassignForRoster("local")).toEqual([]); expect(f.board.get(task.id)).toEqual(before);
  const notices = f.notices.slice(noticesBefore).join("\n");
  expect(notices).toContain("[pii]"); expect(notices).not.toContain(PII); expect(notices).not.toContain("900101");
});

test("roster removal replaces an in-review reviewer and preserves it if nobody else can review (#315)", async () => {
  const f = await rosterTaskFixture();
  const task = await f.tasks.propose(USER, { title: "ready for review", class: "implement", owner: "kimi" }); f.tasks.accept("kimi", task.id); await f.tasks.done("kimi", task.id, "recorded completion");
  expect(f.board.get(task.id)).toMatchObject({ state: "in_review", reviewer: "claude" });
  f.off.add("claude");
  expect(await f.tasks.reassignForRoster("claude")).toEqual([{ id: task.id, title: "#1 ready for review", to: "codex", role: "reviewer" }]);
  expect(f.board.get(task.id)).toMatchObject({ owner: "kimi", state: "in_review", reviewer: "codex" });
  expect(f.peers.codex!.got.at(-1)!.body).toContain("recorded completion"); expect(f.peers.codex!.got.at(-1)!.body).toContain("is off roster");
  f.off.add("codex"); const before = f.board.get(task.id)!;
  expect(await f.tasks.reassignForRoster("codex")).toEqual([]); expect(f.board.get(task.id)).toEqual(before);
  expect(f.notices.at(-1)).toContain(`the reviewer stays codex; use ahub review ${task.id}`);
});

test("a roster relay's saved assignment failure remains typed, noticed once, and does not stop later moves (#315)", async () => {
  const f = await rosterTaskFixture(undefined, 2);
  const first = await f.tasks.propose(USER, { title: "first relay", class: "implement", owner: "kimi" });
  const second = await f.tasks.propose(USER, { title: "second relay", class: "implement", owner: "kimi" }); f.tasks.accept("kimi", first.id);
  f.off.add("kimi");
  const original = f.bus.publish.bind(f.bus), errors: unknown[] = [];
  const internal = f.tasks as unknown as { assignOwner(task: unknown, by: string, options: Record<string, unknown>): Promise<unknown> };
  const assignOwner = internal.assignOwner.bind(f.tasks);
  internal.assignOwner = async (task, by, options) => { try { return await assignOwner(task, by, options); } catch (error) { errors.push(error); throw error; } };
  f.bus.publish = env => { if (env.kind === "task" && env.to?.includes("local")) throw new Error("assignment transport failed"); return original(env); };
  try {
    expect((await f.tasks.reassignForRoster("kimi")).map(move => move.id)).toEqual([first.id, second.id]);
  } finally { f.bus.publish = original; }
  expect(errors).toHaveLength(2);
  for (const error of errors) {
    expect(error).toBeInstanceOf(AssignmentUndeliveredError);
    if (!(error instanceof AssignmentUndeliveredError)) throw new Error("expected saved assignment error");
    expect(error.task).toMatchObject({ owner: "local", state: "proposed" });
  }
  for (const id of [first.id, second.id]) expect(f.notices.filter(line => line.includes(`task #${id}`) && line.includes("assignment's delivery is not confirmed"))).toHaveLength(1);
  expect(f.notices.filter(line => line.includes("moved from kimi to local (off roster)"))).toHaveLength(2);
});

test("the shared budget relay retains its existing no-candidate unassignment behavior (#315)", async () => {
  const f = await rosterTaskFixture(["codex"]);
  const task = await f.tasks.propose(USER, { title: "budget fallback", class: "implement", owner: "codex" }); f.tasks.accept("codex", task.id); f.bus.pause("codex");
  expect(await f.tasks.reassignForPause("codex", undefined)).toEqual([{ id: task.id, title: "#1 budget fallback", to: null, role: "owner" }]);
  expect(f.board.get(task.id)).toMatchObject({ owner: null, state: "proposed" });
  expect(f.board.get(task.id)!.history.map(entry => entry.event)).toEqual(expect.arrayContaining(["released", "unassigned"]));
});

test("a roster reviewer change stays saved when publishing its review request fails (#315)", async () => {
  const f = await rosterTaskFixture();
  const task = await f.tasks.propose(USER, { title: "review request failure", class: "implement", owner: "kimi" }); f.tasks.accept("kimi", task.id); await f.tasks.done("kimi", task.id, "completion is saved");
  f.off.add("claude");
  const publish = f.bus.publish.bind(f.bus);
  f.bus.publish = env => { if (env.kind === "review") throw new Error("review transport failed"); return publish(env); };
  try { await expect(f.tasks.reassignForRoster("claude")).resolves.toEqual([{ id: task.id, title: "#1 review request failure", to: "codex", role: "reviewer" }]); }
  finally { f.bus.publish = publish; }
  expect(f.board.get(task.id)).toMatchObject({ owner: "kimi", state: "in_review", reviewer: "codex" });
  expect(f.notices.filter(line => line.includes("could not send the review request to codex") && line.includes("review transport failed"))).toHaveLength(1);
});

test("the shared budget relay keeps its existing reviewer-clear and quota notice behavior (#315)", async () => {
  const f = await rosterTaskFixture(["claude", "codex", "kimi"]);
  const task = await f.tasks.propose(USER, { title: "budget review fallback", class: "implement", owner: "kimi" }); f.tasks.accept("kimi", task.id); await f.tasks.done("kimi", task.id, "done");
  f.bus.pause("claude"); f.bus.pause("codex");
  expect(await f.tasks.reassignForPause("claude", undefined)).toEqual([{ id: task.id, title: "#1 budget review fallback", to: null, role: "reviewer" }]);
  expect(f.board.get(task.id)).toMatchObject({ owner: "kimi", state: "in_review", reviewer: null });
  expect(f.notices.at(-1)).toBe(`task #1 budget review fallback: its reviewer claude is paused and nobody else can review; use ahub review ${task.id}`);
});

test("removal hands over an in-review owner's work while preserving an irreplaceable reviewer request and verdict (#315)", async () => {
  const f = await rosterTaskFixture();
  const task = await f.tasks.propose(USER, { title: "in review removal", class: "implement", owner: "kimi" });
  f.tasks.accept("kimi", task.id); await f.tasks.done("kimi", task.id, "completion before removal");
  expect(f.board.get(task.id)!.state).toBe("in_review"); f.off.add("kimi");
  expect(await f.tasks.reassignForRoster("kimi")).toContainEqual({ id: task.id, title: "#1 in review removal", role: "owner", to: "local" });
  expect(f.board.get(task.id)).toMatchObject({ owner: "local", state: "in_review" });
  const ownership = f.peers.local!.got.find(env => env.refs?.task === String(task.id))!;
  expect(ownership.body).toContain("already under review");
  expect(ownership.body).toContain(`hub_task_show {id: ${task.id}}`);
  expect(ownership.body).not.toContain("Take it with hub_task_accept");

  const only = await rosterTaskFixture(["codex", "claude"]);
  const retained = await only.tasks.propose(USER, { title: "review request retained", class: "implement", owner: "codex" });
  only.tasks.accept("codex", retained.id); only.off.add("claude"); await only.tasks.reassignForRoster("claude");
  await only.tasks.done("codex", retained.id, "completion for removed reviewer");
  expect(only.board.get(retained.id)).toMatchObject({ state: "in_review", reviewer: "claude" });
  const pending = only.bus.queueList("claude").flatMap(row => row.originals);
  expect(pending.filter(env => env.kind === "review" && env.refs?.task === String(retained.id))).toHaveLength(1);
  only.off.delete("claude"); only.bus.rosterChanged("claude");
  await Promise.resolve(); await Promise.resolve();
  expect(only.peers.claude!.got.filter(env => env.id === pending[0]!.id)).toHaveLength(1);

  only.off.add("codex"); await only.tasks.review("claude", retained.id, "changes_requested", "fix the completion");
  expect(only.bus.queueList("codex").flatMap(row => row.originals).some(env => env.body.includes("fix the completion"))).toBe(true);
});

class PullTaskPeer extends FakePeer { readonly pullOnly = true; }
async function pullTaskFixture(sweep = false, wipLimit?: number) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pull-tasks-")), off = new Set<string>(), notices: string[] = [];
  const bus = new Bus({ batchMs: 0, rostered: peer => !off.has(peer) });
  const peers = { claude: new FakePeer("claude"), codex: new FakePeer("codex"), kimi: new PullTaskPeer("kimi") };
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const routing = loadRouting(dir);
  routing.classes.implement!.peers = ["kimi", "codex"]; routing.classes.implement!.escalate_to = ["kimi"];
  routing.classes.review!.peers = ["kimi", "claude"];
  const roles: Record<string, string[]> = { claude: ["planner", "reviewer", "conductor"], codex: ["implementer"], kimi: ["implementer", "reviewer"] };
  let board = new Board(join(dir, "hub.db"));
  const makeTasks = () => new Tasks({ ...(wipLimit === undefined ? {} : { wipLimit: () => wipLimit! }), board, bus, routing: () => routing, cwd: dir, project: "pull", roles, ...(sweep ? { sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, auto_reassign: true, unaccepted_min: 1, ladder_min: 1 } } : {}), notify: line => notices.push(line) });
  let tasks = makeTasks();
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, off, bus, peers, routing, roles, notices, get board() { return board; }, get tasks() { return tasks; }, reopen() { board.close(); board = new Board(join(dir, "hub.db")); tasks = makeTasks(); } };
}

test("Tasks routes past pull-only peers but explicit proposer, own claim and assign targets take queued work (#316)", async () => {
  const f = await pullTaskFixture(undefined, 2);
  const automatic = await f.tasks.propose(USER, { title: "automatic implementation", class: "implement" });
  expect(automatic).toMatchObject({ owner: "codex", reviewer: "claude" });
  expect(f.tasks.explain(automatic.id).join("\n")).toContain("owner candidate kimi: skipped, pull-only");
  const named = await f.tasks.propose("claude", { title: "named watched work", class: "implement", owner: "kimi" });
  expect(named).toMatchObject({ owner: "kimi", state: "proposed" }); expect(f.peers.kimi.got).toEqual([]);
  const read = f.bus.pull("kimi")!; expect(read.filter(env => env.kind === "task" && env.refs?.task === String(named.id))).toHaveLength(1);
  f.tasks.accept("kimi", named.id); expect(f.board.get(named.id)!.state).toBe("in_progress");
  const claimed = await f.tasks.propose("kimi", { title: "own watched claim", class: "implement", owner: "kimi" });
  expect(claimed).toMatchObject({ owner: "kimi", state: "in_progress" });
  expect(f.bus.pull("kimi")!.some(env => env.kind === "task" && env.refs?.task === String(claimed.id))).toBe(false);
  const reassigned = await f.tasks.assignTo(automatic.id, "kimi", USER, true);
  expect(reassigned.owner).toBe("kimi"); expect(f.bus.pull("kimi")!.filter(env => env.kind === "task" && env.refs?.task === String(automatic.id))).toHaveLength(1);
});

test("persisted explicit pull-only reservations survive dependency completion and automatic candidate overrides do not name them (#316)", async () => {
  const f = await pullTaskFixture(undefined, 2);
  const prerequisite = await f.tasks.propose(USER, { title: "prerequisite", class: "review", owner: "codex" });
  const waiting = await f.tasks.propose("claude", { title: "reserved watched work", class: "implement", owner: "kimi", after: [prerequisite.id] });
  expect(waiting).toMatchObject({ owner: null, reserved: "kimi", state: "proposed" });
  f.reopen();
  expect(f.board.get(waiting.id)!.reserved).toBe("kimi");
  f.tasks.accept("codex", prerequisite.id); await f.tasks.done("codex", prerequisite.id, "ready");
  expect(f.board.get(waiting.id)!.owner).toBe("kimi");
  const offered = f.bus.pull("kimi")!; expect(offered.filter(env => env.kind === "task" && env.refs?.task === String(waiting.id))).toHaveLength(1);
  f.tasks.accept("kimi", waiting.id);
  await f.tasks.decline("kimi", waiting.id, "cannot do it");
  expect(f.board.get(waiting.id)!.owner).toBe("codex");
  const predecessor = await f.tasks.propose(USER, { title: "manual reservation prerequisite", class: "review", owner: "codex" });
  const later = await f.tasks.propose(USER, { title: "manual watched reservation", class: "implement", after: [predecessor.id] });
  expect((await f.tasks.assignTo(later.id, "kimi", USER, true)).reserved).toBe("kimi");
  f.reopen(); f.tasks.accept("codex", predecessor.id); await f.tasks.done("codex", predecessor.id, "ready too");
  expect(f.board.get(later.id)!.owner).toBe("kimi");
});

for (const move of ["escalate", "gone", "budget", "roster"] as const) test(`automatic ${move} singleton candidates never nominate pull-only work (#316)`, async () => {
  const f = await pullTaskFixture();
  const original = await f.tasks.propose(USER, { title: `automatic ${move}`, class: "implement", owner: "codex" });
  f.tasks.accept("codex", original.id); f.routing.classes.implement!.peers = ["kimi"];
  if (move === "escalate") await f.tasks.escalate(USER, original.id);
  else if (move === "gone") { f.peers.codex.set("offline"); await f.tasks.releaseFromGone("codex", 30); }
  else if (move === "budget") { f.bus.pause("codex"); await f.tasks.reassignForPause("codex", undefined); }
  else { f.off.add("codex"); await f.tasks.reassignForRoster("codex"); }
  expect(f.board.get(original.id)!.owner).toBe(move === "budget" ? null : "codex");
  expect(f.bus.queueList("kimi")).toEqual([]); expect(f.peers.kimi.got).toEqual([]);
});

for (const actor of [USER, "claude"]) test(`named pull-only reviewer assigned by ${actor} keeps owner/state and reads one queued review (#316)`, async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose(USER, { title: "explicit watched review", class: "implement", owner: "codex" });
  f.tasks.accept("codex", task.id); await f.tasks.done("codex", task.id, "completion evidence", { commit: "abc" });
  const before = f.board.get(task.id)!;
  const named = await f.tasks.assignTo(task.id, "kimi", actor, true, "reviewer");
  expect(named).toMatchObject({ owner: "codex", state: "in_review", reviewer: "kimi", refs: before.refs });
  expect(named.history.slice(0, -1)).toEqual(before.history); expect(named.history.at(-1)).toMatchObject({ event: "reviewer changed", by: actor });
  expect(f.peers.kimi.got).toEqual([]);
  const read = f.bus.pull("kimi")!; expect(read.filter(env => env.kind === "review" && env.refs?.task === String(task.id))).toHaveLength(1);
  expect(read.find(env => env.kind === "review")!.body).toContain("completion evidence"); expect(f.bus.pull("kimi")).toEqual([]);
});

test("reviewer naming refuses proposer and invalid targets before any board write (#316)", async () => {
  const f = await pullTaskFixture(undefined, 2);
  const task = await f.tasks.propose("kimi", { title: "proposer cannot choose reviewer", class: "implement", owner: "codex" });
  for (const request of [
    { actor: "kimi", peer: "kimi", role: "reviewer" },
    { actor: USER, peer: "codex", role: "reviewer" },
    { actor: USER, peer: "missing", role: "reviewer" },
    { actor: USER, peer: "kimi", role: "invalid" },
  ]) {
    const before = f.board.get(task.id)!;
    await expect(f.tasks.assignTo(task.id, request.peer, request.actor, true, request.role as "reviewer")).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.get(task.id)).toEqual(before);
  }
  f.off.add("kimi");
  await expect(f.tasks.assignTo(task.id, "kimi", USER, true, "reviewer")).rejects.toThrow("off roster");
  f.off.delete("kimi"); f.bus.pause("kimi");
  await expect(f.tasks.assignTo(task.id, "kimi", USER, true, "reviewer")).rejects.toThrow("paused");
  f.bus.resume("kimi");
  const pii = f.board.propose(USER, { title: PII, class: "implement", signals: ["pii"], refs: {} });
  await expect(f.tasks.assignTo(pii.id, "kimi", USER, true, "reviewer")).rejects.toThrow("pii");
  const review = await f.tasks.propose(USER, { title: "no second reviewer", class: "review", owner: "codex" });
  await expect(f.tasks.assignTo(review.id, "kimi", USER, true, "reviewer")).rejects.toThrow("cannot name");
  f.tasks.accept("codex", review.id); await f.tasks.done("codex", review.id);
  await expect(f.tasks.assignTo(review.id, "kimi", USER, true, "reviewer")).rejects.toThrow("can no longer change");
});

test("a named review request publication failure retains the saved reviewer and one guarded notice (#316)", async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose(USER, { title: "saved reviewer", class: "implement", owner: "codex" });
  f.tasks.accept("codex", task.id); await f.tasks.done("codex", task.id, "review this result");
  const publish = f.bus.publish.bind(f.bus); let calls = 0;
  f.bus.publish = env => { if (env.kind === "review" && env.to?.includes("kimi")) { calls++; throw new Error("review storage unavailable"); } return publish(env); };
  try { expect((await f.tasks.assignTo(task.id, "kimi", USER, true, "reviewer")).reviewer).toBe("kimi"); }
  finally { f.bus.publish = publish; }
  expect(calls).toBe(1); expect(f.board.get(task.id)).toMatchObject({ owner: "codex", state: "in_review", reviewer: "kimi" });
  expect(f.notices.filter(line => line.includes("could not send the review request to kimi"))).toHaveLength(1);
});


test("an automatic idle sweep never names its only pull-only replacement (#316)", async () => {
  const f = await pullTaskFixture(true);
  const task = await f.tasks.propose(USER, { title: "watched singleton sweep", class: "implement", owner: "codex" });
  f.routing.classes.implement!.peers = ["kimi"];
  const at = task.history.at(-1)!.at + 60_000;
  for (let step = 0; step < 3; step++) await f.tasks.sweep(at + step * 60_000);
  expect(f.board.get(task.id)!.owner).toBe("codex");
  expect(f.board.get(task.id)!.history.filter(entry => entry.event === "idle sweep")).toHaveLength(3);
  expect(f.notices.some(line => line.includes("Owner reassignment suggestion: no eligible peer"))).toBe(true);
  expect(f.bus.queueList("kimi")).toEqual([]);
});

test("reviewer nomination while dependencies remain refuses before writes or requests and succeeds after approval (#316)", async () => {
  const f = await pullTaskFixture();
  const prerequisite = await f.tasks.propose(USER, { title: "reviewer nomination prerequisite", class: "review", owner: "codex" });
  const waiting = await f.tasks.propose(USER, { title: "reviewer nomination waits", class: "implement", owner: "codex", after: [prerequisite.id] });
  const before = f.board.get(waiting.id)!, queued = f.bus.queueList("kimi");
  for (const actor of [USER, "claude"]) {
    await expect(f.tasks.assignTo(waiting.id, "kimi", actor, true, "reviewer")).rejects.toThrow(`waits for #${prerequisite.id}`);
    expect(f.board.get(waiting.id)).toEqual(before);
    expect(f.bus.queueList("kimi")).toEqual(queued);
    expect(f.peers.kimi.got).toEqual([]);
  }
  f.tasks.accept("codex", prerequisite.id); await f.tasks.done("codex", prerequisite.id, "prerequisite approved");
  expect(f.board.get(prerequisite.id)!.state).toBe("approved");
  const ready = f.board.get(waiting.id)!;
  expect((await f.tasks.assignTo(waiting.id, "kimi", USER, true, "reviewer"))).toMatchObject({ reviewer: "kimi", owner: ready.owner, state: ready.state });
  expect(f.bus.queueList("kimi")).toEqual(queued); // reviewer nomination alone sends no request before done
  f.tasks.accept("codex", waiting.id); await f.tasks.done("codex", waiting.id, "now ready for review");
  const requests = f.bus.pull("kimi")!.filter(env => env.kind === "review" && env.refs?.task === String(waiting.id));
  expect(requests).toHaveLength(1); expect(requests[0]!.body).toContain("now ready for review");
});

test("Tasks reviewer nomination requires the actor's current unique conductor role, not its proposer or reviewer role (#316)", async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose("claude", { title: "reviewer authority", class: "implement", owner: "codex" });
  f.roles.claude = ["planner", "reviewer"];
  const before = f.board.get(task.id)!;
  await expect(f.tasks.assignTo(task.id, "kimi", "claude", true, "reviewer")).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.get(task.id)).toEqual(before); expect(f.bus.queueList("kimi")).toEqual([]);
  f.roles.claude = ["planner", "reviewer", "conductor"];
  const named = await f.tasks.assignTo(task.id, "kimi", "claude", true, "reviewer");
  expect(named).toMatchObject({ owner: before.owner, state: before.state, reviewer: "kimi" });
  expect(named.history.at(-1)).toMatchObject({ by: "claude", event: "reviewer changed" });
});

test("a named reviewer change withdraws its unread request without a replacement notice (#316, #424)", async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose(USER, { title: "review reassigned", class: "implement", owner: "codex" });
  f.tasks.accept("codex", task.id); await f.tasks.done("codex", task.id, "ready");
  await f.tasks.assignTo(task.id, "kimi", USER, true, "reviewer");
  expect(f.bus.snapshot(false).queues.kimi!.filter(env => env.kind === "review")).toHaveLength(1);
  const changed = await f.tasks.assignTo(task.id, "claude", USER, true, "reviewer");
  expect(changed).toMatchObject({ reviewer: "claude", owner: "codex", state: "in_review" });
  const read = f.bus.pull("kimi") ?? [];
  expect(read.filter(env => env.kind === "review")).toEqual([]);
  expect(read.filter(env => env.kind === "status")).toEqual([]);
  await expect(f.tasks.review("kimi", task.id, "approved")).rejects.toThrow("reviewer");
});

// issue #264 (phase 3): the dashboard's warning links are task and peer ids only, from the board's own overlap
// test and the live cohorts; PII tasks never join a link.
test("dashboard links: overlap and cohort rows carry task and peer ids only", async () => {
  const { tasks } = await setup(["claude", "codex", "kimi"], undefined, undefined, 3);
  const first = await tasks.propose("kimi", { title: "one part", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const second = await tasks.propose("codex", { title: "other part", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  expect(tasks.overlapLinks()).toEqual([{ tasks: [first.id, second.id], peers: ["codex", "kimi"] }]);
  expect(tasks.cohortLinks()).toEqual([{ tasks: [first.id, second.id], peers: ["codex", "kimi"] }]);
  // A lone task has no link, and an approved task drops out of both.
  await tasks.propose("kimi", { title: "solo", class: "implement", owner: "kimi", refs: { paths: ["src/b.ts"] } });
  expect(tasks.overlapLinks()).toHaveLength(1);
  // A PII task never joins a link, whatever its refs say.
  const pii = await tasks.propose("kimi", { title: "secret 900101-1234567", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  expect(tasks.isPii(pii)).toBe(true);
  for (const links of [tasks.overlapLinks(), tasks.cohortLinks()]) {
    expect(JSON.stringify(links)).not.toContain("900101-1234567");
    expect(links.flatMap((link) => link.tasks)).not.toContain(pii.id);
  }
});


test("dashboard cohort links revalidate tasks that become private after cohort creation (#264 merge)", async () => {
  const { tasks, board } = await setup(["claude", "codex", "kimi"]);
  const first = await tasks.propose("kimi", { title: "one part", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  await tasks.propose("codex", { title: "other part", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
  expect(tasks.cohortLinks()).toHaveLength(1);
  board.update(first.id, "hub", "screened", { signals: [...first.signals, "pii_path"] });
  expect(tasks.cohortLinks()).toEqual([]);expect(tasks.overlapLinks()).toEqual([]);
});

test("task memory bookkeeping does not discard a passing completion check",async()=>{
 const {tasks,board,release}=await checked({code:0,timedOut:false,tail:"pass"});const task=await tasks.propose("codex",{title:"quiet memory check",class:"implement",owner:"codex"});await tasks.done("codex",task.id,"done");await tasks.remember(USER,{text:"task memo",task:task.id});release();await until(()=>!tasks.isChecking(task.id));expect(board.get(task.id)?.state).toBe("in_review");expect(board.get(task.id)?.history.some(entry=>entry.event==="check finished late")).toBe(false);
});
test("task memory bookkeeping retains dependent readiness after recovery",async()=>{
 const {tasks,board}=await setup();const parent=await tasks.propose("claude",{title:"dependency",class:"implement"}),child=await tasks.propose("claude",{title:"dependent",class:"implement",after:[parent.id]});await tasks.done(board.get(parent.id)!.owner!,parent.id,"done");board.update(parent.id,HUB,"approved",{state:"approved"});await tasks.remember(USER,{text:"dependent memo",task:child.id});await tasks.releaseReady();expect(board.get(child.id)?.owner).not.toBeNull();
});

test("board expected flow revision refuses stale writes synchronously (#424)", () => {
  const board = new Board(join(mkdtempSync(join(tmpdir(), "agenthub-board-revision-")), "hub.db"));
  const task = board.propose(USER, { title: "revision", class: "implement" });
  expect(() => board.update(task.id, USER, "assigned", { owner: "codex" }, undefined, {}, task.history.length + 1)).toThrow("flow revision changed");
  expect(board.get(task.id)).toMatchObject({ owner: null, history: task.history });
  expect(board.update(task.id, USER, "assigned", { owner: "codex" }, undefined, {}, task.history.length).owner).toBe("codex");
  board.close();
});

test("checked assignment and person unassignment preserve authority and suppress automatic offers (#424)", async () => {
  const { tasks, board, peers } = await setup();
  const task = await tasks.propose("claude", { title: "manual roles", class: "implement", owner: "codex" });
  const before = board.get(task.id)!;
  await expect(tasks.assignTo(task.id, "kimi", USER, true, "owner", before.history.length + 1)).rejects.toThrow("flow revision changed");
  expect(board.get(task.id)).toEqual(before);
  expect(peers.kimi!.got).toEqual([]);
  const removed = await tasks.unassign(task.id, USER, true, "owner", before.history.length);
  expect(removed).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  expect(removed.history.at(-1)).toMatchObject({ by: USER, event: "unassigned", owner: null });
  expect(() => tasks.accept("codex", task.id)).toThrow(/only its owner/);
  board.update(task.id, HUB, "ready", {});
  await tasks.releaseReady();
  expect(board.get(task.id)!.owner).toBeNull();
  expect((await tasks.assignTo(task.id, "kimi")).owner).toBe("kimi");
});

test("person-unassigned planner work stays unassigned across release and restart until explicit assignment (#424)", async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose("claude", { title: "planned removal", class: "implement", backlog: true });
  await f.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "pull planned work" });
  expect(f.board.get(task.id)!.reserved).toBe("codex");
  await f.tasks.unassign(task.id);
  await f.tasks.releaseReady();
  expect(f.board.get(task.id)).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  f.reopen();
  await f.tasks.releaseReady();
  expect(f.board.get(task.id)).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  expect((await f.tasks.assignTo(task.id, "codex")).owner).toBe("codex");
});

test("owner and reviewer unassignment withdraw only their queued requests and reject former agents (#424)", async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose(USER, { title: "watched owner removal", class: "implement", owner: "kimi" });
  expect(f.bus.snapshot(false).queues.kimi!.some(env => env.kind === "task" && env.refs?.task === String(task.id))).toBe(true);
  await f.tasks.unassign(task.id);
  const ownerRead = f.bus.pull("kimi") ?? [];
  expect(ownerRead.filter(env => env.kind === "task" && env.refs?.task === String(task.id))).toEqual([]);
  expect(ownerRead.some(env => env.kind === "task" && env.body.includes("no longer assigned"))).toBe(false);
  expect(() => f.tasks.accept("kimi", task.id)).toThrow(/only its owner/);

  const review = await f.tasks.propose(USER, { title: "watched reviewer removal", class: "implement", owner: "codex" });
  f.tasks.accept("codex", review.id);
  await f.tasks.done("codex", review.id, "ready");
  await f.tasks.assignTo(review.id, "kimi", USER, true, "reviewer");
  await f.tasks.unassign(review.id, USER, true, "reviewer");
  const reviewerRead = f.bus.pull("kimi") ?? [];
  expect(reviewerRead.filter(env => env.kind === "review" && env.refs?.task === String(review.id))).toEqual([]);
  expect(reviewerRead.some(env => env.kind === "task" && env.body.includes("is withdrawn"))).toBe(false);
  await expect(f.tasks.review("kimi", review.id, "approved")).rejects.toThrow(/reviewer/);
});

test("unassignment covers the state matrix and retains the PII human reviewer (#424)", async () => {
  const { tasks, board } = await setup();
  const make = (state: string) => {
    const task = board.propose(USER, { title: state, class: "implement", ...(state === "backlog" ? { backlog: true } : {}) });
    if (state === "backlog") return task;
    if (state === "proposed") return board.update(task.id, USER, "assigned", { owner: "codex", reviewer: "claude" });
    board.update(task.id, "codex", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
    if (state === "in_progress") return board.get(task.id)!;
    board.update(task.id, "codex", "done", { state: "in_review" });
    if (state === "in_review") return board.get(task.id)!;
    if (state === "changes_requested") return board.update(task.id, "claude", "changes_requested", { state: "changes_requested" });
    return board.update(task.id, "claude", "approved", { state: "approved" });
  };
  for (const state of ["proposed", "in_progress", "changes_requested"]) {
    const task = make(state);
    expect((await tasks.unassign(task.id)).state).toBe("proposed");
    expect(board.get(task.id)).toMatchObject({ owner: null, reserved: null });
    await expect(tasks.unassign(task.id)).rejects.toThrow(/no owner or owner reservation/);
  }
  const reviewing = make("in_review");
  await expect(tasks.unassign(reviewing.id)).rejects.toThrow(/owner cannot be unassigned/);
  expect((await tasks.unassign(reviewing.id, USER, true, "reviewer")).state).toBe("in_review");
  const approved = make("approved");
  for (const role of ["owner", "reviewer"] as const) await expect(tasks.unassign(approved.id, USER, true, role)).rejects.toThrow(/historical/);
  const backlog = make("backlog");
  await expect(tasks.unassign(backlog.id)).rejects.toThrow(/backlog/);
  const pii = board.propose(USER, { title: PII, class: "implement", signals: ["pii"] });
  board.update(pii.id, USER, "assigned", { owner: "local", reviewer: USER });
  await expect(tasks.unassign(pii.id, USER, true, "reviewer")).rejects.toThrow(/human reviewer is required/);
});

test("dependency approval does not re-offer person-unassigned work through releaseDependents (#424)", async () => {
  const { tasks, board, peers } = await setup();
  const parent = await tasks.propose("claude", { title: "dependency", class: "implement" });
  const child = await tasks.propose("claude", { title: "unassigned dependent", class: "implement", owner: "codex", after: [parent.id] });
  await tasks.unassign(child.id);
  await tasks.done(board.get(parent.id)!.owner!, parent.id, "done");
  await tasks.review(board.get(parent.id)!.reviewer!, parent.id, "approved");
  await tick();
  expect(board.get(child.id)).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  expect(Object.values(peers).flatMap(peer => peer.got).filter(env => env.refs?.task === String(child.id))).toEqual([]);
});

test("person unassignment blocks planner undo and re-pull (#424)", async () => {
  const f = await pullTaskFixture();
  const task = await f.tasks.propose("claude", { title: "undo reservation", class: "implement", backlog: true });
  const pulled = await f.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "initial pull" });
  await f.tasks.unassign(task.id);
  await expect(f.tasks.undoPlanning("claude", task.id, pulled.planningRevision!)).rejects.toThrow("planning undo is stale or not owned");
  await expect(f.tasks.pullPlanned("claude", { id: task.id, revision: pulled.planningRevision!, reason: "re-pull" })).rejects.toThrow("planner pull changed");
  await f.tasks.releaseReady();
  expect(f.board.get(task.id)).toMatchObject({ owner: null, reserved: null, state: "proposed" });
});

test("stale unassign has no side effects, live and reserved owners clear together, and absent replay stays absent (#424)", async () => {
  const { tasks, board, peers } = await setup();
  const task = await tasks.propose("claude", { title: "revision and reservations", class: "implement", owner: "codex" });
  board.update(task.id, USER, "reserved", { reserved: "kimi" });
  const before = board.get(task.id)!, deliveries = Object.values(peers).flatMap(peer => peer.got).length;
  await expect(tasks.unassign(task.id, USER, true, "owner", before.history.length + 1)).rejects.toThrow("flow revision changed");
  expect(board.get(task.id)).toEqual(before);
  expect(Object.values(peers).flatMap(peer => peer.got)).toHaveLength(deliveries);
  const removed = await tasks.unassign(task.id, USER, true, "owner", before.history.length);
  expect(removed).toMatchObject({ owner: null, reserved: null, state: "proposed" });
  const history = removed.history.length, delivered = Object.values(peers).flatMap(peer => peer.got).length;
  await expect(tasks.unassign(task.id)).rejects.toThrow(/no owner or owner reservation/);
  expect(board.get(task.id)!.history).toHaveLength(history);
  expect(Object.values(peers).flatMap(peer => peer.got)).toHaveLength(delivered);
});

test("a superseded relay assignment does not abort later tasks (#424)", async () => {
  const base = await setup();
  const first = await base.tasks.propose("claude", { title: "first relay", class: "implement", owner: "codex" });
  const second = await base.tasks.propose("claude", { title: "second relay", class: "implement", owner: "codex" });
  let superseded = false;
  const briefs = { forTask: async (_owner: string, task: any) => {
    if (!superseded && task.id === first.id) {
      superseded = true;
      base.board.update(first.id, "codex", "accepted", { state: "in_progress" }, "accepted during relay brief");
    }
    return undefined;
  } };
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: line => base.notices.push(line), briefs: briefs as never });
  await expect(tasks.reassignForPause("codex", undefined)).resolves.toHaveLength(2);
  expect(base.board.get(second.id)!.owner).not.toBe("codex");
});

test("a delivered former owner is notified of unassignment (#424)", async () => {
  const { tasks, peers } = await setup();
  const task = await tasks.propose("claude", { title: "delivered owner", class: "implement", owner: "codex" });
  await tasks.unassign(task.id);
  expect(peers.codex!.got.some(env => env.kind === "task" && env.body.includes("no longer assigned"))).toBe(true);
});

test("a self-claimed owner is notified of unassignment without an assignment envelope (#424)", async () => {
  const { tasks, peers, bus } = await setup(["codex"]);
  const task = await tasks.propose("codex", { title: "self claimed owner", class: "implement", owner: "codex" });
  expect(task.state).toBe("in_progress");
  expect(bus.lastDeliveredTo("codex").filter(env => env.refs?.task === String(task.id))).toEqual([]);
  await tasks.unassign(task.id);
  await until(() => peers.codex!.got.some(env => env.kind === "task" && env.body.includes("no longer assigned")));
});

test("unread reassigned owner does not inherit another peer's in-progress acceptance evidence (#424)", async () => {
  const { tasks, peers, bus, board } = await setup();
  const task = await tasks.propose(USER, { title: "accepted by codex, unread by kimi", class: "implement", owner: "codex" });
  tasks.accept("codex", task.id);
  peers.kimi!.set("busy");
  const assigned = await tasks.assignTo(task.id, "kimi");
  expect(assigned.state).toBe("in_progress");
  expect(assigned.history.some(entry => entry.event === "accepted" && entry.by === "kimi")).toBe(false);
  expect(bus.snapshot(false).queues.kimi!.some(env => env.kind === "task" && env.refs?.task === String(task.id))).toBe(true);
  await tasks.unassign(task.id);
  expect(board.get(task.id)!.owner).toBeNull();
  expect((bus.snapshot(false).queues.kimi ?? []).filter(env => env.refs?.task === String(task.id))).toEqual([]);
  peers.kimi!.set("idle");
  expect(peers.kimi!.got.some(env => env.refs?.task === String(task.id))).toBe(false);
});

test("unread reassigned owner does not reuse its acceptance before the latest assignment (#424)", async () => {
  const { tasks, peers, bus, board, dir } = await setup();
  const task = await tasks.propose(USER, { title: "old kimi acceptance, new unread assignment", class: "implement", owner: "kimi" });
  tasks.accept("kimi", task.id);
  await tasks.assignTo(task.id, "codex");
  // A release returns work to proposed; its earlier owner acceptance stays in history.
  board.update(task.id, HUB, "released", { state: "proposed" }, "synthetic release before a new assignment");
  peers.kimi!.set("busy"); peers.kimi!.got = [];
  const assigned = await tasks.assignTo(task.id, "kimi");
  expect(assigned.state).toBe("proposed");
  expect(assigned.history.some(entry => entry.event === "accepted" && entry.by === "kimi")).toBe(true);
  expect(bus.snapshot(false).queues.kimi!.some(env => env.kind === "task" && env.refs?.task === String(task.id))).toBe(true);
  // Simulate the prior delivery evidence disappearing at restart; the only current request is unread.
  const fresh = new Bus({ batchMs: 0 }), current = new FakePeer("kimi");
  fresh.add(current); await current.start(); current.set("busy");
  cleanup.push(() => fresh.closeJournal());
  for (const env of bus.snapshot(false).queues.kimi ?? []) if (env.kind === "task" && env.refs?.task === String(task.id)) fresh.publish(env);
  const restarted = new Tasks({ board, bus: fresh, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {} });
  await restarted.unassign(task.id);
  expect((fresh.snapshot(false).queues.kimi ?? []).filter(env => env.refs?.task === String(task.id))).toEqual([]);
  current.set("idle");
  expect(current.got).toEqual([]);
});

test("an accepted owner is notified of unassignment after a restart without delivery evidence (#424)", async () => {
  const base = await setup(["codex"]);
  const task = await base.tasks.propose(USER, { title: "accepted before restart", class: "implement", owner: "codex" });
  base.tasks.accept("codex", task.id);
  const bus = new Bus({ batchMs: 0 }), peer = new FakePeer("codex");
  bus.add(peer); await peer.start();
  cleanup.push(() => bus.closeJournal());
  const tasks = new Tasks({ board: base.board, bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: () => {} });
  await tasks.unassign(task.id);
  await until(() => peer.got.some(env => env.kind === "task" && env.body.includes("no longer assigned")));
});

test("an accepted owner is notified of unassignment after its terminal delivery row is pruned (#424)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-withdrawal-pruning-"));
  const board = new Board(join(dir, "hub.db"));
  const durable = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "project", instanceId: "pruning" });
  const bus = new Bus({ journal: durable, batchMs: 0 }), peer = new FakePeer("codex");
  bus.add(peer); await peer.start();
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = board.propose(USER, { title: "pruned owner", class: "implement" });
  board.update(task.id, USER, "assigned", { owner: "codex" });
  board.update(task.id, "codex", "accepted", { state: "in_progress" });
  const original = newEnvelope(HUB, `Task #${task.id} [implement] pruned owner`, { to: ["codex"], kind: "task", refs: { task: String(task.id) } });
  durable.createDelivery({ id: "original", peer: "codex", state: "completed", createdAt: 1, updatedAt: 1, originals: [original], out: [original] });
  for (let i = 0; i < 2048; i++) durable.createDelivery({ id: `filler-${i}`, peer: "codex", state: "completed", createdAt: i + 2, updatedAt: i + 2, originals: [], out: [] });
  expect(durable.list("codex").some(row => row.id === "original")).toBe(false);
  await tasks.unassign(task.id);
  await until(() => peer.got.some(env => env.kind === "task" && env.body.includes("no longer assigned")));
});

test("a person reassignment suppresses a superseded budget relay result (#424)", async () => {
  const base = await setup();
  const task = await base.tasks.propose("claude", { title: "budget supersession", class: "implement", owner: "codex" });
  const briefs = { forTask: async () => { base.board.update(task.id, USER, "reassigned", { owner: "kimi" }, "person moved during budget relay"); return undefined; } };
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: line => base.notices.push(line), briefs: briefs as never });
  await expect(tasks.reassignForPause("codex", undefined)).resolves.toEqual([]);
  expect(base.board.get(task.id)!.owner).toBe("kimi");
});

test("a person reassignment suppresses an offline relay result but still tells the former owner to stop (#424)", async () => {
  const base = await setup();
  const task = await base.tasks.propose("claude", { title: "offline supersession", class: "implement", owner: "codex" });
  base.peers.codex!.set("offline");
  const told: string[] = [];
  const briefs = { forTask: async () => { base.board.update(task.id, USER, "reassigned", { owner: "kimi" }, "person moved during offline relay"); return undefined; } };
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: line => base.notices.push(line), briefs: briefs as never, tell: (peer, line) => told.push(`${peer}|${line}`) });
  await expect(tasks.releaseFromGone("codex", 30)).resolves.toEqual([]);
  expect(base.board.get(task.id)!.owner).toBe("kimi");
  expect(told).toContain(`codex|note from hub [decision]: task #${task.id} moved to kimi while you were offline; stop working on it`);
});

test("owner unassignment leaves a turn-free cohort (#424)", async () => {
  const ctx = await turnFreeRig();
  const { first, second } = await pair(ctx.tasks);
  expect(ctx.tasks.cohorts.of(first.id)).toBeDefined();
  await ctx.tasks.unassign(first.id);
  expect(ctx.tasks.cohorts.of(first.id)).toBeUndefined();
  expect(ctx.tasks.cohorts.of(second.id)?.members.has(first.id)).toBe(false);
});

test("owner unassignment refuses the proposer and records USER authority (#424)", async () => {
  const { tasks, board } = await setup();
  const task = await tasks.propose("kimi", { title: "proposer authority", class: "implement", owner: "kimi" });
  const before = board.get(task.id)!;
  await expect(tasks.unassign(task.id, "kimi", true)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(board.get(task.id)).toEqual(before);
  const removed = await tasks.unassign(task.id);
  expect(removed.history.at(-1)).toMatchObject({ by: USER, event: "unassigned" });
});

test("owner unassignment fences an in-flight completion check (#424)", async () => {
  const { tasks, board, peers, release } = await checked({ code: 0, timedOut: false, tail: "pass" });
  const task = await tasks.propose("codex", { title: "unassign during check", class: "implement", owner: "codex" });
  await tasks.done("codex", task.id, "done");
  expect(tasks.isChecking(task.id)).toBe(true);
  await tasks.unassign(task.id);
  release();
  await until(() => board.get(task.id)!.history.some(entry => entry.event === "check finished late"));
  expect(board.get(task.id)).toMatchObject({ owner: null, state: "proposed" });
  expect(peers.claude!.got.some(env => env.kind === "review" && env.refs?.task === String(task.id))).toBe(false);
});


test("#418 Tasks applies capability refusal to proposal, manual assignment, decline reroute and explain", async () => {
  const f = await setup(["pi", "codex", "claude"], undefined, {
    pi: { tests: false, spec: false, testsReason: "runner unavailable", specReason: "gh unavailable" },
    codex: { tests: true, spec: true }, claude: { tests: true, spec: true },
  });
  const task = await f.tasks.propose(USER, { title: "Implement #418", class: "implement" });
  expect(task.owner).toBe("codex");
  expect(f.tasks.explain(task.id).join("\n")).toContain("missing tests: runner unavailable");
  await expect(f.tasks.assignTo(task.id, "pi", USER)).rejects.toThrow();
  expect(f.board.get(task.id)?.owner).toBe("codex");
  await f.tasks.decline("codex", task.id, "cannot continue");
  expect(f.board.get(task.id)?.owner).not.toBe("pi");
});


test("#418 PII proposal and manual assignment retain local-only work without runner or spec capability", async () => {
  for (const cls of ["implement", "test", "bulk_edit"] as const) {
    const f = await setup(["local", "codex"], undefined, { local: { tests: false, spec: false }, codex: { tests: true, spec: true } });
    const proposed = await f.tasks.propose(USER, { title: `${PII} #418`, class: cls });
    expect(proposed).toMatchObject({ owner: "local", reviewer: "user" });
    const staged = f.board.propose(USER, { title: `${PII} #418 manual`, class: cls, signals: ["pii"] });
    await expect(f.tasks.assignTo(staged.id, "local", USER)).resolves.toMatchObject({ owner: "local", reviewer: "user" });
  }
});

test("escalation withdrawal is still needed by the former owner until approval (#434 follow-up)", async () => {
  const base = await setup(["codex", "kimi", "claude"]);
  const task = await base.tasks.propose(USER, { title: "withdrawal contract", class: "implement", owner: "codex" });
  const published: Envelope[] = [], publish = base.bus.publish.bind(base.bus);
  base.bus.publish = envelope => { published.push(envelope); return publish(envelope); };
  await base.tasks.escalate(USER, task.id, "manual handoff");
  const withdrawal = published.find(envelope => envelope.to?.includes("codex") && envelope.body.includes("Stop working on it."))!;
  expect(withdrawal).toBeDefined();
  expect(withdrawal.refs?.taskRecipient).not.toBe("owner");
  expect(supersededDeliveryReason([withdrawal], base.board, "codex")).toBeUndefined();
  base.board.update(task.id, USER, "accepted", { state: "in_progress" });
  base.board.update(task.id, USER, "approved", { state: "approved" });
  expect(supersededDeliveryReason([withdrawal], base.board, "codex")).toBe(`superseded: task #${task.id} approved`);
});
for (const role of ["owner", "reviewer"] as const) test(`#434 former ${role} withdrawal stays held while open and settles only after approval`, async () => {
  const base = await setup(["codex", "kimi", "claude"]);
  const task = await base.tasks.propose(USER, { title: "former role withdrawal", class: "implement", owner: "codex" });
  base.tasks.accept("codex", task.id);
  if (role === "reviewer") {
    await base.tasks.done("codex", task.id, "ready");
    await until(() => base.peers.claude!.got.some(env => env.kind === "review" && env.refs?.task === String(task.id)));
  }
  const former = role === "owner" ? "codex" : "claude";
  const published: Envelope[] = [], publish = base.bus.publish.bind(base.bus);
  base.bus.publish = env => { published.push(env); return publish(env); };
  await base.tasks.assignTo(task.id, "kimi", USER, true, role);
  const withdrawal = published.find(env => env.to?.includes(former) && env.body.includes(role === "owner" ? "no longer assigned" : "is withdrawn"))!;
  expect(withdrawal).toBeDefined(); expect(withdrawal.refs?.taskRecipient).toBeUndefined();
  expect(supersededDeliveryReason([withdrawal], base.board, former)).toBeUndefined();
  if (role === "owner") base.board.update(task.id, "kimi", "accepted", { state: "in_progress" });
  base.board.update(task.id, USER, "approved", { state: "approved" });
  expect(supersededDeliveryReason([withdrawal], base.board, former)).toBe(`superseded: task #${task.id} approved`);
});
test("#434 public route explanation lists all held peers once and screens appended hold lines", async () => {
  const base = await setup(["codex", "claude"]);
  const tasks = new Tasks({ board: base.board, bus: base.bus, routing: () => loadRouting(base.dir), cwd: base.dir, project: "agent-hub", notify: () => {},
    held: () => ({ codex: "needs_review selected-hold", detached: "needs_review detached-hold", private: PII }) });
  const task = await tasks.propose(USER, { title: "hold listing", class: "implement", owner: "codex" });
  const explanation = tasks.publicExplain(task.id).join("\n");
  expect(explanation.split("\n").filter(line => line.includes("selected-hold"))).toHaveLength(1);
  expect(explanation).toContain("detached queue: needs_review detached-hold");
  expect(explanation).not.toContain("900101"); expect(explanation).toContain("[routing explanation withheld: it matches a PII pattern]");
});

test("#146 explicit backlog and dependency reservations refuse missing capabilities before a row exists", async () => {
  const caps = { pi: { tests: false, spec: true }, local: { tests: true, spec: false } };
  const f = await setup(["pi", "local"], undefined, caps);
  const dependency = f.board.propose(USER, { title: "dependency", class: "implement" });
  for (const owner of ["pi", "local"]) for (const backlog of [true, false]) {
    const before = f.board.list();
    await expect(f.tasks.propose(USER, { title: "reserved work", detail: "STAIxBWLB/agent-hub#418", class: "implement", owner, ...(backlog ? { backlog: true } : { after: [dependency.id] }) })).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.list()).toEqual(before);
  }
});

test("#146 backlog reservation patches refuse missing capabilities without history or revision writes", async () => {
  const f = await setup(["pi", "local"], undefined, { pi: { tests: false, spec: true }, local: { tests: true, spec: false } });
  const task = f.board.propose(USER, { title: "backlog work", detail: "https://github.com/STAIxBWLB/agent-hub/issues/418", class: "implement", backlog: true });
  for (const peer of ["pi", "local"]) {
    const before = f.board.get(task.id);
    await expect(f.tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { reserved: peer }, reason: "reserve work" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.get(task.id)).toEqual(before);
  }
});

test("#146 PII local reservations retain capability exemption on proposals and backlog patches", async () => {
  const f = await setup(["local"], undefined, { local: { tests: false, spec: false } });
  const dependency = f.board.propose(USER, { title: "dependency", class: "implement" });
  for (const backlog of [true, false]) {
    const task = await f.tasks.propose(USER, { title: `${PII} #418`, class: "implement", owner: "local", ...(backlog ? { backlog: true } : { after: [dependency.id] }) });
    expect(task).toMatchObject({ owner: null, reserved: "local" });
  }
  const task = f.board.propose(USER, { title: `${PII} #418`, class: "implement", signals: ["pii"], backlog: true });
  expect(await f.tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { reserved: "local" }, reason: "reserve on premise" })).toMatchObject({ reserved: "local" });
});

test("#146 reservation admission rechecks capabilities after awaited proposal and planning privacy screens", async () => {
  const f = await setup(["pi"]), caps = { pi: { tests: true, spec: true } }, routing = loadRouting(f.dir);
  routing.signals.pii_screen = "local";
  const tasks = new Tasks({ board: f.board, bus: f.bus, routing: () => routing, cwd: f.dir, project: "agent-hub", repository: "STAIxBWLB/agent-hub", capabilities: () => caps,
    piiScreen: async () => { caps.pi.tests = false; return { label: "clear", ms: 1 }; }, notify: () => {}, share: () => {}, tell: () => {} });
  const before = f.board.list();
  await expect(tasks.propose(USER, { title: "work", class: "implement", owner: "pi", backlog: true })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.list()).toEqual(before);
  caps.pi.tests = true;
  const task = f.board.propose(USER, { title: "backlog", class: "implement", backlog: true });
  const saved = f.board.get(task.id);
  await expect(tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { reserved: "pi" }, reason: "reserve work" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.get(task.id)).toEqual(saved);
});

test("#146 capability admission keeps eligible offline reservations and same-value person planning", async () => {
  const f = await setup(["pi"], undefined, { pi: { tests: true, spec: true } });
  f.peers.pi!.set("offline");
  const task = await f.tasks.propose(USER, { title: "reserved #418", class: "implement", owner: "pi", backlog: true });
  expect(task).toMatchObject({ reserved: "pi", owner: null });
  expect(await f.tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { reserved: "pi" }, reason: "retain reservation" })).toMatchObject({ reserved: "pi" });
});

test("start reconciliation preserves migrated legacy settlements without authoring generation rows (#432)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-migrated-settle-")), home = join(dir, "home"), project = "synthetic/migration";
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  let store: MemoryStore | undefined;
  try {
    const task = board.propose(USER, { title: "approved before migration", class: "implement" });
    board.update(task.id, "codex", "accepted", { owner: "codex", state: "in_progress" });
    board.update(task.id, "codex", "done", { state: "approved" });
    const key = taskKey(project, task);
    const old = new MemoryStore({ home, deferPromotions: true });
    old.note({ op: "note", project, scope: "project", tier: "short", kind: "finding", peer: "codex", source: "hub", task: key,
      text: "finding settled by the legacy hub", about: [`task:${key}`] });
    old.settle(key, "claude"); old.close();
    await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: "c".repeat(32), authorizedPerson: true, tty: true });
    store = new MemoryStore({ home, deferPromotions: true });
    const authored = () => Object.fromEntries(["log", "local"].flatMap(folder => readdirSync(join(store!.dir, folder))
      .filter(name => name.endsWith(".jsonl")).map(name => [`${folder}/${name}`, readFileSync(join(store!.dir, folder, name), "utf8")])));
    const before = authored();
    const tasks = new Tasks({ board, bus, cwd: dir, project, routing: () => loadRouting(dir), notify: () => {}, store: { store, project, repo: project } });
    expect(store.hasTask(key)).toBe(true);
    expect(store.settled(key)).toBe(false);
    expect(store.settled(key, { includeLegacy: true })).toBe(true);
    expect(tasks.reconcileMemory()).toBe(0);
    expect(tasks.reconcileMemory()).toBe(0);
    expect(authored()).toEqual(before);
    expect(store.settled(key)).toBe(false);
  } finally {
    store?.close(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("by default the third consecutive changes_requested escalates, the second keeps the owner (#488)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-escalate3-"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "local"]) { const p = new FakePeer(id); bus.add(p); await p.start(); }
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {} });
  expect(ESCALATE_AFTER).toBe(3);
  await tasks.propose("claude", { title: "fix the parser", class: "implement" });
  tasks.accept("local", 1);
  for (const [n, note] of [[1, "edge case"], [2, "still wrong"]] as const) {
    await tasks.done("local", 1, `v${n}`);
    expect(await tasks.review("claude", 1, "changes_requested", note)).toMatchObject({ owner: "local", rejections: n });
  }
  await tasks.done("local", 1, "v3");
  const third = await tasks.review("claude", 1, "changes_requested", "third time");
  await tick();
  expect(third).toMatchObject({ owner: "codex", rejections: 0 });
  expect(board.get(1)!.history.map((h) => h.event)).toContain("escalated");
  board.close();
});

test("tasks.escalate_after is read at each verdict, so a live change applies to the next one (#488)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-escalate-live-"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "local"]) { const p = new FakePeer(id); bus.add(p); await p.start(); }
  const board = new Board(join(dir, "hub.db"));
  let after = 5;
  const tasks = new Tasks({ escalateAfter: () => after, board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {} });
  await tasks.propose("claude", { title: "fix the parser", class: "implement" });
  tasks.accept("local", 1);
  await tasks.done("local", 1, "v1");
  expect(await tasks.review("claude", 1, "changes_requested", "one")).toMatchObject({ owner: "local", rejections: 1 });
  after = 2; // a live reload lowers the threshold before the next verdict
  await tasks.done("local", 1, "v2");
  const moved = await tasks.review("claude", 1, "changes_requested", "two");
  await tick();
  expect(moved).toMatchObject({ owner: "codex", rejections: 0 });
  board.close();
});

// issue #655: readiness never puts a reserved owner over its planner WIP cap.
test("dependents reserved for an owner at its WIP cap stay ready with the reason; a freed slot offers the next by priority (#655)", async () => {
  const { tasks, board, peers, notices } = await setup(["claude", "codex"], undefined, undefined, 2);
  const root = board.propose("claude", { title: "root", class: "implement" });
  board.update(root.id, "codex", "accepted", { owner: "codex", state: "in_progress" }); // one open task for codex (limit 2)
  const first = await tasks.propose("claude", { title: "gate task", class: "implement", owner: "claude" });
  const mk = async (title: string) => tasks.propose("claude", { title, class: "implement", owner: "codex", after: [first.id] });
  const low = await mk("low"), high = await mk("high"), mid = await mk("mid");
  board.plan(low.id, "user", { priority: 3 }, 0, "p3");
  board.plan(high.id, "user", { priority: 0 }, 0, "p0");
  board.plan(mid.id, "user", { priority: 1 }, 0, "p1");
  for (const t of [low, high, mid]) expect(board.get(t.id)).toMatchObject({ owner: null, reserved: "codex", state: "proposed" });
  await tasks.done("claude", first.id, "done");
  await tasks.review(board.get(first.id)!.reviewer!, first.id, "approved");
  await tick();
  // one slot: only the P0 dependent is assigned; the other two stay ready in To Do with the reservation and the reason
  expect(board.get(high.id)).toMatchObject({ owner: "codex", state: "proposed" });
  for (const t of [low, mid]) {
    const row = board.get(t.id)!;
    expect(row).toMatchObject({ owner: null, reserved: "codex", state: "proposed" });
    expect(row.history.map((h) => h.event)).toEqual(expect.arrayContaining(["ready", "ready held"]));
    expect(row.history.findLast((h) => h.event === "ready held")!.note).toContain("codex");
    expect(row.history.findLast((h) => h.event === "ready held")!.note).toContain("WIP");
    expect(peers.codex!.got.some((e) => e.kind === "task" && e.refs?.task === String(t.id))).toBe(false);
  }
  expect(notices.join("\n")).not.toContain("planner WIP capacity for codex");
  // a repeated sweep adds no second held entry
  await tasks.releaseReady();
  expect(board.get(mid.id)!.history.filter((h) => h.event === "ready held")).toHaveLength(1);
  // freeing a slot (root approved) offers the next by priority, never over the cap
  board.update(root.id, "codex", "approved", { state: "approved" });
  await tasks.releaseReady();
  expect(board.get(mid.id)!.owner).toBe("codex");
  expect(board.get(low.id)!.owner).toBeNull();
  board.update(high.id, "codex", "accepted", { state: "in_progress" });
  board.update(high.id, "codex", "done", { state: "in_review" });
  board.update(high.id, "claude", "approved", { state: "approved" });
  await tasks.releaseReady();
  expect(board.get(low.id)!.owner).toBe("codex");
});

test("a cancelled owner task frees its slot for the next held ready task (#655)", async () => {
  const { tasks, board } = await setup(["claude", "codex"], undefined, undefined, 1);
  const gate = await tasks.propose("claude", { title: "gate", class: "implement", owner: "claude" });
  const held = await tasks.propose("claude", { title: "held", class: "implement", owner: "codex", after: [gate.id] });
  const busy = board.propose("claude", { title: "busy", class: "implement" });
  board.update(busy.id, "codex", "accepted", { owner: "codex", state: "in_progress" });
  await tasks.done("claude", gate.id, "done");
  await tasks.review(board.get(gate.id)!.reviewer!, gate.id, "approved");
  await tick();
  expect(board.get(held.id)).toMatchObject({ owner: null, reserved: "codex" });
  await tasks.cancel(busy.id, USER, { reason: "not needed" });
  await tick();
  expect(board.get(held.id)!.owner).toBe("codex");
});

test("a planner priority edit does not release held ready work; a freed slot still offers it (#655)", async () => {
  const { tasks, board } = await setup(["claude", "codex"], undefined, undefined, 1);
  const gate = await tasks.propose("claude", { title: "gate", class: "implement", owner: "claude" });
  const held = await tasks.propose("claude", { title: "held", class: "implement", owner: "codex", after: [gate.id] });
  const busy = board.propose("claude", { title: "busy", class: "implement" });
  board.update(busy.id, "codex", "accepted", { owner: "codex", state: "in_progress" });
  await tasks.done("claude", gate.id, "done");
  await tasks.review(board.get(gate.id)!.reviewer!, gate.id, "approved");
  await tick();
  expect(board.get(held.id)!.history.at(-1)!.event).toBe("ready held");
  board.plan(held.id, "user", { priority: 1 }, 0, "bump");
  expect(board.get(held.id)!.owner).toBeNull();
  await tasks.cancel(busy.id, USER, { reason: "not needed" });
  await tick();
  expect(board.get(held.id)!.owner).toBe("codex");
});

test("the release timer offers a held task after a planner edit when its slot freed outside Tasks (#655)", async () => {
  const { tasks, board } = await setup(["claude", "codex"], undefined, undefined, 1);
  const gate = await tasks.propose("claude", { title: "gate", class: "implement", owner: "claude" });
  const held = await tasks.propose("claude", { title: "held", class: "implement", owner: "codex", after: [gate.id] });
  const busy = board.propose("claude", { title: "busy", class: "implement" });
  board.update(busy.id, "codex", "accepted", { owner: "codex", state: "in_progress" });
  await tasks.done("claude", gate.id, "done");
  await tasks.review(board.get(gate.id)!.reviewer!, gate.id, "approved");
  await tick();
  board.plan(held.id, "user", { priority: 1 }, 0, "bump");
  expect(board.get(held.id)!.history.at(-1)!.event).toBe("planned");
  await tasks.releaseReady();
  expect(board.get(held.id)!.owner).toBeNull(); // still no slot
  board.update(busy.id, "codex", "done", { state: "approved" }); // slot freed outside Tasks
  await tasks.releaseReady();
  expect(board.get(held.id)!.owner).toBe("codex");
});

test("two ready offers for one reserved owner with one slot assign exactly one while assignment yields (#655)", async () => {
  const { tasks, board } = await setup(["claude", "codex"], undefined, undefined, 1);
  const gate = await tasks.propose("claude", { title: "gate", class: "implement", owner: "claude" });
  const a = await tasks.propose("claude", { title: "a", class: "implement", owner: "codex", after: [gate.id] });
  const b = await tasks.propose("claude", { title: "b", class: "implement", owner: "codex", after: [gate.id] });
  // Approve the gate outside Tasks so the offers below are the only release path.
  board.update(gate.id, "claude", "accepted", { owner: "claude", state: "in_progress" });
  board.update(gate.id, "claude", "approved", { state: "approved" });
  const real = (tasks as any).assignOwner.bind(tasks);
  let release!: () => void;
  const gateOpen = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  (tasks as any).assignOwner = async (...args: unknown[]) => { calls++; await gateOpen; return real(...args); }; // a deferred admission
  const offers = [(tasks as any).offerReady(board.get(a.id)!, "test"), (tasks as any).offerReady(board.get(b.id)!, "test")];
  await tick();
  expect(calls).toBe(1); // the second saw the first's slot and was held before it reached assignment
  release();
  await Promise.all(offers);
  const owned = [a, b].filter((t) => board.get(t.id)!.owner === "codex");
  expect(owned).toHaveLength(1);
  const other = board.get([a, b].find((t) => board.get(t.id)!.owner === null)!.id)!;
  expect(other.history.at(-1)!.event).toBe("ready held");
  expect(other.reserved).toBe("codex");
});

test("normalized symbol overlap: Tasks.offerReady matches offerReady(), and A.run does not match B.run (#682 phase 1b)", async () => {
  const { tasks } = await setup();
  await tasks.propose("kimi", {
    title: "task 1", class: "implement", owner: "kimi",
    plan: { paths: ["src/a.ts"], symbols: ["Tasks.offerReady"] },
  });
  const offered = await tasks.propose("claude", { title: "task 2", class: "implement", owner: "codex" });
  await tick();
  // Tasks.offerReady matches offerReady():
  const accepted = tasks.accept("codex", offered.id, {
    paths: ["src/b.ts"], symbols: ["offerReady()"],
  });
  expect(tasks.overlaps(accepted)).toContain("Overlaps #1 (owner kimi) on symbol offerReady");

  // Qualified A.run vs B.run do not match:
  const r2 = await setup();
  const t3 = await r2.tasks.propose("kimi", {
    title: "task 3", class: "implement", owner: "kimi",
    plan: { paths: ["src/c.ts"], symbols: ["A.run"] },
  });
  const t4 = await r2.tasks.propose("claude", { title: "task 4", class: "implement", owner: "codex" });
  const acc4 = r2.tasks.accept("codex", t4.id, {
    paths: ["src/d.ts"], symbols: ["B.run"],
  });
  expect(r2.tasks.overlaps(acc4)).toBe("");
});
