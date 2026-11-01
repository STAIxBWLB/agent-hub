import { afterEach, expect, test } from "bun:test";
import { projectChain } from "@staix/agent-mem";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../src/cli/shell-quote.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { canonicalJson } from "../src/hub/packs.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";
import type { ResearchCampaignContract } from "../src/hub/research-campaign.ts";
import type { ComparisonPlanV1, ExperimentProtocolContract } from "../src/hub/research-experiments.ts";
import { RUNNER_RECEIPT_DOMAIN, type AttemptReceiptV1 } from "../src/hub/research-runner.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { SourceRegistry } from "../src/hub/sources.ts";
import { Tasks } from "../src/hub/tasks.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const COMMIT = "b".repeat(40), RUN = "01234567-0123-0123-0123-0123456789ab";
class FixturePeer extends BasePeer {
  readonly got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envelopes: Envelope[]) { this.got.push(...envelopes); }
  begin() { this.setState("busy"); }
  end() { this.setState("idle"); }
}
const op = (client: ControlClient, name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args });
const record = (client: ControlClient, args: Record<string, unknown>) => op(client, "hub_experiment_record", args);
const result = (reply: any): Record<string, any> => { expect(reply.ok, JSON.stringify(reply)).toBe(true); return JSON.parse(reply.text); };
function metadata(reply: any, keys: string[]) {
  const value = result(reply); expect(Object.keys(value).sort()).toEqual([...keys].sort()); return value;
}

