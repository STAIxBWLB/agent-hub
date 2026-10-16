import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, candidateTargetRevision, MemoryStore, importClaudeMem } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { withoutPii } from "../src/hub/memory-policy.ts";
import type { MemoryScreen } from "../src/hub/read-tools.ts";
import type { PiiVerdict } from "../src/hub/inference.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { Briefs } from "../src/memory/brief.ts";
import { nativeRecall } from "../src/memory/recall.ts";
import { gather } from "../src/hub/ask.ts";

const PROJECT = "synthetic/candidate-producers", MARKER = "CANDIDATE-ONLY-CORRECTION";
class ObserverMemory extends MemoryClient {
  readonly saved: Parameters<MemoryClient["save"]>[0][] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async save(note: Parameters<MemoryClient["save"]>[0]): Promise<unknown> { this.saved.push(structuredClone(note)); return { saved: true }; }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-candidate-producers-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "private"));
  const home = join(dir, "isolated-home"), board = new Board(join(dir, "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const store = new MemoryStore({ home, screen: () => "skip" }); cleanup.push(() => store.close());
  const candidates = new CandidateStore({ home }); cleanup.push(() => candidates.close());
  const base = loadRouting(dir), routing = { ...base, signals: { ...base.signals, pii_patterns: ["PRODUCER-PII"], pii_screen: "local" as const }, constraints: { ...base.constraints, pii: "local_only" as const }, classes: { ...base.classes, implement: { peers: [], escalate_to: [] } } };
  const privatePeers = new Set<string>(), memory = new ObserverMemory(), shares: string[] = [], screens: string[] = [];
  let verdict: PiiVerdict = { label: "clear", ms: 0 };
  let screenHook: ((text: string) => Promise<PiiVerdict>) | undefined;
  const candidateScreen: MemoryScreen = rows => withoutPii(rows.filter(row => !JSON.stringify(row).includes("WITHHELD-TARGET")), routing, dir, ["private/"]);
  const tasks = new Tasks({ board, bus, cwd: dir, project: PROJECT, routing: () => routing, piiPaths: ["private/"], memory,
    store: { store, project: PROJECT, repo: "synthetic/candidate-producers" }, candidates, candidateScreen, privateTurn: peer => privatePeers.has(peer),
    piiScreen: async text => { screens.push(text); return screenHook ? screenHook(text) : verdict; }, notify: () => {}, share: (_peer, text) => shares.push(text),
  });
  const add = (text = "ordinary retained authority", extra = {}) => store.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: ["path:src/target.ts"], ...extra });
  const inReview = (title = "synthetic parser task", extra: { refs?: { paths: string[] }; signals?: string[] } = {}) => {
    const task = board.propose("codex", { title, class: "implement", refs: extra.refs ?? { paths: ["src/target.ts"] }, signals: extra.signals });
    board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    return board.update(task.id, "codex", "done", { state: "in_review" });
  };
  return { dir, board, store, candidates, tasks, memory, shares, screens, privatePeers, add, inReview,
    setVerdict: (next: PiiVerdict) => { verdict = next; }, setScreen: (next: (text: string) => Promise<PiiVerdict>) => { screenHook = next; },
    rows: () => candidates.list({ project: PROJECT, status: "all" }),
  };
}

function deferredScreen(f: ReturnType<typeof fixture>) {
  let entered!: () => void, release!: (verdict: PiiVerdict) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const answer = new Promise<PiiVerdict>(resolve => { release = resolve; });
  f.setScreen(async () => { entered(); return answer; });
  return { started, release: () => release({ label: "clear", ms: 0 }) };
}

test("each changes-requested review with unmet items creates one distinct non-evidentiary fail candidate", async () => {
  const f = fixture(), task = f.inReview(), head = "a".repeat(40), unmet = ["retain the quoted-field regression", "reject a stale task revision"];
  await f.tasks.review("claude", task.id, "changes_requested", "correct these gaps", unmet, head);
  expect(f.rows()).toHaveLength(1);
  const first = f.rows()[0]!;
  expect(first.input.kind).toBe("fail");
  if (first.input.kind !== "fail") throw new Error("wrong candidate kind");
  expect(first.input.approach).toContain(task.title);
  for (const item of unmet) expect(first.input.symptom).toContain(item);
  expect(first.input.cause.toLowerCase()).toContain("unknown"); expect(first.input.retryWhen.toLowerCase()).toContain("unknown");
  expect(first.input.evidenceRefs).toContain(`task:${task.id}`); expect(first.input.evidenceRefs).toContain(`reviewed-head:${head}`);
  f.board.update(task.id, "codex", "done", { state: "in_review" });
  await f.tasks.review("claude", task.id, "changes_requested", "correct these gaps", unmet, head);
  expect(f.rows()).toHaveLength(2); expect(new Set(f.rows().map(candidate => candidate.id)).size).toBe(2);
});

