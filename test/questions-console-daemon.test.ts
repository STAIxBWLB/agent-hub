import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { QuestionStore } from "../src/hub/questions.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";
import { Capture } from "../src/memory/capture.ts";
import { FakeMemoryClient, startFakeMemWorker } from "./fakes/mem-worker.ts";
import { readEvents } from "../src/hub/events.ts";

// #1053 T4 (console, CLI and status) and T6 (AC6 privacy) against the real daemon, the real control protocol and the real `ahub` entry, with fake peers.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const CLI = join(import.meta.dir, "../src/cli/main.ts");

class FakePeer extends BasePeer {
  readonly got: Envelope[] = [];
  constructor(id: string) { super(id); }
  get nativeSession() { return `${this.id}-session`; }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push(...envs); if (id) this.onDelivery?.({ id, state: "accepted" }); queueMicrotask(() => { if (id) this.onDelivery?.({ id, state: "completed" }); }); }
}
const opt = (id: string, label = id) => ({ id, label });
const until = async (condition: () => boolean, label: string) => { for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10); if (!condition()) throw new Error(`timed out waiting for ${label}`); };

async function rig(wait = 1000) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-questions-c-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd);
  const stateDir = join(cwd, ".agenthub/state"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{"instances":{}}\n');
  // a task whose title matches this pattern is a PII task for the routing
  writeFileSync(join(cwd, ".agenthub/routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-MARKER"]').replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  const daemon = await startDaemon({ cwd, stateDir, projectId: "questions-console", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, questionSweepMs: 50,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, questions: { ttl_s: 86_400, wait_ms: { codex: wait } }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const codex = new FakePeer("codex"); daemon.bus.add(codex); await codex.start();
  const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  const agent = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: cwd });
  const rows = () => { const probe = new QuestionStore(join(stateDir, "hub.db")); try { return probe.list({}, 50); } finally { probe.close(); } };
  cleanup.push(async () => { person.close(); agent.close(); await daemon.stop(); });
  const ask = (args: unknown) => agent.request({ t: "task", op: "hub_ask", args });
  const setOf = async () => { await until(() => rows().some(row => row.state === "open"), "an open question"); return rows().find(row => row.state === "open")!.set; };
  // the CLI as a person runs it: no agent markers, this project's state
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const wrapper = join(cwd, `cli-${crypto.randomUUID()}.ts`);
    const markers = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED"];
    writeFileSync(wrapper, `for(const key of ${JSON.stringify(markers)})delete process.env[key];Object.assign(process.env,${JSON.stringify({ AGENTHUB_HOME: join(cwd, "home"), ...env })});process.argv=[process.execPath,${JSON.stringify(CLI)},...${JSON.stringify(args)}];await import(${JSON.stringify(CLI)});`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); rmSync(wrapper, { force: true }); }
  };
  return { cwd, stateDir, daemon, codex, person, agent, ask, rows, setOf, cli };
}
const TWO = { questions: [{ id: "db", prompt: "Which database?", options: [opt("pg", "Postgres"), opt("sqlite", "SQLite")] }, { id: "extras", prompt: "Which extras?", options: [opt("a"), opt("b")], multi: true, allowOther: true }] };

test("an open question is a waiting need in status until it settles, and viewing the list never clears it", async () => {
  const f = await rig(60_000);
  expect((await f.person.request({ t: "status" })).status.needs).toMatchObject({ act: 0 });
  void f.ask(TWO);
  const set = await f.setOf();
  const waiting = (await f.person.request({ t: "status" })).status;
  expect(waiting.needs).toMatchObject({ act: 1, state: "waiting", first: { kind: "question", level: "act", peer: "codex", id: set } });
  expect(JSON.stringify(waiting)).not.toContain("Which database");
  // reading the list (the console, `ahub answer`) is a view: the need stays
  expect((await f.person.request({ t: "questions" })).questions).toHaveLength(1);
  expect((await f.cli(["answer"])).code).toBe(0);
  expect((await f.person.request({ t: "status" })).status.needs).toMatchObject({ act: 1, state: "waiting" });
  await f.person.request({ t: "answer", questionSet: set, surface: "console", answers: [{ questionId: "db", optionIds: ["pg"] }, { questionId: "extras", optionIds: ["a"] }] });
  expect((await f.person.request({ t: "status" })).status.needs).toMatchObject({ act: 0 });
});

