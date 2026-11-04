import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import type { ReviewAnchor } from "@staix/agent-console/contract";
import { reviewCommentFields, reviewCommentIds, reviewCommentBody, parseStoredReviewComment, type ReviewCommentFence, type ReviewCommentPackage } from "../src/hub/review-comments.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
const close: (() => unknown)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
const HEAD = "a".repeat(40), TEXT = "First line\nQUOTE_CANARY selected passage\nLast line\n";
const hash = createHash("sha256").update(TEXT).digest("hex");
class Peer extends BasePeer {
  received: Envelope[] = []; wait?: (env: Envelope) => void;
  async start() { this.setState("idle"); } async stop() {}
  async deliver(envs: Envelope[]) { this.received.push(...envs); for (const env of envs) if (env.refs?.reviewPackage) this.wait?.(env); }
  nextPackage(): Promise<Envelope> { const found = this.received.find(env => env.refs?.reviewPackage); return found ? Promise.resolve(found) : new Promise(resolve => { this.wait = resolve; }); }
}
async function fixture(checking = false, durable = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-comments-")), database = join(cwd, "hub.db");
  let board = new Board(database), bus = new Bus({ batchMs: 0, ...(durable ? { journal: new DeliveryJournal({ file: database, projectRoot: cwd, projectId: "review-comments", instanceId: "test" }) } : {}) });
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  let peers = [new Peer("codex"), new Peer("claude")]; for (const peer of peers) { bus.add(peer); await peer.start(); }
  let owner = peers[0]!, notices: string[] = [], envelopes: Envelope[] = [], paths: string[] = [];
  const tap = (current: Bus) => current.tap(event => { if (event.t === "envelope") envelopes.push(event.env); }); tap(bus);
  let checkStarted!: () => void;
  const checkStart = new Promise<void>(resolve => { checkStarted = resolve; });
  const control: { head: string; unavailable: boolean; read?: () => Promise<void>; releaseCheck?: (result: { code: number; timedOut: boolean; tail: string }) => void } = { head: HEAD, unavailable: false };
  let reads = 0;
  const deps: TasksDeps = { cwd, board, bus, project: "fixture", roles: { codex: ["implementer"], claude: ["planner", "reviewer"] }, routing: () => loadRouting(cwd), piiPaths: paths, notify: text => { notices.push(text); },
    reviewMaterials: async (task, requests) => { reads++; await control.read?.(); return { head: control.head, materials: requests.map(request => control.unavailable || task.signals.includes("pii") ? { state: "unavailable" as const, path: request.path, side: request.side ?? "head" } : { state: "available" as const, path: request.path, side: request.side ?? "head", text: TEXT, rawHash: hash, contentHash: hash }) }; },
    ...(checking ? { check: () => "fixture-check", runCheck: () => new Promise<{ code: number; timedOut: boolean; tail: string }>(resolve => { control.releaseCheck = resolve; checkStarted(); }) } : {}) };
  let tasks = new Tasks(deps); const task = await tasks.propose("codex", { owner: "codex", title: "Review fixture", class: "implement", refs: { commit: HEAD, paths: ["notes/report.md"] } });
  const anchor = (path = "notes/report.md"): ReviewAnchor => ({ path, side: "head", contentHash: hash, selectors: [{ kind: "lineRange", startLine: 2, endLine: 2 }, { kind: "textQuote", exact: "QUOTE_CANARY selected passage", prefix: "", suffix: "" }] });
  const draft = (body = "COMMENT_CANARY improve this paragraph", value = anchor()) => tasks.reviewCommentPut("user", { task: task.id, commit: control.head, anchor: value, body });
  const restart = async () => {
    bus.closeJournal(); board.close(); board = new Board(database);
    const journal = durable ? new DeliveryJournal({ file: database, projectRoot: cwd, projectId: "review-comments", instanceId: "restarted" }) : undefined;
    bus = new Bus({ batchMs: 0, ...(journal ? { journal } : {}) }); peers = [new Peer("codex"), new Peer("claude")];
    for (const peer of peers) { bus.add(peer); await peer.start(); }
    owner = peers[0]!; tap(bus); tasks = new Tasks({ ...deps, board, bus });
    return { board, bus, owner, tasks };
  };
  return { cwd, board, bus, owner, tasks, task, anchor, draft, control, paths, notices, envelopes, checkStart, restart, reads: () => reads };
}
const refusal = async (call: Promise<unknown>) => { let error: unknown; try { await call; } catch (caught) { error = caught; } expect(error).toBeInstanceOf(PreEffectToolRefusal); return error as Error; };

