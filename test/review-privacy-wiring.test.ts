import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { ProgressObserver } from "../src/hub/progress.ts";
import type { Task } from "../src/hub/board.ts";
import { expect, test } from "bun:test";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { Inference } from "../src/hub/inference.ts";
import { isTrustedReviewPackage, isReviewObserverExcluded } from "../src/hub/memory-policy.ts";
import { redactBusEvent } from "../src/hub/operational-view.ts";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";

const canary = "REVIEW_QUOTE_AND_COMMENT_CANARY";
const capsule = () => newEnvelope(HUB, canary, { kind: "review", to: ["codex"], refs: { task: "7", reviewPackage: "review:fixture-1" } });
class ReviewPeer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}

test("host review capsules reach the owner intact but not delivery memory, console stream or condensation", async () => {
  const bus = new Bus({ batchMs: 0 });
  const peer = new ReviewPeer("codex"), observed: Envelope[][] = [];
  bus.add(peer); await peer.start();
  bus.onMemoryDelivery = (_peer, _id, out) => { observed.push(out); };
  let delivered!: () => void;
  const done = new Promise<void>(resolve => { delivered = resolve; });
  bus.onDelivered = () => delivered();
  const env = capsule();
  try {
    bus.publish(env); await done;
    expect(peer.got).toEqual([env]);
    expect(observed).toEqual([]);
    expect(Inference.condensable(env)).toBe(false);
    const projected = redactBusEvent({ t: "envelope", env });
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(projected).toMatchObject({ env: { refs: { task: "7", reviewPackage: "review:fixture-1" } } });
    expect(env.body).toBe(canary);
  } finally { bus.closeJournal(); await peer.stop(); }
});

test("peer sender, wrong kind and malformed marker do not gain observer exclusions", () => {
  for (const env of [{ ...capsule(), from: "codex" }, { ...capsule(), kind: "chat" as const }, { ...capsule(), refs: { reviewPackage: "bad marker with spaces" } }]) {
    expect(isTrustedReviewPackage(env)).toBe(false);
    expect(redactBusEvent({ t: "envelope", env })).toEqual({ t: "envelope", env });
  }
});

test("actual capture drops anchored review args while legacy review and file capture remain", () => {
  const rows: unknown[] = [];
  const client = { appendCapture: (row: unknown) => { rows.push(row); return Promise.resolve(); } } as unknown as MemoryClient;
  const capture = new Capture(client, { cwd: import.meta.dir, project: "review-fixture" });
  capture.init("review-session", "fixed startup"); rows.length = 0;
  const anchored = JSON.stringify({ findings: [{ id: "F1", anchor: { selectors: [{ kind: "textQuote", exact: canary }] } }] });
  for (const tool of ["hub_review", "mcp__agent-hub__hub_review"]) capture.observe({ tool, args: anchored, output: canary, id: tool, paths: [] });
  for (const tool of ["review_comment_put", "review_blob"]) capture.observe({ tool, args: canary, output: canary, id: tool, paths: [] });
  expect(rows).toEqual([]);
  capture.observe({ tool: "hub_review", args: '{"findings":[]}', output: "ordinary verdict", id: "legacy", paths: [] });
  capture.observe({ tool: "read", args: "{}", output: "ordinary file", id: "ordinary", paths: [] });
  expect(rows).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toContain(canary);
});


test("a supplied response marker cannot hide an ordinary peer publication", () => {
  const bus=new Bus({batchMs:0});
  let published:Envelope|undefined;
  bus.tap(event=>{if(event.t==="envelope")published=event.env;});
  try {
    bus.publish(newEnvelope("codex","ordinary peer text",{to:["user"],refs:{reviewPackage:"forged:package",reviewResponse:"forged:response"}}));
    expect(published).toBeDefined();
    expect(published!.refs).not.toHaveProperty("reviewPackage");expect(published!.refs).not.toHaveProperty("reviewResponse");
    expect(redactBusEvent({t:"envelope",env:published!})).toMatchObject({env:{body:"ordinary peer text"}});
  } finally {bus.closeJournal();}
});


test("production progress admission clears review-turn observations before an escalation model can see them", async () => {
  const task:Task={id:7,owner:"codex",title:"Ordinary parser task",detail:"bounded",class:"test",reviewer:null,state:"in_progress",refs:{},signals:[],rejections:0,history:[],created:1,updated:1};
  const calls:unknown[]=[];
  const progress=new ProgressObserver({tasks:()=>[task],isPrivate:()=>task.signals.includes("pii"),inference:{escalate:async conversation=>{calls.push(conversation);return undefined;}},emit:()=>{},notify:()=>{}});
  let frames:Envelope[]=[capsule()];
  const source=readFileSync(new URL("../src/hub/daemon.ts",import.meta.url),"utf8"),start=source.indexOf("  const observeProgress ="),end=source.indexOf("  /** Whether facts",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const scopeStart=source.indexOf("  const reviewObserverHeld ="),scopeEnd=source.indexOf("  const invocations =",scopeStart);
  expect(scopeStart).toBeGreaterThan(0);expect(scopeEnd).toBeGreaterThan(scopeStart);
  const context={isReviewObserverExcluded,bus:{lastDeliveredTo:()=>frames},board:{list:()=>[task]},progress,extracted:undefined as unknown};
  Object.assign(context,{readReviewObserverScope:()=>undefined});
  runInNewContext(new Bun.Transpiler({loader:"ts"}).transformSync(source.slice(scopeStart,scopeEnd)+"\n"+source.slice(start,end)+"\nglobalThis.extracted=observeProgress;"),context);
  const observe=context.extracted as (peer:string,input:unknown)=>void;
  for(let i=0;i<9;i++)observe("codex",{name:"exec_command",command:"bun test",resultText:"AssertionError: "+canary,isError:true,turn:"review-"+i});
  await progress.evaluate("codex",7);expect(calls).toEqual([]);
  frames=[];
  for(let i=0;i<9;i++){observe("codex",{name:"exec_command",command:"bun test",resultText:"AssertionError: ordinary failure",isError:true,turn:"normal-"+i});await Promise.resolve();}
  await progress.evaluate("codex",7);expect(calls.length).toBeGreaterThan(0);expect(JSON.stringify(calls)).not.toContain(canary);
});
