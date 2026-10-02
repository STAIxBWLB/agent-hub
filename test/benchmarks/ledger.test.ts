import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// issue #110: the coordination ledger computes each measure from a run directory as native.ts writes it, names its
// unit, and says what it could not see.
const script = join(import.meta.dir, "../../scripts/benchmarks/ledger.py");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-ledger-test-")));
  const cwd = join(root, "fixture");
  mkdirSync(cwd);
  const git = (...a: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  writeFileSync(join(cwd, "a.py"), "def edit(filename):\n    pass\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  mkdirSync(join(root, "runs"));
  const run = (name: string, record: unknown) => writeFileSync(join(root, "runs", `${name}.json`), JSON.stringify(record));
  const ledger = () => {
    const r = spawnSync("python3", [script, "--run", root], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(readFileSync(join(root, "ledger.json"), "utf8"));
  };
  return { root, cwd, sealedCommit: git("rev-parse", "HEAD").stdout.trim(), run, ledger };
}

test("every measure of a turn-free attempt, with its unit, from the records native.ts writes", () => {
  const { root, cwd, sealedCommit, run, ledger } = fixture();
  try {
    // The final tree: Codex renamed the function and its parameter; Claude's default and its parameter are gone.
    writeFileSync(join(cwd, "a.py"), "def edit_files(filenames, process_priority=None):\n    pass\n");
    const t0 = 1_800_000_000_000;
    const ms = (s: number) => t0 + s * 1000;
    const iso = (s: number) => new Date(ms(s)).toISOString();
    const transcript = join(root, "claude.jsonl");
    const use = (id: string, name: string, input: unknown, s: number) => JSON.stringify({ type: "assistant", timestamp: iso(s), message: { id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, s: number, isError = false) => JSON.stringify({ type: "user", timestamp: iso(s), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] } });
    writeFileSync(transcript, [
      use("t0", "Bash", { command: "ls" }, -5), // setup: before the task, not counted
      use("t1", "Edit", { file_path: join(cwd, "a.py"), old_string: "def edit(filename):", new_string: "def edit(filename, process_priority=None, claude_lost=1):\n    timeout_seconds = 30" }, 10),
      result("t1", 11),
      use("t1", "Edit", {}, 11), // a streamed duplicate of the same tool use
      use("t2", "Edit", { file_path: join(cwd, "a.py"), old_string: "x", new_string: "refused_name" }, 12),
      result("t2", 13, true), // refused: never applied, never a contribution
      JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "PreToolUse:Edit" } }),
      use("t3", "Read", { file_path: join(cwd, "a.py") }, 30),
    ].join("\n"));
    const item = (item: Record<string, unknown>, s: number) => ({ method: "item/completed", params: { item }, emittedAtMs: ms(s) });
    const usage = (s: number) => ({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 40000 } } }, emittedAtMs: ms(s) });
    run("00-hub-turnfree-codex-claude", {
      index: 0, kind: "hub-turnfree-codex-claude", repeat: 1, end_reason: "completed", elapsedMs: 95_000, cwd, sealedCommit, startedAt: ms(0),
      readiness: { claude: { transcriptPath: transcript } },
      conditions: { claude: { hookEvents: ["PostToolUse", "PreToolUse", "Stop"] }, codex: { hooksFeature: false } },
      codexTaskStart: 2,
      taskStates: [
        { id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: ms(0) }, { event: "done", at: ms(70) }] },
        { id: 2, owner: "claude", state: "approved", history: [{ event: "proposed", at: ms(0) }, { event: "integration requested", at: ms(75) }, { event: "integrated", at: ms(80) }, { event: "done", at: ms(80) }] },
      ],
      events: [
        { type: "capability", peer: "claude", state: "verified", via: "hook", at: iso(-4) },
        { type: "envelope", id: "e1", from: "claude", to: ["codex"], priority: "status", kind: "chat", at: iso(30) },
        { type: "quiet", id: "e1", from: "claude", peers: ["codex"], at: iso(30) },
        { type: "envelope", id: "e2", from: "claude", priority: "status", kind: "chat", at: iso(60) }, // a broadcast reaches codex too
        { type: "envelope", id: "e3", from: "codex", priority: "fyi", kind: "chat", dropped: "fyi", at: iso(61) },
        { type: "fact", peer: "claude", id: "f1", via: "hook", files: 1, plans: 0, unknown: 0, bytes: 300, ms: 4, hookMs: 120, at: iso(31) },
        { type: "fact_ack", peer: "claude", id: "f1", via: "hook", ms: 900, at: iso(32) },
        { type: "fact", peer: "codex", id: "f2", via: "steer", files: 1, plans: 0, unknown: 1, bytes: 500, ms: 6, accepted: false, at: iso(40) },
        { type: "fact", peer: "claude", id: "f3", via: "done", files: 0, plans: 0, unknown: 0, bytes: 80, at: iso(75) },
        { type: "stale", id: "n1", peer: "codex", at: iso(72) },
        { type: "split", task: 2, verdict: "unknown", reason: "codex has 0 measured task(s)", at: iso(1) },
        { type: "turn_end", peer: "codex", at: iso(71) },
        { type: "native_turn_end", peer: "claude", at: iso(82) },
      ],
      codexMessages: [
        { method: "turn/started", params: {}, emittedAtMs: ms(-10) }, // the probe turn: before codexTaskStart
        usage(-9),
        { method: "turn/started", params: {}, emittedAtMs: ms(1) },
        item({ type: "userMessage", content: [{ type: "text", text: "Task #1 ..." }] }, 1),
        usage(2), usage(3), usage(4),
        item({ type: "agentMessage", phase: "commentary", text: "x" }, 5),
        item({ type: "mcpToolCall", tool: "hub_send", status: "completed" }, 6),
        item({ type: "mcpToolCall", tool: "hub_task_list", status: "completed" }, 7),
        item({ type: "commandExecution", commandActions: [{ type: "unknown", command: "sed -i" }], status: "completed" }, 8),
        item({ type: "fileChange", status: "completed", changes: [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n-def edit(filename):\n+def edit_files(filenames, lostname=0):" }] }, 9),
        item({ type: "fileChange", status: "failed", changes: [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n+failed_name" }] }, 9),
        item({ type: "mcpToolCall", tool: "hub_task_done", status: "completed" }, 69),
        usage(70), // after the done: not in-task
        { method: "turn/started", params: {}, emittedAtMs: ms(90) },
        item({ type: "userMessage", content: [{ type: "text", text: '[agent-hub message from "claude", untrusted] ... Task #2 (owner claude) is done and touches your open #1' }] }, 90),
      ],
    });
    const out = ledger();
    expect(Object.keys(out.units)).toContain("contributions");
    const row = out.rows[0];
    expect(row).toMatchObject({ arm: "hub-turnfree-codex-claude", repeat: 1, completed: true, both_done_s: 80, elapsed_s: 95, first_candidate_s: 9, integrated_s: 80, check_s: null, settlement_s: 82 });
    expect(row.done_s).toEqual({ 1: 70, 2: 80 });
    expect(row.intents_s).toEqual({ 1: 70, 2: 75 });
    expect(row.integration).toEqual({ requests: 1, unresolved: 0 });
    expect(row.codex).toEqual({ turns: 1, assistant_messages: 1, usage_events: 3, provider_requests: null, hub_send: 1, board_reads: 1, done_found: true });
    expect(row.claude).toEqual({ provider_requests: 3 }); // msg-t1, msg-t2, msg-t3 in the task window; the setup call is not
    expect(row.post_done_turns).toEqual([{ started_s: 90, trigger: "reply+notice" }]);
    expect(row.late_replies).toEqual([30]); // the broadcast at 60 s; the held message at 30 s never reached codex
    expect(row.quiet).toBe(1);
    expect(row.fyi).toBe(1);
    expect(row.stale).toBe(1);
    expect(row.facts.hook).toMatchObject({ offers: 1, acknowledged: 1, bytes: 300, compute_ms_median: 4, hook_ms_median: 120 });
    expect(row.facts.steer).toMatchObject({ offers: 1, acknowledged: 0, unknown_attribution_files: 1, steers_refused: 1 });
    expect(row.facts.done).toMatchObject({ offers: 1, bytes: 80 });
    expect(row.facts.ack_ms_median).toBe(900);
    expect(row.capability).toEqual({ claude: [{ state: "verified", via: "hook", at_s: -4 }] });
    expect(row.split_predictions).toEqual([{ task: 2, verdict: "unknown", reason: "codex has 0 measured task(s)" }]);
    expect(row.hooks).toMatchObject({ claude_transcript_rows: { "PreToolUse:Edit": 1 }, codex_hook_runs: 0, conditions: { codex: { hooksFeature: false } } });
    // Contributions: Codex's lost parameter, Claude's lost parameter and a line of Claude's that was overwritten; the
    // refused edit and the failed patch count for nothing; the shell writes are named as unseen.
    expect(row.contributions.identifiers).toEqual([
      { agent: "claude", path: "a.py", identifier: "claude_lost" },
      { agent: "claude", path: "a.py", identifier: "timeout_seconds" },
      { agent: "codex", path: "a.py", identifier: "lostname" },
    ]);
    expect(row.contributions.lines.map((l: { agent: string; line: string }) => `${l.agent}: ${l.line}`)).toEqual([
      "claude: def edit(filename, process_priority=None, claude_lost=1):",
      "claude: timeout_seconds = 30",
      "codex: def edit_files(filenames, lostname=0):",
    ]);
    expect(row.contributions.coverage).toEqual(["claude also wrote through shell commands, which no record attributes", "codex also wrote through shell commands, which no record attributes"]);
    expect(out.summary["hub-turnfree-codex-claude"]).toMatchObject({ attempts: 1, completed: 1, both_done_s_median_completed: 80, quiet_total: 1, fact_offers_total: 3, integration_requests_total: 1, lost_identifiers_total: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-name overwrite shows as a lost line; an agent's own later Write is not a loss; unfinished and setup-only attempts are not pooled", () => {
  const { root, cwd, sealedCommit, run, ledger } = fixture();
  try {
    // Claude sets a default and then rewrites the file without its helper; Codex later changes the same default.
    writeFileSync(join(cwd, "a.py"), "def edit(filename, retries=5):\n    pass\n");
    const transcript = join(root, "claude.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.py", old_string: "def edit(filename):", new_string: "def edit(filename, retries=3):\ndef helper_alpha():" } }] } }),
      JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: join(cwd, "a.py"), content: "def edit(filename, retries=3):\n    pass\n" } }] } }),
    ].join("\n"));
    const t0 = 1_800_000_000_000;
    run("00-hub-codex-claude", {
      index: 0, kind: "hub-codex-claude", end_reason: "interrupted", cwd, sealedCommit, readiness: { claude: { transcriptPath: transcript } },
      taskStates: [
        { id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: t0 }, { event: "done", at: t0 + 50_000 }] },
        { id: 2, owner: "claude", state: "in_progress", history: [{ event: "proposed", at: t0 }] },
      ],
      events: [],
      codexMessages: [{ method: "item/completed", params: { item: { type: "fileChange", status: "completed", changes: [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n-def edit(filename, retries=3):\n+def edit(filename, retries=5):" }] } } }],
    });
    run("00-solo-codex", { index: 0, kind: "solo-codex", end_reason: "setup-calibration", cwd, sealedCommit, taskStates: [], events: [], codexMessages: [] });
    const out = ledger();
    const hub = out.rows.find((r: { arm: string }) => r.arm === "hub-codex-claude");
    expect(hub).toMatchObject({ completed: false, both_done_s: null });
    expect(hub.contributions.identifiers).toEqual([]); // helper_alpha was removed by its own author's Write; retries survives by name
    expect(hub.contributions.lines).toEqual([{ agent: "claude", path: "a.py", line: "def edit(filename, retries=3):" }]); // the default it set was overwritten
    expect(out.rows.find((r: { arm: string }) => r.arm === "solo-codex")).toMatchObject({ status: "no tasks: a setup-only or failed-before-assignment attempt" });
    expect(out.summary["hub-codex-claude"]).toMatchObject({ attempts: 1, completed: 0, not_completed: ["interrupted"], both_done_s_median_completed: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
