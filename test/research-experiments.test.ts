import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks } from "../src/hub/tasks.ts";
import type { ResearchCampaignContract } from "../src/hub/research-campaign.ts";
import { protocolHash, type DeclaredExperimentEventInput, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), SOURCE = "src:0123456789abcdef", HASH = "a".repeat(64), COMMIT = "b".repeat(40);
const RUN = "01234567-0123-0123-0123-0123456789ab";
class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const campaignContract = (): ResearchCampaignContract => ({ question: "What does the synthetic evidence show?", scope: "Isolated fixture", exclusions: [], sourceIds: [SOURCE],
  units: [{ id: "measure", round: 0, question: "Measure synthetic inputs", perspective: "measurement", requiredOutput: "Metrics and bounded receipts", sourceIds: [SOURCE], dependsOn: [], purpose: "analysis" }],
  deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: new Date(NOW + 86_400_000).toISOString() } });

async function fixture(privateSource = false, filePolicy: Pick<ConstructorParameters<typeof Tasks>[0], "piiPaths" | "deny" | "executionRoot"> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-experiment-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"); let board = new Board(file); clean.push(() => board.close());
  const budget = new ExecutionBudget(file); clean.push(() => budget.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const routing = loadRouting(dir), roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
  const sources = new Map([[SOURCE, { id: SOURCE, sha256: HASH, private: privateSource }]]);
  let screen: ConstructorParameters<typeof Tasks>[0]["piiScreen"], check: (run: string) => Promise<unknown> = async () => undefined;
  const build = () => new Tasks({ board, bus, cwd: dir, project: "experiment-fixture", routing: () => routing, roles, executionBudget: budget, wipLimit: () => 32, ...filePolicy,
    notify: () => {}, studyNow: () => NOW, piiScreen: text => screen?.(text) ?? Promise.resolve({ label: "clear" as const, ms: 0 }),
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); },
    experimentCheck: run => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return check(run); } });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Synthetic experiment campaign", class: "implement", backlog: true });
  const draft = await tasks.studyDraft("claude", { parentTaskId: parent.id, contract: campaignContract() });
  const campaign = await tasks.studyApprove(USER, { id: draft.id, revision: 1 });
  const taskId = campaign.units[0]!.taskId;
  await tasks.pullPlanned(USER, { id: taskId, revision: 0, reason: "Start the explicitly approved synthetic unit" });
  const owner = privateSource ? "local" : "codex";
  await tasks.assignTo(taskId, owner, USER);
  tasks.accept(owner, taskId);
  const protocol = (): ExperimentProtocolContract => ({ campaignId: campaign.id, campaignRevision: 1, lineage: "synthetic", claimIds: [], inputs: [{ sourceId: SOURCE, sha256: HASH }],
    code: { commit: COMMIT }, environment: { descriptor: "Synthetic CPU fixture with no environment values" }, method: "Compare two fixed synthetic numbers", parameters: { size: 2 }, seeds: [1],
    evaluator: { id: "fixture", version: "v1" }, metrics: [{ name: "score", unit: "fraction", direction: "higher" }], role: "baseline", splits: ["test"], resourceLimits: [], sealed: false });
  return { dir, bus, sources, routing, roles, parent, campaign, taskId, protocol, get tasks() { return tasks; }, get board() { return board; },
    setScreen(next: NonNullable<typeof screen>) { screen = next; }, setCheck(next: typeof check) { check = next; },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function saveProtocol(f: Fixture, by = "codex", protocol = f.protocol()) {
  const result = await f.tasks.experimentRecord(by, { kind: "protocol", taskId: f.taskId, protocol });
  expect(result.kind).toBe("protocol"); return result.protocolHash;
}
async function attempt(f: Fixture, protocolHash: string, idempotencyKey: string, by = "codex", phase: "development" | "final" = "development") {
  const result = await f.tasks.experimentRecord(by, { kind: "attempt", attempt: { protocolHash, taskId: f.taskId, phase, idempotencyKey } });
  if (!("attemptId" in result) || typeof result.attemptId !== "string") throw new Error("attempt response omitted its identity");
  expect(result.kind).toBe("attempt"); return result.attemptId;
}
const add = (f: Fixture, attemptId: string, idempotencyKey: string, event: DeclaredExperimentEventInput, by = "codex") =>
  f.tasks.experimentRecord(by, { kind: "event", attemptId, idempotencyKey: `${attemptId}:${idempotencyKey}`, event });

test("#932 records immutable protocols, baseline/variant attempts and events without executing protocol text", async () => {
  const f = await fixture(), marker = join(f.dir, "must-not-execute"), p = f.protocol();
  p.method = `touch ${marker}`;
  const hash = await saveProtocol(f, "codex", p), id = await attempt(f, hash, "baseline", "codex", "final");
  expect(hash).toMatch(/^[a-f0-9]{64}$/); expect(id).toMatch(/^ra-[a-f0-9]{12}$/);
  await add(f, id, "start", { kind: "start", body: {} });
  await add(f, id, "metric", { kind: "metric", body: { name: "score", value: 0.8 } });
  await add(f, id, "end", { kind: "end", body: { status: "succeeded", exitStatus: 0 } });
  const variantHash = await saveProtocol(f, "codex", { ...p, role: "variant", variantOf: hash, parameters: { size: 3 } });
  expect(variantHash).not.toBe(hash); await attempt(f, variantHash, "variant");
  const shown = await f.tasks.experimentShow(USER, { attemptId: id });
  expect(shown.attempts[0]).toMatchObject({ id, protocolHash: hash, taskId: f.taskId, phase: "final", status: "succeeded", private: false });
  expect(shown.attempts[0]!.events).toHaveLength(3);
  expect(shown.attempts[0]!.protocol).toMatchObject({provenance:"declared",value:{code:{commit:"b".repeat(40)}}});
  expect(existsSync(marker)).toBe(false);
});

test("#932 rejects foreign campaign/task/source identities, source hash mismatch and closed schema fields before persistence", async () => {
  const f = await fixture(), p = f.protocol();
  const before = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id });
  const integrity = f.board.researchIntegrity();
  for (const protocol of [{ ...p, campaignId: "rc-ffffffffffff" }, { ...p, campaignRevision: 2 }, { ...p, inputs: [{ sourceId: SOURCE, sha256: "c".repeat(64) }] },
    { ...p, inputs: [{ sourceId: "src:ffffffffffffffff", sha256: HASH }] }, { ...p, command: "never execute" }]) {
    await expect(f.tasks.experimentRecord("codex", { kind: "protocol", taskId: f.taskId, protocol })).rejects.toThrow();
  }
  expect(f.board.researchIntegrity()).toEqual(integrity);
  const other = await f.tasks.propose(USER, { title: "Unrelated ordinary work", class: "implement", owner: "codex" });
  await expect(f.tasks.experimentRecord("codex", { kind: "protocol", taskId: other.id, protocol: p })).rejects.toThrow();
  expect(await f.tasks.experimentShow(USER, { campaignId: f.campaign.id })).toEqual(before);
});

