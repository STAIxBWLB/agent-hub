import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope, HUB, USER } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";
import { nextSweep } from "../src/hub/task-sweep.ts";
import { DEFAULT_TASK_SWEEP } from "../src/hub/task-sweep.ts";
import { planningPatch } from "../src/hub/planning.ts";
import { renderBacklog, renderStatus } from "../src/cli/output.ts";

// #1176: a leg only the person can run keeps its reservation as the "who will run it" hint, but no agent is ever offered it: not by auto pull, not by `assign()` (so `route explain` agrees),
// not by the idle sweep, and it counts toward no planner's WIP. An unmarked reserved card behaves exactly as before.
class Quiet extends BasePeer {
  received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.received.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const until = async (condition: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); return condition(); };

async function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-person-run-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const roles: Record<string, string[]> = { claude: ["planner"], codex: ["implementer"], kimi: ["implementer"] };
  const clock = { now: Date.parse("2026-11-02T00:00:00Z") };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", notify: line => notices.push(line), autoPull: () => true, now: () => clock.now, routing: () => loadRouting(cwd),
    sweep: { ...DEFAULT_TASK_SWEEP, enabled: true } });
  const peers = new Map<string, Quiet>();
  for (const id of Object.keys(roles)) { const peer = new Quiet(id); peers.set(id, peer); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const card = (fields: { reserved?: string; needsPerson?: boolean; priority?: number } = {}) => {
    const made = board.propose(USER, { title: "a backlog leg", detail: "needs the person's machine", class: "implement", backlog: true, planner: "claude", reserved: fields.reserved });
    const patch = Object.fromEntries(Object.entries({ priority: fields.priority, needsPerson: fields.needsPerson }).filter(([, value]) => value !== undefined));
    return Object.keys(patch).length ? board.plan(made.id, USER, patch, 0) : made;
  };
  /** A task codex is in review on: approving it frees codex's only planner slot. */
  const release = async () => {
    const made = board.propose(USER, { title: "in review", detail: "", class: "implement", backlog: true, planner: "claude" });
    let task = board.update(made.id, USER, "backlog pulled", { state: "proposed", owner: "codex", reviewer: USER });
    task = board.update(task.id, "codex", "accepted", { state: "in_progress" });
    task = board.update(task.id, "codex", "done", { state: "in_review" });
    await tasks.review(USER, task.id, "approved");
  };
  return { cwd, board, bus, tasks, peers, notices, clock, card, release };
}
const pulled = (task: Task | undefined) => !!task && task.state !== "backlog";

test("AC4 a person-run card is never auto-pulled when a slot frees, and an unmarked reserved card still is", async () => {
  const r = await rig();
  const person = r.card({ reserved: "codex", priority: 0, needsPerson: true }), plain = r.card({ reserved: "codex", priority: 2 });
  await r.release();
  expect(await until(() => pulled(r.board.get(plain.id)))).toBe(true);        // the unmarked card, though ranked lower, is the one pulled
  expect(r.board.get(plain.id)!.owner).toBe("codex");
  expect(r.board.get(person.id)).toMatchObject({ state: "backlog", reserved: "codex", needsPerson: true });   // still backlog, still reserved as a hint
  expect(r.board.get(person.id)!.history.filter(entry => entry.event === "backlog pulled")).toEqual([]);
});

test("with only a person-run card reserved, a freed slot pulls nothing and the planner notice names none as ready", async () => {
  const r = await rig();
  const person = r.card({ reserved: "codex", needsPerson: true });
  await r.release();
  await Bun.sleep(150);
  expect(r.board.get(person.id)!.state).toBe("backlog");
  expect(r.peers.get("codex")!.received.filter(env => env.refs?.task === String(person.id))).toEqual([]);
  const notice = r.peers.get("claude")!.received.find(env => env.body.includes("capacity_released"));
  expect(notice?.body ?? "").toContain("reserved ready none");                  // the planner is not told to pull it either
});

