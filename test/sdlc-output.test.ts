import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { Registry } from "../src/hub/registry.ts";
import { renderAuthorization, renderSdlcCosts, renderSdlcExplain, renderSdlcMetrics, renderSdlcQueue, renderSdlcRelease, renderSdlcStatus, moment } from "../src/cli/sdlc-output.ts";
import { paint } from "../src/cli/console-state.ts";

// #814 T1: the sdlc read commands print for a person by default and print exactly today's JSON with --json.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const NOW = Date.parse("2026-10-25T16:00:00Z");
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const LONG = "a deliberately long blocker sentence that has to wrap beside its bullet at eighty columns without splitting a word or losing any of its text";
const statusReply = { ok: true, mode: "advise", truncated: false, rows: [
  { id: 7, title: "Implement the human output for every sdlc read command with a very long title that must wrap under its number", stage: "review", mode: "advise", ready: false, actor: "reviewer", next: "ask codex-review to approve the head", blockers: ["current PR evidence unknown", LONG],
    receipt: { repo: "owner/repo", issue: 814, pr: 830, head: A, stage: "review" }, spec: { issue: 814, state: "accepted" }, playbook: "Build",
    findings: { important: 1, nit: 2, openImportant: 1, openNit: 0, fixed: 1, falsePositive: 0, accepted: 0 },
    planConformance: { state: "departure", outside: ["docs/extra.md"], untouched: ["src/never-touched.ts"], accepted: false },
    testIntegrity: { applicability: "bug", redFirst: "verified", fileState: "complete", modifiedTests: ["test/a.test.ts"], blockers: [] },
    criteria: { ready: false, blockers: ["AC2 unmet"], id: "ck1", note: "checked" } },
  { id: 8, title: "Second task", stage: "implement", mode: "advise", ready: true, actor: "owner", next: "open a PR", blockers: [], receipt: { stage: "implement" } },
] };
const queueReply = { ok: true, report: { repo: "owner/repo", complete: true, truncated: false, order: [830, 831], unordered: [],
  rows: [{ pr: 830, tasks: [7], head: A, ready: true, blockers: [], after: [] }, { pr: 831, tasks: [8, 9], head: B, ready: false, blockers: ["required check gate is failing", LONG], after: [830] }, { pr: 832, tasks: [10], private: true, ready: false, blockers: [], after: [] }],
  conflicts: [{ left: 830, right: 831, files: 2, order: "person_required" }] } };
const releaseReply = { ok: true, report: { repo: "owner/repo", head: A, version: "0.18.0", tag: "v0.17.0", tagCommit: B, commits: [A, B, C], mergedPrs: [{ pr: 828, commit: A }], native: "unverified", ready: false, sourceReady: true,
  documents: { schemaVersion: 1, fresh: false, errors: 1, documents: [{ path: "docs/operations.md", state: "stale" }, { path: "README.md", state: "fresh" }] },
  liveIssues: [{ id: 814, state: "open" }, { id: 820, state: "closed" }], blockers: ["native acceptance unverified", LONG],
  authorization: { state: "matched", receipt: { schemaVersion: 1, id: "11111111-2222-3333-4444-555555555555", by: "user", commit: A, version: "0.18.0", at: NOW - 3 * 3_600_000, docs: { fresh: true, errors: 0, documents: 12, digest: C } } },
  trains: [{ release: { id: 3 }, readiness: { trigger: "waiting", tasks: [], blockers: ["release scope unavailable"] } }] } };
