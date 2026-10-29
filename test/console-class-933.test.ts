import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";
import { classifyPeerCommand, cliCommandLabel, peerCommandRefusal } from "../src/cli/identity.ts";
import { CONDUCTOR_LOCAL_OPERATIONS, OPERATIONAL_PERSON_GUIDANCE } from "../src/hub/operational-authority.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";
import type { ScheduleEntry } from "../src/hub/schedules.ts";

// #933: the console class keeps trust, money, attribution and interactive terminals; the rest moved to the conductor or to the caller's own task.
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const SCHEDULES: ScheduleEntry[] = [{ id: "nightly", every: "1h", class: "plan", title: "Review the nightly board", queue: "backlog" }];

async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-console-933-"))), stateDir = join(root, ".agenthub/state");
  mkdirSync(join(root, ".agenthub"), { recursive: true });
  const config = { roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex", memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { enabled: false, keep: 20 }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } };
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify(config));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ schedules: SCHEDULES }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, boundedTools: emulatedBoundedTools(), configWatch: false, config: { ...DEFAULT_CONFIG, ...config, schedules: SCHEDULES, batch_ms: 0 } });
  const board = new Board(join(stateDir, "hub.db")), clients: ControlClient[] = [];
  const connect = async (peer: string) => { const client = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: root }); clients.push(client); return client; };
  const admitted = (command: string) => readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "agent_cli" && e.peer === "codex" && e.command === command && !e.refused).length;
  const refusedRows = (peer: string, command: string) => readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "agent_cli" && e.peer === peer && e.command === command && e.refused).length;
  return { root, stateDir, daemon, board, connect, admitted, refusedRows, async close() { for (const client of clients) client.close(); board.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); } };
}

async function cli(root: string, args: string[], peer = "codex") {
  const wrapper = join(root, `cli-${crypto.randomUUID()}.ts`);
  const markers = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"];
  writeFileSync(wrapper, `for(const key of ${JSON.stringify(markers)})delete process.env[key];process.env.AGENTHUB_PEER_ID=${JSON.stringify(peer)};process.env.AGENTHUB_HOME=${JSON.stringify(join(root, "home"))};process.argv=[process.execPath,${JSON.stringify(CLI)},...${JSON.stringify(args)}];await import(${JSON.stringify(CLI)});`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); rmSync(wrapper, { force: true }); }
}

test("#933 AC1: an agent cancels its own task as hub_task_cancel does; the daemon refuses another peer's task by role, not the CLI table", async () => {
  const f = await fixture(); try {
    const own = f.board.propose("codex", { title: "obsolete backlog of codex", class: "plan", backlog: true });
    const theirs = f.board.propose("claude", { title: "backlog claude proposed", class: "plan", backlog: true });
    const mcp = f.board.propose("codex", { title: "a second own card", class: "plan", backlog: true });
    for (const id of [own.id, theirs.id]) expect(classifyPeerCommand("task", ["cancel", String(id), "--reason", "x"])).toBe("allowed");
    const cancelled = await cli(f.root, ["task", "cancel", String(own.id), "--reason", "superseded by a newer plan"]);
    expect(cancelled.code, cancelled.stderr).toBe(0);
    const row = f.board.get(own.id)!;
    expect(row.state).toBe("cancelled"); expect(row.history.findLast(h => h.event === "cancelled")).toMatchObject({ by: "codex", note: "superseded by a newer plan" });
    // The same transition through the MCP tool, for comparison.
    const tools = await f.connect("codex");
    expect((await tools.request({ t: "task", op: "hub_task_cancel", args: { id: mcp.id, reason: "superseded by a newer plan" } })).ok).toBe(true);
    const viaTool = f.board.get(mcp.id)!;
    expect({ state: viaTool.state, event: viaTool.history.at(-1)!.event, by: viaTool.history.at(-1)!.by }).toEqual({ state: row.state, event: row.history.at(-1)!.event, by: row.history.at(-1)!.by });
    // Another peer's task: the CLI lets it through and the daemon's Tasks.cancel refuses it, with the same words as the tool.
    const refused = await cli(f.root, ["task", "cancel", String(theirs.id), "--reason", "not mine"]);
    expect(refused.code).toBe(1); expect(refused.stderr).toContain("planner may cancel only its own");
    expect(refused.stderr).not.toContain("inherited agent markers");
    const toolRefusal = await tools.request({ t: "task", op: "hub_task_cancel", args: { id: theirs.id, reason: "not mine" } });
    expect(toolRefusal.ok).toBe(false); expect(refused.stderr).toContain(String(toolRefusal.error));
    // A peer without the planner role is refused too: the authority is the tool's, nothing more.
    const other = await cli(f.root, ["task", "cancel", String(theirs.id), "--reason", "mine"], "claude");
    expect(other.code).toBe(1); expect(f.board.get(theirs.id)!.state).toBe("backlog");
  } finally { await f.close(); }
}, 30000);

