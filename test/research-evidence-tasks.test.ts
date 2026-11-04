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
import { SourceRegistry, sha256Of, sourceProjectionReceipt, SOURCE_UTF8_PROJECTION_VERSION } from "../src/hub/sources.ts";
import { readEvidenceSource } from "../src/hub/source-read.ts";
import { TaskRepositories } from "../src/hub/task-repository.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { evidenceLinkCanonical, type EvidenceRecordInput, type EvidenceLinkV1 } from "../src/hub/research-evidence.ts";
import { EVIDENCE_READ_TOOL, TASK_TOOLS, TASK_TOOL_NAMES, IMPLEMENTER_HUB_TOOL_NAMES, profileTaskTools, projectToolList } from "../src/hub/hub-tools.ts";
import { MemoryStore, CandidateStore } from "@staix/agent-mem";

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
  const control: { privateTurn: boolean; held: boolean; hash?: string; screen?: () => Promise<void>; screenLabel: "clear" | "pii" | "unknown"; routingUnavailable?: boolean; evidenceRead?: TasksDeps["evidenceSourceRead"] } = { privateTurn: false, held: false, screenLabel: "clear" };
  const patterns: string[] = [], piiPaths: string[] = [];
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"], kimi: ["implementer"], local: ["implementer"] };
  const build = () => new Tasks({ cwd, board, bus, project: "evidence-fixture", profile: "research", roles, notify: line => notices.push(line),
    routing: () => { if (control.routingUnavailable) throw new Error("POLICY_UNAVAILABLE_CANARY"); const routing = loadRouting(cwd); return { ...routing, signals: { ...routing.signals, pii_patterns: [...routing.signals.pii_patterns, ...patterns], ...(control.screen ? { pii_screen: "local" as const } : {}) } }; }, piiPaths,
    privateTurn: () => control.privateTurn, sweepHeld: () => control.held,
    piiScreen: async () => { await control.screen?.(); return control.screenLabel === "unknown" ? { label: "unknown" as const, miss: "failed" as const, ms: 0 } : { label: control.screenLabel, ms: 0 }; },
    intake: { sourceKnown: id => !!registry.get(id), split: async () => undefined, partsSchema: () => ({}) },
    evidenceSourceRead: (by, link, current) => control.evidenceRead?.(by, link, current) ?? Promise.resolve({ resolution: { status: "unavailable" as const, cause: "projection_missing" as const } }),
    evidenceSourceMeta: id => registry.get(id),
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
  const outOfSequence = await refused(f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 4 }));
  expect((outOfSequence as Error).message).toContain("out of sequence");
  expect((outOfSequence as Error).message).toContain("expected next revision 3");
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
    expect((readError as Error).message).toBe("evidence storage invalid; stop the hub and restore a trusted hub.db backup; then restart and retry");
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

test("#931 T1 public claim bindings can be recorded and become stale after a claim edit", async () => {
  const f = await fixture();
  const bindings = f.tasks.publicView(f.board.get(f.task.id)!).claims as ReturnType<typeof taskClaimIdentity>[];
  expect(bindings).toEqual(CLAIMS.map((_claim, index) => taskClaimIdentity(f.task, index + 1)));
  for (const binding of bindings) expect(Object.keys(binding).sort()).toEqual(["claimId", "claimRevision", "slot"]);
  expect(JSON.stringify(bindings)).not.toContain("CLAIM_TEXT_CANARY");
  const binding = bindings[0]!, input = { ...f.input(), claimId: binding.claimId, claimRevision: binding.claimRevision };
  await f.tasks.evidenceRecord("codex", input);
  f.tasks.accept("codex", f.task.id, { claims: ["edited claim", CLAIMS[1]!] });
  const changed = f.tasks.publicView(f.board.get(f.task.id)!).claims as ReturnType<typeof taskClaimIdentity>[];
  expect(changed[0]?.claimId).toBe(binding.claimId);
  expect(changed[0]?.claimRevision).not.toBe(binding.claimRevision);
  const generation = f.board.statusRevision(), before = f.board.researchEvidenceIntegrity();
  const error = await refused(f.tasks.evidenceRecord("codex", input));
  expect((error as Error).message).toContain("claim revision changed");
  expect((error as Error).message).toContain("hub_task_show or ahub task show --json");
  expect(f.board.statusRevision()).toBe(generation);
  expect(f.board.researchEvidenceIntegrity()).toEqual(before);
});

