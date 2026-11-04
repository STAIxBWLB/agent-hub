import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { SourceRegistry } from "../src/hub/sources.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver() {}
}
async function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-plan-sources-1144-"));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), registry = new SourceRegistry(cwd);
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["codex", "kimi"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const notices: string[] = [], tells: { peer: string; text: string }[] = [], effects: string[] = [];
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", profile: "research",
    roles: { codex: ["implementer"], kimi: ["implementer"] },
    routing: () => { const r = loadRouting(cwd); return { ...r, signals: { ...r.signals, pii_patterns: ["PRIVATE-STUDENT"] } }; },
    notify: text => notices.push(text), tell: (peer, text) => { tells.push({ peer, text }); },
    triage: { classify: async () => { effects.push("triage"); return "implement"; }, onCampus: async () => true },
    intake: { split: async () => { effects.push("split"); return undefined; }, partsSchema: () => ({}), sourceKnown: id => !!registry.get(id) },
  });
  const source = registry.add({ bytes: Buffer.from("registered source"), kind: "file", origin: "/notes/source.txt", private: false }).id;
  const other = registry.add({ bytes: Buffer.from("other registered source"), kind: "file", origin: "/notes/other.txt", private: false }).id;
  return { tasks, board, bus, source, other, notices, tells, effects };
}
const unknown = "src:0000000000000000";

// The registry, rather than spelling or a second plan-only list, is authoritative.
test("#1144 propose retains registered plan source ids and refuses an unknown id before effects", async () => {
  const r = await rig();
  await expect(r.tasks.propose("codex", { title: "invalid source", owner: "codex", plan: { sources: [r.source, unknown] } })).rejects.toThrow(`unknown source ${unknown}; list registered ids with ahub source list`);
  expect(r.board.list()).toEqual([]);
  expect(r.effects).toEqual([]);
  expect(r.notices).toEqual([]);
  expect(r.tells).toEqual([]);
  expect(r.bus.pendingEnvelopes("codex")).toEqual([]);
  const task = await r.tasks.propose("codex", { title: "known sources", class: "implement", owner: "codex", plan: { sources: [r.source, r.other] } });
  expect(r.board.get(task.id)?.plan?.sources).toEqual([r.source, r.other]);
});

test("#1144 arbitrary source labels and DOIs must be registered ids on propose and accept", async () => {
  const r = await rig();
  for (const source of ["doi:10.1234/example", "notes/source.txt", "evidence-label"]) {
    await expect(r.tasks.propose("codex", { title: "unregistered label", class: "implement", plan: { sources: [source] } })).rejects.toThrow(`unknown source ${source}`);
  }
  expect(r.board.list()).toEqual([]);
  const task = await r.tasks.propose("codex", { title: "valid task", class: "implement", owner: "codex", plan: { sources: [r.source] } });
  const before = r.board.get(task.id);
  for (const source of ["doi:10.1234/example", "notes/source.txt", "evidence-label"]) {
    expect(() => r.tasks.accept("codex", task.id, { sources: [source] })).toThrow(`unknown source ${source}`);
    expect(r.board.get(task.id)).toEqual(before);
  }
});

test("#1144 accept refuses unknown plan source ids without changing the task or publishing notices", async () => {
  const r = await rig();
  const task = await r.tasks.propose("codex", { title: "existing task", class: "implement", owner: "codex", plan: { sources: [r.source] } });
  const before = r.board.get(task.id), notices = [...r.notices], tells = [...r.tells], envelopes = r.bus.pendingEnvelopes("codex");
  expect(() => r.tasks.accept("codex", task.id, { sources: [unknown] })).toThrow(PreEffectToolRefusal);
  expect(() => r.tasks.accept("codex", task.id, { sources: [unknown] })).toThrow(`unknown source ${unknown}; list registered ids with ahub source list`);
  expect(r.board.get(task.id)).toEqual(before);
  expect(r.notices).toEqual(notices);
  expect(r.tells).toEqual(tells);
  expect(r.bus.pendingEnvelopes("codex")).toEqual(envelopes);
  r.tasks.accept("codex", task.id, { sources: [r.other] });
  expect(r.board.get(task.id)?.plan?.sources).toEqual([r.other]);
});

test("#1144 reviewed acceptance validates sources before any admission readback", async () => {
  const r = await rig();
  const task = await r.tasks.propose("codex", { title: "existing task", class: "implement", owner: "codex" });
  const before = r.board.get(task.id), notices = [...r.notices];
  let readbacks = 0;
  (r.tasks as any).d.sdlc = { config: () => ({ ...sdlcConfig(undefined), mode: "advise" }) };
  // An admission readback can publish or write. A source refusal must precede it.
  (r.tasks as any).specGate = async () => { readbacks++; };
  (r.tasks as any).planEntryGate = async () => { readbacks++; };
  await expect(r.tasks.acceptReviewed("codex", task.id, { sources: [unknown] })).rejects.toThrow(`unknown source ${unknown}`);
  expect(readbacks).toBe(0);
  expect(r.board.get(task.id)).toEqual(before);
  expect(r.notices).toEqual(notices);
  // Positive control: a known source reaches both readbacks. Stop at the final accept boundary.
  (r.tasks as any).accept = () => task;
  await r.tasks.acceptReviewed("codex", task.id, { sources: [r.source] });
  expect(readbacks).toBe(2);
});