test("#933 AC2: every conductor form is admitted once with one audit row, and another agent gets the existing operational refusal", async () => {
  const f = await fixture(); try {
    const lead = await f.connect("codex"), other = await f.connect("claude");
    const refusal = (reply: Record<string, unknown>, label: string) => {
      expect(reply).toMatchObject({ ok: false, authorityRefused: true, refusalAudited: true });
      expect(String(reply.error)).toBe(`claude cannot run ahub ${label}; ${OPERATIONAL_PERSON_GUIDANCE}; this operation requires the explicit conductor role`);
      expect(f.refusedRows("claude", label)).toBe(1);
    };
    // Forms whose effect runs in the CLI: the `admit` handshake is their one admission.
    for (const command of CONDUCTOR_LOCAL_OPERATIONS) {
      expect(await lead.request({ t: "conductor_operational", op: "admit", command })).toMatchObject({ ok: true });
      expect(f.admitted(command), command).toBe(1);
      refusal(await other.request({ t: "conductor_operational", op: "admit", command }), command);
    }
    expect((await lead.request({ t: "conductor_operational", op: "admit", command: "settings set" })).ok).toBe(false); // a daemon-op form is never admitted at the handshake
    expect(f.admitted("settings set")).toBe(0);
    // Console task ops: admitted by the daemon before Tasks, which records the conductor, never the person.
    const draft = f.board.propose(USER, { title: "an intake draft", class: "implement", backlog: true, draft: true });
    const approved = await lead.request({ t: "task", op: "intake_approve", args: { id: draft.id } });
    expect(approved.ok, String(approved.error)).toBe(true); expect(f.admitted("intake approve")).toBe(1);
    expect(f.board.get(draft.id)!.history.at(-1)).toMatchObject({ event: "draft approved", by: "codex" });
    const ran = await lead.request({ t: "task", op: "schedule_run", args: { id: "nightly" } }, 30000);
    expect(ran.ok, String(ran.error)).toBe(true); expect(f.admitted("schedule run")).toBe(1);
    for (const [op, label] of [["schedule_pause", "schedule pause"], ["schedule_resume", "schedule resume"]]) {
      expect((await lead.request({ t: "task", op, args: { id: "nightly" } })).ok).toBe(true); expect(f.admitted(label!)).toBe(1);
    }
    // An ordinary failure after admission keeps its own cause and is not a refusal of authority.
    const imported = await lead.request({ t: "task", op: "github_import", args: { label: "a,b" } });
    expect(imported).toMatchObject({ ok: false, authorityRefused: false }); expect(String(imported.error)).toContain("invalid GitHub import selection");
    expect(f.admitted("board import")).toBe(1); expect(f.refusedRows("codex", "board import")).toBe(0);
    const linked = await lead.request({ t: "goal_link", goal: "missing", task: draft.id });
    expect(linked.ok).toBe(false); expect(linked.authorityRefused).toBe(false); expect(f.admitted("goal link")).toBe(1);
    for (const [op, label] of [["github_import", "board import"], ["intake_approve", "intake approve"], ["schedule_run", "schedule run"], ["schedule_pause", "schedule pause"], ["schedule_resume", "schedule resume"]]) {
      refusal(await other.request({ t: "task", op, args: { id: "nightly", label: "x" } }), label!);
    }
    refusal(await other.request({ t: "goal_link", goal: "missing", task: draft.id }), "goal link");
    expect(f.board.list().filter(task => task.title === "Review the nightly board")).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

test("#933 AC2: conductor CLI forms run end to end with one daemon audit row and no second CLI row; another agent is refused", async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, "notes.md"), "a public note\n");
    const draft = f.board.propose(USER, { title: "an intake draft", class: "implement", backlog: true, draft: true });
    for (const [args, label] of [[["source", "add", "notes.md"], "source add"], [["intake", "approve", String(draft.id)], "intake approve"], [["schedule", "run", "nightly"], "schedule run"]] as [string[], string][]) {
      const denied = await cli(f.root, args, "claude");
      expect(denied.code, label).toBe(1); expect(denied.stderr).toContain("requires the explicit conductor role"); expect(denied.stderr).toContain(OPERATIONAL_PERSON_GUIDANCE);
      const run = await cli(f.root, args);
      expect(run.code, `${label}: ${run.stderr}`).toBe(0); expect(f.admitted(label)).toBe(1);
      expect(drainCliAudits(f.stateDir).filter(row => row.peer === "codex" && row.command === label && row.outcome === "run")).toHaveLength(0);
    }
    expect(f.board.get(draft.id)!.draft).toBeFalsy();
  } finally { await f.close(); }
}, 30000);

