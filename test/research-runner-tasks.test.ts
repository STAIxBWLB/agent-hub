import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { assertHubDbCompatible, HUB_DB_BASE_SCHEMA } from "../src/hub/db-schema.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { ExecutionBudget } from "../src/hub/execution-budget.ts";
import { canonicalJson } from "../src/hub/packs.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { ResearchCampaignContract } from "../src/hub/research-campaign.ts";
import type { ExperimentProtocolContract, RunnerReceiptProjection } from "../src/hub/research-experiments.ts";
import { RUNNER_RECEIPT_DOMAIN, type AttemptReceiptV1, type RegisteredRunnerV1 } from "../src/hub/research-runner.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const NOW = Date.UTC(2026, 10, 1), PROJECT = "runner-fixture", SOURCE = "src:0123456789abcdef", HASH = "a".repeat(64), COMMIT = "b".repeat(40);
class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envelopes: Envelope[]) { this.got.push(...envelopes); }
}

async function fixture(privateSource = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-runner-tasks-")), file = join(dir, "hub.db");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let board = new Board(file); cleanups.push(() => board.close());
  const budget = new ExecutionBudget(file); cleanups.push(() => budget.close());
  const bus = new Bus({ batchMs: 0 }); cleanups.push(() => bus.closeJournal());
  for (const id of ["claude", "codex", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const owner = privateSource ? "local" : "codex", routing = loadRouting(dir);
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"], local: ["implementer"] };
  const sources = new Map([[SOURCE, { id: SOURCE, sha256: HASH, private: privateSource }]]);
  const key = generateKeyPairSync("ed25519"), publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const registration = (): Record<string, RegisteredRunnerV1> => ({ fixture: { publicKey, projects: [PROJECT], revoked: false } });
  let runners: unknown = registration(), runnerReads = 0, registryError = false, privateTurn = false, requestRefusal: string | undefined;
  let screen: TasksDeps["piiScreen"];
  const build = () => new Tasks({ board, bus, cwd: dir, project: PROJECT, routing: () => routing, roles, executionBudget: budget, wipLimit: () => 32,
    notify: () => {}, studyNow: () => NOW, privateTurn: peer => privateTurn && peer === owner,
    requestAuthority: () => () => requestRefusal,
    piiScreen: text => screen?.(text) ?? Promise.resolve({ label: "clear" as const, ms: 0 }),
    researchRunners: () => { runnerReads++; if (registryError) throw new Error("fixture registration source unavailable"); return runners; },
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); return sources.get(id); } });
  let tasks = build();
  const parent = await tasks.propose(USER, { title: "Synthetic runner campaign", class: "implement", backlog: true });
  const contract: ResearchCampaignContract = { question: "What was attested by this synthetic runner?", scope: "CPU-only fixtures without execution or network", exclusions: [], sourceIds: [SOURCE],
    units: [{ id: "measure", round: 0, question: "Record signed synthetic evidence", perspective: "measurement", requiredOutput: "Signed receipt", sourceIds: [SOURCE], dependsOn: [], purpose: "analysis" }],
    deliverableSections: [], stopPolicy: { maxUnits: 1, maxFollowUpRounds: 0, deadline: new Date(NOW + 86_400_000).toISOString() } };
  const draft = await tasks.studyDraft("claude", { parentTaskId: parent.id, contract });
  const campaign = await tasks.studyApprove(USER, { id: draft.id, revision: 1 }), taskId = campaign.units[0]!.taskId;
  await tasks.pullPlanned(USER, { id: taskId, revision: 0, reason: "Record the approved synthetic receipt fixture" });
  await tasks.assignTo(taskId, owner, USER); tasks.accept(owner, taskId);
  const protocol = (): ExperimentProtocolContract => ({ campaignId: campaign.id, campaignRevision: 1, lineage: "synthetic", claimIds: [], inputs: [{ sourceId: SOURCE, sha256: HASH }],
    code: { commit: COMMIT }, environment: { descriptor: "Synthetic CPU fixture" }, method: "Record fixed evidence without running a command", parameters: {}, seeds: [1],
    evaluator: { id: "fixture", version: "v1" }, metrics: [{ name: "score", unit: "fraction", direction: "higher" }], role: "baseline", splits: ["test"], resourceLimits: [], sealed: false });
  return { dir, file, bus, owner, sources, routing, campaign, taskId, publicKey, registration, protocol,
    get board() { return board; }, get tasks() { return tasks; }, get runnerReads() { return runnerReads; },
    get db() { return (board as unknown as { db: Database }).db; },
    setRunners(value: unknown) { runners = value; }, setRegistryError(value: boolean) { registryError = value; },
    setPrivateTurn(value: boolean) { privateTurn = value; }, setRequestRefusal(value: string | undefined) { requestRefusal = value; },
    setScreen(value: NonNullable<typeof screen>) { screen = value; },
    sign(receipt: AttemptReceiptV1) { return sign(null, Buffer.from(RUNNER_RECEIPT_DOMAIN + canonicalJson(receipt), "utf8"), key.privateKey).toString("base64"); },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Attested = RunnerReceiptProjection & { key: { hash: string; status: "active" | "revoked" | "replaced" | "unavailable" } };
async function setupAttempt(f: Fixture, key = "first", protocol = f.protocol(), retryOf?: string) {
  const saved = await f.tasks.experimentRecord(f.owner, { kind: "protocol", taskId: f.taskId, protocol });
  const attempt = await f.tasks.experimentRecord(f.owner, { kind: "attempt", attempt: { protocolHash: saved.protocolHash, taskId: f.taskId, phase: "development", idempotencyKey: key, ...(retryOf ? { retryOf } : {}) } });
  if (!attempt.attemptId) throw new Error("fixture attempt has no identity");
  return { id: attempt.attemptId, hash: saved.protocolHash };
}
function receipt(id: string, hash: string, receiptId = "receipt-one"): AttemptReceiptV1 {
  return { receiptId, runner: "fixture", projectId: PROJECT, attemptId: id, protocolHash: hash, codeCommit: COMMIT,
    imageDigest: `sha256:${"c".repeat(64)}`, containers: [{ id: "candidate", role: "candidate" }, { id: "evaluator", role: "evaluator" }],
    mounts: [{ container: "candidate", path: "/outputs", readOnly: false, purpose: "candidate-output" }, { container: "evaluator", path: "/evaluation", readOnly: true, purpose: "evaluator-code" }],
    network: "none", resourceLimits: [{ name: "cpu", value: 1, unit: "core" }], startedAt: NOW, endedAt: NOW + 1, exitStatus: 0,
    outputs: [{ name: "result.json", sha256: "d".repeat(64) }], metricsFile: { name: "metrics.json", sha256: "e".repeat(64) } };
}
const relay = (f: Fixture, body: AttemptReceiptV1, by = f.owner, signature = f.sign(body)) => f.tasks.experimentRecord(by, { kind: "receipt", receipt: body, signature });
const show = (f: Fixture, id: string) => f.tasks.experimentShow(USER, { attemptId: id });
async function attested(f: Fixture, id: string): Promise<Attested[]> {
  const rows = (await show(f, id)).attempts[0]!.evidence.runnerAttested;
  expect(Array.isArray(rows)).toBe(true);
  return rows as Attested[];
}
const schema = (f: Fixture) => f.db.query("SELECT schema,required_version FROM hub_schema WHERE id=1").get() as { schema: number; required_version: string };
const state = (f: Fixture, id: string) => ({ schema: schema(f), receipts: f.board.runnerReceiptIntegrity(), seq: f.board.experimentLastSeq(id), task: f.board.get(f.taskId) });

test("#1018 a signed receipt binds one attestation event without changing declared status or host evidence", async () => {
  const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash);
  expect(schema(f).schema).toBe(HUB_DB_BASE_SCHEMA);
  const saved = await relay(f, body);
  expect(saved).toMatchObject({ kind: "receipt", receiptId: body.receiptId, protocolHash: a.hash, attemptId: a.id, seq: 1 });
  const row = (await show(f, a.id)).attempts[0]!;
  expect(row).toMatchObject({ id: a.id, status: "declared", evidence: { measured: [], declared: { sealed: { value: false, provenance: "declared" } } } });
  expect(row.events).toHaveLength(1);
  expect(row.events[0]).toMatchObject({ kind: "attestation", body: { receiptId: body.receiptId }, provenance: "runner-attested" });
  const proof = (await attested(f, a.id))[0]!;
  expect(proof).toMatchObject({ receiptId: body.receiptId, provenance: "runner-attested", key: { status: "active" },
    values: { exitStatus: { value: 0, provenance: "runner-attested" }, network: { value: "none", provenance: "runner-attested" } }, sealing: { value: true, provenance: "runner-attested" } });
  expect(proof.key.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(schema(f)).toEqual({ schema: 2, required_version: "0.26.0" });
  expect(() => assertHubDbCompatible(f.file, { schema: 1, version: "0.25.0" })).toThrow(/0\.26\.0/);
  expect(f.board.hasRunnerReceipts()).toBe(true);
  f.restart();
  expect((await attested(f, a.id))[0]).toEqual(proof);
});

test("#1018 unknown, revoked, foreign, tampered and mismatched receipts refuse before all writes", async () => {
  const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash), signature = f.sign(body);
  const cases: { body?: AttemptReceiptV1; runners?: unknown; signature?: string }[] = [
    { runners: {} }, { runners: { fixture: { ...f.registration().fixture!, revoked: true } } },
    { runners: { fixture: { ...f.registration().fixture!, projects: ["foreign-project"] } } },
    { body: { ...body, projectId: "foreign-project" } }, { body: { ...body, attemptId: "ra-ffffffffffff" } },
    { body: { ...body, protocolHash: "f".repeat(64) } }, { body: { ...body, codeCommit: "f".repeat(40) } },
    { body: { ...body, exitStatus: 1 }, signature }, { signature: "invalid" },
  ];
  for (const value of cases) {
    f.setRunners(value.runners ?? f.registration());
    const candidate = value.body ?? body, before = state(f, a.id);
    await expect(relay(f, candidate, f.owner, value.signature ?? f.sign(candidate))).rejects.toThrow();
    expect(state(f, a.id)).toEqual(before);
  }
  f.setRunners(f.registration());
  const before = state(f, a.id);
  await expect(relay(f, body, "claude")).rejects.toThrow();
  expect(state(f, a.id)).toEqual(before);
});

test("#1018 identical signed bytes replay without registry verification or writes after revocation, replacement and removal", async () => {
  const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash), signature = f.sign(body);
  const saved = await relay(f, body, f.owner, signature), before = state(f, a.id);
  const replacement = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  for (const runners of [{ fixture: { ...f.registration().fixture!, revoked: true } }, { fixture: { ...f.registration().fixture!, publicKey: replacement } }, {}]) {
    f.setRunners(runners); const reads = f.runnerReads;
    expect(await relay(f, Object.fromEntries(Object.entries(body).reverse()) as unknown as AttemptReceiptV1, f.owner, signature)).toEqual(saved);
    expect(f.runnerReads).toBe(reads);
    expect(state(f, a.id)).toEqual(before);
    await expect(relay(f, { ...body, receiptId: "new-receipt" })).rejects.toThrow();
    expect(state(f, a.id)).toEqual(before);
  }
  f.setRegistryError(true); const reads = f.runnerReads;
  expect(await relay(f, body, f.owner, signature)).toEqual(saved); expect(f.runnerReads).toBe(reads);
  expect(state(f, a.id)).toEqual(before);
  f.setRegistryError(false); f.setRunners(f.registration());
  await expect(relay(f, { ...body, exitStatus: 1 })).rejects.toThrow(/receipt|different|conflict/i);
  expect(state(f, a.id)).toEqual(before);
});

