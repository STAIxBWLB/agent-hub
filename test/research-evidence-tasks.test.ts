import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Board, claimListId, taskClaimIdentity, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { SourceRegistry, sha256Of } from "../src/hub/sources.ts";
import { TaskRepositories } from "../src/hub/task-repository.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import type { EvidenceRecordInput } from "../src/hub/research-evidence.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
const CLAIMS = ["CLAIM_TEXT_CANARY first", "CLAIM_TEXT_CANARY second"];
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-evidence-")), file = join(cwd, "hub.db");
  let board = new Board(file);
  const bus = new Bus({ batchMs: 0 }), registry = new SourceRegistry(cwd), notices: string[] = [];
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["claude", "codex", "kimi", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const first = registry.add({ bytes: Buffer.from("source A α🙂 passage"), kind: "file", origin: "/private-origin-canary/a.txt", private: false, text: "source A α🙂 passage" });
  const second = registry.add({ bytes: Buffer.from("source B counterevidence"), kind: "file", origin: "/private-origin-canary/b.txt", private: false, text: "source B counterevidence" });
  const control: { privateTurn: boolean; held: boolean; hash?: string; screen?: () => Promise<void>; screenLabel: "clear" | "pii" | "unknown"; routingUnavailable?: boolean } = { privateTurn: false, held: false, screenLabel: "clear" };
  const patterns: string[] = [], piiPaths: string[] = [];
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"], kimi: ["implementer"], local: ["implementer"] };
  const build = () => new Tasks({ cwd, board, bus, project: "evidence-fixture", profile: "research", roles, notify: line => notices.push(line),
    routing: () => { if (control.routingUnavailable) throw new Error("POLICY_UNAVAILABLE_CANARY"); const routing = loadRouting(cwd); return { ...routing, signals: { ...routing.signals, pii_patterns: [...routing.signals.pii_patterns, ...patterns], ...(control.screen ? { pii_screen: "local" as const } : {}) } }; }, piiPaths,
    privateTurn: () => control.privateTurn, sweepHeld: () => control.held,
    piiScreen: async () => { await control.screen?.(); return control.screenLabel === "unknown" ? { label: "unknown" as const, miss: "failed" as const, ms: 0 } : { label: control.screenLabel, ms: 0 }; },
    intake: { sourceKnown: id => !!registry.get(id), split: async () => undefined, partsSchema: () => ({}) },
    studySource: id => { expect((board as unknown as { db: Database }).db.inTransaction).toBe(false); const source = registry.get(id); return source ? { id: source.id, sha256: control.hash ?? source.sha256, private: source.private } : undefined; } } satisfies TasksDeps);
  let tasks = build();
  const task = await tasks.propose("codex", { title: "Research claims", class: "fact_check", owner: "codex", plan: { claims: CLAIMS } });
  const input = (target: Task = board.get(task.id)!, source = first.id, slot = 1): EvidenceRecordInput => {
    const identity = taskClaimIdentity(target, slot);
    return { taskId: target.id, claimId: identity.claimId, claimRevision: identity.claimRevision, sourceId: source,
      rawSha256: registry.get(source)!.sha256, projectionSha256: sha256Of(Buffer.from("declared projection")), projectionVersion: "declared-v1",
      locator: { start: 0, end: 3 }, relation: "supports", revision: 1 };
  };
  return { cwd, file, registry, control, patterns, piiPaths, task, first, second, input, notices, get board() { return board; }, get tasks() { return tasks; },
    restart() { board.close(); board = new Board(file); tasks = build(); } };
}
const refused = async (call: Promise<unknown>) => { try { await call; throw new Error("expected a pre-effect refusal"); } catch (error) { expect(error).toBeInstanceOf(PreEffectToolRefusal); return error; } };

test("#931 T1 support and counterevidence retain declared bindings and return only ids", async () => {
  const f = await fixture(), before = f.board.get(f.task.id)!;
  expect(f.board.hasResearchEvidenceState()).toBe(false);
  const support = await f.tasks.evidenceRecord("codex", f.input());
  const counter = await f.tasks.evidenceRecord("codex", { ...f.input(before, f.second.id), relation: "contradicts" });
  expect(Object.keys(support).sort()).toEqual(["id", "revision", "taskId"]);
  expect(support.id).not.toBe(counter.id);
  expect(f.board.evidenceLink("evidence-fixture", support.id)).toEqual({ ...f.input(), id: support.id, recordedBy: "codex" });
  expect(f.board.evidenceLink("evidence-fixture", counter.id)?.relation).toBe("contradicts");
  expect(f.board.get(f.task.id)).toEqual(before);
  expect(f.board.researchEvidenceIntegrity()).toMatchObject({ links: 2, revisions: 2 });
  expect(JSON.stringify([support, counter, f.notices])).not.toMatch(/CLAIM_TEXT_CANARY|private-origin-canary|source A|counterevidence/);
  // No locator or converter verification is claimed in T1, even for valid but unresolvable proposals.
  const declared = await f.tasks.evidenceRecord("codex", { ...f.input(), projectionSha256: "a".repeat(64), locator: { start: 1000, end: 1001 } });
  expect(f.board.evidenceLink("evidence-fixture", declared.id)?.locator).toEqual({ start: 1000, end: 1001 });
});

