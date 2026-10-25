import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { Registry } from "../src/hub/registry.ts";
import { paint } from "../src/cli/console-state.ts";
import { renderBacklogResult, renderGroom, renderReleaseChange, renderReleaseList, renderReleaseNew, renderReleaseShow, renderTaskCancel, renderTaskShow } from "../src/cli/task-output.ts";

// #814 T2: task show/cancel, the backlog mutations and grooming, and the release commands print for a person by default;
// `--json` prints the hub tool's text exactly as before. The hub tools themselves keep returning JSON to agents.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const NOW = Date.parse("2026-10-25T16:00:00Z");
const A = "a".repeat(40);
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const parses = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const MANY = Array.from({ length: 30 }, (_, i) => i + 1);
const LONG_TITLE = "Implement the human output for every task, backlog and release command with a deliberately very long title that has to wrap under its number at eighty columns";

const task = { id: 7, title: LONG_TITLE, detail: "The detail text of the task, which is long enough to wrap beside its label at eighty columns without losing a word.", class: "implement", owner: "jcode", reviewer: "codex-review", planner: "claude", state: "in_review",
  refs: { repo: "STAIxBWLB/agent-hub", branch: "feat/814-task-output", commit: A, paths: ["src/cli/task-output.ts", "test/task-output.test.ts"] },
  plan: { paths: ["src/cli/task-output.ts"], symbols: ["renderTaskShow"], signatures: ["renderTaskShow(task: unknown, columns?: number): Span[][]"] },
  deps: MANY, signals: [], rejections: 0, created: NOW - 7_200_000, updated: NOW - 60_000, rank: 3, priority: 1, release: 2, planningRevision: 4,
  sdlc: { stage: "review", repo: "STAIxBWLB/agent-hub", issue: 814, pr: 833, head: A },
  relatedMemory: { state: "ready", count: 2 }, symbolOverlaps: [{ task: 8, files: ["src/hub/tasks.ts", "src/cli/task-output.ts"], sameFileDifferentSymbols: true }, { task: 12, files: [], sameFileDifferentSymbols: false }], flowRevision: 9,
  deliverables: { state: "approved", changedSinceReview: true, files: [{ id: "d1", sha256: "b".repeat(64), state: "changed", path: "docs/report-with-a-fairly-long-name.md", format: "md", version: "v2" }, { id: "d2", sha256: "c".repeat(64), state: "unchanged", format: "csv", private: true }] },
  reviews: [{ kind: "approved", reviewer: "codex-review", at: NOW - 3_600_000 }],
  history: [{ at: NOW - 7_000_000, by: "claude", event: "proposed" }, { at: NOW - 6_000_000, by: "jcode", event: "accepted", note: "plan: renderers in task-output.ts" }, { at: NOW - 60_000, by: "codex-review", event: "changes_requested", note: "a long review note that has to wrap in the NOTE column without being cut at eighty columns" }] };
const piiTask = { id: 9, title: "[pii]", detail: "[pii]", class: "implement", owner: "local", reviewer: null, state: "in_progress", refs: {}, plan: {}, deps: [], signals: ["pii"], rejections: 0, created: NOW - 600_000, updated: NOW - 1_000, actualDates: {}, history: [] };
const card = { ...task, planningRevision: 0, state: "backlog", owner: null, reviewer: null, history: [{ at: NOW - 1000, by: "claude", event: "planned", note: "priority 1 and a long reason that must wrap" }] };
const release = { id: 2, name: "0.18.0", goal: "Readable output everywhere a person looks, and a guard so it stays that way", order: 2, state: "active", plannedStart: NOW - 86_400_000, cut: null, ship: null, activatedAt: NOW - 3_600_000, frozenAt: null, shippedAt: null, created: NOW - 9e6, updated: NOW - 1e6, revision: 4,
  tasks: MANY.map(id => ({ id, state: id % 3 ? "approved" : "in_progress", deps: [] })), afterCutUnknown: [41, 42], afterCutUnknownCount: 2, afterCut: null, afterCutCount: null };
