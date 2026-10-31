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
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { loadRouting } from "../src/hub/routing.ts";
import type { ResearchCampaignContract } from "../src/hub/research-campaign.ts";
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
const contract = (): ResearchCampaignContract => ({ question: "What does the fixture show?", scope: "Synthetic inputs only", exclusions: [], sourceIds: [SOURCE],
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
  const executionBudget = new ExecutionBudget(file); clean.push(() => executionBudget.close());
  const routing = loadRouting(dir), roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
  let now = NOW;
  let screen: ConstructorParameters<typeof Tasks>[0]["piiScreen"];
  let notify = (_line: string): void => {};
  const build = () => new Tasks({ board, bus, cwd: dir, project: "fixture-project", roles, routing: () => routing, notify: line => notify(line), executionBudget, studyNow: () => now,
    piiScreen: text => screen?.(text) ?? Promise.resolve({ label: "clear" as const, ms: 0 }),
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); } });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Research parent", class: "implement", owner: "codex" });
  return { dir, file, bus, peers, sources, routing, roles, parent, get ledger() { return executionBudget; }, get board() { return board; }, get tasks() { return tasks; },
    setNow(value: number) { now = value; },
    setScreen(next: NonNullable<typeof screen>) { screen = next; },
    setNotify(next: (line: string) => void) { notify = next; },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}

async function approve(f: Awaited<ReturnType<typeof fixture>>, budget?: ResearchCampaignContract["budget"]) {
  const body = { ...contract(), ...(budget ? { budget } : {}) };
  const draft = await f.tasks.studyDraft("claude", { parentTaskId: f.parent.id, contract: body });
  return f.tasks.studyApprove(USER, { id: draft.id, revision: draft.revision });
}
const firstId = (campaign: Awaited<ReturnType<typeof approve>>) => campaign.units.find(unit => unit.unitId === "discover")!.taskId;
async function pull(f: Awaited<ReturnType<typeof fixture>>, id: number) {
  return f.tasks.pullPlanned(USER, { id, revision: f.board.get(id)!.planningRevision ?? 0, reason: "fixture pull" });
}

test("named budget coverage does not accept a different applicable budget and never resets shared usage", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({ id: "shared", kind: "run", peers: ["local"], limits: { model_calls: 3 } });
  f.tasks.configureExecutionBudget({ id: "other", kind: "run", peers: ["local"], limits: { tool_calls: 20 } });
  const one = await approve(f, { id: "shared", hardCap: ["model_calls"] });
  const parent2 = await f.tasks.propose(USER, { title: "Second research parent", class: "implement", backlog: true });
  const draft2 = await f.tasks.studyDraft(USER, { parentTaskId: parent2.id, contract: { ...contract(), budget: { id: "shared", hardCap: ["model_calls"] } } });
  const two = await f.tasks.studyApprove(USER, { id: draft2.id, revision: 1 });
  for (const campaign of [one, two]) {
    expect(f.board.researchCampaign(campaign.id)!.eligibleOwners).toEqual(["local"]);
    expect(f.ledger.covers("shared", firstId(campaign), "local", ["model_calls"])).toBe(true);
    expect(f.tasks.admitExecution(firstId(campaign), "local", "model_calls").find(row => row.scope === "shared")!.allowed).toBe(true);
  }
  expect((f.ledger.status("shared") as { used: {model_calls:number} }).used.model_calls).toBe(2);
  f.tasks.disableExecutionBudget("shared");
  expect(f.ledger.applies([firstId(one)], "local")).toBe(true);
  expect(f.ledger.covers("shared", firstId(one), "local", ["model_calls"])).toBe(false);
  await expect(pull(f, firstId(one))).rejects.toThrow(/study|eligible/);
  expect(f.board.get(firstId(one))!.state).toBe("backlog");
});

test("planner pull expiry after screening and after restart dispatches no expired study", async () => {
  const f = await fixture(), campaign = await approve(f), id = firstId(campaign);
  f.setScreen(async () => { f.setNow(NOW + 2 * 86_400_000); return {label:"clear",ms:0}; });
  await expect(pull(f, id)).rejects.toThrow(/study|eligible/);
  expect(f.board.get(id)!.state).toBe("backlog");
  f.restart();
  await expect(pull(f, id)).rejects.toThrow(/study|eligible/);
  expect(f.tasks.studyShow(USER, {id:campaign.id}).reasons).toContain("campaign deadline has passed or is unknown");
});

test("a revised draft or close during screening cannot inherit the old approval", async () => {
  for (const action of ["revise", "close"]) {
    const f = await fixture(), campaign = await approve(f), id = firstId(campaign);
    f.setScreen(async () => {
      f.setScreen(async () => ({label:"clear",ms:0}));
      if (action === "revise") await f.tasks.studyRevise(USER, {id:campaign.id,revision:1,contract:{...contract(),scope:"Changed scope"}});
      else await f.tasks.studyClose(USER, {id:campaign.id,revision:1,reason:"Stop fixture"});
      return {label:"clear",ms:0};
    });
    await expect(pull(f,id)).rejects.toThrow(/study|eligible/);
    expect(f.board.get(id)!.state).toBe("backlog");
  }
});

test("hard-cap routing admits only its stored instrumented owners and rejects uncovered manual handoff", async () => {
  const f = await fixture();
  f.tasks.configureExecutionBudget({id:"cap",kind:"run",peers:["local"],limits:{tool_calls:10}});
  const campaign = await approve(f,{id:"cap",hardCap:["tool_calls"]}), id=firstId(campaign);
  await pull(f,id);
  // An unreserved planner pull reserves its chosen owner, and the ordinary backlog pull writes the owner.
  if (f.board.get(id)!.state === "backlog") await f.tasks.moveBacklog(USER,id,true);
  const task = f.board.get(id)!;
  expect(task.owner ?? task.reserved).toBe("local");
  await expect(f.tasks.assignTo(id,"codex",USER,true,"owner")).rejects.toThrow(/study|eligible|covered/);
  expect(f.board.get(id)!.owner).not.toBe("codex");
});

test("a task-scoped budget cannot cover another unit even with another run budget present", async () => {
  const f=await fixture(), campaign=await approve(f), id=firstId(campaign);
  f.tasks.configureExecutionBudget({id:"narrow",kind:"task",taskId:f.parent.id,peers:["local"],limits:{tool_calls:3}});
  f.tasks.configureExecutionBudget({id:"wide",kind:"run",peers:["local"],limits:{tool_calls:3}});
  expect(f.ledger.covers("narrow",id,"local",["tool_calls"])).toBe(false);
  expect(f.ledger.covers("wide",id,"local",["tool_calls"])).toBe(true);
});