test("#932 only the current owner may write; a person, another peer and a non-running unit cannot", async () => {
  const f = await fixture();
  await expect(saveProtocol(f, "claude")).rejects.toThrow();
  await expect(saveProtocol(f, USER)).rejects.toThrow();
  const hash = await saveProtocol(f), id = await attempt(f, hash, "owner-fence");
  await expect(add(f, id, "foreign", { kind: "note", body: { text: "not the owner" } }, "local")).rejects.toThrow();
  await f.tasks.cancel(f.taskId, USER, { reason: "Synthetic work stopped" });
  await expect(add(f, id, "late", { kind: "note", body: { text: "cannot write a stopped unit" } })).rejects.toThrow();
  await expect(saveProtocol(f, USER)).rejects.toThrow();
});

test("#932 attempt/event retries preserve identity and reject conflicting keys or a second terminal event across restart", async () => {
  const f = await fixture(), hash = await saveProtocol(f), id = await attempt(f, hash, "stable-attempt");
  expect(await attempt(f, hash, "stable-attempt")).toBe(id);
  await expect(attempt(f, hash, "stable-attempt", "codex", "final")).rejects.toThrow();
  const start = { kind: "start" as const, body: { startedAt: NOW } };
  const first = await add(f, id, "stable-event", start);
  expect(await add(f, id, "stable-event", start)).toEqual(first);
  await expect(add(f, id, "stable-event", { kind: "note", body: { text: "conflicting body" } })).rejects.toThrow();
  await add(f, id, "terminal", { kind: "end", body: { status: "failed", reason: "Synthetic failure" } });
  await expect(add(f, id, "second-end", { kind: "end", body: { status: "succeeded" } })).rejects.toThrow();
  f.restart();
  expect(await attempt(f, hash, "stable-attempt")).toBe(id);
  expect(await add(f, id, "stable-event", start)).toEqual(first);
  const shown = await f.tasks.experimentShow(USER, { attemptId: id });
  expect(shown.attempts[0]).toMatchObject({ id, status: "failed" }); expect(shown.attempts[0]!.events).toHaveLength(2);
});

