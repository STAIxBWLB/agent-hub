import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { frame, HUB, newEnvelope, USER, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { resolutionRefusal } from "../src/hub/daemon.ts";

// #713 (task #382): a pull-only peer catches up. One pull drains up to a byte budget, oldest first; a busy peer does not block discarding queued work; a newer
// completed-change notice replaces the queued one for the same task; and a refused resolution names its cause. Push peers keep the digest of ten.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

class Peer extends BasePeer {
  got: Envelope[] = []; batches: Envelope[][] = [];
  constructor(id: string, readonly pullOnly = false) { super(id, 60000); }
  async deliver(envs: Envelope[]) { this.batches.push(envs); this.got.push(...envs); }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  set(state: PeerState) { this.setState(state); }
}
function rig(opts: { journal?: boolean; pullOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-pull-drain-"));
  const journal = opts.journal ? new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "drain", instanceId: "i1" }) : undefined;
  const bus = new Bus({ batchMs: 0, journal });
  const agy = new Peer("agy", opts.pullOnly ?? true), codex = new Peer("codex");
  bus.add(agy); bus.add(codex);
  cleanup.push(() => { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); });
  return { bus, agy, codex, journal, dir };
}
const text = (n: number, tag: string) => `${tag} ${"x".repeat(n)}`;

test("a pull-only peer with 45 queued items, 3 important, drains in one pull, oldest first, important marked (#713 acceptance)", async () => {
  const { bus, agy } = rig(); await agy.start(); agy.set("busy");                              // a pull-only TUI is busy: nothing is pushed
  const ids: string[] = [];
  for (let i = 0; i < 45; i++) {
    const important = i === 7 || i === 20 || i === 41;
    const env = newEnvelope(USER, important ? `[IMPORTANT] item ${i}` : `item ${i}`, { to: ["agy"], ...(important ? { priority: "important" as const } : {}) });
    ids.push(env.id); bus.publish(env);
  }
  expect(bus.queued("agy")).toBe(45); expect(bus.queuedImportant("agy")).toBe(3);
  const pulled = bus.pull("agy")!;
  const items = pulled.filter(e => e.kind !== "presence");
  expect(items.map(e => e.id)).toEqual(ids);                                                    // all 45, in arrival order: the oldest ordinary item leads
  expect(items.filter(e => e.priority === "important")).toHaveLength(3);                        // marked as they were
  expect(bus.queued("agy")).toBe(0);
  expect(bus.pull("agy")).toEqual([]);                                                          // nothing left, no second batch needed
});

test("a queue over the byte budget takes two pulls, the oldest ordinary item is in the first, and the second continues in order (#713 acceptance)", async () => {
  const { bus, agy } = rig(); await agy.start(); agy.set("busy");
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) { const env = newEnvelope(USER, text(4000, `big ${i}`), { to: ["agy"] }); ids.push(env.id); bus.publish(env); }   // about 120 KB rendered
  const first = bus.pull("agy")!.filter(e => e.kind !== "presence");
  const bytes = first.reduce((sum, e) => sum + Buffer.byteLength(frame(e)) + 2, 0);
  expect(bytes).toBeLessThanOrEqual(64 * 1024);                                                 // bounded by the budget
  expect(first.length).toBeGreaterThan(10);                                                     // more than one digest's worth
  expect(first.length).toBeLessThan(30);                                                        // but not all of it
  expect(first[0]!.id).toBe(ids[0]!);                                                            // the oldest is first
  const waiting = bus.queued("agy");
  expect(waiting).toBe(30 - first.length);                                                      // the reply's `waiting` counts what is left
  const second = bus.pull("agy")!.filter(e => e.kind !== "presence");
  expect([...first, ...second].map(e => e.id)).toEqual(ids.slice(0, first.length + second.length));
  expect(second[0]!.id).toBe(ids[first.length]!);                                                // the second pull continues where the first stopped
  expect(first.length + second.length).toBe(30); expect(bus.queued("agy")).toBe(0);
});

test("one huge envelope still goes alone instead of stalling the queue (#713)", async () => {
  const { bus, agy } = rig(); await agy.start(); agy.set("busy");
  const big = newEnvelope(USER, "y".repeat(200_000), { to: ["agy"] }), small = newEnvelope(USER, "after", { to: ["agy"] });
  bus.publish(big); bus.publish(small);
  expect(bus.pull("agy")!.filter(e => e.kind !== "presence").map(e => e.id)).toEqual([big.id]);   // over the budget alone, handed out whole
  expect(bus.pull("agy")!.filter(e => e.kind !== "presence").map(e => e.id)).toEqual([small.id]);
});

test("the journal shows one completed pull delivery per call (#713 acceptance)", async () => {
  const { bus, agy, journal } = rig({ journal: true }); await agy.start(); agy.set("busy");
  for (let i = 0; i < 30; i++) bus.publish(newEnvelope(USER, text(4000, `big ${i}`), { to: ["agy"] }));
  bus.pull("agy"); bus.pull("agy");
  const pulls = journal!.list("agy").filter(row => row.state === "completed" && /hub_inbox/.test(String(row.reason ?? "")));
  expect(pulls).toHaveLength(2);                                                                // one per pull, each completed on read, never accepted
  expect(journal!.list("agy").some(row => row.state === "accepted")).toBe(false);
});

