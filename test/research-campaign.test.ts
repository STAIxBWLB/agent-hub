import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), SOURCE = "src:0123456789abcdef";
class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const contract = () => ({ question: "What does the fixture show?", scope: "Synthetic inputs only", exclusions: [], sourceIds: [SOURCE],
  units: [
    { id: "discover", round: 0, question: "Inspect the synthetic source", perspective: "measurement", requiredOutput: "a bounded handoff", sourceIds: [SOURCE], dependsOn: [], purpose: "discovery" },
    { id: "synthesis", round: 0, question: "Combine the synthetic evidence", perspective: "synthesis", requiredOutput: "the result section", sourceIds: [], dependsOn: ["discover"], purpose: "synthesis" },
  ], deliverableSections: [{ id: "result", title: "Result", ownerUnitId: "synthesis" }],
  stopPolicy: { maxUnits: 2, maxFollowUpRounds: 1, deadline: new Date(NOW + 86_400_000).toISOString() } });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-study-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"); let board = new Board(file); clean.push(() => board.close());
  const bus = new Bus({ batchMs: 0 }), peers = [new Peer("claude"), new Peer("codex"), new Peer("local")];
  for (const peer of peers) { bus.add(peer); await peer.start(); }
  const sources = new Map([[SOURCE, { id: SOURCE, sha256: "a".repeat(64), private: false }]]);
  const routing = loadRouting(dir), roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
  let screen: ConstructorParameters<typeof Tasks>[0]["piiScreen"];
  const build = () => new Tasks({ board, bus, cwd: dir, project: "fixture-project", roles, routing: () => routing, notify: () => {}, studyNow: () => NOW,
    piiScreen: text => screen?.(text) ?? Promise.resolve({ label: "clear" as const, ms: 0 }),
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); } });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Research parent", class: "implement", owner: "codex" });
  return { dir, file, bus, peers, sources, routing, roles, parent, get board() { return board; }, get tasks() { return tasks; },
    setScreen(next: NonNullable<typeof screen>) { screen = next; },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}

test("#930 drafts create no children; approval maps one ordinary backlog child per unit and replays after restart", async () => {
  const f = await fixture(), initial = f.board.list().length;
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  expect(draft).toMatchObject({ parentTaskId: f.parent.id, revision: 1, status: "draft", units: [] });
  expect(draft.id).toMatch(/^rc-[a-f0-9]{12}$/);
  expect(f.board.list()).toHaveLength(initial);
  const approved = await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  expect(approved).toMatchObject({ status: "approved", revision: 1 });
  expect(approved.units).toHaveLength(2);
  const ids = new Map(approved.units.map(unit => [unit.unitId, unit.taskId]));
  const first = f.board.get(ids.get("discover")!)!, second = f.board.get(ids.get("synthesis")!)!;
  for (const child of [first, second]) {
    expect(child).toMatchObject({ state: "backlog", owner: null, reviewer: null });
    expect(child.draft ?? false).toBe(false);
  }
  expect(second.deps).toEqual([first.id]);
  expect(f.board.list()).toHaveLength(initial + 2);
  const history = f.board.get(f.parent.id)!.history;
  expect(await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 })).toEqual(approved);
  expect(f.board.get(f.parent.id)!.history).toEqual(history);
  f.restart();
  expect(await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 })).toEqual(approved);
  expect(f.board.list()).toHaveLength(initial + 2);
});

test("#930 revisions are immutable, stale changes and unauthorized activation refuse before effects", async () => {
  const f = await fixture();
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  const original = f.board.researchCampaign(draft.id, 1)!;
  const revised = await f.tasks.studyRevise("claude", { id: draft.id, revision: 1, contract: { ...contract(), scope: "Revised synthetic scope" } });
  expect(revised.revision).toBe(2);
  expect(f.board.researchCampaign(draft.id, 1)).toEqual(original);
  for (const call of [
    () => f.tasks.studyRevise("claude", { id: draft.id, revision: 1, contract: contract() }),
    () => f.tasks.studyApprove(USER, { id: draft.id, revision: 1 }),
    () => f.tasks.studyApprove("claude", { id: draft.id, revision: 2 }),
    () => f.tasks.studyDraft("codex", { parentTaskId: f.parent.id, contract: contract() }),
  ]) {
    const before = f.board.researchIntegrity(), tasks = f.board.list();
    await expect(call()).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(tasks);
  }
});

