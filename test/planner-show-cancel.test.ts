import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, taskHasWorkEvidence, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Conductor, ConductorHolds, type ConductEvent } from "../src/hub/conductor.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import type { Envelope } from "../src/hub/envelope.ts";

// agent-hub#812 AC5 (task #481): the configured planner reads any task's public view with hub_task_show, and cancels a task it proposed that an owner accepted and then
// declined untouched. Anything with execution, branch, commit or PR evidence is still refused with today's text; a non-planner is refused as before.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

class Quiet extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver(_envs: Envelope[]) {} }

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-show-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ["codex", "pi"]) bus.add(new Quiet(id));
  const tasks = new Tasks({ board, bus, cwd: dir, project: "show-cancel", routing: () => loadRouting(dir), roles: { claude: ["planner"], codex: ["implementer"] }, notify: text => notices.push(text) });
  /** A task the planner proposed and `codex` accepted, then declined: back in `proposed` with no owner. */
  const declined = (over: { branch?: boolean; commit?: string; pr?: number; localCheck?: boolean; done?: boolean } = {}): Task => {
    let t = board.propose("claude", { title: "planner owned work", class: "implement" });
    t = board.update(t.id, "user", "assigned", { owner: "codex", reviewer: "user" });
    t = board.update(t.id, "codex", "accepted", { state: "in_progress" });
    if (over.branch) t = board.update(t.id, "codex", "lifecycle", { refs: { ...t.refs, branch: "feat/x" } });
    if (over.commit) t = board.update(t.id, "codex", "lifecycle", { refs: { ...t.refs, commit: over.commit } });
    if (over.pr) t = board.update(t.id, "codex", "lifecycle", { sdlc: { stage: "build", repo: "owner/repo", pr: over.pr } });
    if (over.localCheck) t = board.update(t.id, "codex", "check passed", {}, "local check ok");
    if (over.done) { t = board.update(t.id, "codex", "done", { state: "in_review" }, "done"); t = board.update(t.id, "user", "changes_requested", { state: "changes_requested" }, "no"); }
    return board.update(t.id, "codex", "declined", { state: "proposed", owner: null }, "cannot take it");
  };
  return { board, tasks, declined, notices };
}

test("AC5: a planner cancels the task it proposed after an owner accepted and then declined it untouched, and the history keeps every step", async () => {
  const r = rig();
  const t = r.declined();
  expect(t).toMatchObject({ state: "proposed", owner: null });
  expect(t.history.map(h => h.event)).toEqual(expect.arrayContaining(["proposed", "accepted", "declined"]));
  expect(taskHasWorkEvidence(t)).toBe(false);
  const next = await r.tasks.cancel(t.id, "claude", { reason: "obsolete after the decline" });
  expect(next).toMatchObject({ state: "cancelled", cancelled: { reason: "obsolete after the decline" } });
  expect(next.history.map(h => h.event)).toEqual(expect.arrayContaining(["accepted", "declined", "cancelled"]));   // rows are kept, not rewritten
  expect(next.history.filter(h => h.event === "cancelled")).toHaveLength(1);
});

test("AC5: any execution evidence keeps today's refusal, for the planner, and leaves the task untouched", async () => {
  const r = rig();
  const cases: [string, Parameters<typeof r.declined>[0]][] = [
    ["a branch ref", { branch: true }], ["a commit ref", { commit: "a".repeat(40) }], ["a PR", { pr: 7 }], ["a recorded local check", { localCheck: true }], ["a done and a verdict", { done: true }]];
  for (const [label, over] of cases) {
    const t = r.declined(over), before = r.board.get(t.id);
    expect(taskHasWorkEvidence(t), label).toBe(true);
    const failure = await r.tasks.cancel(t.id, "claude", { reason: "obsolete" }).then(() => undefined, error => error as Error);
    expect(failure, label).toBeInstanceOf(PreEffectToolRefusal);
    expect(failure!.message, label).toBe("planner may cancel only its own historically unaccepted backlog or proposed work");   // today's text
    expect(r.board.get(t.id), label).toEqual(before);
  }
});