test("three person drafts start no turn; send commits one package and one count-only history entry", async () => {
  const f = await fixture(), history = f.board.get(f.task.id)!.history, messages = f.envelopes.length;
  const drafts = await Promise.all([f.draft(), f.draft("Second comment"), f.draft("Third comment")]);
  expect(f.envelopes).toHaveLength(messages); expect(f.owner.state).toBe("idle"); expect(f.board.get(f.task.id)!.history).toEqual(history);
  const edited = await f.tasks.reviewCommentPut("user", { task: f.task.id, id: drafts[0]!.id, revision: drafts[0]!.revision, commit: HEAD, anchor: f.anchor(), body: "Edited comment" }, { identity: "verified-person", node: "fixture-node", via: "console" });
  expect(f.board.reviewComments(f.task.id, f.task.created).find(row => row.thread.id === edited.id)?.thread.author).toBe("verified-person");
  const receipt = await f.tasks.reviewCommentSend("user", { task: f.task.id });
  expect(receipt).toMatchObject({ task: f.task.id, count: 3, delivery: "queued" });
  const packet = await f.owner.nextPackage(); expect(packet.kind).toBe("review"); expect(packet.refs?.reviewPackage).toBe(receipt.packageId);
  expect(f.envelopes.filter(env => env.refs?.reviewPackage)).toHaveLength(1);
  expect(packet.body).toContain("QUOTE_CANARY"); expect(packet.body).toContain("Edited comment"); expect(packet.body).toContain("notes/report.md:2-2 (anchored)");
  const entries = f.board.get(f.task.id)!.history.slice(history.length); expect(entries).toHaveLength(1); expect(entries[0]?.event).toBe("person review comments sent (3)");
  expect(JSON.stringify([entries, f.notices])).not.toMatch(/QUOTE_CANARY|COMMENT_CANARY|Edited comment/);
  expect(f.board.reviewCommentCounts(f.task.id, f.task.created)).toEqual({ draft: 0, sent: 3, resolved: 0, dismissed: 0 });
  await refusal(f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [edited.id] }));
});

test("draft delete is physical; owner done resolves sent comments, person dismissal stays terminal and idempotent", async () => {
  const f = await fixture(), removed = await f.draft(); await f.tasks.reviewCommentDelete("user", { task: f.task.id, id: removed.id, revision: removed.revision });
  expect(f.board.reviewComments(f.task.id, f.task.created)).toEqual([]);
  const draft = await f.draft(); await f.tasks.reviewCommentSend("user", { task: f.task.id });
  await f.tasks.done("codex", f.task.id, "Addressed review", undefined, undefined, undefined, [draft.id]);
  const resolved = f.board.reviewComments(f.task.id, f.task.created)[0]!; expect(resolved.lifecycle).toBe("resolved");
  const dismissed = await f.tasks.reviewCommentDelete("user", { task: f.task.id, id: draft.id, revision: resolved.revision });
  expect(dismissed.lifecycle).toBe("dismissed");
  const before = f.board.reviewCommentsIntegrity(), generation = f.board.statusRevision();
  expect(await f.tasks.reviewCommentDelete("user", { task: f.task.id, id: draft.id, revision: resolved.revision })).toEqual(dismissed);
  expect(f.board.statusRevision()).toBe(generation); expect(f.board.reviewCommentsIntegrity()).toEqual(before);
  const original = resolved.thread; expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.thread).toEqual(original);
});

test("comment ids stay sent while an admitted done check fails", async () => {
  const f = await fixture(true), draft = await f.draft(); await f.tasks.reviewCommentSend("user", { task: f.task.id });
  await f.tasks.done("codex", f.task.id, "Addressed review", undefined, undefined, undefined, [draft.id]);
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("sent");
  await f.checkStart; f.control.releaseCheck!({ code: 1, timedOut: false, tail: "fixture failed" });
  await (f.tasks as unknown as { checkQueue: Promise<void> }).checkQueue;
  expect(f.board.get(f.task.id)?.state).toBe("in_progress"); expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("sent");
});

