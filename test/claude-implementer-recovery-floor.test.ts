import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import type { InstancesConfig } from "../src/hub/instances.ts";

async function fixture(form: "implementer" | "implementer-verifier" | "reviewer" | "ordinary" | "terminal" | "terminal-verifier") {
  const root = mkdtempSync(join(tmpdir(), "ahub-claude-recovery-floor-")), stateDir = join(root, "state");
  const instances: InstancesConfig | undefined = form === "ordinary" ? undefined : {
    "claude-floor": form === "reviewer" ? { kind: "claude", roles: ["reviewer"], start_mode: "headless" }
      : { kind: "claude", roles: (form === "implementer-verifier" || form === "terminal-verifier") ? ["implementer", "verifier"] : ["implementer"], ...((form === "implementer" || form === "implementer-verifier") ? { start_mode: "headless" as const } : {}), worktree: ".worktrees/claude-floor" },
  };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  try {
    // Recovery feature compatibility depends on the startup declaration even while the peer is offline.
    // This fixture never starts a native agent or resolves/creates its execution worktree.
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, ...(instances ? { instances } : {}), roster: {}, batch_ms: 0,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    const withoutFloor = status.features.filter((feature: string) => feature !== "role_stages");
    return { client, status, withoutFloor, async close() { client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); throw error; }
}

for (const form of ["implementer", "implementer-verifier", "terminal", "terminal-verifier"] as const) test(`#525 declared Claude ${form} advertises and requires role_stages before every recovery target effect`, async () => {
  const f = await fixture(form);
  try {
    expect(DAEMON_FEATURES).toContain("role_stages");
    expect(f.status.features).toContain("role_stages");
    const message = { t: "recovery", operationId: "implementer-floor", expectedInstanceId: f.status.instanceId };
    for (const op of ["inspect", "prepare", "commit"]) {
      expect(await f.client.request({ ...message, op, targetFeatures: f.withoutFloor })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks role_stages") });
      expect((await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery.phase).toBeUndefined();
    }
    expect(await f.client.request({ ...message, op: "prepare", targetFeatures: f.status.features })).toMatchObject({ ok: true });
    // A later downgrade is rechecked even after a compatible prepare established the recovery operation.
    expect(await f.client.request({ ...message, op: "commit", targetFeatures: f.withoutFloor })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks role_stages") });
    expect(await f.client.request({ ...message, op: "abort" })).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

for (const form of ["ordinary", "reviewer"] as const) test(`#525 ${form} Claude compatibility does not acquire the declared implementer recovery floor`, async () => {
  const f = await fixture(form);
  try {
    expect(await f.client.request({ t: "recovery", op: "prepare", operationId: `${form}-floor`, expectedInstanceId: f.status.instanceId, targetFeatures: f.withoutFloor })).toMatchObject({ ok: true });
    expect(await f.client.request({ t: "recovery", op: "abort", operationId: `${form}-floor`, expectedInstanceId: f.status.instanceId })).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);
