import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { USER } from "../src/hub/envelope.ts";
import { campaignHash, parseResearchCampaign } from "../src/hub/research-campaign.ts";

async function fixture(options: { draft?: boolean; files?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-study-recovery-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    const dir = join(root, key.toLowerCase());
    mkdirSync(dir);
    process.env[key] = dir;
  }
  const configDir = join(root, ".agenthub");
  mkdirSync(configDir);
  for (const [name, body] of Object.entries(options.files ?? {})) writeFileSync(join(configDir, name), JSON.stringify(body), { mode: 0o600 });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { client?.close(); await daemon?.stop(); }
    finally {
      for (const key of envKeys) { const previous = savedEnv[key]; if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
      rmSync(root, { recursive: true, force: true });
    }
  };
  let expectedResearch: ReturnType<Board["researchIntegrity"]> | undefined;
  try {
    if (options.draft) {
      const board = new Board(join(stateDir, "hub.db"));
      try {
        const parent = board.propose(USER, { title: "Research recovery fixture", class: "plan", backlog: true });
        const contract = parseResearchCampaign({ question: "Which observations distinguish the alternatives?", scope: "Isolated recovery fixture", exclusions: [], sourceIds: [],
          units: [{ id: "discovery", round: 0, question: "Collect observations", perspective: "Independent", requiredOutput: "Evidence list", sourceIds: [], dependsOn: [], purpose: "discovery" }],
          deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: "2030-01-01T00:00:00Z" } });
        board.saveResearchCampaignDraft({ id: "rc-000000000001", project: root, parentTaskId: parent.id, revision: 1, status: "draft", contract,
          hash: campaignHash(contract), private: false, createdBy: USER, createdAt: 1 }, undefined, parent.history.length);
        expectedResearch = board.researchIntegrity();
      } finally { board.close(); }
    }
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    return { root, configDir, client, status, expectedResearch, withoutResearch: status.features.filter((feature: string) => feature !== "research_records"), close };
  } catch (error) { await close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, op: string, targetFeatures?: readonly string[]) => f.client.request({ t: "recovery", op, operationId: "research-capability",
  expectedInstanceId: f.status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const inspect = async (f: Fixture) => (await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery;

test("the daemon advertises research_records and leaves empty recovery integrity unchanged", async () => {
  expect(DAEMON_FEATURES).toContain("research_records");
  const f = await fixture();
  try {
    expect(f.status.features).toContain("research_records");
    const reply = await request(f, "inspect", f.withoutResearch);
    expect(reply.ok).toBe(true);
    expect(Object.keys(reply.recovery.integrity.current).sort()).toEqual(["boardDigest", "budgetDigest", "manualPaused", "queues"]);
    expect(await request(f, "prepare", f.withoutResearch)).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("persisted campaign drafts refuse unsupported prepare, commit and target inspect before recovery effects", async () => {
  const f = await fixture({ draft: true });
  try {
    for (const targetFeatures of [undefined, f.withoutResearch, []] as Array<readonly string[] | undefined>) for (const op of ["prepare", "commit"]) {
      expect(await request(f, op, targetFeatures), op).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_records") });
      expect((await inspect(f)).phase).toBeUndefined();
    }
    expect(await request(f, "inspect", f.withoutResearch)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_records") });
    const current = await inspect(f);
    expect(current.phase).toBeUndefined();
    expect(current.integrity.current.research).toEqual(f.expectedResearch);
    expect(current.integrity.current.research).toMatchObject({ campaigns: 1, units: 0, revision: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.keys(current.integrity.current.research).sort()).toEqual(["campaigns", "digest", "revision", "units"]);
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
  } finally { await f.close(); }
}, 20_000);

test("a supporting target prepares a persisted campaign with its research integrity", async () => {
  const f = await fixture({ draft: true });
  try {
    const reply = await request(f, "prepare", f.status.features);
    expect(reply).toMatchObject({ ok: true, recovery: { phase: "prepared", integrity: { current: { research: f.expectedResearch } } } });
  } finally { await f.close(); }
}, 20_000);

for (const file of ["config.json", "config.local.json"]) for (const runners of [{}, false, null, true]) {
  test(`raw ${file} research.runners=${JSON.stringify(runners)} requires research_records even when ignored`, async () => {
    const f = await fixture({ files: { [file]: { research: { enabled: false, runners } } } });
    try {
      for (const op of ["prepare", "commit", "inspect"]) {
        expect(await request(f, op, f.withoutResearch)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_records") });
        expect((await inspect(f)).phase).toBeUndefined();
      }
      expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true });
    } finally { await f.close(); }
  }, 20_000);
}

test("raw research configuration without runners leaves an older target compatible", async () => {
  const f = await fixture({ files: { "config.json": { research: { enabled: false } }, "config.local.json": {} } });
  try { expect(await request(f, "prepare", f.withoutResearch)).toMatchObject({ ok: true }); }
  finally { await f.close(); }
}, 20_000);

for (const raw of ["{", "null", "[]", '{"research":null}']) {
  test(`malformed raw research configuration after startup refuses unknown compatibility: ${raw}`, async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.configDir, "config.local.json"), raw, { mode: 0o600 });
      for (const op of ["prepare", "commit", "inspect"]) expect(await request(f, op, f.withoutResearch)).toMatchObject({ ok: false, error: expect.stringContaining("research_records compatibility is unknown") });
      expect((await inspect(f)).phase).toBeUndefined();
    } finally { await f.close(); }
  }, 20_000);
}

test("an unreadable raw configuration refuses research compatibility instead of treating it as absent", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.configDir, "config.local.json"));
    expect(await request(f, "prepare", f.withoutResearch)).toMatchObject({ ok: false, error: expect.stringContaining("research_records compatibility is unknown") });
    expect((await inspect(f)).phase).toBeUndefined();
  } finally { await f.close(); }
}, 20_000);


test("restart snapshot validation retains valid research integrity and refuses malformed research receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-study-snapshot-"));
  const research = { campaigns: 1, units: 2, revision: 1, digest: "a".repeat(64) };
  const expected = { projectRoot: root, projectId: "study-fixture", operationId: "study-snapshot" };
  const snapshot: RestartSnapshot = { schemaVersion: 1, ...expected, sourceInstanceId: "source", committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
    integrity: { queues: {}, manualPaused: [], boardDigest: "board", budgetDigest: "budget", research } };
  try {
    writeRestartSnapshot(root, snapshot);
    expect(readRestartSnapshot(root, expected)?.integrity?.research).toEqual(research);
    for (const bad of [null, [], { ...research, campaigns: -1 }, { ...research, units: 1.5 }, { ...research, revision: "1" }, { ...research, digest: "not a digest" }]) {
      writeRestartSnapshot(root, { ...snapshot, integrity: { ...snapshot.integrity!, research: bad } } as unknown as RestartSnapshot);
      expect(readRestartSnapshot(root, expected)).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
