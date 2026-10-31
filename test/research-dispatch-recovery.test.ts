import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { USER } from "../src/hub/envelope.ts";
import { campaignHash, parseResearchCampaign, type ResearchHandoff } from "../src/hub/research-campaign.ts";

// #597: research dispatch is its own recovery floor, additive to the base `research_records` one, and handoffs are part of the recovery integrity.
async function fixture(seed?: (board: Board) => void) {
  const root = mkdtempSync(join(tmpdir(), "ahub-dispatch-recovery-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { const dir = join(root, key.toLowerCase()); mkdirSync(dir); process.env[key] = dir; }
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { client?.close(); await daemon?.stop(); }
    finally { for (const key of envKeys) { const previous = saved[key]; if (previous === undefined) delete process.env[key]; else process.env[key] = previous; } rmSync(root, { recursive: true, force: true }); }
  };
  let research: ReturnType<Board["researchIntegrity"]> | undefined;
  try {
    if (seed) { const board = new Board(join(stateDir, "hub.db")); try { seed(board); research = board.researchIntegrity(); } finally { board.close(); } }
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    return { root, client, status, research, close, without: (feature: string) => status.features.filter((name: string) => name !== feature) };
  } catch (error) { await close(); throw error; }
}
type F = Awaited<ReturnType<typeof fixture>>;
const request = (f: F, op: string, targetFeatures?: readonly string[]) => f.client.request({ t: "recovery", op, operationId: "dispatch-capability", expectedInstanceId: f.status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const phase = async (f: F) => (await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery;

const contract = () => parseResearchCampaign({ question: "Which observations distinguish the alternatives?", scope: "Isolated recovery fixture", exclusions: [], sourceIds: [],
  units: [{ id: "discovery", round: 0, question: "Collect observations", perspective: "Independent", requiredOutput: "Evidence list", sourceIds: [], dependsOn: [], purpose: "discovery" }],
  deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: "2030-01-01T00:00:00Z" } });
const seedDraft = (board: Board) => {
  const parent = board.propose(USER, { title: "Research recovery fixture", class: "plan", backlog: true }), body = contract();
  board.saveResearchCampaignDraft({ id: "rc-000000000001", project: "x", parentTaskId: parent.id, revision: 1, status: "draft", contract: body, hash: campaignHash(body), private: false, createdBy: USER, createdAt: 1 }, undefined, parent.history.length);
};

test("the daemon advertises research_dispatch beside research_records", async () => {
  expect(DAEMON_FEATURES).toContain("research_dispatch"); expect(DAEMON_FEATURES).toContain("research_records");
  const f = await fixture();
  try { expect(f.status.features).toEqual(expect.arrayContaining(["research_dispatch", "research_records"])); } finally { await f.close(); }
}, 20_000);

test("a project with stored research refuses a target that has the base storage but not dispatch, before any recovery effect", async () => {
  const f = await fixture(seedDraft);
  try {
    const withoutDispatch = f.without("research_dispatch");
    expect(withoutDispatch).toContain("research_records");                 // the exact case: base storage present, dispatch absent
    for (const op of ["prepare", "commit"]) {
      expect(await request(f, op, withoutDispatch), op).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_dispatch") });
      expect((await phase(f)).phase).toBeUndefined();
    }
    expect(await request(f, "inspect", withoutDispatch)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_dispatch") });
    // the base floor is separate and still enforced: dispatch without storage is refused for the storage
    expect(await request(f, "prepare", f.without("research_records"))).toMatchObject({ ok: false, error: expect.stringContaining("target lacks research_records") });
    expect((await f.client.request({ t: "status" })).status.instanceId).toBe(f.status.instanceId);
    expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("a project with no research state leaves a target without research_dispatch allowed", async () => {
  const f = await fixture();
  try { expect(await request(f, "prepare", f.without("research_dispatch"))).toMatchObject({ ok: true }); } finally { await f.close(); }
}, 20_000);

test("a stored handoff is research state and joins the recovery integrity, and an idle campaign keeps its old digest", async () => {
  const none = await fixture(seedDraft);
  let handoffs: ReturnType<Board["researchIntegrity"]> | undefined;
  try {
    const current = (await phase(none)).integrity.current.research;
    expect(current).toEqual(none.research); expect(Object.keys(current).sort()).toEqual(["campaigns", "digest", "revision", "units"]);   // no handoffs: the shape it had before this slice
  } finally { await none.close(); }
  const f = await fixture(board => {
    seedDraft(board);
    const db = (board as unknown as { db: import("bun:sqlite").Database }).db;
    const body: ResearchHandoff = { campaignId: "rc-000000000001", revision: 1, unitId: "discovery", taskId: 1, evidence: [], unresolved: [], contradictions: [], limitations: [] };
    db.query("INSERT INTO research_handoffs(campaign_id,unit_id,seq,task_id,body,by,at) VALUES(?,?,?,?,?,?,?)").run(body.campaignId, body.unitId, 1, 1, JSON.stringify(body), "local", 5);
  });
  try {
    handoffs = f.research;
    expect(handoffs).toMatchObject({ campaigns: 1, handoffs: 1 });
    const current = (await phase(f)).integrity.current.research;
    expect(current).toEqual(handoffs);
    expect(current.digest).not.toBe(((): string => { const board = new Board(join(f.root, "x.db")); try { seedDraft(board); return board.researchIntegrity().digest; } finally { board.close(); } })());
    expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true, recovery: { phase: "prepared", integrity: { current: { research: handoffs } } } });
  } finally { await f.close(); }
}, 20_000);

test("restart snapshot validation retains a handoff count and refuses a malformed one or an unknown research key", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-dispatch-snapshot-"));
  const research = { campaigns: 1, units: 2, revision: 1, digest: "a".repeat(64), handoffs: 3 };
  const expected = { projectRoot: root, projectId: "dispatch-fixture", operationId: "dispatch-snapshot" };
  const snapshot: RestartSnapshot = { schemaVersion: 1, ...expected, sourceInstanceId: "source", committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
    integrity: { queues: {}, manualPaused: [], boardDigest: "board", budgetDigest: "budget", research } };
  try {
    writeRestartSnapshot(root, snapshot);
    expect(readRestartSnapshot(root, expected)?.integrity?.research).toEqual(research);
    for (const bad of [{ ...research, handoffs: 0 }, { ...research, handoffs: -1 }, { ...research, handoffs: 1.5 }, { ...research, handoffs: "3" }, { ...research, extra: 1 }]) {
      writeRestartSnapshot(root, { ...snapshot, integrity: { ...snapshot.integrity!, research: bad } } as unknown as RestartSnapshot);
      expect(readRestartSnapshot(root, expected), JSON.stringify(bad)).toBeUndefined();
    }
    const { handoffs: _omitted, ...before } = research;
    writeRestartSnapshot(root, { ...snapshot, integrity: { ...snapshot.integrity!, research: before } });
    expect(readRestartSnapshot(root, expected)?.integrity?.research).toEqual(before);   // the shape of an older snapshot still reads
  } finally { rmSync(root, { recursive: true, force: true }); }
});
