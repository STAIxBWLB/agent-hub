import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectChain } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { campaignHash, parseResearchCampaign } from "../src/hub/research-campaign.ts";
import { protocolHash, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";
import { RUNNER_RECEIPT_DOMAIN, type RegisteredRunnerV1 } from "../src/hub/research-runner.ts";
import { canonicalJson } from "../src/hub/packs.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { realPath } from "../src/hub/project.ts";
import { USER } from "../src/hub/envelope.ts";

async function fixture(options: { receipt?: boolean; runners?: Record<string, RegisteredRunnerV1> } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-runner-recovery-"))), stateDir = join(root, "state"), configDir = join(root, ".agenthub");
  mkdirSync(stateDir); mkdirSync(configDir);
  execFileSync("git", ["-C", root, "init", "-q"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" });
  const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "AGENTHUB_HOME", "AMEM_HOME", "KIMI_CODE_HOME"] as const;
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { const home = join(root, key.toLowerCase()); mkdirSync(home); process.env[key] = home; }
  const shared = { roster: {}, batch_ms: 0, memory: { enabled: false, native: false }, inference: { enabled: false },
    mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, task_sweep: { enabled: false }, approvals: { notify: false }, research: { enabled: false } };
  writeFileSync(join(configDir, "config.json"), JSON.stringify(shared));
  if (options.runners !== undefined) writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ research: { runners: options.runners } }));
  // startDaemon deliberately preserves embedding-owned policy references, so this observes active publication directly.
  const acceptedResearch = { enabled: false, ...(options.runners !== undefined ? { runners: options.runners } : {}) };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  const close = async () => {
    try { client?.close(); await daemon?.stop(); }
    finally {
      for (const key of envKeys) { const before = savedEnv[key]; if (before === undefined) delete process.env[key]; else process.env[key] = before; }
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    if (options.receipt) {
      const project = projectChain(root).at(-1)!, board = new Board(join(stateDir, "hub.db"));
      try {
        const parent = board.propose(USER, { title: "Runner recovery fixture", class: "plan", backlog: true });
        const contract = parseResearchCampaign({ question: "Which observation supports the claim?", scope: "Synthetic fixture", exclusions: [], sourceIds: [],
          units: [{ id: "discovery", round: 0, question: "Collect observation", perspective: "Independent", requiredOutput: "Evidence", sourceIds: [], dependsOn: [], purpose: "discovery" }],
          deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: "2030-01-01T00:00:00Z" } });
        board.saveResearchCampaignDraft({ id: "rc-000000000001", project, parentTaskId: parent.id, revision: 1, status: "draft", contract, hash: campaignHash(contract), private: false, createdBy: USER, createdAt: 1 }, undefined, parent.history.length);
        const activated = board.activateCampaign("rc-000000000001", 1, project, USER, 2, [{ unitId: "discovery", create: { title: "Runner receipt fixture", class: "implement", signals: [] } }], board.get(parent.id)!.history.length, false, {});
        const assigned = board.update(activated.bindings[0]!.taskId, USER, "backlog pulled", { state: "proposed", owner: "local" });
        board.update(assigned.id, "local", "accepted", { state: "in_progress" });
        const protocol: ExperimentProtocolContract = { campaignId: activated.campaign.id, campaignRevision: 1, lineage: "fixture", claimIds: [], inputs: [], code: { commit: "b".repeat(40) },
          environment: { descriptor: "Synthetic CPU" }, method: "Collect fixture", parameters: {}, seeds: [1], evaluator: { id: "count", version: "1" }, metrics: [], role: "baseline", splits: [], resourceLimits: [], sealed: false };
        const fence = () => ({ project, taskId: assigned.id, taskFlowRevision: board.get(assigned.id)!.history.length, owner: "local", campaignId: activated.campaign.id, campaignRevision: 1, campaignHash: activated.campaign.hash });
        const hash = protocolHash(protocol);
        board.saveExperimentProtocol({ hash, project, recordedForTaskId: assigned.id, protocol, by: "local", at: 3, private: false }, fence());
        const attempt = { protocolHash: hash, taskId: assigned.id, phase: "final" as const, idempotencyKey: "runner-recovery" };
        board.createExperimentAttempt({ attemptId: "ra-000000000001", project, attempt, bodyHash: createHash("sha256").update(canonicalJson(attempt)).digest("hex"), by: "local", at: 4, private: false }, fence());
        board.appendExperimentEvent("ra-000000000001", "end", { kind: "end", body: { status: "succeeded" } }, [], "local", 5, false, 0, fence());
        const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
        const receipt = { receiptId: "receipt-fixture", runner: "cpu", projectId: project, attemptId: "ra-000000000001", protocolHash: hash, codeCommit: "b".repeat(40) };
        const signature = sign(null, Buffer.from(RUNNER_RECEIPT_DOMAIN + canonicalJson(receipt)), keys.privateKey).toString("base64");
        board.appendRunnerReceipt({ receipt, signature, publicKey, by: "local", at: 6, private: false }, 1, fence());
      } finally { board.close(); }
    }
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, roster: {}, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
        research: acceptedResearch, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const status = (await client.request({ t: "status" })).status;
    const restartTarget = async (operationId: string) => {
      await daemon!.stopped;
      client!.close();
      const targetConfig = loadConfig(root);
      const prior = process.env.AGENTHUB_RECOVERY_OPERATION;
      process.env.AGENTHUB_RECOVERY_OPERATION = operationId;
      try {
        daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, config: targetConfig });
      } finally { if (prior === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = prior; }
      client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
      const targetStatus = (await client.request({ t: "status" })).status;
      return { daemon, client, status: targetStatus, acceptedResearch: targetConfig.research };
    };
    return { root, stateDir, configDir, client, status, close, restartTarget, acceptedResearch, withoutRunners: status.features.filter((feature: string) => feature !== "research_runners") };
  } catch (error) { await close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, op: string, targetFeatures?: readonly string[]) => f.client.request({ t: "recovery", op, operationId: "runner-capability", expectedInstanceId: f.status.instanceId,
  ...(targetFeatures === undefined ? {} : { targetFeatures }) });