test("#931 T1 private, dev and malformed optional claim views expose no claim bindings", async () => {
  const f = await fixture();
  for (const signal of ["pii", "pii_path"]) {
    const task = f.board.update(f.task.id, "user", "privacy changed", { signals: [signal] });
    const view = f.tasks.publicView(task);
    expect(view).not.toHaveProperty("claims");
    expect(JSON.stringify(view)).not.toContain("CLAIM_TEXT_CANARY");
  }
  // Even a routing opt-out cannot publish new bindings for raw PII signals.
  const raw = f.board.get(f.task.id)!;
  const permissiveBus = new Bus({ batchMs: 0 }); cleanup.push(() => permissiveBus.closeJournal());
  const permissive = new Tasks({ cwd: f.cwd, board: f.board, bus: permissiveBus, project: "evidence-fixture", routing: () => { const routing = loadRouting(f.cwd); return { ...routing, constraints: { ...routing.constraints, pii: "off" as const } }; }, notify: () => {} });
  expect(permissive.publicView({ ...raw, signals: ["pii"] })).not.toHaveProperty("claims");
  const dev = f.board.propose("codex", { title: "Dev fixture", class: "test", plan: { claims: CLAIMS } });
  expect(f.tasks.publicView(dev)).not.toHaveProperty("claims");
  expect(f.tasks.publicView(dev).plan).toEqual(dev.plan);
  const current = { ...raw, signals: [] };
  expect(() => f.tasks.publicView({ ...current, created: NaN })).not.toThrow();
  expect(f.tasks.publicView({ ...current, created: NaN })).not.toHaveProperty("claims");
  const malformed = { ...current, plan: { claims: [null] } } as unknown as Task;
  expect(() => f.tasks.publicView(malformed)).not.toThrow();
  expect(f.tasks.publicView(malformed)).not.toHaveProperty("claims");
});

test("#931 T1 sequence and claim association refuse before screening or storage", async () => {
  const f = await fixture(), input = f.input(), first = await f.tasks.evidenceRecord("codex", input);
  let screens = 0; f.control.screen = async () => { screens++; };
  const generation = f.board.statusRevision(), before = f.board.researchEvidenceIntegrity(), task = f.board.get(f.task.id);
  const sequence = await refused(f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 3 }));
  expect((sequence as Error).message).toContain("expected next revision 2");
  const association = await refused(f.tasks.evidenceRecord("codex", { ...f.input(f.board.get(f.task.id)!, f.first.id, 2), id: first.id, revision: 2 }));
  expect((association as Error).message).toContain("belongs to another claim");
  expect(screens).toBe(0);
  expect(f.board.statusRevision()).toBe(generation);
  expect(f.board.researchEvidenceIntegrity()).toEqual(before);
  expect(f.board.get(f.task.id)).toEqual(task);
});

for (const drift of ["revision", "claim association"] as const) test(`#931 T1 ${drift} is checked again after screening`, async () => {
  const f = await fixture(), input = f.input(), first = await f.tasks.evidenceRecord("codex", input);
  const original = f.board.evidenceLink("evidence-fixture", first.id)!, task = f.board.get(f.task.id)!;
  let expected = f.board.researchEvidenceIntegrity(), generation = f.board.statusRevision();
  f.control.screen = async () => {
    if (drift === "revision") f.board.recordEvidenceLink("evidence-fixture", { ...original, revision: 2, relation: "context" }, { owner: "codex", taskCreated: task.created, taskFlowRevision: task.history.length });
    else {
      const body = evidenceLinkCanonical({ ...original, claimId: taskClaimIdentity(task, 2).claimId });
      (f.board as unknown as { db: Database }).db.query("UPDATE research_evidence_links SET body=?,body_sha256=? WHERE project=? AND id=?").run(body, sha256Of(Buffer.from(body)), "evidence-fixture", first.id);
    }
    expected = f.board.researchEvidenceIntegrity(); generation = f.board.statusRevision();
  };
  const error = await refused(f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 2, relation: "contradicts" }));
  expect((error as Error).message).toContain(drift === "revision" ? "next revision 3" : "belongs to another claim");
  expect(f.board.researchEvidenceIntegrity()).toEqual(expected);
  expect(f.board.statusRevision()).toBe(generation);
  expect(f.board.get(f.task.id)).toEqual(task);
});

