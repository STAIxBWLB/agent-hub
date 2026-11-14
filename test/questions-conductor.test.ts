import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { parseAnswerArgs } from "../src/cli/answer-args.ts";
import { answerProvenance } from "../src/hub/questions.ts";
import { QuestionStore } from "../src/hub/questions.ts";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";
import { Capture } from "../src/memory/capture.ts";
import { FakeMemoryClient, startFakeMemWorker } from "./fakes/mem-worker.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const QUOTE = "INSTRUCTION_QUOTE_CANARY record the choice I just made";
const ANSWER_TEXT = "ANSWER_TEXT_CANARY selected by the person";
const ANSWERS = [{ questionId: "choice", optionIds: ["a"], other: ANSWER_TEXT }];
const ASK = { questions: [{ id: "choice", prompt: "Select a fixture option", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], allowOther: true }] };
const PROVENANCE = "answered by claude on the person's instruction";
const until = async (condition: () => boolean) => { const deadline = Date.now() + 3000; while (!condition() && Date.now() < deadline) await Bun.sleep(5); expect(condition()).toBe(true); };
class Peer extends BasePeer {
  got: Envelope[] = [];
  get nativeSession() { return `${this.id}-fixture-session`; }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push(...envs); if (id) this.onDelivery?.({ id, state: "completed" }); }
}
type InstructedRow = { set: string; state: string; private: boolean; peer: string; surface?: string; person?: string; instructed?: boolean; instruction?: string; answers?: unknown[] };
async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-question-conductor-"))), stateDir = join(root, ".agenthub/state"), home = join(root, "home");
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); gitProject(root); mkdirSync(stateDir, { recursive: true }); mkdirSync(home);
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ instances: {} }));
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "questions-conductor-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, questionSweepMs: 50,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, roles: { claude: ["conductor"], codex: ["implementer"], pi: ["implementer"] },
      questions: { ttl_s: 86_400, wait_ms: { codex: 1000, claude: 1000, pi: 1000 } }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  const peers: Record<string, Peer> = {};
  for (const id of ["claude", "codex", "pi"]) { const peer = new Peer(id); peers[id] = peer; daemon.bus.add(peer); await peer.start(); }
  const clients: ControlClient[] = [];
  const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, { role, projectRoot: root, ...(peer ? { peer } : {}) }); clients.push(client); return client; };
  const person = await connect("console"), lead = await connect("tools", "claude"), asker = await connect("tools", "codex"), other = await connect("tools", "pi");
  cleanup.push(async () => { for (const client of clients) client.close(); await daemon.stop(); });
  const rows = (openOnly = false) => { const store = new QuestionStore(join(stateDir, "hub.db")); try { return store.list(openOnly ? { state: "open" } : {}, 100) as unknown as InstructedRow[]; } finally { store.close(); } };
  const open = async (peer = "codex", task?: number) => {
    const client = peer === "claude" ? lead : peer === "pi" ? other : asker;
    const waiting = client.request({ t: "task", op: "hub_ask", args: { ...ASK, ...(task === undefined ? {} : { task }) } });
    await until(() => rows(true).some(row => row.peer === peer && row.state === "open"));
    const set = rows(true).find(row => row.peer === peer && row.state === "open")!.set;
    return { set, waiting };
  };
  const answerTool = (client: ControlClient, set: string, ...supplied: unknown[]) => {
    const instruction = supplied.length ? supplied[0] : QUOTE;
    return client.request({ t: "task", op: "hub_ask_answer", args: { set, answers: ANSWERS, ...(instruction === undefined ? {} : { instruction }) } });
  };
  const cli = async (args: string[], peer?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), KIMI_CODE_HOME: join(home, "kimi"), AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: root };
    for (const key of Object.keys(env)) if (key.startsWith("ORCA_") || ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "AGENTHUB_DELIVERY_ONLY", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_UNATTENDED", "CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"].includes(key)) delete env[key];
    if (peer) env.AGENTHUB_PEER_ID = peer;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); await child.exited; }
  };
  return { root, stateDir, daemon, peers, rows, open, answerTool, person, lead, asker, other, cli };
}
function safeSinks(f: Awaited<ReturnType<typeof fixture>>) {
  return ["hub.log", "events.jsonl"].map(name => existsSync(join(f.stateDir, name)) ? readFileSync(join(f.stateDir, name), "utf8") : "").join("\n");
}

