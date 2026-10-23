import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcMode } from "../src/hub/sdlc.ts";
import { unmetCriteriaIds } from "../src/hub/workflow.ts";

// #507b (AC3): a task's acceptance criteria are the #481 S8 checklist, ids and all. The review request lists them and a verdict's
// unmet items that start with an id name that criterion on the board.
const A = "a".repeat(40);
class Peer extends BasePeer {
  readonly got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const criterion = (id: string, extra: object = {}) => ({ id, required: true, result: "unverified" as "unverified" | "verified" | "failed", refs: [] as string[], ...extra });
async function rig(mode: SdlcMode = "advise") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-criteria-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const peers = { claude: new Peer("claude"), codex: new Peer("codex") };
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const config = sdlcConfig({ mode, required_checks: [] }, "0.14.0");
  const tasks = new Tasks({ board, bus, cwd: dir, project: "criteria", routing: () => loadRouting(dir), roles: { claude: ["planner", "reviewer"] }, notify: (text: string) => notices.push(text), piiScreen: async () => ({ label: "clear", ms: 0 }), sdlc: { config: () => config } } as never);
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const submit = async (criteria?: object[], extra: object = {}) => {
    const task = await tasks.propose("claude", { title: "rank the sources", class: "implement", owner: "codex", ...extra });
    if (criteria) tasks.recordLifecycle(USER, task.id, { criteria: { id: "acceptance", head: A, criteria } });
    await tasks.done("codex", task.id, "finished");
    await Bun.sleep(5);
    return task.id;
  };
  const review = (id: number) => peers.claude.got.filter(e => e.kind === "review" && e.refs?.task === String(id)).at(-1)?.body;
  return { tasks, board, peers, notices, submit, review };
}

test("unmetCriteriaIds: an item names a criterion only by starting with its exact recorded id (pure)", () => {
  const checklist = { criteria: [criterion("AC1"), criterion("AC2"), criterion("source-rank")] };
  const ids = (...items: string[]) => unmetCriteriaIds(items, checklist);
  expect(ids("AC1: no test for overwrite", "AC2")).toEqual(["AC1", "AC2"]);
  expect(ids("  AC2 - the second case", "AC2: again", "AC1.")).toEqual(["AC2", "AC1"]); // each once, in the order first named
  expect(ids("source-rank: wrong order")).toEqual(["source-rank"]);
  expect(ids("ac1: wrong case", "AC10: not a recorded id", "AC1x: prefix of a longer word", "see AC1 for details", "the AC2 case")).toEqual([]); // exact id at the start, nothing else
  expect(ids("AC3: not recorded")).toEqual([]); // an id the checklist does not hold is plain text
  expect(ids()).toEqual([]);
  expect(unmetCriteriaIds(["AC1: x"], undefined)).toEqual([]);
  expect(unmetCriteriaIds([], checklist)).toEqual([]);
});

test("the review request lists the recorded criteria, optional ones marked, ahead of the checklist", async () => {
  const r = await rig();
  const id = await r.submit([criterion("AC1"), criterion("AC2", { required: false, result: "verified", refs: ["sha256:" + "c".repeat(64)] }), criterion("AC3", { result: "failed" })]);
  const body = r.review(id)!;
  expect(body).toContain('Acceptance criteria (name an id at the start of an unmet item, such as "AC1: what is missing"):\n- AC1: unverified\n- AC2 (optional): verified\n- AC3: failed\nChecklist:\n');
  expect(body.indexOf("Acceptance criteria")).toBeLessThan(body.indexOf("Checklist:"));
});

test("a task with no recorded criteria gets the request it always got, byte for byte", async () => {
  const withNone = await rig();
  const id = await withNone.submit();
  const body = withNone.review(id)!;
  expect(body).not.toContain("Acceptance criteria");
  expect(body).toContain("\nChecklist:\n- Map the changed signatures and call sites to the task title, and name each one that does not match.");
});

test("unmet items that start with a recorded id name it on the verdict, in history and in the public view", async () => {
  const r = await rig();
  const id = await r.submit([criterion("AC1"), criterion("AC2"), criterion("AC3")]);
  await r.tasks.review("claude", id, "changes_requested", "two gaps", ["AC2: the overwrite case has no test", "no mention of AC3 here", "AC9: not a criterion", "AC2: said twice"]);
  const verdict = r.board.get(id)!.history.find(h => h.event === "changes_requested")!;
  expect(verdict.unmetCriteria).toEqual(["AC2"]); // only a leading recorded id counts, each once
  expect(verdict.note).toBe("two gaps\nUnmet: AC2: the overwrite case has no test; no mention of AC3 here; AC9: not a criterion; AC2: said twice"); // the note text is unchanged
  const shown = (r.tasks.publicView(r.board.get(id)!, true).history as { event: string; unmetCriteria?: string[] }[]).find(h => h.event === "changes_requested")!;
  expect(shown.unmetCriteria).toEqual(["AC2"]);
});

