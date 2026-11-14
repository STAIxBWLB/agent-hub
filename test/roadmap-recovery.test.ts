import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { realPath } from "../src/hub/project.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { gitProject } from "./fakes/git-project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const PROJECT = "roadmap-recovery-project", INSTANCE = "roadmap-recovery-source", OPERATION = "roadmap-recovery-operation";
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roadmap-recovery-"))), stateDir = join(root, "state");
  mkdirSync(stateDir); gitProject(root);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  return { root, stateDir, board };
}
async function startFixture(f: ReturnType<typeof fixture>, instanceId = INSTANCE) {
  const kimiHome = join(f.root, "kimi-home"); mkdirSync(kimiHome, { recursive: true });
  const daemon = await startDaemon({ cwd: f.root, stateDir: f.stateDir, projectId: PROJECT, instanceId, kimiHome,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {}, sdlc: sdlcConfig(undefined),
    config: { ...DEFAULT_CONFIG, roster: {}, roles: {}, start: { agents: [] }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      specs: { ...DEFAULT_CONFIG.specs, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop()); return daemon;
}
async function personAt(stateDir: string) {
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close()); return person;
}
const retained = (f: ReturnType<typeof fixture>) => f.board.newMilestone({ title: "ROADMAP_RECOVERY_TITLE_CANARY", outcome: "ROADMAP_RECOVERY_OUTCOME_CANARY" }, "user", 1000);
const request = (op: string, targetFeatures: readonly string[] = DAEMON_FEATURES) => ({ t: "recovery", op, operationId: OPERATION, expectedInstanceId: INSTANCE, targetFeatures });
const expected = (f: ReturnType<typeof fixture>) => ({ projectRoot: f.root, projectId: PROJECT, operationId: OPERATION });

test("roadmap integrity is stable across reads/reopen and binds milestone edits and link mutations", () => {
  const f = fixture();
  expect(f.board.hasMilestoneState()).toBe(false);
  const empty = f.board.roadmapIntegrity();
  expect(empty).toMatchObject({ milestones: 0, links: 0 });
  const milestone = retained(f), created = f.board.roadmapIntegrity();
  expect(f.board.hasMilestoneState()).toBe(true);
  expect(created).toMatchObject({ milestones: 1, links: 0 });
  expect(created.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.board.roadmapIntegrity()).toEqual(created);
  const secondConnection = new Board(join(f.stateDir, "hub.db"));
  try { expect(secondConnection.roadmapIntegrity()).toEqual(created); }
  finally { secondConnection.close(); }
  const edited = f.board.updateMilestone(milestone.id, { order: 2 }, milestone.revision, { at: 2000, by: "user", event: "ordered", fields: ["order"] });
  const changed = f.board.roadmapIntegrity(); expect(changed.digest).not.toBe(created.digest);
  const linked = f.board.linkMilestone(milestone.id, "issue", "example/repo#42", "user", edited.revision, 3000);
  const links = f.board.roadmapIntegrity(); expect(links.links).toBe(1); expect(links.digest).not.toBe(changed.digest);
  expect(f.board.linkMilestone(milestone.id, "issue", "example/repo#42", "user", linked.revision, 4000)).toEqual(linked);
  expect(f.board.roadmapIntegrity()).toEqual(links);
  f.board.unlinkMilestone(milestone.id, "issue", "example/repo#42", "user", linked.revision, 5000);
  const unlinked = f.board.roadmapIntegrity(); expect(unlinked.links).toBe(0); expect(unlinked.digest).not.toBe(links.digest);
});

test("empty roadmap keeps legacy recovery integrity shape and permits targets without roadmap", async () => {
  const f = fixture(); await startFixture(f); const person = await personAt(f.stateDir);
  expect(DAEMON_FEATURES).toContain("roadmap"); expect(person.features).toContain("roadmap");
  const unsupported = DAEMON_FEATURES.filter(feature => feature !== "roadmap");
  const inspected = await person.request(request("inspect", unsupported));
  expect<boolean>(inspected.ok, inspected.error).toBe(true);
  expect(inspected.recovery.integrity.current.roadmap).toBeUndefined();
  const prepared = await person.request(request("prepare", unsupported));
  expect<boolean>(prepared.ok, prepared.error).toBe(true);
  expect((await person.request(request("abort", unsupported))).ok).toBe(true);
  expect(f.board.hasMilestoneState()).toBe(false);
}, 20_000);

test("retained roadmap refuses unsupported inspect/prepare/commit before recovery effects", async () => {
  const f = fixture(); retained(f); await startFixture(f); const person = await personAt(f.stateDir);
  const unsupported = DAEMON_FEATURES.filter(feature => feature !== "roadmap"), before = f.board.roadmapIntegrity();
  for (const op of ["inspect", "prepare"]) {
    const reply = await person.request(request(op, unsupported));
    expect(reply.ok).toBe(false); expect(String(reply.error)).toContain("target lacks roadmap");
    const status = (await person.request({ t: "status" })).status;
    expect(status.recovery?.operationId).toBeUndefined(); expect(status.stopping).not.toBe(true);
    expect(f.board.roadmapIntegrity()).toEqual(before);
  }
  const inspected = await person.request(request("inspect"));
  expect<boolean>(inspected.ok, inspected.error).toBe(true);
  expect(inspected.recovery.integrity.current.roadmap).toEqual(before);
  expect(JSON.stringify(inspected.recovery)).not.toContain("ROADMAP_RECOVERY_");
  expect((await person.request(request("prepare"))).ok).toBe(true);
  const blockedCommit = await person.request(request("commit", unsupported));
  expect(blockedCommit.ok).toBe(false); expect(String(blockedCommit.error)).toContain("target lacks roadmap");
  expect((await person.request({ t: "status" })).status.stopping).not.toBe(true);
  expect(f.board.roadmapIntegrity()).toEqual(before);
  expect((await person.request(request("abort"))).ok).toBe(true);
}, 20_000);

async function committedFixture() {
  const f = fixture(); retained(f); const source = await startFixture(f), person = await personAt(f.stateDir);
  const prepared = await person.request(request("prepare")); expect<boolean>(prepared.ok, prepared.error).toBe(true);
  const committed = await person.request(request("commit")); expect<boolean>(committed.ok, committed.error).toBe(true); expect(committed.committed).toBe(true);
  await source.stopped; person.close();
  const snapshot = readRestartSnapshot(f.stateDir, expected(f));
  expect(snapshot).toBeDefined(); expect(snapshot!.integrity!.roadmap).toEqual(f.board.roadmapIntegrity());
  return { ...f, snapshot: snapshot! };
}
async function inRecovery<T>(run: () => Promise<T>): Promise<T> {
  const prior = process.env.AGENTHUB_RECOVERY_OPERATION; process.env.AGENTHUB_RECOVERY_OPERATION = OPERATION;
  try { return await run(); }
  finally { if (prior === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = prior; }
}

test("a supporting restored daemon verifies the matching roadmap digest", async () => {
  const f = await committedFixture(), before = f.board.roadmapIntegrity();
  await inRecovery(async () => { await startFixture(f, "roadmap-recovery-target"); });
  const person = await personAt(f.stateDir), status = (await person.request({ t: "status" })).status;
  expect(status.instanceId).toBe("roadmap-recovery-target"); expect(status.recovery?.phase).toBe("restored");
  expect(f.board.roadmapIntegrity()).toEqual(before);
}, 20_000);

for (const mismatch of ["missing", "changed-proof", "changed-storage"] as const) test(`restore rejects ${mismatch} roadmap integrity with retained rows`, async () => {
  const f = await committedFixture();
  if (mismatch === "missing") delete f.snapshot.integrity!.roadmap;
  else if (mismatch === "changed-proof") f.snapshot.integrity!.roadmap = { ...f.snapshot.integrity!.roadmap!, digest: "f".repeat(64) };
  else {
    const row = f.board.milestones()[0]!;
    f.board.updateMilestone(row.id, { order: 1 }, row.revision, { at: 3000, by: "user", event: "ordered", fields: ["order"] });
  }
  writeRestartSnapshot(f.stateDir, f.snapshot);
  await inRecovery(async () => { await expect(startFixture(f, "roadmap-recovery-target")).rejects.toThrow(/roadmap|milestone/); });
}, 20_000);

test("restart reader accepts legacy absence and valid roadmap proof but rejects malformed optional proofs", () => {
  const f = fixture(), bus = new Bus(); cleanup.push(() => bus.closeJournal());
  const base: RestartSnapshot = { schemaVersion: 1, projectRoot: f.root, projectId: PROJECT, sourceInstanceId: INSTANCE, operationId: OPERATION, committedAt: Date.now(),
    bus: bus.snapshot(), peers: [], manualPaused: [], integrity: { queues: {}, manualPaused: [], boardDigest: "a", budgetDigest: "b" } };
  writeRestartSnapshot(f.stateDir, base);
  expect(readRestartSnapshot(f.stateDir, expected(f))?.integrity?.roadmap).toBeUndefined();
  expect(readRestartSnapshot(f.stateDir, expected(f))).toBeDefined();
  const valid = { milestones: 1, links: 2, digest: "a".repeat(64) };
  writeRestartSnapshot(f.stateDir, { ...base, integrity: { ...base.integrity!, roadmap: valid } });
  expect(readRestartSnapshot(f.stateDir, expected(f))?.integrity?.roadmap).toEqual(valid);
  const invalid: unknown[] = [null, { ...valid, milestones: -1 }, { ...valid, links: 1.5 }, { ...valid, links: "2" }, { milestones: 1, links: 2 }, { ...valid, extra: true }, { ...valid, digest: "a".repeat(63) }, { ...valid, digest: "A".repeat(64) }, { ...valid, digest: "a".repeat(64) + "\n" }];
  for (const roadmap of invalid) {
    writeRestartSnapshot(f.stateDir, { ...base, integrity: { ...base.integrity!, roadmap } as RestartSnapshot["integrity"] });
    expect(readRestartSnapshot(f.stateDir, expected(f))).toBeUndefined();
  }
});
