import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskState } from "../src/hub/board.ts";
import type { SupervisionFacts, SupervisionHistoryFact } from "../src/hub/supervision-rules.ts";
import {
  MAX_PROPOSALS,
  MAX_PROPOSALS_PER_REVISION,
  MAX_PROPOSAL_READ,
  MAX_PROPOSAL_ROWS,
  ProposalStore,
  SUPERVISION_PROPOSAL_STATES,
  SupervisionProposals,
  proposalKey,
  type ProposalPorts,
  type SupervisionProposal,
} from "../src/hub/supervision-proposals.ts";

// #1221 T2: the queue is a store plus a decision path over ports, so every proof here is a fact fixture, a port stub
// and the rows left in a throwaway hub.db. Nothing in this file starts a daemon, a peer, a worker or a timer, and the
// last test proves mechanically that the module itself cannot.

const BASE = 1_700_000_000_000, STEP = 1_000;
type Item = string | readonly [string, Partial<SupervisionHistoryFact>];
const history = (...items: Item[]): SupervisionHistoryFact[] => items.map((item, index) => typeof item === "string"
  ? { at: BASE + index * STEP, event: item }
  : { at: BASE + index * STEP, event: item[0], ...item[1] });
const task = (id: number, items: readonly Item[], state: TaskState = "in_progress") => ({ id, state, history: history(...items) });
const failing = (times = 2): readonly Item[] => {
  const items: Item[] = ["proposed", "assigned", "accepted", "done"];
  for (let round = 0; round < times; round += 1) items.push(["check failed", { checkKey: "implement" }], "done");
  return items;
};

interface Harness {
  dir: string;
  dbPath: string;
  store: ProposalStore;
  proposals: SupervisionProposals;
  ports: ProposalPorts;
  facts: SupervisionFacts;
  state: { private: boolean; held: boolean; generation: string; decides: boolean; now: number };
  runs: { action: string; actor: string }[];
  answer: { outcome: "ran" | "refused" | "unknown"; detail?: string } | Error;
  /** A second daemon start over the same file: the store is closed first, then opened again, as a restart does. */
  restart: () => SupervisionProposals;
  close: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ahub-supervision-"));
  const dbPath = join(dir, "hub.db");
  const store = new ProposalStore(dbPath);
  const state = { private: false, held: false, generation: "qwen@gen-1", decides: true, now: BASE };
  const runs: { action: string; actor: string }[] = [];
  const h: Harness = {
    dir, dbPath, store, state, runs, facts: { tasks: [] }, answer: { outcome: "ran", detail: "escalated" },
    proposals: undefined as unknown as SupervisionProposals,
    ports: undefined as unknown as ProposalPorts,
    restart: () => undefined as unknown as SupervisionProposals,
    close: () => h.store.close(),
  };
  const ports: ProposalPorts = {
    facts: () => h.facts,
    isPrivate: () => state.private,
    generation: () => state.generation,
    mayDecide: () => state.decides,
    held: () => state.held,
    run: async (proposal, actor) => {
      runs.push({ action: proposal.action, actor });
      if (h.answer instanceof Error) throw h.answer;
      return h.answer;
    },
    now: () => state.now,
  };
  h.ports = ports;
  h.proposals = new SupervisionProposals(store, ports);
  h.restart = () => { store.close(); h.store = new ProposalStore(dbPath); return (h.proposals = new SupervisionProposals(h.store, ports)); };
  return h;
}

