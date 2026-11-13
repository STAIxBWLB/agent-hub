import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board, taskClaimIdentity } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { SourceRegistry, sourceProjectionReceipt } from "../src/hub/sources.ts";
import { evidenceSnapshotKey, readEvidenceSource } from "../src/hub/source-read.ts";
import { hashDeliverables } from "../src/hub/deliverable-files.ts";
import { evidenceLinkId, parseEvidenceLink, type EvidenceRecordInput } from "../src/hub/research-evidence.ts";
import { synthesisManifestHash, type SynthesisManifestV1 } from "../src/hub/synthesis-readiness.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }

async function fixture(personVerdict = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-synthesis-tasks-")), project = "synthesis-fixture";
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 }), registry = new SourceRegistry(cwd);
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["codex", "claude", "kimi"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const control: { privateTurn: boolean; held: boolean; privacyModel?: boolean; projectionVersion?: string; screen?: (id: string) => Promise<void>; reads: string[]; offline: boolean[] } = { privateTurn: false, held: false, reads: [], offline: [] };
  const sources = ["SOURCE_PASSAGE_CANARY support 한🙂", "SOURCE_PASSAGE_CANARY counterevidence"].map((text, index) => {
    const bytes = Buffer.from(text), projection = sourceProjectionReceipt(bytes, text)!;
    const added = registry.add({ bytes, text, projection, kind: "file", origin: `ORIGIN_PATH_CANARY/${index}.txt`, private: false });
    return { id: added.id, projection };
  });
  const version = (receipt: { projectionVersion: string }) => control.projectionVersion ?? receipt.projectionVersion;
  const deps: TasksDeps = { cwd, project, board, bus, profile: "research", roles: { codex: ["implementer"], claude: ["planner", "reviewer"], kimi: ["implementer"] },
    notify: () => {}, routing: () => { const routing = loadRouting(cwd); return { ...routing, signals: { ...routing.signals, pii_screen: control.privacyModel ? "local" as const : "off" as const } }; },
    privateTurn: () => control.privateTurn, sweepHeld: () => control.held,
    intake: { sourceKnown: id => !!registry.get(id), split: async () => undefined, partsSchema: () => ({}) },
    studySource: id => { const source = registry.get(id); return source ? { id: source.id, sha256: source.sha256, private: source.private } : undefined; },
    evidenceSourceMeta: id => registry.get(id),
    evidenceSourceSnapshotKey: link => evidenceSnapshotKey(registry, link.sourceId, version),
    evidenceSourceRead: async (_by, link, current, mode) => {
      control.reads.push(link.sourceId); control.offline.push(mode?.privacyReadOnly === true);
      return readEvidenceSource(registry, link, { valid: current, projectionVersion: version, canReadPrivate: async () => false, privacyReadOnly: mode?.privacyReadOnly,
        screen: async (text, source) => { await control.screen?.(source.id); return control.privacyModel ? (await deps.piiScreen?.(text))?.label === "clear" : true; } });
    },
  };
  const tasks = new Tasks(deps);
  const proposed = board.propose("user", { title: "Synthesis fixture", class: "test", profile: "research", profileClass: "fact_check", plan: { claims: ["CLAIM_TEXT_CANARY one"] } });
  const task = board.update(proposed.id, "user", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
  writeFileSync(join(cwd, "report.md"), "A qualified fixture conclusion [@fixture-paper].\n");
  writeFileSync(join(cwd, "references.bib"), "@article{fixture-paper, title={BIBLIOGRAPHY_TEXT_CANARY}}\n");
  const artifacts = await hashDeliverables([{ path: "report.md", format: "md" }, { path: "references.bib", format: "bib" }], { cwd, deny: [], private: () => false });
  board.update(task.id, "codex", "lifecycle", {}, undefined, { deliverables: artifacts });
  const input = (index = 0, relation: EvidenceRecordInput["relation"] = "supports", start = 0): EvidenceRecordInput => {
    const source = sources[index]!, identity = taskClaimIdentity(board.get(task.id)!, 1);
    return { taskId: task.id, claimId: identity.claimId, claimRevision: identity.claimRevision, sourceId: source.id,
      rawSha256: registry.get(source.id)!.sha256, projectionSha256: source.projection.projectionSha256, projectionVersion: source.projection.projectionVersion,
      locator: { start, end: start + 4 }, relation, revision: 1 };
  };
  const support = await tasks.evidenceRecord("codex", input());
  if (personVerdict) tasks.recordClaimVerdict("user", task.id, { slot: 1, verdict: "supported" });
  async function manifest(selected = support.id): Promise<SynthesisManifestV1> {
    const view = await tasks.synthesisEvidence("codex", { taskId: task.id });
    if (view.status !== "available") throw new Error("expected public authoring inventory");
    const claims = view.claims.map(claim => {
      if (!claim.inventory) throw new Error("expected complete inventory binding");
      const evidence = claim.evidence.find(row => row.id === selected);
      return { claimId: claim.claimId, claimRevision: claim.claimRevision, inventory: claim.inventory,
        evidence: evidence ? [{ id: evidence.id, revision: evidence.revision, citationKey: "fixture-paper" }] : [] };
    });
    return { schemaVersion: 1, taskId: task.id, taskCreated: task.created,
      deliverable: { id: artifacts[0]!.id, sha256: artifacts[0]!.sha256 }, bibliography: { id: artifacts[1]!.id, sha256: artifacts[1]!.sha256 }, claims };
  }
  const check = (value: SynthesisManifestV1, by = "codex") => tasks.synthesisCheck(by, { taskId: task.id, manifest: value });
  return { cwd, board, bus, registry, tasks, deps, control, sources, task, support, artifacts, input, manifest, check };
}

test("#931 offline checks reuse configured privacy screening without source fetch or unknown-state mutation", async () => {
  const f = await fixture(), manifest = await f.manifest();
  f.control.privacyModel = true;
  let calls = 0;
  f.deps.piiScreen = async () => { calls++; return { label: "clear", ms: 0 }; };
  const before = f.board.statusRevision();
  expect((await f.check(manifest)).status).toBe("ready");
  expect(calls).toBe(1); expect(f.registry.get(f.sources[0]!.id)?.private).toBe(false);
  f.deps.piiScreen = async () => { calls++; throw new Error("SCREEN_UNAVAILABLE"); };
  expect((await f.check(manifest)).status).toBe("unknown");
  expect(calls).toBe(2); expect(f.registry.get(f.sources[0]!.id)?.private).toBe(false); expect(f.board.statusRevision()).toBe(before);
});

test("#931 an earlier source changed while a later source resolves cannot retain ready", async () => {
  for (const change of ["text", "converter"] as const) {
    const f = await fixture(); await f.tasks.evidenceRecord("codex", f.input(1, "context"));
    const manifest = await f.manifest();
    f.control.screen = async id => {
      if (id !== f.sources[1]!.id) return;
      if (change === "text") writeFileSync(join(f.registry.root, f.sources[0]!.id.replace(":", "-"), "text"), "changed after first source resolution");
      else f.control.projectionVersion = "changed-converter-version";
    };
    expect((await f.check(manifest)).status).toBe("stale");
  }
});

test("#931 a private upgrade inside the final source snapshot fence cannot return ready", async () => {
  const f = await fixture(), manifest = await f.manifest();
  const readRaw = f.registry.readRaw.bind(f.registry), key = f.deps.evidenceSourceSnapshotKey!;
  let calls = 0, armed = false;
  f.registry.readRaw = id => {
    if (armed) { armed = false; f.registry.markPrivate(id); }
    return readRaw(id);
  };
  f.deps.evidenceSourceSnapshotKey = link => {
    if (++calls === 2) armed = true;
    return key(link);
  };
  expect(await f.check(manifest)).toEqual({ taskId: f.task.id, status: "private" });
  expect(calls).toBe(2);
});

test("#931 a later final source fence upgrading an already-fenced source stays private", async () => {
  const f = await fixture(); await f.tasks.evidenceRecord("codex", f.input(1, "context"));
  const manifest = await f.manifest(), key = f.deps.evidenceSourceSnapshotKey!, order: string[] = [], calls = new Map<string, number>();
  let upgraded = false;
  f.deps.evidenceSourceSnapshotKey = link => {
    const count = (calls.get(link.sourceId) ?? 0) + 1; calls.set(link.sourceId, count);
    if (count === 1) order.push(link.sourceId);
    if (count === 2 && link.sourceId === order[1]) { upgraded = true; f.registry.markPrivate(order[0]!); }
    return key(link);
  };
  expect(await f.check(manifest)).toEqual({ taskId: f.task.id, status: "private" });
  expect(upgraded).toBe(true);
});

test("#931 Tasks builds a ready offline provenance report from guarded artifacts and the existing person verdict", async () => {
  const f = await fixture(), manifest = await f.manifest(), before = f.board.statusRevision();
  const result = await f.check(manifest);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("expected ready structural result");
  expect(result.claimCoverage).toBe("complete"); expect(result.scope).toBe("structural_provenance");
  expect(result.claims[0]).toMatchObject({ inventory: "current", provenance: "resolved", locator: "resolved", judgment: "present", contradiction: "none" });
  expect(f.control.offline.every(Boolean)).toBe(true); expect(f.control.offline.length).toBeGreaterThan(0);
  expect(f.board.statusRevision()).toBe(before);
  expect(JSON.stringify(result)).not.toMatch(/CLAIM_TEXT_CANARY|SOURCE_PASSAGE_CANARY|ORIGIN_PATH_CANARY|BIBLIOGRAPHY_TEXT_CANARY|fixture-paper|report\.md|references\.bib|sourceId|excerpt/);
});

test("#931 new unselected counterevidence invalidates the previously ready Tasks manifest", async () => {
  const f = await fixture(), old = await f.manifest();
  expect((await f.check(old)).status).toBe("ready");
  await f.tasks.evidenceRecord("codex", f.input(1, "contradicts"));
  const changed = await f.check(old);
  expect(changed.status).toBe("stale");
  if (!("claims" in changed)) throw new Error("expected independent statuses");
  expect(changed.claims[0]).toMatchObject({ inventory: "stale", judgment: "present", contradiction: "open", locator: "resolved" });
  const current = await f.check(await f.manifest());
  expect(current.status).toBe("not_ready");
  if (!("claims" in current)) throw new Error("expected contradiction status");
  expect(current.claims[0]?.contradiction).toBe("open");
  expect(f.control.reads).toContain(f.sources[1]!.id);
});

test("#931 only an existing person verdict bound to this manifest qualifies an open contradiction", async () => {
  const f = await fixture(); await f.tasks.evidenceRecord("codex", f.input(1, "contradicts"));
  const manifest = await f.manifest(), synthesis = { manifestSha256: synthesisManifestHash(manifest), disposition: "qualified" as const };
  const before = f.board.statusRevision();
  await expect(f.tasks.recordSynthesisClaimVerdict("codex", f.task.id, { slot: 1, verdict: "supported", synthesis }, manifest)).rejects.toThrow("only the console user");
  expect(f.board.statusRevision()).toBe(before);
  expect((await f.check(manifest)).status).toBe("not_ready");
  expect(() => f.tasks.recordClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", synthesis })).toThrow("current manifest validation");
  await expect(f.tasks.recordSynthesisClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", synthesis: { ...synthesis, manifestSha256: "f".repeat(64) } }, manifest)).rejects.toThrow(synthesis.manifestSha256);
  expect(f.board.statusRevision()).toBe(before);
  await f.tasks.recordSynthesisClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", synthesis }, manifest);
  const ready = await f.check(manifest);
  expect(ready.status).toBe("ready");
  if (!("claims" in ready)) throw new Error("expected separate qualification status");
  expect(ready.claims[0]?.contradiction).toBe("qualified");
  await f.tasks.evidenceRecord("codex", f.input(1, "context", 1));
  const currentHash = synthesisManifestHash(await f.manifest()), revised = f.board.statusRevision();
  await expect(f.tasks.recordSynthesisClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", synthesis }, manifest)).rejects.toThrow(`current manifestSha256 ${currentHash}`);
  expect(f.board.statusRevision()).toBe(revised);
  expect((await f.check(manifest)).status).toBe("stale");
  const refreshed = await f.check(await f.manifest());
  expect(refreshed.status).toBe("not_ready");
  if (!("claims" in refreshed)) throw new Error("expected stale disposition not to count");
  expect(refreshed.claims[0]?.contradiction).toBe("open");
});

test("#931 person qualification cannot commit across a privacy upgrade during its snapshot", async () => {
  const f = await fixture(), manifest = await f.manifest(), before = f.board.statusRevision();
  const synthesis = { manifestSha256: synthesisManifestHash(manifest), disposition: "qualified" };
  f.control.screen = async () => { f.registry.markPrivate(f.sources[0]!.id); };
  await expect(f.tasks.recordSynthesisClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", synthesis }, manifest)).rejects.toThrow(/private|unavailable|changed/);
  expect(f.board.statusRevision()).toBe(before);
  expect(f.board.get(f.task.id)!.history.at(-1)?.claim).not.toHaveProperty("synthesis");
});

test("#931 an inventory write after the snapshot is refused atomically before person history", async () => {
  const f = await fixture(), manifest = await f.manifest(), history = f.board.get(f.task.id)!.history.length;
  const synthesis = { manifestSha256: synthesisManifestHash(manifest), disposition: "qualified" };
  const record = f.board.recordSynthesisClaimVerdict.bind(f.board), input = f.input(1, "contradicts");
  f.board.recordSynthesisClaimVerdict = (id, claim, fence) => {
    const task = f.board.get(id)!, link = parseEvidenceLink({ ...input, id: evidenceLinkId(input, "codex"), recordedBy: "codex" });
    f.board.recordEvidenceLink("synthesis-fixture", link, { taskFlowRevision: task.history.length, taskCreated: task.created, owner: "codex" });
    return record(id, claim, fence);
  };
  await expect(f.tasks.recordSynthesisClaimVerdict("user", f.task.id, { slot: 1, verdict: "supported", synthesis }, manifest)).rejects.toThrow("synthesis context changed");
  expect(f.board.get(f.task.id)!.history).toHaveLength(history);
  expect(f.board.get(f.task.id)!.history.at(-1)?.claim).not.toHaveProperty("synthesis");
  expect((await f.check(manifest)).status).toBe("stale");
});

test("#931 withdrawal appends a revision, stales prior inventory and preserves historical public readback", async () => {
  const f = await fixture(), counter = await f.tasks.evidenceRecord("codex", f.input(1, "contradicts"));
  const manifest = await f.manifest();
  const withdrawn = await f.tasks.evidenceRecord("user", { ...f.input(1, "contradicts"), id: counter.id, revision: 2, status: "withdrawn" });
  expect(withdrawn.revision).toBe(2);
  expect(f.board.evidenceLink("synthesis-fixture", counter.id, 1)?.status).toBeUndefined();
  expect(f.board.evidenceLink("synthesis-fixture", counter.id)?.status).toBe("withdrawn");
  expect(f.board.evidenceLink("synthesis-fixture", counter.id)?.recordedBy).toBe("user");
  expect(await f.tasks.evidenceRead("codex", { id: counter.id })).toEqual({ ...withdrawn, status: "withdrawn" });
  expect((await f.tasks.evidenceRead("codex", { id: counter.id, revision: 1 })).status).toBe("resolved");
  expect((await f.check(manifest)).status).toBe("stale");
  const refreshed = await f.check(await f.manifest());
  expect(refreshed.status).toBe("ready");
  if (!("claims" in refreshed)) throw new Error("expected current withdrawal inventory");
  expect(refreshed.claims[0]?.contradiction).toBe("none");
});

test("#931 owner and person withdrawal on a closed task name the follow-up-task next step", async () => {
  const f = await fixture();
  f.board.update(f.task.id, "codex", "done", { state: "in_review" });
  f.board.update(f.task.id, "user", "approved", { state: "approved" });
  const before = f.board.statusRevision(), integrity = f.board.researchEvidenceIntegrity();
  for (const by of ["codex", "user"]) await expect(f.tasks.evidenceRecord(by, { ...f.input(), id: f.support.id, revision: 2, status: "withdrawn" })).rejects.toThrow("open a follow-up research task");
  expect(f.board.statusRevision()).toBe(before); expect(f.board.researchEvidenceIntegrity()).toEqual(integrity);
});

test("#931 valid guarded citations and provenance do not manufacture a missing person verdict", async () => {
  const f = await fixture(false), result = await f.check(await f.manifest());
  expect(result.status).toBe("not_ready");
  if (!("claims" in result)) throw new Error("expected judgment and provenance statuses");
  expect(result.claims[0]).toMatchObject({ citationKey: "resolved", provenance: "resolved", judgment: "missing", contradiction: "none" });
  expect(result.next).toContain("record_person_judgment");
});

test("#931 Tasks reports artifact and active unselected projection changes independently of selected provenance", async () => {
  const artifact = await fixture(), artifactManifest = await artifact.manifest();
  writeFileSync(join(artifact.cwd, "report.md"), "changed artifact [@fixture-paper]\n");
  const changed = await artifact.check(artifactManifest);
  expect(changed.status).toBe("stale");
  if (!("deliverable" in changed)) throw new Error("expected artifact status");
  expect(changed.deliverable).toBe("changed");
  const projection = await fixture();
  await projection.tasks.evidenceRecord("codex", projection.input(1, "context"));
  const manifest = await projection.manifest();
  expect((await projection.check(manifest)).status).toBe("ready");
  writeFileSync(join(projection.registry.root, projection.sources[1]!.id.replace(":", "-"), "text"), "CHANGED_PROJECTION_CANARY");
  const stale = await projection.check(manifest);
  expect(stale.status).toBe("stale");
  if (!("claims" in stale)) throw new Error("expected full provenance status");
  expect(stale.claims[0]).toMatchObject({ inventory: "current", locator: "resolved", provenance: "stale" });
});

test("#931 absent raw snapshots and overflowing full inventories remain unknown", async () => {
  const missing = await fixture(), missingManifest = await missing.manifest();
  rmSync(join(missing.registry.root, missing.sources[0]!.id.replace(":", "-"), "raw"));
  expect((await missing.check(missingManifest)).status).toBe("unknown");
  const overflow = await fixture(), old = await overflow.manifest();
  // Real append-only rows exercise Board.latestEvidenceLinks' task-wide complete flag, no fake complete=true source.
  for (let start = 1; start <= 128; start++) await overflow.tasks.evidenceRecord("codex", overflow.input(0, "context", start));
  const inventory = await overflow.tasks.synthesisEvidence("codex", { taskId: overflow.task.id });
  if (inventory.status !== "available") throw new Error("expected bounded authoring inventory");
  expect(inventory.claims[0]?.complete).toBe(false); expect(inventory.claims[0]?.inventory).toBeUndefined();
  expect((await overflow.check(old)).status).toBe("unknown");
});

test("#931 any selected or unselected private source upgrade yields only the neutral task status", async () => {
  for (const unselected of [false, true]) {
    const f = await fixture();
    if (unselected) await f.tasks.evidenceRecord("codex", f.input(1, "context"));
    const manifest = await f.manifest();
    f.registry.markPrivate(f.sources[unselected ? 1 : 0]!.id);
    expect(await f.check(manifest)).toEqual({ taskId: f.task.id, status: "private" });
    expect(await f.tasks.synthesisEvidence("codex", { taskId: f.task.id })).toEqual({ taskId: f.task.id, status: "private" });
  }
});

test("#931 a private upgrade during an awaited source screen cannot publish an earlier public synthesis", async () => {
  const f = await fixture(); await f.tasks.evidenceRecord("codex", f.input(1, "context"));
  const manifest = await f.manifest(); let changed = false;
  f.control.screen = async () => { if (!changed) { changed = true; f.registry.markPrivate(f.sources[1]!.id); } };
  expect(await f.check(manifest)).toEqual({ taskId: f.task.id, status: "private" });
  expect(changed).toBe(true);
});

test("#931 a new link or artifact edit during awaited source resolution invalidates the captured Tasks batch", async () => {
  for (const kind of ["counterevidence", "artifact"] as const) {
    const f = await fixture(), manifest = await f.manifest(); let changed = false;
    f.control.screen = async () => {
      if (changed) return; changed = true;
      if (kind === "counterevidence") await f.tasks.evidenceRecord("codex", f.input(1, "contradicts"));
      else writeFileSync(join(f.cwd, "report.md"), "edited while sources were resolving\n");
    };
    const result = await f.check(manifest);
    expect(result.status).toBe("stale"); expect(changed).toBe(true);
  }
});

test("#931 check input and task-show authority refuse before source resolution; current privacy still wins", async () => {
  const f = await fixture(), manifest = await f.manifest();
  await expect(f.check(manifest, "kimi")).rejects.toThrow(/unavailable|visible/);
  await expect(f.check(manifest, "codex@foreign")).rejects.toThrow(/remote/);
  await expect(f.tasks.synthesisCheck("codex", { taskId: f.task.id, manifest, current: {} })).rejects.toThrow();
  await expect(f.tasks.synthesisCheck("codex", { taskId: f.task.id + 1, manifest })).rejects.toThrow(/another task/);
  expect(f.control.reads).toEqual([]);
  f.control.privateTurn = true;
  expect(await f.check(manifest)).toEqual({ taskId: f.task.id, status: "private" });
});
