import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry } from "../src/hub/registry.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

class FixturePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[]) { /* takes the task context without a native account */ }
}

// #604 (agent-hub#1030): two real temporary projects with two running daemons, a real machine registry, real sockets and real boards. Roots are resolved with realPath.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Project = Awaited<ReturnType<typeof project>>;
async function project(name: string, home: string, options: { roles?: Record<string, string[]>; features?: string[] } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), `ahub-handoff-${name}-`))), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub", "config.json"), "{}");
  writeFileSync(join(root, ".agenthub", "routing.toml"), '[local]\nfixed_model = "coding"\n[signals]\npii_patterns = ["\\\\b\\\\d{6}-\\\\d{7}\\\\b"]\n');   // the shipped PII pattern (Korean resident numbers), and nothing else
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const registry = new Registry(join(home, "registry.db")), registered = registry.register(root); registry.close?.();
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: registered.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {},
    config: { ...DEFAULT_CONFIG, roles: options.roles ?? { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
      approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (hello: Record<string, unknown>) => { const client = await ControlClient.connect(stateDir, { projectRoot: root, ...hello } as never); cleanup.push(() => client.close()); return client; };
  return { id: registered.id, root, stateDir, daemon, connect, person: await connect({ role: "console" }) };
}
async function pair(options: { a?: Parameters<typeof project>[2]; b?: Parameters<typeof project>[2] } = {}) {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-handoff-home-"))); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AMEM_HOME: process.env.AMEM_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
  const home = join(base, "hubs"); mkdirSync(home);
  process.env.AGENTHUB_HOME = home;
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "AMEM_HOME", "KIMI_CODE_HOME"] as const) { const dir = join(base, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  cleanup.push(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const a = await project("a", home, options.a), b = await project("b", home, options.b);
  return { a, b, home };
}
const task = (client: ControlClient, op: string, args: Record<string, unknown> = {}) => client.request({ t: "task", op, args });
const body = (reply: any) => { expect(reply.ok, JSON.stringify(reply)).toBe(true); return JSON.parse(reply.text); };
const boardOf = (p: Project) => { const board = new Board(join(p.stateDir, "hub.db")); return { board, close: () => board.close() }; };

test("AC1: a handoff from A to a running B creates an ownerless proposed task in B through Tasks, with its origin shown, and B's routing takes it from there", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const reply = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Raise the exact amem pin", class: "implement", detail: "to 0.16.0, as in #1015", paths: ["package.json", "bun.lock"], issue: 12 }));
  expect(reply).toMatchObject({ project: b.id, task: 1 });
  const read = boardOf(b);
  try {
    const created = read.board.get(1)!;
    expect(created).toMatchObject({ title: "Raise the exact amem pin", class: "implement", refs: { paths: ["package.json", "bun.lock"] } });
    expect(created.history[0]).toMatchObject({ by: "hub", event: "proposed" });                         // made by the hub on the origin's behalf, not by the origin peer
    expect(created.detail).toContain("to 0.16.0, as in #1015"); expect(created.detail).toContain(`handed off from project ${a.id} by claude`);
    expect(read.board.handoffOrigin(1)).toMatchObject({ projectId: a.id, peer: "claude" });
  } finally { read.close(); }
  // shown to the person in B: the public task view carries the origin, as ids only
  const shown = body(await task(b.person, "task_show", { id: 1 }));
  expect(shown.handoffOrigin).toEqual({ projectId: a.id, peer: "claude" });
  const listed = body(await task(b.person, "hub_task_list", {}));
  expect(listed.find((row: any) => row.id === 1)?.handoffOrigin).toMatchObject({ projectId: a.id, peer: "claude" });
  // routing: B's own implementer was offered it as for a local proposal (it is ownerless until someone accepts, and codex is the implementer)
  expect(shown.owner === null || shown.owner === "codex").toBe(true);
  // A recorded what it handed over
  expect(body(await task(planner, "hub_task_handoffs"))).toMatchObject({ handoffs: [{ remoteProject: b.id, remoteTask: 1, originPeer: "claude", state: "proposed" }] });
}, 60_000);

test("AC2: an unregistered, same-project or not-running target, a private turn, a [pii] task and an oversized body are each refused with a named reason and leave no row in either board", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const refused = async (args: Record<string, unknown>, client = planner) => { const reply = await task(client, "hub_task_handoff", args); expect(reply.ok, JSON.stringify(args)).toBe(false); return String(reply.error); };
  expect(await refused({ project: "p_000000000000000000000000", title: "x" })).toContain("not in this machine's agent-hub registry");
  expect(await refused({ project: a.id, title: "x" })).toContain("that is this project");
  expect(await refused({ project: a.root, title: "x" })).toContain("that is this project");                  // by canonical root as well as by id
  expect(await refused({ project: b.id, title: "x", paths: ["/etc/passwd"] })).toContain("repository-relative");
  expect(await refused({ project: b.id, title: "x", detail: "d".repeat(5000) })).toContain("over 4000 characters");
  expect(await refused({ project: b.id, title: "x", extra: 1 })).toContain("unknown field");
  expect(await refused({ project: b.id, title: "x" }, await a.connect({ role: "tools", peer: "codex" }))).toContain("needs the person, a configured planner or the conductor");   // an implementer is none of them
  // not running: B's daemon is stopped, its descriptor is gone or its port refuses
  await b.daemon.stop();
  expect(await refused({ project: b.id, title: "x" })).toMatch(/not running|did not answer/);
  expect(await refused({ project: b.id, title: "x" })).toContain("ahub up");                                 // names the person's action
  // no row in either board, however many refusals
  const readA = boardOf(a), readB = boardOf(b);
  try { expect(readA.board.handoffOutbound()).toEqual([]); expect(readB.board.list()).toEqual([]); expect(readB.board.hasHandoffState()).toBe(false); expect(readA.board.hasHandoffState()).toBe(false); }
  finally { readA.close(); readB.close(); }
}, 60_000);