test("AC5: the other planner limits hold: its own proposals only, backlog or proposed only, and a non-planner is refused as before", async () => {
  const r = rig();
  // A task another peer proposed, even untouched and declined.
  let other = r.board.propose("pi", { title: "someone else's", class: "implement" });
  other = r.board.update(other.id, "user", "assigned", { owner: "codex", reviewer: "user" });
  other = r.board.update(other.id, "codex", "accepted", { state: "in_progress" }); other = r.board.update(other.id, "codex", "declined", { state: "proposed", owner: null }, "no");
  await expect(r.tasks.cancel(other.id, "claude", { reason: "obsolete" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(r.board.get(other.id)?.state).toBe("proposed");
  // The planner's own task while an owner still holds it (in progress): not cancellable.
  let live = r.board.propose("claude", { title: "live", class: "implement" });
  live = r.board.update(live.id, "user", "assigned", { owner: "codex", reviewer: "user" }); live = r.board.update(live.id, "codex", "accepted", { state: "in_progress" });
  await expect(r.tasks.cancel(live.id, "claude", { reason: "obsolete" })).rejects.toThrow("planner may cancel only its own");
  // A peer without the planner role cannot cancel even the declined task of its own proposal.
  const mine = r.declined();
  await expect(r.tasks.cancel(mine.id, "codex", { reason: "obsolete" })).rejects.toThrow("planning requires a person or configured planner role");
  expect(r.board.get(mine.id)?.state).toBe("proposed");
  // The person's cancellation is unchanged.
  expect((await r.tasks.cancel(live.id, "user", { reason: "person cancels" })).state).toBe("cancelled");
});

test("hub_task_show: the configured planner reads any non-backlog task's public view, a staged backlog row stays hidden, a PII task stays a stub, and a peer with no role is still refused", async () => {
  const holds = new ConductorHolds(":memory:"); cleanups.push(() => holds.close());
  const events: ConductEvent[] = [];
  const tasksById: Record<number, Task> = {
    1: { id: 1, title: "secret title", detail: "secret body", class: "implement", owner: "pi", reviewer: "kimi", state: "in_progress", refs: {}, plan: {}, signals: [], rejections: 0, history: [{ at: 1, by: "claude", event: "proposed", note: "n" }], created: 1, updated: 1 },
    2: { id: 2, title: "backlog title", detail: "d", class: "implement", owner: null, reviewer: null, state: "backlog", refs: {}, plan: {}, signals: [], rejections: 0, history: [{ at: 1, by: "claude", event: "backlogged" }], created: 1, updated: 1 },
    3: { id: 3, title: "PRIVATE-MARKER", detail: "PRIVATE-MARKER", class: "implement", owner: "pi", reviewer: "kimi", state: "in_progress", refs: {}, plan: {}, signals: ["pii"], rejections: 0, history: [{ at: 1, by: "claude", event: "proposed", note: "PRIVATE-MARKER" }], created: 1, updated: 1 },
  };
  const hooks = (planners: string[]) => ({
    roles: () => ({ codex: ["conductor"] }), capabilities: () => ({}), status: () => ({ peers: [], taskCounts: {}, approvals: [] }), task: (id: number) => tasksById[id],
    publicView: (t: Task) => t.signals.includes("pii") ? { title: "[pii]", detail: "[pii]", class: t.class, state: t.state, owner: t.owner, reviewer: t.reviewer, history: [] } : { id: t.id, title: t.title, state: t.state, history: t.history },
    isPlanner: (actor: string) => planners.includes(actor),
    assign: async () => {}, escalate: async () => tasksById[1]!, preview: (peer: string) => `ahub ${peer}`, startMode: () => "headless" as const, start: async () => {}, known: () => true, pause: () => {}, release: () => {}, audit: (event: ConductEvent) => { events.push(event); },
  });
  const planner = new Conductor(holds, hooks(["claude"]));
  expect(await planner.execute("claude", "hub_task_show", { id: 1 })).toMatchObject({ id: 1, title: "secret title" });
  // A staged backlog row stays hidden from agent task tools (#263), for the planner too: backlog is read through planner tools.
  await expect(planner.execute("claude", "hub_task_show", { id: 2 })).rejects.toThrow("explicit conductor role");
  const stub = await planner.execute("claude", "hub_task_show", { id: 3 }) as Record<string, unknown>;
  expect(stub).toMatchObject({ title: "[pii]", detail: "[pii]", history: [] }); expect(JSON.stringify(stub)).not.toContain("PRIVATE-MARKER");
  // A peer holding BOTH roles takes the audited conductor path, which reads non-backlog work and refuses backlog work exactly as before.
  const dual = new Conductor(holds, { ...hooks(["codex"]), roles: () => ({ codex: ["conductor", "planner"] }) });
  const before = events.length;
  expect(await dual.execute("codex", "hub_task_show", { id: 1 })).toMatchObject({ id: 1 });
  expect(events.slice(before)).toEqual([{ kind: "conduct", actor: "codex", action: "task_show", task: 1 }]);
  await expect(dual.execute("codex", "hub_task_show", { id: 2 })).rejects.toThrow("backlog is read through planner tools");
  // No planner hook (an older wiring) and a peer that is not the planner: refused with today's text.
  await expect(new Conductor(holds, { ...hooks([]), isPlanner: undefined }).execute("claude", "hub_task_show", { id: 1 })).rejects.toThrow("explicit conductor role");
  await expect(planner.execute("kimi-two", "hub_task_show", { id: 1 })).rejects.toThrow("explicit conductor role");
  // The planner's read grants nothing else: it cannot assign, escalate or hold through the conductor tools.
  await expect(planner.execute("claude", "hub_task_assign", { id: 1, peer: "kimi" })).rejects.toThrow("explicit conductor role");
  await expect(planner.execute("claude", "hub_peer_hold", { peer: "pi" })).rejects.toThrow("explicit conductor role");
  expect(events.filter(event => event.actor !== "codex")).toEqual([]);                                                       // the planner's read is no conduct action (only the conductor's own is audited)
});

test("end to end through the daemon: the planner shows a task it neither owns nor reviews and cancels its declined one; a plain peer is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-show-daemon-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-MARKER"]').replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  const seed = new Board(join(dir, "hub.db"));
  let shownId = 0, declinedId = 0, piiId = 0;
  try {
    shownId = seed.propose("codex", { title: "someone else's work", class: "implement" }).id;
    seed.update(shownId, "user", "assigned", { owner: "kimi", reviewer: "codex" }); seed.update(shownId, "kimi", "accepted", { state: "in_progress" });
    declinedId = seed.propose("claude", { title: "planner owned work", class: "implement" }).id;
    seed.update(declinedId, "user", "assigned", { owner: "kimi", reviewer: "codex" }); seed.update(declinedId, "kimi", "accepted", { state: "in_progress" }); seed.update(declinedId, "kimi", "declined", { state: "proposed", owner: null }, "no");
    piiId = seed.propose("codex", { title: "PRIVATE-MARKER work", detail: "PRIVATE-MARKER", class: "implement", signals: ["pii"] }).id;
  } finally { seed.close(); }
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, roles: { ...DEFAULT_CONFIG.roles, claude: ["planner"], codex: ["conductor"] }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  cleanups.push(() => { void daemon.stop(); });
  const connect = async (peer: string) => { const client = await ControlClient.connect(dir, { role: "tools", peer }); cleanups.push(() => client.close()); return client; };
  const planner = await connect("claude"), plain = await connect("pi");   // pi owns, reviews and plans nothing here
  const op = (client: ControlClient, name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args });
  const shown = await op(planner, "hub_task_show", { id: shownId });
  expect(shown.ok).toBe(true); expect(JSON.parse(shown.text)).toMatchObject({ id: shownId, title: "someone else's work" });
  const stub = await op(planner, "hub_task_show", { id: piiId });
  expect(stub.ok).toBe(true); expect(stub.text).not.toContain("PRIVATE-MARKER"); expect(JSON.parse(stub.text)).toMatchObject({ title: "[pii]" });
  const refused = await op(plain, "hub_task_show", { id: shownId });
  expect(refused.ok).toBe(false); expect(refused.error).toContain("explicit conductor role");
  const cancelled = await op(planner, "hub_task_cancel", { id: declinedId, reason: "obsolete after the decline" });
  expect(cancelled.ok).toBe(true); expect(JSON.parse(cancelled.text)).toMatchObject({ id: declinedId, state: "cancelled" });
  const notMine = await op(planner, "hub_task_cancel", { id: shownId, reason: "not mine" });
  expect(notMine.ok).toBe(false); expect(notMine.error).toContain("planner may cancel only its own");
}, 30000);