test("ahub answer lists the open questions, answers one through the real CLI, and the waiting call gets the person's options", async () => {
  const f = await rig(30_000);
  expect((await f.cli(["answer"])).stdout).toContain("no open questions");
  const waiting = f.ask(TWO);
  const set = await f.setOf();
  const listed = await f.cli(["answer"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stdout).toContain(`${set}  codex asks`);
  expect(listed.stdout).toContain("db: Which database?");
  expect(listed.stdout).toContain("pg  Postgres");
  expect(listed.stdout).toContain(`ahub answer ${set} db=pg extras=a`);
  expect(JSON.parse((await f.cli(["answer", "--json"])).stdout)[0]).toMatchObject({ set, peer: "codex" });
  const refused = await f.cli(["answer", set, "db=mysql", "extras=a"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("an option id was not offered");
  expect(refused.stderr).not.toContain("mysql"); // a refusal names a question by position, never the value
  expect(f.rows()[0]!.state).toBe("open");
  const missing = await f.cli(["answer", set, "db=pg"]);
  expect(missing.code).toBe(1); expect(missing.stderr).toContain("question 2 has no answer");
  const bad = await f.cli(["answer", "db=pg"]);
  expect(bad.code).toBe(1); expect(bad.stderr).toContain("usage: ahub answer");
  const done = await f.cli(["answer", set, "db=sqlite", "extras=a,b", "--other", "extras=and more"]);
  expect(done.code, done.stderr).toBe(0);
  expect(done.stdout).toContain(`answered ${set}`);
  expect(JSON.parse((await waiting).text)).toEqual({ status: "answered", questionSet: set, answers: [{ questionId: "db", optionIds: ["sqlite"] }, { questionId: "extras", optionIds: ["a", "b"], other: "and more" }], answeredBy: "person", surface: "terminal" });
  const again = await f.cli(["answer", set, "db=pg", "extras=a"]);
  expect(again.code).toBe(1); expect(again.stderr).toContain("already answered");
});

test("an agent shell is refused ahub answer before it reaches the hub, and its audit line names no set or option", async () => {
  const f = await rig(30_000);
  void f.ask(TWO);
  const set = await f.setOf();
  const refused = await f.cli(["answer", set, "db=pg", "extras=a"], { AGENTHUB_PEER_ID: "codex" });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("ahub console or a terminal");
  expect(f.rows()[0]!.state).toBe("open");
  const audits = readEvents(join(f.stateDir, "events.jsonl")).filter(e => e.type === "agent_cli");
  expect(JSON.stringify(audits)).not.toContain(set);
  expect(JSON.stringify(audits)).not.toContain("db=pg");
});

test("the dashboard snapshot carries the open question for the person, and a live-test dashboard never gets its text", async () => {
  const f = await rig(30_000);
  void f.ask(TWO);
  const set = await f.setOf();
  const snap = await f.person.request({ t: "ui_snapshot", after: 0 });
  expect(snap.questions).toEqual([expect.objectContaining({ set, peer: "codex", private: false, questions: expect.arrayContaining([expect.objectContaining({ id: "db", prompt: "Which database?" })]) })]);
});

// T6 / AC6 --------------------------------------------------------------------------------------------------------------------------------------------------------------
const SECRETS = ["PRIVATE-MARKER-PROMPT", "PRIVATE-MARKER-LABEL", "TOPSECRET-OTHER-TEXT", "PRIVATE-MARKER task title"];

test("AC6 a private question (asked about a PII task) is private in its row, in the status need and in the answer envelope, and no question or answer text reaches hub.log, events.jsonl or memory capture", async () => {
  const f = await rig(1000);
  const task = JSON.parse((await f.person.request({ t: "task", op: "hub_task_propose", args: { title: "PRIVATE-MARKER task title", class: "implement" } })).text.replace(/^task #(\d+).*$/s, '{"id":$1}'));
  const set = JSON.parse((await f.ask({ questions: [{ id: "q", prompt: "PRIVATE-MARKER-PROMPT?", options: [opt("o1", "PRIVATE-MARKER-LABEL"), opt("o2")], allowOther: true }], task: task.id })).text).questionSet as string;
  const row = f.rows().find(r => r.set === set)!;
  expect(row).toMatchObject({ private: true, state: "open" });
  // the status need and the attention model carry ids only
  const status = (await f.person.request({ t: "status" })).status;
  expect(JSON.stringify(status)).not.toContain("PRIVATE-MARKER");
  expect(status.needs.first).toMatchObject({ kind: "question", id: set });
  // the dashboard snapshot flags it private so a surface shows a stub; the text is the person's panel only
  const snap = await f.person.request({ t: "ui_snapshot", after: 0 });
  expect(snap.questions[0]).toMatchObject({ set, private: true });
  expect(JSON.stringify(snap.tasks)).not.toContain("PRIVATE-MARKER task title");
  // the late answer travels as a private envelope the asking peer alone receives
  await f.person.request({ t: "answer", questionSet: set, surface: "terminal", answers: [{ questionId: "q", optionIds: [], other: "TOPSECRET-OTHER-TEXT" }] });
  await until(() => f.codex.got.some(env => env.kind === "answer"), "the answer envelope");
  expect(f.codex.got.find(env => env.kind === "answer")).toMatchObject({ private: true });
  await Bun.sleep(150);
  for (const name of ["hub.log", "events.jsonl"]) {
    const file = join(f.stateDir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const secret of SECRETS) expect(text, `${name} must not hold ${secret}`).not.toContain(secret);
  }
  const events = readEvents(join(f.stateDir, "events.jsonl")).filter(e => e.type === "question");
  expect(events.map(e => e.event)).toEqual(["asked", "pending", "answered"]);
  expect(events.every(e => e.private === true)).toBe(true);
  for (const event of events) expect(Object.keys(event).every(key => ["v", "at", "type", "set", "peer", "event", "latencyMs", "surface", "reason", "questions", "private"].includes(key)), JSON.stringify(Object.keys(event))).toBe(true);
});

test("AC6 memory capture drops a hub_ask call and its answer whatever the paths say, while an ordinary tool call is still captured", async () => {
  const mem = startFakeMemWorker(); cleanup.push(mem.stop);
  const capture = new Capture(new FakeMemoryClient(mem.url), { project: "p", cwd: "/p", skip: [], deny: [] });
  capture.init("session-1", "start");
  const call = (tool: string, args: string, output: string, id: string) => capture.observe({ tool, args, output, id, paths: [] });
  call("hub_ask", JSON.stringify({ questions: [{ prompt: "PRIVATE-MARKER-PROMPT?" }] }), JSON.stringify({ status: "pending", questionSet: "qs-0123456789ab" }), "1");
  call("mcp__agent_hub_codex__hub_ask", "PRIVATE-MARKER-PROMPT", "TOPSECRET-OTHER-TEXT", "2");
  call("read", "{}", "ordinary output", "3");
  await until(() => mem.calls.some(c => c.path.endsWith("/observations") && (c.body as { tool_name: string }).tool_name === "read"), "the ordinary observation");
  await Bun.sleep(50);
  const observations = mem.calls.filter(c => c.path.endsWith("/observations")).map(c => (c.body as { tool_name: string }).tool_name);
  expect(observations).toEqual(["read"]);
  expect(JSON.stringify(mem.calls)).not.toContain("PRIVATE-MARKER");
  expect(JSON.stringify(mem.calls)).not.toContain("TOPSECRET");
});
