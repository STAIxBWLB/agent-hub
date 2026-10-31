import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

// #999 T3: a project that sets `action_policy.floor` cannot be recovered onto a daemon that predates the key, because that daemon rejects the unknown key and the project would
// not load there. Codex raised it on #582: #581's project_autonomy gate covers the preset's metadata, not this independently writable field.
async function fixture(policy: unknown) {
  const root = mkdtempSync(join(tmpdir(), "ahub-floor-recovery-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => { client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); };
  try {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, ...(policy === undefined ? {} : { action_policy: policy as never }), roster: {}, batch_ms: 0,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    return { client, status, withoutFloor: status.features.filter((feature: string) => feature !== "action_policy_floor"), close };
  } catch (error) { await close(); throw error; }
}
const request = (f: Awaited<ReturnType<typeof fixture>>, op: string, targetFeatures?: readonly string[]) =>
  f.client.request({ t: "recovery", op, operationId: "floor-capability", expectedInstanceId: f.status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const phase = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery.phase;

test("the daemon advertises action_policy_floor", async () => {
  expect(DAEMON_FEATURES).toContain("action_policy_floor");
  const f = await fixture(undefined);
  try { expect(f.status.features).toContain("action_policy_floor"); } finally { await f.close(); }
}, 20_000);

test("a project that sets action_policy.floor refuses a target without the feature before every recovery effect", async () => {
  const f = await fixture({ floor: true });
  try {
    for (const targetFeatures of [undefined, f.withoutFloor, []] as Array<readonly string[] | undefined>) for (const op of ["prepare", "commit"]) {
      expect(await request(f, op, targetFeatures), `${op} ${JSON.stringify(targetFeatures)?.slice(0, 20)}`).toMatchObject({ ok: false, error: expect.stringContaining("target lacks action_policy_floor") });
      expect(await phase(f)).toBeUndefined();
    }
    expect(await request(f, "inspect", f.withoutFloor)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks action_policy_floor") });
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
  } finally { await f.close(); }
}, 20_000);

test("a target that has the feature is accepted for a floor project", async () => {
  const f = await fixture({ floor: true });
  try {
    const reply = await request(f, "prepare", f.status.features);
    expect(reply.error ?? "").not.toContain("action_policy_floor");
    expect(reply).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("a floor policy that names the key at all refuses a target without the feature, true or false, enabled or not", async () => {
  for (const policy of [{ floor: false }, { floor: false, enabled: false }, { floor: true }]) {
    const f = await fixture(policy);
    try { expect(await request(f, "inspect", f.withoutFloor), JSON.stringify(policy)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks action_policy_floor") }); }
    finally { await f.close(); }
  }
}, 40_000);

test("without the key no target needs the feature: absent and unrelated policies are unchanged", async () => {
  for (const policy of [undefined, {}, { budgets: { publish: 2 } }, { enabled: false }]) {
    const f = await fixture(policy);
    try {
      const reply = await request(f, "inspect", f.withoutFloor);
      expect(reply.error ?? "", JSON.stringify(policy)).not.toContain("action_policy_floor");
    } finally { await f.close(); }
  }
}, 40_000);

test("a disabled policy that still names the floor is judged as written: the older target would reject the key", async () => {
  const f = await fixture({ floor: true, enabled: false });
  try { expect(await request(f, "inspect", f.withoutFloor)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks action_policy_floor") }); }
  finally { await f.close(); }
}, 20_000);
