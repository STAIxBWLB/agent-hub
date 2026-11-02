import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { assign, loadRouting, type PeerCapabilities } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const task = (signals: string[] = []) => ({ class: "implement" as const, signals: signals as any });
const caps = (pi: Partial<PeerCapabilities>): Record<string, PeerCapabilities> => ({ pi: { tests: true, spec: true, ...pi }, codex: { tests: true, spec: true, network: true } });

test("a task that needs the network is never routed to a peer without it, and the trace says why (#1081 AC2)", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-network-")));
  const states = { pi: "idle", codex: "idle" } as any;
  const noNetwork = caps({ network: false, networkReason: "local.bash_network is off" });
  for (const nomination of [{}, { namedOwner: "pi" }, { candidates: ["pi"] }]) {
    const result = assign({ ...task(["needs_network"]), reserved: "pi" }, states, routing, { capabilities: noNetwork, ...nomination });
    expect(result.owner).not.toBe("pi");
    expect(result.refusals?.find(row => row.peer === "pi" && row.role === "owner")).toMatchObject({ code: "network" });
    expect(result.trace.join("\n")).toContain("no network: local.bash_network is off");
  }
  // the automatic route lands on a peer that has network
  expect(assign(task(["needs_network"]), states, routing, { capabilities: noNetwork }).owner).toBe("codex");
});

test("work that does not declare a network need, and a peer whose network is unknown, are not refused (#1081)", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-network-")));
  const states = { pi: "idle", codex: "idle" } as any;
  // no declared need: a peer without network still takes it
  expect(assign({ ...task(), reserved: "pi" }, states, routing, { capabilities: caps({ network: false }), namedOwner: "pi" }).owner).toBe("pi");
  // a declared need against an unknown network (no entry) is not a refusal
  expect(assign({ ...task(["needs_network"]), reserved: "pi" }, states, routing, { capabilities: caps({}), namedOwner: "pi" }).owner).toBe("pi");
  // a peer with network takes it
  expect(assign({ ...task(["needs_network"]), reserved: "pi" }, states, routing, { capabilities: caps({ network: true }), namedOwner: "pi" }).owner).toBe("pi");
});

async function rig(network: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-needs-network-"));
  mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), "[local]\nfixed_model=\"m\"\n[classes.implement]\npeers=[\"pi\",\"codex\"]\n");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); });
  for (const id of ["pi", "codex"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const live = { value: network };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: () => {}, wipLimit: () => 5,
    sdlc: { config: () => sdlcConfig({ mode: "off" }) },
    capabilities: () => ({ pi: { tests: true, spec: true, network: live.value, ...(live.value ? {} : { networkReason: "local.bash_network is off" }) }, codex: { tests: true, spec: true, network: true } }) });
  return { board, tasks, live };
}

test("hub_task_propose records needs_network as a signal, and a non-boolean is refused with the next step (#1081)", async () => {
  const { board, tasks } = await rig(true);
  const made = await tasks.propose("user", { title: "raise the agent-mem pin", class: "implement", needs_network: true });
  expect(board.get(made.id)!.signals).toContain("needs_network");
  const plain = await tasks.propose("user", { title: "rename a helper", class: "implement" });
  expect(board.get(plain.id)!.signals).not.toContain("needs_network");
  let failure: unknown;
  try { await tasks.propose("user", { title: "x", class: "implement", needs_network: "yes" as unknown as boolean }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("true or false");
  expect(board.list().length).toBe(2);
});

test("an explicit assignment of network work to a peer without network is refused before any write (#1081)", async () => {
  const { board, tasks } = await rig(false);
  const made = await tasks.propose("user", { title: "raise the pin", class: "implement", needs_network: true });
  const before = JSON.stringify(board.get(made.id));
  let failure: unknown;
  try { await tasks.assignTo(made.id, "pi"); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect((failure as Error).message).toContain("no network");
  expect(JSON.stringify(board.get(made.id))).toBe(before);
});

test("accept refuses network work when the owner's network went away after the offer, before any write, naming the next step (#1081)", async () => {
  const { board, tasks, live } = await rig(true);
  const row = board.propose("user", { title: "raise the pin", class: "implement", signals: ["needs_network"] });
  board.update(row.id, "user", "assigned", { owner: "pi" });
  live.value = false; // the sandbox network was switched off after the offer
  const before = JSON.stringify(board.get(row.id));
  let failure: unknown;
  try { tasks.accept("pi", row.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  const text = (failure as Error).message;
  expect(text).toContain("needs the network");
  expect(text).toContain("local.bash_network is off");
  expect(text).toContain("decline it");
  expect(JSON.stringify(board.get(row.id))).toBe(before);
  live.value = true;
  expect(() => tasks.accept("pi", row.id)).not.toThrow();
  expect(board.get(row.id)).toMatchObject({ state: "in_progress", owner: "pi" });
});

test("accept of ordinary work is unaffected by a peer without network (#1081)", async () => {
  const { board, tasks } = await rig(false);
  const row = board.propose("user", { title: "rename a helper", class: "implement" });
  board.update(row.id, "user", "assigned", { owner: "pi" });
  expect(() => tasks.accept("pi", row.id)).not.toThrow();
  expect(board.get(row.id)!.state).toBe("in_progress");
});

test("a reservation for a peer without network is refused at propose, before any write (#1081)", async () => {
  const { board, tasks } = await rig(false);
  const blocker = board.propose("user", { title: "must land first", class: "implement" });
  let failure: unknown;
  try { await tasks.propose("user", { title: "raise the pin", class: "implement", owner: "pi", after: [blocker.id], needs_network: true }); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect((failure as Error).message).toContain("no network");
  expect(board.list().length).toBe(1); // only the blocker; the refused reservation left no task behind
});