test("approval and a changes-requested review without unmet items create no fail candidates", async () => {
  const f = fixture(), approved = f.inReview("first clean task"), noItems = f.inReview("second clean task");
  await f.tasks.review("claude", approved.id, "approved", "complete", []);
  await f.tasks.review("claude", noItems.id, "changes_requested", "needs another look", []);
  expect(f.rows()).toEqual([]);
});

for (const variant of ["note-pii", "title-pii", "refs-pii", "note-secret", "title-secret", "refs-secret", "note-private", "title-private", "refs-private", "screen-unknown", "private-turn", "pii-task"] as const) test(`review candidate producer refuses ${variant}`, async () => {
  const f = fixture();
  const title = variant === "title-pii" ? "PRODUCER-PII title" : variant === "title-secret" ? "password: synthetic-title-value" : variant === "title-private" ? "private/fixture.txt" : "synthetic parser task";
  const task = f.inReview(title, { ...(variant === "refs-private" ? { refs: { paths: ["private/fixture.txt"] } } : variant === "refs-pii" ? { refs: { paths: ["PRODUCER-PII.txt"] } } : variant === "refs-secret" ? { refs: { paths: ["password: synthetic-reference-value"] } } : {}), ...(variant === "pii-task" ? { signals: ["pii"] } : {}) });
  if (variant === "screen-unknown") f.setVerdict({ label: "unknown", miss: "failed", ms: 0 });
  if (variant === "private-turn") f.privatePeers.add("claude");
  const note = variant === "note-pii" ? "PRODUCER-PII review" : variant === "note-secret" ? "password: synthetic-review-value" : variant === "note-private" ? "private/fixture.txt" : "retain the regression";
  await f.tasks.review("claude", task.id, "changes_requested", note, ["one unmet check"]);
  expect(f.rows()).toEqual([]);
});

test("correct binds a full visible target revision and leaves native/cloud/share evidence unchanged", async () => {
  const f = fixture(), id = f.add(), target = f.store.get(id, PROJECT)!, before = f.store.dump();
  await f.tasks.correct("codex", { id: id.slice(0, 8), text: MARKER, reason: "candidate-only proposal reason" });
  expect(f.rows()).toHaveLength(1);
  const candidate = f.rows()[0]!;
  expect(candidate.input).toMatchObject({ project: PROJECT, kind: "correction", target: { id, revision: candidateTargetRevision(target) }, proposedText: MARKER, reason: "candidate-only proposal reason" });
  expect(f.store.dump()).toBe(before); expect(f.memory.saved).toEqual([]); expect(f.shares).toEqual([]);
  const briefs = new Briefs(undefined, PROJECT, 8, () => f.store.related(PROJECT, ["path:src/target.ts"], 8).map(view => ({ id: view.id, kind: view.kind, line: view.text })));
  const brief = await briefs.forTask("claude", { title: "target", refs: { paths: ["src/target.ts"] } });
  const recall = nativeRecall(f.store.list({ project: PROJECT, tier: "long" }), 1000, view => view.text);
  const ask = await gather(MARKER, { board: f.board, isPii: () => false, onCampus: async () => false, project: PROJECT, logFile: join(f.dir, "missing.log"), native: () => f.store.list({ project: PROJECT }).map(view => ({ id: view.id, text: view.text })) });
  const file = join(f.dir, "empty-observations.db"), db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)"); db.close();
  expect(importClaudeMem(f.store, { project: PROJECT, chain: [PROJECT], db: file, isPii: () => false }).added).toBe(0);
  f.store.rebuild();
  const graph = f.store.graph(PROJECT, "path:src/target.ts", 2);
  for (const consumer of [brief, recall, JSON.stringify(ask), JSON.stringify(graph), JSON.stringify(f.store.list({ project: PROJECT }))]) { expect(consumer).not.toContain(MARKER); expect(consumer).not.toContain(candidate.id); }
});

