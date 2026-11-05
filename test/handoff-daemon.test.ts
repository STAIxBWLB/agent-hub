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
async function project(name: string, home: string, options: { roles?: Record<string, string[]>; features?: string[]; handoffRequestMs?: number; handoffCatchUpMs?: number; handoffWatchMs?: number; handoffCatchUpHold?: () => Promise<void>; screen?: (text: string) => Promise<{ label: "clear" | "pii" | "unknown"; ms: number }> } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), `ahub-handoff-${name}-`))), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub", "config.json"), "{}");
  writeFileSync(join(root, ".agenthub", "routing.toml"), '[local]\nfixed_model = "coding"\n[signals]\npii_patterns = ["\\\\b\\\\d{6}-\\\\d{7}\\\\b"]\n' + (options.screen ? 'pii_screen = "local"\n' : ""));   // the shipped PII pattern (Korean resident numbers), and nothing else
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const registry = new Registry(join(home, "registry.db")), registered = registry.register(root); registry.close?.();
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: registered.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {}, ...(options.screen ? { piiScreen: options.screen } : {}), ...(options.handoffRequestMs ? { handoffRequestMs: options.handoffRequestMs } : {}), ...(options.handoffCatchUpMs ? { handoffCatchUpMs: options.handoffCatchUpMs } : {}), ...(options.handoffWatchMs ? { handoffWatchMs: options.handoffWatchMs } : {}), ...(options.handoffCatchUpHold ? { handoffCatchUpHold: options.handoffCatchUpHold } : {}),
    config: { ...DEFAULT_CONFIG, roles: options.roles ?? { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
      approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const connect = async (hello: Record<string, unknown>) => { const client = await ControlClient.connect(stateDir, { projectRoot: root, ...hello } as never); cleanup.push(() => client.close()); return client; };
  return { id: registered.id, root, stateDir, daemon, connect, person: await connect({ role: "console" }) };
}
async function pair(options: { a?: Parameters<typeof project>[2]; b?: Parameters<typeof project>[2]; more?: Parameters<typeof project>[2] } = {}) {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-handoff-home-"))); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const saved = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, AMEM_HOME: process.env.AMEM_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
  const home = join(base, "hubs"); mkdirSync(home);
  process.env.AGENTHUB_HOME = home;
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "AMEM_HOME", "KIMI_CODE_HOME"] as const) { const dir = join(base, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  cleanup.push(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const a = await project("a", home, options.a), b = await project("b", home, options.b);
  const more = options.more ? await project("c", home, options.more) : undefined;
  return { a, b, c: more as Project, home };
}
const task = (client: ControlClient, op: string, args: Record<string, unknown> = {}) => client.request({ t: "task", op, args });
const body = (reply: any) => { expect(reply.ok, JSON.stringify(reply)).toBe(true); return JSON.parse(reply.text); };
const readOnly = (p: Project) => { const read = boardOf(p); const rows = { handoffOutbound: () => { try { return read.board.handoffOutbound(); } finally { read.close(); } } }; return rows; };
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

test("review P1: a handoff whose PII screen is pending when a recovery starts writes nothing, the origin gets a named refusal, and the recovery waits for it as for a task op", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  const { a, b } = await pair({ b: { screen: async () => { entered(); await held; return { label: "clear", ms: 0 }; } } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const handoff = task(planner, "hub_task_handoff", { project: b.id, title: "Chore that must not outlive a recovery" });
  await inside;
  const status = (await b.person.request({ t: "status" })).status;
  const prepare = b.person.request({ t: "recovery", op: "prepare", operationId: "handoff-fence", expectedInstanceId: status.instanceId, targetFeatures: DAEMON_FEATURES }, 30_000);
  const first = await prepare;
  expect(first.recovery).toMatchObject({ phase: "preparing", ready: false });          // the in-flight handoff blocks the recovery like a task command
  expect(first.recovery.blockers).toContain("a task command in flight");
  release();
  const refused = await handoff;
  expect(refused.ok).toBe(false); expect(String(refused.error)).toContain("recovery");
  const readB = boardOf(b), readA = boardOf(a);
  try { expect(readB.board.list()).toEqual([]); expect(readB.board.hasHandoffState()).toBe(false); expect(readA.board.handoffOutbound()).toEqual([]); } finally { readB.close(); readA.close(); }
}, 60_000);

test("review P2: the spec issue the caller named is kept in the target task and shown by task show", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Raise the exact amem pin", issue: 12 }));
  const shown = body(await task(b.person, "task_show", { id: sent.task }));
  expect(shown.detail).toContain("spec issue: #12");
  const read = boardOf(b);
  try { expect(read.board.get(sent.task)!.detail).toContain("spec issue: #12"); } finally { read.close(); }
}, 60_000);

// #1175 ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const conductorRoles = { claude: ["planner"], codex: ["implementer"], kimi: ["conductor"] };
const onBoard = async (project: Project, op: string, args: Record<string, unknown>, peer = "kimi") => { const client = await project.connect({ role: "tools", peer }); return task(client, op, args); };
const proposed = (reply: any) => { expect(reply.ok, JSON.stringify(reply)).toBe(true); return Number(/task #(\d+)/.exec(String(reply.text))![1]); };
const rowsOf = (project: Project) => { const handle = boardOf(project); try { return handle.board.list(); } finally { handle.close(); } };

test("#1175 AC1: a handoff for a spec issue that already has an open task is refused with those ids and writes nothing; duplicate_ok files it with the reason kept", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const first = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Questions for the person", issue: 1053 }));
  const second = await task(planner, "hub_task_handoff", { project: b.id, title: "Questions for the person again", issue: 1053 });
  expect(second.ok).toBe(false);
  expect(String(second.error)).toContain(`#${first.task}`);
  expect(String(second.error)).toContain("duplicate_ok");
  expect(String(second.error)).toContain("spec issue #1053");
  expect(String(second.error)).not.toContain("Questions for the person");                                          // an id, never a title
  expect(rowsOf(b)).toHaveLength(1);                                                                              // nothing was stored in the target
  expect(body(await task(planner, "hub_task_handoffs")).handoffs).toHaveLength(1);                               // nor recorded at the origin
  // another issue is not a duplicate, and a task of the same issue by bare title reference also counts
  expect(body(await task(planner, "hub_task_handoff", { project: b.id, title: "Other spec", issue: 1054 })).task).toBe(first.task + 1);
  const person = proposed(await task(b.person, "hub_task_propose", { title: "#1060 the person's own task", class: "implement" }));
  expect(String((await task(planner, "hub_task_handoff", { project: b.id, title: "Chore", issue: 1060 })).error)).toContain(`#${person}`);
  // the explicit reason files it, and the task keeps the sender's reason as its own line
  const ok = body(await task(planner, "hub_task_handoff", { project: b.id, title: "A separate part of the same issue", issue: 1053, duplicate_ok: "covers only the privacy leg" }));
  expect(ok.task).toBeGreaterThan(first.task);
  expect(rowsOf(b).find(row => row.id === ok.task)!.detail).toContain("duplicate acknowledged by the sender: covers only the privacy leg");
  // no issue named: nothing to compare, nothing refused
  expect(body(await task(planner, "hub_task_handoff", { project: b.id, title: "A mechanical chore" })).task).toBeGreaterThan(ok.task);
}, 60_000);

test("#1175 AC1: a closed task does not block a handoff, and a [pii] task's id is never named to another project", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const first = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Spec work", issue: 2001 }));
  expect((await task(b.person, "hub_task_cancel", { id: first.task, reason: "not needed" })).ok).toBe(true);
  expect(body(await task(planner, "hub_task_handoff", { project: b.id, title: "Spec work again", issue: 2001 })).task).toBeGreaterThan(first.task);   // the cancelled one is closed
  // a task whose text is private carries the issue too, but the sender is not told its id
  const secret = await task(b.person, "hub_task_propose", { title: "#3001 patient 900101-1234567 follow-up", class: "implement" });
  expect(secret.ok).toBe(true);
  const sent = await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for 3001", issue: 3001 });
  expect(sent.ok, JSON.stringify(sent)).toBe(true);                                                              // the private task is invisible to the check: it is not named, so it cannot block
}, 60_000);

test("#1175 AC2 and AC4: the receiving conductor cancels an unaccepted handoff with a reason and the origin hears it; its text never crosses", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  { const kimi = new FixturePeer("kimi"); b.daemon.bus.add(kimi); await kimi.start(); }                           // the conductor must be on the roster
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "A duplicate of open work", duplicate_ok: "test" }));
  const cancelled = await onBoard(b, "hub_task_cancel", { id: sent.task, reason: "SECRET-REASON duplicate of #700" });
  expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
  const row = rowsOf(b).find(r => r.id === sent.task)!;
  expect(row.state).toBe("cancelled");
  expect(row.history.findLast(h => h.event === "cancelled")).toMatchObject({ by: "kimi" });                       // the real actor, not the person
  await until(() => received.some(env => env.kind === "task" && env.body === `agent-hub task ${sent.task} cancelled`), "cancel reached A");
  expect(received.every(env => !env.body.includes("SECRET-REASON"))).toBe(true);
  expect(body(await task(planner, "hub_task_handoffs")).handoffs).toMatchObject([{ remoteTask: sent.task, state: "cancelled" }]);
}, 60_000);

