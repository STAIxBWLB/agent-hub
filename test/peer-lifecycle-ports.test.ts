import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasePeer, type PeerAdapter } from "../src/hub/peers.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { WsPeer } from "../src/adapters/channel-peer.ts";
import { AcpPeer } from "../src/adapters/acp.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { renderHeldHint } from "../src/hub/delivery-hints.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class PlainPeer extends BasePeer {
  stops: (string | undefined)[] = [];
  async start() { this.setState("idle"); }
  async stop(reason?: string) { this.stops.push(reason); this.setState("offline"); }
  async deliver(_envs: Envelope[], id?: string) { if (id) this.delivery({ id, state: "needs_review" }); }
  offline() { this.setState("offline"); }
}
function ports<T extends PeerAdapter>(peer: T, values: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(peer, key, { configurable: true, value });
  return peer;
}
async function fixture(peer: PeerAdapter, genericAcp = false) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-lifecycle-ports-"));
  mkdirSync(join(cwd, ".agenthub"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, batch_ms: 0, roster: { ...DEFAULT_CONFIG.roster, [peer.id]: true },
      ...(genericAcp ? { adapters: { fixture: { transport: "acp" as const, command: "fixture-never-started", args: [], displayName: "Fixture", roles: ["implementer"] } } } : {}),
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false },
      approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  writeFileSync(join(cwd, ".agenthub", "config.json"), JSON.stringify(config));
  const daemon = await startDaemon({ cwd, stateDir: join(cwd, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(join(cwd, "state"), { role: "console" });
  cleanup.push(() => client.close());
  daemon.bus.add(peer); await peer.start();
  return { daemon, client, cwd, stop: () => client.request({ t: "peer_stop", peer: peer.id }),
    roster: (value: boolean) => client.request({ t: "settings_set", key: `roster.${peer.id}`, value, confirm: peer.id }) };
}

for (const value of [true, undefined, false, "absent"] as const) test(`#625 deliveryOnly ${String(value)} controls recipient retry and its hint on a plain peer`, async () => {
  const peer = new PlainPeer("local");
  if (value !== "absent") ports(peer, { deliveryOnly: value });
  const f = await fixture(peer);
  const tools = await ControlClient.connect(join(f.cwd, "state"), { role: "tools", peer: peer.id });
  cleanup.push(() => tools.close());
  f.daemon.bus.publish(newEnvelope("user", "held fixture", { to: [peer.id] }));
  for (let i = 0; i < 100 && !f.daemon.bus.queueList(peer.id).some(row => row.state === "needs_review"); i++) await Bun.sleep(5);
  const held = f.daemon.bus.queueList(peer.id).find(row => row.state === "needs_review"); expect(held).toBeDefined();
  const permitted = value === false || value === "absent";
  // The in-process callback adds this host hint; the control task reply deliberately does not.
  const source = readFileSync(new URL("../src/hub/daemon.ts", import.meta.url), "utf8");
  const begin = source.indexOf("  const deliveryRetryAllowed ="), end = source.indexOf("  /** A model-written peer argument", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const hint = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end)) + "\nownHeldHint", { bus: f.daemon.bus, renderHeldHint, Date });
  expect(hint(peer.id)).toContain(permitted ? "Use hub_delivery_retry" : "Ask the person to resolve");
  const retried = await tools.request({ t: "task", op: "hub_delivery_retry", args: { delivery_id: held!.id } });
  expect(retried.ok).toBe(permitted);
  if (!permitted) expect(retried.error).toContain("delivery-only peers require the person");
});

test("#625 plain hubOwned peers stop and capture idle resume evidence without native inheritance", async () => {
  let captures = 0;
  const peer = ports(new PlainPeer("local"), { hubOwned: true, captureResume: async () => { captures++; return {}; } });
  const f = await fixture(peer);
  expect(await f.stop()).toMatchObject({ ok: true, state: "offline" });
  expect(captures).toBe(1); expect(peer.stops).toEqual(["requested stop: ahub stop local"]);
});

for (const value of [undefined, false, "absent"] as const) test(`#625 hubOwned ${String(value)} never grants stop authority`, async () => {
  const peer = new PlainPeer("local"); if (value !== "absent") ports(peer, { hubOwned: value });
  const f = await fixture(peer);
  expect(await f.stop()).toMatchObject({ ok: false, error: "unknown or non-owned peer; run ahub status and choose a hub-owned headless peer" });
  expect(peer.stops).toEqual([]);
});

for (const form of ["tui", undefined] as const) test(`#625 plain form ${String(form)} refuses a hub-owned stop`, async () => {
  const peer = ports(new PlainPeer("local"), { hubOwned: true, form }), f = await fixture(peer);
  const result = await f.stop(); expect(result.ok).toBe(false);
  expect(result.error).toBe(form === "tui" ? `${definitionOf("local")!.displayName} belongs to a native TUI terminal; end it in its terminal` : "peer form is unknown; refresh ahub status before stopping it");
  expect(peer.stops).toEqual([]);
});

test("#625 pendingOwnedProcess admits an offline generic owner to teardown", async () => {
  const peer = ports(new PlainPeer("local"), { hubOwned: true, pendingOwnedProcess: true }), f = await fixture(peer);
  peer.offline(); expect(await f.stop()).toMatchObject({ ok: true, state: "offline" });
  expect(peer.stops).toHaveLength(1);
});

for (const pendingOwnedProcess of [true, undefined]) test(`#625 generic ACP retained ${String(pendingOwnedProcess)} process evidence refuses replacement`, async () => {
  const peer = ports(new PlainPeer("fixture"), { pendingOwnedProcess }), f = await fixture(peer, true);
  peer.offline();
  expect(await f.client.request({ t: "start", peer: peer.id })).toMatchObject({ ok: false, error: "configured ACP previous process teardown is unconfirmed; retry ahub stop before starting again" });
  expect(f.daemon.bus.peers.get(peer.id)).toBe(peer);
});

for (const form of ["tui", "headless", "absent"] as const) test(`#625 roster detach and resume dispatch by generic ports with form ${form}`, async () => {
  const peer = new PlainPeer("local"), detached: string[] = []; let resumed = 0;
  ports(peer, { hubOwned: true, detachForRoster: (mode: string) => { detached.push(mode); peer.offline(); }, resumeFromRoster: async () => { resumed++; } });
  if (form !== "absent") ports(peer, { form });
  const f = await fixture(peer);
  expect(await f.roster(false)).toMatchObject({ ok: true });
  expect(detached).toEqual(form === "headless" ? [] : ["ask"]);
  expect(peer.stops).toHaveLength(form === "headless" ? 1 : 0);
  expect(await f.roster(true)).toMatchObject({ ok: true });
  expect(resumed).toBe(form === "headless" ? 0 : 1);
});

test("#625 a plain peer without roster detach takes the owned stop path", async () => {
  const peer = ports(new PlainPeer("local"), { hubOwned: true }), f = await fixture(peer);
  expect(await f.roster(false)).toMatchObject({ ok: true }); expect(peer.stops).toHaveLength(1);
});

test("#625 ACP and channel owners keep byte-identical Kimi stop notices", async () => {
  for (const [owner, expected] of [
    [new WsPeer("kimi"), "Kimi belongs to its own TUI terminal; end it in that terminal"],
    [new AcpPeer("kimi", { cwd: "/unopened/fixture", cmd: ["fixture-never-started"] }), "peer is already offline; start it with ahub kimi before stopping it"],
  ] as const) {
    // Construct real owners without starting a native runtime; stop refusal needs no native process.
    const f = await fixture(new PlainPeer("kimi")); f.daemon.bus.add(owner);
    expect(await f.stop()).toMatchObject({ ok: false, error: expected });
  }
});

test("#625 Codex roster removal detaches while retaining its existing frontend proxy", async () => {
  const f = await fixture(new PlainPeer("codex"));
  const owner = new CodexPeer("codex", { cwd: f.cwd, appPort: 0, proxyPort: 0, upstreamUrl: "ws://127.0.0.1:9" });
  f.daemon.bus.add(owner); await owner.start();
  const proxy = owner.proxyUrl;
  expect("form" in owner).toBe(false); expect("hubOwned" in owner).toBe(false);
  expect(await f.roster(false)).toMatchObject({ ok: true });
  expect(owner.proxyUrl).toBe(proxy);
  expect((await fetch(proxy.replace("ws:", "http:"))).status).toBe(200);
  expect(await f.stop()).toMatchObject({ ok: false, error: "this peer belongs to a native terminal; end it in its terminal" });
});

test("#625 generic pullOnly status and unknown unmanaged TUI form retain native permission refusal", async () => {
  const peer = ports(new PlainPeer("kimi"), { pullOnly: true, form: undefined }), f = await fixture(peer);
  const status = (await f.client.request({ t: "status" })).status;
  expect(status.peers.kimi.permissionNote).toBe(definitionOf("kimi")!.permission.unmanagedStatusNote);
  expect(await f.client.request({ t: "permission", peer: "kimi", mode: "ask-when-needed" })).toMatchObject({ ok: false, error: definitionOf("kimi")!.permission.unmanagedNote });
});

test("#625 ACP factory admission rejects a subclass that widens deliveryOnly before starting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-acp-port-admission-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub", "adapters"), { recursive: true });
  const marker = join(root, "unsafe-started");
  const source = `import {ADAPTER_API,AcpPeer} from "@staix/agent-hub/adapter";
import {writeFileSync} from "node:fs";
class Unsafe extends AcpPeer { deliveryOnly=false; async start(){writeFileSync(${JSON.stringify(marker)},"unsafe"); throw new Error("fixture start was reached");} }
export const definition={api:ADAPTER_API,kind:"fixture",family:"fixture",displayName:"Fixture",transport:"acp",roles:["implementer"],optional:true,defaultOnRoster:false,
trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{unmanaged:"fixture unmanaged"},
start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],
launch:ctx=>({cmd:"fixture-never-started",args:[],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"fixture",env:{}}}),
create:ctx=>new Unsafe(ctx.instance,{...ctx.daemon.acp,kind:ctx.instance,requireOwnedGroup:true,requireLoadSessionEcho:true})},
session:{idField:"sessionId",currentId:peer=>peer.sessionId},turnEnd:"adapter",cli:{command:"fixture",startWords:()=>["fixture"]},display:{palette:{fg:"white",bg:"black"}}};`;
  writeFileSync(join(root, ".agenthub", "adapters", "fixture.mjs"), source);
  writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({
    adapter_modules: [{ path: ".agenthub/adapters/fixture.mjs", sha256: createHash("sha256").update(source).digest("hex") }], roster: { fixture: true },
  }));
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, pi: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const stateDir = join(root, "state"), daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const status = (await client.request({ t: "status" })).status;
  expect(status.externalAdapterRefusals ?? []).toEqual([]);
  expect(status.externalAdapters).toContainEqual({ kind: "fixture", displayName: "Fixture" });
  const started = await client.request({ t: "start", peer: "fixture" });
  expect(started.ok).toBe(false); expect(started.error).toContain("ACP factory did not return its bound native transport");
  expect(existsSync(marker)).toBe(false);
  expect(daemon.bus.peers.has("fixture")).toBe(false);
});