test("person authority and untrusted author/meta fields refuse before any draft effect", async () => {
  const f = await fixture(), draft = await f.draft(), before = f.board.reviewCommentsIntegrity();
  for (const by of ["codex", "claude", "local", "codex@remote"]) {
    await refusal(f.tasks.reviewCommentPut(by, { task: f.task.id, commit: HEAD, anchor: f.anchor(), body: "forged" }));
    await refusal(f.tasks.reviewCommentDelete(by, { task: f.task.id, id: draft.id, revision: 1 }));
    await refusal(f.tasks.reviewCommentSend(by, { task: f.task.id }));
  }
  for (const field of ["author", "meta", "at", "state"]) await refusal(f.tasks.reviewCommentPut("user", { task: f.task.id, commit: HEAD, anchor: f.anchor(), body: "forged", [field]: "FORGED_CANARY" }));
  expect(f.board.reviewCommentsIntegrity()).toEqual(before);
});

test("PII comments are board-only and private paths retain only existing safe selectors", async () => {
  const f = await fixture(); f.paths.push("notes/private.md");
  const draft = await f.draft("COMMENT_CANARY private", f.anchor("notes/private.md"));
  const stored = f.board.reviewComments(f.task.id, f.task.created)[0]!;
  expect(stored.thread.anchor.selectors).toEqual([{ kind: "lineRange", startLine: 2, endLine: 2 }]);
  expect(JSON.stringify(stored.thread.anchor)).not.toContain("QUOTE_CANARY");
  await refusal(f.draft("private quote", { ...f.anchor("notes/private.md"), selectors: [{ kind: "textQuote", exact: "QUOTE_CANARY", prefix: "", suffix: "" }] }));
  expect((await f.tasks.reviewCommentList("user", { task: f.task.id })).comments).toEqual([]);
  f.board.update(f.task.id, "user", "private", { signals: ["pii"] });
  const receipt = await f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] });
  const packet = await f.owner.nextPackage(); expect(packet.refs?.reviewPackage).toBe(receipt.packageId);
  expect(packet.body).not.toMatch(/QUOTE_CANARY|COMMENT_CANARY|notes\/private/);
  expect(JSON.stringify(f.tasks.publicView(f.board.get(f.task.id)!))).not.toMatch(/QUOTE_CANARY|COMMENT_CANARY|notes\/private/);
});

test("unavailable material retains the stored person thread and refuses Send before effects", async () => {
  const f = await fixture(), draft = await f.draft(); f.control.unavailable = true;
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.private).toBe(false);
  const unavailable = (await f.tasks.reviewCommentList("user", { task: f.task.id })).comments[0]!;
  expect(unavailable).toMatchObject({ thread: { id: draft.id, body: "COMMENT_CANARY improve this paragraph" }, commit: HEAD, placement: { status: "unavailable" } });
  expect(unavailable).toHaveProperty("thread"); expect(JSON.stringify(unavailable)).toMatch(/COMMENT_CANARY|notes\/report/);
  const before = f.board.reviewCommentsIntegrity(), history = f.board.get(f.task.id)?.history;
  await refusal(f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] }));
  expect(f.board.reviewCommentsIntegrity()).toEqual(before); expect(f.board.get(f.task.id)?.history).toEqual(history);
  f.control.unavailable = false;
  const available = (await f.tasks.reviewCommentList("user", { task: f.task.id })).comments[0]!;
  expect(available.thread?.anchor).toEqual(f.anchor()); expect(available.placement.status).toBe("anchored");
});

test("private-path drafts keep safe board anchors without reading public material", async () => {
  const f = await fixture(); f.paths.push("notes/private.md"); f.control.unavailable = true;
  const draft = await f.draft("private body", { ...f.anchor("notes/private.md"), selectors: [
    { kind: "lineRange", startLine: 2, endLine: 2 },
    { kind: "textQuote", exact: "PRIVATE_QUOTE_CANARY", prefix: "", suffix: "" },
  ] });
  const stored = f.board.reviewComments(f.task.id, f.task.created)[0]!;
  expect(stored.thread.id).toBe(draft.id);
  expect(stored.thread.anchor.selectors).toEqual([{ kind: "lineRange", startLine: 2, endLine: 2 }]);
  expect(stored.private).toBe(true);
  expect(JSON.stringify(stored)).not.toContain("PRIVATE_QUOTE_CANARY");
  const receipt = await f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] }), packet = await f.owner.nextPackage();
  expect(receipt.delivery).toBe("queued");
  expect(packet.body).toContain(draft.id);
  expect(packet.body).not.toMatch(/private body|PRIVATE_QUOTE_CANARY|notes\/private/);
});