// These host-port fixtures isolate Tasks admission and projections; real immutable resolver/Unicode fixtures live in research-evidence-locator and source-read tests.
const resolvedRead = (link: EvidenceLinkV1) => ({ resolution: { status: "resolved" as const, locator: link.locator, excerpt: "PASSAGE_CANARY", excerptSha256: sha256Of(Buffer.from("PASSAGE_CANARY")) } });

test("#931 T2 Tasks resolves a real registered scalar projection afresh and withholds later private upgrades", async () => {
  const f = await fixture(), text = "앞🙂é뒤", bytes = Buffer.from(text);
  const source = f.registry.add({ bytes, kind: "file", origin: "/real-projection.txt", private: false, text, projection: sourceProjectionReceipt(bytes, text) });
  const receipt = await f.tasks.evidenceRecord("codex", { ...f.input(f.board.get(f.task.id)!, source.id), projectionSha256: sha256Of(bytes), projectionVersion: SOURCE_UTF8_PROJECTION_VERSION, locator: { start: 1, end: 4 } });
  let screens = 0;
  f.control.evidenceRead = (_by, link, current) => readEvidenceSource(f.registry, link, { valid: current, canReadPrivate: async () => false, projectionVersion: () => SOURCE_UTF8_PROJECTION_VERSION, screen: async () => { screens++; return true; } });
  const resolved = await f.tasks.evidenceRead("codex", { id: receipt.id }); expect(resolved.status).toBe("resolved");
  if (resolved.status === "resolved") { expect(resolved.excerpt).toBe("🙂é"); expect(resolved.locator).toEqual({ start: 1, end: 4 }); expect(resolved.excerptSha256).toBe(sha256Of(Buffer.from("🙂é"))); }
  await f.tasks.evidenceRead("codex", { id: receipt.id }); expect(screens).toBe(2);
  f.registry.markPrivate(source.id);
  expect(await f.tasks.evidenceRead("codex", { id: receipt.id })).toEqual({ ...receipt, status: "private" });
});

test("#931 T2 research-only read publication preserves dev schemas and read-only availability", () => {
  expect(profileTaskTools("dev")).toBe(TASK_TOOLS);
  expect(TASK_TOOLS.some(tool => tool.name === EVIDENCE_READ_TOOL.name)).toBe(false);
  expect(profileTaskTools("research").some(tool => tool.name === EVIDENCE_READ_TOOL.name)).toBe(true);
  expect(projectToolList(profileTaskTools("research"), true).some(tool => tool.name === EVIDENCE_READ_TOOL.name)).toBe(true);
  expect(TASK_TOOL_NAMES.has(EVIDENCE_READ_TOOL.name)).toBe(true); expect(IMPLEMENTER_HUB_TOOL_NAMES).toContain(EVIDENCE_READ_TOOL.name);
  expect(EVIDENCE_READ_TOOL.inputSchema.additionalProperties).toBe(false); expect(EVIDENCE_READ_TOOL.inputSchema.properties).not.toHaveProperty("taskId");
});