test("a planner pull of a person-run card is refused with the reason, and clearing the mark restores the pull", async () => {
  const r = await rig();
  const person = r.card({ reserved: "codex", needsPerson: true });
  await expect(r.tasks.pullPlanned("claude", { id: person.id, revision: r.board.get(person.id)!.planningRevision ?? 0, reason: "try" })).rejects.toThrow(/person-run leg/);
  expect(r.board.get(person.id)!.state).toBe("backlog");
  r.board.plan(person.id, USER, { needsPerson: false }, r.board.get(person.id)!.planningRevision ?? 0);
  expect(r.board.get(person.id)!.needsPerson).toBeUndefined();                  // the field is absent, not false
  await r.tasks.pullPlanned("claude", { id: person.id, revision: r.board.get(person.id)!.planningRevision ?? 0, reason: "now an agent's" });
  expect(r.board.get(person.id)!.state).toBe("proposed");
});

test("assign() is pure and gives a person-run task no owner and no reviewer, so route explain agrees with it", async () => {
  const r = await rig();
  const routing = loadRouting(r.cwd), states = { codex: "idle", kimi: "idle", claude: "idle" } as const;
  const base = { class: "implement" as const, signals: [] as string[], reserved: "codex", state: "proposed" as const };
  const marked = assign({ ...base, needsPerson: true }, { ...states }, routing);
  expect(marked.owner).toBeUndefined(); expect(marked.reviewer).toBeUndefined();
  expect(marked.trace.join(" ")).toContain("person-run");
  expect(marked.trace.join(" ")).toContain("reserved for codex as a hint only");
  expect(assign(base, { ...states }, routing).owner).toBe("codex");              // unmarked: the reservation is honoured, as before
  // the hub's explain is the same function: a marked card in To Do is explained as person-run, never offered
  const made = r.board.propose(USER, { title: "leg", detail: "", class: "implement", reserved: "codex" });
  r.board.plan(made.id, USER, { needsPerson: true }, 0);
  expect(r.tasks.explain(made.id).join("\n")).toContain("person-run");
});

test("the idle sweep never escalates a person-run card, and still escalates an unmarked one", async () => {
  const r = await rig();
  const make = (needsPerson: boolean) => {
    const made = r.board.propose(USER, { title: "ready leg", detail: "", class: "implement", reserved: "codex" });
    return needsPerson ? r.board.plan(made.id, USER, { needsPerson: true }, 0) : made;
  };
  const marked = make(true), plain = make(false);
  const far = Date.now() + 10 * 60 * 60 * 1000;
  expect(nextSweep(r.board.get(marked.id)!, { ...DEFAULT_TASK_SWEEP, enabled: true }, far)).toBeUndefined();
  expect(nextSweep(r.board.get(plain.id)!, { ...DEFAULT_TASK_SWEEP, enabled: true }, far)).toMatchObject({ kind: "ready-unassigned" });
  const swept = await r.tasks.sweep(far);
  expect(swept.map(entry => entry.task)).not.toContain(marked.id);
});

test("a person-run card counts toward no planner's WIP, while the same unowned reserved pull unmarked does", async () => {
  const r = await rig();
  // A planner pull reserves a slot: the card sits in To Do, unowned, reserved for kimi, and `plannerWip` counts it. That is the row the SQL reads.
  const reservedPull = (needsPerson: boolean) => {
    const made = r.card({ reserved: "kimi", needsPerson });
    r.board.pullPlanned(made.id, "claude", "kimi", r.board.get(made.id)!.planningRevision ?? 0, "ready");
    return r.board.get(made.id)!;
  };
  expect(r.tasks.wip("kimi")).toBe(0);
  const unmarked = reservedPull(false);
  expect(unmarked).toMatchObject({ state: "proposed", reserved: "kimi" }); expect(unmarked.owner).toBeNull();
  expect(r.tasks.wip("kimi")).toBe(1);                                           // an unmarked reserved pull holds the slot, as before
  expect(r.board.plannerWipBreakdown().kimi).toEqual({ active: 0, reviewWait: 0, reserved: 1 });
  const marked = reservedPull(true);
  expect(marked).toMatchObject({ state: "proposed", reserved: "kimi", needsPerson: true });
  expect(r.tasks.wip("kimi")).toBe(1);                                           // the person-run one added nothing
  expect(r.board.plannerWipBreakdown().kimi).toEqual({ active: 0, reviewWait: 0, reserved: 1 });
  expect(r.tasks.wipBreakdown(["kimi"]).kimi).toMatchObject({ wip: 1, reserved: 1 });
});