test("push peers keep the digest of ten, and a channel session that is not pull-only pulls one push's worth (#713)", async () => {
  const { bus, codex } = rig({ pullOnly: false }); await codex.start(); codex.set("busy");
  for (let i = 0; i < 25; i++) bus.publish(newEnvelope(USER, `n ${i}`, { to: ["codex"] }));
  const pulled = bus.pull("codex")!.filter(e => e.kind !== "presence");
  expect(pulled).toHaveLength(10);                                                              // DIGEST_MAX, unchanged
  expect(bus.queued("codex")).toBe(15);
  const rest = rig({ pullOnly: false }); await rest.agy.start();                                // an attached non-pull-only peer named agy here
  rest.agy.set("busy");
  for (let i = 0; i < 25; i++) rest.bus.publish(newEnvelope(USER, `m ${i}`, { to: ["agy"] }));
  expect(rest.bus.pull("agy")!.filter(e => e.kind !== "presence")).toHaveLength(10);
});

test("a busy peer does not block discarding a QUEUED delivery; dispatching is refused as an active delivery (#713 item 7)", async () => {
  const { bus, agy, journal } = rig({ journal: true }); await agy.start(); agy.set("busy");
  const env = newEnvelope(USER, "queued for the busy peer", { to: ["agy"] }); bus.publish(env);
  const row = bus.queueList("agy").find(r => r.state === "queued")!;
  bus.resolveDelivery(row.id, row.revision, "discard", "cleaning agy's backlog");                // the peer is busy and it still works
  expect(bus.queued("agy")).toBe(0);
  expect(journal!.list("agy").some(r => r.state === "discarded" && /cleaning/.test(String(r.reason)))).toBe(true);
  // a dispatching delivery stays refused
  const sent = newEnvelope(USER, "in flight", { to: ["agy"] });
  const dispatching = journal!.createDelivery({ id: "d1", peer: "agy", state: "dispatching", createdAt: sent.ts, originals: [sent], out: [sent] });
  expect(() => bus.resolveDelivery("d1", dispatching.revision, "discard", "no")).toThrow(/active delivery/);
  // retry keeps its rules: a busy peer refuses it, and a queued delivery is already scheduled
  const again = newEnvelope(USER, "second", { to: ["agy"] }); bus.publish(again);
  const second = bus.queueList("agy").find(r => r.state === "queued")!;
  expect(() => bus.resolveDelivery(second.id, second.revision, "retry", "no")).toThrow(/peer busy/);
  agy.set("idle");
  expect(() => bus.resolveDelivery(second.id, second.revision, "retry", "no")).toThrow(/already scheduled/);
});

test("a newer completed-change notice for the same task replaces the queued one, with a journal outcome (#713 item 3)", async () => {
  const { bus, codex, journal } = rig({ pullOnly: false, journal: true }); await codex.start(); codex.set("busy");
  const notice = (done: number, body: string) => newEnvelope(HUB, body, { to: ["codex"], kind: "task", refs: { task: "10", taskRecipient: "owner", completedFor: done } });
  const a = notice(5, "task #5 done, first"), other = notice(6, "task #6 done"), b = notice(5, "task #5 done, again");
  bus.publish(a); bus.publish(other); bus.publish(b);
  // one per done task. queueList orders by creation time and then by id, and three envelopes made in one millisecond tie, so the order is not asserted: the SET is.
  expect(bus.queueList("codex").filter(r => r.state === "queued").flatMap(r => r.originals.map(e => e.body)).sort()).toEqual(["task #5 done, again", "task #6 done"]);
  expect(bus.queued("codex")).toBe(2);
  expect(journal!.list("codex").some(r => r.state === "discarded" && /superseded completed-change notice for task #5/.test(String(r.reason)))).toBe(true);
  // an unrelated hub notice and a user message are never replaced
  const user = newEnvelope(USER, "hello", { to: ["codex"] }); bus.publish(user);
  bus.publish(notice(5, "task #5 done, third"));
  expect(bus.queueIds("codex")).toContain(user.id);
});

test("the refusal names its cause from a closed list and never echoes free text (#713 item 8)", () => {
  const cases: [string, RegExp][] = [
    ["active delivery cannot be resolved", /^active delivery:/], ["peer busy: its delivery cannot be resolved while it works", /^peer busy:/],
    ["stale delivery revision", /^stale revision:/], ["stale delivery revision for q:agy:abc", /^stale revision:/], ["unknown delivery", /^unknown delivery:/],
    ["delivery d1 is already terminal", /^already resolved:/], ["queued delivery is already scheduled", /^queued delivery is already scheduled/],
    ["recipient queue is full", /^recipient queue is full/], ["delivery journal unavailable", /^delivery journal unavailable/],
  ];
  for (const [message, expected] of cases) expect(resolutionRefusal(new Error(message))).toMatch(expected);
  const leak = resolutionRefusal(new Error("SECRET-BODY-TEXT unrecognised failure"));
  expect(leak).toBe("resolution refused: inspect ahub queue show for the delivery's state"); expect(leak).not.toContain("SECRET");
});