test("#1175 AC2: only the configured conductor, only for a handed-off task nobody has accepted; every other cancel keeps today's refusal", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  for (const id of ["kimi", "codex", "claude"]) { const peer = new FixturePeer(id); b.daemon.bus.add(peer); await peer.start(); }
  const handed = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  const localId = proposed(await task(b.person, "hub_task_propose", { title: "A task proposed in B itself", class: "implement" }));
  // a peer without the conductor role, and the conductor on a task B proposed itself, are refused as before
  for (const [peer, id, rule] of [["codex", handed.task, /planning requires a person or configured planner role/], ["claude", handed.task, /planner may cancel only its own/], ["kimi", localId, /the conductor may cancel only a task another project handed off.*`ahub task cancel <id> --reason <text>`/]] as const) {
    const refused = await onBoard(b, "hub_task_cancel", { id, reason: "not mine" }, peer);
    expect(refused.ok, `${peer} #${id}`).toBe(false);
    expect(String(refused.error), `${peer} #${id}`).toMatch(rule);
  }
  expect(rowsOf(b).find(r => r.id === handed.task)!.state).not.toBe("cancelled");
  // once an owner accepted it, the conductor's special path is gone
  expect((await task(b.person, "task_assign", { id: handed.task, peer: "codex", role: "owner" })).ok).toBe(true);
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  expect((await task(implementer, "hub_task_accept", { id: handed.task })).ok).toBe(true);
  const late = await onBoard(b, "hub_task_cancel", { id: handed.task, reason: "too late" });
  expect(late.ok).toBe(false);
  expect(rowsOf(b).find(r => r.id === handed.task)!.state).toBe("in_progress");
  // the person still can
  expect((await task(b.person, "hub_task_cancel", { id: handed.task, reason: "person decides" })).ok).toBe(true);
}, 60_000);

