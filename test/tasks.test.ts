import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, type Envelope, type PeerState } from "../src/hub/envelope.ts";
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
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", memory, briefs: new Briefs(memory, "agent-hub"), notify: (l) => notices.push(l) });
  const saves = () => mem.calls.filter((c) => c.path === "/api/memory/save").map((c) => c.body as any);
  return { dir, bus, peers, board, tasks, notices, mem, saves };
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
  expect(assign(task("implement"), all, routing)).toMatchObject({ owner: "codex", reviewer: "claude" });
  expect(assign(task("implement"), { ...all, codex: "busy" }, routing).owner).toBe("kimi");
  expect(assign(task("implement"), { codex: "busy", claude: "idle" }, routing).owner).toBe("codex"); // busy beats nobody
  expect(assign(task("implement"), { ...all, codex: "paused", kimi: "offline" }, routing).owner).toBe("local");
  expect(assign(task("implement"), all, routing, { exclude: ["codex", "kimi"] }).owner).toBe("local");
  expect(assign(task("implement"), all, routing, { candidates: ["kimi"] }).owner).toBe("kimi");
  expect(assign(task("implement"), all, routing, { candidates: ["ghost"] }).owner).toBeUndefined();
  expect(assign(task("review"), all, routing)).toMatchObject({ owner: "claude" });
  expect(assign(task("plan"), all, routing, { candidates: ["local"] }).owner).toBeUndefined(); // local_allowed = false
  expect(assign(task("bulk_edit", ["long_context"]), all, routing).owner).toBe("kimi");
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
  expect(t).toMatchObject({ owner: "codex", reviewer: "claude", state: "proposed" });
  const offer = peers.codex!.got.at(-1)!;
  expect(offer).toMatchObject({ from: HUB, kind: "task", priority: "important", refs: { task: "1" } });
  expect(offer.body).toContain("Task #1 [implement] add --json to ahub status");
  expect(peers.kimi!.got).toHaveLength(0);

  expect(() => tasks.accept("kimi", 1)).toThrow(/only its owner \(codex\)/);
  tasks.accept("codex", 1);
  await expect(tasks.review("claude", 1, "approved")).rejects.toThrow(/cannot move/);
  await tasks.done("codex", 1, "flag added, tests pass", { commit: "abc123" });
  await tick();
  const ask = peers.claude!.got.at(-1)!;
  expect(ask.kind).toBe("review");
  expect(ask.body).toContain("commit abc123");
  await expect(tasks.review("codex", 1, "approved")).rejects.toThrow(/only its reviewer/);
  await tasks.review("claude", 1, "approved", "clean");
  await tick();
  expect(board.get(1)!.state).toBe("approved");
  expect(peers.codex!.got.at(-1)!.body).toContain("approved by claude");
  // notes: done and the verdict, not proposed or accepted
  expect(saves().map((s) => s.metadata.kind)).toEqual(["finding", "decision"]);
  expect(saves()[0].metadata).toMatchObject({ peer: "codex", task: 1 });
});

test("changes_requested twice escalates to the next attached peer in escalate_to, with the review notes", async () => {
  const { tasks, peers, board, notices } = await setup();
  await tasks.propose("claude", { title: "fix the parser", class: "implement" });
  tasks.accept("codex", 1);
  await tasks.done("codex", 1, "v1");
  const once = await tasks.review("claude", 1, "changes_requested", "edge case missing");
  expect(once).toMatchObject({ state: "in_progress", owner: "codex", rejections: 1 });
  await tasks.done("codex", 1, "v2");
  const twice = await tasks.review("claude", 1, "changes_requested", "still wrong");
  await tick();
  expect(twice).toMatchObject({ state: "in_progress", owner: "kimi", rejections: 0 });
  expect(peers.kimi!.got.at(-1)!.body).toContain("edge case missing");
  expect(peers.codex!.got.at(-1)!.body).toContain("moved to kimi");
  expect(notices.some((n) => n.includes("escalated from codex to kimi"))).toBe(true);
  expect(board.get(1)!.history.map((h) => h.event)).toContain("escalated");
});

test("a decline reaches the next peer in the class list; a task that is in review or approved cannot change hands", async () => {
  const { tasks, peers, board } = await setup();
  await tasks.propose("claude", { title: "implement the thing", class: "implement" });
  expect(board.get(1)!.owner).toBe("codex");
  const next = await tasks.decline("codex", 1, "busy with the release");
  await tick();
  expect(next).toMatchObject({ owner: "kimi", state: "proposed" });
  expect(peers.kimi!.got.at(-1)!.body).toContain("Task #1");
  expect(tasks.explain(1).join("\n")).toContain("owner candidate codex: skipped, excluded");

  tasks.accept("kimi", 1);
  await tasks.done("kimi", 1, "done", { paths: "src/thing.ts" } as any); // a model sent a string where the schema says array
  await tick();
  expect(board.get(1)).toMatchObject({ state: "in_review", refs: { paths: ["src/thing.ts"] } });
  expect(peers.claude!.got.at(-1)!.body).toContain("paths src/thing.ts"); // the review still went out
  for (const op of [() => tasks.decline("kimi", 1), () => tasks.escalate("user", 1), () => tasks.assignTo(1, "codex")]) {
    await expect(op()).rejects.toThrow(/can no longer change hands/);
  }
});

test("a second rejection with nobody to escalate to still reaches the owner", async () => {
  const { tasks, peers, notices } = await setup();
  await tasks.propose("claude", { title: "summarize the log", class: "summarize", owner: "kimi" }); // summarize has no escalate_to
  tasks.accept("kimi", 1);
  for (const note of ["too long", "still too long"]) {
    await tasks.done("kimi", 1, "v");
    await tasks.review("claude", 1, "changes_requested", note);
  }
  await tick();
  expect(peers.kimi!.got.at(-1)!.body).toContain("requests changes again. still too long");
  expect(notices.at(-1)).toContain("escalation found nobody");
  expect((await tasks.done("kimi", 1, "v3")).state).toBe("in_review"); // and the task is not stuck
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
  const first = peers.codex!.got.at(-1)!.body;
  expect(first).toContain("Memory brief");
  expect(first).toContain("#65001 10:00a decision switchyard sidecar fallback design");
  expect(first).toContain("#65002"); // the timeline neighbour
  await tasks.assignTo(1, "codex");
  await tick();
  expect(peers.codex!.got.at(-1)!.body).not.toContain("#65001");
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
  expect(await tasks.remember("codex", { text: "use bun:sqlite, not a server", kind: "decision", task: 1 })).toBe("saved to shared memory");
  expect(saves().at(-1)).toMatchObject({ text: "use bun:sqlite, not a server", project: "agent-hub", metadata: { peer: "codex", kind: "decision", task: 1 } });
  mem.stop();
  expect(await tasks.remember("codex", { text: "x" })).toBe("memory worker unavailable; nothing saved");
  tasks.accept("codex", 1);
  expect((await tasks.done("codex", 1, "done")).state).toBe("in_review");
});

test("budget pause: open work goes to local first through the constraints, reviews move on, PII gets no handoff text", async () => {
  const { tasks, peers, board, bus } = await setup();
  await tasks.propose("claude", { title: "implement parser", class: "implement" }); // #1 -> codex
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
  expect(lines).toContain("owner: kimi");
  expect((await tasks.propose("claude", { title: "rename things", class: "implement" })).owner).toBe("kimi");
  expect(tasks.explain(1)[0]).toContain("#1 rename things (proposed, owner kimi)");
});