test("#932 measured check evidence stays beside contradictory declared exit status, without a second end", async () => {
  const f = await fixture();
  f.setCheck(async run => ({ run, task: f.taskId, sha: COMMIT, status: "finished", exit: 1, timed_out: false, cancelled: false, duration_ms: 42, created: NOW, tail: "PRIVATE_UNUSED_NATIVE_TAIL" }));
  const hash = await saveProtocol(f), id = await attempt(f, hash, "check-evidence");
  await add(f, id, "end", { kind: "end", body: { status: "succeeded", exitStatus: 0, run: RUN } });
  const shown = await f.tasks.experimentShow(USER, { attemptId: id }), row = shown.attempts[0]!;
  expect(row.evidence).toMatchObject({ declared: { exitStatus: { value: 0, provenance: "declared" } },
    measured: [{ values: { exitStatus: { value: 1, provenance: "host-observed", evidence: RUN } } }] });
  expect(row.events).toHaveLength(1); expect(row.status).toBe("succeeded");
  expect(JSON.stringify(shown)).not.toContain("PRIVATE_UNUSED_NATIVE_TAIL");
});

test("#932 absent or mismatched checks leave host facts and unavailable timing unknown", async () => {
  const f = await fixture(), hash = await saveProtocol(f);
  for (const [key, check] of [["absent", undefined], ["wrong-task", { run: RUN, task: f.taskId + 100, sha: COMMIT, status: "finished", exit: 0, timed_out: false, cancelled: false, duration_ms: 1, created: NOW }]] as const) {
    f.setCheck(async () => check);
    const id = await attempt(f, hash, key); await add(f, id, "end", { kind: "end", body: { status: "failed", run: RUN } });
    const row = (await f.tasks.experimentShow(USER, { attemptId: id })).attempts[0]!;
    expect(row.evidence).toMatchObject({ measured: [], declared: { durationMs: { value: null, provenance: "unknown" },
      startedAt: { value: null, provenance: "unknown" }, endedAt: { value: null, provenance: "unknown" } } });
  }
});

test("#932 caller evidence elevation and undeclared metric names refuse without appending events", async () => {
  const f = await fixture(), hash = await saveProtocol(f), id = await attempt(f, hash, "caller-evidence");
  for (const event of [{ kind: "metric", body: { name: "score", value: 1 }, provenance: "host-observed" },
    { kind: "metric", body: { name: "unregistered", value: 1 } }, { kind: "attestation", body: { evidence: RUN } },
    { kind: "output", body: { path: "result.csv", format: "csv", sha256: HASH } }]) {
    await expect(f.tasks.experimentRecord("codex", { kind: "event", attemptId: id, idempotencyKey: "forged", event })).rejects.toThrow();
  }
  const row = (await f.tasks.experimentShow(USER, { attemptId: id })).attempts[0]!;
  expect(row.events).toEqual([]); expect(row.evidence).toMatchObject({ measured: [] });
});