const only = (rows: SupervisionProposal[]): SupervisionProposal => {
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

test("a reading becomes one bounded proposal, and a replay of the same records adds nothing", async () => {
  const h = harness();
  h.facts = { tasks: [task(7, failing())] };
  const [proposal] = await h.proposals.observe(7);
  expect(proposal).toBeDefined();
  expect(proposal).toMatchObject({
    key: "repeated_failure:7:1:none:failures:check:implement", rule: "repeated_failure", version: 1, task: 7, revision: "1:none",
    trigger: "failures:check:implement", records: 5, truncated: false, action: "escalate", reason: "repeated_failure",
    generation: "qwen@gen-1", state: "pending", createdAt: BASE,
  });
  expect(proposal!.refs).toEqual(["history:4", "history:6"]);
  // A proposal is codes and ids: no note, no title, no path, no file body.
  expect(Object.keys(proposal!).sort()).toEqual([
    "action", "createdAt", "generation", "id", "key", "reason", "records", "refs", "revision", "rule", "state", "task", "trigger", "truncated", "version",
  ]);
  // The dedupe identity is the rules' own tuple, so a replayed reading is recognised by four fields and no timestamp.
  const identity = { rule: proposal!.rule, task: proposal!.task, revision: proposal!.revision, trigger: proposal!.trigger };
  expect(proposalKey(identity as Parameters<typeof proposalKey>[0])).toBe(proposal!.key);
  expect(await h.proposals.observe(7)).toEqual([]);
  expect(h.store.pendingCount()).toBe(1);
  expect(h.runs).toEqual([]); // reading proposes; it never runs anything
  h.close();
});

test("the queue is bounded: one proposal per key, three per revision, 100 pending, 50 in one read", async () => {
  const h = harness();
  // Four equal-failure classes in one revision make four observations; the per-revision bound keeps three.
  const items: Item[] = ["proposed", "assigned", "accepted"];
  for (const key of ["a", "b", "c", "d"]) items.push(["check failed", { checkKey: key }], ["check failed", { checkKey: key }], "check passed");
  h.facts = { tasks: [task(10, items)] };
  expect(await h.proposals.observe(10)).toHaveLength(MAX_PROPOSALS_PER_REVISION);
  expect(h.store.inRevision(10, "1:none")).toBe(MAX_PROPOSALS_PER_REVISION);
  // The global queue holds MAX_PROPOSALS pending proposals however many tasks report.
  for (let id = 200; id < 200 + MAX_PROPOSALS + 5; id += 1) {
    h.facts = { tasks: [task(id, failing())] };
    await h.proposals.observe(id);
  }
  expect(h.store.pendingCount()).toBe(MAX_PROPOSALS);
  // A read is bounded too, and pending rows come first.
  expect(await h.proposals.read("user")).toHaveLength(MAX_PROPOSAL_READ);
  h.close();
});

test("accepting runs the named existing action once and records a receipt beside the decision, never in its place", async () => {
  const h = harness();
  h.facts = { tasks: [task(11, failing())] };
  const proposal = only(await h.proposals.observe(11));
  const historyBefore = h.facts.tasks[0]!.history.length;

  const accepted = await h.proposals.decide("user", proposal.id, "accept");
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.proposal).toMatchObject({ state: "accepted", actor: "user", disposedAt: BASE });
  expect(accepted.receipt).toEqual({ outcome: "ran", detail: "escalated", at: BASE });
  expect(h.runs).toEqual([{ action: "escalate", actor: "user" }]);
  // The intent (this row's disposition), the receipt (the action's report) and the board's own result are three records:
  // the acceptance wrote no history, and the receipt is on the proposal row rather than inside the task.
  expect(h.facts.tasks[0]!.history).toHaveLength(historyBefore);
  expect(h.store.get(proposal.id)!.receipt).toEqual({ outcome: "ran", detail: "escalated", at: BASE });
  expect(SUPERVISION_PROPOSAL_STATES).toContain(accepted.proposal.state);

  // A decided proposal is terminal: neither verb runs again, and the action is never retried.
  expect(await h.proposals.decide("user", proposal.id, "accept")).toEqual({ ok: false, error: "this proposal is already accepted" });
  expect(await h.proposals.decide("user", proposal.id, "dismiss")).toEqual({ ok: false, error: "this proposal is already accepted" });
  expect(h.runs).toHaveLength(1);
  h.close();
});

