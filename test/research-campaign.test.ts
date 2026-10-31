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
  const build = () => new Tasks({ board, bus, cwd: dir, project: "fixture-project", roles, routing: () => routing, notify: () => {}, studyNow: () => NOW,
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); } });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Research parent", class: "implement", owner: "codex" });
  return { dir, file, bus, peers, sources, routing, roles, parent, get board() { return board; }, get tasks() { return tasks; },
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
    { ...contract(), sourceIds: ["src:ffffffffffffffff"] },
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