test("draft creation refuses mismatched immutable hash and closed-task Send before effects", async () => {
  const f = await fixture(), before = f.board.reviewCommentsIntegrity();
  const mismatched = { ...f.anchor(), contentHash: "b".repeat(64) };
  expect((await refusal(f.tasks.reviewCommentPut("user", { task: f.task.id, commit: HEAD, anchor: mismatched, body: "stale anchor" }))).message).toContain("content hash or projection");
  expect(f.board.reviewCommentsIntegrity()).toEqual(before);
  const draft = await f.draft();
  f.board.update(f.task.id, "user", "cancelled", { state: "cancelled" });
  const closed = f.board.reviewCommentsIntegrity();
  expect((await refusal(f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] }))).message).toContain("task is open");
  expect(f.board.reviewCommentsIntegrity()).toEqual(closed);
});

test("an explicit retry uses the same durable package and envelope without creating a new turn", async () => {
  const f = await fixture(false, true), draft = await f.draft(), receipt = await f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] });
  const original = await f.owner.nextPackage(), snapshot = f.board.reviewCommentsIntegrity();
  expect((await f.tasks.reviewCommentList("user", { task: f.task.id })).packages).toContainEqual({ id: receipt.packageId, count: 1, delivery: "queued" });
  const retried = await f.tasks.reviewCommentSend("user", { task: f.task.id, packageId: receipt.packageId });
  expect(retried).toEqual({ ...receipt, delivery: "queued" });
  expect(f.owner.received.filter(env => env.refs?.reviewPackage === receipt.packageId)).toHaveLength(1);
  expect(f.owner.received[0]?.id).toBe(original.id); expect(f.board.reviewCommentsIntegrity()).toEqual(snapshot);
});

test("a sent package keeps its original owner scoped after task reassignment and across restart", async () => {
  const f = await fixture(false, true), draft = await f.draft(); await f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] });
  const beforeMove = f.board.get(f.task.id)!;
  f.board.update(f.task.id, "user", "reassigned", { owner: "claude" }, undefined, {}, beforeMove.history.length);
  const reopened = await f.restart();
  expect(reopened.board.hasOpenReviewCommentsFor("codex", f.task.id)).toBe(true);
  expect(reopened.board.hasReviewObserverScope("codex", f.task.id)).toBe(true);
  await refusal(reopened.tasks.remember("codex", { task: f.task.id, text: "must remain scoped after reassignment" }));
  const sent = reopened.board.reviewComments(f.task.id, f.task.created)[0]!;
  await reopened.tasks.reviewCommentDelete("user", { task: f.task.id, id: sent.thread.id, revision: sent.revision });
  expect(reopened.board.hasOpenReviewCommentsFor("codex", f.task.id)).toBe(false);
  expect(reopened.board.hasReviewObserverScope("codex", f.task.id)).toBe(false);
  for (const delivery of reopened.bus.queueList("codex").filter(row => row.originals.some(env => env.refs?.reviewPackage))) {
    if (["queued", "dispatching", "accepted", "needs_review"].includes(delivery.state)) {
      reopened.bus.resolveDelivery(delivery.id, delivery.revision, "discard", "fixture resolves the pending original package delivery");
    }
  }
  expect(await reopened.tasks.remember("codex", { task: f.task.id, text: "scope cleared after dismissal" })).toContain("memory is disabled");
});

test("synchronous publish failure leaves a package for explicit same-envelope retry", async () => {
  const f = await fixture(false, true), draft = await f.draft(), publish = f.bus.publishResult.bind(f.bus);
  f.bus.publishResult = (() => { throw new Error("fixture publication failure"); }) as typeof f.bus.publishResult;
  const sent = await f.tasks.reviewCommentSend("user", { task: f.task.id, ids: [draft.id] });
  f.bus.publishResult = publish;
  expect(sent.delivery).toBe("unconfirmed");
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("sent");
  expect((await f.tasks.reviewCommentList("user", { task: f.task.id })).packages).toContainEqual({ id: sent.packageId, count: 1, delivery: "unconfirmed" });
  const retried = await f.tasks.reviewCommentSend("user", { task: f.task.id, packageId: sent.packageId });
  expect(retried.delivery).toBe("queued");
  expect(f.owner.received.filter(env => env.refs?.reviewPackage === sent.packageId)).toHaveLength(1);
});

