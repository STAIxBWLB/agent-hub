import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readEvents, type StampedEvent } from "../src/hub/events.ts";
import { appendRecords, CSV_COLUMNS, projectKey, readStore, readStores, RESEARCH_SCHEMA, researchFile, researchReport, taskRecords, toCsv, type TaskRecord } from "../src/hub/research.ts";
import { classifyPeerCommand as cliClass } from "../src/cli/identity.ts";

// #247: opt-in research records of each approved task, built only from events.jsonl.

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-research-${name}-`))); dirs.push(d); return d; };
let clock = Date.parse("2026-10-10T00:00:00Z");
const at = () => new Date(clock += 60_000).toISOString();
const task = (id: number, event: string, state: string, extra: Partial<{ owner: string; reviewer: string; class: string; pii: boolean; by: string }> = {}): StampedEvent =>
  ({ v: 1, at: at(), type: "task", id, event, by: extra.by ?? "hub", state, owner: extra.owner ?? null, reviewer: extra.reviewer ?? null, class: extra.class ?? "implement", pii: extra.pii ?? false });
const writer = { version: "test", source: "backfill" as const };

test("one record per approval with review rounds, rework, checks, tokens and turns; a reopened task gets a newer revision", () => {
  const events: StampedEvent[] = [
    task(1, "proposed", "proposed", { reviewer: "claude" }),
    task(1, "assigned", "in_progress", { owner: "codex", reviewer: "claude" }),
    { v: 1, at: at(), type: "tokens", peer: "codex", n: 700, task: 1, attribution: "delivery" },
    { v: 1, at: at(), type: "turn_end", peer: "codex", turn: "codex#1.1", ms: 4000, files: 3, task: 1, attribution: "delivery" },
    { v: 1, at: at(), type: "usage", peer: "codex", source: "omniroute", id: "u1", servedModel: "gpt-x", inputTokens: 500, outputTokens: 200, totalTokens: 700, task: 1, attribution: "delivery" },
    { v: 1, at: at(), type: "usage", peer: "codex", source: "omniroute", id: "u1", servedModel: "gpt-x", inputTokens: 500, outputTokens: 200, totalTokens: 700, task: 1, attribution: "delivery" }, // a repeat
    task(1, "check failed", "in_progress", { owner: "codex", reviewer: "claude" }),
    task(1, "done", "in_review", { owner: "codex", reviewer: "claude" }),
    task(1, "changes_requested", "changes_requested", { owner: "codex", reviewer: "claude" }),
    { v: 1, at: at(), type: "stuck", peer: "codex", task: 1, category: "repetition", streak: 2, latched: false },
    task(1, "done", "in_review", { owner: "codex", reviewer: "claude" }),
    { v: 1, at: at(), type: "tokens", peer: "claude", n: 300, task: 1, attribution: "delivery" },
    task(1, "approved", "approved", { owner: "codex", reviewer: "claude", by: "claude" }),
    task(2, "proposed", "proposed", { class: "plan" }),
    task(2, "accepted", "in_progress", { owner: "claude", class: "plan" }),
    { v: 1, at: at(), type: "tokens", peer: "claude", n: 50, task: 2, attribution: "single_open" },
    task(2, "done", "approved", { owner: "claude", class: "plan" }),
    { v: 1, at: at(), type: "tokens", peer: "codex", n: 999 }, // unattributed: no task gets it
    task(1, "reassigned", "in_progress", { owner: "kimi", reviewer: "claude" }), // reopened
    task(1, "done", "in_review", { owner: "kimi", reviewer: "claude" }),
    task(1, "approved", "approved", { owner: "kimi", reviewer: "claude" }),
  ];
  const [first, second, again] = taskRecords(events, "p-1", writer);
  expect(first).toMatchObject({ schema: RESEARCH_SCHEMA, kind: "task", project: projectKey("p-1"), task: 1, revision: 1, class: "implement", outcome: "approved",
    owners: ["codex"], reviewer: "claude", reviewRounds: 2, changesRequested: 1, checkFailed: 1, dones: 2, reassignments: 0, firstPass: false, stuck: 1,
    tokens: { total: 1000, byPeer: { codex: 700, claude: 300 } }, usage: { codex: { input: 500, output: 200, cacheRead: null, total: 700 } },
    turns: 1, activeMs: 4000, filesChanged: 3, models: ["gpt-x"] });
  expect(first!.wallMs).toBe(Date.parse(first!.approvedAt) - Date.parse(first!.startedAt!));
  expect(second).toMatchObject({ task: 2, revision: 1, class: "plan", reviewRounds: 0, firstPass: true, tokens: { total: 50 } });
  expect(again).toMatchObject({ task: 1, revision: 2, owners: ["codex", "kimi"], reassignments: 1, reviewRounds: 3 });
});

test("measures count each task once at its latest revision, and a person's failure label turns an approval into a failure", () => {
  const home = temp("measures");
  const base = taskRecords([
    task(1, "proposed", "proposed"), task(1, "assigned", "in_progress", { owner: "codex", reviewer: "claude" }),
    { v: 1, at: at(), type: "tokens", peer: "codex", n: 100, task: 1 },
    task(1, "done", "in_review", { owner: "codex", reviewer: "claude" }), task(1, "approved", "approved", { owner: "codex", reviewer: "claude" }),
    task(2, "proposed", "proposed"), task(2, "assigned", "in_progress", { owner: "kimi", reviewer: "claude" }),
    { v: 1, at: at(), type: "tokens", peer: "kimi", n: 300, task: 2 },
    task(2, "done", "in_review", { owner: "kimi", reviewer: "claude" }), task(2, "changes_requested", "changes_requested", { owner: "kimi", reviewer: "claude" }),
    task(2, "done", "in_review", { owner: "kimi", reviewer: "claude" }), task(2, "approved", "approved", { owner: "kimi", reviewer: "claude" }),
  ], "alpha", writer);
  appendRecords("alpha", base, home);
  expect(appendRecords("alpha", base, home)).toBe(0); // the same approvals are not written twice
  appendRecords("alpha", [{ schema: RESEARCH_SCHEMA, kind: "label", project: projectKey("alpha"), task: 2, label: "reverted", at: at() }], home);
  const r = researchReport(readStore(researchFile("alpha", home)));
  expect(r.overall).toMatchObject({ tasks: 2, succeeded: 1, failedByLabel: 1, successRate: 0.5, firstPassRate: 0.5, reworkRate: 0.5, checkFailureRate: 0, tokensPerTask: { median: 300, p90: 300 } });
  expect(Object.keys(r.byOwner)).toEqual(["codex", "kimi"]);
  expect(r.byOwner.kimi).toMatchObject({ tasks: 1, successRate: 0 });
  // Another project's store merges with --all.
  appendRecords("beta", taskRecords([task(9, "proposed", "proposed"), task(9, "accepted", "in_progress", { owner: "claude" }), task(9, "done", "approved", { owner: "claude" })], "beta", writer), home);
  const all = researchReport(readStores(undefined, home));
  expect(all.overall.tasks).toBe(3);
  expect(Object.keys(all.byProject).sort()).toEqual([projectKey("alpha"), projectKey("beta")].sort());
  // CSV: a header row in the documented order, one row per task record, its latest label included.
  const csv = toCsv(readStores(undefined, home)).trim().split("\n");
  expect(csv[0]).toBe(CSV_COLUMNS.join(","));
  expect(csv).toHaveLength(4);
  expect(csv.find((line) => line.startsWith(`${projectKey("alpha")},2,`))).toContain(",reverted,");
});

test("labelling a task is a person's; reading the research measures is not", () => {
  expect(cliClass("task", ["label", "3", "reverted"])).toBe("console");
  expect(cliClass("research", ["backfill"])).toBe("console");
  expect(cliClass("research", [])).toBe("allowed");
  expect(cliClass("research", ["export", "--format", "csv"])).toBe("allowed");
});

async function daemonWith(research: boolean, home: string) {
  const root = temp("project");
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home;
  cleanup.push(() => { if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; });
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "p-research", instanceId: "i-research", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, research: { enabled: research } } });
  cleanup.push(() => daemon.stop());
  const as = async (peer: string) => { const c = await ControlClient.connect(stateDir, { role: "tools", peer }); cleanup.push(() => c.close()); return c; };
  // Attached as peers too, so the board can give them tasks; the tools connections act for them.
  for (const peer of ["worker", "claude"]) { const c = await ControlClient.connect(stateDir, { role: "peer", peer }); cleanup.push(() => c.close()); }
  for (let i = 0; i < 100 && !(daemon.bus.peers.get("worker")?.state === "idle" && daemon.bus.peers.get("claude")?.state === "idle"); i++) await Bun.sleep(10);
  const codex = await as("worker"), claude = await as("claude");
  const op = async (c: ControlClient, name: string, args: Record<string, unknown>) => {
    const reply = await c.request({ t: "task", op: name, args });
    if (!reply.ok) throw new Error(reply.error);
    return reply.text as string;
  };
  // The reviewer the hub named in the done reply ("..., reviewer <peer>"): connect as that peer to give the verdict.
  const reviewers = new Map<string, ControlClient>([["worker", codex], ["claude", claude]]);
  const daemonReviewer = (reply: string) => reviewers.get(/reviewer (\w+)/.exec(reply)?.[1] ?? "claude") ?? claude;
  return { stateDir, daemon, codex, claude, op, daemonReviewer };
}
const MARKERS = ["SECRET-TITLE", "SECRET-DETAIL", "SECRET-PLAN", "SECRET-SUMMARY", "SECRET-NOTE", "src/secret-path.ts", "900101-1234567"];
async function approveTwo(f: Awaited<ReturnType<typeof daemonWith>>) {
  // Codex claims its own task (it starts in progress), reports it done, and whoever reviews it approves it.
  await f.op(f.codex, "hub_task_propose", { title: "SECRET-TITLE ordinary", detail: "SECRET-DETAIL", class: "implement", owner: "worker",
    refs: { paths: ["src/secret-path.ts"] }, plan: { paths: ["src/secret-path.ts"], symbols: ["SECRET-PLAN"] } });
  const done = await f.op(f.codex, "hub_task_done", { id: 1, summary: "SECRET-SUMMARY done" });
  if (done.includes("in_review")) await f.op(f.daemonReviewer(done), "hub_review", { id: 1, verdict: "approved", note: "SECRET-NOTE fine" });
  await f.op(f.claude, "hub_task_propose", { title: "call 900101-1234567 back SECRET-TITLE", class: "implement" }); // a PII task, never approved
}

test("the live writer records each approved task, holds no text, and backfill rebuilds the same records", async () => {
  const home = temp("home");
  const f = await daemonWith(true, home);
  await approveTwo(f);
  const file = researchFile("p-research", home);
  for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(10);
  const stored = readStore(file) as TaskRecord[];
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ task: 1, revision: 1, owners: ["worker"], firstPass: true, dones: 1, writer: { source: "live" } });
  const raw = readFileSync(file, "utf8");
  for (const marker of MARKERS) expect(raw).not.toContain(marker);
  expect(raw).not.toContain(f.stateDir); // no path
  expect((readFileSync(file).length > 0) && (Bun.file(file).size > 0)).toBe(true);
  // Backfill from the same events: the same records, only the writer differs.
  const rebuilt = taskRecords(readEvents(join(f.stateDir, "events.jsonl")), "p-research", { version: "x", source: "backfill" });
  const strip = (r: TaskRecord) => ({ ...r, writer: undefined });
  expect(rebuilt.map(strip)).toEqual(stored.map(strip));
  expect(appendRecords("p-research", rebuilt, home)).toBe(0);
});

test("with research off nothing is written, and a store that cannot be written logs once and changes no outcome", async () => {
  const off = temp("home-off");
  const f = await daemonWith(false, off);
  await approveTwo(f);
  await Bun.sleep(50);
  expect(existsSync(join(off, "research"))).toBe(false);

  const blocked = temp("home-blocked");
  writeFileSync(join(blocked, "research"), "a file where the store directory would go");
  const g = await daemonWith(true, blocked);
  await approveTwo(g);
  await g.op(g.codex, "hub_task_accept", { id: 2 }).catch(() => undefined);
  await Bun.sleep(100);
  const log = readFileSync(join(g.stateDir, "hub.log"), "utf8");
  expect(log.match(/research record not written/g)?.length).toBe(1);
  expect(await g.op(g.claude, "hub_task_list", {})).toContain("approved");
});