test("#1175 AC3: a refused duplicate leaves no row to offer or escalate, and a task the check admits is offered as before", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const first = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Spec", issue: 4001 }));
  const before = rowsOf(b).map(row => `${row.id}:${row.state}:${row.history.length}`);
  expect((await task(planner, "hub_task_handoff", { project: b.id, title: "Spec duplicate", issue: 4001 })).ok).toBe(false);
  expect(rowsOf(b).map(row => `${row.id}:${row.state}:${row.history.length}`)).toEqual(before);                   // no new row and no history entry on the existing one
  expect(rowsOf(b)).toHaveLength(1);
  expect(first.task).toBe(1);
}, 60_000);

test("#1175 AC1: an imported backlog row that carries its issue only as external {repo, issue} is a duplicate, and a closed one is not", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const write = boardOf(b);
  let open: number, closed: number;
  try {
    open = write.board.propose("user", { title: "The issue's own words", class: "implement", backlog: true, external: { provider: "github", repo: "acme/hub", issue: 6001, url: "https://github.com/acme/hub/issues/6001" } }).id;
    closed = write.board.propose("user", { title: "An earlier import", class: "implement", backlog: true, external: { provider: "github", repo: "acme/hub", issue: 6002, url: "https://github.com/acme/hub/issues/6002" } }).id;
    
  } finally { write.close(); }
  expect((await task(b.person, "hub_task_cancel", { id: closed, reason: "done elsewhere" })).ok).toBe(true);
  const refused = await task(planner, "hub_task_handoff", { project: b.id, title: "Spec", issue: 6001 });
  expect(refused.ok).toBe(false); expect(String(refused.error)).toContain(`#${open}`);
  expect(rowsOf(b)).toHaveLength(2);                                                                              // nothing was written by the refusal
  expect((await task(planner, "hub_task_handoff", { project: b.id, title: "Spec", issue: 6002 })).ok).toBe(true);   // a cancelled import is not open work
}, 60_000);