test("#930 unknown sources and cyclic unit dependencies cannot create a campaign", async () => {
  const f = await fixture();
  for (const body of [
    { ...contract(), sourceIds: ["src:ffffffffffffffff"], units: contract().units.map(unit => ({ ...unit, sourceIds: unit.sourceIds.length ? ["src:ffffffffffffffff"] : [] })) },
    { ...contract(), units: contract().units.map((unit, index) => ({ ...unit, dependsOn: [index ? "discover" : "synthesis"] })) },
  ]) {
    const before = f.board.researchIntegrity(), tasks = f.board.list();
    await expect(f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: body })).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(tasks);
  }
});

test("#930 approval reuses approved intake children without rewriting their ownership or dependencies", async () => {
  const f = await fixture();
  const root = f.board.propose(USER, { title: "Approved intake", class: "implement", backlog: true, draft: true });
  const split = f.board.splitBacklog(root.id, USER, 0, [
    { title: "Intake discovery", class: "implement", refs: {} },
    { title: "Intake synthesis", class: "implement", refs: {}, afterParts: [0] },
  ], "fixture split");
  f.board.approveDrafts([root.id, ...split.children.map(task => task.id)], USER, "intake approved by the person");
  const adopted = split.children.map(task => f.board.get(task.id)!);
  const body = { ...contract(), units: contract().units.map((unit, index) => ({ ...unit, adoptTaskId: adopted[index]!.id })) };
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: root.id, contract: body });
  const count = f.board.list().length;
  const result = await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  expect(result.units.map(unit => unit.taskId)).toEqual(adopted.map(task => task.id));
  expect(result.units.every(unit => unit.adopted)).toBe(true);
  expect(f.board.list()).toHaveLength(count);
  expect(adopted.map(task => f.board.get(task.id))).toEqual(adopted);
});


test("#930 private source campaigns create only private children and expose no question in write receipts or public views", async () => {
  const f = await fixture(), canary = "PRIVATE_CAMPAIGN_QUESTION_CANARY";
  f.sources.get(SOURCE)!.private = true;
  const body = { ...contract(), question: canary, units: contract().units.map(unit => ({ ...unit, question: canary })) };
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: body });
  expect(JSON.stringify(draft)).not.toContain(canary);
  expect(f.board.researchCampaign(draft.id)!.private).toBe(true);
  const approved = await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  for (const unit of approved.units) {
    const child = f.board.get(unit.taskId)!;
    expect(child.signals).toContain("pii"); expect(child.planner).toBeNull();
    expect(JSON.stringify(f.tasks.publicView(child))).not.toContain(canary);
  }
  expect(JSON.stringify(f.board.get(f.parent.id)!.history)).not.toContain(canary);
});

test("#930 source privacy changes while approval is screened invalidate preparation and drain its pending counter", async () => {
  const f = await fixture();
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.setScreen(async () => { expect((f.board as unknown as { db: Database }).db.inTransaction).toBe(false); entered(); await gate; return { label: "clear", ms: 0 }; });
  const before = f.board.researchIntegrity(), rows = f.board.list();
  const call = f.tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  const result = call.then(() => undefined, error => error);
  try {
    await Promise.race([started, call.then(() => { throw new Error("approval missed the screen barrier"); })]);
    expect(f.tasks.studiesPending()).toBe(1);
    f.sources.get(SOURCE)!.private = true;
  } finally { release(); }
  expect(await result).toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.studiesPending()).toBe(0);
  expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(rows);
}, 20_000);

test("#930 a planner whose role is withdrawn during screening cannot store a draft", async () => {
  const f = await fixture(); f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.setScreen(async () => { entered(); await gate; return { label: "clear", ms: 0 }; });
  const before = f.board.researchIntegrity(), rows = f.board.list();
  const call = f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() }), result = call.then(() => undefined, error => error);
  try { await Promise.race([started, call.then(() => { throw new Error("draft missed the screen barrier"); })]); f.roles.claude = ["reviewer"]; }
  finally { release(); }
  expect(await result).toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.studiesPending()).toBe(0);
  expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(rows);
}, 20_000);