/** Real Tasks bootstrap only: the new public tool is exercised through the daemon's authenticated control socket. */
async function rig(options: { owner?: "codex" | "local"; privateTurn?: boolean; readonly?: boolean } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-experiment-record-daemon-"))), stateDir = join(root, "state"), configDir = join(root, ".agenthub");
  mkdirSync(stateDir); mkdirSync(configDir); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const homes = ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME"] as const;
  const previous = Object.fromEntries(homes.map(key => [key, process.env[key]]));
  for (const key of homes) { const home = join(root, key.toLowerCase()); mkdirSync(home); process.env[key] = home; }
  cleanup.push(() => { for (const key of homes) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const git = hubGitSync(["-C", root, "init", "-q"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" });
  if (git.status !== 0) throw new Error(`fixture git init failed: ${git.stderr}`);
  const project = projectChain(root).at(-1)!, sourceRegistry = new SourceRegistry(stateDir);
  const added = sourceRegistry.add({ bytes: Buffer.from("Synthetic experiment input"), kind: "file", origin: "fixture-input.txt", private: false, text: "Synthetic experiment input" });
  const source = sourceRegistry.get(added.id); if (!source) throw new Error("fixture source registration missing");
  const key = generateKeyPairSync("ed25519"), publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const runners = { fixture: { publicKey, projects: [project], revoked: false } };
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"], kimi: ["implementer"] }, owner = options.owner ?? "codex";
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const budget = new ExecutionBudget(join(stateDir, "hub.db"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of Object.keys(roles)) { const peer = new FixturePeer(id); bus.add(peer); await peer.start(); }
  const bootstrap = new Tasks({ cwd: root, project, board, bus, executionBudget: budget, routing: () => loadRouting(root), roles, wipLimit: () => 32,
    notify: () => {}, piiScreen: async () => ({ label: "clear", ms: 0 }), studySource: id => sourceRegistry.get(id) });
  let campaign: Awaited<ReturnType<Tasks["studyApprove"]>>, taskId: number, privateTaskId: number | undefined;
  try {
    const parent = await bootstrap.propose(USER, { title: "Public experiment parent", class: owner === "local" ? "implement" : "plan", backlog: true });
    const contract: ResearchCampaignContract = { question: "Which synthetic observations support this claim?", scope: "No command or runner execution", exclusions: [], sourceIds: [source.id],
      units: [{ id: "measure", round: 0, question: "Record synthetic measurements", perspective: "measurement", requiredOutput: "Bounded evidence", sourceIds: [source.id], dependsOn: [], purpose: "analysis" }],
      deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: new Date(Date.now() + 86_400_000).toISOString() } };
    const draft = await bootstrap.studyDraft("claude", { parentTaskId: parent.id, contract });
    campaign = await bootstrap.studyApprove(USER, { id: draft.id, revision: 1 }); taskId = campaign.units[0]!.taskId;
    await bootstrap.pullPlanned(USER, { id: taskId, revision: 0, reason: "Record approved synthetic evidence" });
    await bootstrap.assignTo(taskId, owner, USER); bootstrap.accept(owner, taskId);
    if (options.privateTurn) privateTaskId = (await bootstrap.propose(USER, { title: "Patient 900101-1234567 private work", class: "implement", owner: "local" })).id;
  } finally { bus.closeJournal(); budget.close(); }
  const adapters: NonNullable<HubConfig["adapters"]> = options.readonly ? { fixture: { transport: "acp", command: process.execPath,
    args: [join(import.meta.dir, "fakes/acp-server.ts"), "--agent-name", "Fixture ACP", "--agent-version", "1", "--modes", "default,plan"],
    displayName: "Fixture ACP", roles: ["verifier"], identity: { name: "Fixture ACP", version: "1" }, permission: { ask: "default" }, readOnly: "plan" } } : {};
  const instances: NonNullable<HubConfig["instances"]> = options.readonly ? { "fixture-check": { kind: "fixture", roles: ["verifier"], start_mode: "headless", readOnly: true } } : {};
  const local = { research: { enabled: false, runners }, ...(options.readonly ? { adapters, instances, roster: { fixture: false, "fixture-check": true } } : {}) };
  writeFileSync(join(configDir, "config.local.json"), JSON.stringify(local));
  const marker = join(root, "must-not-execute"), command = `touch ${shellQuote(marker)}`;
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: project, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier: () => {},
    piiScreen: async () => ({ label: "clear", ms: 0 }), config: { ...DEFAULT_CONFIG, roles, adapters, instances, batch_ms: 0,
      roster: { ...DEFAULT_CONFIG.roster, local: true, kimi: true, ...(options.readonly ? { fixture: false, "fixture-check": true } : {}) },
      tasks: { ...DEFAULT_CONFIG.tasks, wip_limits: { claude: 32, codex: 32, local: 32, kimi: 32 } },
      research: { enabled: false, runners }, checks: { ...DEFAULT_CONFIG.checks, implement: command },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], access_hosts: [] },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const peers = new Map<string, FixturePeer>();
  for (const id of Object.keys(roles)) { const peer = new FixturePeer(id); peers.set(id, peer); daemon.bus.add(peer); await peer.start(); }
  const connect = async (peer?: string) => { const client = await ControlClient.connect(stateDir, peer ? { role: "tools", peer, projectRoot: root } : { role: "console", projectRoot: root }); cleanup.push(() => client.close()); return client; };
  const protocol = (): ExperimentProtocolContract => ({ campaignId: campaign.id, campaignRevision: 1, lineage: "synthetic", claimIds: [], inputs: [{ sourceId: source.id, sha256: source.sha256 }],
    code: { commit: COMMIT }, environment: { descriptor: "Synthetic CPU fixture" }, method: "Record fixed evidence", parameters: {}, seeds: [1],
    evaluator: { id: "fixture", version: "v1" }, metrics: [{ name: "score", unit: "fraction", direction: "higher" }], role: "baseline", splits: ["test"], resourceLimits: [], sealed: false });
  return { root, stateDir, project, taskId, privateTaskId, marker, command, board, daemon, peers, protocol, owner,
    person: await connect(), agent: await connect(owner), reviewer: await connect("claude"), other: await connect("kimi"), connect,
    signature: (body: unknown) => sign(null, Buffer.from(RUNNER_RECEIPT_DOMAIN + canonicalJson(body), "utf8"), key.privateKey).toString("base64") };
}
type Rig = Awaited<ReturnType<typeof rig>>;
async function protocolAndAttempt(r: Rig, protocol = r.protocol()) {
  const p = metadata(await record(r.agent, { kind: "protocol", taskId: r.taskId, protocol }), ["kind", "protocolHash"]);
  const args = { kind: "attempt", attempt: { protocolHash: p.protocolHash, taskId: r.taskId, phase: "development", idempotencyKey: "first-attempt" } };
  const a = metadata(await record(r.agent, args), ["kind", "protocolHash", "attemptId"]) as { kind: "attempt"; protocolHash: string; attemptId: string };
  expect(a.attemptId).toMatch(/^ra-[a-f0-9]{12}$/); expect(a.protocolHash).toMatch(/^[a-f0-9]{64}$/);
  return { p, a, args };
}
function signedBody(r: Rig, a: { attemptId: string; protocolHash: string }, receiptId: string): AttemptReceiptV1 {
  return { receiptId, runner: "fixture", projectId: r.project, attemptId: a.attemptId, protocolHash: a.protocolHash, codeCommit: COMMIT,
    containers: [{ id: "candidate", role: "candidate" }, { id: "evaluator", role: "evaluator" }],
    mounts: [{ container: "evaluator", path: "/evaluation", readOnly: true, purpose: "evaluator-code" }], network: "none", exitStatus: 0 };
}
const snapshot = (r: Rig) => ({ experiments: r.board.researchExperimentsIntegrity(), runners: r.board.runnerReceiptIntegrity(), task: r.board.get(r.taskId) });

test("#615 owner records protocols, attempts, plans and events over the real control socket with metadata-only replay results", async () => {
  const r = await rig(), { p, a, args } = await protocolAndAttempt(r);
  expect(metadata(await record(r.agent, args), ["kind", "protocolHash", "attemptId"])).toEqual(a);
  expect(metadata(await record(r.agent, { kind: "protocol", taskId: r.taskId, protocol: r.protocol() }), ["kind", "protocolHash"])).toEqual(p);
  const protocol = r.protocol(), plan: ComparisonPlanV1 = { campaignId: protocol.campaignId, fixed: { inputs: protocol.inputs, splits: protocol.splits, evaluator: protocol.evaluator, metrics: protocol.metrics },
    varying: ["code", "parameters", "seeds", "role"], rule: { kind: "tolerance", value: 0.01 } };
  const planned = metadata(await record(r.agent, { kind: "plan", taskId: r.taskId, plan }), ["kind", "planHash"]);
  expect(planned.kind).toBe("plan"); expect(planned.planHash).toMatch(/^[a-f0-9]{64}$/);
  const event = { kind: "event", attemptId: a.attemptId, idempotencyKey: "score", event: { kind: "metric", body: { name: "score", value: 0.8 } } };
  const observed = metadata(await record(r.agent, event), ["kind", "protocolHash", "attemptId", "seq"]);
  expect(metadata(await record(r.agent, event), ["kind", "protocolHash", "attemptId", "seq"])).toEqual(observed);
  expect(r.board.experimentLastSeq(a.attemptId)).toBe(1); expect(r.board.experimentAttempt(a.attemptId)?.attempt.protocolHash).toBe(p.protocolHash);
  expect(existsSync(r.marker)).toBe(false);
}, 20_000);

test("#615 reviewer, another owner, console non-receipt and readonly instance cannot bypass record authority", async () => {
  const r = await rig({ readonly: true }), readonly = await r.connect("fixture-check"), { a } = await protocolAndAttempt(r), before = snapshot(r);
  const args = { kind: "event", attemptId: a.attemptId, idempotencyKey: "not-owner", event: { kind: "note", body: { text: "must not be recorded" } } };
  for (const client of [r.reviewer, r.other, r.person]) {
    const reply = await record(client, args); expect(reply.ok).toBe(false); expect(String(reply.error)).toMatch(/owner/);
  }
  const refused = await record(readonly, args); expect(refused.ok).toBe(false); expect(refused.error).toContain("read-only");
  expect(snapshot(r)).toEqual(before); expect(existsSync(r.marker)).toBe(false);
}, 20_000);

test("#615 signed receipt owner and person-console relays keep the actual actor and return only receipt metadata", async () => {
  const r = await rig(), { a } = await protocolAndAttempt(r), ownerBody = signedBody(r, a, "owner-receipt"), consoleBody = signedBody(r, a, "console-receipt");
  const args = { kind: "receipt", receipt: ownerBody, signature: r.signature(ownerBody) };
  const saved = metadata(await record(r.agent, args), ["kind", "protocolHash", "attemptId", "seq", "receiptId"]);
  expect(metadata(await record(r.agent, args), ["kind", "protocolHash", "attemptId", "seq", "receiptId"])).toEqual(saved);
  const consoleResult = metadata(await record(r.person, { kind: "receipt", receipt: consoleBody, signature: r.signature(consoleBody) }), ["kind", "protocolHash", "attemptId", "seq", "receiptId"]);
  expect(consoleResult.receiptId).toBe(consoleBody.receiptId);
  expect(r.board.runnerReceipt(ownerBody.receiptId)?.by).toBe(r.owner); expect(r.board.runnerReceipt(consoleBody.receiptId)?.by).toBe(USER);
  const before = snapshot(r), foreign = signedBody(r, a, "reviewer-receipt");
  expect((await record(r.reviewer, { kind: "receipt", receipt: foreign, signature: r.signature(foreign) })).ok).toBe(false);
  expect(snapshot(r)).toEqual(before); expect(existsSync(r.marker)).toBe(false);
}, 20_000);

test("#615 unknown fields and command-shaped payloads neither start configured checks nor execute receipt text", async () => {
  const r = await rig(), protocol = { ...r.protocol(), method: r.command, parameters: { command: r.command } }, { a } = await protocolAndAttempt(r, protocol);
  const before = snapshot(r), body = { ...signedBody(r, a, "malicious-fields"), command: r.command };
  for (const args of [
    { kind: "protocol", taskId: r.taskId, protocol, command: r.command },
    { kind: "attempt", attempt: { protocolHash: a.protocolHash, taskId: r.taskId, phase: "development", idempotencyKey: "bad", command: r.command } },
    { kind: "event", attemptId: a.attemptId, idempotencyKey: "bad-metric", event: { kind: "metric", body: { name: "score", value: r.command } } },
    { kind: "receipt", receipt: body, signature: r.signature(body) },
  ]) expect((await record(r.agent, args)).ok).toBe(false);
  expect(snapshot(r)).toEqual(before);
  const receipt = { ...signedBody(r, a, "declaration-only"), metricsFile: { name: `$(${r.command})`, sha256: "a".repeat(64) } };
  metadata(await record(r.agent, { kind: "receipt", receipt, signature: r.signature(receipt) }), ["kind", "protocolHash", "attemptId", "seq", "receiptId"]);
  metadata(await record(r.agent, { kind: "event", attemptId: a.attemptId, idempotencyKey: "unknown-run", event: { kind: "end", body: { status: "failed", run: RUN } } }), ["kind", "protocolHash", "attemptId", "seq"]);
  expect(existsSync(r.marker)).toBe(false);
}, 20_000);

test("#615 actual latched private host turn refuses every record kind before its ordinary target is admitted", async () => {
  const r = await rig({ owner: "local", privateTurn: true }), peer = r.peers.get("local")!;
  if (r.privateTaskId === undefined) throw new Error("fixture omitted its private task");
  expect(r.board.get(r.privateTaskId)?.owner).toBe("local");
  expect(r.board.get(r.privateTaskId)?.signals).toContain("pii");
  peer.begin();
  const events = readFileSync(join(r.stateDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(event => event.type === "turn_start" && event.peer === "local")).toBe(true);
  result(await op(r.person, "hub_task_cancel", { id: r.privateTaskId, reason: "Keep the already private turn latched after its task closes" }));
  expect(peer.state).toBe("busy"); expect(r.board.get(r.privateTaskId)?.state).toBe("cancelled");
  expect(r.board.list().some(task => task.owner === "local" && !["approved", "cancelled"].includes(task.state) && task.signals.some(signal => signal === "pii" || signal === "pii_path"))).toBe(false);
  const before = snapshot(r);
  try {
    for (const kind of ["protocol", "attempt", "event", "plan", "receipt"]) {
      const args = kind === "protocol" ? { kind, taskId: r.taskId, protocol: r.protocol() } : { kind };
      const reply = await record(r.agent, args); expect(reply.ok).toBe(false);
      expect(reply.error).toContain("hub_experiment_record is not available while working on a PII task");
    }
    expect(snapshot(r)).toEqual(before); expect(existsSync(r.marker)).toBe(false);
  } finally { peer.end(); }
}, 20_000);