test("#1175 the real ahub process passes --duplicate-ok, refuses a duplicate naming the open ids, and admits it with a reason", async () => {
  const { a, b } = await pair({ b: { roles: conductorRoles } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const first = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Spec", issue: 5001 }));
  const cli = async (...args: string[]) => {
    const env = { ...process.env, NO_COLOR: "1", COLUMNS: "120" } as Record<string, string>;
    for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME" || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "KIMI_CODE"].includes(key)) delete env[key];
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "--project", a.root, "task", "handoff", "--project", b.id, ...args], { cwd: a.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
  };
  const refused = await cli("Spec", "--issue", "5001");
  expect(refused.code).toBe(1); expect(refused.stderr).toContain(`#${first.task}`); expect(refused.stderr).toContain("--duplicate-ok");
  expect(rowsOf(b)).toHaveLength(1);                                                                              // the refusal wrote nothing
  const missing = await cli("Spec", "--issue", "5001", "--duplicate-ok");
  expect(missing.code).toBe(1); expect(missing.stderr).toContain("usage: ahub task handoff");
  const admitted = await cli("Spec", "--issue", "5001", "--duplicate-ok", "separate leg");
  expect(admitted.code, admitted.stderr).toBe(0); expect(admitted.stdout).toContain(`Handed off to project ${b.id}`);
  expect(rowsOf(b)).toHaveLength(2);
  expect(rowsOf(b)[1]!.detail).toContain("duplicate acknowledged by the sender: separate leg");
}, 60_000);

// #731 (agent-hub#1203) T1, AC1: a target that answers after the origin's timeout leaves ONE task, and the same key returns it.
test("#731 AC1: a target that answers after the origin's timeout files one task; the origin reports outcome_unknown with the key, a retry with it returns that task, and follow-backs arrive", async () => {
  let release!: () => void, entered = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  // the first screen call is held open past the origin's 300 ms request budget; later ones pass at once
  const screen = async () => { if (entered++ < 2) await held; return { label: "clear" as const, ms: 0 }; };
  const { a, b } = await pair({ a: { handoffRequestMs: 300 }, b: { screen } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const first = task(planner, "hub_task_handoff", { project: b.id, title: "Chore that B files late" });
  await until(() => entered >= 1, "B is screening the first attempt");
  const unknown = await first;                                       // the origin's own timeout (and its one same-key resend) pass while B is still screening
  expect(unknown.ok).toBe(false);
  expect(String(unknown.error)).toContain("did not confirm");
  const key = /--key ([0-9a-f-]{36})/.exec(String(unknown.error))?.[1];
  expect(key, String(unknown.error)).toBeDefined();
  expect(readOnly(a).handoffOutbound()).toEqual([]);                 // nothing is recorded as sent, and nothing is claimed as refused
  release();                                                         // B now finishes BOTH attempts of the same key
  await until(() => rowsOf(b).length >= 1, "B filed the task");
  await Bun.sleep(300);
  expect(rowsOf(b)).toHaveLength(1);                                 // one task, never two
  const retried = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore that B files late", handoffKey: key }));
  expect(retried).toMatchObject({ project: b.id, task: rowsOf(b)[0]!.id });
  expect(rowsOf(b)).toHaveLength(1);
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ remoteProject: b.id, remoteTask: retried.task, state: "proposed" }]);   // now the origin knows the task, so follow-backs are not refused
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  expect((await task(b.person, "task_assign", { id: retried.task, peer: "codex", role: "owner" })).ok).toBe(true);
  expect((await task(implementer, "hub_task_accept", { id: retried.task })).ok).toBe(true);
  await until(() => received.some(env => env.body === `agent-hub task ${retried.task} accepted`), "accepted reached A after the retry");
}, 60_000);

test("#731 AC1: the same key with a different request is refused, never answered with the earlier task; a malformed key is refused", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const key = "6f1c2c0e-8b1a-4c3e-9d3a-1b2c3d4e5f60";
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "One request", handoffKey: key }));
  expect(body(await task(planner, "hub_task_handoff", { project: b.id, title: "One request", handoffKey: key })).task).toBe(sent.task);   // the same request replays to the same task
  const other = await task(planner, "hub_task_handoff", { project: b.id, title: "A different request", handoffKey: key });
  expect(other.ok).toBe(false); expect(String(other.error)).toContain("already used for a different request");
  const bad = await task(planner, "hub_task_handoff", { project: b.id, title: "x", handoffKey: "not-a-uuid" });
  expect(bad.ok).toBe(false); expect(String(bad.error)).toContain("UUID");
  expect(rowsOf(b)).toHaveLength(1);
});

