import { expect, test } from "bun:test";
import { Bus } from "../src/hub/bus.ts";
import { HUB, isInvocationKind, KINDS, newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #445 C2: how the bus carries an invocation's two envelope kinds: alone, never condensed, and a callee's answer taken over before anything is built from it.
class Recorder extends BasePeer {
  batches: Envelope[][] = [];
  async deliver(envs: Envelope[]) { this.batches.push(envs); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  force(state: "idle" | "busy" | "offline") { this.setState(state); }
}
class PullRecorder extends Recorder { readonly pullOnly = true; }

const request = (to: string, over: Partial<Parameters<typeof newEnvelope>[2]> = {}) => newEnvelope(HUB, "do the thing", { to: [to], kind: "invocation", priority: "status", ...over });
const result = (to: string) => newEnvelope(HUB, "the result", { to: [to], kind: "invocation_result", priority: "status" });
const chat = (to: string, text: string) => newEnvelope(USER, text, { to: [to], priority: "status" });

test("the kind list has both new kinds once, and isInvocationKind is exactly those two", () => {
  expect(KINDS.filter(k => k === "invocation")).toHaveLength(1); expect(KINDS.filter(k => k === "invocation_result")).toHaveLength(1);
  for (const kind of KINDS) expect(isInvocationKind({ kind }), kind).toBe(kind === "invocation" || kind === "invocation_result");
});

test("a push delivery hands an invocation request alone, and never beside chat that was queued before or after it", async () => {
  const bus = new Bus({ batchMs: 0 }), peer = new Recorder("kimi"); bus.add(peer);
  peer.force("busy"); // everything queues while the peer is busy
  bus.publish(chat("kimi", "one")); bus.publish(request("kimi")); bus.publish(chat("kimi", "two")); bus.publish(chat("kimi", "three"));
  peer.force("idle");
  for (let i = 0; i < 100 && peer.batches.flat().length < 4; i++) { await Bun.sleep(5); if (peer.state === "idle") peer.force("idle"); }
  const batches = peer.batches;
  const holding = batches.filter(b => b.some(e => e.kind === "invocation"));
  expect(holding).toHaveLength(1); expect(holding[0]).toHaveLength(1); // alone
  expect(batches.flat().filter(e => e.kind !== "invocation").map(e => e.body).sort()).toEqual(["one", "three", "two"]); // nothing was lost
});

test("two requests and a result each go in their own delivery", async () => {
  const bus = new Bus({ batchMs: 0 }), peer = new Recorder("kimi"); bus.add(peer);
  peer.force("busy");
  bus.publish(request("kimi")); bus.publish(request("kimi")); bus.publish(result("kimi"));
  peer.force("idle");
  for (let i = 0; i < 200 && peer.batches.length < 3; i++) { await Bun.sleep(5); if (peer.state === "idle") peer.force("idle"); }
  expect(peer.batches.map(b => b.length)).toEqual([1, 1, 1]);
});

test("an invocation request is not condensed even when a condenser is installed and chatter is queued", async () => {
  let condensed = 0;
  const bus = new Bus({ batchMs: 0, condense: async envs => { condensed++; return envs; } }), peer = new Recorder("kimi"); bus.add(peer);
  peer.force("busy");
  for (let i = 0; i < 6; i++) bus.publish(chat("kimi", `chatter ${i}`));
  bus.publish(request("kimi"));
  peer.force("idle");
  for (let i = 0; i < 200 && peer.batches.flat().length < 7; i++) { await Bun.sleep(5); if (peer.state === "idle") peer.force("idle"); }
  const holding = peer.batches.find(b => b.some(e => e.kind === "invocation"))!;
  expect(holding).toHaveLength(1);
});

test("a pull hands an invocation alone and the rest in their own pull", async () => {
  const bus = new Bus({ batchMs: 0 }), peer = new PullRecorder("claude"); bus.add(peer); await peer.start();
  bus.publish(chat("claude", "one")); bus.publish(request("claude")); bus.publish(chat("claude", "two"));
  const first = bus.pull("claude")!;
  expect(first.map(e => e.kind)).toEqual(["chat"]); // the request stopped the first batch
  const second = bus.pull("claude")!;
  expect(second.map(e => e.kind)).toEqual(["invocation"]); expect(second).toHaveLength(1);
  const third = bus.pull("claude")!;
  expect(third.map(e => e.kind)).toEqual(["chat"]);
  expect(bus.pull("claude")).toEqual([]);
});

test("a pull that starts with an invocation takes only it, even when more is queued behind", async () => {
  const bus = new Bus({ batchMs: 0 }), peer = new PullRecorder("claude"); bus.add(peer); await peer.start();
  bus.publish(request("claude")); bus.publish(chat("claude", "after"));
  expect(bus.pull("claude")!.map(e => e.kind)).toEqual(["invocation"]);
  expect(bus.pull("claude")!.map(e => e.kind)).toEqual(["chat"]);
});

// ---- the answer hook ----
async function answering(opts: { host: (peer: string, text: string, handed: readonly Envelope[]) => boolean }) {
  const bus = new Bus({ batchMs: 0 }), callee = new Recorder("kimi"), other = new Recorder("pi"), caller = new Recorder("codex");
  for (const p of [callee, other, caller]) { bus.add(p); await p.start(); }
  bus.onAnswer = opts.host;
  const req = request("kimi"); bus.publish(req);
  for (let i = 0; i < 100 && !callee.batches.length; i++) await Bun.sleep(5);
  const events: string[] = []; bus.tap(e => { if (e.t === "envelope") events.push(e.env.body); });
  return { bus, callee, other, caller, req, events };
}

test("an answer to a delivery that holds an invocation is offered to the host first and, when taken, builds nothing", async () => {
  const seen: { peer: string; text: string; handed: string[] }[] = [];
  const f = await answering({ host: (peer, text, handed) => { seen.push({ peer, text, handed: handed.map(e => e.kind) }); return true; } });
  for (const to of [undefined, ["codex"], ["pi"], ["digest"], ["hub"]]) callee_say(f.callee, "ANSWER", f.req, to);
  await Bun.sleep(80);
  expect(seen).toHaveLength(5); expect(seen.every(s => s.peer === "kimi" && s.text === "ANSWER" && s.handed.join() === "invocation")).toBe(true);
  expect(f.events).toEqual([]); // no envelope was published, so no tap, log or memory path saw it
  expect(f.other.batches).toEqual([]); expect(f.caller.batches).toEqual([]);
  expect(f.bus.queueIds("pi")).toEqual([]); expect(f.bus.queueIds("codex")).toEqual([]);
});

test("an answer the host does not take flows on as an ordinary message", async () => {
  const f = await answering({ host: () => false });
  callee_say(f.callee, "ordinary answer", f.req, ["pi"]);
  await Bun.sleep(80);
  expect(f.events).toEqual(["ordinary answer"]); expect(f.other.batches.flat().map(e => e.body)).toEqual(["ordinary answer"]);
});

test("a host that throws still takes the answer: it is never turned into a broadcast", async () => {
  const f = await answering({ host: () => { throw new Error("host failed"); } });
  callee_say(f.callee, "must not leak", f.req, undefined);
  await Bun.sleep(80);
  expect(f.events).toEqual([]); expect(f.other.batches).toEqual([]); expect(f.caller.batches).toEqual([]);
});

test("the host is not asked about a delivery that holds no invocation", async () => {
  let asked = 0;
  const bus = new Bus({ batchMs: 0 }), callee = new Recorder("kimi"), other = new Recorder("pi");
  for (const p of [callee, other]) { bus.add(p); await p.start(); }
  bus.onAnswer = () => { asked++; return true; };
  const env = chat("kimi", "hello"); bus.publish(env);
  for (let i = 0; i < 100 && !callee.batches.length; i++) await Bun.sleep(5);
  callee_say(callee, "reply", env, ["pi"]);
  await Bun.sleep(60);
  expect(asked).toBe(0); expect(other.batches.flat().map(e => e.body)).toEqual(["reply"]);
});

test("an answer in a later turn, when the peer was last handed ordinary chat, is not an invocation answer", async () => {
  let asked = 0;
  const bus = new Bus({ batchMs: 0 }), callee = new Recorder("kimi"), other = new Recorder("pi");
  for (const p of [callee, other]) { bus.add(p); await p.start(); }
  bus.onAnswer = () => { asked++; return true; };
  const req = request("kimi"); bus.publish(req);
  for (let i = 0; i < 100 && !callee.batches.length; i++) await Bun.sleep(5);
  callee.force("idle");
  const next = chat("kimi", "a new question"); bus.publish(next);
  for (let i = 0; i < 100 && callee.batches.length < 2; i++) { await Bun.sleep(5); if (callee.state === "idle") callee.force("idle"); }
  callee_say(callee, "answer to the question", next, ["pi"]);
  await Bun.sleep(60);
  expect(asked).toBe(0); expect(other.batches.flat().map(e => e.body)).toEqual(["answer to the question"]);
});

function callee_say(peer: Recorder, text: string, parent: Envelope, to?: string[]) {
  peer.onMessage?.(text, { inReplyTo: parent, ...(to ? { to } : {}) });
}

// ---- isHeld ----
test("isHeld reports a pause and a roster hold, and nothing otherwise", async () => {
  let on = true;
  const bus = new Bus({ batchMs: 0, rostered: () => on }), peer = new Recorder("kimi"); bus.add(peer); await peer.start();
  expect(bus.isHeld("kimi")).toBe(false);
  bus.pause("kimi"); expect(bus.isHeld("kimi")).toBe(true); bus.resume("kimi"); expect(bus.isHeld("kimi")).toBe(false);
  on = false; expect(bus.isHeld("kimi")).toBe(true); on = true; expect(bus.isHeld("kimi")).toBe(false);
});

test("a journalled bus settles an invocation request through the journal like any delivery, and the kind survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-bus-invoke-"));
  try {
    const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i", operationId: "o" });
    const bus = new Bus({ batchMs: 0, journal }), peer = new Recorder("kimi"); bus.add(peer);
    peer.force("busy");
    const req = request("kimi"); bus.publish(req);
    const snapshot = bus.snapshot();
    expect(JSON.stringify(snapshot)).toContain('"kind":"invocation"');
    const again = new Bus({ batchMs: 0, journal }); again.restore(snapshot);
    expect(again.queueIds("kimi")).toEqual([req.id]);
    bus.closeJournal();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the capture ends with the invocation's own turn ----
test("a journalled bus captures an unnamed message only while the invocation's delivery is open, and publishes it once the delivery has completed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-bus-capture-"));
  try {
    const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i", operationId: "o" });
    const bus = new Bus({ batchMs: 0, journal }), callee = new Recorder("kimi"), other = new Recorder("pi");
    for (const p of [callee, other]) { bus.add(p); await p.start(); }
    let taken = 0; bus.onAnswer = () => { taken++; return true; };
    let deliveryId = ""; callee.deliver = async (envs: Envelope[], id?: string) => { callee.batches.push(envs); deliveryId = id ?? ""; callee.force("busy"); };
    const req = request("kimi"); bus.publish(req);
    for (let i = 0; i < 100 && !callee.batches.length; i++) await Bun.sleep(5);
    callee.onMessage?.("unnamed, inside the turn", {});
    expect(taken).toBe(1); expect(other.batches).toEqual([]);
    bus.deliveryReceipt("kimi", { id: deliveryId, state: "completed" }); callee.force("idle");
    callee.onMessage?.("unnamed, after the turn", {});
    await Bun.sleep(60);
    expect(taken).toBe(1); // not offered again
    expect(other.batches.flat().map(e => e.body)).toEqual(["unnamed, after the turn"]);
    callee_say(callee, "named, after the turn", req, ["pi"]); // naming the request is always the invocation's answer
    await Bun.sleep(60);
    expect(taken).toBe(2); expect(other.batches.flat().map(e => e.body)).toEqual(["unnamed, after the turn"]);
    bus.closeJournal();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a message naming something else while the invocation is the last delivery is an ordinary message", async () => {
  const bus = new Bus({ batchMs: 0 }), callee = new Recorder("kimi"), other = new Recorder("pi");
  for (const p of [callee, other]) { bus.add(p); await p.start(); }
  let taken = 0; bus.onAnswer = () => { taken++; return true; };
  const req = request("kimi"); bus.publish(req);
  for (let i = 0; i < 100 && !callee.batches.length; i++) await Bun.sleep(5);
  const unrelated = chat("kimi", "unrelated"); bus.publish(unrelated);
  callee_say(callee, "about something else", unrelated, ["pi"]);
  await Bun.sleep(60);
  expect(taken).toBe(0); expect(other.batches.flat().map(e => e.body)).toEqual(["about something else"]);
});

test("a journal-less bus keeps capturing for as long as the peer is busy, and publishes once it is idle", async () => {
  const bus = new Bus({ batchMs: 0 }), callee = new Recorder("kimi"), other = new Recorder("pi");
  for (const p of [callee, other]) { bus.add(p); await p.start(); }
  let taken = 0; bus.onAnswer = () => { taken++; return true; };
  callee.deliver = async (envs: Envelope[]) => { callee.batches.push(envs); callee.force("busy"); };
  bus.publish(request("kimi"));
  for (let i = 0; i < 100 && !callee.batches.length; i++) await Bun.sleep(5);
  callee.onMessage?.("while busy", {}); expect(taken).toBe(1);
  callee.force("idle");
  callee.onMessage?.("once idle", {}); await Bun.sleep(60);
  expect(taken).toBe(1); expect(other.batches.flat().map(e => e.body)).toEqual(["once idle"]);
});