test("AC2: a handoff is refused while the caller owns an open [pii] task, and when the text itself matches a PII pattern, with nothing stored in either board", async () => {
  const { a, b } = await pair({ a: { roles: { claude: ["planner"], codex: ["implementer"], local: ["planner"] } } });   // the on-prem worker holds the planner role here, so only a private turn can refuse it
  const planner = await a.connect({ role: "tools", peer: "claude" });
  // the TARGET refuses PII text: the pattern is matched there too, so a caller that skipped its own gate still leaves nothing in B
  const text = await task(planner, "hub_task_handoff", { project: b.id, title: "check the record of 900101-1234567" });
  expect(text.ok).toBe(false); expect(String(text.error)).toMatch(/PII/);
  const readB = boardOf(b), readA = boardOf(a);
  try { expect(readB.board.list()).toEqual([]); expect(readB.board.hasHandoffState()).toBe(false); expect(readA.board.handoffOutbound()).toEqual([]); } finally { readB.close(); readA.close(); }
  // the ORIGIN refuses while the caller holds an open [pii] task: it is a private context, so nothing leaves
  const owned = await task(a.person, "hub_task_propose", { title: "record of 900101-1234567", class: "implement", owner: "claude" });
  expect(owned.ok, JSON.stringify(owned)).toBe(true);
  // the caller's turn is private: an open [pii] task is OWNED by the on-prem local worker (routing allows no other owner), so a handoff from it is a PII turn whatever its own text says
  { const local = new FixturePeer("local"); a.daemon.bus.add(local); await local.start(); }
  const owned_ = await task(a.person, "task_assign", { id: 1, peer: "local", role: "owner" }); expect(owned_.ok, JSON.stringify(owned_)).toBe(true);
  const localTools = await a.connect({ role: "tools", peer: "local" });
  const during = await task(localTools, "hub_task_handoff", { project: b.id, title: "an ordinary chore" });
  expect(during.ok, JSON.stringify(during)).toBe(false); expect(String(during.error)).toContain("private turn");              // refused for the private context, not for lack of a role
  const piiTask = await task(planner, "hub_task_handoff", { project: b.id, title: "an ordinary chore", task: 1 });                   // the task it comes from is [pii]
  expect(piiTask.ok).toBe(false); expect(String(piiTask.error)).toContain("[pii] task");
  const missing = await task(planner, "hub_task_handoff", { project: b.id, title: "an ordinary chore", task: 99 });
  expect(missing.ok).toBe(false); expect(String(missing.error)).toContain("no task #99");
  const after = boardOf(b);
  try { expect(after.board.list()).toEqual([]); } finally { after.close(); }
}, 60_000);

