import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import type { ReviewAnchor } from "../src/hub/acon-review-contract.d.ts";
import { reviewCommentFields, reviewCommentIds, reviewCommentBody, parseStoredReviewComment } from "../src/hub/review-comments.ts";
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
async function fixture(checking = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-comments-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const peers = [new Peer("codex"), new Peer("claude")]; for (const peer of peers) { bus.add(peer); await peer.start(); }
  const owner = peers[0]!, notices: string[] = [], envelopes: Envelope[] = [], paths: string[] = [];
  bus.tap(event => { if (event.t === "envelope") envelopes.push(event.env); });
  let checkStarted!: () => void;
  const checkStart = new Promise<void>(resolve => { checkStarted = resolve; });
  const control: { head: string; unavailable: boolean; read?: () => Promise<void>; releaseCheck?: (result: { code: number; timedOut: boolean; tail: string }) => void } = { head: HEAD, unavailable: false };
  let reads = 0;
  const deps: TasksDeps = { cwd, board, bus, project: "fixture", roles: { codex: ["implementer"], claude: ["planner", "reviewer"] }, routing: () => loadRouting(cwd), piiPaths: paths, notify: text => { notices.push(text); },
    reviewMaterials: async (task, requests) => { reads++; await control.read?.(); return { head: control.head, materials: requests.map(request => control.unavailable || task.signals.includes("pii") ? { state: "unavailable" as const, path: request.path, side: request.side ?? "head" } : { state: "available" as const, path: request.path, side: request.side ?? "head", text: TEXT, rawHash: hash, contentHash: hash }) }; },
    ...(checking ? { check: () => "fixture-check", runCheck: () => new Promise<{ code: number; timedOut: boolean; tail: string }>(resolve => { control.releaseCheck = resolve; checkStarted(); }) } : {}) };
  const tasks = new Tasks(deps), task = await tasks.propose("codex", { owner: "codex", title: "Review fixture", class: "implement", refs: { commit: HEAD, paths: ["notes/report.md"] } });
  const anchor = (path = "notes/report.md"): ReviewAnchor => ({ path, side: "head", contentHash: hash, selectors: [{ kind: "lineRange", startLine: 2, endLine: 2 }, { kind: "textQuote", exact: "QUOTE_CANARY selected passage", prefix: "", suffix: "" }] });
  const draft = (body = "COMMENT_CANARY improve this paragraph", value = anchor()) => tasks.reviewCommentPut("user", { task: task.id, commit: control.head, anchor: value, body });
  return { cwd, board, bus, owner, tasks, task, anchor, draft, control, paths, notices, envelopes, checkStart, reads: () => reads };
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

test("resolution is an admitted owner submission claim even while its later check fails", async () => {
  const f = await fixture(true), draft = await f.draft(); await f.tasks.reviewCommentSend("user", { task: f.task.id });
  await f.tasks.done("codex", f.task.id, "Addressed review", undefined, undefined, undefined, [draft.id]);
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("resolved");
  await f.checkStart; f.control.releaseCheck!({ code: 1, timedOut: false, tail: "fixture failed" });
  await (f.tasks as unknown as { checkQueue: Promise<void> }).checkQueue;
  expect(f.board.get(f.task.id)?.state).toBe("in_progress"); expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("resolved");
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

test("unavailable material is a transient ids-only placement, never permanent privacy or invented coordinates", async () => {
  const f = await fixture(); f.control.unavailable = true;
  const draft = await f.draft(); expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.private).toBe(false);
  const unavailable = (await f.tasks.reviewCommentList("user", { task: f.task.id })).comments[0]!;
  expect(unavailable).toMatchObject({ id: draft.id, placement: { status: "unavailable" } });
  expect(unavailable).not.toHaveProperty("thread"); expect(JSON.stringify(unavailable)).not.toMatch(/QUOTE_CANARY|COMMENT_CANARY|notes\/report/);
  f.control.unavailable = false;
  const available = (await f.tasks.reviewCommentList("user", { task: f.task.id })).comments[0]!;
  expect(available.thread?.anchor).toEqual(f.anchor()); expect(available.placement.status).toBe("anchored");
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