test("#931 T2 reads re-resolve every call, retain declared relation and never write task or verdict state", async () => {
  const f = await fixture(), receipt = await f.tasks.evidenceRecord("codex", f.input()); let reads = 0;
  f.control.evidenceRead = async (_by, link, current) => { expect(current()).toBe(true); reads++; return resolvedRead(link); };
  const before = f.board.get(f.task.id), generation = f.board.statusRevision(), integrity = f.board.researchEvidenceIntegrity();
  for (const by of ["codex", "claude", "user"]) {
    const result = await f.tasks.evidenceRead(by, { id: receipt.id }); expect(result.status).toBe("resolved");
    if (result.status === "resolved") { expect(result.link.relation).toBe("supports"); expect(result.excerpt).toBe("PASSAGE_CANARY"); expect(result.origins.state).toBe("known"); }
    expect(JSON.stringify(result)).not.toMatch(/CLAIM_TEXT_CANARY|private-origin-canary/);
  }
  expect(reads).toBe(3); expect(f.board.get(f.task.id)).toEqual(before); expect(f.board.statusRevision()).toBe(generation); expect(f.board.researchEvidenceIntegrity()).toEqual(integrity);
  expect(JSON.stringify(f.notices)).not.toContain("PASSAGE_CANARY");
});

for (const change of ["source private", "private turn", "task private", "claims", "metadata policy", "policy unavailable", "owner"] as const) {
  test(`#931 T2 ${change} during awaited read cannot release an old public excerpt`, async () => {
    const f = await fixture(), receipt = await f.tasks.evidenceRecord("codex", f.input());
    let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.control.evidenceRead = async (_by, link) => { entered(); await gate; return resolvedRead(link); };
    const reading = f.tasks.evidenceRead("codex", { id: receipt.id }), outcome = reading.then(value => ({ value }), error => ({ error: error as unknown }));
    await started;
    if (change === "source private") f.registry.markPrivate(f.first.id);
    if (change === "private turn") f.control.privateTurn = true;
    if (change === "task private") f.board.update(f.task.id, "user", "privacy tightened", { signals: ["pii"] });
    if (change === "claims") f.board.update(f.task.id, "codex", "claims edited", { plan: { claims: ["new claim"] } });
    if (change === "metadata policy") f.patterns.push("PASSAGE_CANARY");
    if (change === "policy unavailable") f.control.routingUnavailable = true;
    if (change === "owner") f.board.update(f.task.id, "user", "reassigned", { owner: "kimi" });
    const generation = f.board.statusRevision(), integrity = f.board.researchEvidenceIntegrity(); release(); const result = await outcome;
    if (change === "owner") { expect("error" in result).toBe(true); if ("error" in result) expect(result.error).toBeInstanceOf(PreEffectToolRefusal); }
    else {
      expect("value" in result).toBe(true); if ("value" in result) { expect(result.value.status).toBe(change === "claims" ? "stale" : "private"); expect(Object.keys(result.value).sort()).toEqual(["id", "revision", "status", "taskId"]); }
    }
    expect(JSON.stringify("error" in result && result.error instanceof Error ? { error: result.error.message } : result)).not.toMatch(/PASSAGE_CANARY|CLAIM_TEXT_CANARY|private-origin-canary|POLICY_UNAVAILABLE_CANARY/);
    expect(f.board.statusRevision()).toBe(generation); expect(f.board.researchEvidenceIntegrity()).toEqual(integrity);
  });
}

test("#931 T2 unknown, foreign, dev and unauthorized reads refuse before consulting the source port", async () => {
  const f = await fixture(), receipt = await f.tasks.evidenceRecord("codex", f.input()); let reads = 0;
  f.control.evidenceRead = async (_by, link) => { reads++; return resolvedRead(link); };
  for (const input of [{ id: `ev:${"0".repeat(32)}` }, { id: receipt.id, revision: 0 }, { id: receipt.id, taskId: f.task.id }, Object.defineProperty({}, "id", { get() { throw new Error("GETTER_CANARY"); } })]) await refused(f.tasks.evidenceRead("codex", input));
  for (const by of ["kimi", "codex@remote"]) await refused(f.tasks.evidenceRead(by, { id: receipt.id }));
  f.board.update(f.task.id, "user", "foreign metadata", { refs: { repo: "PRIVATE-OWNER/PRIVATE-FOREIGN-REFERENCE" } });
  await refused(f.tasks.evidenceRead("codex", { id: receipt.id }));
  f.board.update(f.task.id, "user", "project metadata restored", { refs: { repo: undefined } });
  (f.board as unknown as { db: Database }).db.query("UPDATE tasks SET project_profile=NULL WHERE id=?").run(f.task.id);
  expect(f.board.get(f.task.id)?.profile ?? "dev").toBe("dev"); await refused(f.tasks.evidenceRead("codex", { id: receipt.id }));
  expect(reads).toBe(0);
});

