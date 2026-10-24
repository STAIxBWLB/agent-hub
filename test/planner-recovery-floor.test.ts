import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";

type Evidence = "task" | "release" | "plan-author-null" | "self-review" | "history-plan-author-null" | "history-self-review" | "legacy-null";
function seed(file: string, evidence: Evidence): void {
  const board = new Board(file);
  try {
    if (evidence === "release") { board.newRelease("fixture", "fixture", 0, "claude"); return; }
    const task = board.propose("user", { title: "fixture authority evidence", class: "test", ...(evidence === "task" ? { planner: "claude", plannerReason: "named" as const } : {}) });
    if (evidence === "task") return;
    if (evidence === "history-plan-author-null" || evidence === "history-self-review") {
      board.update(task.id, "claude", "plan reviewed", {}, undefined, evidence === "history-plan-author-null" ? { planAuthor: null } : { selfReview: true });
      return;
    }
    const receipt = { planner: "claude", planningRevision: 0, recordedAt: 1, ...(evidence === "plan-author-null" ? { planAuthor: null } : evidence === "self-review" ? { selfReview: false } : {}) };
    const db = new Database(file);
    try { db.query("UPDATE tasks SET sdlc=? WHERE id=?").run(JSON.stringify({ stage: "plan", planReview: receipt }), task.id); }
    finally { db.close(); }
    if (evidence === "legacy-null") board.newRelease("legacy", "fixture", 0);
  } finally { board.close(); }
}

async function fixture(options: { planner?: HubConfig["planner"]; instance?: boolean; evidence?: Evidence } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-planner-recovery-floor-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  if (options.evidence) seed(join(stateDir, "hub.db"), options.evidence);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => { client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); };
  try {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, ...(options.planner !== undefined ? { planner: options.planner } : {}),
        ...(options.instance ? { instances: { "codex-floor": { kind: "codex", roles: ["implementer"] } } } : {}),
        roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
        approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    const withoutFloor = status.features.filter((feature: string) => feature !== "role_stages");
    return { client, status, withoutFloor, close };
  } catch (error) { await close(); throw error; }
}

const cases: Array<{ name: string; planner?: HubConfig["planner"]; instance?: boolean; evidence?: Evidence }> = [
  { name: "planner list", planner: ["claude", "codex"] },
  { name: "singleton raw planner list", planner: ["claude"] },
  { name: "named capable instance", planner: "codex-floor", instance: true },
  ...(["task", "release", "plan-author-null", "self-review", "history-plan-author-null", "history-self-review"] as Evidence[]).map(evidence => ({ name: `persisted ${evidence}`, evidence })),
];
for (const input of cases) test(`#525 R3 ${input.name} requires role_stages before every recovery effect`, async () => {
  const f = await fixture(input);
  try {
    expect(DAEMON_FEATURES).toContain("role_stages");
    expect(f.status.features).toContain("role_stages");
    const message = { t: "recovery", operationId: "planner-floor", expectedInstanceId: f.status.instanceId };
    for (const op of ["inspect", "prepare", "commit"]) {
      expect(await f.client.request({ ...message, op, targetFeatures: f.withoutFloor })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks role_stages") });
      expect((await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery.phase).toBeUndefined();
    }
    // A compatible target may prepare, but may not downgrade before its next effect. No compatible commit is sent.
    expect(await f.client.request({ ...message, op: "prepare", targetFeatures: f.status.features })).toMatchObject({ ok: true });
    expect(await f.client.request({ ...message, op: "commit", targetFeatures: f.withoutFloor })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks role_stages") });
    expect(await f.client.request({ ...message, op: "abort" })).toMatchObject({ ok: true });
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
  } finally { await f.close(); }
}, 20_000);

for (const input of [{ name: "ordinary default" }, { name: "legacy nullable task/release and old receipt", evidence: "legacy-null" as const }]) test(`#525 R3 ${input.name} does not acquire a planner recovery floor`, async () => {
  const f = await fixture(input);
  try {
    const message = { t: "recovery", operationId: "legacy-planner-floor", expectedInstanceId: f.status.instanceId };
    expect(await f.client.request({ ...message, op: "prepare", targetFeatures: f.withoutFloor })).toMatchObject({ ok: true });
    expect(await f.client.request({ ...message, op: "abort" })).toMatchObject({ ok: true });
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
  } finally { await f.close(); }
}, 20_000);

test("#525 R3 a published 0.15.0 role_stages claim cannot restore task planner authority", async () => {
  // Frozen from v0.15.0: role_stages covered the earlier headless implementation slice, not task-bound planners.
  const oldFeatures = ["external_adapter_modules", "configured_acp", "native_hook_launch", "task_cancel", "recovery_deferred_hub", "peer_instances", "role_stages", "release_trains", "reviewer_pool", "native_tui_launch", "terminal_owner", "cli_audit_delegated"];
  const f = await fixture({ evidence: "task" });
  try {
    expect(oldFeatures).toContain("role_stages");
    const result = await f.client.request({ t: "recovery", op: "inspect", operationId: "old-planner-target", expectedInstanceId: f.status.instanceId, targetFeatures: oldFeatures });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("planner");
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
  } finally { await f.close(); }
}, 20_000);