test("#931 T1 exact replay writes nothing, survives restart, and retains every link revision", async () => {
  const f = await fixture(), input = f.input();
  const { revision: _default, ...withoutRevision } = input;
  const first = await f.tasks.evidenceRecord("codex", withoutRevision), generation = f.board.statusRevision(), initial = f.board.researchEvidenceIntegrity();
  expect(await f.tasks.evidenceRecord("codex", input)).toEqual(first);
  expect(f.board.statusRevision()).toBe(generation);
  expect(f.board.researchEvidenceIntegrity()).toEqual(initial);
  const changed = await f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 2, relation: "context" });
  expect(changed).toEqual({ ...first, revision: 2 });
  expect(f.board.evidenceLink("evidence-fixture", first.id, 1)?.relation).toBe("supports");
  expect(f.board.evidenceLink("evidence-fixture", first.id)?.relation).toBe("context");
  const saved = f.board.researchEvidenceIntegrity();
  f.restart();
  expect(f.board.researchEvidenceIntegrity()).toEqual(saved);
  const restartedGeneration = f.board.statusRevision();
  expect(await f.tasks.evidenceRecord("codex", input)).toEqual(first);
  expect(f.board.statusRevision()).toBe(restartedGeneration);
  expect(f.board.evidenceLink("other-project", first.id)).toBeUndefined();
  await refused(f.tasks.evidenceRecord("codex", { ...input, id: first.id, relation: "contradicts" }));
  await expect(f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 4 })).rejects.toThrow("out of sequence");
  expect(f.board.researchEvidenceIntegrity()).toEqual(saved);
});

test("#931 and #901 share claim identity, list revision and exact-list restoration without duplicate judgments", async () => {
  const f = await fixture(), identity = taskClaimIdentity(f.task, 1), input = f.input();
  expect(identity.claimId).toBe(`claim:${f.task.id}:${f.task.created}:1`);
  expect(identity.claimRevision).toBe(claimListId(CLAIMS));
  expect(taskClaimIdentity({ ...f.task, created: f.task.created + 1 }, 1).claimId).not.toBe(identity.claimId);
  f.tasks.recordClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", model: "fixture", modelVerdict: "supported" });
  const first = await f.tasks.evidenceRecord("codex", input);
  expect(f.board.get(f.task.id)!.history.findLast(entry => entry.event === "claim verdict")?.claim).toEqual({ slot: 1, verdict: "supported", model: "fixture", modelVerdict: "supported", list: identity.claimRevision });
  f.tasks.accept("codex", f.task.id, { claims: ["changed first claim", CLAIMS[1]!] });
  expect(taskClaimIdentity(f.board.get(f.task.id)!, 1).claimRevision).not.toBe(identity.claimRevision);
  await refused(f.tasks.evidenceRecord("codex", input));
  f.tasks.accept("codex", f.task.id, { claims: CLAIMS });
  expect(taskClaimIdentity(f.board.get(f.task.id)!, 1)).toEqual(identity);
  expect(await f.tasks.evidenceRecord("codex", input)).toEqual(first);
  expect(f.board.get(f.task.id)!.history.filter(entry => entry.event === "claim verdict")).toHaveLength(1);
  expect(f.board.researchEvidenceIntegrity()).toMatchObject({ links: 1, revisions: 1 });
});