test("#1018 current key status never rewrites the as-of-signing attestation", async () => {
  const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash);
  await relay(f, body); const stored = f.board.runnerReceipt(body.receiptId), original = (await attested(f, a.id))[0]!;
  const replacement = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  for (const [runners, status] of [[{ fixture: { ...f.registration().fixture!, revoked: true } }, "revoked"],
    [{ fixture: { ...f.registration().fixture!, publicKey: replacement } }, "replaced"], [{}, "unavailable"]] as const) {
    f.setRunners(runners);
    const proof = (await attested(f, a.id))[0]!;
    expect(proof.key).toEqual({ hash: original.key.hash, status });
    expect(proof.sealing).toEqual(original.sealing); expect(proof.values).toEqual(original.values);
    expect(f.board.runnerReceipt(body.receiptId)).toEqual(stored);
  }
});

test("#1018 missing fields remain unknown and incomplete isolation cannot verify sealing", async () => {
  const f = await fixture(), a = await setupAttempt(f);
  const body: AttemptReceiptV1 = { receiptId: "minimal", runner: "fixture", projectId: PROJECT, attemptId: a.id, protocolHash: a.hash };
  await relay(f, body);
  const proof = (await attested(f, a.id))[0]!;
  for (const name of ["codeCommit", "imageDigest", "containers", "mounts", "network", "resourceLimits", "startedAt", "endedAt", "exitStatus", "outputs", "metricsFile"])
    expect(proof.values[name]).toEqual({ value: null, provenance: "unknown" });
  expect(proof.sealing).toEqual({ value: false, provenance: "declared" });
  expect(proof.codeMatch).toEqual({ value: null, provenance: "unknown" });
});