test("#930 a newer draft admitted during approval screening wins without partial activation", async () => {
  const f = await fixture(), draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
  let release!: () => void, entered!: () => void, blocked = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.setScreen(async () => { if (!blocked) { blocked = true; entered(); await gate; } return { label: "clear", ms: 0 }; });
  const call = f.tasks.studyApprove(USER, { id: draft.id, revision: 1 }), result = call.then(() => undefined, error => error);
  try {
    await Promise.race([started, call.then(() => { throw new Error("approval missed the screen barrier"); })]);
    expect((await f.tasks.studyRevise("claude", { id: draft.id, revision: 1, contract: { ...contract(), scope: "A newer explicit contract" } })).revision).toBe(2);
  } finally { release(); }
  expect(await result).toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.researchCampaign(draft.id)).toMatchObject({ revision: 2, status: "draft" });
  expect(f.board.list()).toHaveLength(1);
}, 20_000);

test("#930 incompatible adoption rolls back a newly allocated child and emits no intermediate notification", async () => {
  const f = await fixture();
  const root = f.board.propose(USER, { title: "Intake parent", class: "implement", backlog: true, draft: true });
  const adopted = f.board.propose(USER, { title: "Old intake work", class: "implement", backlog: true, draft: true });
  f.board.plan(root.id, USER, { deps: [adopted.id] }, 0, "fixture family");
  f.board.approveDrafts([root.id, adopted.id], USER, "intake approved by the person");
  const body = contract(); Object.assign(body.units[1]!, { adoptTaskId: adopted.id });
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: root.id, contract: body });
  const before = f.board.researchIntegrity(), rows = f.board.list(), revision = f.board.statusRevision();
  const notices: number[] = [], changed = f.board.onChange;
  f.board.onChange = (task, entry) => { notices.push(task.id); changed?.(task, entry); };
  try { await expect(f.tasks.studyApprove(USER, { id: draft.id, revision: 1 })).rejects.toThrow(/dependencies/); }
  finally { f.board.onChange = changed; }
  expect(f.board.researchIntegrity()).toEqual(before); expect(f.board.list()).toEqual(rows);
  expect(f.board.statusRevision()).toBe(revision); expect(notices).toEqual([]);
});

test("#930 only one campaign is active per parent; close preserves tasks and allows another explicit campaign", async () => {
  const f = await fixture();
  const a = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  const b = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  await f.tasks.studyApprove(USER, { id: a.id, revision: 1 });
  const before = f.board.list();
  await expect(f.tasks.studyApprove(USER, { id: b.id, revision: 1 })).rejects.toThrow(/active/);
  expect(f.board.list()).toEqual(before);
  expect((await f.tasks.studyClose("claude", { id: a.id, revision: 1, reason: "The first campaign is complete" })).status).toBe("closed");
  expect(before.filter(task => task.id !== f.parent.id).map(task => f.board.get(task.id))).toEqual(before.filter(task => task.id !== f.parent.id));
  expect((await f.tasks.studyApprove(USER, { id: b.id, revision: 1 })).units).toHaveLength(2);
  await expect(f.tasks.studyRevise("claude", { id: a.id, revision: 1, contract: contract() })).rejects.toThrow(/closed/);
});

test("#930 already-approved replay keeps identities and tightens newly private metadata without a new review history", async () => {
  const f = await fixture(), draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  const approved = await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 }), rows = f.board.list(), before = f.board.researchIntegrity();
  f.sources.get(SOURCE)!.private = true;
  expect(await f.tasks.studyApprove(USER, { id: draft.id, revision: 1 })).toEqual(approved);
  expect(f.board.list()).toEqual(rows);
  expect(f.board.researchCampaign(draft.id)!.private).toBe(true);
  const after = f.board.researchIntegrity();
  expect(after.campaigns).toBe(before.campaigns); expect(after.units).toBe(before.units); expect(after.digest).not.toBe(before.digest);
});

test("#930 foreign parent repositories, campaign projects and unrelated intake tasks refuse before writes", async () => {
  const f = await fixture();
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() });
  const other = new Tasks({ board: f.board, bus: f.bus, cwd: f.dir, project: "another-project", roles: f.roles, routing: () => f.routing, notify: () => {} });
  const before = f.board.researchIntegrity();
  await expect(other.studyRevise(USER, { id: draft.id, revision: 1, contract: contract() })).rejects.toThrow(/project/);
  f.board.update(f.parent.id, USER, "fixture repository", { refs: { repo: "foreign/research" } });
  await expect(f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: contract() })).rejects.toThrow(/project/);
  expect(f.board.researchIntegrity()).toEqual(before);
});