test("#1144 source overlap notices name the registered id on propose and accept", async () => {
  const r = await rig();
  const first = await r.tasks.propose("codex", { title: "first", class: "implement", owner: "codex", plan: { sources: [r.source] } });
  const second = await r.tasks.propose("kimi", { title: "second", class: "implement", owner: "kimi", plan: { sources: [r.source] } });
  expect(r.tasks.overlaps(second)).toContain(`source ${r.source}`);
  expect(r.tells.some(item => item.peer === "codex" && item.text.includes(`source ${r.source}`))).toBe(true);
  expect(r.notices.some(text => text.includes("Overlaps") && text.includes(`source ${r.source}`))).toBe(true);
  r.tasks.accept("kimi", second.id, { sources: [r.other] });
  expect(r.tasks.overlaps(r.board.get(second.id)!)).toBe("");
  r.tells.length = 0; r.notices.length = 0;
  const accepted = r.tasks.accept("kimi", second.id, { sources: [r.source] });
  expect(r.tasks.overlapTasks(accepted)).toEqual([first.id]);
  expect(r.tells.some(item => item.peer === "codex" && item.text.includes(`source ${r.source}`))).toBe(true);
  expect(JSON.stringify(r.tells)).not.toContain("/notes/source.txt");
});

test("#1144 PII plan sources remain stored but are absent from public views and overlap notices", async () => {
  const r = await rig();
  const plain = await r.tasks.propose("codex", { title: "public task", class: "implement", owner: "codex", plan: { sources: [r.source] } });
  const task = await r.tasks.propose(USER, { title: "PRIVATE-STUDENT", class: "implement", backlog: true, plan: { sources: [r.source] } });
  expect(task.plan?.sources).toEqual([r.source]);
  expect(r.tasks.publicView(task)).toMatchObject({ title: "[pii]", plan: {} });
  expect(JSON.stringify(r.tasks.publicView(task))).not.toContain(r.source);
  expect(r.tasks.overlaps(task)).toBe("");
  expect(r.tasks.overlapTasks(plain)).toEqual([]);
  // Seed only the owner offer; acceptance and the public projection still go through Tasks.
  const offered = r.board.update(task.id, USER, "backlog pulled", { state: "proposed", owner: USER });
  r.notices.length = 0; r.tells.length = 0;
  const accepted = r.tasks.accept(USER, offered.id, { sources: [r.other] });
  expect(accepted.plan?.sources).toEqual([r.other]);
  expect(r.tasks.publicView(accepted)).toMatchObject({ title: "[pii]", plan: {} });
  expect(JSON.stringify(r.tasks.publicView(accepted))).not.toContain(r.other);
  expect(r.tells).toEqual([]);
  expect(r.notices.join("\n")).not.toContain(r.other);
});

test("#1161 splitBacklog refuses a part naming an unregistered source before the board write, and a registered one splits", async () => {
  const r = await rig();
  const card = await r.tasks.propose(USER, { title: "split me", class: "implement", backlog: true });
  const before = r.board.get(card.id)!, count = r.board.list().length;
  r.effects.length = 0; r.notices.length = 0;
  const bad = [{ title: "first", plan: { sources: [r.source] } }, { title: "second", plan: { sources: [r.source, unknown] } }];
  await expect(r.tasks.splitBacklog(USER, { id: card.id, revision: before.planningRevision ?? 0, parts: bad, reason: "parts" })).rejects.toThrow(new PreEffectToolRefusal(`unknown source ${unknown}; list registered ids with ahub source list`).message);
  await expect(r.tasks.splitBacklog(USER, { id: card.id, revision: before.planningRevision ?? 0, parts: bad, reason: "parts" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(r.board.get(card.id)).toEqual(before);
  expect(r.board.get(card.id)!.planningRevision ?? 0).toBe(before.planningRevision ?? 0);
  expect(r.board.list()).toHaveLength(count);
  expect(r.notices).toEqual([]);
  const good = await r.tasks.splitBacklog(USER, { id: card.id, revision: before.planningRevision ?? 0, parts: [{ title: "first", plan: { sources: [r.source] } }, { title: "second", plan: { sources: [r.source, r.other] } }], reason: "parts" });
  expect(good.children).toHaveLength(2);
  expect(r.board.get(good.children[1]!.id)?.plan?.sources).toEqual([r.source, r.other]);
});

test("#1161 the hub's intake split refuses an unregistered part source the same way, leaving the draft whole", async () => {
  const r = await rig();
  const draft = await r.tasks.propose(USER, { title: "intake draft", class: "implement", backlog: true, draft: true });
  const before = r.board.get(draft.id)!, count = r.board.list().length;
  const bad = [{ title: "first" }, { title: "second", plan: { sources: [unknown] } }];
  await expect(r.tasks.splitBacklog("hub", { id: draft.id, revision: before.planningRevision ?? 0, parts: bad, reason: "intake: split by the hub model" }, { intake: true })).rejects.toThrow(`unknown source ${unknown}; list registered ids with ahub source list`);
  expect(r.board.get(draft.id)).toEqual(before);
  expect(r.board.list()).toHaveLength(count);
  const ok = await r.tasks.splitBacklog("hub", { id: draft.id, revision: before.planningRevision ?? 0, parts: [{ title: "first" }, { title: "second", plan: { sources: [r.other] } }], reason: "intake: split by the hub model" }, { intake: true });
  expect(ok.children).toHaveLength(2);
});
