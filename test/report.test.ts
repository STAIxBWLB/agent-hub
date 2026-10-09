import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubEvent, StampedEvent } from "../src/hub/events.ts";
import { formatTaskReport, summarizeByTask } from "../src/hub/report.ts";

const ev = (s: number, e: HubEvent): StampedEvent => ({ v: 1, at: new Date(Date.UTC(2026, 9, 9, 0, 0, s)).toISOString(), ...e });
const task = (id: number, state: string, cls = "implement"): HubEvent => ({ type: "task", id, state, class: cls, event: state, by: "codex", owner: "codex", reviewer: "claude", pii: false });

test("task and class reports use latest outcome, first accept/approval, and deduplicated reported counters", () => {
  const events = [ev(0, task(1, "proposed")), ev(1, task(1, "in_progress")), ev(2, task(1, "in_progress")),
    ev(3, { type: "tokens", peer: "codex", n: 100, task: 1, attribution: "single_open" }),
    ev(4, { type: "usage", peer: "local", source: "omniroute", id: "a", inputTokens: 10, outputTokens: 0, task: 1, attribution: "delivery" }),
    ev(5, { type: "usage", peer: "local", source: "omniroute", id: "a", inputTokens: 10, outputTokens: 0, task: 1, attribution: "delivery" }),
    ev(6, { type: "usage", peer: "local", source: "omniroute", id: "b", task: 1, attribution: "delivery" }),
    ev(7, { type: "turn_end", peer: "codex", turn: "t", ms: 3000, task: 1, attribution: "single_open" }),
    ev(8, task(1, "approved")), ev(9, task(1, "approved")), ev(10, task(2, "in_progress", "review")),
    ev(11, { type: "tokens", peer: "claude", n: 20, task: 2, attribution: "delivery" }),
    ev(12, { type: "tokens", peer: "codex", n: 30, task: 3, attribution: "delivery" }),
    ev(12, { type: "turn_end", peer: "pi", turn: "pi#1", ms: 100, task: 3, attribution: "delivery" })];
  const r = summarizeByTask(events);
  expect(r.tasks["1"]).toMatchObject({ class: "implement", outcome: "approved", wallMs: 7000, turns: 1 });
  expect(r.tasks["2"]).toMatchObject({ class: "review", outcome: "in_progress", wallMs: null });
  expect(r.tasks["3"]).toMatchObject({ class: null, outcome: null, wallMs: null });
  expect(r.tasks["1"]!.peers.local).toMatchObject({ tokens: null, usage: { records: 2, inputTokens: 10, inputRecords: 1, outputTokens: 0, outputRecords: 1, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, withoutUsage: 1 } });
  expect(r.classes.implement!.peers.codex!.tokens).toBe(100);
  expect(r.classes.review!.peers.claude!.tokens).toBe(20);
  expect(r.classes.unknown!.peers.codex!.tokens).toBe(30);
  expect(r.tasks["3"]!.peers.pi).toMatchObject({ tokens: null, usage: { totalTokens: null } });
  expect(r.totals).toEqual({ tokens: 150, usageRecords: 2 });
  expect(summarizeByTask([...events, ev(13, task(1, "in_progress"))]).tasks["1"]!.wallMs).toBeNull();
});

test("unattributed share and before attribution remain distinct and visible, even with no records", () => {
  const r = summarizeByTask([
    ev(0, { type: "tokens", peer: "codex", n: 40, task: 1, attribution: "delivery" }),
    ev(1, { type: "tokens", peer: "codex", n: 20, attribution: "unattributed" }),
    ev(2, { type: "tokens", peer: "codex", n: 40, task: 999 }),
    ev(3, { type: "usage", peer: "local", source: "omniroute", id: "a", task: 1, attribution: "delivery" }),
    ev(4, { type: "usage", peer: "local", source: "omniroute", id: "b", attribution: "unattributed" }),
    ev(5, { type: "usage", peer: "local", source: "omniroute", id: "c" }),
    ev(6, { type: "usage", peer: "local", source: "omniroute", id: "b", attribution: "unattributed" }),
  ]);
  expect(r.unattributed).toMatchObject({ tokens: 20, usageRecords: 1, tokenShare: 0.2, usageShare: 1 / 3 });
  expect(r.beforeAttribution).toMatchObject({ tokens: 40, usageRecords: 1 });
  expect(r.tasks["1"]!.peers.codex!.tokens).toBe(40);
  expect(r.tasks["999"]).toBeUndefined();
  expect(formatTaskReport(r).join("\n")).toContain("unattributed: tokens 20/100 (20.0%), usage records 1/3 (33.3%)");
  expect(formatTaskReport(r).join("\n")).toContain("before attribution: tokens 40, usage records 1");
  const empty = summarizeByTask([]);
  expect(empty.unattributed.tokenShare).toBeNull();
  expect(empty.unattributed.usageShare).toBeNull();
  expect(formatTaskReport(empty).join("\n")).toContain("unattributed: tokens 0/0 (unknown), usage records 0/0 (unknown)");
});

test("PII CLI report and export expose task ids and counters without reading board text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agenthub-task-report-"));
  const state = join(cwd, ".agenthub/state");
  mkdirSync(state, { recursive: true });
  const events = [ev(0, { ...task(9, "in_progress"), pii: true }),
    ev(1, { type: "tokens", peer: "local", n: 42, task: 9, attribution: "delivery", pii: true }),
    ev(2, { type: "usage", peer: "local", source: "omniroute", id: "opaque", inputTokens: 40, outputTokens: 2, task: 9, attribution: "delivery", pii: true }),
    ev(3, { type: "turn_end", peer: "local", turn: "local#1", ms: 500, task: 9, attribution: "delivery", pii: true })];
  writeFileSync(join(state, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(state, "hub.db"), "PRIVATE TASK TITLE SHOULD NEVER BE READ");
  const env = { ...process.env };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR"]) delete env[key];
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    expect(out).not.toContain("PRIVATE TASK TITLE");
    return out;
  };
  try {
    const text = await run("report", "--by", "task");
    expect(text).toContain("task #9 [pii]");
    expect(text).toContain("tokens 42");
    const json = JSON.parse(await run("report", "--by", "task", "--json"));
    expect(json.tasks["9"]).toMatchObject({ pii: true, peers: { local: { tokens: 42, usage: { inputTokens: 40, outputTokens: 2, totalTokens: null } } } });
    const exported = (await run("export")).trim().split("\n").map(line => JSON.parse(line));
    expect(exported).toEqual(events);
    expect(exported.filter(e => e.type === "usage" || e.type === "tokens").every(e => e.task === 9 && e.pii === true && e.title === undefined && e.detail === undefined && e.body === undefined)).toBe(true);
    const plain = JSON.parse(await run("report", "--json"));
    expect(plain.peers.local.tokens).toBe(42);
    expect(plain.unattributed).toBeUndefined();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 10_000);
