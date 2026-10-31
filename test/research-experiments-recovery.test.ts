import { createHash } from "node:crypto";
import { protocolHash, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";
import { canonicalJson } from "../src/hub/packs.ts";
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

async function fixture(options: { draft?: boolean; experiment?: boolean; files?: Record<string, unknown> } = {}) {
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
    if (options.draft || options.experiment) {
      const board = new Board(join(stateDir, "hub.db"));
      try {
        const parent = board.propose(USER, { title: "Research recovery fixture", class: "plan", backlog: true });
        const contract = parseResearchCampaign({ question: "Which observations distinguish the alternatives?", scope: "Isolated recovery fixture", exclusions: [], sourceIds: [],
          units: [{ id: "discovery", round: 0, question: "Collect observations", perspective: "Independent", requiredOutput: "Evidence list", sourceIds: [], dependsOn: [], purpose: "discovery" }],
          deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: "2030-01-01T00:00:00Z" } });
        board.saveResearchCampaignDraft({ id: "rc-000000000001", project: root, parentTaskId: parent.id, revision: 1, status: "draft", contract,
          hash: campaignHash(contract), private: false, createdBy: USER, createdAt: 1 }, undefined, parent.history.length);
        if (options.experiment) {
          const activated = board.activateCampaign("rc-000000000001", 1, root, USER, 2, [{ unitId: "discovery", create: { title: "Experiment fixture", class: "implement", signals: [] } }], board.get(parent.id)!.history.length, false, {});
          const task = board.update(activated.bindings[0]!.taskId, USER, "backlog pulled", {state:"proposed",owner:"local"});
          board.update(task.id, "local", "accepted", {state:"in_progress"});
          const protocol: ExperimentProtocolContract = {campaignId:activated.campaign.id,campaignRevision:1,lineage:"fixture",claimIds:[],inputs:[],code:{commit:"b".repeat(40)},environment:{descriptor:"Synthetic Linux CPU"},method:"Record synthetic evidence",parameters:{},seeds:[1],evaluator:{id:"count",version:"1"},metrics:[],role:"baseline",splits:[],resourceLimits:[],sealed:false};
          const fence = () => ({project:root,taskId:task.id,taskFlowRevision:board.get(task.id)!.history.length,owner:"local",campaignId:activated.campaign.id,campaignRevision:1,campaignHash:activated.campaign.hash});
          const hash = protocolHash(protocol);
          board.saveExperimentProtocol({hash,project:root,recordedForTaskId:task.id,protocol,by:"local",at:3,private:false},fence());
          const attempt={protocolHash:hash,taskId:task.id,phase:"final" as const,idempotencyKey:"recovery-fixture"};
          board.createExperimentAttempt({attemptId:"ra-000000000001",project:root,attempt,bodyHash:createHash("sha256").update(canonicalJson(attempt)).digest("hex"),by:"local",at:4,private:false},fence());
          board.appendExperimentEvent("ra-000000000001","end",{kind:"end",body:{status:"failed"}},[],"local",5,false,0,fence());
        }
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
    return { root, configDir, client, status, expectedResearch, withoutResearch: status.features.filter((feature: string) => feature !== "research_experiments"), close };
  } catch (error) { await close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, op: string, targetFeatures?: readonly string[]) => f.client.request({ t: "recovery", op, operationId: "research-capability",
  expectedInstanceId: f.status.instanceId, ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const inspect = async (f: Fixture) => (await f.client.request({ t: "recovery", op: "inspect", expectedInstanceId: f.status.instanceId })).recovery;


test("an empty project and legacy campaign do not require research_experiments", async () => {
  expect(DAEMON_FEATURES).toContain("research_experiments");
  for (const draft of [false,true]) {
    const f=await fixture({draft});
    try { expect(await request(f,"prepare",f.withoutResearch)).toMatchObject({ok:true}); }
    finally { await f.close(); }
  }
},20_000);

test("experiment rows require their additive floor before prepare, commit or target inspect", async () => {
  const f=await fixture({experiment:true});
  try {
    expect(f.withoutResearch).toContain("research_records"); expect(f.withoutResearch).toContain("research_dispatch");
    for (const op of ["prepare","commit","inspect"]) {
      expect(await request(f,op,f.withoutResearch)).toMatchObject({ok:false,error:expect.stringContaining("research_experiments")});
      expect((await inspect(f)).phase).toBeUndefined();
    }
    const reply=await request(f,"prepare",f.status.features);
    expect(reply).toMatchObject({ok:true,recovery:{integrity:{current:{researchExperiments:{protocols:1,attempts:1,events:1,observations:0,digest:expect.stringMatching(/^[a-f0-9]{64}$/)}}}}});
  } finally { await f.close(); }
},20_000);