const summary = (n: number, mean: number | null) => ({ n, unknown: 1, mean, median: mean, p90: mean, max: mean });
const metricsReply = { since: NOW - 7 * 86_400_000, tasks: 12, withheldPrivate: 2, stalls: { open: 1, byKind: { "no-writes": 1 }, doneWithoutWrites: 0 },
  metrics: { acceptance_to_plan_ms: summary(9, 5_400_000), acceptance_to_first_review_ms: summary(9, 7_200_000), acceptance_to_merge_ms: summary(8, 93_600_000), rework_rounds: summary(10, 1.5), same_head_ci_reruns: summary(5, 0), stale_head_re_reviews: summary(6, 0.4),
    first_pass_approval: { n: 10, unknown: 0, rate: 0.6 }, first_pass_check: { n: 5, unknown: 5, rate: null } },
  bands: [{ metric: "rework_rounds", tier: "diagnose", reason: LONG, baseline: 1, mean: 1.5, sd: 0.5, last: 3, z: 3, lastTask: 7, episode: 7 }, { metric: "first_pass_approval", tier: "ok", reason: "within band", baseline: 0.6, mean: 0.6, sd: 0.1, last: 0.6, z: 0, lastTask: 8, episode: null }] };
const costsReply = { rows: [{ repo: "owner/repo", pr: 830, reviewRounds: 2, ciRuns: 4, ciReruns: null, fullReReviews: 1, deltaReviews: 1, reviewMs: 5_400_000, unknownReviewScopes: 1, githubReviews: 2, complete: false }, { repo: "owner/repo", pr: 828, reviewRounds: 1, ciRuns: 2, ciReruns: 0, fullReReviews: 1, deltaReviews: 0, reviewMs: 600_000, unknownReviewScopes: 0, githubReviews: 1, complete: true }], truncated: true, privateTasks: "withheld", bands: "see ahub sdlc metrics" };
const authorization = { schemaVersion: 1, id: "11111111-2222-3333-4444-555555555555", by: "user", commit: A, version: "0.18.0", at: NOW - 60_000, docs: { fresh: true, errors: 0, documents: 12, digest: C } };