test("only the person marks or clears the mark: a planner is refused both ways, and a planner cannot plan a marked card at all", async () => {
  const r = await rig();
  const plain = r.card({ reserved: "codex" }), person = r.card({ reserved: "codex", needsPerson: true });
  await expect(r.tasks.planBacklog("claude", { id: plain.id, revision: 0, fields: { needsPerson: true }, reason: "mark it" })).rejects.toThrow(/person-run card is the person's/);
  await expect(r.tasks.planBacklog("claude", { id: person.id, revision: r.board.get(person.id)!.planningRevision ?? 0, fields: { needsPerson: false }, reason: "clear it" })).rejects.toThrow(/person-run card is the person's/);
  await expect(r.tasks.planBacklog("claude", { id: person.id, revision: r.board.get(person.id)!.planningRevision ?? 0, fields: { priority: 1 }, reason: "reprioritise" })).rejects.toThrow(/person-run card is the person's/);
  expect(r.board.get(plain.id)!.needsPerson).toBeUndefined();
  expect(r.board.get(person.id)!.needsPerson).toBe(true);
  // the person can do both, with a reason
  await r.tasks.planBacklog(USER, { id: plain.id, revision: 0, fields: { needsPerson: true }, reason: "needs my accounts" });
  expect(r.board.get(plain.id)!.needsPerson).toBe(true);
  await r.tasks.planBacklog(USER, { id: plain.id, revision: r.board.get(plain.id)!.planningRevision ?? 0, fields: { needsPerson: false }, reason: "done on my side" });
  expect(r.board.get(plain.id)!.needsPerson).toBeUndefined();
});

test("the field is a closed boolean and an older row reads as unmarked", () => {
  expect(planningPatch({ needsPerson: true })).toEqual({ needsPerson: true });
  expect(planningPatch({ needsPerson: false })).toEqual({ needsPerson: false });
  for (const bad of ["true", 1, null, {}]) expect(() => planningPatch({ needsPerson: bad }), String(bad)).toThrow("needsPerson must be a boolean");
  expect(() => planningPatch({ needs_person: true })).toThrow("unknown planning fields");
});

test("the backlog table and status show a person-run card as waiting on the person, ids only", async () => {
  const r = await rig();
  const person = r.card({ reserved: "codex", needsPerson: true }), plain = r.card({ reserved: "codex" });
  const cards = r.tasks.backlogList("claude") as Record<string, unknown>[];
  const text = renderBacklog(cards, 120).map(line => line.map(cell => cell.text).join(" ")).join("\n");
  expect(text).toContain(`#${person.id}`); expect(text).toContain("(person)");
  expect(text).toContain(`waiting on you: #${person.id}`);
  expect(text).not.toContain(`waiting on you: #${person.id}, #${plain.id}`);
  expect(text).toMatch(/reserved: codex 1/);                                    // the marked card is not counted as a codex reservation
  const status = renderStatus({ peers: {}, tasks: { backlog: 2 }, personRun: r.board.personRunIds() } as never, 120).map(line => line.map(cell => cell.text).join(" ")).join("\n");
  expect(status).toContain(`WAITING ON YOU  #${person.id}`);
  expect(status).not.toContain(`#${plain.id}`);
  expect(r.board.personRunIds()).toEqual([person.id]);
});

test("a person-run card in To Do is not reported as stalled for lacking an owner, while the unmarked one is", async () => {
  const r = await rig();
  const todo = (needsPerson: boolean) => {
    const made = r.board.propose(USER, { title: "to do leg", detail: "", class: "implement" });   // proposed, ownerless: routing has no owner to give it
    return needsPerson ? r.board.plan(made.id, USER, { needsPerson: true }, 0) : made;
  };
  const marked = todo(true);
  // make routing unable to place it, so an unmarked ownerless card would be reported as a stall
  r.board.update(marked.id, HUB, "noted", {}, "no owner");
  await r.tasks.releaseReady();
  expect(r.board.stalls().map(stall => stall.task)).not.toContain(marked.id);
});

// --- the real ahub process against a real daemon -----------------------------------------------------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";

test("the real ahub process marks a leg person-run, lists it as waiting on the person, shows it in status, refuses an agent shell, and clears it", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-person-run-cli-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd);
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  const daemon = await startDaemon({ cwd, stateDir, projectId: "person-run-cli", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] } } });
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  cleanup.push(async () => { person.close(); await daemon.stop(); });
  const peer = new Quiet("codex"); daemon.bus.add(peer); await peer.start();
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const wrapper = join(cwd, `cli-${crypto.randomUUID()}.ts`), entry = join(import.meta.dir, "../src/cli/main.ts");
    const markers = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED"];
    writeFileSync(wrapper, `for(const key of ${JSON.stringify(markers)})delete process.env[key];Object.assign(process.env,${JSON.stringify({ AGENTHUB_HOME: join(cwd, "home"), NO_COLOR: "1", COLUMNS: "140", ...env })});process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); rmSync(wrapper, { force: true }); }
  };
  const made = JSON.parse(String((await person.request({ t: "task", op: "hub_task_propose", args: { title: "live receipt leg", class: "implement", backlog: true, owner: "codex" } })).text.replace(/^task #(\d+).*$/s, '{"id":$1}'))).id as number;
  const listed = await cli(["backlog", "list"]);
  expect(listed.code, listed.stderr).toBe(0); expect(listed.stdout).not.toContain("(person)");
  const revision = JSON.parse((await person.request({ t: "task", op: "hub_backlog_list", args: {} })).text).find((card: { id: number }) => card.id === made).planningRevision ?? 0;
  const marked = await cli(["backlog", "person", String(made), String(revision), "true", "needs", "my", "accounts"]);
  expect(marked.code, marked.stderr + marked.stdout).toBe(0);
  const after = await cli(["backlog", "list"]);
  expect(after.stdout).toContain("(person)"); expect(after.stdout).toContain(`waiting on you: #${made}`);
  const status = await cli(["status"]);
  expect(status.stdout).toContain(`WAITING ON YOU  #${made}`);
  expect((await cli(["status", "--json"])).stdout).toContain(`"personRun"`);
  // bad value and an agent shell are refused, and nothing changes
  expect((await cli(["backlog", "person", String(made), String(revision + 1), "maybe", "why"])).code).toBe(1);
  const agent = await cli(["backlog", "person", String(made), String(revision + 1), "false", "agent tries"], { AGENTHUB_PEER_ID: "codex" });
  expect(agent.code).toBe(1);
  expect((await cli(["backlog", "list"])).stdout).toContain("(person)");
  // the person clears it
  const cleared = await cli(["backlog", "person", String(made), String(revision + 1), "false", "done", "on", "my", "side"]);
  expect(cleared.code, cleared.stderr + cleared.stdout).toBe(0);
  const last = await cli(["backlog", "list"]);
  expect(last.stdout).not.toContain("(person)"); expect(last.stdout).not.toContain("waiting on you");
  expect((await cli(["status"])).stdout).not.toContain("WAITING ON YOU");
}, 60_000);