const inspect = async (f: Fixture) => (await request(f, "inspect")).recovery;

test("empty recovery keeps its integrity shape and does not require research_runners", async () => {
  expect(DAEMON_FEATURES).toContain("research_runners");
  const f = await fixture();
  try {
    expect((await inspect(f)).integrity.current.researchRunners).toBeUndefined();
    expect(await request(f, "prepare", f.withoutRunners)).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

for (const name of ["config.json", "config.local.json"]) {
  test(`raw runner key in ${name}, including an empty map, requires its additive floor`, async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.configDir, name), JSON.stringify({ research: { runners: {} } }));
      for (const op of ["prepare", "commit", "inspect"]) {
        expect(await request(f, op, f.withoutRunners)).toMatchObject({ ok: false, error: expect.stringContaining("research_runners") });
        expect((await inspect(f)).phase).toBeUndefined();
      }
      expect((await inspect(f)).integrity.current.researchRunners).toBeUndefined();
    } finally { await f.close(); }
  }, 20_000);
}

test("stored receipts require research_runners even without any registration, and retain earlier research floors", async () => {
  const f = await fixture({ receipt: true });
  try {
    for (const op of ["prepare", "commit", "inspect"]) expect(await request(f, op, f.withoutRunners)).toMatchObject({ ok: false, error: expect.stringContaining("research_runners") });
    const current = (await inspect(f)).integrity.current;
    expect(current.researchRunners).toMatchObject({ count: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    for (const key of ["research", "researchDispatch", "researchExperiments", "researchComparisons"]) expect(current[key]).toBeDefined();
    for (const feature of ["research_records", "research_dispatch", "research_experiments", "research_comparisons"]) {
      expect(await request(f, "prepare", f.status.features.filter((value: string) => value !== feature))).toMatchObject({ ok: false, error: expect.stringContaining(feature) });
    }
    expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

for (const receipt of [false, true]) test(`${receipt ? "stored receipt" : "config-only"} runner integrity survives a two-daemon recovery with a pending raw revocation`, async () => {
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"), runners = { cpu: { publicKey, projects: ["fixture"], revoked: false } };
  const f = await fixture({ receipt, runners });
  try {
    const before = (await inspect(f)).integrity.current.researchRunners;
    const board = new Board(join(f.stateDir, "hub.db"));
    try {
      const stored = board.runnerReceiptIntegrity();
      expect(before).toEqual(stored.count ? stored : undefined);
    } finally { board.close(); }
    writeFileSync(join(f.configDir, "config.local.json"), JSON.stringify({ research: { runners: { cpu: { ...runners.cpu, revoked: true } } } }));
    expect(f.acceptedResearch.runners?.cpu?.revoked).toBe(false);
    expect((await inspect(f)).integrity.current.researchRunners).toEqual(before);
    expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true, recovery: { phase: "prepared" } });
    expect(await request(f, "commit", f.status.features)).toMatchObject({ ok: true, committed: true });
    const target = await f.restartTarget("runner-capability");
    expect(target.acceptedResearch.runners?.cpu?.revoked).toBe(true);
    const targetRequest = (op: string) => target.client.request({ t: "recovery", op, operationId: "runner-capability", expectedInstanceId: target.status.instanceId });
    const restored = await targetRequest("inspect");
    expect(restored).toMatchObject({ ok: true, recovery: { phase: "restored" } });
    expect(restored.recovery.integrity.current.researchRunners).toEqual(before);
    expect(await targetRequest("release")).toMatchObject({ ok: true, released: true, recovery: { phase: "released" } });
    expect(target.daemon.bus.isRecoveryHeld).toBe(false);
    expect(await target.client.request({ t: "send", body: "ordinary work after runner recovery" })).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("a two-daemon recovery releases a legacy runner-free integrity snapshot despite a raw runner key", async () => {
  const f = await fixture();
  try {
    // Older sources could retain raw runner configuration without supporting its release-equality field.
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const runners = { cpu: { publicKey, projects: ["fixture"], revoked: false } };
    writeFileSync(join(f.configDir, "config.local.json"), JSON.stringify({ research: { runners } }));
    expect(f.acceptedResearch.runners).toBeUndefined();
    expect(await request(f, "prepare", f.status.features)).toMatchObject({ ok: true, recovery: { phase: "prepared" } });
    expect(await request(f, "commit", f.status.features)).toMatchObject({ ok: true, committed: true });
    const expected = { projectRoot: f.root, projectId: f.status.projectId, operationId: "runner-capability" };
    const committed = readRestartSnapshot(f.stateDir, expected);
    expect(committed?.integrity).toBeDefined();
    // Model the legacy release-equality shape explicitly, retaining every queue/board/budget field.
    const { researchRunners: _newField, ...legacyIntegrity } = committed!.integrity!;
    writeRestartSnapshot(f.stateDir, { ...committed!, integrity: legacyIntegrity });
    expect(readRestartSnapshot(f.stateDir, expected)?.integrity?.researchRunners).toBeUndefined();
    const target = await f.restartTarget("runner-capability");
    expect(target.acceptedResearch.runners).toEqual(runners);
    const targetRequest = (op: string) => target.client.request({ t: "recovery", op, operationId: "runner-capability", expectedInstanceId: target.status.instanceId });
    const restored = await targetRequest("inspect");
    expect(restored).toMatchObject({ ok: true, recovery: { phase: "restored" } });
    expect(restored.recovery.integrity.current.researchRunners).toBeUndefined();
    expect(await targetRequest("release")).toMatchObject({ ok: true, released: true, recovery: { phase: "released" } });
    expect(target.daemon.bus.isRecoveryHeld).toBe(false);
    expect(await target.client.request({ t: "send", body: "ordinary work after legacy runner recovery" })).toMatchObject({ ok: true });
  } finally { await f.close(); }
}, 20_000);

test("a person can replace an existing whole runner block through a tier2 structural edit", async () => {
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64"), runners = { cpu: { publicKey, projects: ["fixture"], revoked: false } };
  const f = await fixture({ runners });
  try {
    expect(f.acceptedResearch.runners?.cpu?.revoked).toBe(false);
    const revisions = (await f.client.request({ t: "config_edit_get" })).revisions;
    const edit = { file: "config.local.json", revision: revisions["config.local.json"], set: [{ path: ["research", "runners"], value: { cpu: { ...runners.cpu, revoked: true } } }] };
    expect(await f.client.request({ t: "config_edit_preview", edit })).toMatchObject({ ok: true, tier: 2 });
    expect(await f.client.request({ t: "config_edit_apply", edit, reason: "revoke the fixture key" })).toMatchObject({ ok: true, saved: true });
    expect(f.acceptedResearch.runners?.cpu?.revoked).toBe(true);
    const unchanged = await f.client.request({ t: "settings_reload" });
    expect(unchanged).toMatchObject({ ok: true, applied: [], rejected: [] });
    expect(unchanged.confirmation).toBeUndefined(); // a pending unpublished edit would still require person confirmation
    expect((await inspect(f)).integrity.current.researchRunners).toBeUndefined();
  } finally { await f.close(); }
}, 20_000);

test("restart snapshots retain runner integrity and reject malformed count or digest", () => {
  const stateDir = realPath(mkdtempSync(join(tmpdir(), "ahub-runner-snapshot-"))), bus = new Bus({ batchMs: 0 });
  try {
    const researchRunners = { count: 1, digest: "a".repeat(64) };
    const snapshot: RestartSnapshot = { schemaVersion: 1, projectRoot: stateDir, projectId: "fixture", sourceInstanceId: "source", operationId: "runner", committedAt: 1,
      bus: bus.snapshot(), manualPaused: [], peers: [], integrity: { queues: {}, manualPaused: [], boardDigest: "board", budgetDigest: "budget", researchRunners } };
    const expected = { projectRoot: stateDir, projectId: "fixture", operationId: "runner" };
    writeRestartSnapshot(stateDir, snapshot);
    expect(readRestartSnapshot(stateDir, expected)?.integrity?.researchRunners).toEqual(researchRunners);
    for (const invalid of [{ ...researchRunners, count: -1 }, { ...researchRunners, count: 0.5 }, { count: 1 }, { ...researchRunners, digest: "invalid" }, null]) {
      writeRestartSnapshot(stateDir, { ...snapshot, integrity: { ...snapshot.integrity!, researchRunners: invalid } } as RestartSnapshot);
      expect(readRestartSnapshot(stateDir, expected)).toBeUndefined();
    }
  } finally { bus.closeJournal(); rmSync(stateDir, { recursive: true, force: true }); }
});
