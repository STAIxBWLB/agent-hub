import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

class Owner extends BasePeer {
  stops = 0;
  async start() { this.setState("idle"); }
  async stop() { this.stops++; this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
  recoveryMetadata() { return { threadId: "retained-native-thread" }; }
}
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-reload-")), stateDir = join(root, ".agenthub", "state"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(hubGitSync(["init", "--quiet", root], { encoding: "utf8" }).status).toBe(0);
  writeFileSync(join(root, ".gitignore"), ".agenthub/\n"); mkdirSync(join(root, ".agenthub"));
  const initial = { instances: { "codex-a": { kind: "codex", roles: ["reviewer"], start_mode: "headless", permission_mode: "ask" } },
    memory: { enabled: false, native: false }, snapshots: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, approvals: { notify: false }, batch_ms: 0 };
  const write = (value: unknown) => writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify(value));
  write(initial);
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0 }); cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); cleanup.push(() => console_.close());
  const owner = new Owner("codex-a"); await owner.start(); daemon.bus.add(owner);
  const status = async () => (await console_.request({ t: "status" })).status;
  const snapshot = async () => console_.request({ t: "ui_snapshot" });
  const reload = async () => {
    const preview = await console_.request({ t: "settings_reload" });
    return preview.confirmation ? console_.request({ t: "settings_reload", confirm: preview.confirmation.token }) : preview;
  };
  return { root, stateDir, initial, write, daemon, console_, owner, status, snapshot, reload };
}

test("I2 live reload defers nested instance defaults and additions without replacing the current owner", async () => {
  const f = await fixture(), before = await f.status(), beforeUi = await f.snapshot();
  expect(before.roleInfo["codex-a"].flowRoles).toEqual(["reviewer"]);
  expect(beforeUi.boardLegend.find((row: any) => row.peer === "codex-a").permissionMode).toBe("ask");
  const priorStart = beforeUi.starts.find((row: any) => row.peer === "codex-a"); expect(priorStart.mode).toBe("headless");
  f.write({ ...f.initial, instances: {
    "codex-a": { ...f.initial.instances["codex-a"], roles: ["implementer"], permission_mode: "never-ask" },
    "codex-b": { kind: "codex", roles: ["reviewer"], start_mode: "headless", permission_mode: "ask" },
  } });
  expect(await f.reload()).toMatchObject({ ok: true });
  const after = await f.status(), afterUi = await f.snapshot();
  expect(after.pendingRestart.some((row: { key: string }) => row.key.startsWith("instances."))).toBe(true);
  expect(after.roleInfo["codex-a"]).toEqual(before.roleInfo["codex-a"]);
  expect(after.taskCapabilities["codex-a"]).toEqual(before.taskCapabilities["codex-a"]);
  expect(afterUi.boardLegend.find((row: any) => row.peer === "codex-a").permissionMode).toBe("ask");
  expect(afterUi.starts.find((row: any) => row.peer === "codex-a")).toEqual(priorStart);
  expect(after.roleInfo["codex-b"]).toBeUndefined(); expect(after.taskCapabilities["codex-b"]).toBeUndefined();
  expect(afterUi.starts.some((row: any) => row.peer === "codex-b")).toBe(false);
  expect((await f.console_.request({ t: "start", peer: "codex-b" })).ok).toBe(false);
  let accepted = false;
  try { const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex-b", projectRoot: f.root }); accepted = true; tools.close(); } catch { /* ordinary external tools admission may fail only for an independent transport error */ }
  // B1: startup-bound native metadata stays absent, while pre-I2 external tool admission remains available.
  expect(accepted).toBe(true);
  expect((await f.console_.request({ t: "watch", peer: "codex-b" })).ok).toBe(false);
  expect(f.daemon.bus.peers.has("codex-b")).toBe(false);
  expect(f.daemon.bus.peers.get("codex-a")).toBe(f.owner); expect(f.owner.state).toBe("idle"); expect(f.owner.stops).toBe(0);
}, 20_000);

test("I2 malformed instance reload refuses the candidate and keeps the last valid live catalog", async () => {
  const f = await fixture(), before = await f.status(), beforeUi = await f.snapshot();
  f.write({ ...f.initial, instances: { ...f.initial.instances, "codex-b": { kind: "not-a-native-kind", roles: ["reviewer"] } } });
  expect(await f.reload()).toMatchObject({ ok: false });
  const after = await f.status(), afterUi = await f.snapshot();
  expect(after.roleInfo).toEqual(before.roleInfo); expect(after.taskCapabilities).toEqual(before.taskCapabilities);
  expect(afterUi.starts).toEqual(beforeUi.starts);
  expect(f.daemon.bus.peers.get("codex-a")).toBe(f.owner); expect(f.owner.stops).toBe(0);
}, 20_000);

test("I2 source refuses a recovery target lacking instance support before holding or replacing live owners", async () => {
  const f = await fixture(), status = await f.status();
  const before = await f.console_.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId });
  const refused = await f.console_.request({ t: "recovery", op: "prepare", operationId: "instance-downgrade-fixture", expectedInstanceId: status.instanceId, targetFeatures: ["task_cancel", "recovery_deferred_hub"] });
  expect(refused.ok).toBe(false); expect(refused.error).toContain("peer_instances");
  expect(f.daemon.bus.isRecoveryHeld).toBe(false);
  const after = await f.console_.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId });
  expect(after.recovery.operationId).toBe(before.recovery.operationId); expect(after.recovery.phase).toBe(before.recovery.phase);
  expect(existsSync(join(f.stateDir, "restart.json"))).toBe(false);
  expect(f.daemon.bus.peers.get("codex-a")).toBe(f.owner); expect(f.owner.stops).toBe(0);
}, 20_000);