test("#931 T2 connected shared registered origins group transitively; private members make groups unknown", async () => {
  const f = await fixture();
  const a = await f.tasks.evidenceRecord("codex", f.input());
  f.registry.add({ bytes: Buffer.from("source A α🙂 passage"), kind: "url", origin: "https://example.test/shared", private: false, text: "source A α🙂 passage" });
  f.registry.add({ bytes: Buffer.from("source B counterevidence"), kind: "url", origin: "https://example.test/shared", private: false, text: "source B counterevidence" });
  f.registry.add({ bytes: Buffer.from("source B counterevidence"), kind: "url", origin: "https://example.test/shared-second", private: false, text: "source B counterevidence" });
  await f.tasks.evidenceRecord("codex", f.input(f.board.get(f.task.id)!, f.second.id));
  const third = f.registry.add({ bytes: Buffer.from("third distinct passage"), kind: "file", origin: "/third-origin.txt", private: false, text: "third distinct passage" });
  f.registry.add({ bytes: Buffer.from("third distinct passage"), kind: "url", origin: "https://example.test/shared-second", private: false, text: "third distinct passage" });
  await f.tasks.evidenceRecord("codex", f.input(f.board.get(f.task.id)!, third.id));
  const fourth = f.registry.add({ bytes: Buffer.from("fourth passage"), kind: "file", origin: "/fourth-origin.txt", private: false, text: "fourth passage" });
  await f.tasks.evidenceRecord("codex", f.input(f.board.get(f.task.id)!, fourth.id));
  f.control.evidenceRead = async (_by, link) => resolvedRead(link);
  const known = await f.tasks.evidenceRead("codex", { id: a.id }); expect(known.status).toBe("resolved");
  if (known.status === "resolved") { expect(known.origins.state).toBe("known"); if (known.origins.state === "known") expect(known.origins.groups).toBe(2); }
  expect(JSON.stringify(known)).not.toMatch(/example.test|third-origin|private-origin-canary/);
  f.registry.markPrivate(f.second.id);
  const privateMember = await f.tasks.evidenceRead("codex", { id: a.id }); expect(privateMember.status).toBe("resolved");
  if (privateMember.status === "resolved") expect(privateMember.origins).toEqual({ state: "unknown" });
});

test("#931 T2 latest inventory retains one revision per link and overflow never certifies complete groups", async () => {
  const f = await fixture(), input = f.input(), first = await f.tasks.evidenceRecord("codex", input);
  await f.tasks.evidenceRecord("codex", { ...input, id: first.id, revision: 2, relation: "context" });
  const identity = taskClaimIdentity(f.board.get(f.task.id)!, 1), inventory = () => f.board.latestEvidenceLinks("evidence-fixture", f.task.id, identity.claimId, identity.claimRevision, 128);
  expect(inventory()).toMatchObject({ complete: true }); expect(inventory().links).toHaveLength(1); expect(inventory().links[0]?.revision).toBe(2);
  for (let index = 1; index <= 128; index++) await f.tasks.evidenceRecord("codex", { ...input, locator: { start: index, end: index + 1 } });
  expect(inventory().complete).toBe(false); expect(inventory().links).toHaveLength(128);
  f.control.evidenceRead = async (_by, link) => resolvedRead(link);
  const read = await f.tasks.evidenceRead("codex", { id: first.id }); if (read.status !== "resolved") throw new Error("expected public selected link"); expect(read.origins).toEqual({ state: "unknown" });
});