test("a dismissal is terminal, runs nothing, and leaves the board alone", async () => {
  const h = harness();
  h.facts = { tasks: [task(12, failing())] };
  const proposal = only(await h.proposals.observe(12));
  const dismissed = await h.proposals.decide("user", proposal.id, "dismiss");
  expect(dismissed.ok).toBe(true);
  if (!dismissed.ok) return;
  expect(dismissed.proposal).toMatchObject({ state: "dismissed", actor: "user" });
  expect(dismissed.proposal.receipt).toBeUndefined();
  expect(dismissed.receipt).toBeUndefined();
  expect(h.runs).toEqual([]);
  expect(h.store.pendingCount()).toBe(0);
  h.close();
});

test("an action that fails without a known outcome is recorded unknown, not retried and not run twice", async () => {
  const h = harness();
  h.facts = { tasks: [task(13, failing())] };
  const proposal = only(await h.proposals.observe(13));
  h.answer = new Error("the conductor refused mid-flight");
  const decided = await h.proposals.decide("user", proposal.id, "accept");
  expect(decided.ok).toBe(true);
  if (!decided.ok) return;
  expect(decided.receipt).toMatchObject({ outcome: "unknown", detail: "the conductor refused mid-flight" });
  expect(h.store.get(proposal.id)!.receipt).toMatchObject({ outcome: "unknown" });
  expect(await h.proposals.decide("user", proposal.id, "accept")).toMatchObject({ ok: false });
  expect(h.runs).toHaveLength(1);
  h.close();
});

test("AC3: an id, an actor, a private task, a hold, a revision, a generation and a vanished reading all refuse", async () => {
  const h = harness();
  h.facts = { tasks: [task(20, failing())] };
  const base = only(await h.proposals.observe(20));

  // The id grammar, an unknown id, and an id that is not a string.
  expect(await h.proposals.decide("user", "nope", "accept")).toEqual({ ok: false, error: "unknown supervision proposal" });
  expect(await h.proposals.decide("user", "sup-zzzzzzzzzzzz", "accept")).toEqual({ ok: false, error: "unknown supervision proposal" });
  expect(await h.proposals.decide("user", 42, "accept")).toEqual({ ok: false, error: "unknown supervision proposal" });
  expect(await h.proposals.decide("user", "sup-000000000000", "accept")).toEqual({ ok: false, error: "unknown supervision proposal" });
  // A caller with no present role on the task is refused, and the proposal stays for whoever may decide it.
  h.state.decides = false;
  expect(await h.proposals.decide("kimi", base.id, "accept")).toEqual({
    ok: false, error: "not yours to decide: the task's owner, reviewer, planner, conductor or the person decides a supervision proposal",
  });
  expect(h.store.get(base.id)!.state).toBe("pending");
  h.state.decides = true;
  // A private task is never decided, whatever the caller's role.
  h.state.private = true;
  expect(await h.proposals.decide("user", base.id, "accept")).toEqual({ ok: false, error: "a private task is never proposed on" });
  expect(h.store.get(base.id)!.state).toBe("pending");
  h.state.private = false;
  // An existing needs_review delivery for the owner holds the decision; the proposal is not spent by the refusal.
  h.state.held = true;
  expect(await h.proposals.decide("user", base.id, "accept")).toMatchObject({ ok: false, error: "the owner has a needs_review delivery; resolve it before acting on this proposal" });
  expect(h.store.get(base.id)!.state).toBe("pending");
  h.state.held = false;

  // A replaced native generation expires the proposal: another session's reading is not this session's question.
  h.state.generation = "qwen@gen-2";
  expect(await h.proposals.decide("user", base.id, "accept")).toEqual({ ok: false, error: "the native session it was read under was replaced; the proposal expired" });
  expect(h.store.get(base.id)!.state).toBe("expired");
  expect(h.runs).toEqual([]);

  // A moved revision, a closed task and a task that left the board each expire a pending proposal.
  const movedOn: readonly Item[] = [...failing(), "reassigned", "accepted", ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }]];
  const cases: { why: string; id: number; next: SupervisionFacts }[] = [
    { why: "the task moved to another revision", id: 21, next: { tasks: [task(21, movedOn)] } },
    { why: "the task is closed", id: 22, next: { tasks: [task(22, failing(), "approved" as TaskState)] } },
    { why: "the task is no longer on the board", id: 23, next: { tasks: [] } },
  ];
  for (const test of cases) {
    h.state.generation = "qwen@gen-1";
    h.facts = { tasks: [task(test.id, failing())] };
    const fresh = only(await h.proposals.observe(test.id));
    h.facts = test.next;
    expect(await h.proposals.decide("user", fresh.id, "accept")).toEqual({ ok: false, error: `${test.why}; the proposal expired` });
    expect(h.store.get(fresh.id)!.state).toBe("expired");
  }
  expect(h.runs).toEqual([]);
  h.close();
});