test("#1018 a retry is a new linked attempt and cannot overwrite a receipt on its predecessor", async () => {
  const f = await fixture(), first = await setupAttempt(f), body = receipt(first.id, first.hash);
  await relay(f, body);
  const retry = await setupAttempt(f, "retry", f.protocol(), first.id);
  await expect(relay(f, { ...body, attemptId: retry.id })).rejects.toThrow();
  await relay(f, receipt(retry.id, retry.hash, "retry-receipt"));
  const shown = await f.tasks.experimentShow(USER, { campaignId: f.campaign.id });
  expect(shown.counts.all).toBe(2); expect(shown.attempts.find(row => row.id === retry.id)).toMatchObject({ retryOf: first.id });
  expect(f.board.runnerReceipts(first.id).map(row => row.receipt.receiptId)).toEqual([body.receiptId]);
  expect(f.board.runnerReceipts(retry.id).map(row => row.receipt.receiptId)).toEqual(["retry-receipt"]);
});

test("#1018 person relay uses the signed runner authority while arbitrary peers remain refused", async () => {
  const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash);
  await expect(relay(f, body, "local")).rejects.toThrow();
  const saved = await relay(f, body, USER);
  expect(saved).toMatchObject({ kind: "receipt", attemptId: a.id });
  expect(f.board.runnerReceipt(body.receiptId)?.by).toBe(USER);
});

