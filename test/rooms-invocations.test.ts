import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { buildCapability, type CapabilityManifest } from "../src/hub/capabilities.ts";
import { argsDigest, InvocationLedger } from "../src/hub/invocations.ts";
import { replyParent, replyAudience, type Envelope } from "../src/hub/envelope.ts";
import { RoomLink } from "../src/rooms/link.ts";
import { RoomStore } from "../src/rooms/store.ts";
import { startBroker } from "../src/broker/server.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean, label: string) => { for (let i = 0; i < 1000 && !condition(); i++) await Bun.sleep(5); expect(condition(), label).toBe(true); };
const capability = buildCapability({ kind: "command", name: "probe", source: "published", invoke: "prompt", sideEffect: "read", description: "Public read probe",
  inputSchema: { type: "object", properties: { input: { type: "string" }, z: { type: "string" } }, required: ["input"], additionalProperties: false } })!;
class Sink extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push(...envs); if (id) this.delivery({ id, state: "completed" }); }
}
class Probe extends Sink {
  readonly manifest: CapabilityManifest = { capabilities: [capability], observedAt: 1 };
  answer: string | undefined = "X6_PUBLIC_RESULT";
  uncertain = false;
  accept = true;
  onRequest?: (envs: Envelope[]) => void | Promise<void>;
  async capabilityManifest() { return this.manifest; }
  override async deliver(envs: Envelope[], id?: string) {
    this.got.push(...envs); this.setState("busy");
    if (id && this.accept) this.delivery({ id, state: "accepted" });
    await this.onRequest?.(envs);
    if (this.answer !== undefined) this.onMessage?.(this.answer, { inReplyTo: replyParent(envs), to: replyAudience(envs) });
    if (id) this.delivery({ id, state: this.uncertain ? "needs_review" : "completed" });
    this.setState("idle");
  }
}
async function command(client: ControlClient, action: string, input: Record<string, unknown>) {
  const preview = await client.request({ t: "room", op: "preview", action, input }); expect(preview.ok, JSON.stringify(preview)).toBe(true);
  const result = await client.request({ t: "room", op: "execute", ticket: preview.ticket, confirm: preview.member }); expect(result.ok, JSON.stringify(result)).toBe(true); return result;
}
async function mesh(options: { sourcePin?: boolean; targetPin?: boolean; targetClass?: string; digest?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-x6-daemons-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const broker = await startBroker({ stateDir: join(root, "broker"), port: 0 }); cleanup.push(() => broker.stop());
  const side = async (label: string, peer: Sink, share: Record<string, unknown>) => {
    const cwd = join(root, label); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
    writeFileSync(join(cwd, ".agenthub/config.local.json"), JSON.stringify({ rooms: { work: { expose: [peer.id] } }, invocation: { share } }));
    const stateDir = join(cwd, "state");
    const daemon = await startDaemon({ cwd, stateDir, configWatch: false, invocationSweepMs: 20, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, invocation: { share: share as never, timeout_s: 10 }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
        omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
    cleanup.push(() => daemon.stop()); daemon.bus.add(peer); await peer.start();
    const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer: peer.id }); cleanup.push(() => tools.close());
    const ledger = new InvocationLedger(join(stateDir, "hub.db")); cleanup.push(() => ledger.close());
    return { cwd, stateDir, daemon, person, tools, ledger, peer };
  };
  const caller = new Sink("codex"), callee = new Probe("kimi");
  const a = await side("alpha", caller, options.sourcePin === false ? {} : { "kimi@beta": { [capability.id]: { digest: options.digest ?? capability.digest, class: "read" } } });
  const b = await side("beta", callee, options.targetPin === false ? {} : { kimi: { [capability.id]: { digest: capability.digest, class: options.targetClass ?? "read" } } });
  await command(a.person, "create", { name: "work", broker: broker.publicUrl, label: "alpha" });
  await command(a.person, "expose", { name: "work", peers: ["codex"] });
  const invite = await command(a.person, "invite", { name: "work" });
  const request = await command(b.person, "join", { name: "work", label: "beta", token: invite.artifact });
  const roster = await command(a.person, "invite", { name: "work", request: request.artifact });
  await command(b.person, "join", { name: "work", roster: roster.artifact });
  await until(() => a.daemon.bus.stateOf("kimi@beta") === "idle" && b.daemon.bus.stateOf("codex@alpha") === "idle", "both signed room peers online");
  const invoke = (args: Record<string, unknown> = { input: "public diff" }) => a.tools.request({ t: "task", op: "hub_invoke", args: { peer: "kimi@beta", capability: capability.id, args } });
  return { a, b, caller, callee, invoke, broker };
}

test("X6 real broker/crypto with two daemons relays one double-pinned read and one caller-only result", async () => {
  const f = await mesh();
  const response = await f.invoke(); expect(response.ok, JSON.stringify(response)).toBe(true);
  const id = JSON.parse(response.text).invocation;
  await until(() => f.a.ledger.get(id)?.outcome === "completed", "source capability result");
  expect(f.callee.got.filter(env => env.kind === "invocation")).toHaveLength(1);
  const target = f.callee.got.find(env => env.kind === "invocation")!;
  expect(target.from).toBe("hub"); expect(target.id).not.toBe(id); expect(target.trace).toBe(f.a.ledger.get(id)!.trace);
  expect(f.b.ledger.relay(target.id)).toMatchObject({ request: id, direction: "inbound", caller: "codex", target: "kimi" });
  await until(() => f.caller.got.some(env => env.kind === "invocation_result"), "caller result delivery");
  expect(f.caller.got.filter(env => env.kind === "invocation_result")).toHaveLength(1);
  await until(() => f.b.ledger.relay(target.id)?.state === "completed", "result transport signed acknowledgement");
  expect(f.a.daemon.bus.isHeld("kimi@beta")).toBe(false);
  expect(f.caller.got[0]!.body).toContain("X6_PUBLIC_RESULT"); expect(f.caller.got[0]!.body).toContain("kimi@beta");
  for (const side of [f.a, f.b]) for (const name of ["events.jsonl", "hub.log", "status.json"]) expect(readFileSync(join(side.stateDir, name), "utf8")).not.toContain("X6_PUBLIC_RESULT");
});

test("X6 non-alphabetical argument insertion order relays once with matching source and target digests", async () => {
  const f = await mesh(), args = { z: "last", input: "first" };
  expect(Object.keys(args)).toEqual(["z", "input"]);
  const response = await f.invoke(args); expect(response.ok, JSON.stringify(response)).toBe(true);
  const id = JSON.parse(response.text).invocation;
  await until(() => f.a.ledger.get(id)?.outcome === "completed", "source result for unsorted args");
  const requests = f.callee.got.filter(env => env.kind === "invocation"); expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toContain('Arguments: {"input":"first","z":"last"}');
  const digest = argsDigest({ input: "first", z: "last" });
  expect(f.a.ledger.get(id)?.argsSha256).toBe(digest); expect(f.b.ledger.get(requests[0]!.id)?.argsSha256).toBe(digest);
  await until(() => f.caller.got.some(env => env.kind === "invocation_result"), "unsorted argument caller result");
  expect(f.caller.got.filter(env => env.kind === "invocation_result")).toHaveLength(1);
  expect(f.caller.got.find(env => env.kind === "invocation_result")!.body).toContain("X6_PUBLIC_RESULT");
});

for (const options of [{ sourcePin: false }, { targetPin: false }, { targetClass: "write" }, { targetClass: "external" }, { digest: "sha256:" + "d".repeat(64) }]) test(`X6 requires both current read pins ${JSON.stringify(options)}`, async () => {
  const f = await mesh(options), response = await f.invoke();
  if (response.ok) { const id = JSON.parse(response.text).invocation; await until(() => f.a.ledger.get(id)?.outcome === "refused", "target hub refusal"); }
  else expect(response.error).toMatch(/shared|read|pin/);
  expect(f.callee.got).toEqual([]); expect(f.b.ledger.countOpen()).toBe(0);
});

test("X6 target validates its actual native schema before any native dispatch", async () => {
  const f = await mesh(), response = await f.invoke({ another: "source shape permits this key, target schema does not" });
  expect(response.ok).toBe(true); const id = JSON.parse(response.text).invocation;
  await until(() => f.a.ledger.get(id)?.outcome === "refused", "actual target schema refusal"); expect(f.callee.got).toEqual([]);
});

for (const accept of [true, false]) test(`X6 depth two is refused while a remote invocation turn is open, nativeAccepted=${accept}`, async () => {
  const f = await mesh(); f.callee.accept = accept; let nested: Promise<any> | undefined;
  f.callee.onRequest = async () => { nested = f.b.tools.request({ t: "task", op: "hub_invoke", args: { peer: "codex@alpha", capability: capability.id, args: { input: "nested" } } }); await nested; };
  const first = await f.invoke(); expect(first.ok).toBe(true);
  await until(() => !!nested, "target attempts nested remote call");
  const response = await nested!; expect(response.ok).toBe(false); expect(response.error).toMatch(/do not nest/);
  const id = JSON.parse(first.text).invocation; await until(() => f.a.ledger.get(id)?.outcome === "completed", "original read completes after nested refusal");
});


test("X6 an uncertain native receipt reaches source needs_review and never silently replays", async () => {
  const f = await mesh(); f.callee.answer = undefined; f.callee.uncertain = true;
  const response = await f.invoke(); expect(response.ok).toBe(true); const id = JSON.parse(response.text).invocation;
  await until(() => f.a.ledger.get(id)?.outcome === "needs_review", "uncertain source result");
  expect(f.callee.got.filter(env => env.kind === "invocation")).toHaveLength(1);
  expect(f.a.daemon.bus.isHeld("kimi@beta")).toBe(true); expect(f.b.daemon.bus.isHeld("kimi")).toBe(true);
});

test("X6 a lost capability result becomes needs_review even after signed request admission", async () => {
  const f = await mesh(); f.callee.answer = undefined;
  const response = await f.invoke(); expect(response.ok).toBe(true); const id = JSON.parse(response.text).invocation;
  await until(() => f.a.ledger.relay(id)?.state === "admitted", "signed request admission is not a capability result");
  const db = new Database(join(f.a.stateDir, "hub.db")); db.run("UPDATE invocations SET deadline=1 WHERE id=?", id); db.close();
  await until(() => f.a.ledger.get(id)?.outcome === "needs_review", "remote result deadline");
  expect(f.a.daemon.bus.isHeld("kimi@beta")).toBe(true); expect(f.callee.got.filter(env => env.kind === "invocation")).toHaveLength(1);
});

test("X6 unsafe arguments are refused before relay and private target answers are withheld", async () => {
  const f = await mesh();
  const refused = await f.invoke({ input: "patient 900101-1234567" }); expect(refused.ok).toBe(false); expect(f.callee.got).toEqual([]);
  f.callee.answer = "private result 900101-1234567";
  const response = await f.invoke(); expect(response.ok).toBe(true); const id = JSON.parse(response.text).invocation;
  await until(() => f.a.ledger.get(id)?.outcome === "withheld", "private target answer withheld");
  await until(() => f.caller.got.some(env => env.kind === "invocation_result"), "fixed withheld result");
  expect(JSON.stringify(f.caller.got)).not.toContain("900101-1234567");
  for (const side of [f.a, f.b]) for (const name of ["events.jsonl", "hub.log", "status.json"]) expect(readFileSync(join(side.stateDir, name), "utf8")).not.toContain("900101-1234567");
});


test("X6 authenticated duplicate wire requests do not execute again", async () => {
  const f = await mesh(); let replay!: () => Promise<string>, requestId = "", duplicate = false;
  const publish = RoomLink.prototype.publishApplication, incoming = RoomStore.prototype.applicationIncoming;
  const sender = spyOn(RoomLink.prototype, "publishApplication").mockImplementation(function(this: RoomLink, message, recipient, metadata, current) {
    if (message.type === "chat" && message.envelope.kind === "invocation" && metadata) {
      const copy = structuredClone(message), saved = { ...metadata, deliveryId: crypto.randomUUID() };
      requestId = message.envelope.id;
      replay = () => publish.call(this, copy, recipient, saved, () => true);
    }
    return publish.call(this, message, recipient, metadata, current);
  });
  const receiver = spyOn(RoomStore.prototype, "applicationIncoming").mockImplementation(async function(this: RoomStore, ...args) {
    const result = await incoming.apply(this, args);
    if (result.chat.id === requestId && !result.primary) duplicate = true;
    return result;
  });
  try {
    const response = await f.invoke(); expect(response.ok).toBe(true); const id = JSON.parse(response.text).invocation;
    await until(() => f.a.ledger.get(id)?.outcome === "completed", "first capability result");
    expect(typeof replay).toBe("function"); await replay();
    await until(() => duplicate, "durable application dedupe observed the signed duplicate");
    expect(f.callee.got.filter(env => env.kind === "invocation")).toHaveLength(1);
    expect(f.caller.got.filter(env => env.kind === "invocation_result")).toHaveLength(1);
  } finally { receiver.mockRestore(); sender.mockRestore(); }
});