test("#731 AC1: a replayed key is answered before the duplicate check, so a handoff that named a spec issue is not refused as a duplicate of itself", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const key = "0b8f3f3e-2d52-4f7e-8f55-5a7a0f2d9c11";
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Spec work for #77", issue: 77, handoffKey: key }));
  const replay = await task(planner, "hub_task_handoff", { project: b.id, title: "Spec work for #77", issue: 77, handoffKey: key });
  expect(replay.ok, JSON.stringify(replay)).toBe(true); expect(body(replay).task).toBe(sent.task);
  const fresh = await task(planner, "hub_task_handoff", { project: b.id, title: "Spec work for #77", issue: 77 });   // a NEW request on the same issue is still a duplicate
  expect(fresh.ok).toBe(false); expect(String(fresh.error)).toContain("already has open");
});

test("#731: the task and its origin row are written together, and the by-key lookup answers only the asking project", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  const read = boardOf(b);
  try {
    const origin = read.board.handoffOrigin(sent.task)!;
    expect(origin.projectId).toBe(a.id);
    // the key the origin minted is stored with the origin row; the lookup finds the task and answers nobody else
    const row = (read.board as any).db.query("SELECT handoff_key FROM task_handoff_origin WHERE task_id=?").get(sent.task) as { handoff_key: string };
    expect(row.handoff_key).toMatch(/^[0-9a-f-]{36}$/);
    const console_ = await b.connect({ role: "console" });
    const found = await console_.request({ t: "task_handoff_by_key", projectId: a.id, key: row.handoff_key });
    expect(found).toMatchObject({ ok: true, found: true, task: sent.task, state: "proposed" });
    const stranger = await console_.request({ t: "task_handoff_by_key", projectId: "p_someone_else", key: row.handoff_key });
    expect(stranger).toMatchObject({ ok: true, found: false });
    const agent = await b.connect({ role: "tools", peer: "codex" });
    const refused = await agent.request({ t: "task_handoff_by_key", projectId: a.id, key: row.handoff_key });
    expect(refused.ok).toBe(false); expect(refused.t).toBe("task_handoff_by_key");
  } finally { read.close(); }
});

// #731, AC4 (H3): the follow-back names the remote task, not a local one, so a local task with the same number cannot make the bus drop it.
test("#731 AC4: a follow-back is delivered even when the origin board has a cancelled or approved local task with the same number as the remote task", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  // B first gets two tasks of its own, so the handed-off task is #3 there; A's local #3 is made, then cancelled
  expect((await task(b.person, "hub_task_propose", { title: "b one", class: "implement" })).ok).toBe(true);
  expect((await task(b.person, "hub_task_propose", { title: "b two", class: "implement" })).ok).toBe(true);
  for (const title of ["a one", "a two", "a three"]) expect((await task(a.person, "hub_task_propose", { title, class: "implement" })).ok).toBe(true);
  expect((await task(a.person, "hub_task_cancel", { id: 3, reason: "stale" })).ok).toBe(true);
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B", task: 1 }));
  expect(sent.task).toBe(3);                                         // the remote task number equals A's cancelled local #3
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);
  expect((await task(implementer, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await until(() => received.some(env => env.body === `agent-hub task 3 accepted`), "the follow-back reached A despite A's cancelled #3");
  const env = received.find(e => e.body === "agent-hub task 3 accepted")!;
  expect(env.refs).toEqual({ handoff: { project: b.id, task: 3 } });   // no refs.task: it is not about any local task
});

test("#731 AC7 of T1: an older target without task_handoff_key is sent no key and keeps today's behavior", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const statusFile = join(b.stateDir, "status.json"), real = readFileSync(statusFile, "utf8");
  const older = JSON.parse(real); older.features = older.features.filter((feature: string) => feature !== "task_handoff_key");
  writeFileSync(statusFile, JSON.stringify(older));
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for an older B" }));
  expect(sent.task).toBe(1);
  const read = boardOf(b);
  try { expect(((read.board as any).db.query("SELECT handoff_key, request_digest FROM task_handoff_origin").get())).toEqual({ handoff_key: null, request_digest: null }); } finally { read.close(); }
  expect(DAEMON_FEATURES).toContain("task_handoff_key");
}, 60_000);

