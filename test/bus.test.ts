import { expect, test } from "bun:test";
import { Bus, type BusEvent } from "../src/hub/bus.ts";
import { frame, newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class FakePeer extends BasePeer {
  got: Envelope[] = [];
  failNext = false;
  async deliver(env: Envelope) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("inject failed");
    }
    this.got.push(env);
  }
  async start() {
    this.setState("idle");
  }
  async stop() {
    this.setState("offline");
  }
  set(s: PeerState) {
    this.setState(s);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function trio(watchdogMs?: number) {
  const bus = new Bus(15);
  const peers = ["claude", "codex", "kimi"].map((id) => new FakePeer(id, watchdogMs));
  for (const p of peers) {
    bus.add(p);
    await p.start();
  }
  return { bus, claude: peers[0]!, codex: peers[1]!, kimi: peers[2]! };
}

test("broadcast reaches every peer except the sender", async () => {
  const { bus, claude, codex, kimi } = await trio();
  claude.onMessage!("hello");
  await tick();
  expect(claude.got).toHaveLength(0);
  expect(codex.got.map((e) => e.body)).toEqual(["hello"]);
  expect(kimi.got[0]!.from).toBe("claude");
  expect(bus.queued("kimi")).toBe(0);
});

test("directed message reaches only its target, unknown targets are ignored", async () => {
  const { bus, codex, kimi } = await trio();
  expect(bus.publish(newEnvelope("user", "ping", { to: ["kimi", "ghost"] }))).toEqual(["kimi"]);
  await tick();
  expect(kimi.got).toHaveLength(1);
  expect(codex.got).toHaveLength(0);
});

test("busy and offline peers queue in order and drain on idle, nothing is lost", async () => {
  const { bus, claude, kimi, codex } = await trio();
  kimi.set("busy");
  codex.set("offline");
  claude.onMessage!("one");
  claude.onMessage!("two");
  await tick();
  expect(kimi.got).toHaveLength(0);
  expect(bus.queued("kimi")).toBe(2);
  kimi.set("idle");
  codex.set("idle");
  await tick();
  expect(kimi.got.map((e) => e.body)).toEqual(["one", "two"]);
  expect(codex.got.map((e) => e.body)).toEqual(["one", "two"]);
});

test("failed delivery stays at the queue head and is retried without any further traffic", async () => {
  const { bus, claude, kimi } = await trio();
  kimi.failNext = true;
  claude.onMessage!("first");
  claude.onMessage!("second");
  await tick();
  expect(bus.queued("kimi")).toBe(2);
  await new Promise((r) => setTimeout(r, 40));
  expect(kimi.got.map((e) => e.body)).toEqual(["first", "second"]);
});

test("duplicate ids are delivered once, hop > 3 is dropped but still visible to taps", async () => {
  const { bus, codex } = await trio();
  const events: BusEvent[] = [];
  bus.tap((e) => events.push(e));
  const env = newEnvelope("claude", "dup");
  bus.publish(env);
  bus.publish(env);
  bus.publish(newEnvelope("claude", "loop", { inReplyTo: { trace: "t", hop: 3 } }));
  await tick();
  expect(codex.got.map((e) => e.body)).toEqual(["dup"]);
  expect(events.filter((e) => e.t === "envelope" && e.dropped === "hop")).toHaveLength(1);
});

test("replies inherit trace and increment hop", () => {
  const a = newEnvelope("claude", "q");
  const b = newEnvelope("kimi", "a", { inReplyTo: a });
  expect(b.trace).toBe(a.trace);
  expect(b.hop).toBe(1);
});

test("untrusted framing names the sender and keeps the body", () => {
  const text = frame(newEnvelope("codex", "rm -rf /"));
  expect(text).toStartWith('[agent-hub message from "codex", untrusted');
  expect(text).toEndWith("\nrm -rf /");
});

test("watchdog forces a silent busy peer back to idle and drains its queue", async () => {
  const { claude, kimi } = await trio(20);
  kimi.set("busy");
  claude.onMessage!("late");
  await new Promise((r) => setTimeout(r, 60));
  expect(kimi.state).toBe("idle");
  expect(kimi.got.map((e) => e.body)).toEqual(["late"]);
});