/** A card an agent already holds: pulled to codex as an offer in To Do. */
const offered = (r: Awaited<ReturnType<typeof rig>>) => {
  const made = r.board.propose(USER, { title: "an offered leg", detail: "", class: "implement", backlog: true, planner: "claude" });
  return r.board.update(made.id, USER, "backlog pulled", { state: "proposed", owner: "codex", reviewer: USER });
};

test("review 1: a planner's split of a person-run card is refused (before the screen and in the board), the person's split marks every child, an unmarked split is unchanged", async () => {
  const r = await rig();
  const person = r.card({ reserved: "codex", needsPerson: true }), plain = r.card({ reserved: "codex" });
  const parts = [{ title: "leg A" }, { title: "leg B" }];
  await expect(r.tasks.splitBacklog("claude", { id: person.id, revision: r.board.get(person.id)!.planningRevision ?? 0, parts, reason: "split it" })).rejects.toThrow(/children would be unmarked cards an agent could take/);   // the planner-side refusal, ahead of any screen call
  expect(r.board.list().filter(task => task.title.startsWith("leg "))).toEqual([]);              // no child was written
  expect(() => r.board.splitBacklog(person.id, "claude", r.board.get(person.id)!.planningRevision ?? 0, parts.map(part => ({ ...part, detail: "", class: "implement" as const, refs: {}, plan: {}, deps: [], afterParts: [] })), "direct")).toThrow(/person's to split/);
  const own = await r.tasks.splitBacklog(USER, { id: person.id, revision: r.board.get(person.id)!.planningRevision ?? 0, parts, reason: "the person splits it" });
  expect(own.children.map(child => r.board.get(child.id)!.needsPerson)).toEqual([true, true]);   // the children inherit the mark: person-only work stays person-only
  const agent = await r.tasks.splitBacklog("claude", { id: plain.id, revision: r.board.get(plain.id)!.planningRevision ?? 0, parts, reason: "split a plain one" });
  expect(agent.children.map(child => r.board.get(child.id)!.needsPerson)).toEqual([undefined, undefined]);
});

test("review 2: marking a card an agent already owns is refused with the way out, and marking an unowned proposed card is allowed", async () => {
  const r = await rig();
  const held = offered(r);
  await expect(r.tasks.planBacklog(USER, { id: held.id, revision: held.planningRevision ?? 0, fields: { needsPerson: true }, reason: "mark" })).rejects.toThrow(/already proposed with codex: take it off the agent first/);
  expect(r.board.get(held.id)!.needsPerson).toBeUndefined();
  const free = r.board.propose(USER, { title: "unowned", detail: "", class: "implement", backlog: true, planner: "claude" });
  await r.tasks.planBacklog(USER, { id: free.id, revision: 0, fields: { needsPerson: true }, reason: "mark" });
  expect(r.board.get(free.id)!.needsPerson).toBe(true);                                          // a backlog card has no owner: unchanged
});

test("review 2: a card marked behind the guard (an offer made before) cannot be accepted, and its queued offer is dropped at delivery", async () => {
  const r = await rig();
  const held = offered(r);
  r.board.plan(held.id, USER, { needsPerson: true }, held.planningRevision ?? 0);                 // the board write, as a stale or raced mark leaves it
  expect(() => r.tasks.accept("codex", held.id)).toThrow(/person-run leg: no agent accepts it/);
  await expect(r.tasks.acceptReviewed("codex", held.id)).rejects.toThrow(/person-run leg: no agent accepts it/);
  expect(r.board.get(held.id)!.state).toBe("proposed");
  const offer = { id: "offer-1", from: HUB, to: "codex", kind: "task", body: "offer", refs: { task: String(held.id), taskOffer: 1 }, ts: 1, hops: 0 } as unknown as Envelope;
  expect(r.tasks.relevant("codex", offer)).toBe(false);
  const plain = offered(r);
  expect(r.tasks.relevant("codex", { ...offer, refs: { task: String(plain.id), taskOffer: 1 } } as unknown as Envelope)).toBe(true);   // an unmarked offer is still delivered
});

test("review 2: hub_task_assign names no agent owner of a person-run card, for the conductor and the person alike, and an unmarked card is assigned as before", async () => {
  const r = await rig();
  const made = r.board.propose(USER, { title: "a leg", detail: "", class: "implement", reserved: "codex" });
  r.board.plan(made.id, USER, { needsPerson: true }, 0);
  for (const by of ["claude", USER]) await expect(r.tasks.assignTo(made.id, "kimi", by, true)).rejects.toThrow(/person-run leg: no agent is named its owner/);
  expect(r.board.get(made.id)!.owner ?? null).toBeNull();
  r.board.plan(made.id, USER, { needsPerson: false }, 1);
  expect((await r.tasks.assignTo(made.id, "kimi", USER, true)).owner).toBe("kimi");
});
