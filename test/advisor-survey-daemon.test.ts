import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { realPath } from "../src/hub/project.ts";
import { gitProject } from "./fakes/git-project.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

/** Synthetic daemon-owned readiness and delivery receipts, following auto-pull/conductor daemon fixtures. */
class PlannerPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envelopes: Envelope[], id?: string) { if (id) this.delivery({ id, state: "completed" }); }
}

const finding = { id: "daemon-parser-boundary", pass: "bugs", evidence: "src/parser.ts:12", paths: ["src/parser.ts"], impact: "RPC_IMPACT_CANARY invalid input accepted",
  effort: "S", risk: "bounded behavior change", confidence: "high", fix_sketch: "validate the boundary" };
async function fixture(mode: "off" | "advise" = "advise") {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-survey-daemon-"))), stateDir = join(root, "state"); mkdirSync(stateDir);
  gitProject(root); // Isolated empty local repository; no provider, native agent, account or network API.
  const board = new Board(join(stateDir, "hub.db"));
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "survey-daemon-fixture", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    sdlc: sdlcConfig({ mode, required_checks: [] }),
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["planner", "reviewer"], kimi: ["conductor"] }, roster: { ...DEFAULT_CONFIG.roster, kimi: true }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false } } });
  // Tools sockets are pull-only and do not prove a managed native peer ready. Inject actual fake peers at the existing bus port instead.
  for (const id of ["claude", "codex"]) { const peer = new PlannerPeer(id); daemon.bus.add(peer); await peer.start(); }
  const clients: ControlClient[] = [];
  const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, { role, projectRoot: root, ...(peer ? { peer } : {}) }); clients.push(client); return client; };
  const person = await connect("console"), planners = { claude: await connect("tools", "claude"), codex: await connect("tools", "codex") }, conductor = await connect("tools", "kimi");
  const report = (client: ControlClient, args: unknown) => client.request({ t: "task", op: "hub_survey_report", args });
  const start = async () => {
    const reply = await person.request({ t: "sdlc", op: "survey-start", focus: "bugs" }); expect(reply.ok === true, String(reply.error ?? "")).toBe(true);
    const task = board.get(reply.task)!;
    const owner = planners[task.owner as keyof typeof planners]; if (!owner) throw new Error("expected a connected synthetic planner owner");
    if (task.state !== "in_progress") { const accepted = await owner.request({ t: "task", op: "hub_task_accept", args: { id: task.id } }); expect(accepted.ok === true, String(accepted.error ?? "")).toBe(true); }
    return { task: task.id, survey: reply.survey as number, owner, other: owner === planners.claude ? planners.codex : planners.claude };
  };
  return { root, stateDir, board, daemon, person, planners, conductor, report, start,
    close: async () => { for (const client of clients) client.close(); board.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("real daemon routes survey start/report through current authority and explicit vetting only", async () => {
  const f = await fixture();
  try {
    expect((await f.planners.codex.request({ t: "sdlc", op: "survey-start" })).ok).toBe(false);
    expect(f.board.list()).toEqual([]);
    const s = await f.start();
    expect((await f.report(s.other, { id: s.task, findings: [finding] })).ok).toBe(false);
    const filed = await f.report(s.owner, { id: s.task, findings: [finding] }); expect(filed.ok === true, String(filed.error ?? "")).toBe(true);
    expect(f.board.list()).toHaveLength(1); expect(f.board.surveyFindings(s.survey)).toHaveLength(1);
    const vetted = await f.report(s.owner, { id: s.task, vet: [{ id: finding.id, verdict: "vetted" }] }); expect(vetted.ok === true, String(vetted.error ?? "")).toBe(true);
    expect(JSON.parse(vetted.text).createdIDs).toHaveLength(1);
    const replay = await f.report(s.owner, { id: s.task, vet: [{ id: finding.id, verdict: "vetted" }] }); expect(replay.ok === true, String(replay.error ?? "")).toBe(true);
    expect(JSON.parse(replay.text).createdIDs).toEqual([]); expect(f.board.list()).toHaveLength(2);
    const malformed = await f.report(s.owner, { id: s.task, findings: [], unknown: "RPC_PRIVATE_ARGUMENT_CANARY" });
    expect(malformed.ok).toBe(false); expect(JSON.stringify(malformed)).not.toContain("RPC_PRIVATE_ARGUMENT_CANARY");
  } finally { await f.close(); }
}, 20_000);

test("real daemon refuses lifecycle-off and private survey writes without leaking stored finding text", async () => {
  const off = await fixture("off");
  try { expect((await off.person.request({ t: "sdlc", op: "survey-start" })).ok).toBe(false); expect(off.board.hasSurveyState()).toBe(false); expect(off.board.list()).toEqual([]); }
  finally { await off.close(); }
  const f = await fixture();
  try {
    const s = await f.start(); expect((await f.report(s.owner, { id: s.task, findings: [finding] })).ok).toBe(true);
    f.board.update(s.task, "user", "private upgrade", { signals: ["pii"] });
    const before = f.board.surveyIntegrity(), refused = await f.report(s.owner, { id: s.task, vet: [{ id: finding.id, verdict: "vetted" }] });
    expect(refused.ok).toBe(false); expect(JSON.stringify(refused)).not.toContain("RPC_IMPACT_CANARY"); expect(f.board.surveyIntegrity()).toEqual(before);
    const show = await f.person.request({ t: "sdlc", op: "survey-show", id: s.task }); expect(show.ok === true, String(show.error ?? "")).toBe(true);
    expect(show.survey).toEqual({ task: s.task, status: "private" });
  } finally { await f.close(); }
}, 20_000);

test("recovery requires advisor_surveys only for stored state and conditionally binds its private integrity", async () => {
  expect(DAEMON_FEATURES).toContain("advisor_surveys");
  for (const stored of [false, true]) {
    const f = await fixture();
    try {
      if (stored) { const s = await f.start(); expect((await f.report(s.owner, { id: s.task, findings: [finding] })).ok).toBe(true); }
      const status = (await f.person.request({ t: "status" })).status, without = status.features.filter((name: string) => name !== "advisor_surveys");
      const request = (op: string, targetFeatures: readonly string[]) => f.person.request({ t: "recovery", op, operationId: "survey-recovery", expectedInstanceId: status.instanceId, targetFeatures });
      if (stored) for (const op of ["prepare", "commit", "inspect"]) expect(await request(op, without)).toMatchObject({ ok: false, error: expect.stringContaining("target lacks advisor_surveys") });
      const features = stored ? status.features : without;
      const prepared = await request("prepare", features); expect(prepared.ok === true, String(prepared.error ?? "")).toBe(true);
      const committed = await request("commit", features); expect(committed.ok === true, String(committed.error ?? "")).toBe(true); expect(committed.committed).toBe(true);
      const snapshot = readRestartSnapshot(f.stateDir, { projectRoot: f.root, projectId: "survey-daemon-fixture", operationId: "survey-recovery" })!;
      expect(snapshot).toBeDefined();
      if (stored) expect(snapshot.integrity?.advisorSurveys).toEqual(f.board.surveyIntegrity());
      else expect(snapshot.integrity).not.toHaveProperty("advisorSurveys");
    } finally { await f.close(); }
  }
}, 20_000);

test("legacy snapshot bytes remain unchanged and survey integrity accepts only closed bounded counts and digest", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-survey-restart-"));
  const legacy: RestartSnapshot = { schemaVersion: 1, projectRoot: "/fixture", projectId: "survey", sourceInstanceId: "source", operationId: "operation", committedAt: 1,
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
    integrity: { queues: {}, manualPaused: [], boardDigest: "a".repeat(64), budgetDigest: "b".repeat(64) } };
  const expected = { projectRoot: "/fixture", projectId: "survey", operationId: "operation" };
  try {
    writeRestartSnapshot(root, legacy); expect(readRestartSnapshot(root, expected)).toEqual(legacy);
    const proof = { surveys: 1, findings: 2, considered: 3, digest: "c".repeat(64) };
    writeRestartSnapshot(root, { ...legacy, integrity: { ...legacy.integrity!, advisorSurveys: proof } });
    expect(readRestartSnapshot(root, expected)?.integrity?.advisorSurveys).toEqual(proof);
    for (const value of [null, [], { ...proof, surveys: -1 }, { ...proof, findings: 1.5 }, { ...proof, considered: "3" }, { ...proof, digest: "bad" }, { ...proof, reason: "PRIVATE_NARRATIVE_CANARY" }]) {
      writeRestartSnapshot(root, { ...legacy, integrity: { ...legacy.integrity!, advisorSurveys: value } } as unknown as RestartSnapshot);
      expect(readRestartSnapshot(root, expected)).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
