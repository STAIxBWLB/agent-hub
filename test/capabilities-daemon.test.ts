import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { acpManifest, validatePublished, type CapabilityManifest } from "../src/hub/capabilities.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { projectToolList, profileTaskTools } from "../src/hub/hub-tools.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[]) {}
}
/** A stand-in for a native peer the hub reads itself: it answers `capabilityManifest` from a list the test sets. */
class Native extends Peer {
  manifest: CapabilityManifest = { capabilities: [], observedAt: 1 };
  failing = false;
  async capabilityManifest() { if (this.failing) throw new Error("no answer"); return this.manifest; }
}
const update = { availableCommands: [{ name: "skill:review", description: "Review the diff." }, { name: "skill:deploy", description: "Ship it." }] };
const nativeManifest = () => acpManifest("Kimi Code CLI", "2.3.2", update, 5);

async function fixture(share?: Record<string, Record<string, { digest: string; class?: string }>>) {
  const root = mkdtempSync(join(tmpdir(), "ahub-capabilities-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const r = hubGitSync(["-C", root, "init", "-q"], { encoding: "utf8" }); if (r.status) throw new Error("fixture git failed");
  const stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, native: false, enabled: false }, snapshots: { enabled: false, keep: 1 }, ...(share ? { invocation: { share } } : {}) } });
  cleanups.push(() => daemon.stop());
  const board = new Board(join(stateDir, "hub.db")); cleanups.push(() => board.close());
  const kimi = new Native("kimi"), codex = new Peer("codex"), pi = new Peer("pi");
  for (const p of [kimi, codex, pi]) { daemon.bus.add(p); await p.start(); }
  kimi.manifest = nativeManifest();
  const clients = new Map<string, ControlClient>();
  const call = async (by: string, op: string, args: Record<string, unknown> = {}) => {
    let client = clients.get(by);
    if (!client) { client = await ControlClient.connect(stateDir, by === "user" ? { role: "console" } : { role: "tools", peer: by }); clients.set(by, client); cleanups.push(() => client!.close()); }
    return client.request({ t: "task", op, args });
  };
  return { daemon, board, kimi, codex, pi, call };
}
const review = () => nativeManifest().capabilities.find(c => c.name === "skill:review")!;
const deploy = () => nativeManifest().capabilities.find(c => c.name === "skill:deploy")!;

test("nothing is listed to an agent until the person shares it, and then only what was shared", async () => {
  const none = await fixture();
  expect(JSON.parse((await none.call("codex", "hub_capabilities")).text).capabilities).toEqual([]);
  expect(JSON.parse((await none.call("codex", "hub_capabilities", { peer: "kimi" })).text).capabilities).toEqual([]);
  const f = await fixture({ kimi: { [review().id]: { digest: review().digest, class: "read" } } });
  const seen = JSON.parse((await f.call("codex", "hub_capabilities")).text);
  expect(seen.capabilities.map((c: any) => [c.peer, c.id, c.class, c.permission_mode, c.invoke])).toEqual([["kimi", "command:skill:review", "read", "ask", "native"]]);
  expect(JSON.stringify(seen)).not.toContain("deploy"); // an unshared entry is invisible to an agent
  expect(seen.capabilities[0].digest).toBe(review().digest);
  expect(JSON.parse((await f.call("codex", "hub_capabilities", { peer: "pi" })).text).capabilities).toEqual([]);
  expect(JSON.parse((await f.call("codex", "hub_capabilities", { peer: "Kimi" })).text).capabilities).toHaveLength(1); // ids are lowercase; "Kimi" means kimi
});