for (const failure of ["foreign owner", "remote actor", "missing task", "person override", "dev task", "outside project", "inactive", "unknown source", "raw hash", "stale claim", "private task", "private source", "private turn", "spoofed actor"] as const) {
  test(`#931 T1 refuses ${failure} before any evidence write`, async () => {
    const f = await fixture(); let input: unknown = f.input(), by = "codex";
    if (failure === "foreign owner") by = "kimi";
    if (failure === "remote actor") by = "codex@foreign-project";
    if (failure === "missing task") input = { ...f.input(), taskId: 999999, claimId: `claim:999999:${f.task.created}:1` };
    if (failure === "person override") by = "user";
    if (failure === "dev task") {
      const task = f.board.propose("codex", { title: "Dev task", class: "test", plan: { claims: CLAIMS } });
      input = f.input(f.board.update(task.id, "codex", "accepted", { state: "in_progress", owner: "codex" }));
    }
    if (failure === "outside project") f.board.update(f.task.id, "codex", "repository changed", { refs: { repo: "example/foreign" } });
    if (failure === "inactive") {
      f.board.update(f.task.id, "codex", "done", { state: "in_review" });
      f.board.update(f.task.id, "user", "changes_requested", { state: "changes_requested" });
      expect(f.board.get(f.task.id)?.state).toBe("changes_requested");
    }
    if (failure === "unknown source") input = { ...f.input(), sourceId: "src:0000000000000000" };
    if (failure === "raw hash") input = { ...f.input(), rawSha256: "f".repeat(64) };
    if (failure === "stale claim") input = { ...f.input(), claimRevision: "f".repeat(16) };
    if (failure === "private task") f.board.update(f.task.id, "user", "private", { signals: ["pii"] });
    if (failure === "private source") f.registry.markPrivate(f.first.id);
    if (failure === "private turn") f.control.privateTurn = true;
    if (failure === "spoofed actor") input = { ...f.input(), recordedBy: "user" };
    const before = f.board.researchEvidenceIntegrity(), task = f.board.get(f.task.id), generation = f.board.statusRevision();
    await refused(f.tasks.evidenceRecord(by, input));
    expect(f.board.researchEvidenceIntegrity()).toEqual(before);
    expect(f.board.get(f.task.id)).toEqual(task);
    expect(f.board.statusRevision()).toBe(generation);
  });
}

for (const change of ["owner", "claims", "source hash", "source private", "private turn", "hold", "unknown screen"] as const) {
  test(`#931 T1 rechecks ${change} after asynchronous admission`, async () => {
    const f = await fixture(), input = f.input();
    f.control.screen = async () => {
      if (change === "owner") f.board.update(f.task.id, "user", "reassigned", { owner: "kimi" });
      if (change === "claims") f.board.update(f.task.id, "codex", "plan changed", { plan: { claims: ["replacement"] } });
      if (change === "source hash") f.control.hash = "a".repeat(64);
      if (change === "source private") f.registry.markPrivate(f.first.id);
      if (change === "private turn") f.control.privateTurn = true;
      if (change === "hold") f.control.held = true;
      if (change === "unknown screen") f.control.screenLabel = "unknown";
    };
    await refused(f.tasks.evidenceRecord("codex", input));
    expect(f.board.hasResearchEvidenceState()).toBe(false);
  });
}

test("#931 T1 recovery drain tracks an admitted evidence write and fences it when stopping", async () => {
  const f = await fixture(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.control.screen = async () => { enter(); await gate; };
  const recording = f.tasks.evidenceRecord("codex", f.input());
  const outcome = recording.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
  await entered;
  expect(f.tasks.studiesPending()).toBe(1);
  const stopping = f.tasks.stopStudies(); release();
  const result = await outcome; await stopping;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("held evidence write unexpectedly completed");
  expect(result.error).toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.studiesPending()).toBe(0);
  expect(f.board.hasResearchEvidenceState()).toBe(false);
});

test("#931 T1 a source upgraded to private cannot be replayed from a formerly public link", async () => {
  const f = await fixture(), input = f.input(); await f.tasks.evidenceRecord("codex", input);
  const before = f.board.researchEvidenceIntegrity(), generation = f.board.statusRevision();
  f.registry.markPrivate(f.first.id);
  await refused(f.tasks.evidenceRecord("codex", input));
  expect(f.board.researchEvidenceIntegrity()).toEqual(before);
  expect(f.board.statusRevision()).toBe(generation);
});

test("#931 T1 storage rechecks the task fence and integrity detects missing immutable revisions", async () => {
  const f = await fixture(), input = f.input(), first = await f.tasks.evidenceRecord("codex", input);
  const link = f.board.evidenceLink("evidence-fixture", first.id)!;
  const before = f.board.researchEvidenceIntegrity(), task = f.board.get(f.task.id)!;
  expect(() => f.board.recordEvidenceLink("evidence-fixture", { ...link, revision: 2, relation: "context" }, { taskFlowRevision: task.history.length - 1, taskCreated: task.created, owner: "codex" })).toThrow("authority changed");
  expect(f.board.researchEvidenceIntegrity()).toEqual(before);
  await f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 2, relation: "context" });
  const db = (f.board as unknown as { db: Database }).db;
  db.query("DELETE FROM research_evidence_links WHERE project=? AND id=? AND revision=1").run("evidence-fixture", first.id);
  expect(() => f.board.researchEvidenceIntegrity()).toThrow("revision history is incomplete");
});

