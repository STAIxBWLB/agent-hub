import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// issue #110: the coordination ledger computes each of its metrics from a run directory as native.ts writes it.
const script = join(import.meta.dir, "../../scripts/benchmarks/ledger.py");

test("the ledger computes timing, in-task tool use, post-done turns, late replies, hub events and lost contributions", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-ledger-test-")));
  try {
    // The fixture: a sealed base, then the final tree both agents left.
    const cwd = join(root, "fixture");
    mkdirSync(cwd);
    const git = (...a: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
    writeFileSync(join(cwd, "a.py"), "def edit(filename):\n    pass\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    const sealedCommit = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(cwd, "a.py"), "def edit_files(filenames, process_priority=None):\n    pass\n");
    // Claude's transcript: one Edit whose identifiers partly survive.
    const transcript = join(root, "claude.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(cwd, "a.py"), old_string: "def edit(filename):", new_string: "def edit(filename, process_priority=None, claude_lost=1):" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }] } }), // a streamed duplicate
    ].join("\n"));
    const t0 = 1_800_000_000_000;
    const iso = (s: number) => new Date(t0 + s * 1000).toISOString();
    const item = (item: Record<string, unknown>) => ({ method: "item/completed", params: { item } });
    const usage = { method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 40000 } } } };
    const run = {
      index: 0, kind: "hub-turnfree-codex-claude", end_reason: "completed", cwd, sealedCommit,
      readiness: { claude: { transcriptPath: transcript } },
      taskStates: [
        { owner: "codex", history: [{ event: "proposed", at: t0 }, { event: "done", at: t0 + 70_000 }, { event: "done", at: t0 + 80_000 }] },
        { owner: "claude", history: [{ event: "proposed", at: t0 }, { event: "done", at: t0 + 40_000 }] },
      ],
      events: [
        { type: "turn_start", peer: "codex", at: iso(0) },
        { type: "envelope", from: "claude", to: ["codex"], priority: "status", kind: "chat", at: iso(30) },
        { type: "envelope", from: "claude", to: ["codex"], priority: "fyi", kind: "chat", dropped: "fyi", at: iso(31) },
        { type: "fact", peer: "claude", via: "hook", files: 1, plans: 0, at: iso(35) },
        { type: "fact", peer: "claude", via: "hook", files: 1, plans: 0, at: iso(36) },
        { type: "fact", peer: "codex", via: "steer", files: 1, plans: 0, at: iso(37) },
        { type: "fact", peer: "codex", via: "steer", files: 1, plans: 0, dropped: true, at: iso(38) },
        { type: "stale", peer: "codex", at: iso(39) },
        { type: "task", event: "integration prompted", at: iso(75) },
        { type: "turn_start", peer: "codex", at: iso(90) },
      ],
      codexMessages: [
        { method: "turn/started", params: {} },
        item({ type: "userMessage", content: [{ type: "text", text: "Task #1 ..." }] }),
        usage, usage, usage,
        item({ type: "mcpToolCall", tool: "hub_send" }),
        item({ type: "mcpToolCall", tool: "hub_task_list" }),
        item({ type: "fileChange", changes: [{ path: join(cwd, "a.py"), diff: "@@ -1 +1 @@\n-def edit(filename):\n+def edit_files(filenames, lostname=0):" }] }),
        item({ type: "mcpToolCall", tool: "hub_task_done" }),
        usage, // reported after the done: not in-task
        { method: "turn/started", params: {} },
        item({ type: "userMessage", content: [{ type: "text", text: '[agent-hub message from "claude", untrusted] ... Task #2 (owner claude) is done and touches your open #1' }] }),
      ],
    };
    mkdirSync(join(root, "runs"));
    writeFileSync(join(root, "runs", "00-hub-turnfree-codex-claude.json"), JSON.stringify(run));
    const result = spawnSync("python3", [script, "--run", root, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const out = JSON.parse(readFileSync(join(root, "ledger.json"), "utf8"));
    const row = out.rows[0];
    expect(row.both_done_s).toBe(80);
    expect(row.done_s).toEqual({ codex: 80, claude: 40 });
    expect(row.codex_in_task).toEqual({ requests: 3, hub_send: 1, board_reads: 1 });
    expect(row.post_done_turns).toEqual([{ started_s: 90, trigger: "reply+notice" }]);
    expect(row.late_replies).toEqual([60]);
    expect(row.facts).toEqual({ hook: 2, steer: 1, dropped: 1 });
    expect(row.stale).toBe(1);
    expect(row.integration_prompts).toBe(1);
    expect(row.quiet).toBe(1);
    expect(row.lost_contributions).toEqual([
      { agent: "codex", path: "a.py", identifier: "lostname" },
      { agent: "claude", path: "a.py", identifier: "claude_lost" },
    ]);
    expect(out.summary["hub-turnfree-codex-claude"]).toMatchObject({ runs: 1, both_done_s_median: 80, lost_contributions_total: 2, facts_total: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