test("a crash gap after package persistence recovers after Board and Bus reopen", async () => {
  const f = await fixture(false, true), draft = await f.draft(), row = f.board.get(f.task.id)!, record = f.board.reviewComments(row.id, row.created)[0]!;
  const packageId = `review-${crypto.randomUUID()}`, envelopeId = crypto.randomUUID(), trace = crypto.randomUUID(), ts = Date.now();
  const packet: ReviewCommentPackage = { id: packageId, task: row.id, taskCreated: row.created, ids: [record.thread.id], owner: row.owner!, head: HEAD,
    at: new Date(ts).toISOString(), body: "CRASH_GAP_IMMUTABLE_BODY", envelopeId, trace, ts, delivery: "unconfirmed", publicationEvidenceVersion: 1 };
  const fence: ReviewCommentFence = { task: row.id, taskCreated: row.created, flow: row.history.length, owner: row.owner, head: HEAD };
  f.board.sendReviewComments([record], packet, fence);
  expect((await f.tasks.reviewCommentList("user", { task: row.id })).packages).toContainEqual({ id: packageId, count: 1, delivery: "unconfirmed" });
  const reopened = await f.restart();
  const retried = await reopened.tasks.reviewCommentSend("user", { task: row.id, packageId });
  expect(retried).toMatchObject({ task: row.id, packageId, count: 1, delivery: "queued" });
  const delivered = await reopened.owner.nextPackage();
  expect(delivered).toMatchObject({ id: envelopeId, trace, body: "CRASH_GAP_IMMUTABLE_BODY", refs: { reviewPackage: packageId } });
  expect(reopened.owner.received.filter(env => env.refs?.reviewPackage === packageId)).toHaveLength(1);
});

test("oversized aggregate packages refuse atomically instead of truncating selected comments", async () => {
  const f = await fixture(); for (let i = 0; i < 6; i++) await f.draft("C".repeat(2048));
  const before = f.board.reviewCommentsIntegrity(), history = f.board.get(f.task.id)?.history;
  expect((await refusal(f.tasks.reviewCommentSend("user", { task: f.task.id }))).message).toContain("select fewer ids");
  expect(f.board.reviewCommentsIntegrity()).toEqual(before); expect(f.board.get(f.task.id)?.history).toEqual(history);
  expect(f.envelopes.filter(env => env.refs?.reviewPackage)).toEqual([]);
});

test("stale head and asynchronous task changes refuse before saving; stop drains an admitted read safely", async () => {
  const f = await fixture(); f.control.head = "b".repeat(40);
  await refusal(f.tasks.reviewCommentPut("user", { task: f.task.id, commit: HEAD, anchor: f.anchor(), body: "stale" }));
  f.control.head = HEAD;
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.read = async () => { entered(); await gate; };
  const pending = f.draft(), outcome = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
  await start; expect(f.tasks.reviewCommentsPending()).toBe(1);
  const stop = f.tasks.stopReviewComments(); release(); const result = await outcome; await stop;
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.reviewCommentsPending()).toBe(0); expect(f.board.reviewComments(f.task.id, f.task.created)).toEqual([]);
});

test("comment validators reject inert-array violations and malformed recovered authors without executing input", () => {
  let executed = 0; const id = `comment-${"a".repeat(36)}`;
  const accessor = [id]; Object.defineProperty(accessor, "0", { enumerable: true, get() { executed++; return id; } });
  const hidden = [id]; Object.defineProperty(hidden, "0", { enumerable: false, value: id });
  const hole = new Array(1), symbol = [id]; Object.defineProperty(symbol, Symbol.iterator, { value() { executed++; return [id][Symbol.iterator](); } });
  for (const value of [accessor, hidden, hole, symbol, new Proxy([id], { get() { executed++; throw new Error("proxy"); } })]) expect(() => reviewCommentIds(value)).toThrow();
  const input = Object.defineProperty({}, "task", { value: 1, enumerable: false }); expect(() => reviewCommentFields(input, ["task"])).toThrow(); expect(executed).toBe(0);
  expect(() => reviewCommentBody("가".repeat(683))).toThrow("2048");
  for (const author of ["AUTHOR_CANARY\nspoof", "X".repeat(513)]) expect(() => parseStoredReviewComment({ task: 1, taskCreated: 1, commit: HEAD, lifecycle: "draft", revision: 1, private: false, thread: { id, anchor: { path: "a.md", selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }] }, body: "ok", author, at: new Date().toISOString() } })).toThrow("storage invalid");
});
