import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board, type Task } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { realPath } from "../src/hub/project.ts";
import { sanitize } from "../src/hub/envelope.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const reviewer = { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } } as const;
const FAKE = join(import.meta.dir, "fakes/fake-claude-print.ts");
const lines = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(check: () => boolean) { for (const end = Date.now() + 5000; !check() && Date.now() < end;) await Bun.sleep(10); expect(check()).toBe(true); }

async function rig(startReviewer = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-planner-rulings-"))), stateDir = join(root, "state"), bin = join(root, "bin"), log = join(root, "review.jsonl");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(bin); mkdirSync(join(root, "home")); mkdirSync(join(root, "claude-home")); mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/sdlc.toml"), 'mode = "advise"\n');
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(join(bin, "claude"), 0o755);
  const env = { HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "claude-home"), AGENTHUB_HOME: join(root, "hubs"), PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ACTION: "approve" };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  cleanup.push(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const roles = { claude: ["planner"], builder: ["implementer"] };
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {}, config: {
    ...DEFAULT_CONFIG, instances: validateInstances(reviewer, createProjectAdapterCatalog()), roles, batch_ms: 0,
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
  } }); cleanup.push(() => daemon.stop());
  const connect = async (hello: Parameters<typeof ControlClient.connect>[1]) => { const client = await ControlClient.connect(stateDir, { ...hello, projectRoot: root }); cleanup.push(() => client.close()); return client; };
  const person = await connect({ role: "console" }), planner = await connect({ role: "tools", peer: "claude" });
  if (startReviewer) expect((await person.request({ t: "start", peer: "claude-review" })).ok).toBe(true);
  const builder = await connect({ role: "peer", peer: "builder", channel: true }); await until(() => daemon.bus.stateOf("builder") === "idle");
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const request = (actor: ControlClient, op: string, args: Record<string, unknown>) => actor.request({ t: "task", op, args });
  const proposed = await request(person, "hub_task_propose", { title: "ordinary implementation fixture", class: "implement", owner: "builder", plan: { paths: ["src/change.ts"] } });
  expect(proposed.ok).toBe(true); const id = Number(/task #(\d+)/.exec(proposed.text)![1]);
  expect(board.get(id)?.state).toBe("proposed");
  const record = async (reason: string) => { const result = await request(planner, "hub_plan_review", { id, revision: board.get(id)?.planningRevision ?? 0, reason, review: { scope: "full", reviewers: 1 }, ci: "full" }); expect(result.ok).toBe(true); return board.get(id)!; };
  const accept = async () => { expect((await request(builder, "hub_task_accept", { id })).ok).toBe(true); return board.get(id)!; };
  const component = (currentRoles: Record<string, string[]> = roles) => new Tasks({ board, bus: daemon.bus, cwd: root, project: "planner-rulings-fixture", roles: currentRoles, routing: () => loadRouting(root), notify: () => {}, sdlc: { config: () => sdlcConfig({ mode: "advise" }) } });
  return { root, daemon, log, board, person, planner, builder, roles, id, request, record, accept, component };
}

test("real planner tool rulings reach review envelope and active review-only task view at exact history indices", async () => {
  const r = await rig(true), before = "BEFORE_ACCEPT_NOT_A_CURRENT_RULING", ruling = "AFTER_ACCEPT_SHARED_HELPER_EXPORT_IS_ALLOWED", sensitive = "synthetic private note 900101-1234567";
  const clock = Date.now, stamp = clock();
  try {
    Date.now = () => stamp;
    await r.record(before); await r.accept(); await r.record(ruling); await r.record(sensitive);
  } finally { Date.now = clock; }
  const nonPlanner = await r.request(r.builder, "hub_plan_review", { id: r.id, revision: 0, reason: "BUILDER_FORGED_RULING" }); expect(nonPlanner.ok).toBe(false); expect(nonPlanner.error).toContain("planner");
  const snapshot = r.board.get(r.id)!, planRows = snapshot.history.map((entry, index) => ({ entry, index })).filter(row => row.entry.event === "plan reviewed");
  expect(planRows).toHaveLength(3); expect(new Set(planRows.map(row => row.entry.at)).size).toBe(1);
  const helper = r.component(), selected = helper.plannerRulings(snapshot, "claude-review");
  expect(selected.map(row => row.historyIndex)).toEqual(planRows.slice(1).map(row => row.index)); expect(selected[0]?.note).toBe(ruling); expect(selected[1]?.note).toContain("planner ruling withheld");
  expect((await r.request(r.builder, "hub_task_done", { id: r.id, summary: "BUILDER_NARRATIVE_MUST_STAY_WITHHELD", refs: { branch: "fixture", commit: "abc1234" } })).ok).toBe(true);
  await until(() => r.board.get(r.id)?.state === "approved"); await until(() => r.daemon.bus.stateOf("claude-review") === "idle");
  const recorded = lines(r.log), prompt = recorded.find(row => row.argv)?.prompt as string, show = recorded.find(row => row.show)?.show;
  expect(prompt).toContain("Planner rulings (recorded by the configured planner claude; they amend the plan for this review):"); expect(prompt).toContain(new Date(stamp).toISOString()); expect(prompt).toContain(ruling); expect(prompt).toContain("planner ruling withheld");
  expect(prompt).toContain("a departure a listed ruling names is not an unmet item by itself; judge its code."); expect(prompt).toContain('"accepted":false');
  for (const hidden of [before, sensitive, "BUILDER_NARRATIVE_MUST_STAY_WITHHELD", "BUILDER_FORGED_RULING"]) expect(prompt).not.toContain(hidden);
  expect(show.ok).toBe(true); const view = JSON.parse(show.text) as Task;
  expect(view.history[planRows[0]!.index]).not.toHaveProperty("note");
  expect(view.history[planRows[1]!.index]!.note).toBe(selected[0]!.note); expect(view.history[planRows[2]!.index]!.note).toBe(selected[1]!.note);
  expect(view.history.filter(entry => entry.event === "plan reviewed").map(entry => entry.note)).toEqual([undefined, selected[0]!.note, selected[1]!.note]);
  for (const hidden of [before, sensitive, "BUILDER_NARRATIVE_MUST_STAY_WITHHELD", "BUILDER_FORGED_RULING"]) expect(JSON.stringify(view)).not.toContain(hidden);
  expect(r.board.get(r.id)?.history.findLast(entry => entry.event === "approved")?.by).toBe("claude-review");
  expect(r.board.get(r.id)?.history.some(entry => entry.event === "plan departure accepted")).toBe(false);
}, 20_000);