// #731 review: a refusal of the RESEND does not settle a first attempt whose outcome is unknown.
test("#731 a resend refused while the first attempt is still screening ends as outcome_unknown with the key, never as a refusal; the retry with the key returns the task the first attempt filed", async () => {
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  // call 1 (the first attempt) is held open; call 2 (the resend) is refused by the screen as unknown; any later call is clear
  const screen = async () => { const n = ++calls; if (n === 1) { await held; return { label: "clear" as const, ms: 0 }; } if (n === 2) return { label: "unknown" as const, ms: 0 }; return { label: "clear" as const, ms: 0 }; };
  const { a, b } = await pair({ a: { handoffRequestMs: 300 }, b: { screen } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const reply = await task(planner, "hub_task_handoff", { project: b.id, title: "Chore whose resend is refused" });
  expect(reply.ok).toBe(false);
  expect(String(reply.error)).toContain("did not confirm");                                // not "invalid": the first attempt may still file it
  expect(String(reply.error)).toContain("the resend was refused");
  const key = /--key ([0-9a-f-]{36})/.exec(String(reply.error))?.[1];
  expect(key, String(reply.error)).toBeDefined();
  expect(readOnly(a).handoffOutbound()).toEqual([]);
  release();                                                                               // the first attempt now clears its screen and files the task
  await until(() => rowsOf(b).length === 1, "the first attempt filed the task");
  const retried = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore whose resend is refused", handoffKey: key }));
  expect(retried.task).toBe(rowsOf(b)[0]!.id);
  expect(rowsOf(b)).toHaveLength(1);
}, 60_000);

test("#731 a resend that is refused after the first attempt filed the task is answered by the by-key lookup with that task, not reported as a refusal", async () => {
  // call 1 (the first attempt) is held until the resend's screen starts; the resend's screen then lets the first attempt file the task before it refuses, so the lookup must find it
  let calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const screen = async () => {
    const n = ++calls;
    if (n === 1) { await held; return { label: "clear" as const, ms: 0 }; }
    release(); await Bun.sleep(150);
    return { label: "unknown" as const, ms: 0 };
  };
  const { a, b } = await pair({ a: { handoffRequestMs: 300 }, b: { screen } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore filed during recovery" }));
  expect(rowsOf(b)).toHaveLength(1);
  expect(sent.task).toBe(rowsOf(b)[0]!.id);                                                // the lookup established the task the first attempt filed
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ remoteProject: b.id, remoteTask: sent.task }]);
}, 60_000);

// #733 (agent-hub#1203 T2). Both projects' control tokens are made unreadable together, which is how a state change that reaches nobody looks: B cannot notify A, and A's own catch-up cannot ask B.
// Restoring them is the two hubs being reachable again. Hiding only one side would let the other side's catch-up race the assertion that the change was missed.
const hideBoth = (...projects: Project[]) => { const saved = projects.map(p => { const file = join(p.stateDir, "control-token"), real = readFileSync(file, "utf8"); rmSync(file); return () => writeFileSync(file, real); }); return () => { for (const restore of saved) restore(); }; };

test("#733 AC2: an origin that is up but missed the first notify learns the state within one catch-up period, and its peer gets the envelope", async () => {
  const { a, b } = await pair({ a: { handoffCatchUpMs: 300 } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore whose first notify is missed" }));
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  const restore = hideBoth(a, b);
  expect((await task(implementer, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await Bun.sleep(700);                                                                    // more than two catch-up periods, with nobody reachable
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ state: "proposed" }]);            // missed, and not learned meanwhile
  expect(received.some(env => env.body === `agent-hub task ${sent.task} accepted`)).toBe(false);
  restore();
  await until(() => received.some(env => env.body === `agent-hub task ${sent.task} accepted`), "A's own catch-up delivered the missed state within a period");
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ state: "accepted" }]);
}, 60_000);

test("#733 AC3: an event with a lower or equal seq than the stored one changes nothing and sends no envelope; a newer one applies", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  const console_ = await a.connect({ role: "console" });
  const event = (state: string, seq?: number) => console_.request({ t: "task_handoff_event", event: { projectId: b.id, remoteTask: sent.task, state, ...(seq === undefined ? {} : { seq }) } });
  expect(await event("approved", 10)).toMatchObject({ ok: true, recorded: true });
  await until(() => received.some(env => env.body === `agent-hub task ${sent.task} approved`), "approved reached A");
  const before = received.length;
  expect(await event("in_review", 5)).toMatchObject({ ok: true, recorded: false });        // arrives late: an older sequence
  expect(await event("accepted", 10)).toMatchObject({ ok: true, recorded: false });        // the same sequence is a repeat
  await Bun.sleep(150);
  expect(received.length).toBe(before);                                                    // no envelope
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ state: "approved", seq: 10 }]);   // and the row did not move back
  expect(await event("changes_requested", 11)).toMatchObject({ ok: true, recorded: true });   // a withdrawn approval is a newer event
  await until(() => received.some(env => env.body === `agent-hub task ${sent.task} changes requested`), "changes_requested reached A");
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ state: "changes_requested", seq: 11 }]);
  const malformed = await event("approved", 0);
  expect(malformed.ok).toBe(false); expect(String(malformed.error)).toContain("malformed");
}, 60_000);