test("AC3: the origin peer has no authority in B: accept, review, approve, assign and cancel attempts from it are refused", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  // the origin is a record, never an identity in B: it is no roster peer, holds no role, and a connection naming it is B's own claude, not A's
  expect(b.daemon.bus.peers.has("claude")).toBe(false);
  const readB = boardOf(b);
  try { expect(readB.board.get(sent.task)!.history.every(entry => entry.by !== "claude")).toBe(true); expect(readB.board.get(sent.task)!.owner).not.toBe("claude"); } finally { readB.close(); }
  // an agent connection in B cannot send the inbound control messages that would forge an origin or a state
  const agent = await b.connect({ role: "tools", peer: "codex" });
  const forged = await agent.request({ t: "task_handoff", origin: { projectId: a.id, peer: "claude" }, request: { title: "forged" } });
  expect(forged.ok).toBe(false); expect(String(forged.error)).toContain("not from an agent connection");
  const event = await agent.request({ t: "task_handoff_event", event: { projectId: a.id, remoteTask: sent.task, state: "approved" } });
  expect(event.ok).toBe(false); expect(String(event.error)).toContain("not from an agent connection");
  // the same origin id on B's own board is nobody: B's claude (the planner here) is B's own session, and the origin's authority never reaches it
  const stranger = await b.connect({ role: "tools", peer: "kimi" });
  for (const [op, args] of [["hub_task_accept", { id: sent.task }], ["hub_review", { id: sent.task, verdict: "approved", note: "x" }], ["hub_task_cancel", { id: sent.task, reason: "x" }], ["hub_task_assign", { id: sent.task, peer: "codex" }]] as const) {
    const reply = await task(stranger, op, { ...args });
    expect(reply.ok, op).toBe(false);
  }
  const still = boardOf(b);
  try { expect(still.board.get(sent.task)!.state).toBe("proposed"); expect(still.board.get(sent.task)!.owner).toBeNull(); } finally { still.close(); }
}, 60_000);

const until = async (check: () => boolean, label: string, ms = 8000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await Bun.sleep(20); expect(check(), label).toBe(true); };