test("AC1 conductor tool records a per-set instruction in db only and returns answer provenance", async () => {
  const f = await fixture(), q = await f.open();
  const answered = await f.answerTool(f.lead, q.set); expect(answered.ok, String(answered.error ?? "")).toBe(true);
  const reply = await q.waiting; expect(reply.ok).toBe(true); const result = JSON.parse(reply.text);
  expect(result.status).toBe("answered"); expect(result.actor).toBe("claude"); expect(result.instructed).toBe(true); expect(result.provenance).toContain(PROVENANCE);
  expect(JSON.stringify(result.answers)).toContain(ANSWER_TEXT); expect(JSON.stringify(reply)).not.toContain(QUOTE); expect(JSON.stringify(answered)).not.toContain(QUOTE);
  const row = f.rows().find(row => row.set === q.set)!;
  expect(row).toMatchObject({ state: "answered", surface: "conductor", person: "claude", instructed: true, instruction: QUOTE });
  const view = await f.person.request({ t: "questions" }); expect(JSON.stringify(view)).not.toContain(QUOTE);
  const all = await f.person.request({ t: "questions", state: "all" });
  const projected = all.questions.find((row: Record<string, unknown>) => row.set === q.set);
  expect(projected).toBeDefined(); expect(projected).not.toHaveProperty("instruction"); expect(projected.provenance).toContain(PROVENANCE); expect(JSON.stringify(all)).not.toContain(QUOTE);
  expect(safeSinks(f)).not.toContain(QUOTE); expect(safeSinks(f)).not.toContain(ANSWER_TEXT);
}, 20_000);

test("AC1 instructed control answer supplies the same late-envelope provenance without publishing the quote", async () => {
  const f = await fixture(), q = await f.open(); expect(JSON.parse((await q.waiting).text).status).toBe("pending");
  const reply = await f.lead.request({ t: "answer", questionSet: q.set, answers: ANSWERS, instructed: QUOTE }); expect(reply.ok, String(reply.error ?? "")).toBe(true);
  await until(() => f.peers.codex!.got.some(env => env.kind === "answer"));
  const envelopes = f.peers.codex!.got.filter(env => env.kind === "answer"); expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.body).toContain(PROVENANCE); expect(envelopes[0]!.body).toContain(ANSWER_TEXT); expect(JSON.stringify(envelopes)).not.toContain(QUOTE);
  expect(f.rows().find(row => row.set === q.set)).toMatchObject({ surface: "conductor", person: "claude", instructed: true, instruction: QUOTE });
  expect(safeSinks(f)).not.toContain(QUOTE); expect(safeSinks(f)).not.toContain(ANSWER_TEXT);
}, 20_000);

test("AC2 wrong peer, asking conductor, missing/empty quote and settled sets refuse with cause and person next step", async () => {
  const f = await fixture(), q = await f.open();
  for (const [client, instruction, cause] of [[f.other, QUOTE, /conductor/], [f.lead, undefined, /instruction|quote/], [f.lead, "  ", /instruction|quote/]] as const) {
    const refused = await f.answerTool(client, q.set, instruction); expect(refused.ok).toBe(false); expect(String(refused.error)).toMatch(cause); expect(String(refused.error)).toContain("ahub console");
    expect(f.rows().find(row => row.set === q.set)?.state).toBe("open"); expect(JSON.stringify(refused)).not.toContain(QUOTE);
  }
  expect((await f.person.request({ t: "answer", questionSet: q.set, answers: ANSWERS })).ok).toBe(true); await q.waiting;
  const closed = await f.answerTool(f.lead, q.set); expect(closed.ok).toBe(false); expect(String(closed.error)).toMatch(/answered|open|closed/); expect(String(closed.error)).toContain("ahub console");
  const own = await f.open("claude"), self = await f.answerTool(f.lead, own.set); expect(self.ok).toBe(false); expect(String(self.error)).toMatch(/own|ask/); expect(String(self.error)).toContain("ahub console");
  expect((await f.person.request({ t: "answer", questionSet: own.set, answers: ANSWERS })).ok).toBe(true); await own.waiting;
}, 20_000);

