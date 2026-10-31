import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
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
  const routing = loadRouting(dir); routing.signals.pii_screen = "local"; routing.constraints.pii = "local_only";
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
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

test("an exhausted named cap holds dispatch, including elapsed time and token-unknown model calls", async () => {
  for (const resource of ["tool_calls","elapsed_ms"] as const) {
    const f=await fixture();
    f.tasks.configureExecutionBudget({id:"spent",kind:"run",peers:["local"],limits:{[resource]:0}});
    const campaign=await approve(f,{id:"spent",hardCap:[resource]}), id=firstId(campaign);
    await expect(pull(f,id)).rejects.toThrow(/study|eligible/);
    expect(f.board.get(id)!.state).toBe("backlog");
  }
  const f=await fixture();
  f.tasks.configureExecutionBudget({id:"unknown",kind:"run",peers:["local"],limits:{model_calls:2,tokens:100}});
  await expect(approve(f,{id:"unknown",hardCap:["model_calls"]})).rejects.toThrow(/hard-cap/);
});

async function startDiscovery(f: Awaited<ReturnType<typeof fixture>>, campaign: Awaited<ReturnType<typeof approve>>) {
  const id=firstId(campaign); await pull(f,id); await f.tasks.assignTo(id,"local",USER,true);
  f.tasks.accept("local",id); return id;
}
const handoff = (campaignId:string,taskId:number) => ({campaignId,revision:1,unitId:"discover",taskId,evidence:[{sourceId:SOURCE,locator:"synthetic section"}],unresolved:[],contradictions:[],limitations:[]});

test("only a stored complete handoff or insufficient evidence advances a discovery round", async () => {
  const f=await fixture(), campaign=await approve(f), id=await startDiscovery(f,campaign);
  const next=contract(); next.stopPolicy.maxUnits=3;
  next.units.push({id:"next",round:1,question:"Next measured question",perspective:"analysis",requiredOutput:"result",sourceIds:[SOURCE],dependsOn:[],purpose:"analysis"});
  await expect(f.tasks.studyRevise(USER,{id:campaign.id,revision:1,contract:next})).rejects.toThrow(/follow-up/);
  await expect(f.tasks.studyHandoff("codex",handoff(campaign.id,id))).rejects.toThrow(/owner/);
  expect(await f.tasks.studyHandoff("local",handoff(campaign.id,id))).toMatchObject({unitId:"discover",seq:1});
  expect(f.tasks.studyShow(USER,{id:campaign.id}).discoveryRounds).toEqual([{round:0,complete:true}]);
  const revised=await f.tasks.studyRevise(USER,{id:campaign.id,revision:1,contract:next});
  expect(revised.revision).toBe(2);
  expect((await f.tasks.studyApprove(USER,{id:campaign.id,revision:2})).units).toHaveLength(3);
  f.restart();
  expect(f.tasks.studyShow(USER,{id:campaign.id}).discoveryRounds).toEqual([{round:0,complete:true}]);
});

test("handoffs refuse missing or newly private sources without persisting public text", async () => {
  const f=await fixture(), campaign=await approve(f), id=await startDiscovery(f,campaign);
  f.sources.delete(SOURCE);
  await expect(f.tasks.studyHandoff("local",handoff(campaign.id,id))).rejects.toThrow(/source/);
  f.sources.set(SOURCE,{id:SOURCE,sha256:"a".repeat(64),private:true});
  await expect(f.tasks.studyHandoff("local",handoff(campaign.id,id))).rejects.toThrow(/privacy/);
  expect(f.board.researchHandoffs(campaign.id)).toEqual([]);
  expect(f.tasks.studyShow(USER,{id:campaign.id}).units.every(unit=>unit.sourceIds.length===0)).toBe(true);
});

test("a queued owner offer is rechecked at delivery after its campaign closes", async () => {
  const f=await fixture(), campaign=await approve(f), id=await startDiscovery(f,campaign);
  const env=newEnvelope(HUB,"fixture offer",{to:["local"],kind:"task",refs:{task:String(id),taskOffer:1,taskRecipient:"owner"}});
  expect(f.tasks.relevant("local",env)).toBe(true);
  await f.tasks.studyClose(USER,{id:campaign.id,revision:1,reason:"Closed before delivery"});
  expect(f.tasks.relevant("local",env)).toBe(false);
});

test("insufficientEvidence settles a discovery round while acceptance still refuses an expired task", async () => {
  const f=await fixture(), campaign=await approve(f), id=await startDiscovery(f,campaign);
  await f.tasks.studyHandoff("local",{...handoff(campaign.id,id),evidence:[],insufficientEvidence:"The fixture source provides no measurements"});
  const projection=f.tasks.studyShow(USER,{id:campaign.id});
  expect(projection.discoveryRounds).toEqual([{round:0,complete:true}]);
  expect(projection.units[0]!.handoff.complete).toBe(false);
  const next=contract(); next.stopPolicy.maxUnits=3;
  next.units.push({id:"another",round:1,question:"Inspect a second perspective",perspective:"analysis",requiredOutput:"note",sourceIds:[SOURCE],dependsOn:[],purpose:"analysis"});
  expect((await f.tasks.studyRevise(USER,{id:campaign.id,revision:1,contract:next})).revision).toBe(2);
  await f.tasks.studyApprove(USER,{id:campaign.id,revision:2});
  f.setNow(NOW+2*86_400_000);
  expect(()=>f.tasks.accept("local",id)).toThrow(/deadline/);
  expect(f.board.get(id)!.state).toBe("in_progress");
});

test("the dispatch check runs right before the owner write: a revocation or expiry that lands after routing is read there and nothing is written", async () => {
  // `current` is asked at the start of assignOwner and a second time immediately before the last check and the write (a third is the delivery, after the write). The first call
  // passes; the second lands the change after the early read and before the write, which is exactly the window a screen, plan review or routing await opens. Remove the last check and
  // these refuse nothing.
  const run = (f: Awaited<ReturnType<typeof fixture>>, taskId: number, hook: () => void) => {
    let calls = 0;
    const current = () => { calls += 1; if (calls === 2) hook(); };
    return (f.tasks as unknown as { assignOwner(task: unknown, by: string, opts: Record<string, unknown>): Promise<unknown> })
      .assignOwner(f.board.get(taskId), USER, { candidates: ["local"], namedOwner: "local", refuseNamed: "pre", current });
  };
  const prepared = async () => {
    const f = await fixture(), c = await approve(f), id = firstId(c);
    await f.tasks.pullPlanned("claude", { id, revision: 0, reason: "the planner pulls the unit" });
    return { f, id, before: f.board.get(id)!.history.length };
  };
  const a = await prepared();
  await expect(run(a.f, a.id, () => { (a.f.board as unknown as { db: Database }).db.query("UPDATE research_campaigns SET status='closed',closed_by='user',closed_at=1,closed_reason='late'").run(); })).rejects.toThrow();
  expect(a.f.board.get(a.id)!.owner).toBeNull(); expect(a.f.board.get(a.id)!.history).toHaveLength(a.before);
  const b = await prepared();
  await expect(run(b.f, b.id, () => b.f.setNow(NOW + 2 * 86_400_000))).rejects.toThrow(/deadline/);
  expect(b.f.board.get(b.id)!.owner).toBeNull(); expect(b.f.board.get(b.id)!.history).toHaveLength(b.before);
  // with no change at all the same call writes the owner, so the refusals above are the gate and not a broken fixture
  const c = await prepared();
  await run(c.f, c.id, () => {});
  expect(c.f.board.get(c.id)!.owner).toBe("local");
});