test("AC4: each state change in B reaches the origin peer in A as a kind task envelope", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B", class: "implement" }));
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  const lines = () => received.filter(env => env.kind === "task" && /^agent-hub task \d+ /.test(env.body)).map(env => env.body);
  // accepted
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }                              // an in-process implementer stand-in in B, as the study tests use
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);        // B's own person (or its routing) gives it an owner, as for any local proposal
  expect((await task(implementer, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await until(() => lines().some(line => line === `agent-hub task ${sent.task} accepted`), "accepted reached A");
  // done: B has no reviewer for this class, so the done itself approves and A hears "approved" (the in_review leg has its own test below)
  const head = "c".repeat(40);
  expect((await task(implementer, "hub_task_done", { id: sent.task, summary: "pin raised; bun test ran", refs: { commit: head, repo: "STAIxBWLB/agent-hub" } })).ok).toBe(true);
  await until(() => lines().some(line => line.startsWith(`agent-hub task ${sent.task} approved`)), "approved reached A");
  // A's own record names the last state; a repeat of the same event sends nothing more
  const before = received.length;
  const duplicate = await (await a.connect({ role: "console" })).request({ t: "task_handoff_event", event: { projectId: b.id, remoteTask: sent.task, state: "approved" } });
  expect(duplicate.ok).toBe(true); expect(duplicate.recorded).toBe(false);
  await Bun.sleep(150);
  expect(received.length).toBe(before);
  const handoffs = body(await task(planner, "hub_task_handoffs")).handoffs;
  expect(handoffs).toMatchObject([{ remoteProject: b.id, remoteTask: sent.task, state: "approved", originPeer: "claude" }]);
  // every envelope A got for this is a kind task from the hub, with a fixed one-line body: no free text from B
  for (const env of received.filter(env => /^agent-hub task \d+ /.test(env.body))) { expect(env.from).toBe("hub"); expect(env.body.split("\n")).toHaveLength(1); expect(env.body.length).toBeLessThan(120); }
}, 60_000);

test("AC4: with A stopped, A shows the latest remote state after it starts again, and a cancel in B reaches it", async () => {
  const { a, b, home } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B", class: "implement" }));
  const owner = await b.connect({ role: "tools", peer: "codex" });
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);
  expect((await task(owner, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await until(() => { const r = boardOf(a); try { return r.board.handoffOutboundFor(b.id, sent.task)?.state === "accepted"; } finally { r.close(); } }, "accepted recorded in A");
  // A goes down. B keeps working: the task is finished while nobody in A can be told.
  await a.daemon.stop();
  expect((await task(owner, "hub_task_done", { id: sent.task, summary: "done", refs: { commit: "d".repeat(40) } })).ok).toBe(true);
  await Bun.sleep(300);
  const whileDown = boardOf(a);
  try { expect(whileDown.board.handoffOutboundFor(b.id, sent.task)?.state).toBe("accepted"); } finally { whileDown.close(); }   // A could not be told: its record still says accepted
  // A starts again on the same state directory: it asks the target where the task stands and records the latest
  const again = await startDaemon({ cwd: a.root, stateDir: a.stateDir, projectId: a.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {},
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => again.stop());
  await until(() => { const r = boardOf(a); try { return r.board.handoffOutboundFor(b.id, sent.task)?.state === "approved"; } finally { r.close(); } }, "A caught up to approved");
  const caught = boardOf(a);
  try { expect(caught.board.handoffOutboundFor(b.id, sent.task)).toMatchObject({ state: "approved", head: "d".repeat(40) }); } finally { caught.close(); }
  void home;
}, 60_000);

test("AC4: a cancel in B reaches A as a kind task envelope", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  const cancelled = await task(b.person, "hub_task_cancel", { id: sent.task, reason: "not needed any more" });
  expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
  await until(() => received.some(env => env.kind === "task" && env.body === `agent-hub task ${sent.task} cancelled`), "cancel reached A");
  expect(received.every(env => !env.body.includes("not needed any more"))).toBe(true);                          // B's reason text never crosses
}, 60_000);

test("AC5: an older target daemon is refused with the named upgrade error, and the new control message gets a reply even where it is unknown", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  // B advertises task_handoff in its status descriptor; an older hub does not. Remove the label from B's status.json, as an older daemon's would read.
  const statusFile = join(b.stateDir, "status.json"), real = readFileSync(statusFile, "utf8");
  const older = JSON.parse(real); older.features = older.features.filter((feature: string) => feature !== "task_handoff");
  writeFileSync(statusFile, JSON.stringify(older));
  const refused = await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" });
  expect(refused.ok).toBe(false); expect(String(refused.error)).toContain("too old to take a handoff"); expect(String(refused.error)).toContain("ahub upgrade");
  const readB = boardOf(b), readA = boardOf(a);
  try { expect(readB.board.list()).toEqual([]); expect(readA.board.handoffOutbound()).toEqual([]); } finally { readB.close(); readA.close(); }   // nothing was sent, nothing recorded
  writeFileSync(statusFile, real);
  expect(body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" })).task).toBe(1);                              // the real label is accepted
  // an unknown message type always gets a reply, so a newer CLI never hangs on an older hub: the new types answer from a connection that may not use them, and a made-up one is "unknown"
  const agent = await b.connect({ role: "tools", peer: "codex" });
  for (const t of ["task_handoff", "task_handoff_event", "task_handoff_states"]) { const reply = await agent.request({ t }); expect(reply.ok, t).toBe(false); expect(reply.t).toBe(t); }
  const unknown = await b.person.request({ t: "task_handoff_nonexistent" }); expect(unknown.ok).toBe(false); expect(String(unknown.error)).toContain("does not know");
  expect(DAEMON_FEATURES).toContain("task_handoff");
}, 60_000);

test("task_handoff is its own recovery label: a stored handoff row in either direction refuses a target without it, and an empty project is still recoverable", async () => {
  const { a, b } = await pair();
  const request = (client: ControlClient, instanceId: string, features: readonly string[]) => client.request({ t: "recovery", op: "inspect", operationId: "op-handoff-guard", expectedInstanceId: instanceId, targetFeatures: features });
  const instanceOf = (p: Project) => JSON.parse(readFileSync(join(p.stateDir, "status.json"), "utf8")).instanceId as string;
  const without = DAEMON_FEATURES.filter(feature => feature !== "task_handoff");
  expect((await request(a.person, instanceOf(a), without)).error ?? "").not.toContain("task_handoff");                // nothing handed over yet: an older target is still acceptable
  const planner = await a.connect({ role: "tools", peer: "claude" });
  body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  for (const [label, p] of [["origin", a], ["target", b]] as const) {
    const refused = await request(p.person, instanceOf(p), without);
    expect(refused.error, label).toContain("target lacks task_handoff");                                                // a row in either board needs the feature
    expect((await request(p.person, instanceOf(p), DAEMON_FEATURES)).error ?? "", label).not.toContain("task_handoff");
  }
}, 60_000);

// The real `ahub` process against the real daemons: argv parsing, the control socket, the daemon's op and the renderer, with nothing in between faked. The CLI finds its project from --project and
// the inherited environment is cleared, as a person's shell has none of an agent's markers.
test("the real ahub process hands a task to another project, shows it in the target's board, and lists it with --handoffs", async () => {
  const { a, b } = await pair();
  const cli = async (project: Project, ...args: string[]) => {
    const env = { ...process.env, NO_COLOR: "1", COLUMNS: "120" } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME" || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "KIMI_CODE"].includes(key)) delete env[key];
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", project.root, ...args], { cwd: project.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
  const usage = await cli(a, "task", "handoff", "--project", b.id);                                             // no title: usage, nothing sent
  expect(usage.code).toBe(1); expect(usage.stderr).toContain("usage: ahub task handoff");
  const badIssue = await cli(a, "task", "handoff", "--project", b.id, "--issue", "x", "A chore");
  expect(badIssue.code).toBe(1); expect(badIssue.stderr).toContain("--issue is the target repository's issue number");
  const sent = await cli(a, "task", "handoff", "--project", b.id, "implement", "Raise", "the", "pin", "--path", "package.json", "--issue", "12", "--detail", "to 0.18.0");
  expect(sent.code, sent.stderr).toBe(0); expect(sent.stdout).toContain(`Handed off to project ${b.id}`); expect(sent.stdout).toContain("#1");
  const readB = boardOf(b);
  try { expect(readB.board.get(1)).toMatchObject({ title: "Raise the pin", class: "implement", refs: { paths: ["package.json"] } }); expect(readB.board.get(1)!.detail).toContain("to 0.18.0"); } finally { readB.close(); }
  const showB = await cli(b, "task", "show", "1");
  expect(showB.code, showB.stderr).toBe(0); expect(showB.stdout).toContain(`project ${a.id}`); expect(showB.stdout).toContain("handed off by");
  const boardB = await cli(b, "board");
  expect(boardB.stdout).toContain("handed off from"); expect(boardB.stdout).toContain("Raise the pin");
  const listed = await cli(a, "board", "--handoffs");
  expect(listed.code, listed.stderr).toBe(0); expect(listed.stdout).toContain("Handoffs (1)"); expect(listed.stdout).toContain(b.id.slice(0, 24)); expect(listed.stdout).toContain("proposed");
  const json = await cli(a, "board", "--handoffs", "--json");
  expect(JSON.parse(json.stdout).handoffs).toHaveLength(1);                                                    // --json prints the hub's own text
  // an agent shell is refused: the form is the person's, and --live-test does not delegate it
  const agentEnv = { AGENTHUB_PEER_ID: "codex" };
  const refused = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", a.root, "task", "handoff", "--project", b.id, "A chore"], { cwd: a.root, env: { ...process.env, ...agentEnv, AGENTHUB_STATE_DIR: a.stateDir, AGENTHUB_PROJECT_DIR: a.root } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const refusedErr = await new Response(refused.stderr).text(); expect(await refused.exited).toBe(1); expect(refusedErr).toContain("codex cannot run ahub task"); expect(refusedErr).toContain("inherited agent markers");
  const live = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--live-test", "--project", a.root, "task", "handoff", "--project", b.id, "A chore"], { cwd: a.root, env: { ...process.env, ...agentEnv, AGENTHUB_STATE_DIR: a.stateDir, AGENTHUB_PROJECT_DIR: a.root } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const liveErr = await new Response(live.stderr).text(); expect(await live.exited).toBe(1); expect(liveErr).toContain("live-test cannot write person-attributed content");
  const after = boardOf(b);
  try { expect(after.board.list()).toHaveLength(1); } finally { after.close(); }                                  // neither refused form created a second task
}, 120_000);