test("#932 an owner change during a host receipt read refuses the event before persistence", async () => {
  const f = await fixture(), hash = await saveProtocol(f), id = await attempt(f, hash, "host-read-fence");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.setCheck(async run => { entered(); await gate; return { run, task: f.taskId, sha: COMMIT, status: "finished", exit: 1, timed_out: false, cancelled: false, duration_ms: 42, created: NOW }; });
  const call = add(f, id, "end", { kind: "end", body: { status: "succeeded", exitStatus: 0, run: RUN } }), result = call.then(() => undefined, error => error);
  try {
    await Promise.race([started, call.then(() => { throw new Error("event admission missed the host-read barrier"); })]);
    await f.tasks.assignTo(f.taskId, "local", USER);
  } finally { release(); }
  expect(await result).toBeInstanceOf(Error);
  const row = (await f.tasks.experimentShow(USER, { attemptId: id })).attempts[0]!;
  expect(row.events).toEqual([]); expect(row.evidence).toMatchObject({ measured: [] });
}, 20_000);

test("#932 an unknown screen refuses a public protocol without storing redacted content", async () => {
  const f = await fixture(); f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
  f.setScreen(async () => ({ label: "unknown", miss: "failed", ms: 0 }));
  await expect(saveProtocol(f)).rejects.toThrow();
  expect(f.board.experimentProtocol(protocolHash(f.protocol()))).toBeUndefined();
  expect((await f.tasks.experimentShow(USER, { campaignId: f.campaign.id })).counts.all).toBe(0);
});

test("#932 real output hashing uses #509 while supplied hashes stay declared and missing/denied files stay unknown", async () => {
  const f = await fixture(); mkdirSync(join(f.dir, "results")); writeFileSync(join(f.dir, "results/result.csv"), "value\n1\n"); writeFileSync(join(f.dir, ".env"), "SYNTHETIC=private");
  const hash = await saveProtocol(f), id = await attempt(f, hash, "outputs");
  await add(f, id, "host-file", { kind: "output", body: { path: "results/result.csv", format: "csv" } });
  await add(f, id, "declared-file", { kind: "output", body: { id: "d-0123456789ab", sha256: HASH } });
  await add(f, id, "missing-file", { kind: "output", body: { path: "results/missing.csv", format: "csv" } });
  await add(f, id, "denied-file", { kind: "output", body: { path: ".env", format: "txt" } });
  const row = (await f.tasks.experimentShow(USER, { attemptId: id })).attempts[0]!;
  expect(row.evidence).toMatchObject({ measured: [{ values: { sha256: { value: createHash("sha256").update("value\n1\n").digest("hex"), provenance: "host-observed" } } }],
    declared: { outputs: [expect.anything(), { sha256: { value: HASH, provenance: "declared" } },
      { sha256: { value: null, provenance: "unknown" } }, { sha256: { value: null, provenance: "unknown" } }] } });
});

test("#932 source privacy upgrades and private event text are stubbed in every public show", async () => {
  const f = await fixture(true), canary = "PRIVATE_EXPERIMENT_TEXT_CANARY";
  const p = f.protocol(); p.method = canary;
  const hash = await saveProtocol(f, "local", p), id = await attempt(f, hash, "private", "local");
  await add(f, id, "private-note", { kind: "note", body: { text: canary } }, "local");
  for (const by of [USER, "claude", "codex"]) {
    const shown = await f.tasks.experimentShow(by, { attemptId: id });
    expect(shown.attempts[0]).toMatchObject({ id, private: true }); expect(JSON.stringify(shown)).not.toContain(canary);
  }
  expect(JSON.stringify(f.board.get(f.taskId)!.history)).not.toContain(canary);
});

test("#932 privacy is refreshed on reads when a previously public source becomes private", async () => {
  const f = await fixture(), canary = "FORMERLY_PUBLIC_EXPERIMENT_METHOD";
  const hash = await saveProtocol(f, "codex", { ...f.protocol(), method: canary }), id = await attempt(f, hash, "late-private");
  expect(JSON.stringify(await f.tasks.experimentShow(USER, { attemptId: id }))).toContain(canary);
  f.sources.get(SOURCE)!.private = true;
  const shown = await f.tasks.experimentShow(USER, { attemptId: id });
  expect(shown.attempts[0]!.private).toBe(true); expect(JSON.stringify(shown)).not.toContain(canary);
});