/** Each command: its argv, what the fake hub answers, and the exact text `--json` printed before this change. */
const commands = [
  { name: "status", argv: ["sdlc", "status"], reply: statusReply, json: JSON.stringify(statusReply, null, 2) + "\n", must: ["SDLC lifecycle", "#7", "ready", "ask codex-review to approve the head"] },
  { name: "status <task>", argv: ["sdlc", "status", "7"], reply: statusReply, json: JSON.stringify(statusReply, null, 2) + "\n", must: ["current PR evidence unknown", "owner/repo#814"] },
  { name: "explain", argv: ["sdlc", "explain", "7"], reply: statusReply, json: JSON.stringify(statusReply, null, 2) + "\n", must: ["plan files", "docs/extra.md", "red-first verified", "AC2 unmet"] },
  { name: "queue", argv: ["sdlc", "queue", "owner/repo"], reply: queueReply, json: JSON.stringify(queueReply, null, 2) + "\n", must: ["Merge queue owner/repo", "#830, #831", "the person orders them", "private"] },
  { name: "release", argv: ["sdlc", "release", "owner/repo", "814"], reply: releaseReply, json: JSON.stringify(releaseReply, null, 2) + "\n", must: ["Release readiness owner/repo", "0.18.0", "matched", "docs/operations.md", "native acceptance unverified"] },
  { name: "metrics", argv: ["sdlc", "metrics"], reply: undefined, tool: { op: "hub_sdlc_metrics", text: JSON.stringify(metricsReply) }, json: JSON.stringify(metricsReply) + "\n", must: ["SDLC metrics", "first-pass approval", "60%", "diagnose", "private withheld"] },
  { name: "costs", argv: ["sdlc", "costs", "owner/repo"], reply: undefined, tool: { op: "hub_sdlc_costs", text: JSON.stringify(costsReply) }, json: JSON.stringify(costsReply) + "\n", must: ["SDLC costs", "#830", "1h30m", "private tasks are withheld"] },
  { name: "authorize-release", argv: ["sdlc", "authorize-release", "0.18.0"], reply: { ok: true, authorization }, json: JSON.stringify(authorization, null, 2) + "\n", must: ["Release authorized", "0.18.0", "a daemon restart revokes", "UTC"] },
] as const;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-sdlc-output-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const registry = new Registry(join(root, "home/registry.db"));
  const project = registry.register(root, stateDir); registry.close();
  const status = { projectId: project.id, pid: process.pid, cwd: root, controlPort: 12345, instanceId: "sdlc-output-fixture", peers: {}, tasks: {} };
  const requests: any[] = []; let answer: Record<string, unknown> = {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, body) {
      const req = JSON.parse(String(body)); requests.push(req);
      const reply = req.t === "hello" ? { t: "welcome", cwd: root, projectId: project.id, instanceId: status.instanceId } : req.t === "status" ? { status } : answer;
      ws.send(JSON.stringify({ ok: true, ...reply, rid: req.rid }));
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...status, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(root, ".agenthub/config.json"), "{}");
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env: { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  git("init", "-q"); writeFileSync(join(root, "README.md"), "fixture\n"); git("add", "README.md"); git("commit", "-q", "-m", "fixture");
  const bin = join(root, "bin"); mkdirSync(bin);
  for (const name of ["bun", "claude", "codex", "kimi", "dot"]) writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in\n  --version) echo 'fixture 1.0';;\nesac\n`, { mode: 0o755 });
  const wrapper = join(root, "run.ts");
  writeFileSync(wrapper, `Date.now = () => ${NOW}; await import(${JSON.stringify(CLI)});`);
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const childEnv: Record<string, string> = { ...process.env as Record<string, string>, HOME: root, AGENTHUB_HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color", ...env };
    for (const marker of ["AGENTHUB_PEER_ID", "AGENTHUB_CHANNEL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "NO_COLOR", "COLUMNS"]) if (!(marker in env)) delete childEnv[marker];
    const proc = Bun.spawn([process.execPath, wrapper, ...args], { cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  const serve = (command: (typeof commands)[number]) => { answer = "tool" in command ? { text: command.tool.text } : { ...command.reply }; };
  /** The text today's code prints for `--json`: the reply exactly as the hub framed it. */
  const printed = (command: (typeof commands)[number], space?: number) => {
    const sent = requests.findLast(r => r.t === "sdlc" || r.t === "task");
    const frame = { ok: true, ...answer, rid: sent?.rid };
    return "tool" in command ? command.tool.text + "\n" : JSON.stringify(command.argv[1] === "authorize-release" ? (frame as any).authorization : frame, null, space ?? 2) + "\n";
  };
  return { run, requests, serve, printed };
}
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const parses = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };

for (const command of commands) {
  test(`AC1 ${command.name}: the default is for a person, --json is today's output byte for byte`, async () => {
    const f = fixture(); f.serve(command);
    const human = await f.run([...command.argv]);
    expect(human.code, human.stderr).toBe(0);
    expect(parses(human.stdout), "default output must not parse as JSON").toBe(false);
    expect(human.stdout).not.toMatch(/^\s*[{[]/);
    expect(human.stdout).not.toMatch(/"[A-Za-z_]+":/);
    expect(human.stdout).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    for (const needle of command.must) expect(human.stdout.toLowerCase(), needle).toContain(needle.toLowerCase());
    const json = await f.run([...command.argv, "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout).toBe(f.printed(command));
    expect(JSON.parse(json.stdout)).toMatchObject("tool" in command ? JSON.parse(command.tool.text) : command.argv[1] === "authorize-release" ? authorization : command.reply);
    // presentation flags never reach the hub: the request is the same with and without them
    const before = f.requests.length;
    await f.run([...command.argv, "--json", "--color=always"]);
    expect(f.requests.slice(before).filter(r => r.t === "sdlc" || r.t === "task").map(r => JSON.stringify({ ...r, rid: 0 })))
      .toEqual(f.requests.filter(r => r.t === "sdlc" || r.t === "task").slice(0, 1).map(r => JSON.stringify({ ...r, rid: 0 })));
  });

  test(`AC3 ${command.name}: 80 and 200 columns, no line over the width, text intact, --color=never plain`, async () => {
    const f = fixture(); f.serve(command);
    const narrow = await f.run([...command.argv, "--color=never"], { COLUMNS: "80" });
    const wide = await f.run([...command.argv, "--color=never"], { COLUMNS: "200" });
    expect(narrow.code, narrow.stderr).toBe(0); expect(wide.code, wide.stderr).toBe(0);
    for (const line of narrow.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(80);
    for (const line of wide.stdout.split("\n")) expect(Bun.stringWidth(line), line).toBeLessThanOrEqual(200);
    expect(narrow.stdout).not.toContain("\x1b"); expect(wide.stdout).not.toContain("\x1b");
    // wrapping never loses a word: the 80 column text holds every word of the 200 column text
    const words = (text: string) => text.split(/\s+/).filter(Boolean).sort().join(" ");
    expect(words(narrow.stdout.replace(/[-]\s/g, ""))).toBe(words(wide.stdout.replace(/[-]\s/g, "")));
    // explicit color paints, and removing the paint gives the plain text
    const colored = await f.run([...command.argv, "--color=always"], { COLUMNS: "200" });
    expect(colored.stdout).toContain("\x1b[");
    expect(plain(colored.stdout)).toBe(wide.stdout);
    // without a terminal and without COLUMNS the output is not wrapped at all and never painted
    const piped = await f.run([...command.argv]);
    expect(piped.stdout).not.toContain("\x1b");
  });
}

test("unparseable hub tool text is printed as it came, never rendered as an empty report", async () => {
  const f = fixture(); (f as any).serve({ tool: { text: "metrics are unavailable right now" } });
  const result = await f.run(["sdlc", "metrics"]);
  expect(result.code).toBe(0); expect(result.stdout).toBe("metrics are unavailable right now\n");
});

test("sdlc export is a data format: it stays JSON by default and is never rendered", async () => {
  const f = fixture(); f.serve(commands[0]);
  const result = await f.run(["sdlc", "export", "7"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(JSON.stringify({ ...statusReply, rid: f.requests.findLast(r => r.t === "sdlc")!.rid }, null, 2) + "\n");
  expect(parses(result.stdout)).toBe(true);
});

test("the other sdlc subcommands keep their argv: --json is not stripped from them", async () => {
  const f = fixture(); f.serve(commands[0]);
  const refused = await f.run(["sdlc", "record", "7", "{}", "--json"]);
  expect(refused.code).not.toBe(0);
  expect(f.requests.some(r => r.t === "sdlc" && r.op === "record")).toBe(false);
});

// A realistic wide reply for every table: a PR linked to thirty tasks, a long dependency list, many documents, issues and repositories.
const MANY = Array.from({ length: 30 }, (_, i) => i + 1);
const wide = {
  queue: { report: { repo: "owner/a-repository-with-a-long-name", complete: true, truncated: false, order: [830, 831, 832], unordered: [833],
    rows: [{ pr: 830, tasks: MANY, head: A, ready: true, blockers: [], after: [] }, { pr: 831, tasks: [31, 32], head: B, ready: false, blockers: ["x"], after: MANY.map(n => n + 800) }, { pr: 832, tasks: [33], private: true, ready: false, blockers: [], after: [830, 831] }],
    conflicts: [{ left: 830, right: 831, files: 12, order: "dependency" }] } },
  release: { report: { ...releaseReply.report, liveIssues: MANY.map(id => ({ id: 800 + id, state: id % 2 ? "open" : "closed" })), mergedPrs: MANY.map(pr => ({ pr: 700 + pr, commit: A })) } },
  status: { mode: "advise", rows: MANY.map(id => ({ id, title: "task " + id, stage: "implementation-review", mode: "advise", ready: id % 2 === 0, actor: "owner/planner", next: "wait", blockers: [], receipt: { pr: 800 + id } })) },
  costs: { rows: MANY.flatMap(pr => ["owner/first-long-repository-name", "owner/second-long-repository-name"].map(repo => ({ repo, pr: 1000 + pr, reviewRounds: 12, ciRuns: 345, ciReruns: 67, fullReReviews: 8, deltaReviews: 9, reviewMs: 987_654_321, unknownReviewScopes: 3, githubReviews: 4, complete: pr % 2 === 0 }))), truncated: false },
  metrics: metricsReply,
};
test("AC3 a realistic wide reply fits every width, keeps every identifier and never cuts a word", () => {
  const renderers = { queue: renderSdlcQueue, release: renderSdlcRelease, status: renderSdlcStatus, costs: renderSdlcCosts, metrics: renderSdlcMetrics } as const;
  for (const [name, render] of Object.entries(renderers)) {
    const reference = render((wide as any)[name], 400, NOW).map(line => paint(line, false)).join("\n");
    const identifiers: string[] = reference.match(/#\d+/g) ?? [];
    for (const columns of [80, 60, 40, 24]) {
      const lines = render((wide as any)[name], columns, NOW).map(line => paint(line, false));
      for (const line of lines) expect(Bun.stringWidth(line), `${name} at ${columns}: ${line}`).toBeLessThanOrEqual(columns);
      const text = lines.join("\n");
      // every task, PR and issue number survives as a whole token, in the same multiset
      expect([...(text.match(/#\d+/g) ?? [])].sort(), `${name} at ${columns}`).toEqual([...identifiers].sort());
      // no word of the wide rendering is split or dropped, whichever layout the width chose. Two honest exceptions: a column
      // header (the block layout replaces a header row with per-row headings and labels) and a single token wider than the
      // terminal, which can only be broken to fit.
      const words = (value: string) => value.split(/\s+/).filter(word => word && !/^[-]+$/.test(word));
      const headers = new Set(["PR", "TASKS", "READY", "HEAD", "AFTER", "ID", "STAGE", "ACTOR", "ISSUE", "STATE", "ROUNDS", "CI", "RERUNS", "FULL", "DELTA", "REVIEW", "UNK", "OK", "METRIC", "N", "UNKNOWN", "MEAN", "MEDIAN", "P90", "MAX", "RATE", "VALUE", "BAND", "TIER", "BASELINE", "LAST", "Z", "TASK"]);
      const present = new Set(words(text));
      for (const word of new Set(words(reference))) if (!headers.has(word) && word.length <= columns - 2) expect(present.has(word) || present.has(word.toLowerCase()), `${name} at ${columns}: ${word}`).toBe(true);
    }
  }
  // the reviewer's exact case: one PR linked to tasks 1..30 at 80 columns no longer pushes the table to 138
  const queue = renderSdlcQueue(wide.queue, 80, NOW).map(line => paint(line, false));
  expect(Math.max(...queue.map(line => Bun.stringWidth(line)))).toBeLessThanOrEqual(80);
  expect(queue.join("\n")).toContain("#30");
  // a terminal too narrow for any column falls back to one labelled block per row, still whole
  const tiny = renderSdlcQueue(wide.queue, 24, NOW).map(line => paint(line, false)).join("\n");
  expect(tiny).toMatch(/^#830$/m); expect(tiny).toContain("  tasks  #1 #2");
});

test("renderers are pure and tolerate an empty or partial reply", () => {
  for (const render of [renderSdlcStatus, renderSdlcExplain, renderSdlcQueue, renderSdlcRelease, renderSdlcMetrics, renderSdlcCosts, renderAuthorization]) {
    for (const input of [undefined, null, {}, { rows: [] }, { report: {} }]) {
      const lines = render(input as never, 80, NOW);
      expect(lines.length).toBeGreaterThan(0);
      expect(paint(lines.flat().length ? lines[0]! : [], false)).not.toContain("undefined");
      expect(lines.map(line => paint(line, false)).join("\n")).not.toMatch(/undefined|NaN|\[object/);
    }
  }
});

test("a time is an absolute minute and an age, never a raw ISO string; terminal control text in data is neutralised", () => {
  expect(moment(NOW - 3 * 3_600_000, NOW)).toBe("2026-10-25 13:00 UTC (3h00m ago)");
  expect(moment(undefined, NOW)).toBe("unknown");
  const hostile = { rows: [{ id: 1, title: "\x1b[31mred\x1b]0;owned\x07 title", stage: "x", mode: "advise", ready: false, actor: "a", next: "n\x1b[2Jext", blockers: ["b\x1b[1mold"], receipt: {} }], mode: "advise" };
  const text = renderSdlcStatus(hostile, 80, NOW).map(line => paint(line, false)).join("\n");
  expect(text).not.toContain("\x1b"); expect(text).toContain("red");
});