test("#933: a local conductor form's usage error is refused before the admission, so it leaves no admitted row", async () => {
  const f = await fixture(); try {
    for (const [args, label] of [[["bench", "run", "--arm", "x"], "bench run"], [["research", "backfill", "--unknown"], "research backfill"], [["source", "add", "a", "b"], "source add"]] as [string[], string][]) {
      const result = await cli(f.root, args);
      expect(result.code, label).toBe(1); expect(result.stderr).toMatch(/usage|unknown argument/);
      expect(f.admitted(label), label).toBe(0);
    }
  } finally { await f.close(); }
}, 30000);

test("#933 AC3: the person's forms are still refused in every agent shell, the conductor's included, with the unchanged cause line", async () => {
  expect(classifyPeerCommand("upgrade", ["--to", "1.2.3", "--yes"])).toBe("conductor"); // #900 adds the proof-bound recovery path.
  const f = await fixture(); try {
    for (const args of [["permission", "claude", "never-ask", "--yes"], ["budget", "set", "claude", "1"], ["agents", "trust", "codex-review", "0.165.0"], ["role", "assign", "claude", "backend-engineer"], ["task", "cancel", "1", "--reason", "x", "--as-user"], ["say", "--as-user", "hello"], ["memory", "forget", "x"], ["goal", "new", "a goal"]]) {
      expect(classifyPeerCommand(args[0]!, args.slice(1))).toBe("console");
      const result = await cli(f.root, args);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr.trim()).toBe(`ahub: ${peerCommandRefusal("codex", cliCommandLabel(args[0]!, args.slice(1)), { AGENTHUB_PEER_ID: "codex" })}`);
    }
  } finally { await f.close(); }
}, 30000);

test("#933: Tasks records an admitted conductor as the actor of a GitHub import and refuses any other agent", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-console-933-tasks-"))), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  try {
    let admitted: string | undefined;
    const tasks = new Tasks({ board, bus, cwd: root, project: "fixture", routing: () => loadRouting(root), notify: () => {}, operational: by => by === admitted });
    const page = JSON.stringify([{ number: 7, title: "an issue to import", body: "", url: "https://github.com/owner/repo/issues/7", state: "OPEN" }]);
    const run = async () => ({ code: 0, stdout: page });
    await expect(tasks.importGitHub("codex", { repo: "owner/repo", label: "ready" }, run)).rejects.toThrow("person console");
    admitted = "codex";
    const result = await tasks.importGitHub("codex", { repo: "owner/repo", label: "ready" }, run);
    expect(result.imported).toHaveLength(1);
    expect(board.get(result.imported[0]!)!.history[0]).toMatchObject({ by: "codex" });
    await expect(tasks.importGitHub("claude", { repo: "owner/repo", label: "ready" }, run)).rejects.toThrow("person console");
  } finally { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); }
});