test("AC2 private question and private conductor context remain person-only", async () => {
  const f = await fixture(), board = new Board(join(f.stateDir, "hub.db")); cleanup.push(() => board.close());
  const task = board.propose("user", { title: "private fixture", class: "test", signals: ["pii"] }); board.update(task.id, "user", "accepted", { owner: "codex", state: "in_progress" });
  const q = await f.open("codex", task.id), refused = await f.answerTool(f.lead, q.set); expect(refused.ok).toBe(false); expect(String(refused.error)).toMatch(/private|person/); expect(String(refused.error)).toContain("ahub console");
  expect(f.rows().find(row => row.set === q.set)?.private).toBe(true); expect((await f.person.request({ t: "answer", questionSet: q.set, answers: ANSWERS })).ok).toBe(true); await q.waiting;
  board.update(task.id, "user", "approved", { state: "approved" });
  const publicQuestion = await f.open(), context = board.propose("user", { title: "private conductor fixture", class: "test", signals: ["pii"] }); board.update(context.id, "user", "accepted", { owner: "claude", state: "in_progress" });
  const privateActor = await f.answerTool(f.lead, publicQuestion.set); expect(privateActor.ok).toBe(false); expect(String(privateActor.error)).toMatch(/private|person/); expect(String(privateActor.error)).toContain("ahub console");
  expect((await f.person.request({ t: "answer", questionSet: publicQuestion.set, answers: ANSWERS })).ok).toBe(true); await publicQuestion.waiting;
}, 20_000);