test("a reading that no longer holds is expired, both before a decision and while a proposal waits", async () => {
  const h = harness();
  h.facts = { tasks: [task(30, failing())] };
  const proposal = only(await h.proposals.observe(30));
  // A recorded check pass between the failures clears the streak inside the same revision: the question is gone, the
  // revision is not.
  const cleared: readonly Item[] = ["proposed", "assigned", "accepted", ["check failed", { checkKey: "implement" }], "done",
    ["check passed", { checkKey: "implement" }], ["check failed", { checkKey: "implement" }], "done"];
  h.facts = { tasks: [task(30, cleared)] };
  expect(await h.proposals.decide("user", proposal.id, "accept")).toEqual({ ok: false, error: "the reading changed: new input replaced this proposal; the proposal expired" });
  expect(h.store.get(proposal.id)!.state).toBe("expired");

  // The same reading is never advised twice, not even after its proposal expired: the dedupe key outlives the decision.
  h.facts = { tasks: [task(30, failing())] };
  expect(await h.proposals.observe(30)).toEqual([]);
  expect(h.store.pendingCount()).toBe(0);

  // The next reading invalidates what it no longer produces, without waiting for a decision.
  h.facts = { tasks: [task(32, failing())] };
  const waiting = only(await h.proposals.observe(32));
  expect(waiting.state).toBe("pending");
  h.facts = { tasks: [task(32, cleared)] };
  expect(await h.proposals.observe(32)).toEqual([]);
  expect(h.store.get(waiting.id)!.state).toBe("expired");
  h.close();
});

test("a clipped reading proposes nothing of its own and invalidates nothing", async () => {
  const h = harness();
  const clipped: Item[] = ["accepted", ...Array.from({ length: 70 }, () => "done" as const), ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }]];
  h.facts = { tasks: [task(31, failing())] };
  const waiting = only(await h.proposals.observe(31));
  h.facts = { tasks: [task(31, clipped)] };
  expect(await h.proposals.observe(31)).toEqual([]);
  expect(h.store.get(waiting.id)!.state).toBe("pending"); // an unknown prefix is not evidence that the question left
  h.close();
});

test("AC6: a restart keeps the keys, the dispositions and an outcome the hub never saw, and retries nothing", async () => {
  const h = harness();
  h.facts = { tasks: [task(40, failing())] };
  const decided = only(await h.proposals.observe(40));
  h.facts = { tasks: [task(40, failing()), task(41, failing())] };
  const moved = only(await h.proposals.observe(41));
  expect(await h.proposals.decide("user", decided.id, "dismiss")).toMatchObject({ ok: true });
  // The intent is written and the action's outcome never was: the shape a crash between the two leaves behind.
  expect(h.store.dispose(moved.id, "accepted", "user", BASE, { outcome: "pending", at: BASE })).toBe(true);

  const restarted = h.restart();
  // The task moved on while the hub was down.
  h.facts = { tasks: [task(41, [...failing(), "reassigned", "accepted", ["check failed", { checkKey: "implement" }], "done", ["check failed", { checkKey: "implement" }]]), task(40, failing())] };
  expect(await restarted.recover()).toEqual({ expired: 0, unknown: 1 });
  expect(h.store.get(decided.id)!.state).toBe("dismissed"); // a disposition survives the restart
  expect(h.store.get(moved.id)).toMatchObject({ state: "accepted", receipt: { outcome: "unknown", detail: "the hub restarted before the action reported" } });
  expect(h.runs).toEqual([]); // neither a dismissal nor a restart runs an action
  // Replay after the restart adds nothing: the dedupe key is still the row's.
  expect(await restarted.observe(40)).toEqual([]);
  expect(h.store.inRevision(40, "1:none")).toBe(1);

  // A pending proposal whose task closed while the hub was down expires at the same pass.
  h.facts = { tasks: [task(42, failing())] };
  only(await restarted.observe(42));
  h.facts = { tasks: [task(42, failing(), "cancelled" as TaskState)] };
  expect(await h.restart().recover()).toEqual({ expired: 1, unknown: 0 });
  h.close();
});