test("a verdict with no criteria on the task, no unmet items or no id match records no ids", async () => {
  const none = await rig();
  const bare = await none.submit();
  await none.tasks.review("claude", bare, "changes_requested", "x", ["AC1: there is no checklist, so this is plain text"]);
  expect(none.board.get(bare)!.history.find(h => h.event === "changes_requested")).not.toHaveProperty("unmetCriteria");
  const some = await rig();
  const id = await some.submit([criterion("AC1")]);
  await some.tasks.review("claude", id, "changes_requested", "no ids", ["a gap with no id"]);
  expect(some.board.get(id)!.history.find(h => h.event === "changes_requested")).not.toHaveProperty("unmetCriteria");
  const approved = await rig();
  const ok = await approved.submit([criterion("AC1")]);
  await approved.tasks.review("claude", ok, "approved", "fine");
  expect(approved.board.get(ok)!.history.find(h => h.event === "approved")).not.toHaveProperty("unmetCriteria");
});

test("ids are read from the board's checklist at the verdict, not from the caller: a re-recorded checklist is the one used", async () => {
  const r = await rig();
  const id = await r.submit([criterion("AC1")]);
  r.tasks.recordLifecycle(USER, id, { criteria: { id: "acceptance", head: A, criteria: [criterion("AC1"), criterion("late-one")] } });
  await r.tasks.review("claude", id, "changes_requested", "x", ["late-one: found after the request", "AC1: still open"]);
  expect(r.board.get(id)!.history.find(h => h.event === "changes_requested")!.unmetCriteria).toEqual(["late-one", "AC1"]);
});

test("a PII task lists no criteria in its review request and records no ids, even when a checklist was recorded", async () => {
  const r = await rig();
  // Built straight on the board: a PII task has a person reviewer and its checklist is private, so nothing about it reaches a peer.
  const task = r.board.propose("claude", { title: "ordinary title", class: "implement", signals: ["pii_path"] });
  r.board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
  r.tasks.recordLifecycle(USER, task.id, { criteria: { id: "acceptance", head: A, criteria: [criterion("AC1")] } });
  expect(r.tasks.isPii(r.board.get(task.id)!)).toBe(true);
  r.board.update(task.id, "codex", "done", { state: "in_review" }, "finished");
  await r.tasks.review("claude", task.id, "changes_requested", "x", ["AC1: a gap"]);
  const verdict = r.board.get(task.id)!.history.find(h => h.event === "changes_requested")!;
  expect(verdict).not.toHaveProperty("unmetCriteria"); // private: the checklist is not read
  expect(JSON.stringify(r.tasks.publicView(r.board.get(task.id)!, true))).not.toContain("AC1");
  // and the request itself, built directly for the PII task: it carries no criteria list and is marked private
  (r.tasks as unknown as { sendReview(task: unknown, reviewer: string): void }).sendReview(r.board.get(task.id)!, "claude");
  await Bun.sleep(5);
  const sent = r.peers.claude.got.filter(e => e.kind === "review" && e.refs?.task === String(task.id)).at(-1);
  expect(sent).toBeDefined();
  expect(sent!.private).toBe(true);
  expect(sent!.body).not.toContain("Acceptance criteria");
  expect(sent!.body).not.toContain("AC1");
});

test("the history field is validated: only bounded distinct ids on a saved verdict", async () => {
  const r = await rig();
  const id = await r.submit([criterion("AC1")]);
  const task = r.board.get(id)!;
  expect(() => r.board.update(id, "claude", "lifecycle", {}, undefined, { unmetCriteria: ["AC1"] } as never)).toThrow("unmet criteria require a saved review verdict");
  for (const bad of ["AC1", ["AC1", "AC1"], ["bad id"], [1], ["x".repeat(49)], Array.from({ length: 33 }, (_, i) => `c${i}`)]) {
    expect(() => r.board.update(id, "claude", "changes_requested", { state: "changes_requested", rejections: task.rejections + 1 }, "n", { unmetCriteria: bad } as never), JSON.stringify(bad)).toThrow("unmet criteria: expected up to 32 distinct criterion ids");
  }
  expect(r.board.get(id)!.state).toBe("in_review"); // a refused write changed nothing
});