const groom = { items: [{ kind: "overlap", task: 7, related: MANY, code: "tests" }, { kind: "stale", task: 8 }, { kind: "duplicate", task: 9, related: [10], personCommand: "ahub backlog return 9 3 a very long reason for the person to read before running this command at eighty columns" }], unknown: [11, 12], truncated: true, privateTasks: "withheld" };

/** Each command: its argv, the hub op it calls with the args it must send, what the fake hub answers (the exact text), and what a person must see. */
type Case = { name: string; argv: string[]; op: string; args: Record<string, unknown>; text: string; must: string[] };
const cases: Case[] = [
  { name: "task show", argv: ["task", "show", "7"], op: "task_show", args: { id: "7" }, text: JSON.stringify(task, null, 2), must: ["#7", "in_review", "jcode", "codex-review", "#30", "renderTaskShow", "changes_requested", "feat/814-task-output", "planning rev 4", "flow rev 9", "#8 touches src/hub/tasks.ts", "same file, different symbols", "#12 touches files withheld", "deliverables", "changed since review", "docs/report-with-a-fairly-long-name.md", "(private)"] },
  { name: "task show of a private task", argv: ["task", "show", "9"], op: "task_show", args: { id: "9" }, text: JSON.stringify(piiTask, null, 2), must: ["#9", "[pii]", "private task", "withheld"] },
  { name: "task show of a task that does not exist", argv: ["task", "show", "99"], op: "task_show", args: { id: "99" }, text: JSON.stringify("no task #99"), must: ["no task #99"] },
  { name: "task cancel", argv: ["task", "cancel", "7", "--reason", "superseded by the new plan", "--superseded-by", "#8"], op: "hub_task_cancel", args: { id: 7, reason: "superseded by the new plan", superseded_by: "#8" }, text: JSON.stringify({ ...task, state: "cancelled", cancelled: { reason: "superseded by the new plan", supersededBy: "#8" }, history: undefined }), must: ["cancelled", "superseded by the new plan", "#8"] },
  { name: "backlog plan", argv: ["backlog", "plan", "7", "3", '{"priority":1}', "raise it"], op: "hub_backlog_plan", args: { id: 7, revision: 3, fields: { priority: 1 }, reason: "raise it" }, text: JSON.stringify(card), must: ["Backlog card planned", "#7", "backlog", "priority P1", "planning rev 0"] },
  { name: "backlog pin", argv: ["backlog", "pin", "7", "3", "true", "keep it first"], op: "hub_backlog_plan", args: { id: 7, revision: 3, fields: { pinned: true }, reason: "keep it first" }, text: JSON.stringify({ ...card, pinned: true }), must: ["Backlog card pinned", "pinned"] },
  { name: "backlog return-untouched", argv: ["backlog", "return", "7", "3", "nobody started it"], op: "hub_backlog_return_untouched", args: { id: 7, revision: 3, reason: "nobody started it" }, text: JSON.stringify(card), must: ["returned to the backlog", "#7"] },
  { name: "backlog pull-ready", argv: ["backlog", "pull-ready", "7", "3", "it is ready"], op: "hub_backlog_pull", args: { id: 7, revision: 3, reason: "it is ready" }, text: JSON.stringify({ ...card, state: "proposed", owner: "jcode" }), must: ["pulled and routed", "proposed", "jcode"] },
  { name: "backlog split", argv: ["backlog", "split", "7", "3", '[{"title":"first part"},{"title":"second part"}]', "too big"], op: "hub_backlog_split", args: { id: 7, revision: 3, parts: [{ title: "first part" }, { title: "second part" }], reason: "too big" }, text: JSON.stringify({ parent: card, children: [{ id: 21, title: "first part", state: "backlog", deps: [] }, { id: 22, title: "second part", state: "backlog", deps: [21] }] }), must: ["Backlog card split", "2 child cards", "#21", "#22", "first part"] },
  { name: "backlog undo", argv: ["backlog", "undo", "7", "3"], op: "hub_backlog_undo", args: { id: 7, revision: 3 }, text: JSON.stringify(card), must: ["Planning change undone", "#7"] },
  { name: "backlog groom", argv: ["backlog", "groom"], op: "hub_planner_groom", args: {}, text: JSON.stringify(groom), must: ["Backlog grooming", "overlaps other open work", "#30", "not enough evidence", "truncated", "private tasks are withheld"] },
  { name: "release list", argv: ["release", "list"], op: "hub_release_list", args: {}, text: JSON.stringify([release, { ...release, id: 3, name: "0.19.0", state: "planned", tasks: [] }]), must: ["#2", "0.18.0", "active", "#30 in_progress", "#3", "0.19.0", "no task assigned"] },
  { name: "release show", argv: ["release", "show", "0.18.0"], op: "release_show", args: { name: "0.18.0" }, text: JSON.stringify(release), must: ["0.18.0", "active", "Readable output everywhere", "unknown date", "#41"] },
  { name: "release new", argv: ["release", "new", "0.20.0", "a goal", "3"], op: "release_new", args: { name: "0.20.0", goal: "a goal", order: 3 }, text: JSON.stringify({ ...release, id: 4, name: "0.20.0", goal: "a goal", state: "planned", tasks: [] }), must: ["Release created", "0.20.0", "a goal"] },
  { name: "release plan", argv: ["release", "plan", "0.18.0", "4", '{"cut":1800000000000}'], op: "release_change", args: { name: "0.18.0", revision: 4, fields: { cut: 1800000000000 } }, text: JSON.stringify({ ...release, cut: 1800000000000 }), must: ["Release updated", "0.18.0", "cut"] },
  { name: "release activate", argv: ["release", "activate", "0.18.0", "4"], op: "release_change", args: { name: "0.18.0", revision: 4, fields: { state: "active" } }, text: JSON.stringify(release), must: ["Release updated", "active"] },
  { name: "release freeze", argv: ["release", "freeze", "0.18.0", "4"], op: "release_change", args: { name: "0.18.0", revision: 4, fields: { state: "frozen" } }, text: JSON.stringify({ ...release, state: "frozen" }), must: ["Release updated", "frozen"] },
  { name: "release ship", argv: ["release", "ship", "0.18.0", "4"], op: "release_change", args: { name: "0.18.0", revision: 4, fields: { state: "shipped" } }, text: JSON.stringify({ ...release, state: "shipped" }), must: ["Release updated", "shipped"] },
  { name: "release drop", argv: ["release", "drop", "0.18.0", "4"], op: "release_change", args: { name: "0.18.0", revision: 4, fields: { state: "dropped" } }, text: JSON.stringify({ ...release, state: "dropped" }), must: ["Release updated", "dropped"] },
];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-task-output-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const registry = new Registry(join(root, "home/registry.db"));
  const project = registry.register(root, stateDir); registry.close();
  const status = { projectId: project.id, pid: process.pid, cwd: root, controlPort: 12345, instanceId: "task-output-fixture", peers: {}, tasks: {} };
  const requests: any[] = []; let answer = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, body) {
      const req = JSON.parse(String(body)); requests.push(req);
      const reply = req.t === "hello" ? { t: "welcome", cwd: root, projectId: project.id, instanceId: status.instanceId, features: ["task_cancel"] } : req.t === "status" ? { status } : req.t === "task" ? { text: answer } : {};
      ws.send(JSON.stringify({ ok: true, ...reply, rid: req.rid }));
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const name of ["bun", "claude", "codex", "kimi", "dot"]) writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in\n  --version) echo 'fixture 1.0';;\nesac\n`, { mode: 0o755 });
  const wrapper = join(root, "run.ts");
  writeFileSync(wrapper, `Date.now = () => ${NOW}; await import(${JSON.stringify(CLI)});`);
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const childEnv: Record<string, string> = { ...process.env as Record<string, string>, HOME: root, AGENTHUB_HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color", ...env };
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_DELIVERY_ONLY", "NO_COLOR", "COLUMNS"]) if (!(marker in env)) delete childEnv[marker];
    const proc = Bun.spawn([process.execPath, wrapper, ...args], { cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { run, requests, serve: (text: string) => { answer = text; } };
}
const taskCalls = (f: ReturnType<typeof fixture>) => f.requests.filter(r => r.t === "task");

for (const c of cases) {
  test(`AC1 ${c.name}: the default is for a person, --json is the hub's text byte for byte, and no presentation flag reaches the hub`, async () => {
    const f = fixture(); f.serve(c.text);
    const human = await f.run(c.argv);
    expect(human.code, human.stderr).toBe(0);
    if (!c.name.includes("does not exist")) expect(parses(human.stdout), "default output must not parse as JSON").toBe(false);
    expect(human.stdout).not.toMatch(/^\s*[{[]/); expect(human.stdout).not.toMatch(/"[A-Za-z_]+":/); expect(human.stdout).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    for (const needle of c.must) expect(flat(human.stdout).toLowerCase(), needle).toContain(needle.toLowerCase());
    const json = await f.run([...c.argv, "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout).toBe(c.text + "\n");
    // the hub saw the same operation with the same arguments every time
    expect(taskCalls(f).map(r => ({ op: r.op, args: r.args }))).toEqual([{ op: c.op, args: c.args }, { op: c.op, args: c.args }]);
  });

  test(`AC3 ${c.name}: 80 and 200 columns with a long title and a long dependency list, nothing over the width, --color=never plain`, async () => {
    const f = fixture(); f.serve(c.text);
    const narrow = await f.run([...c.argv, "--color=never"], { COLUMNS: "80" });
    const wide = await f.run([...c.argv, "--color=never"], { COLUMNS: "200" });
    expect(narrow.code, narrow.stderr).toBe(0); expect(wide.code, wide.stderr).toBe(0);
    for (const line of narrow.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80);
    for (const line of wide.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(200);
    expect(narrow.stdout).not.toContain("\x1b"); expect(wide.stdout).not.toContain("\x1b");
    // every #id of the wide rendering is whole in the narrow one
    const ids = (text: string) => [...(text.match(/#\d+/g) ?? [])].sort();
    expect(ids(narrow.stdout)).toEqual(ids(wide.stdout));
    const colored = await f.run([...c.argv, "--color=always"], { COLUMNS: "200" });
    // a bare sentence has nothing to paint; every rendered block does
    if (c.name.includes("does not exist")) expect(colored.stdout).toBe(wide.stdout);
    else { expect(colored.stdout).toContain("\x1b["); expect(plain(colored.stdout)).toBe(wide.stdout); }
  });
}

test("an invalid --color refuses BEFORE any request is sent, so a mutation never happens behind a usage error", async () => {
  const f = fixture(); f.serve(JSON.stringify(card));
  for (const c of cases) {
    const before = taskCalls(f).length;
    const result = await f.run([...c.argv, "--color=invalid"]);
    expect(result.code, c.name).toBe(1); expect(result.stderr, c.name).toContain("usage:");
    expect(taskCalls(f).length - before, `${c.name} sent a request before refusing`).toBe(0);
  }
});

test("a repeated or conflicting --color refuses BEFORE any request is sent, for every command", async () => {
  const f = fixture(); f.serve(JSON.stringify(card));
  // the space form `--color always` is only an error where the operands are fixed: on backlog commands the trailing words are the reason, free text by design
  for (const c of cases) for (const extra of [["--color=never", "--color=always"], ...(c.argv[0] === "backlog" ? [] : [["--color=never", "--color", "always"]])]) {
    const before = taskCalls(f).length;
    const result = await f.run([...c.argv, ...extra]);
    expect(result.code, `${c.name} ${extra.join(" ")}`).toBe(1); expect(result.stderr, c.name).toMatch(/usage:|invalid .* command/);
    expect(taskCalls(f).length - before, `${c.name} sent a request before refusing`).toBe(0);
  }
});

test("a private task renders as its stub in task show, cancel and every backlog result: no title, detail, path or plan, only the pointer", () => {
  const secretPlan = { ...piiTask, refs: {}, plan: {} };
  for (const lines of [renderTaskShow(secretPlan, 80, NOW), renderTaskCancel({ ...secretPlan, state: "cancelled", cancelled: { reason: "r" } }, 80, NOW), renderBacklogResult("plan", secretPlan, 80, NOW), renderBacklogResult("split", { parent: secretPlan, children: [] }, 80, NOW)]) {
    const text = lines.map(line => paint(line, false)).join("\n");
    expect(text).toContain("[pii]");
    expect(text).not.toMatch(/detail\n/); expect(text).not.toContain("plan\n"); expect(text).not.toContain("ref paths");
  }
  const show = renderTaskShow(secretPlan, 80, NOW).map(line => paint(line, false)).join("\n");
  expect(show).toContain("private task"); expect(show).toContain("ahub task show 9");
});

test("renderers are pure and tolerate an empty or partial reply, and terminal control text in data is neutralised", () => {
  const renderers: ((value: unknown, columns?: number, now?: number) => unknown[][])[] = [renderTaskShow, renderTaskCancel, renderGroom, renderReleaseList, renderReleaseShow, renderReleaseChange, renderReleaseNew, (v, c, n) => renderBacklogResult("plan", v, c, n), (v, c, n) => renderBacklogResult("split", v, c, n)];
  for (const render of renderers) for (const input of [undefined, null, {}, [], { items: [] }, "no such thing"]) {
    const text = (render(input, 80, NOW) as any[][]).map(line => paint(line, false)).join("\n");
    expect(text).not.toMatch(/undefined|NaN|\[object/);
  }
  const hostile = { ...task, title: "\x1b[31mred\x1b]0;owned\x07 title", history: [{ at: NOW, by: "a\x1b[2J", event: "e", note: "n\x1b[1mote" }] };
  const out = renderTaskShow(hostile, 80, NOW).map(line => paint(line, false)).join("\n");
  expect(out).not.toContain("\x1b"); expect(out).toContain("red");
});

test("free text keeps its words: a --json in the middle of a reason is text, a trailing one is the flag, and a value flag's value is never a flag", async () => {
  const f = fixture(); f.serve(JSON.stringify(card));
  await f.run(["backlog", "plan", "7", "3", '{"priority":1}', "keep", "--json", "in", "the", "reason"]);
  expect(taskCalls(f).at(-1)!.args.reason).toBe("keep --json in the reason");
  const trailing = await f.run(["backlog", "plan", "7", "3", '{"priority":1}', "a", "reason", "--json"]);
  expect(taskCalls(f).at(-1)!.args.reason).toBe("a reason"); expect(trailing.stdout).toBe(JSON.stringify(card) + "\n");
  const before = taskCalls(f).length;
  f.serve(JSON.stringify({ ...task, state: "cancelled", cancelled: { reason: "--json" } }));
  await f.run(["task", "cancel", "7", "--reason", "--json"]);
  const cancels = taskCalls(f).slice(before);
  expect(cancels.map(r => r.op)).toEqual(["hub_task_cancel"]);
  expect(cancels[0]!.args).toMatchObject({ id: 7, reason: "--json" });
});

test("text the hub returns that is not JSON is printed as it came, never as an empty record", async () => {
  const f = fixture(); f.serve("task 7 is busy; try again");
  const result = await f.run(["task", "show", "7"]);
  expect(result.code).toBe(0); expect(result.stdout).toBe("task 7 is busy; try again\n");
});

test("the commands that already answer a sentence are unchanged: escalate, assign, unassign, backlog add|pull|return, release errors", async () => {
  const f = fixture(); f.serve("task #7: proposed, owner jcode");
  for (const argv of [["task", "escalate", "7"], ["task", "assign", "7", "jcode"], ["task", "unassign", "7"], ["backlog", "pull", "7"], ["backlog", "add", "implement", "a", "card"]]) {
    const result = await f.run(argv);
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toBe("task #7: proposed, owner jcode\n");
  }
});
