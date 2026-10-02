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
      JSON.stringify({ type: "assistant", timestamp: iso(85), message: { id: "msg-end", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 5 } } }),
      JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: "bun facts-hook.ts", durationMs: 30 }], timestamp: iso(85) }),
    ].join("\n"));
    const item = (item: Record<string, unknown>, s: number) => ({ method: "item/completed", params: { item }, emittedAtMs: ms(s) });
    const usage = (s: number, total: number) => ({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { totalTokens: total }, last: { totalTokens: 1 } } }, emittedAtMs: ms(s) });
    run("00-hub-turnfree-codex-claude", {
      index: 0, kind: "hub-turnfree-codex-claude", repeat: 1, end_reason: "completed", end_reason_detail: "completed", setupMs: 20_000, elapsedMs: 95_000, cwd, sealedCommit, startedAt: ms(0),
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
        { type: "hook_stats", peer: "claude", n: 4, startupMs: 200, hubMs: 12, maxStartupMs: 80, at: iso(85) },
        { type: "envelope", id: "e1", from: "claude", to: ["codex"], priority: "status", kind: "chat", at: iso(30) },
        { type: "quiet", id: "e1", from: "claude", peers: ["codex"], at: iso(30) },
        { type: "envelope", id: "e2", from: "claude", priority: "status", kind: "chat", at: iso(60) }, // a broadcast reaches codex too
        { type: "envelope", id: "e4", from: "claude", to: ["codex"], priority: "important", kind: "chat", at: iso(95) }, // steered into a running turn
        { type: "envelope", id: "e3", from: "codex", priority: "fyi", kind: "chat", dropped: "fyi", at: iso(61) },
        { type: "fact", peer: "claude", id: "f1", via: "hook", files: 1, plans: 0, unknown: 0, bytes: 300, ms: 4, hookMs: 120, at: iso(31) },
        { type: "fact_ack", peer: "claude", id: "f1", via: "hook", ms: 900, at: iso(32) },
        { type: "fact", peer: "codex", id: "f2", via: "steer", files: 1, plans: 0, unknown: 1, bytes: 500, ms: 6, rttMs: 40, accepted: false, at: iso(40) },
        { type: "fact", peer: "claude", id: "f3", via: "done", files: 0, plans: 0, unknown: 0, bytes: 80, at: iso(75) },
        { type: "stale", id: "n1", peer: "codex", at: iso(72) },
        { type: "split", task: 2, verdict: "unknown", reason: "codex has 0 measured task(s)", trace: ["unknown: codex has 0 measured task(s)"], at: iso(1) },
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
    expect(Object.keys(out.units)).toEqual(expect.arrayContaining(["contributions", "validity", "settlement", "summary", "hooks", "split_predictions", "codex_attempt", "claude_attempt"]));
    const row = out.rows[0];
    expect(row).toMatchObject({ arm: "hub-turnfree-codex-claude", repeat: 1, end_reason_detail: "completed", completed: true, both_done_s: 80, setup_s: 20, elapsed_s: 95, first_candidate_s: 9, integrated_s: 80, check_s: null });
    expect(row.done_s).toEqual({ 1: 70, 2: 80 });
    expect(row.intents_s).toEqual({ 1: 70, 2: 75 });
    expect(row.integration).toEqual({ requests: 1, unresolved: [] });
    // Each from its own record: Codex was idle at the last done (its turn ended at 72 s); Claude stopped at its end_turn.
    expect(row.settlement).toEqual({ codex: 80, claude: 85 });
    expect(row.settlement_s).toBe(85);
    // In task: up to its done on the board (70 s); the post-done turn's refused hub_task_done is not in-task. The first
    // in-task model call grows past the setup probe's total (1000), so it counts.
    expect(row.codex).toEqual({ turns: 1, assistant_messages: 1, usage_growth: 3, usage_events: 4, tokens: 3000, provider_requests: null, hub_send: 1, board_reads: 1, window: "to its last done" });
    expect(row.codex_attempt).toEqual({ turns: 2, assistant_messages: 1, usage_growth: 4, usage_events: 5, tokens: 4000, provider_requests: null, hub_send: 1, board_reads: 1, window: "to the end of the record" });
    expect(row.claude).toEqual({ assistant_messages: 4, turns: 0, tokens: null, provider_requests: null }); // t1, t2, t4, t3: no usage recorded
    expect(row.claude_attempt).toEqual({ assistant_messages: 5, turns: 1, tokens: 115, provider_requests: null });
    expect(row.post_done_turns).toEqual([{ started_s: 90, trigger: "notice" }]);
    // The broadcast at 60 s reached codex at its next turn (90 s); the steered one at 95 s landed at once, after the done;
    // the held one never reached it.
    expect(row.late_replies).toEqual([30, 0]);
    expect(row.validity).toEqual({ valid: true, why: null });
    expect(row).toMatchObject({ quiet: 1, fyi: 1, stale: 1 }); // the setup probe's [FYI] is not in the task window
    expect(row.facts.hook).toMatchObject({ offers: 1, acknowledged: 1, bytes: 300, build_ms_median: 4, hook_startup_ms_median: 120 });
    expect(row.facts.steer).toMatchObject({ offers: 1, acknowledged: 0, unknown_attribution_files: 1, steers_refused: 1, steer_rtt_ms_median: 40 });
    expect(row.facts.done).toMatchObject({ offers: 1, bytes: 80 });
    expect(row.facts.ack_ms_median).toBe(900);
    expect(row.split_predictions).toEqual([{ task: 2, verdict: "unknown", reason: "codex has 0 measured task(s)", trace: ["unknown: codex has 0 measured task(s)"] }]);
    expect(row.hooks).toMatchObject({
      claude_transcript_rows: { "PreToolUse:Edit bun facts-hook.ts": 1, "Stop bun facts-hook.ts": 1 }, claude_hook_ms: { timed_rows: 2, median: 33, total: 66 }, foreign: [],
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
      attempts: 1, completed: 1, valid_completed: 1, excluded: [], missing: [], both_done_s_median: 80, both_done_s_median_common: 80, quiet_total: 1, fact_offers_total: 3,
      integration_requests_total: 1, lost_identifiers_total: 3, codex_attempt_tokens_median: 4000, claude_attempt_tokens_median: 115,
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
      index: 0, kind: "hub-turnfree-codex-claude", repeat: 0, end_reason: "timeout", end_reason_detail: "wall-timeout", cwd, sealedCommit, readiness: { claude: { transcriptPath: transcript } },
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
    run("00-solo-codex", { index: 0, kind: "solo-codex", repeat: 0, end_reason: "interrupted", end_reason_detail: "setup-calibration", cwd, sealedCommit, taskStates: [], events: [], codexMessages: [] });
    const out = ledger();
    const tf = out.rows.find((r: { arm: string }) => r.arm === "hub-turnfree-codex-claude");
    expect(tf).toMatchObject({ completed: false, both_done_s: null, end_reason_detail: "wall-timeout" });
    expect(tf.validity).toEqual({ valid: false, why: "turn-free treatment absent: the tasks never formed a silent cohort" });
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
      index: 0, kind: "hub-codex-claude", end_reason: "completed", cwd: join(root, "gone"), sealedCommit, readiness: { claude: { transcriptPath: join(root, "nope.jsonl") } },
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
      index: 0, kind, repeat, end_reason: "completed", cwd: f.cwd, sealedCommit: f.sealedCommit, codexMessages: [], events,
      readiness: kind.includes("claude") ? { claude: { transcriptPath: join(f.root, "none.jsonl") } } : {},
      taskStates: [{ id: 1, owner: "codex", state: "approved", history: [{ event: "proposed", at: f.t0 }, { event: "done", at: f.t0 + repeat * 10_000 }] }],
    });
    for (const [f, repeat] of [[a, 1], [b, 2]] as const) writeFileSync(join(f.root, "cohort.json"), JSON.stringify({ cases: [0], arms: ["solo-codex", "hub-turnfree-codex-claude"], repeat }));
    a.run("00-solo-codex", record(a, "solo-codex", 1));
    b.run("00-solo-codex", record(b, "solo-codex", 2));
    a.run("00-hub-turnfree-codex-claude", record(a, "hub-turnfree-codex-claude", 1, [{ type: "cohort", id: 1, event: "formed", silent: false, tasks: [1], at: a.iso(1) }]));
    const r = spawnSync("python3", [script, "--run", a.root, "--run", b.root], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    const out = JSON.parse(readFileSync(join(a.root, "ledger.json"), "utf8"));
    expect(out.rows.map((x: { run: string; repeat: number }) => x.repeat).sort()).toEqual([1, 1, 2]);
    expect(out.missing).toEqual([{ case: 0, arm: "hub-turnfree-codex-claude", repeat: 2 }]);
    expect(out.summary["solo-codex"]).toMatchObject({ attempts: 2, valid_completed: 2, both_done_s_median: 15 });
    expect(out.summary["hub-turnfree-codex-claude"]).toMatchObject({
      attempts: 1, completed: 1, valid_completed: 0, excluded: ["turn-free treatment absent: the tasks never formed a silent cohort"], missing: ["case 0 repeat 2"], both_done_s_median: null,
    });
  } finally {
    for (const f of [a, b]) rmSync(f.root, { recursive: true, force: true });
  }
});