test("#932 failed, cancelled and unknown attempts remain in all-attempt counts", async () => {
  const f = await fixture(), hash = await saveProtocol(f);
  for (const status of ["failed", "cancelled"] as const) {
    const id = await attempt(f, hash, status); await add(f, id, "end", { kind: "end", body: { status } });
  }
  await attempt(f, hash, "unsettled"); await f.tasks.cancel(f.taskId, USER, { reason: "No final receipt exists for the third attempt" });
  const shown = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id });
  expect(shown.counts).toMatchObject({ all: 3, statuses: { failed: 1, cancelled: 1, unknown: 1 } });
  expect(shown.attempts.map(row => row.status).sort()).toEqual(["cancelled", "failed", "unknown"]);
});

test("#932 attempt pagination caps a page at fifty and keeps total denominators", async () => {
  const f = await fixture(), hash = await saveProtocol(f);
  for (let index = 0; index < 53; index++) await attempt(f, hash, `page-${index}`);
  const first = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id, limit: 50 });
  expect(first.attempts).toHaveLength(50); expect(first.counts.all).toBe(53); expect(first.nextCursor).toBeDefined();
  const second = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id, after: first.nextCursor, limit: 50 });
  expect(second.attempts).toHaveLength(3); expect(second.counts.all).toBe(53);
  expect(new Set([...first.attempts, ...second.attempts].map(row => row.id)).size).toBe(53);
  await expect(f.tasks.experimentShow(USER, { campaignId: f.campaign.id, limit: 51 })).rejects.toThrow();
});

for (const change of ["owner", "source-hash", "source-privacy", "campaign", "recovery"] as const) {
  test(`#932 a ${change} change during asynchronous screening refuses the stale admission`, async () => {
    const f = await fixture(); f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
    let release!: () => void, entered!: () => void, first = true;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.setScreen(async () => { if (first) { first = false; entered(); await gate; } return { label: "clear", ms: 0 }; });
    const call = saveProtocol(f), result = call.then(() => undefined, error => error);
    try {
      await Promise.race([started, call.then(() => { throw new Error("protocol admission missed the screen barrier"); })]);
      if (change === "owner") await f.tasks.assignTo(f.taskId, "local", USER);
      else if (change === "source-hash") f.sources.get(SOURCE)!.sha256 = "c".repeat(64);
      else if (change === "source-privacy") f.sources.get(SOURCE)!.private = true;
      else if (change === "campaign") await f.tasks.studyClose(USER, { id: f.campaign.id, revision: 1, reason: "The approved experiment scope ended" });
      else f.bus.setRecoveryHold(true);
    } finally { release(); }
    try {
      expect(await result).toBeInstanceOf(Error);
      expect(f.board.experimentProtocol(protocolHash(f.protocol()))).toBeUndefined();
      expect((await f.tasks.experimentShow(USER, { campaignId: f.campaign.id })).counts.all).toBe(0);
    }
    finally { f.bus.setRecoveryHold(false); }
  }, 20_000);
}

test("#932 protocol supersession records a new immutable declared body without approving it", async () => {
  const f=await fixture(), original=f.protocol(), hash=await saveProtocol(f,"codex",original);
  const changed={...original,method:"A newly declared protocol",supersedes:hash};
  const next=await saveProtocol(f,"codex",changed);
  expect(next).not.toBe(hash);
  expect(f.board.experimentProtocol(hash)!.protocol).toEqual(original);
  expect(f.board.experimentProtocol(next)!.protocol).toEqual(changed);
  await expect(saveProtocol(f,"codex",{...changed,lineage:"foreign-lineage"})).rejects.toThrow();
});

test("#932 a missing output under pii.paths remains private even though its hash is unknown", async () => {
  const f=await fixture(false,{piiPaths:["private-results"]}), hash=await saveProtocol(f), id=await attempt(f,hash,"missing-private");
  const path="private-results/missing.csv";
  expect(existsSync(join(f.dir,path))).toBe(false);
  await add(f,id,"protected-output",{kind:"output",body:{path,format:"csv"}});
  const shown=await f.tasks.experimentShow(USER,{attemptId:id}), row=shown.attempts[0]!;
  expect(row.private).toBe(true);
  expect(row.events[0]).toMatchObject({kind:"output",body:"[pii]"});
  expect(JSON.stringify(shown)).not.toContain(path);
  expect(f.board.experimentEvents(id).rows[0]!.observations).toEqual([]);
  expect(f.board.experimentAttempt(id)!.private).toBe(true);
});