test("a changed digest unlists the entry, an unshared class cannot lower, and a native list that fails is no list", async () => {
  const f = await fixture({ kimi: { [review().id]: { digest: "sha256:" + "0".repeat(64), class: "read" }, [deploy().id]: { digest: deploy().digest } } });
  const seen = JSON.parse((await f.call("codex", "hub_capabilities")).text).capabilities;
  expect(seen.map((c: any) => c.id)).toEqual(["command:skill:deploy"]); // review's pin is stale
  expect(seen[0].class).toBe("destructive"); // shared with no class anywhere: listed, and refused later (O6)
  f.kimi.failing = true;
  expect(JSON.parse((await f.call("codex", "hub_capabilities")).text).capabilities).toEqual([]);
});

test("the person sees every entry with its share state, and an agent shell cannot ask for that view", async () => {
  const f = await fixture({ kimi: { [review().id]: { digest: review().digest, class: "write" }, [deploy().id]: { digest: "sha256:" + "1".repeat(64) } } });
  const view = JSON.parse((await f.call("user", "capabilities_list")).text);
  expect(view.peers.map((p: any) => p.peer)).toEqual(["kimi"]); // codex and pi list nothing
  expect(view.peers[0].entries.map((e: any) => [e.id, e.state, e.class])).toEqual([["command:skill:review", "listed", "write"], ["command:skill:deploy", "digest-changed", "destructive"]]);
  for (const by of ["codex", "kimi", "pi"]) { const r = await f.call(by, "capabilities_list"); expect(r.ok, by).toBe(false); expect(r.error).toContain("console command"); }
});

test("hub_capabilities is strict about its input", async () => {
  const f = await fixture();
  for (const args of [{ peer: 7 }, { peer: "../x" }, { peer: "kimi", extra: 1 }, { other: "kimi" }]) expect((await f.call("codex", "hub_capabilities", args)).ok, JSON.stringify(args)).toBe(false);
  expect((await f.call("codex", "hub_capabilities", { peer: "" })).ok).toBe(true);
});

test("a native peer that is offline, or whose list is empty, shows nothing to anyone", async () => {
  const f = await fixture({ kimi: { [review().id]: { digest: review().digest, class: "read" } } });
  expect(JSON.parse((await f.call("codex", "hub_capabilities")).text).capabilities).toHaveLength(1);
  f.kimi.manifest = { capabilities: [], observedAt: 2 };
  expect(JSON.parse((await f.call("user", "capabilities_list")).text).peers).toEqual([]); // a peer with nothing found is not a row
  expect(JSON.parse((await f.call("codex", "hub_capabilities")).text).capabilities).toEqual([]);
  f.kimi.manifest = nativeManifest();
  expect(JSON.parse((await f.call("codex", "hub_capabilities")).text).capabilities).toHaveLength(1);
  await f.kimi.stop(); // offline: its last list is not offered
  expect(JSON.parse((await f.call("codex", "hub_capabilities")).text).capabilities).toEqual([]);
  expect(JSON.parse((await f.call("user", "capabilities_list")).text).peers).toEqual([]);
});

const published = { capabilities: [{ kind: "skill", name: "lint", description: "Lint the tree.", sideEffect: "read" }] };

test("a session publishes its own capabilities, never shared until pinned, and a native peer cannot publish", async () => {
  const pin = validatePublished(published, 1).capabilities[0]!;
  const f = await fixture({ pi: { [pin.id]: { digest: pin.digest } } });
  expect(JSON.parse((await f.call("codex", "hub_capabilities", { peer: "pi" })).text).capabilities).toEqual([]); // pinned, but nothing published yet
  const ok = await f.call("pi", "hub_capabilities_publish", published);
  expect(ok.ok).toBe(true); expect(JSON.parse(ok.text).published).toBe(1);
  const seen = JSON.parse((await f.call("codex", "hub_capabilities", { peer: "pi" })).text).capabilities;
  expect(seen.map((c: any) => [c.id, c.class, c.invoke, c.source])).toEqual([["skill:lint", "read", "prompt", "published"]]); // forced to prompt, whatever it claimed
  const refused = await f.call("kimi", "hub_capabilities_publish", published);
  expect(refused.ok).toBe(false); expect(refused.error).toContain("reads kimi's capabilities itself");
  const g = await fixture();
  await g.call("pi", "hub_capabilities_publish", published);
  expect(JSON.parse((await g.call("codex", "hub_capabilities", { peer: "pi" })).text).capabilities).toEqual([]); // published but not pinned: invisible
  const view = JSON.parse((await g.call("user", "capabilities_list")).text);
  expect(view.peers.map((p: any) => [p.peer, p.entries[0].state])).toEqual([["kimi", "unshared"], ["pi", "unshared"]]); // the person still sees it
});

