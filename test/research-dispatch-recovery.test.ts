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

async function fixture(options: { draft?: boolean; approved?: boolean; dropped?: boolean; files?: Record<string, unknown> } = {}) {
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
  let expectedResearch: ReturnType<Board["researchIntegrity"]> | undefined, expectedDispatch: ReturnType<Board["researchDispatchIntegrity"]> | undefined;
  try {
    if (options.draft || options.approved) {
      const board = new Board(join(stateDir, "hub.db"));
      try {
        const parent = board.propose(USER, { title: "Research recovery fixture", class: "plan", backlog: true });
        const contract = parseResearchCampaign({ question: "Which observations distinguish the alternatives?", scope: "Isolated recovery fixture", exclusions: [], sourceIds: [],
          units: [{ id: "discovery", round: 0, question: "Collect observations", perspective: "Independent", requiredOutput: "Evidence list", sourceIds: [], dependsOn: [], purpose: "discovery" }],
          deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: "2030-01-01T00:00:00Z" } });
        board.saveResearchCampaignDraft({ id: "rc-000000000001", project: root, parentTaskId: parent.id, revision: 1, status: "draft", contract,
          hash: campaignHash(contract), private: false, createdBy: USER, createdAt: 1 }, undefined, parent.history.length);
        if (options.approved) {
          const activated = board.activateCampaign("rc-000000000001", 1, root, USER, 2, [{ unitId: "discovery", create: { title: "Study unit discovery", class: "implement", signals: [] } }], board.get(parent.id)!.history.length, false, { eligibleOwners: undefined });
          if (options.dropped) board.recordResearchDroppedOffer(activated.bindings[0]!.taskId, "local");
        }
        expectedResearch = board.researchIntegrity();
        expectedDispatch = board.researchDispatchIntegrity();
      } finally { board.close(); }
    }
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0,
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    return { root, configDir, client, status, expectedResearch, expectedDispatch, withoutResearch: status.features.filter((feature: string) => feature !== "research_dispatch"), close };
  } catch (error) { await close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, op: string, targetFeatures?: readonly string[]) => f.client.request({ t: "recovery", op, operationId: "research-capability",
  expectedInstanceId: f.status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const inspect = async (f: Fixture) => (await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery;

test("research_dispatch is advertised but an empty legacy project remains recoverable", async () => {
  expect(DAEMON_FEATURES).toContain("research_dispatch");
  const f = await fixture();
  try { expect(await request(f,"prepare",f.withoutResearch)).toMatchObject({ok:true}); }
  finally { await f.close(); }
},20_000);

test("even a pre-dispatch campaign refuses an older target before prepare, commit or target inspect effects", async () => {
  const f=await fixture({draft:true});
  try {
    expect(f.withoutResearch).toContain("research_records");
    for (const op of ["prepare","commit","inspect"]) {
      expect(await request(f,op,f.withoutResearch)).toMatchObject({ok:false,error:expect.stringContaining("research_dispatch")});
      expect((await inspect(f)).phase).toBeUndefined();
    }
    expect(await request(f,"prepare",f.status.features)).toMatchObject({ok:true});
  } finally { await f.close(); }
},20_000);

test("a persisted dropped study offer is part of the dispatch integrity a real daemon reports for recovery", async () => {
  const plain = await fixture({ approved: true });
  let withoutRow: string;
  try { await request(plain, "prepare", plain.status.features); withoutRow = (await inspect(plain)).integrity.current.researchDispatch.digest; expect(plain.expectedDispatch!.digest).toBe(withoutRow); }
  finally { await plain.close(); }
  const f = await fixture({ approved: true, dropped: true });
  try {
    await request(f, "prepare", f.status.features);
    const current = (await inspect(f)).integrity.current;
    expect(current.researchDispatch).toEqual(f.expectedDispatch);                      // the daemon computed it over the stored row
    expect(current.researchDispatch.digest).not.toBe(withoutRow);                      // and the row changes it
    expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true, recovery: { phase: "prepared", integrity: { current: { researchDispatch: f.expectedDispatch } } } });
    expect(await request(f, "prepare", f.withoutResearch)).toMatchObject({ ok: false, error: expect.stringContaining("research_dispatch") });   // an older target is refused
  } finally { await f.close(); }
}, 30_000);