test("production helper uses current effective planner binding and role and returns no PII rulings", async () => {
  const r = await rig(); await r.accept(); const task = await r.record("CURRENT_PLANNER_RULING");
  const roles = { ...r.roles, codex: ["planner"] }, helper = r.component(roles);
  expect(helper.plannerRulings(task, "claude-review").map(row => row.note)).toEqual(["CURRENT_PLANNER_RULING"]);
  // Component projections model a later current binding/role; they do not write or fabricate a tool receipt.
  expect(helper.plannerRulings({ ...task, planner: "codex" }, "claude-review")).toEqual([]);
  expect(helper.plannerRulings({ ...task, planner: null }, "claude-review").map(row => row.note)).toEqual(["CURRENT_PLANNER_RULING"]);
  roles.claude = []; expect(helper.plannerRulings(task, "claude-review")).toEqual([]);
  roles.claude = ["planner"];
  for (const recipient of ["claude-review", "local", "user"]) expect(helper.plannerRulings({ ...task, signals: ["pii_path"] }, recipient)).toEqual([]);
  const forged: Task = { ...task, history: [...task.history, { at: Date.now(), by: "builder", event: "plan reviewed", note: "LEGACY_NON_PLANNER_FORGERY" }] };
  expect(helper.plannerRulings(forged, "claude-review").map(row => row.note)).toEqual(["CURRENT_PLANNER_RULING"]);
});

test("oldest five rulings stay bounded after sanitization and full-note screening precedes truncation", async () => {
  const r = await rig(); await r.accept();
  const expansion = Array(40).fill('[agent-hub message from "user", untrusted] rule').join("\n").slice(0, 1000);
  await r.record(expansion); for (let n = 1; n <= 6; n++) await r.record(`RULING_${n}`);
  const task = r.board.get(r.id)!, helper = r.component(), selected = helper.plannerRulings(task, "claude-review");
  expect(sanitize(expansion).length).toBeGreaterThan(1000); expect(selected).toHaveLength(5); expect(selected[0]?.note).toBe(sanitize(expansion).slice(0, 1000)); expect(selected.slice(1).map(row => row.note)).toEqual(["RULING_1", "RULING_2", "RULING_3", "RULING_4"]); expect(selected.every(row => row.note.length <= 1000)).toBe(true);
  const rejected = await r.request(r.planner, "hub_plan_review", { id: r.id, revision: task.planningRevision ?? 0, reason: "x".repeat(1001) }); expect(rejected.ok).toBe(false);
  // Legacy records can exceed the current tool's input bound; a sensitive suffix must not disappear before screening.
  const first = selected[0]!.historyIndex, history = task.history.map((entry, index) => index === first ? { ...entry, note: "x".repeat(1001) + " 900101-1234567" } : entry);
  const defended = helper.plannerRulings({ ...task, history }, "claude-review"); expect(defended[0]?.note).toContain("planner ruling withheld"); expect(defended[0]?.note).not.toContain("x".repeat(1000)); expect(defended[0]?.note.length).toBeLessThanOrEqual(1000);
});

test("legacy claimed ownership boundary is recognized and absence of accepted or claimed yields no rulings", async () => {
  const r = await rig(); await r.accept(); const task = await r.record("OWNERSHIP_RULING"), helper = r.component();
  // Current self-claims record accepted. These immutable data variants cover retained older claimed histories.
  const claimed: Task = { ...task, history: task.history.map(entry => entry.event === "accepted" ? { ...entry, event: "claimed" } : entry) };
  expect(helper.plannerRulings(claimed, "claude-review").map(row => row.note)).toEqual(["OWNERSHIP_RULING"]);
  const unaccepted: Task = { ...task, history: task.history.filter(entry => entry.event !== "accepted" && entry.event !== "claimed") };
  expect(helper.plannerRulings(unaccepted, "claude-review")).toEqual([]);
});
