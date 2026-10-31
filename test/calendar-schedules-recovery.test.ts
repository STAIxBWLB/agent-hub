import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

// #1017: a project whose `schedules` use `cron` or `tz` cannot be recovered onto a daemon that predates them, because that daemon refuses the key ("cron not supported yet") and the
// project would not load there. Same shape as the action_policy.floor guard (test/action-floor-recovery.test.ts): the raw files decide, not the effective config.
async function fixture(policy: unknown, files: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-floor-recovery-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  if (Object.keys(files).length) { mkdirSync(join(root, ".agenthub")); for (const [name, body] of Object.entries(files)) writeFileSync(join(root, ".agenthub", name), JSON.stringify(body)); }
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
    return { client, status, withoutCalendar: status.features.filter((feature: string) => feature !== "calendar_schedules"), close };
  } catch (error) { await close(); throw error; }
}
const request = (f: Awaited<ReturnType<typeof fixture>>, op: string, targetFeatures?: readonly string[]) =>
  f.client.request({ t: "recovery", op, operationId: "floor-capability", expectedInstanceId: f.status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const phase = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery.phase;


const entry = (patch: Record<string, unknown>) => ({ id: "d", class: "plan", title: "t", ...patch });
const CRON = entry({ cron: "30 7 * * 1-5", tz: "Asia/Seoul" });

test("the daemon advertises calendar_schedules", async () => {
  expect(DAEMON_FEATURES).toContain("calendar_schedules");
  const f = await fixture(undefined);
  try { expect(f.status.features).toContain("calendar_schedules"); } finally { await f.close(); }
}, 20_000);

test("a project with a cron or tz schedule refuses a target without the feature before every recovery effect", async () => {
  const f = await fixture(undefined, { "config.local.json": { schedules: [CRON] } });
  try {
    for (const targetFeatures of [undefined, f.withoutCalendar, []] as Array<readonly string[] | undefined>) for (const op of ["prepare", "commit"]) {
      expect(await request(f, op, targetFeatures), `${op} ${JSON.stringify(targetFeatures)?.slice(0, 20)}`).toMatchObject({ ok: false, error: expect.stringContaining("target lacks calendar_schedules") });
      expect(await phase(f)).toBeUndefined();
    }
    expect(await request(f, "inspect", f.withoutCalendar)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks calendar_schedules") });
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
  } finally { await f.close(); }
}, 20_000);

test("a target that has the feature is accepted for a cron project", async () => {
  const f = await fixture(undefined, { "config.local.json": { schedules: [CRON] } });
  try {
    const reply = await request(f, "prepare", f.status.features);
    expect(reply.error ?? "").not.toContain("calendar_schedules");
    expect(reply).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("the raw files decide: a tz key, or a cron entry in the shared config.json, also refuses an older target", async () => {
  for (const [name, files] of [["tz only in local", { "config.local.json": { schedules: [entry({ every: "1h", tz: "UTC" })] } }], ["cron in the shared file", { "config.json": { schedules: [CRON] } }]] as Array<[string, Record<string, unknown>]>) {
    // Neither loads as an effective schedule (a bad tz entry, or a machine-local key set in a committed file), yet an older parser meets the raw key.
    const f = await fixture(undefined, files);
    try { expect(await request(f, "inspect", f.withoutCalendar), name).toMatchObject({ ok: false, error: expect.stringContaining("target lacks calendar_schedules") }); }
    finally { await f.close(); }
  }
}, 20_000);

test("an every-only project leaves an older target allowed", async () => {
  for (const files of [{}, { "config.local.json": { schedules: [entry({ every: "1h" })] } }, { "config.local.json": { schedules: [] } }] as Array<Record<string, unknown>>) {
    const f = await fixture(undefined, files);
    try { expect((await request(f, "inspect", f.withoutCalendar)).error ?? "", JSON.stringify(files)).not.toContain("calendar_schedules"); }
    finally { await f.close(); }
  }
}, 20_000);