test("an unknown outcome is reconciled from the board's own record, never from a guess", async () => {
  const h = harness();
  h.facts = { tasks: [task(50, failing())] };
  const proposal = only(await h.proposals.observe(50));
  h.answer = new Error("the answer never arrived");
  await h.proposals.decide("user", proposal.id, "accept");
  expect(h.store.get(proposal.id)!.receipt).toMatchObject({ outcome: "unknown" });

  // The board has no escalated record at or after the receipt: the receipt stays unknown and the read invents nothing.
  expect((await h.proposals.read("user"))[0]).toMatchObject({ receipt: { outcome: "unknown" } });
  // The board recorded the escalation this action made: the receipt settles to ran, and the read says which record did.
  h.facts = { tasks: [task(50, [...failing(), ["escalated", { at: BASE + STEP }]])] };
  const settled = (await h.proposals.read("user"))[0]!;
  expect(settled.receipt).toMatchObject({ outcome: "ran", detail: "the board recorded escalated" });
  expect(h.runs).toHaveLength(1);
  h.close();
});

test("a read shows only what the caller may decide, never a private task's proposal, and is bounded", async () => {
  const h = harness();
  h.facts = { tasks: [task(60, failing()), task(61, failing())] };
  await h.proposals.observe(60);
  await h.proposals.observe(61);
  expect((await h.proposals.read("user")).map((proposal) => proposal.task).sort()).toEqual([60, 61]);
  h.state.decides = false;
  expect(await h.proposals.read("kimi")).toEqual([]);
  h.state.decides = true;
  h.state.private = true;
  expect(await h.proposals.read("user")).toEqual([]);
  h.state.private = false;
  expect((await h.proposals.read("user", 61)).map((proposal) => proposal.task)).toEqual([61]);
  expect(MAX_PROPOSAL_ROWS).toBeGreaterThanOrEqual(MAX_PROPOSALS);
  h.close();
});

test("retention keeps the newest bounded terminal rows and never prunes a pending one", async () => {
  const h = harness();
  const ids: string[] = [];
  let seq = 0;
  for (let round = 0; round < 4; round += 1) {
    h.state.now = BASE + (seq += STEP);
    h.facts = { tasks: [task(70 + round, failing())] };
    const proposal = only(await h.proposals.observe(70 + round));
    ids.push(proposal.id);
    await h.proposals.decide("user", proposal.id, "dismiss");
  }
  h.facts = { tasks: [task(80, failing())] };
  const pending = only(await h.proposals.observe(80));
  expect(h.store.prune(2)).toBe(2);
  expect(h.store.get(pending.id)!.state).toBe("pending");
  expect(ids.filter((id) => h.store.get(id) !== undefined)).toHaveLength(2);
  h.close();
});

test("the module carries no clock, no timer, no bus and no board write: its effects are the ones the ports name", () => {
  const source = readFileSync(new URL("../src/hub/supervision-proposals.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "Date.now(", "performance.now(", "setTimeout(", "setInterval(", "setImmediate(", "process.env",
    "publish(", "notify(", "writeFileSync", "\"./tasks.ts\"", "\"./daemon.ts\"", "\"./bus.ts\"", "\"./peers.ts\"", "\"./memory/",
  ]) expect({ forbidden, found: source.includes(forbidden) }).toEqual({ forbidden, found: false });
  // The clock is a port, and the store is the only module that opens the database.
  expect(source).toContain("now: () => number");
  expect(source).toContain("openHubDatabase(dbPath, { create: true })");
});
