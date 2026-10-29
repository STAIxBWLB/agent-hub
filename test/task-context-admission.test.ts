import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { ContextWindows, type ContextConfig } from "../src/hub/context-window.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_messages: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-context-offer-"));
  const board = new Board(join(cwd, "hub.db"));
  const bus = new Bus({ batchMs: 0, deliveryHeld: () => true });
  for (const id of ["codex", "kimi", "claude"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const config: ContextConfig = { gate: 0.7, stale_min: 1, max_assignment_used: 0.8 };
  let now = 1_800_000_000_000;
  const sessions: Record<string, string> = { codex: "first", kimi: "first", claude: "first" }, crossings: string[] = [];
  const windows = new ContextWindows(config, peer => { crossings.push(peer); }, () => now);
  const roles: Record<string, string[]> = { claude: ["conductor", "planner"] };
  const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex","kimi"]\n[classes.review]\npeers=["claude"]\n');
  let mode: "off" | "advise" = "off";
  const tasks = new Tasks({ board, bus, routing: () => routing, cwd, project: "context-test", roles, notify: () => {}, now: () => now,
    contextAdmission: () => ({ policy: { max_used: config.max_assignment_used ?? 0, stale_min: config.stale_min }, peers: Object.fromEntries(Object.keys(sessions).map(peer => [peer, windows.admission(peer, sessions[peer], bus.stateOf(peer) !== "offline")])) }),
    sdlc: { config: () => ({ ...sdlcConfig(undefined), mode }) },
  });
  cleanup.push(() => { tasks.stopQueuePressureRechecks(); tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const report = (peer: string, used: number) => windows.report(peer, { source: "codex_token_usage", sessionId: sessions[peer]!, measuredAt: now, tokens: used * 100, window: 100, used }, sessions[peer]);
  return { board, bus, tasks, config, sessions, crossings, roles, report, advance: () => { now += 60_001; }, lifecycle: () => { mode = "advise"; } };
}

test("real new-work routing and explain share context refusal without changing an active owner or session", async () => {
  const f = await fixture();
  f.report("codex", 0.1);
  const active = await f.tasks.propose(HUB, { title: "existing", class: "implement" });
  await f.tasks.accept("codex", active.id);
  const before = f.board.get(active.id), queue = f.bus.queueIds("codex");
  f.report("codex", 0.9);
  const next = await f.tasks.propose(HUB, { title: "next", class: "implement" });
  expect(next.owner).toBe("kimi");
  expect(f.tasks.explain(next.id)).toContain("  owner candidate codex: skipped, context headroom: used 0.9 at or above max 0.8");
  expect(f.tasks.explain(next.id)).toContain("owner: kimi");
  expect(f.board.get(active.id)).toEqual(before);
  expect(f.bus.queueIds("codex")).toEqual(queue);
  expect(f.bus.stateOf("codex")).toBe("idle");
  expect(f.sessions.codex).toBe("first");
  expect(f.crossings).toEqual(["codex"]);
});

test("stale and replaced native sessions remain visibly unknown on actual assignment", async () => {
  const f = await fixture(); f.report("codex", 0.9); f.advance();
  const stale = await f.tasks.propose(HUB, { title: "stale", class: "implement" });
  expect(stale.owner).toBe("codex");
  expect(f.tasks.explain(stale.id).join()).toContain("context headroom: unknown");
  f.report("codex", 0.9); f.sessions.codex = "replacement";
  const replaced = await f.tasks.propose(HUB, { title: "new session", class: "implement" });
  expect(replaced.owner).toBe("codex");
  expect(f.tasks.explain(replaced.id).join()).toContain("context headroom: unknown");
});

test("manual person/conductor assignment and self-claim bypass only context admission", async () => {
  const f = await fixture(); f.report("codex", 1);
  for (const by of [USER, "claude"]) {
    const row = f.board.propose(HUB, { title: `manual ${by}`, class: "implement" });
    expect((await f.tasks.assignTo(row.id, "codex", by)).owner).toBe("codex");
  }
  const fresh = await fixture(); fresh.report("codex", 1);
  const claim = await fresh.tasks.propose("codex", { title: "claim", class: "implement", owner: "codex" });
  expect(claim.owner).toBe("codex"); expect(claim.state).toBe("in_progress");
  const named = await f.tasks.propose(HUB, { title: "named automatic", class: "implement", owner: "codex" });
  expect(named.owner).toBeNull();
});

test("default-off real offers ignore high occupancy and preserve checkpoint gate", async () => {
  const f = await fixture(); f.config.max_assignment_used = 0; f.report("codex", 1);
  const row = await f.tasks.propose(HUB, { title: "disabled", class: "implement" });
  expect(row.owner).toBe("codex");
  expect(f.tasks.explain(row.id).join()).not.toContain("context headroom");
  expect(f.crossings).toEqual(["codex"]);
});

test("context and manual conductor authority are re-read after awaited admission", async () => {
  const f = await fixture(); f.lifecycle(); f.report("codex", 1);
  const row = f.board.propose(HUB, { title: "barrier", class: "implement" });
  f.board.update(row.id, USER, "lifecycle", { sdlc: { stage: "build", planReview: { planner: "claude", planningRevision: 0, recordedAt: Date.now() } } });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(done => { entered = done; }), barrier = new Promise<void>(done => { release = done; });
  f.tasks.planReviewGap = async () => { entered(); await barrier; return undefined; };
  const pending = f.tasks.assignTo(row.id, "codex", "claude", true).then(value => ({ value }), error => ({ error }));
  await waiting; f.roles.claude = []; release();
  const result = await pending;
  expect("error" in result && String(result.error)).toContain("current configured conductor");
  expect(f.board.get(row.id)?.owner).toBeNull();
});

test("automatic owner admission uses a fresh reading after its awaited plan check", async () => {
  const f = await fixture(); f.lifecycle(); f.report("codex", 0.1);
  const row = f.board.propose("kimi", { title: "fresh admission", class: "implement" });
  f.board.update(row.id, USER, "lifecycle", { sdlc: { stage: "build", planReview: { planner: "claude", planningRevision: 0, recordedAt: Date.now() } } });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(done => { entered = done; }), barrier = new Promise<void>(done => { release = done; });
  f.tasks.planReviewGap = async () => { entered(); await barrier; return undefined; };
  const pending = f.tasks.assignTo(row.id, "codex", "kimi", true).then(value => ({ value }), error => ({ error }));
  await waiting; f.report("codex", 0.9); release();
  const result = await pending;
  expect("error" in result && String(result.error)).toContain("context headroom");
  expect(f.board.get(row.id)?.owner).toBeNull();
});

test("explicit person and conductor intent survives admission being enabled during the await", async () => {
  for (const actor of [USER, "claude"]) {
    const f = await fixture(); f.lifecycle(); f.config.max_assignment_used = 0; f.report("codex", 1);
    const row = f.board.propose(HUB, { title: `reload ${actor}`, class: "implement" });
    f.board.update(row.id, USER, "lifecycle", { sdlc: { stage: "build", planReview: { planner: "claude", planningRevision: 0, recordedAt: Date.now() } } });
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(done => { entered = done; }), barrier = new Promise<void>(done => { release = done; });
    f.tasks.planReviewGap = async () => { entered(); await barrier; return undefined; };
    const pending = f.tasks.assignTo(row.id, "codex", actor, true);
    await waiting; f.config.max_assignment_used = 0.8; release();
    const assigned = await pending;
    expect(assigned.owner).toBe("codex");
    expect(assigned.history.findLast(entry => entry.event === "reassigned")?.by).toBe(actor);
  }
});