test("a bad publish stores nothing, replaces the earlier list when good, and a disconnect drops it", async () => {
  const f = await fixture();
  expect((await f.call("pi", "hub_capabilities_publish", published)).ok).toBe(true);
  for (const bad of [{}, { capabilities: [] }, { capabilities: [{ kind: "skill", name: "x y", description: "d", sideEffect: "read" }] }, { capabilities: [{ ...published.capabilities[0], extra: 1 }] }, { capabilities: published.capabilities, more: 1 }]) {
    expect((await f.call("pi", "hub_capabilities_publish", bad as never)).ok, JSON.stringify(bad)).toBe(false);
  }
  const names = async () => JSON.parse((await f.call("user", "capabilities_list")).text).peers.filter((p: any) => p.peer === "pi").flatMap((p: any) => p.entries.map((e: any) => e.name));
  expect(await names()).toEqual(["lint"]); // the refusals left the good list alone
  await f.call("pi", "hub_capabilities_publish", { capabilities: [{ kind: "command", name: "fmt", description: "Format.", sideEffect: "write" }] });
  expect(await names()).toEqual(["fmt"]); // replaced, not merged
  await f.pi.stop();
  await f.pi.start();
  expect(await names()).toEqual([]); // the new connection never published
  expect((await f.call("user", "hub_capabilities_publish", published)).ok).toBe(false); // the person is not a peer with a session
});

test("a published list is bound to its connection: a replaced peer object, or an offline peer, neither lists nor publishes", async () => {
  const pin = validatePublished(published, 1).capabilities[0]!;
  const f = await fixture({ pi: { [pin.id]: { digest: pin.digest } } });
  expect((await f.call("pi", "hub_capabilities_publish", published)).ok).toBe(true);
  expect(JSON.parse((await f.call("codex", "hub_capabilities", { peer: "pi" })).text).capabilities).toHaveLength(1);
  const again = new Peer("pi"); f.daemon.bus.add(again); await again.start(); // a new connection for the same id, with no offline event between
  expect(JSON.parse((await f.call("codex", "hub_capabilities", { peer: "pi" })).text).capabilities).toEqual([]);
  await again.stop();
  const refused = await f.call("pi", "hub_capabilities_publish", published);
  expect(refused.ok).toBe(false); expect(refused.error).toContain("attached session");
});

test("the read-only project tool list offers the read tool and never the publish tool", () => {
  expect(projectToolList(profileTaskTools(), true).map(t => t.name)).toContain("hub_capabilities");
  expect(projectToolList(profileTaskTools(), true).map(t => t.name)).not.toContain("hub_capabilities_publish");
  expect(projectToolList(profileTaskTools(), false).map(t => t.name)).toContain("hub_capabilities_publish");
});

test("neither call runs for a peer holding PII, and a read-only status stays unaffected", async () => {
  const f = await fixture();
  f.board.update(f.board.propose("user", { title: "private 900101-1234567", class: "implement", signals: ["pii"] } as never).id, "user", "accepted", { owner: "pi", state: "in_progress" });
  for (const [op, args] of [["hub_capabilities", {}], ["hub_capabilities_publish", published]] as const) {
    const r = await f.call("pi", op, args as never); expect(r.ok, op).toBe(false); expect(r.error).toContain("PII");
  }
  expect((await f.call("codex", "hub_capabilities")).ok).toBe(true); // another peer is not affected
});