for (const variant of ["other-project", "hidden-target", "private-target", "secret-target", "private-turn", "input-pii", "input-secret", "input-private", "reason-pii", "reason-secret", "reason-private", "screen-unknown"] as const) test(`correction producer refuses ${variant} without writing a candidate`, async () => {
  const f = fixture(), id = f.add(variant === "hidden-target" ? "WITHHELD-TARGET" : variant === "secret-target" ? "password: synthetic-target-value" : "ordinary retained authority", {
    ...(variant === "other-project" ? { project: "synthetic/other" } : {}), ...(variant === "private-target" ? { about: ["path:private/fixture.txt"] } : {}),
  });
  if (variant === "private-turn") f.privatePeers.add("codex");
  if (variant === "screen-unknown") f.setVerdict({ label: "unknown", miss: "failed", ms: 0 });
  const text = variant === "input-pii" ? "PRODUCER-PII correction" : variant === "input-secret" ? "password: synthetic-correction-value" : variant === "input-private" ? "private/fixture.txt" : "candidate-only corrected content";
  const reason = variant === "reason-pii" ? "PRODUCER-PII reason" : variant === "reason-secret" ? "password: synthetic-reason-value" : variant === "reason-private" ? "private/fixture.txt" : "candidate-only reason";
  const before = f.store.dump();
  await expect(f.tasks.correct("codex", { id, text, reason })).rejects.toThrow();
  expect(f.rows()).toEqual([]); expect(f.store.dump()).toBe(before); expect(f.memory.saved).toEqual([]); expect(f.shares).toEqual([]);
});

for (const variant of ["target-revision", "private-turn"] as const) test(`correction revalidates ${variant} after asynchronous privacy screening`, async () => {
  const f = fixture(), id = f.add(), deferred = deferredScreen(f);
  const before = f.store.get(id, PROJECT)!;
  expect(before.tier).toBe("long");
  const revision = candidateTargetRevision(before);
  const pending = f.tasks.correct("codex", { id, text: MARKER, reason: "candidate-only reason" });
  // Native handlers attach immediately without asking Bun's matcher to await a still-closed barrier.
  const outcome = pending.then(value => ({ status: "fulfilled" as const, value }), error => ({ status: "rejected" as const, error }));
  const entered = await Promise.race([deferred.started.then(() => true), outcome.then(() => false)]);
  expect(entered).toBe(true);
  try {
    if (variant === "target-revision") {
      f.store.demote(id, "person", PROJECT);
      expect(candidateTargetRevision(f.store.get(id, PROJECT)!)).not.toBe(revision);
    } else f.privatePeers.add("codex");
  } finally { deferred.release(); }
  const result = await outcome;
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.error).toBeInstanceOf(Error);
  expect(f.rows()).toEqual([]); expect(f.memory.saved).toEqual([]); expect(f.shares).toEqual([]);
});

test("review candidate evidence names the saved review after a concurrent history-only lifecycle update", async () => {
  const f = fixture(), task = f.inReview();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const answer = new Promise<void>(resolve => { release = resolve; });
  f.setScreen(async text => {
    if (text.includes('"context":')) { entered(); await answer; }
    return { label: "clear", ms: 0 };
  });
  const pending = f.tasks.review("claude", task.id, "changes_requested", "retain this regression", ["one unmet check"]);
  const outcome = pending.then(value => ({ status: "fulfilled" as const, value }), error => ({ status: "rejected" as const, error }));
  const reached = await Promise.race([started.then(() => true), outcome.then(() => false)]);
  expect(reached).toBe(true);
  try { f.tasks.recordLifecycle("claude", task.id, { pr: 1 }); }
  finally { release(); }
  const result = await outcome;
  expect(result.status).toBe("fulfilled");
  const saved = f.board.get(task.id)!;
  const reviewIndex = saved.history.findIndex(entry => entry.event === "changes_requested" && entry.by === "claude");
  expect(reviewIndex).toBeGreaterThan(task.history.length - 1);
  expect(saved.history[reviewIndex - 1]?.event).toBe("lifecycle");
  expect(f.rows()).toHaveLength(1);
  const candidate = f.rows()[0]!;
  if (candidate.input.kind !== "fail") throw new Error("wrong candidate kind");
  expect(candidate.input.evidenceRefs).toContain(`review:${task.id}:${reviewIndex + 1}`);
  expect(candidate.input.evidenceRefs).not.toContain(`review:${task.id}:${task.history.length + 1}`);
});