test("#931 T2 observer provenance is latched before done awaits and keeps derived summary/review out of screens and memory sidecars", async () => {
  const f = await fixture(), home = join(f.cwd, "observer-memory"), store = new MemoryStore({ home, deferPromotions: true }), candidates = new CandidateStore({ home });
  cleanup.push(() => { candidates.close(); store.close(); });
  let excluded = true, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const screens: string[] = [], published: string[] = [];
  f.bus.tap(event => { if (event.t === "envelope") published.push(event.env.body); });
  const tasks = new Tasks({ cwd: f.cwd, board: f.board, bus: f.bus, project: "observer-fixture", profile: "research", roles: { codex: ["implementer"], claude: ["planner", "reviewer"] }, notify: line => f.notices.push(line),
    routing: () => { const routing = loadRouting(f.cwd); return { ...routing, signals: { ...routing.signals, pii_screen: "local" as const } }; },
    observerExcludedTurn: () => excluded, piiScreen: async text => { screens.push(text); return { label: "clear", ms: 0 }; },
    prepareReviewBrief: async () => { entered(); await gate; }, store: { store, project: "observer-fixture", repo: "fixture" }, candidates });
  const summary = "EVIDENCE_DERIVED_SUMMARY_CANARY source origin /derived/private/report.txt";
  const finishing = tasks.done("codex", f.task.id, summary); await started; excluded = false; release(); await finishing;
  expect(screens).toEqual([]); const done = f.board.get(f.task.id)!;
  expect(done.history.findLast(entry => entry.event === "done")).toMatchObject({ note: summary, withheld: true });
  expect(JSON.stringify(tasks.publicView(done, true))).not.toContain("EVIDENCE_DERIVED_SUMMARY_CANARY");
  excluded = true;
  await tasks.review("claude", f.task.id, "changes_requested", "EVIDENCE_DERIVED_REVIEW_CANARY", undefined, undefined, undefined, [{ id: "derived-finding", pass: "bugs", severity: "important", disposition: "open", rationale: "EVIDENCE_DERIVED_FINDING_CANARY" }]);
  expect(screens).toEqual([]); expect(store.list({ project: "observer-fixture", limit: 100, includeSuperseded: true })).toEqual([]); expect(candidates.list({ project: "observer-fixture" })).toEqual([]);
  expect(JSON.stringify([published, f.notices, tasks.publicView(f.board.get(f.task.id)!, true)])).not.toMatch(/EVIDENCE_DERIVED_|derived\/private\/report/);
});

for (const code of [0, 1]) test(`#931 T2 observer exclusion survives asynchronous check exit ${code} and hides raw check tail`, async () => {
  const f = await fixture(); let excluded = true, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), published: string[] = [];
  f.bus.tap(event => { if (event.t === "envelope") published.push(event.env.body); });
  const tasks = new Tasks({ cwd: f.cwd, board: f.board, bus: f.bus, project: "observer-fixture", profile: "research", roles: { codex: ["implementer"], claude: ["planner", "reviewer"] }, routing: () => loadRouting(f.cwd), notify: line => f.notices.push(line),
    observerExcludedTurn: () => excluded, check: () => "fixture-check", runCheck: async () => { entered(); await gate; return { code, timedOut: false, tail: "EVIDENCE_CHECK_TAIL_CANARY" }; } });
  await tasks.done("codex", f.task.id, "EVIDENCE_PENDING_SUMMARY_CANARY"); await started; excluded = false; release();
  await (tasks as unknown as { checkQueue: Promise<void> }).checkQueue;
  const task = f.board.get(f.task.id)!, check = task.history.findLast(entry => entry.event === (code ? "check failed" : "check passed"));
  expect(check?.note).toContain("EVIDENCE_CHECK_TAIL_CANARY"); expect(check?.withheld).toBe(true);
  expect(JSON.stringify([published, f.notices, tasks.publicView(task, true)])).not.toMatch(/EVIDENCE_CHECK_TAIL_CANARY|EVIDENCE_PENDING_SUMMARY_CANARY/);
});