test("#931 T1 missing and foreign evidence tasks have actionable errors without private repository refs", async () => {
  const f = await fixture(), input = f.input();
  const missing = await refused(f.tasks.evidenceRecord("codex", { ...input, taskId: 999999, claimId: `claim:999999:${f.task.created}:1` }));
  expect((missing as Error).message).toBe("evidence task is unavailable or outside this project; refresh ahub task show and select an active research task in this project");
  f.board.update(f.task.id, "codex", "repository changed", { refs: { repo: "PRIVATE-OWNER/PRIVATE-FOREIGN-REFERENCE" } });
  const generation = f.board.statusRevision(), before = f.board.get(f.task.id);
  const repositories = new TaskRepositories(f.cwd);
  expect(repositories.scope(before!.refs).key).not.toBe(repositories.scope({}).key);
  expect(before).toMatchObject({ owner: "codex", profile: "research", state: "in_progress" });
  const foreign = await refused(f.tasks.evidenceRecord("codex", input));
  expect((foreign as Error).message).toBe((missing as Error).message);
  expect(String(foreign)).not.toContain("PRIVATE-OWNER");
  expect(String(foreign)).not.toContain("PRIVATE-FOREIGN-REFERENCE");
  expect(f.board.get(f.task.id)).toEqual(before);
  expect(f.board.statusRevision()).toBe(generation);
  expect(f.board.hasResearchEvidenceState()).toBe(false);
});

test("#931 T1 corrupt stored JSON, schema and hashes never echo stored private bytes or write on record replay", async () => {
  const f = await fixture(), input = f.input(), receipt = await f.tasks.evidenceRecord("codex", input);
  const stored = f.board.evidenceLink("evidence-fixture", receipt.id)!;
  const db = (f.board as unknown as { db: Database }).db, marker = "STORED_PRIVATE_EVIDENCE_CANARY";
  const invalidBodies = [`{"private":"${marker}"`, JSON.stringify({ private: marker }), JSON.stringify({ ...stored, projectionVersion: marker })];
  for (const body of invalidBodies) {
    db.query("UPDATE research_evidence_links SET body=? WHERE project=? AND id=?").run(body, "evidence-fixture", receipt.id);
    const generation = f.board.statusRevision(), before = f.board.get(f.task.id), rows = db.query("SELECT COUNT(*) AS n FROM research_evidence_links").get();
    let readError: unknown;
    try { f.board.evidenceLink("evidence-fixture", receipt.id); } catch (error) { readError = error; }
    expect(readError).toBeInstanceOf(Error);
    expect((readError as Error).message).toBe("evidence storage invalid; inspect the evidence record before retrying");
    expect(String((readError as Error).stack)).not.toContain(marker);
    let writeError: unknown;
    try { await f.tasks.evidenceRecord("codex", input); } catch (error) { writeError = error; }
    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as Error).message).toBe((readError as Error).message);
    expect(String((writeError as Error).stack)).not.toContain(marker);
    expect(f.board.statusRevision()).toBe(generation);
    expect(f.board.get(f.task.id)).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM research_evidence_links").get()).toEqual(rows);
    expect(db.query("SELECT body FROM research_evidence_links WHERE project=? AND id=?").get("evidence-fixture", receipt.id)).toEqual({ body });
  }
});

for (const policy of ["PII patterns", "private paths", "unavailable policy (throws)"] as const) {
  test(`#931 T1 metadata policy is revalidated after screening: ${policy}`, async () => {
    const f = await fixture(), input = { ...f.input(), projectionVersion: "public/evidence.md" };
    expect(f.tasks.publicMetadataText(JSON.stringify(input))).toBe(true);
    const before = f.board.get(f.task.id), generation = f.board.statusRevision();
    f.control.screen = async () => {
      if (policy === "PII patterns") f.patterns.push("public/evidence.md");
      if (policy === "private paths") f.piiPaths.push("public/evidence.md");
      if (policy === "unavailable policy (throws)") f.control.routingUnavailable = true;
    };
    const error = await refused(f.tasks.evidenceRecord("codex", input));
    expect((error as Error).message).toBe("evidence metadata is private or sensitive; remove sensitive metadata before recording a public link");
    expect(String(error)).not.toContain("POLICY_UNAVAILABLE_CANARY");
    expect(f.board.get(f.task.id)).toEqual(before);
    expect(f.board.statusRevision()).toBe(generation);
    expect(f.board.hasResearchEvidenceState()).toBe(false);
    expect(f.tasks.studiesPending()).toBe(0);
  });
}
