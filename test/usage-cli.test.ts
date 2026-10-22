import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { summarizeByTask } from "../src/hub/report.ts";
import { readEvents } from "../src/hub/events.ts";

// #683 U2 acceptance through the real CLI: `ahub usage --by task` and `ahub report --by task` run as processes against one real daemon and one events.jsonl.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const ev = (s: number, e: Record<string, unknown>) => JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 9, 9, 0, 0, s)).toISOString(), ...e }) + "\n";

async function rig() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-usage-cli-")), stateDir = join(cwd, ".agenthub", "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  writeFileSync(join(stateDir, "events.jsonl"), [
    ev(0, { type: "task", id: 1, state: "in_progress", class: "implement", event: "accepted", by: "codex", owner: "codex", reviewer: "claude", pii: false }),
    ev(1, { type: "task", id: 2, state: "in_progress", class: "implement", event: "accepted", by: "local", owner: "local", reviewer: "claude", pii: true }),
    ev(2, { type: "tokens", peer: "codex", n: 1050, task: 1, attribution: "delivery" }),
    ev(3, { type: "usage", peer: "codex", source: "codex_appserver", id: "c1", inputTokens: 1000, cacheReadTokens: 700, outputTokens: 50, totalTokens: 1050, task: 1, attribution: "delivery" }),
    ev(4, { type: "tokens", peer: "claude", n: 300, task: 1, attribution: "delivery" }),
    ev(5, { type: "tokens", peer: "local", n: 42, task: 2, attribution: "delivery", pii: true }),
    ev(6, { type: "usage", peer: "local", source: "omniroute", id: "l1", inputTokens: 40, outputTokens: 2, totalTokens: 42, task: 2, attribution: "delivery", pii: true }),
    ev(7, { type: "tokens", peer: "jcode", n: 77, attribution: "unattributed" }),
    ev(8, { type: "budget_pause", peer: "claude", reason: "5h window at 95% (status line)", window: "5h", resetsAt: 1_900_000_000_000, by: "hub" }),
  ].join(""));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_CHANNEL"]) delete env[key];
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  return { cwd, stateDir, run };
}

test("`ahub usage --by task --json` reproduces the per-task tokens of `ahub report --by task --json`, run as processes against one hub (#683 U2 acceptance)", async () => {
  const { run, stateDir } = await rig();
  const usage = await run("usage", "--by", "task", "--json"), report = await run("report", "--by", "task", "--json");
  expect(usage.code, usage.stderr).toBe(0); expect(report.code, report.stderr).toBe(0);
  const u = JSON.parse(usage.stdout), r = JSON.parse(report.stdout);
  const reportTokens = (id: string) => Object.values<any>(r.tasks[id].peers).reduce((a: number, p: any) => a + (p.tokens ?? 0), 0);
  expect(u.rows.find((x: any) => x.key === "1").counted).toEqual({ value: reportTokens("1"), source: "count" });
  expect(reportTokens("1")).toBe(1350);                                                        // codex 1050 + claude 300, as the report counts them
  expect(u.rows.find((x: any) => x.key === "1").total).toEqual({ value: 1050, source: "native" });
  expect(u.unattributed.counted.value).toBe(r.unattributed.tokens);
  // and the library report on the same file agrees with the process output
  expect(summarizeByTask(readEvents(join(stateDir, "events.jsonl"))).tasks["1"]!.peers.codex!.tokens).toBe(1050);
});

test("the text output names a source on every known number, prints unknown instead of 0, and shows a private task as [pii] (#683 U2)", async () => {
  const { run } = await rig();
  const text = (await run("usage", "--by", "peer", "--color=never")).stdout;
  expect(text).toContain("1050 (native)");
  expect(text).toContain("77 (hub count)");
  expect(text).toMatch(/jcode\s+unknown/);                                                     // jcode reported no counters
  expect(text).toContain("WITHOUT CACHE"); expect(text).toContain("CACHE READ");
  expect(text).toContain("unknown is never zero");
  const tasks = (await run("usage", "--by", "task", "--color=never")).stdout;
  expect(tasks).toContain("#2 [pii]");
  expect(tasks).toContain("unattributed");
  expect(`${text}${tasks}`).not.toContain("PRIVATE");
});

test("usage limits and usage total print the history and the lifetime numbers, and both have --json (#683 U2)", async () => {
  const { run } = await rig();
  const limits = await run("usage", "limits", "--color=never");
  expect(limits.code, limits.stderr).toBe(0);
  expect(limits.stdout).toContain("pause ended, end unknown: claude 5h");                                   // the hub holds no record of it: not open forever
  expect(limits.stdout).toMatch(/pause\s+claude\s+5h/);
  expect(JSON.parse((await run("usage", "limits", "--peer", "claude", "--json")).stdout).limits.history).toHaveLength(1);
  const total = await run("usage", "total", "--color=never");
  expect(total.code, total.stderr).toBe(0);
  expect(total.stdout).toContain("ALL PEERS"); expect(total.stdout).toContain("lifetime development tokens since 2026-10-09");
  expect(JSON.parse((await run("usage", "total", "--json")).stdout).overall.tokens.source).toBe("count");
  const cut = await run("usage", "limits", "--limit", "1", "--json"); expect(cut.code, cut.stderr).toBe(0);
  expect(JSON.parse(cut.stdout).limits).toMatchObject({ total: 1, shown: 1, truncated: false, limit: 1 });
  for (const bad of ["0", "x", "99999", "1.5"]) expect((await run("usage", "limits", "--limit", bad)).code).not.toBe(0);
});

test("a wrong argument is refused with a usage line, not a stack trace, and nothing is asked of the hub (#683 U2)", async () => {
  const { run } = await rig();
  for (const bad of [["usage", "--by", "nonsense"], ["usage", "bogus"], ["usage", "--since"], ["usage", "limits", "--by", "task"], ["usage", "total", "--since", "7d"]]) {
    const r = await run(...bad);
    expect(r.code, bad.join(" ")).not.toBe(0);
    expect(r.stderr, bad.join(" ")).not.toContain("    at ");
    expect(r.stderr.length, bad.join(" ")).toBeGreaterThan(0);
  }
});

test("from an agent shell the planner gets the numbers and every other agent gets the hub's refusal and exit 1 (#683 U2)", async () => {
  const { run, cwd, stateDir } = await rig();
  const asAgent = async (peer: string) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), "usage", "--json"], { cwd, env: { ...process.env, AGENTHUB_PEER_ID: peer, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_PROJECT_DIR: cwd, AGENTHUB_MODE: "tools" } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const planner = await asAgent("claude");                                                     // claude is the default planner
  expect(planner.code, planner.stderr).toBe(0);
  expect(JSON.parse(planner.stdout).rows.find((x: any) => x.key === "codex").total).toEqual({ value: 1050, source: "native" });
  const other = await asAgent("codex");
  expect(other.code).toBe(1);
  expect(other.stderr).toContain("usage is read by the person and a configured planner");
  expect(other.stdout).toBe("");                                                                // no number leaks to the refused agent
  expect((await run("usage", "--json")).code).toBe(0);                                         // the person still can
});