test("AC3 person parity and real CLI instructed conductor path, audit and agent refusals", async () => {
  const f = await fixture(), personQuestion = await f.open();
  const person = await f.cli(["answer", personQuestion.set, "choice=a", "--other", ANSWER_TEXT]); expect(person.code, person.stderr).toBe(0); await personQuestion.waiting;
  expect(f.rows().find(row => row.set === personQuestion.set)).toMatchObject({ surface: "terminal" });
  const instructed = await f.open(), cli = await f.cli(["answer", instructed.set, "choice=a", "--other", ANSWER_TEXT, "--instructed", QUOTE], "claude");
  expect(cli.code, cli.stderr).toBe(0); await instructed.waiting; expect(f.rows().find(row => row.set === instructed.set)).toMatchObject({ surface: "conductor", person: "claude", instructed: true, instruction: QUOTE });
  expect(classifyPeerCommand("answer", [instructed.set, "choice=a", "--instructed", QUOTE])).toBe("conductor");
  const audit = () => readFileSync(join(f.stateDir, "events.jsonl"), "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }).filter(row => row.type === "agent_cli");
  await until(() => audit().some(row => row.peer === "claude" && row.instructed === true));
  expect(audit().some(row => row.peer === "claude" && row.instructed === true)).toBe(true);
  for (const [args, peer] of [[["answer", "qs-aaaaaaaaaaaa", "choice=a"], "claude"], [["answer", "qs-aaaaaaaaaaaa", "choice=a", "--instructed", QUOTE], "pi"], [["--live-test", "answer", "qs-aaaaaaaaaaaa", "choice=a", "--instructed", QUOTE], "claude"]] as [string[], string][]) {
    const refused = await f.cli(args, peer); expect(refused.code).not.toBe(0); expect(refused.stdout + refused.stderr).not.toContain(QUOTE); expect(refused.stdout + refused.stderr).toContain("ahub console");
  }
  expect(safeSinks(f)).not.toContain(QUOTE); expect(safeSinks(f)).not.toContain(ANSWER_TEXT);
}, 20_000);

test("AC4 capture excludes instructed-answer tool input/output while ordinary capture remains enabled", async () => {
  const mem = startFakeMemWorker(); cleanup.push(mem.stop);
  const capture = new Capture(new FakeMemoryClient(mem.url), { project: "p", cwd: "/p", skip: [], deny: [] }); capture.init("session-fixture", "start");
  for (const tool of ["hub_ask_answer", "mcp__agent_hub_claude__hub_ask_answer"]) capture.observe({ tool, args: JSON.stringify({ set: "qs-aaaaaaaaaaaa", answers: ANSWERS, instruction: QUOTE }), output: JSON.stringify({ status: "answered", answers: ANSWERS }), id: tool, paths: [] });
  capture.observe({ tool: "read", args: "{}", output: "ordinary output", id: "ordinary", paths: [] });
  await until(() => mem.calls.some(row => row.path.endsWith("/observations") && (row.body as { tool_name?: string }).tool_name === "read"));
  const names = mem.calls.filter(row => row.path.endsWith("/observations")).map(row => (row.body as { tool_name: string }).tool_name);
  expect(names).toEqual(["read"]); expect(JSON.stringify(mem.calls)).not.toContain(QUOTE); expect(JSON.stringify(mem.calls)).not.toContain(ANSWER_TEXT);
});


test("instruction CLI parser requires one nonempty quote within 500 characters and preserves legacy answers", () => {
  const base = ["qs-aaaaaaaaaaaa", "choice=a"];
  const plain = parseAnswerArgs(base); expect(plain.ok).toBe(true); if (!plain.ok) throw new Error("expected ordinary person args"); expect(plain.value).not.toHaveProperty("instruction");
  const atBound = parseAnswerArgs([...base, "--instructed", "x".repeat(500)]); expect(atBound.ok).toBe(true);
  for (const tail of [["--instructed"], ["--instructed", ""], ["--instructed", "   "], ["--instructed", "x".repeat(501)], ["--instructed", QUOTE, "--instructed", QUOTE]]) {
    const parsed = parseAnswerArgs([...base, ...tail]); expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected invalid instruction refusal");
    expect(parsed.error).toMatch(/instruction|instructed|quote/); expect(parsed.error).toContain("ahub console"); expect(parsed.error).not.toContain(QUOTE);
  }
});

test("answer provenance is a fixed actor attribution and never quotes the database-only instruction", () => {
  expect(answerProvenance({ person: "claude", instructed: true, instruction: QUOTE } as { person: string; instructed: true })).toBe(PROVENANCE);
  expect(answerProvenance({ person: "console-fixture" })).toBeUndefined();
});

test("settled history cannot crowd out an open question or recent instructed provenance in default reads and CLI listing", async () => {
  const f = await fixture(), store = new QuestionStore(join(f.stateDir, "hub.db"));
  let instructedSet: string;
  try {
    const base = Date.now() - 120_000;
    for (let i = 0; i < 101; i++) {
      const row = store.ask({ peer: "pi", session: "pi-fixture-session", private: false, questions: ASK.questions }, base + i);
      if ("error" in row) throw new Error("fixture question seed refused");
      const answer = store.answer(row.set, ANSWERS, "terminal", base + i + 1, false); expect(answer.ok).toBe(true);
    }
    const row = store.ask({ peer: "pi", session: "pi-fixture-session", private: false, questions: ASK.questions }, Date.now() - 1000);
    if ("error" in row) throw new Error("fixture instructed question seed refused");
    instructedSet = row.set;
    expect(store.answer(row.set, ANSWERS, "conductor", Date.now() - 500, false, "claude", QUOTE).ok).toBe(true);
  } finally { store.close(); }
  const q = await f.open(), read = await f.person.request({ t: "questions" }); expect(read.ok).toBe(true);
  expect(read.questions.some((row: Record<string, unknown>) => row.set === q.set && row.state === "open")).toBe(true);
  const provenance = read.answeredQuestions.find((row: Record<string, unknown>) => row.set === instructedSet);
  expect(provenance).toBeDefined(); expect(provenance.provenance).toBe(PROVENANCE); expect(provenance).not.toHaveProperty("instruction"); expect(JSON.stringify(read)).not.toContain(QUOTE);
  const listing = await f.cli(["answer"]); expect(listing.code, listing.stderr).toBe(0); expect(listing.stdout).toContain(q.set); expect(listing.stdout + listing.stderr).not.toContain(QUOTE);
  expect((await f.person.request({ t: "answer", questionSet: q.set, answers: ANSWERS })).ok).toBe(true); await q.waiting;
}, 20_000);
