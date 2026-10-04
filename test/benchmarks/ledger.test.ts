import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const t0 = 1_800_000_000_000;
  const ms = (s: number) => t0 + s * 1000;
  const iso = (s: number) => new Date(ms(s)).toISOString();
  return { root, cwd, sealedCommit: git("rev-parse", "HEAD").stdout.trim(), run, ledger, t0, ms, iso };
}

test("every measure of a turn-free attempt, with its unit, from the records native.ts writes", () => {
  const { root, cwd, sealedCommit, run, ledger, ms, iso } = fixture();
  try {
    // The final tree: Codex renamed the function; Claude's parameter and its timeout line are gone.
    writeFileSync(join(cwd, "a.py"), "def edit_files(filenames, process_priority=None):\n    pass\n");
    const transcript = join(root, "claude.jsonl");
    const use = (id: string, name: string, input: unknown, s: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "assistant", timestamp: iso(s), message: { id: `msg-${id}`, content: [{ type: "tool_use", id, name, input }], ...extra } });
    const result = (id: string, s: number, isError = false) => JSON.stringify({ type: "user", timestamp: iso(s), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] } });
    writeFileSync(transcript, [
      use("t0", "Bash", { command: "ls" }, -5), // setup: before the task
      result("t0", -4),
      use("t1", "Edit", { file_path: join(cwd, "a.py"), old_string: "def edit(filename):", new_string: "def edit(filename, process_priority=None, claude_lost=1):\n    timeout_seconds = 30" }, 10),
      result("t1", 11),
      use("t1", "Edit", {}, 11), // a streamed duplicate of the same tool use
      use("t2", "Edit", { file_path: join(cwd, "a.py"), old_string: "x", new_string: "refused_name" }, 12),
      result("t2", 13, true), // refused: never applied
      use("t4", "Write", { file_path: join(cwd, "a.py"), content: "never_answered = 1\n" }, 14), // no result: never applied
      JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "PreToolUse:Edit", command: "bun facts-hook.ts", durationMs: 36 } }),
      JSON.stringify({ type: "attachment", attachment: { type: "hook_additional_context", hookName: "PreToolUse:Edit", toolUseID: "t1", content: ["x"] } }),
      use("t3", "Read", { file_path: join(cwd, "a.py") }, 30),
      result("t3", 31),
      JSON.stringify({ type: "assistant", timestamp: iso(85), requestId: "req-end", message: { id: "msg-end", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 5 } } }),
      JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "bun facts-hook.ts", durationMs: 30 }], timestamp: iso(85) }),
    ].join("\n"));
    const item = (item: Record<string, unknown>, s: number) => ({ method: "item/completed", params: { item }, emittedAtMs: ms(s) });
    const usage = (s: number, total: number) => ({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { totalTokens: total }, last: { totalTokens: 1 } } }, emittedAtMs: ms(s) });
    run("00-hub-turnfree-codex-claude", {
      index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind: "hub-turnfree-codex-claude", repeat: 1, end_reason: "completed", end_reason_detail: "completed", setupMs: 20_000, elapsedMs: 100_000, stoppedMs: 4000, teardownMs: 9000, cwd, sealedCommit, startedAt: ms(0),
      readiness: { claude: { transcriptPath: transcript } },
      conditions: { claude: { hookEvents: ["PostToolUse", "PreToolUse", "Stop"] }, codex: { hooksFeature: false } },
      codexTaskStart: 2,
      taskStates: [
        { id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: ms(0) }, { event: "done", at: ms(70) }] },
        { id: 2, owner: "claude", state: "approved", history: [{ event: "proposed", at: ms(0) }, { event: "integration requested", at: ms(75) }, { event: "integrated", at: ms(80) }, { event: "done", at: ms(80) }] },
      ],
      events: [
        { type: "capability", peer: "claude", state: "verified", via: "hook", at: iso(-4) },
        { type: "capability", peer: "codex", state: "verified", via: "steer", at: iso(-2) },
        { type: "envelope", id: "e0", from: "codex", priority: "fyi", kind: "chat", dropped: "fyi", at: iso(-1) }, // the setup probe's answer
        { type: "cohort", id: 1, event: "formed", silent: true, tasks: [1, 2], owners: ["claude", "codex"], at: iso(0.5) },
        { type: "progress", peer: "codex", task: 1, severity: 0, spinning: 0, exploring: 1, production: 0, at: iso(10) },
        { type: "progress", peer: "claude", task: 2, severity: 0.7, spinning: 0, exploring: 0, production: 1, at: iso(20) },
        { type: "stuck", peer: "claude", task: 2, category: "repetition", streak: 2, latched: true, at: iso(20) },
        { type: "hook_stats", peer: "claude", n: 4, startupMs: 200, hubMs: 12, maxStartupMs: 80, at: iso(85) },
        { type: "envelope", id: "e1", from: "claude", to: ["codex"], priority: "status", kind: "chat", at: iso(30) },
        { type: "quiet", id: "e1", from: "claude", peers: ["codex"], at: iso(30) },
        { type: "envelope", id: "e2", from: "claude", priority: "status", kind: "chat", at: iso(60) }, // a broadcast reaches codex too
        { type: "envelope", id: "e4", from: "claude", to: ["codex"], priority: "important", kind: "chat", at: iso(95) }, // steered into a running turn
        { type: "envelope", id: "e3", from: "codex", priority: "fyi", kind: "chat", dropped: "fyi", at: iso(61) },
        { type: "fact", peer: "claude", id: "f1", via: "hook", files: 1, plans: 0, unknown: 0, bytes: 300, ms: 4, hookMs: 120, at: iso(31) },
        { type: "fact_ack", peer: "claude", id: "f1", via: "hook", ms: 900, at: iso(32) },
        { type: "fact", peer: "codex", id: "f2", via: "steer", files: 1, plans: 0, unknown: 1, bytes: 500, ms: 6, rttMs: 9000, accepted: false, at: iso(40) }, // refused: not a round trip
        { type: "fact", peer: "codex", id: "f4", via: "steer", files: 1, plans: 0, unknown: 0, bytes: 100, ms: 5, rttMs: 40, accepted: true, at: iso(45) },
        { type: "fact", peer: "claude", id: "f3", via: "done", files: 0, plans: 0, unknown: 0, named: 2, bytes: 80, at: iso(75) }, // names only (#112)
        { type: "stale", id: "n1", peer: "codex", at: iso(72) },
        { type: "split", task: 2, where: "cohort", verdict: "unknown", reason: "codex has 0 measured task(s)", trace: ["unknown: codex has 0 measured task(s)"], at: iso(1) },
        // Teardown, after the active time: Claude's session closes and its path is lost. Not part of the treatment.
        { type: "capability", peer: "claude", state: "lost", at: iso(103) },
        { type: "cohort", id: 1, event: "lifted", silent: false, tasks: [1, 2], at: iso(103) },
      ],
      codexMessages: [
        { method: "turn/started", params: {}, emittedAtMs: ms(-10) }, // the probe turn: before codexTaskStart
        usage(-9, 1000),
        { method: "turn/started", params: {}, emittedAtMs: ms(1) },
        item({ type: "userMessage", content: [{ type: "text", text: "Task #1 ..." }] }, 1),
        usage(2, 2000), usage(3, 3000), usage(3.5, 3000), usage(4, 4000), // one update repeats its total: not a model call
        item({ type: "agentMessage", phase: "commentary", text: "x" }, 5),
        item({ type: "mcpToolCall", tool: "hub_send", status: "completed" }, 6),
        item({ type: "mcpToolCall", tool: "hub_task_list", status: "completed" }, 7),
        item({ type: "commandExecution", commandActions: [{ type: "unknown", command: "sed -i" }], status: "completed" }, 8),
        item({ type: "fileChange", status: "completed", changes: [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n-def edit(filename):\n+def edit_files(filenames, lostname=0):" }] }, 9),
        item({ type: "fileChange", status: "failed", changes: [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n+failed_name" }] }, 9),
        item({ type: "mcpToolCall", tool: "hub_task_done", status: "completed" }, 69),
        { method: "turn/completed", params: {}, emittedAtMs: ms(72) },
        { method: "turn/started", params: {}, emittedAtMs: ms(90) },
        item({ type: "userMessage", content: [{ type: "text", text: "Task #2 (owner claude) is done and touches your open #1" }] }, 90),
        item({ type: "mcpToolCall", tool: "hub_task_done", status: "completed" }, 92), // refused as already approved: still after its done
        usage(93, 5000),
        { method: "turn/completed", params: {}, emittedAtMs: ms(100) },
      ],
    });
    const out = ledger();
    expect(Object.keys(out.units)).toEqual(expect.arrayContaining(["contributions", "validity", "treatment", "settlement", "summary", "hooks", "split_predictions", "codex_attempt", "claude_attempt", "stopped_s"]));
    const row = out.rows[0];
    expect(row).toMatchObject({ arm: "hub-turnfree-codex-claude", repeat: 1, end_reason_detail: "completed", completed: true, both_done_s: 80, setup_s: 20, elapsed_s: 100, first_candidate_s: 9, integrated_s: 80, check_s: null });
    expect(row.done_s).toEqual({ 1: 70, 2: 80 });
    expect(row.intents_s).toEqual({ 1: 70, 2: 75 });
    expect(row.integration).toEqual({ requests: 1, unresolved: [] });
    // Each from its own record, late turns included: Codex's notice turn after the last done ended at 100 s.
    expect(row.settlement).toEqual({ codex: 100, claude: 85 });
    expect(row.settlement_s).toBe(100);
    expect(row).toMatchObject({ stopped_s: 4, teardown_s: 9 });
    // In task: up to its done on the board (70 s); the post-done turn's refused hub_task_done is not in-task. The first
    // in-task model call grows past the setup probe's total (1000), so it counts.
    expect(row.codex).toEqual({ turns: 1, assistant_messages: 1, usage_growth: 3, usage_events: 4, tokens: 3000, provider_requests: null, hub_send: 1, board_reads: 1, window: "to its last done" });
    expect(row.codex_attempt).toEqual({ turns: 2, assistant_messages: 1, usage_growth: 4, usage_events: 5, tokens: 4000, provider_requests: null, hub_send: 1, board_reads: 1, window: "to the end of the record" });
    expect(row.claude).toEqual({ assistant_messages: 4, turns: 0, tokens: null, provider_requests: null }); // t1, t2, t4, t3: no usage recorded
    expect(row.claude_attempt).toEqual({ assistant_messages: 5, turns: 1, tokens: 115, provider_requests: 1 });
    expect(row.post_done_turns).toEqual([{ started_s: 90, trigger: "notice" }]);
    // The broadcast at 60 s reached codex at its next turn (90 s); the steered one at 95 s landed at once, after the done;
    // the held one never reached it.
    expect(row.late_replies).toEqual([30, 0]);
    expect(row.capability).toEqual({ claude: [{ state: "verified", via: "hook", at_s: -4 }, { state: "lost", via: null, at_s: 103 }], codex: [{ state: "verified", via: "steer", at_s: -2 }] });
    expect(row.progress).toEqual({
      series: [
        { peer: "codex", task: 1, severity: 0, spinning: 0, exploring: 1, production: 0, at_s: 10 },
        { peer: "claude", task: 2, severity: 0.7, spinning: 0, exploring: 0, production: 1, at_s: 20 },
      ],
      stuck: [{ peer: "claude", task: 2, category: "repetition", streak: 2, latched: true, at_s: 20 }],
      coverage: {
        observed_peers: ["claude", "codex"], samples_by_peer: { codex: 1, claude: 1 },
        notes: [
          "Codex commandExecution/fileChange, local/Pi tool callbacks, and Claude turn-free hooks have different observation coverage.",
          "Only emitted samples are measured; a missing peer or interval is unknown, not zero progress or no difficulty.",
        ],
      },
    });
    expect(row.validity).toEqual({ valid: true, why: null }); // the teardown's lost path and lift come after the work
    expect(row.treatment).toEqual({ silent_cohort: true });
    expect(row).toMatchObject({ quiet: 1, fyi: 1, stale: 1 }); // the setup probe's [FYI] is not in the task window
    expect(row.facts.hook).toMatchObject({ offers: 1, acknowledged: 1, bytes_offered: 300, bytes_acknowledged: 300, build_ms_median: 4, hook_startup_ms_median: 120 });
    expect(row.facts.steer).toMatchObject({ offers: 2, acknowledged: 0, bytes_offered: 600, bytes_acknowledged: 0, unknown_attribution_files: 1, steers_refused: 1, steers_unanswered: 0, steer_rtt_ms_median: 40 });
    expect(row.facts.done).toMatchObject({ offers: 1, bytes_offered: 80, bytes_acknowledged: 0, directory_files_named: 2 });
    expect(row.facts.hook.directory_files_named).toBeNull(); // an event from before #112 has no count: unknown, not none
    expect([row.facts.hook.probes, row.facts.hook.coverage_notices, row.facts.steer.probes]).toEqual([0, 0, 0]);
    expect(row.facts.ack_ms_median).toBe(900);
    expect(row.split_predictions).toEqual([{ task: 2, where: "cohort", verdict: "unknown", reason: "codex has 0 measured task(s)", trace: ["unknown: codex has 0 measured task(s)"] }]);
    expect(row.hooks).toMatchObject({
      claude_transcript_rows: { "PreToolUse:Edit agent-hub facts hook": 1, "Stop agent-hub facts hook": 1 }, claude_hook_ms: { timed_rows: 2, median: 33, total: 66 }, foreign: [],
      facts_hook_timing: { calls: 4, startup_ms_total: 200, hub_ms_total: 12, startup_ms_max: 80 }, codex_hook_runs: 0, conditions: { codex: { hooksFeature: false } },
    });
    expect(row.contributions.identifiers).toEqual([
      { agent: "claude", path: "a.py", identifier: "claude_lost" },
      { agent: "claude", path: "a.py", identifier: "timeout_seconds" },
      { agent: "codex", path: "a.py", identifier: "lostname" },
    ]);
    expect(row.contributions.fragments.map((f: { agent: string; fragment: string }) => `${f.agent}: ${f.fragment}`)).toEqual([
      "claude: def edit(filename, process_priority=None, claude_lost=1):",
      "claude: timeout_seconds = 30",
      "codex: def edit_files(filenames, lostname=0):",
    ]);
    expect(row.contributions.coverage).toEqual(["codex ran 1 shell command(s) during the task; what they wrote is not attributed"]); // the setup Bash is before the task
    expect(out.summary["hub-turnfree-codex-claude"]).toMatchObject({
      attempts: 1, completed: 1, valid_completed: 1, excluded: [], missing: [], both_done_s_median: 80, both_done_s_median_common: 80, settlement_s_median: 100, quiet_total: 1, quiet_unknown: 0,
      fact_offers_total: 4, fact_bytes_offered_total: 980, fact_bytes_acknowledged_total: 300, integration_requests_total: 1, lost_identifiers_total: 3, lost_identifiers_unknown: 0,
      progress_samples_total: 2, stuck_verdicts_total: 1,
      codex_attempt_tokens_median: 4000, claude_attempt_tokens_median: 115, treatment_received: 1, both_done_s_median_treated: 80,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overwrites and own rewrites, partial-line edits, a Write that carries a peer's names, a moved file, an invalid treatment, unfinished and setup-only attempts", () => {
  const { root, cwd, sealedCommit, run, ledger, t0, iso } = fixture();
  try {
    // Final: Codex changed Claude's default; Claude's helper was removed by Claude's own Write; codex_name was renamed by codex.
    writeFileSync(join(cwd, "a.py"), "def edit(filename, retries=5):\n    x = timeout=10\n    codex_name_v2 = 1\n");
    writeFileSync(join(cwd, "moved.py"), "def moved_helper():\ndef claude_feature_fn():\n    pass\n");
    const transcript = join(root, "claude.jsonl");
    const call = (id: string, input: unknown, name = "Edit") => [
      JSON.stringify({ type: "assistant", timestamp: iso(1), message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } }),
      JSON.stringify({ type: "user", timestamp: iso(2), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }),
    ];
    writeFileSync(transcript, [
      ...call("t1", { file_path: "a.py", old_string: "def edit(filename):", new_string: "def edit(filename, retries=3):\ndef helper_alpha():" }),
      ...call("t2", { file_path: "a.py", old_string: "timeout=5", new_string: "timeout=10" }), // a partial line, still in the final file
      ...call("t3", { file_path: join(cwd, "a.py"), content: "def edit(filename, retries=3):\n    x = timeout=10\n    codex_name = 1\n" }, "Write"),
      ...call("t4", { file_path: "old.py", old_string: "def old_helper():", new_string: "def old_helper():\ndef claude_feature_fn():" }), // then Codex moves the file
    ].join("\n"));
    const codexItem = (s: number, changes: unknown[]) => ({ method: "item/completed", params: { item: { type: "fileChange", status: "completed", changes } }, emittedAtMs: t0 + s * 1000 });
    run("00-hub-turnfree-codex-claude", {
      index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind: "hub-turnfree-codex-claude", repeat: 0, end_reason: "timeout", end_reason_detail: "wall-timeout", cwd, sealedCommit, readiness: { claude: { transcriptPath: transcript } },
      taskStates: [
        { id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: t0 }, { event: "done", at: t0 + 50_000 }] },
        { id: 2, owner: "claude", state: "in_progress", history: [{ event: "proposed", at: t0 }] },
      ],
      events: [{ type: "capability", peer: "claude", state: "verified", via: "hook", at: iso(-3) }], // codex never verified
      codexMessages: [
        codexItem(0.5, [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1 +1,2 @@\n def edit(filename):\n+    codex_name = 1" }]),
        codexItem(3, [{ path: join(cwd, "a.py"), kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n-def edit(filename, retries=3):\n+def edit(filename, retries=5):\n-    codex_name = 1\n+    codex_name_v2 = 1" }]),
        codexItem(4, [{ path: join(cwd, "old.py"), kind: { type: "update", move_path: join(cwd, "moved.py") }, diff: "@@ -1 +1 @@\n-def old_helper():\n+def moved_helper():" }]),
      ],
    });
    run("00-solo-codex", { index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind: "solo-codex", repeat: 0, end_reason: "interrupted", end_reason_detail: "setup-calibration", cwd, sealedCommit, taskStates: [], events: [], codexMessages: [] });
    const out = ledger();
    const tf = out.rows.find((r: { arm: string }) => r.arm === "hub-turnfree-codex-claude");
    expect(tf).toMatchObject({ completed: false, both_done_s: null, end_reason_detail: "wall-timeout" });
    expect(tf.validity).toEqual({ valid: false, why: "turn-free context path not verified before the tasks: codex" });
    // helper_alpha: removed by Claude's own Write. codex_name: Codex's, carried by Claude's Write, renamed by Codex itself.
    // claude_feature_fn: Claude's, in a file Codex moved afterwards, intact at the new path.
    expect(tf.contributions.identifiers).toEqual([]);
    // The default Claude set was overwritten (a same-name change); the partial-line edit is still in the file.
    expect(tf.contributions.fragments).toEqual([{ agent: "claude", path: "a.py", fragment: "def edit(filename, retries=3):" }]);
    expect(out.rows.find((r: { arm: string }) => r.arm === "solo-codex")).toMatchObject({ completed: false, status: "no tasks: a setup-only or failed-before-assignment attempt" });
    expect(out.summary["hub-turnfree-codex-claude"]).toMatchObject({ attempts: 1, completed: 0, valid_completed: 0, not_completed: ["wall-timeout"], both_done_s_median: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing fixture or an unreadable transcript gives nulls with a reason, not a crash", () => {
  const { root, cwd, sealedCommit, run, ledger, t0 } = fixture();
  try {
    run("00-hub-codex-claude", {
      index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind: "hub-codex-claude", end_reason: "completed", cwd: join(root, "gone"), sealedCommit, readiness: { claude: { transcriptPath: join(root, "nope.jsonl") } },
      taskStates: [{ id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: t0 }, { event: "done", at: t0 + 1000 }] }], events: [], codexMessages: [],
    });
    const row = ledger().rows[0];
    expect(row.claude).toBeNull();
    // Missing evidence is unknown, never "no hooks ran": the attempt is left out of the arm's medians.
    expect(row.validity).toEqual({ valid: null, why: "hook isolation unknown: transcript unreadable (FileNotFoundError)" });
    expect(row.hooks).toMatchObject({ claude_transcript_rows: null, foreign: null, claude_why: "transcript unreadable (FileNotFoundError)" });
    expect(row.contributions).toEqual({ identifiers: null, fragments: null, coverage: ["the fixture is gone: nothing to compare with"] });
    void cwd;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("several run directories pool their repeats; a planned attempt without a record is missing; an invalid one is left out of the medians", () => {
  const a = fixture();
  const b = fixture();
  try {
    const record = (f: ReturnType<typeof fixture>, kind: string, repeat: number, events: unknown[] = []) => ({
      index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind, repeat, end_reason: "completed", cwd: f.cwd, sealedCommit: f.sealedCommit, codexMessages: [], events,
      readiness: kind.includes("claude") ? { claude: { transcriptPath: join(f.root, "none.jsonl") } } : {},
      taskStates: [{ id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: f.t0 }, { event: "done", at: f.t0 + repeat * 10_000 }] }],
    });
    for (const [f, repeat] of [[a, 1], [b, 2]] as const) writeFileSync(join(f.root, "cohort.json"), JSON.stringify({ cases: [0], arms: ["solo-codex", "hub-turnfree-codex-claude"], repeat }));
    writeFileSync(join(a.root, "manifest.json"), JSON.stringify({ arms: ["solo-codex", "hub-turnfree-codex-claude"], plan: { pilot: { cases: [0], repeats: 3 } } }));
    a.run("00-solo-codex", record(a, "solo-codex", 1));
    b.run("00-solo-codex", record(b, "solo-codex", 2));
    a.run("00-hub-turnfree-codex-claude", record(a, "hub-turnfree-codex-claude", 1, [{ type: "cohort", id: 1, event: "formed", silent: false, tasks: [1], at: a.iso(1) }]));
    const twice = spawnSync("python3", [script, "--run", a.root, "--run", a.root], { encoding: "utf8" });
    expect(twice.status).not.toBe(0); // one repeat given twice would count twice
    expect(twice.stderr).toContain("repeat 1 is in both");
    const r = spawnSync("python3", [script, "--run", a.root, "--run", b.root, "--plan", "pilot"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    const out = JSON.parse(readFileSync(join(a.root, "ledger.json"), "utf8"));
    expect(out.rows.map((x: { run: string; repeat: number }) => x.repeat).sort()).toEqual([1, 1, 2]);
    // The plan's first repeat never ran at all: every arm of it is missing, as is the turn-free attempt of repeat 2.
    expect(out.missing).toEqual([{ case: 0, arm: "hub-turnfree-codex-claude", repeat: 0 }, { case: 0, arm: "hub-turnfree-codex-claude", repeat: 2 }, { case: 0, arm: "solo-codex", repeat: 0 }]);
    expect(out.summary["solo-codex"]).toMatchObject({ attempts: 2, valid_completed: 2, both_done_s_median: 15 });
    expect(out.summary["hub-turnfree-codex-claude"]).toMatchObject({
      attempts: 1, completed: 1, valid_completed: 0, excluded: ["turn-free context path not verified before the tasks: claude, codex"], missing: ["case 0 repeat 0", "case 0 repeat 2"], both_done_s_median: null,
    });
    // #115: a record kept in recovery/ (its cleanup incomplete) is a withheld attempt, unavailable, never missing.
    mkdirSync(join(b.root, "recovery", "runs"), { recursive: true });
    writeFileSync(join(b.root, "recovery", "runs", "00-hub-turnfree-codex-claude.json"), JSON.stringify({ ...record(b, "hub-turnfree-codex-claude", 2), cleanup_complete: false, cleanup: { outcome: "incomplete_or_unknown", reasons: ["still running: below 107"] } }));
    expect(spawnSync("python3", [script, "--run", a.root, "--run", b.root, "--plan", "pilot"], { encoding: "utf8" }).status).toBe(0);
    const held = JSON.parse(readFileSync(join(a.root, "ledger.json"), "utf8"));
    expect(held.missing).not.toContainEqual({ case: 0, arm: "hub-turnfree-codex-claude", repeat: 2 });
    const withheld = held.rows.find((x: { withheld?: boolean }) => x.withheld);
    expect([withheld.repeat, withheld.validity]).toEqual([2, { valid: false, why: "cleanup incomplete or unknown: still running: below 107" }]);
    // restore.ts writes a record to runs/ before it removes it from recovery/: stopped in between, the record is in both
    // and still withheld.
    b.run("00-hub-turnfree-codex-claude", record(b, "hub-turnfree-codex-claude", 2));
    const both = spawnSync("python3", [script, "--run", a.root, "--run", b.root, "--plan", "pilot"], { encoding: "utf8" });
    if (both.status !== 0) throw new Error(both.stderr);
    const moving = JSON.parse(readFileSync(join(a.root, "ledger.json"), "utf8")).rows.filter((x: { repeat: number; arm: string }) => x.repeat === 2 && x.arm === "hub-turnfree-codex-claude");
    expect(moving.map((x: { withheld?: boolean; validity: { valid: boolean } }) => [x.withheld, x.validity.valid])).toEqual([[true, false]]); // the recovery copy
    // runs/ locked with the arm's siblings (its cleanup incomplete): its records cannot be read, which is not "missing".
    rmSync(join(b.root, "runs", "00-hub-turnfree-codex-claude.json"));
    chmodSync(join(b.root, "runs"), 0o000);
    const locked = spawnSync("python3", [script, "--run", a.root, "--run", b.root, "--plan", "pilot"], { encoding: "utf8" });
    chmodSync(join(b.root, "runs"), 0o700);
    if (locked.status !== 0) throw new Error(locked.stderr);
    expect(locked.stderr).toContain("locked until");
    const unread = JSON.parse(readFileSync(join(a.root, "ledger.json"), "utf8"));
    expect(unread.unreadable).toEqual([{ case: 0, arm: "solo-codex", repeat: 2 }]); // b's solo-codex record is in runs/
    expect(unread.summary["solo-codex"].unreadable).toEqual(["case 0 repeat 2"]);
    // An arm with no record at all still shows what it owes.
    const lone = spawnSync("python3", ["-c", `import json, sys; sys.path.insert(0, ${JSON.stringify(join(script, ".."))}); from ledger import summarize; print(json.dumps(summarize([], [(0, "solo-claude", 1)], [(0, "solo-claude", 2)])))`], { encoding: "utf8" });
    if (lone.status !== 0) throw new Error(lone.stderr);
    expect(JSON.parse(lone.stdout)["solo-claude"]).toMatchObject({ attempts: 0, valid_completed: 0, both_done_s_median: null, missing: ["case 0 repeat 1"], unreadable: ["case 0 repeat 2"] });
    // Common medians are over pairs every arm completed validly: an arm with no record completed none.
    const row = { arm: "solo-codex", case: 0, repeat: 1, completed: true, validity: { valid: true }, both_done_s: 10 };
    const pair = spawnSync("python3", ["-c", `import json, sys; sys.path.insert(0, ${JSON.stringify(join(script, ".."))}); from ledger import summarize; print(json.dumps(summarize([${JSON.stringify(row).replace(/true/g, "True")}], [(0, "solo-claude", 1)])))`], { encoding: "utf8" });
    if (pair.status !== 0) throw new Error(pair.stderr);
    expect(JSON.parse(pair.stdout)["solo-codex"]).toMatchObject({ both_done_s_median: 10, both_done_s_median_common: null });
    expect(unread.missing).not.toContainEqual({ case: 0, arm: "solo-codex", repeat: 2 });
    expect(unread.rows.filter((x: { withheld?: boolean }) => x.withheld)).toHaveLength(1);
  } finally {
    for (const f of [a, b]) { try { chmodSync(join(f.root, "runs"), 0o700); } catch {} rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("a measure that does not apply is not unknown, an unknown settlement or a partial count is no number, and hook labels keep values out", () => {
  const { root, cwd, sealedCommit, run, ledger, t0, iso } = fixture();
  try {
    const transcript = join(root, "claude.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", timestamp: iso(9), message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
      JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "PreToolUse:Bash", command: 'SLACK_TOKEN=xoxb-123 MSG="hello secretword" /usr/local/bin/notify --channel x' } }),
      JSON.stringify({ type: "assistant", timestamp: iso(11), message: { id: "m2", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "API Error" }] } }),
    ].join("\n"));
    const task = (owner: string, done: number) => ({ id: 1, owner, state: "approved", history: [{ event: "proposed", at: t0 }, { event: "done", at: t0 + done * 1000 }] });
    run("00-solo-claude", { index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind: "solo-claude", repeat: 0, end_reason: "completed", cwd, sealedCommit, readiness: { claude: { transcriptPath: transcript } }, taskStates: [task("claude", 10)], events: [], codexMessages: [] });
    run("00-hub-codex-claude", {
      index: 0, cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, trust_restored: true, kind: "hub-codex-claude", repeat: 0, end_reason: "completed", cwd, sealedCommit, readiness: { claude: { transcriptPath: join(root, "gone.jsonl") } }, taskStates: [task("codex", 10)], events: [],
      codexMessages: [{ method: "turn/started", params: {}, emittedAtMs: t0 + 5000 }], // still in its turn when its record ended
    });
    const out = ledger();
    const solo = out.rows.find((r: { arm: string }) => r.arm === "solo-claude");
    expect(solo.settlement).toEqual({ claude: 11 }); // the synthetic error response ended its turn
    expect(solo.hooks).toMatchObject({ claude_transcript_rows: { "PreToolUse:Bash other: notify": 1 }, foreign: ["other: notify"] });
    expect(JSON.stringify(out)).not.toMatch(/xoxb|secretword/);
    expect(solo.validity).toEqual({ valid: false, why: "hook isolation failed: Claude ran a hook that is not the hub's" });
    expect(out.summary["solo-claude"]).toMatchObject({ hub_send_unknown: 0, post_done_turns_unknown: 0, late_replies_unknown: 0 });
    const joint = out.rows.find((r: { arm: string }) => r.arm === "hub-codex-claude");
    expect(joint.settlement).toEqual({ codex: null, claude: null }); // a missing record is unknown, never left out
    expect(joint.settlement_s).toBeNull();
    expect(out.summary["hub-codex-claude"]).toMatchObject({ lost_identifiers_unknown: 1, lost_fragments_unknown: 1 }); // Claude's writes were not counted
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// issue #113: a final answer written after the attempt's prefix was taken is never counted: the prefix stays as recorded,
// the late bytes are reported, and the settlement of a turn still open in the prefix is unknown.
test("a late transcript append keeps the frozen prefix, is reported, and leaves an open turn's settlement unknown", () => {
  const { root, cwd, sealedCommit, run, ledger, ms, iso } = fixture();
  try {
    const transcript = join(root, "claude.jsonl");
    const rows = [
      { type: "assistant", sessionId: "s", timestamp: iso(10), message: { id: "m1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", sessionId: "s", timestamp: iso(11), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(transcript, rows);
    const late = [
      { type: "assistant", sessionId: "s", timestamp: iso(40), message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "[FYI] done" }] } },
      { type: "system", subtype: "turn_duration", sessionId: "s", timestamp: iso(40) },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const { createHash } = require("node:crypto");
    run("00-solo-claude", {
      index: 0, cleanup_complete: true, trust_restored: true, kind: "solo-claude", end_reason: "completed", cwd, sealedCommit, codexMessages: [], events: [], startedAt: ms(0), elapsedMs: 30_000,
      readiness: { claude: { transcriptPath: transcript, transcriptBytes: Buffer.byteLength(rows), transcriptSha256: createHash("sha256").update(rows).digest("hex") } },
      taskStates: [{ id: 1, owner: "claude", state: "approved", history: [{ event: "proposed", at: ms(0) }, { event: "done", at: ms(9) }] }],
      completion: { outcome: "timeout", ms: 30_000, boundMs: 30_000 }, tree_changed_after_active_time: false,
      cleanup: { outcome: "clean", reasons: [], fallback: [], normal: { errors: ["registration not removed: test"], ms: 10 } }, restoration: { siblings: "restored", trust: "restored" },
    });
    writeFileSync(transcript, rows + late); // Claude Code wrote its answer after the prefix was taken
    const row = ledger().rows[0];
    expect(row.settlement.claude).toBeNull(); // the turn is open in the prefix: unknown, not counted from the late rows
    expect(row.teardown).toEqual({ completion: { outcome: "timeout", ms: 30_000, boundMs: 30_000 }, cleanup: "clean", cleanup_reasons: [], fallback_signals: 0, restoration: { siblings: "restored", trust: "restored" }, late_append_bytes: Buffer.byteLength(late), normal_errors: ["registration not removed: test"], tree_changed_after_active_time: false, verified: true });
    expect(row.validity.valid).not.toBe(false); // the prefix still matches its hash: readable
    // An attempt whose cleanup was not complete is unavailable to the ledger as to grading, whatever its end reason.
    run("00-solo-claude", { ...JSON.parse(readFileSync(join(root, "runs", "00-solo-claude.json"), "utf8")), cleanup_complete: false, cleanup: { outcome: "incomplete_or_unknown", reasons: ["still running: below 107"] } });
    expect(ledger().rows[0].validity).toEqual({ valid: false, why: "cleanup incomplete or unknown: still running: below 107" });
    // A record from before 0.12.5 is judged as it was then, by its own flags (0.12.3 and 0.12.4 set cleanup_complete when
    // the shutdown commands exited 0), and its teardown is shown as not verified.
    const { cleanup: _, ...older } = JSON.parse(readFileSync(join(root, "runs", "00-solo-claude.json"), "utf8"));
    run("00-solo-claude", { ...older, cleanup_complete: true });
    expect([ledger().rows[0].validity.valid, ledger().rows[0].teardown.verified]).toEqual([true, false]);
    run("00-solo-claude", { ...older, cleanup_complete: false });
    expect(ledger().rows[0].validity).toEqual({ valid: false, why: "cleanup incomplete, as recorded before 0.12.5" });
    run("00-solo-claude", { ...older, cleanup_complete: true, kind: "solo-codex", codexMessages: [{ method: "hook/started" }] }); // a definite failure still shows
    expect(ledger().rows[0].validity).toEqual({ valid: false, why: "hook isolation failed: Codex ran hooks" });
    // A flag beside the end reason is part of how the attempt ended: reported, not a bare "completed".
    run("00-solo-claude", { ...JSON.parse(readFileSync(join(root, "runs", "00-solo-claude.json"), "utf8")), kind: "solo-claude", codexMessages: [], cleanup_complete: true, cleanup: { outcome: "clean", reasons: [] }, end_reason: "infrastructure-error", end_reason_detail: "completed", end_flags: ["tree-changed-after-active-time"] });
    const flagged = ledger();
    expect(flagged.rows[0].end_story).toBe("completed, then tree-changed-after-active-time");
    expect(flagged.summary["solo-claude"].not_completed).toEqual(["completed, then tree-changed-after-active-time"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// issue #151: a v3 headless Pi/Qwen record has no board taskStates (bus prompts); the ledger dispatches on the
// record's protocol and classifies it by the runner's own end reason, apart from official quality (the grader's).
const V3_UNITS = { pi: "incremental onTokens counter, whole attempt including the setup probes", qwen: "session usage_update running total, whole attempt including the setup probes" };

function v3record(f: ReturnType<typeof fixture>, kind: string, over: Record<string, unknown> = {}) {
  return {
    protocol: "native-pq-v3", platform: "darwin", index: 0, kind, repo: "pallets/click", features: [1, 2], project: f.cwd, cwd: f.cwd, sealedCommit: f.sealedCommit,
    readiness: {}, patchFile: "", sourceDirs: ["src"], featureAssignments: { pi: 0, qwen: 1 },
    modelIdentity: {
      requested: "flashnext/qwen3.8-flash-next", expectedServedModel: "qwen3.8-flash-next", expectedProvider: "prov", probe: { servedModel: "qwen3.8-flash-next", provider: "prov" }, generationVerified: true,
      requests: [
        { id: "r1", outcome: "completed", identified: true, requestedModel: "flashnext/qwen3.8-flash-next", actualModel: "qwen3.8-flash-next", provider: "prov" },
        { id: "r2", outcome: "cancelled", identified: false }, // cancelled before identification: certifies nothing
      ],
    },
    requestLinkage: { requests: 2, completed: 1, identified: 1, cancelledUnidentified: 1, mismatches: 0, providerMissing: 0 },
    nativeVersions: { pi: { version: "1.0.1", binary: "pi" }, qwen: { version: "0.24.7", binary: "cli.js" } },
    repeat: 0, setupMs: 5000, elapsedMs: 120_000, startedAt: f.t0,
    usage: { pi: 4200, qwen: 9800, units: V3_UNITS, toolSurfaces: { pi: "hub-moderated tools", qwen: "own seatbelted tools" } },
    end_reason: "completed", end_reason_detail: "completed",
    cleanup: { outcome: "clean", reasons: [] }, cleanup_complete: true,
    metadata_clean: true, tree_changed_after_active_time: false, changedPaths: [],
    events: [{ at: f.iso(0), event: "active_start" }, { at: f.iso(10), event: "peer_message", from: "pi", to: "qwen" }],
    answers: { pi: ["[FYI] done"], qwen: ["[FYI] done"] }, patchSHA256: "x", patchBytes: 120,
    ...over,
  };
}

test("completed v3 records without taskStates classify by their end reason, with usage units kept apart and request linkage consumed", () => {
  const f = fixture();
  try {
    f.run("00-joint-pi-qwen", v3record(f, "joint-pi-qwen"));
    // A timeout is a normal classification, not a setup error; a solo-pi record has no qwen actor (null, preserved).
    f.run("00-solo-pi", v3record(f, "solo-pi", {
      usage: { pi: 3100, qwen: null, units: V3_UNITS }, end_reason: "timeout", end_reason_detail: "wall-timeout", elapsedMs: 300_000, answers: { pi: ["[FYI] partial"] },
      requestLinkage: { requests: 4, completed: 4, identified: 4, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 },
    }));
    // An infrastructure error with an incomplete cleanup: unavailable by the teardown gate, whatever it managed to do.
    f.run("00-solo-qwen", v3record(f, "solo-qwen", {
      usage: { pi: 0, qwen: 5100, units: V3_UNITS }, end_reason: "infrastructure-error", end_reason_detail: "infrastructure-error", error: "relay exploded",
      cleanup: { outcome: "incomplete_or_unknown", reasons: ["still running: below 107"] }, cleanup_complete: false, elapsedMs: 40_000,
    }));
    const out = f.ledger();
    const joint = out.rows.find((r: { arm: string }) => r.arm === "joint-pi-qwen");
    expect(joint).toMatchObject({ protocol: "native-pq-v3", completed: true, end_reason: "completed", elapsed_s: 120, setup_s: 5, peer_messages: 1, answers: { pi: 1, qwen: 1 } });
    expect(joint.done_s).toBeUndefined(); // no board tasks: the task measures are absent, not zero
    expect(joint.native_usage).toMatchObject({ pi: 4200, qwen: 9800, units: V3_UNITS });
    expect(joint.request_linkage).toEqual({ requests: 2, completed: 1, identified: 1, cancelledUnidentified: 1, mismatches: 0, providerMissing: 0 });
    expect(joint.model_identity).toEqual({ verified: true, why: null, requests_journaled: 2 });
    expect(joint.validity).toEqual({ valid: true, why: null });
    expect(joint.teardown).toMatchObject({ cleanup: "clean", verified: true, tree_changed_after_active_time: false });
    const soloPi = out.rows.find((r: { arm: string }) => r.arm === "solo-pi");
    expect(soloPi).toMatchObject({ completed: false, end_reason: "timeout", end_reason_detail: "wall-timeout", end_story: "wall-timeout", elapsed_s: 300, validity: { valid: true, why: null } });
    expect(soloPi.native_usage.qwen).toBeNull(); // no qwen actor in the arm: not applicable, preserved as null
    const soloQwen = out.rows.find((r: { arm: string }) => r.arm === "solo-qwen");
    expect(soloQwen).toMatchObject({ completed: false, end_reason: "infrastructure-error", error: "relay exploded" });
    expect(soloQwen.validity).toEqual({ valid: false, why: "cleanup incomplete or unknown: still running: below 107" });
    const summary = out.summary["joint-pi-qwen"];
    expect(summary).toMatchObject({ attempts: 1, completed: 1, valid_completed: 1, elapsed_s_median: 120, setup_s_median: 5, model_identity_verified: 1 });
    expect(summary.request_linkage).toEqual({ attempts: 1, requests: 2, completed: 1, identified: 1, cancelledUnidentified: 1, mismatches: 0, providerMissing: 0 });
    expect(summary.native_usage).toMatchObject({ pi_tokens_total: 4200, pi_tokens_unknown: 0, qwen_tokens_total: 9800, qwen_tokens_unknown: 0 });
    expect(summary.native_usage.units).toContain("never added together"); // the two units stay apart
    expect(out.summary["solo-pi"].not_completed).toEqual(["wall-timeout"]);
    expect(out.summary["solo-pi"].native_usage.qwen_tokens_total).toBeUndefined(); // no qwen actor: not counted at all
    expect(out.summary["solo-qwen"]).toMatchObject({ attempts: 1, completed: 0, valid_completed: 0, not_completed: ["infrastructure-error"], elapsed_s_median: null });
    expect(Object.keys(out.units)).toEqual(expect.arrayContaining(["native_usage", "request_linkage", "model_identity"]));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("two v3 repeats pool over the fixed 10 cases x 3 arms x 2 repeats matrix; duplicates and missing planned cells are refused or listed", () => {
  const a = fixture();
  const b = fixture();
  try {
    // The driver's arm-failure fallback record: a setup error, no usage, no elapsed time, cleanup unknown.
    const fallback = (f: ReturnType<typeof fixture>, kind: string, repeat: number) => ({
      protocol: "native-pq-v3", platform: "darwin", index: 0, kind, repo: "pallets/click", features: [1, 2], cwd: f.cwd, sealedCommit: "",
      readiness: {}, patchFile: "", modelIdentity: { requested: "flashnext/qwen3.8-flash-next", generationVerified: false, requests: [] },
      requestLinkage: { requests: 0, completed: 0, identified: 0, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 },
      nativeVersions: {}, repeat, end_reason: "infrastructure-error", end_reason_detail: "infrastructure-error", error: "probe failed",
      cleanup_complete: false, metadata_clean: false, events: [], answers: {}, patchSHA256: "x", patchBytes: 0,
    });
    const manifest = { arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], plan: { study: { cases: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], repeats: 2, attempts: 60, active_ceiling_s: 18000 } } };
    writeFileSync(join(a.root, "manifest.json"), JSON.stringify(manifest));
    for (const [f, repeat] of [[a, 0], [b, 1]] as const) writeFileSync(join(f.root, "cohort.json"), JSON.stringify({ schema: "agent-hub.cooperbench-run/v1", cases: [0], arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], repeat }));
    for (const kind of ["solo-pi", "solo-qwen", "joint-pi-qwen"]) a.run(`00-${kind}`, v3record(a, kind, { repeat: 0, elapsedMs: 120_000 }));
    b.run("00-solo-pi", v3record(b, "solo-pi", { repeat: 1, elapsedMs: 180_000 }));
    b.run("00-joint-pi-qwen", v3record(b, "joint-pi-qwen", { repeat: 1, elapsedMs: 180_000 }));
    b.run("00-solo-qwen", fallback(b, "solo-qwen", 1));
    // A repeat given twice is refused.
    const twice = spawnSync("python3", [script, "--run", a.root, "--run", a.root], { encoding: "utf8" });
    expect(twice.status).not.toBe(0);
    expect(twice.stderr).toContain("repeat 0 is in both");
    const r = spawnSync("python3", [script, "--run", a.root, "--run", b.root, "--plan", "study"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    const out = JSON.parse(readFileSync(join(a.root, "ledger.json"), "utf8"));
    expect(out.rows).toHaveLength(6);
    // 60 planned cells, 6 written: every other planned cell is listed as missing, whole cases included.
    expect(out.missing).toHaveLength(54);
    expect(out.missing).toContainEqual({ case: 1, arm: "solo-pi", repeat: 0 });
    expect(out.missing).toContainEqual({ case: 9, arm: "joint-pi-qwen", repeat: 1 });
    expect(out.summary["solo-pi"].missing).toHaveLength(18); // cases 1-9 of both repeats
    expect(out.summary["solo-pi"].missing).toContain("case 1 repeat 0");
    // Pair (0, 1) is not common: solo-qwen's repeat 1 is unavailable. Medians over valid completed vs common pairs differ.
    expect(out.summary["solo-pi"]).toMatchObject({ attempts: 2, completed: 2, valid_completed: 2, elapsed_s_median: 150, elapsed_s_median_common: 120 });
    expect(out.summary["joint-pi-qwen"].missing).toHaveLength(18);
    // The fallback record keeps its setup-error classification and its usage stays unknown, never zero.
    const fell = out.rows.find((x: { run: string; arm: string }) => x.run === b.root.split("/").pop() && x.arm === "solo-qwen");
    expect(fell).toMatchObject({ completed: false, end_reason: "infrastructure-error", elapsed_s: null, setup_s: null, protocol: "native-pq-v3" });
    expect([fell.native_usage.pi, fell.native_usage.qwen]).toEqual([null, null]);
    expect(fell.validity.valid).toBe(false);
    const qwen = out.summary["solo-qwen"];
    expect(qwen).toMatchObject({ attempts: 2, completed: 1, valid_completed: 1, elapsed_s_median: 120, not_completed: ["infrastructure-error"] });
    expect(qwen.native_usage).toMatchObject({ qwen_tokens_total: 9800, qwen_tokens_unknown: 1 }); // the fallback wrote none: unknown, not zero
    expect(qwen.native_usage.pi_tokens_total).toBeUndefined(); // no pi actor in the arm
  } finally {
    for (const f of [a, b]) rmSync(f.root, { recursive: true, force: true });
  }
});

test("a record of an unknown protocol is refused before any output is written", () => {
  const f = fixture();
  try {
    f.run("00-solo-pi", v3record(f, "solo-pi", { protocol: "native-pq-v9" }));
    const r = spawnSync("python3", [script, "--run", f.root], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unsupported record protocol");
    expect(existsSync(join(f.root, "ledger.json"))).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a stale cached model verdict and linkage summary are recomputed from the request journal; a missing journal is unknown (review #151)", () => {
  const f = fixture();
  try {
    // The cached summary claims verified with zero requests; the journal shows a cancelled-AFTER-identification
    // request with a confirmed mismatch — evidence whatever its outcome, so the verdict is failed.
    f.run("00-joint-pi-qwen", v3record(f, "joint-pi-qwen", {
      modelIdentity: {
        requested: "flashnext/qwen3.8-flash-next", expectedServedModel: "qwen3.8-flash-next", expectedProvider: "prov", generationVerified: true,
        requests: [
          { id: "r1", outcome: "completed", identified: true, requestedModel: "flashnext/qwen3.8-flash-next", actualModel: "qwen3.8-flash-next", provider: "prov" },
          { id: "r2", outcome: "cancelled", identified: true, requestedModel: "flashnext/qwen3.8-flash-next", actualModel: "qwen3.8-flash-next", provider: "prov", mismatch: true },
        ],
      },
      requestLinkage: { requests: 0, completed: 0, identified: 0, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 }, // stale cache: lies
    }));
    // A record without its journal: explicit unknown, never the trusted cached flag.
    f.run("00-solo-pi", v3record(f, "solo-pi", { index: 1, modelIdentity: { requested: "flashnext/qwen3.8-flash-next", generationVerified: true } }));
    // Setup failures with recorded setup time stay out of the setup median (valid completed attempts only).
    f.run("00-solo-qwen", v3record(f, "solo-qwen", { index: 2, setupMs: 60_000, elapsedMs: undefined, startedAt: undefined, end_reason: "infrastructure-error", end_reason_detail: "infrastructure-error", usage: { pi: 0, qwen: null, units: V3_UNITS } }));
    const out = f.ledger();
    const joint = out.rows.find((r: { arm: string }) => r.arm === "joint-pi-qwen");
    expect(joint.model_identity).toEqual({ verified: false, why: "generation served model mismatch flagged", requests_journaled: 2 });
    expect(joint.request_linkage).toEqual({ requests: 2, completed: 1, identified: 1, cancelledUnidentified: 0, mismatches: 1, providerMissing: 0 });
    expect(out.summary["joint-pi-qwen"]).toMatchObject({ model_identity_verified: 0 });
    expect(out.summary["joint-pi-qwen"].request_linkage).toMatchObject({ requests: 2, mismatches: 1 });
    const soloPi = out.rows.find((r: { arm: string }) => r.arm === "solo-pi");
    expect(soloPi.model_identity).toEqual({ verified: null, why: "the record carries no request journal", requests_journaled: null });
    expect(soloPi.request_linkage).toBeNull();
    expect(soloPi.completed).toBe(true); // an unknown model verdict is not the runner's end classification
    expect(out.summary["solo-pi"]).toMatchObject({ model_identity_verified: 0, valid_completed: 1 });
    expect(out.summary["solo-pi"].request_linkage).toEqual({ attempts: 0, requests: 0, completed: 0, identified: 0, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 });
    // The failed setup recorded 60 s; only the (absent here) valid completed attempts would feed the median.
    expect(out.summary["solo-qwen"]).toMatchObject({ attempts: 1, valid_completed: 0, setup_s_median: null, not_completed: ["infrastructure-error"] });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the setup median pools only valid completed attempts", () => {
  const f = fixture();
  try {
    f.run("00-solo-pi", v3record(f, "solo-pi", { setupMs: 5000 }));
    f.run("01-solo-pi", v3record(f, "solo-pi", { index: 1, setupMs: 65_000, end_reason: "timeout", end_reason_detail: "wall-timeout", elapsedMs: 300_000 }));
    const out = f.ledger();
    // The timed-out attempt's 65 s setup is not a measurement of a good attempt's setup.
    expect(out.summary["solo-pi"]).toMatchObject({ attempts: 2, completed: 1, valid_completed: 1, setup_s_median: 5, elapsed_s_median: 120 });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
