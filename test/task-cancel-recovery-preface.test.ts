import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { writeRestartSnapshot } from "../src/hub/restart.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("controlled recovery task preface excludes cancelled owners and reviewers while retaining actual open work (#438)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-cancel-preface-")), stateDir = join(root, "state");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // Fixture rows represent the board captured by a completed source-side recovery commit.
  mkdirSync(stateDir, { recursive: true });
  const board = new Board(join(stateDir, "hub.db"));
  const owner = board.propose("user", { title: "CANCELLED_OWNER_FIXTURE", class: "implement" });
  board.update(owner.id, "user", "assigned", { owner: "local" });
  board.update(owner.id, "user", "cancelled", { state: "cancelled", cancelled: { reason: "superseded fixture", flowRevision: 3 } });
  const reviewer = board.propose("user", { title: "CANCELLED_REVIEWER_FIXTURE", class: "implement" });
  board.update(reviewer.id, "user", "assigned", { owner: "codex", reviewer: "local" });
  board.update(reviewer.id, "user", "cancelled", { state: "cancelled", cancelled: { reason: "superseded fixture", flowRevision: 3 } });
  const open = board.propose("user", { title: "OPEN_TASK_FIXTURE", class: "implement" }); board.update(open.id, "user", "assigned", { owner: "local" }); board.close();
  writeRestartSnapshot(stateDir, { schemaVersion: 1, projectRoot: root, projectId: "cancel-preface", sourceInstanceId: "source", operationId: "preface-op", committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: { local: [] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [], manualPaused: ["local"] }, manualPaused: ["local"], peers: [{ id: "local", state: "paused", queueIds: [] }] });
  const previous = process.env.AGENTHUB_RECOVERY_OPERATION; let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    process.env.AGENTHUB_RECOVERY_OPERATION = "preface-op";
    daemon = await startDaemon({ cwd: root, stateDir, projectId: "cancel-preface", instanceId: "target", boundedTools: emulatedBoundedTools(), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
  } finally { if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previous; }
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "start", peer: "local", args: { model: "m" }, operationId: "preface-op" })).ok).toBe(true);
  const context = daemon.bus.snapshot(false).prefaces.local?.body ?? "";
  expect(context).toContain("Controlled restart restored your open task context"); expect(context).toContain("OPEN_TASK_FIXTURE");
  expect(context).not.toContain("CANCELLED_OWNER_FIXTURE"); expect(context).not.toContain("CANCELLED_REVIEWER_FIXTURE");
  expect(daemon.bus.isPaused("local")).toBe(true); expect(daemon.bus.queued("local")).toBe(0);
});