for (const change of ["revoked", "replaced", "source-hash", "source-privacy", "owner", "private-turn", "recovery", "request-authority"] as const) {
  test(`#1018 a ${change} change during receipt screening refuses before persistence`, async () => {
    const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash);
    f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
    let entered!: () => void, release!: () => void, first = true;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.setScreen(async () => { if (first) { first = false; entered(); await gate; } return { label: "clear", ms: 0 }; });
    const call = relay(f, body), result = call.then(() => undefined, error => error);
    try {
      await Promise.race([started, call.then(() => { throw new Error("receipt admission missed the screen barrier"); })]);
      if (change === "revoked") f.setRunners({ fixture: { ...f.registration().fixture!, revoked: true } });
      else if (change === "replaced") f.setRunners({ fixture: { ...f.registration().fixture!, publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64") } });
      else if (change === "source-hash") f.sources.get(SOURCE)!.sha256 = "f".repeat(64);
      else if (change === "source-privacy") f.sources.get(SOURCE)!.private = true;
      else if (change === "owner") await f.tasks.assignTo(f.taskId, "local", USER);
      else if (change === "private-turn") f.setPrivateTurn(true);
      else if (change === "recovery") f.bus.setRecoveryHold(true);
      else f.setRequestRefusal("receipt caller generation changed");
    } finally { release(); }
    try {
      expect(await result).toBeInstanceOf(Error);
      expect(f.board.hasRunnerReceipts()).toBe(false);
      expect(f.board.experimentLastSeq(a.id)).toBe(0);
      expect(schema(f).schema).toBe(HUB_DB_BASE_SCHEMA);
    } finally { f.bus.setRecoveryHold(false); }
  }, 20_000);
}

test("#1018 a receipt storage failure rolls back its attestation and schema advance together", async () => {
  const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash), before = state(f, a.id);
  f.db.run("CREATE TRIGGER refuse_fixture_receipt BEFORE INSERT ON research_runner_receipts BEGIN SELECT RAISE(ABORT,'fixture storage refusal'); END");
  await expect(relay(f, body)).rejects.toThrow();
  expect(state(f, a.id)).toEqual(before);
  f.db.run("DROP TRIGGER refuse_fixture_receipt");
  expect((await relay(f, body)).seq).toBe(1); expect(schema(f).schema).toBe(2);
});

test("#1018 source privacy upgrades mask stored receipt details and attestation bodies", async () => {
  const f = await fixture(), a = await setupAttempt(f), canary = "FORMERLY_PUBLIC_RUNNER_OUTPUT_CANARY";
  const body = { ...receipt(a.id, a.hash), outputs: [{ name: canary, sha256: HASH }] };
  await relay(f, body);
  expect(JSON.stringify(await show(f, a.id))).toContain(canary);
  f.sources.get(SOURCE)!.private = true;
  for (const by of [USER, "claude", "codex"]) {
    const shown = await f.tasks.experimentShow(by, { attemptId: a.id });
    expect(shown.attempts[0]).toMatchObject({ private: true, events: [{ kind: "attestation", body: "[pii]" }] });
    expect(JSON.stringify(shown)).not.toContain(canary);
  }
  expect(JSON.stringify(f.board.get(f.taskId)!.history)).not.toContain(canary);
});

test("#1018 an unknown public receipt screen refuses before attestation or schema writes", async () => {
  const f = await fixture(), a = await setupAttempt(f), before = state(f, a.id);
  f.routing.signals.pii_screen = "local"; f.routing.constraints.pii = "local_only";
  f.setScreen(async () => ({ label: "unknown", miss: "failed", ms: 0 }));
  await expect(relay(f, receipt(a.id, a.hash))).rejects.toThrow();
  expect(state(f, a.id)).toEqual(before);
});

test("#1018 private-source receipts persist privately and expose no signed payload to public readers", async () => {
  const f = await fixture(true), a = await setupAttempt(f), canary = "PRIVATE_RUNNER_INPUT_OUTPUT_CANARY";
  const body = { ...receipt(a.id, a.hash), outputs: [{ name: canary, sha256: HASH }] };
  await relay(f, body);
  expect(f.board.runnerReceipt(body.receiptId)?.private).toBe(true);
  for (const by of [USER, "claude", "codex"]) {
    const shown = await f.tasks.experimentShow(by, { attemptId: a.id });
    expect(shown.attempts[0]).toMatchObject({ private: true, events: [{ kind: "attestation", body: "[pii]" }] });
    expect(JSON.stringify(shown)).not.toContain(canary);
  }
  expect(JSON.stringify(f.board.get(f.taskId)!.history)).not.toContain(canary);
});

test("#1018 a runner commit claim cannot prove the code of a deliverable-based protocol", async () => {
  const f = await fixture(), file = "candidate.txt"; writeFileSync(join(f.dir, file), "Synthetic candidate bytes\n");
  const recorded = await f.tasks.recordSdlc(f.owner, f.taskId, { deliverables: [{ path: file, format: "txt" }] });
  const artifact = recorded.history.findLast(entry => entry.deliverables?.length)?.deliverables?.[0];
  if (!artifact) throw new Error("fixture host hashing omitted its deliverable record");
  const protocol = { ...f.protocol(), code: { deliverable: { id: artifact.id, sha256: artifact.sha256 } } };
  const a = await setupAttempt(f, "deliverable-code", protocol), body = receipt(a.id, a.hash);
  await relay(f, body);
  const proof = (await attested(f, a.id))[0]!;
  expect(proof.values.codeCommit).toEqual({ value: COMMIT, provenance: "runner-attested", evidence: body.receiptId });
  expect(proof.codeMatch).toEqual({ value: null, provenance: "unknown" });
  expect((await show(f, a.id)).attempts[0]!.evidence.measured).toEqual([]);
});


for (const corruption of ["body", "project", "by_peer", "at", "idempotency_key", "host-observation"] as const) {
  test(`#1018 corrupt linked attestation ${corruption} refuses stored proof, replay, integrity and paginated show`, async () => {
    const f = await fixture(), a = await setupAttempt(f), body = receipt(a.id, a.hash), signature = f.sign(body);
    const saved = await relay(f, body, f.owner, signature);
    if (typeof saved.seq !== "number") throw new Error("fixture receipt omitted its attestation sequence");
    const seq = saved.seq;
    const eventHash = () => (f.db.query("SELECT body_sha256 FROM research_attempt_events WHERE attempt_id=? AND seq=?").get(a.id, seq) as { body_sha256: string }).body_sha256;
    const originalHash = eventHash();
    if (corruption === "body") f.db.query("UPDATE research_attempt_events SET body=? WHERE attempt_id=? AND seq=?")
      .run(canonicalJson({ kind: "attestation", body: { receiptId: "forged-link" } }), a.id, seq);
    else if (corruption === "project") f.db.query("UPDATE research_attempt_events SET project=? WHERE attempt_id=? AND seq=?").run("foreign-project", a.id, seq);
    else if (corruption === "by_peer") f.db.query("UPDATE research_attempt_events SET by_peer=? WHERE attempt_id=? AND seq=?").run("local", a.id, seq);
    else if (corruption === "at") f.db.query("UPDATE research_attempt_events SET at=? WHERE attempt_id=? AND seq=?").run(NOW + 1, a.id, seq);
    else if (corruption === "idempotency_key") f.db.query("UPDATE research_attempt_events SET idempotency_key=? WHERE attempt_id=? AND seq=?").run("forged-key", a.id, seq);
    else {
      // Well-formed host evidence still cannot attach to a runner attestation.
      const observation = { source: "deliverable", evidence: "d-0123456789ab", values: { deliverableId: "d-0123456789ab", sha256: HASH, bytes: 1 } };
      f.db.query("INSERT INTO research_attempt_observations(attempt_id,event_seq,body,body_sha256) VALUES(?,?,?,?)")
        .run(a.id, seq, canonicalJson(observation), createHash("sha256").update(canonicalJson(observation)).digest("hex"));
    }
    expect(eventHash()).toBe(originalHash); // Do not repair the old checksum after corrupting its linked row.
    const rawState = () => ({
      receipts: f.db.query("SELECT * FROM research_runner_receipts ORDER BY receipt_id").all(),
      events: f.db.query("SELECT * FROM research_attempt_events ORDER BY attempt_id,seq").all(),
      observations: f.db.query("SELECT * FROM research_attempt_observations ORDER BY attempt_id,event_seq").all(),
      schema: schema(f), task: f.board.get(f.taskId),
    });
    const before = rawState();
    expect(() => f.board.runnerReceipt(body.receiptId)).toThrow();
    await expect(relay(f, body, f.owner, signature)).rejects.toThrow();
    expect(() => f.board.runnerReceiptIntegrity()).toThrow();
    // A page beginning after the corrupt event must not hide a corrupt linked receipt.
    await expect(f.tasks.experimentShow(USER, { attemptId: a.id, eventAfter: seq })).rejects.toThrow();
    expect(rawState()).toEqual(before);
  });
}

test("#1018 a removed own constructor runner is unavailable rather than an inherited registration", async () => {
  const f = await fixture(), a = await setupAttempt(f);
  f.setRunners({ constructor: { ...f.registration().fixture! } });
  const body = { ...receipt(a.id, a.hash), runner: "constructor" };
  await relay(f, body);
  const original = (await attested(f, a.id))[0]!;
  expect(original).toMatchObject({ runner: "constructor", key: { status: "active" } });
  f.setRunners({});
  const proof = (await attested(f, a.id))[0]!;
  expect(proof).toMatchObject({ runner: "constructor", key: { hash: original.key.hash, status: "unavailable" } });
  expect(proof.values).toEqual(original.values);
});