test("#733: a live event carries the target task's flow revision, so the origin row keeps the sequence the target used", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" }));
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  expect((await task(implementer, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await until(() => readOnly(a).handoffOutbound()[0]?.state === "accepted", "accepted reached A");
  expect(readOnly(a).handoffOutbound()[0]!.seq).toBe(rowsOf(b).find(row => row.id === sent.task)!.history.length);
}, 60_000);

test("#733 AC2: a target whose control descriptor changed is caught up at once, not at the next period", async () => {
  const { a, b } = await pair({ a: { handoffCatchUpMs: 3_600_000, handoffWatchMs: 100 } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for a moving B" }));
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  await Bun.sleep(350);                                                                    // A's watch has read B's descriptor
  const restore = hideBoth(a, b);                                                          // B is away: its descriptor cannot be read
  expect((await task(implementer, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await Bun.sleep(400);                                                                    // A's watch sees it gone
  expect(readOnly(a).handoffOutbound()).toMatchObject([{ state: "proposed" }]);
  restore();                                                                               // B is back: the descriptor changed, and A asks it at once
  await until(() => received.some(env => env.body === `agent-hub task ${sent.task} accepted`), "the descriptor change triggered a catch-up long before the hour-long period");
}, 60_000);

test("#733 AC5: the catch-up covers every open row, beyond the 200 most recent, in chunks of 200", async () => {
  const { a, b } = await pair({ a: { handoffCatchUpMs: 500 } });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const ids: number[] = [];
  for (let start = 0; start < 250; start += 25)
    await Promise.all(Array.from({ length: 25 }, async (_, n) => { ids.push(body(await task(planner, "hub_task_handoff", { project: b.id, title: `Chore ${start + n} for B` })).task); }));
  expect(ids).toHaveLength(250);
  await Bun.sleep(1_200);                                                                  // A's catch-up passes (every 500 ms) are idle now: a pass that connected before the tokens are hidden would keep its connection and could learn a state change meanwhile
  const restore = hideBoth(a, b);                                                          // every state change below misses A
  for (let start = 0; start < 250; start += 25)
    await Promise.all(ids.slice(start, start + 25).map(async id => { expect((await task(b.person, "hub_task_cancel", { id, reason: "stale" })).ok).toBe(true); }));
  await Bun.sleep(700);
  const cancelled = () => { const handle = boardOf(a); try { return ((handle.board as any).db.query("SELECT COUNT(*) AS n FROM task_handoff_outbound WHERE last_state='cancelled'").get() as { n: number }).n; } finally { handle.close(); } };
  expect(cancelled()).toBe(0);                                                             // none learned while unreachable
  restore();
  await until(() => cancelled() === 250, "all 250 rows, the oldest 50 included, were caught up", 30_000);
}, 120_000);

test("#733: an origin without task_handoff_seq is sent no seq and not the two new events; it still hears the events it knows", async () => {
  const { a, b } = await pair();
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const statusFile = join(a.stateDir, "status.json"), real = readFileSync(statusFile, "utf8");
  const older = JSON.parse(real); older.features = older.features.filter((feature: string) => feature !== "task_handoff_seq");
  // A's daemon rewrites status.json on every bus event, so the older shape is held in place for the length of the test, the way an older daemon's file would read.
  const hold = setInterval(() => { try { const now = JSON.parse(readFileSync(statusFile, "utf8")); if (now.features?.includes("task_handoff_seq")) writeFileSync(statusFile, JSON.stringify({ ...now, features: now.features.filter((feature: string) => feature !== "task_handoff_seq") })); } catch { /* mid-rewrite */ } }, 5);
  cleanup.push(() => clearInterval(hold));
  writeFileSync(statusFile, JSON.stringify(older));                                        // A reads as an origin from before sequences
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  const sent = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for an older origin" }));
  { const codex = new FixturePeer("codex"); b.daemon.bus.add(codex); await codex.start(); }
  expect((await task(b.person, "task_assign", { id: sent.task, peer: "codex", role: "owner" })).ok).toBe(true);
  const implementer = await b.connect({ role: "tools", peer: "codex" });
  expect((await task(implementer, "hub_task_accept", { id: sent.task })).ok).toBe(true);
  await until(() => received.some(env => env.body === `agent-hub task ${sent.task} accepted`), "an event the older origin knows still arrives");
  expect(readOnly(a).handoffOutbound()[0]!.seq).toBeNull();                               // sent without a sequence
  expect(DAEMON_FEATURES).toContain("task_handoff_seq");
}, 60_000);

// #733 review: handoffWatch asks for ONE catch-up for the whole changed set, and a request that arrives while a pass is running is queued and drained when it ends, never dropped by the one-pass guard.
// Each project's token is hidden on its own, so its descriptor can come back separately. C files a local task first, so its handed-off task is #2 and the two follow-backs differ.
const hide = (p: Project) => { const file = join(p.stateDir, "control-token"), real = readFileSync(file, "utf8"); rmSync(file); return () => writeFileSync(file, real); };
const twoTargets = async (options: { hold?: () => Promise<void> }) => {
  const { a, b, c } = await pair({ a: { handoffCatchUpMs: 3_600_000, handoffWatchMs: 100, ...(options.hold ? { handoffCatchUpHold: options.hold } : {}) }, more: {} });
  const planner = await a.connect({ role: "tools", peer: "claude" });
  const received: Envelope[] = [];
  const listening = await a.connect({ role: "peer", peer: "claude", channel: true });
  listening.onPush = message => { if (message.t === "deliver") received.push(...(message.envs ?? [message.env])); };
  expect((await task(c.person, "hub_task_propose", { title: "a local task of C", class: "implement" })).ok).toBe(true);
  const sentB = body(await task(planner, "hub_task_handoff", { project: b.id, title: "Chore for B" })), sentC = body(await task(planner, "hub_task_handoff", { project: c.id, title: "Chore for C" }));
  expect([sentB.task, sentC.task]).toEqual([1, 2]);
  const owners: { id: number; owner: ControlClient }[] = [];
  for (const [project, id] of [[b, sentB.task], [c, sentC.task]] as const) {
    { const codex = new FixturePeer("codex"); project.daemon.bus.add(codex); await codex.start(); }
    expect((await task(project.person, "task_assign", { id, peer: "codex", role: "owner" })).ok).toBe(true);
    owners.push({ id, owner: await project.connect({ role: "tools", peer: "codex" }) });   // connected now: a hidden token would refuse a new connection
  }
  await Bun.sleep(350);                                                                    // A's watch has read both descriptors
  const back = { a: hide(a), b: hide(b), c: hide(c) };                                     // all three are away
  for (const { id, owner } of owners) expect((await task(owner, "hub_task_accept", { id })).ok).toBe(true);
  await Bun.sleep(400);                                                                    // A's watch sees them gone
  expect(readOnly(a).handoffOutbound().map(row => row.state)).toEqual(["proposed", "proposed"]);
  const caught = (id: number) => received.some(env => env.body === `agent-hub task ${id} accepted`);
  return { back, caught, ids: [sentB.task as number, sentC.task as number] };
};

test("#733 AC2: two targets whose descriptors change in the same watch tick are both caught up promptly, not only the first", async () => {
  const { back, caught, ids } = await twoTargets({});
  back.a(); back.b(); back.c();                                                            // all come back together
  await until(() => caught(ids[0]!) && caught(ids[1]!), "both targets were caught up long before the hour-long period", 10_000);
}, 60_000);

test("#733 AC2: a descriptor change that arrives while a catch-up pass is running is queued and drained when the pass ends, not dropped", async () => {
  let release!: () => void, holds = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // A's start-up pass goes through; the next one is held open once it has chosen its targets, standing for a long pass, while another descriptor changes.
  const hold = async () => { if (++holds >= 2) await gate; };
  const { back, caught, ids } = await twoTargets({ hold });
  back.a(); back.b();                                                                      // B returns: the watch starts a pass for B, which is held
  await Bun.sleep(500);
  back.c();                                                                                // C returns while that pass is still running
  await Bun.sleep(500);
  expect(caught(ids[0]!) || caught(ids[1]!)).toBe(false);                                  // the held pass has delivered nothing yet
  release();
  await until(() => caught(ids[0]!) && caught(ids[1]!), "C, queued behind the held pass, was caught up when it ended", 10_000);
}, 60_000);
