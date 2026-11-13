import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcMode } from "../src/hub/sdlc.ts";
import type { AuditSource } from "../src/hub/audit-source.ts";
import type { ConsideredEntry } from "../src/hub/considered-findings.ts";
import { securityPolicy } from "../src/hub/security-pass.ts";

const H0 = "a".repeat(40), H1 = "b".repeat(40), clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver() {} }
const finding = (id = "bounded-survey-parser", confidence = "high", pass = "bugs") => ({ id, pass, evidence: "src/parser.ts:12", paths: ["src/parser.ts"],
  impact: "IMPACT_CANARY invalid input accepted", effort: "S", risk: "RISK_CANARY bounded change", confidence, fix_sketch: "FIX_CANARY validate the boundary" });
async function fixture(mode: SdlcMode = "advise") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-survey-tasks-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  clean.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["claude", "codex", "kimi", "pi"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const control: { held: boolean; private: boolean; screen?: () => Promise<void>; changed?: string[]; sourceCalls: string[]; deny: boolean } = { held: false, private: false, sourceCalls: [], deny: false };
  const config = sdlcConfig({ mode, required_checks: [] }), roles = { claude: ["planner"], codex: ["planner", "reviewer"], kimi: ["conductor"], pi: ["planner"] };
  const source: AuditSource = { head: () => { control.sourceCalls.push("head"); return H1; }, resolve: ref => { control.sourceCalls.push("resolve"); return [H0, H1].includes(ref) ? ref : undefined; },
    changed: (from, to) => { control.sourceCalls.push("changed"); return from === to ? [] : control.changed; } };
  const notices: string[] = [];
  const deps: TasksDeps = { cwd, project: "survey-fixture", repository: "fixture/survey", board, bus, roles, notify: text => { notices.push(text); },
    routing: () => { const base = loadRouting(cwd); return { ...base, signals: { ...base.signals, pii_screen: "local" as const, pii_patterns: control.deny ? ["IMPACT_CANARY"] : [] } }; },
    piiScreen: async () => { await control.screen?.(); return { label: "clear", ms: 0 }; }, sweepHeld: () => control.held, privateTurn: () => control.private,
    sdlc: { config: () => config }, auditSource: source };
  const tasks = new Tasks(deps);
  async function start() {
    const started = await tasks.surveyStart("user", { focus: "bugs" }), row = board.get(started.task)!;
    if (!row.owner) throw new Error("expected routed planner");
    if (row.state !== "in_progress") tasks.accept(row.owner, row.id);
    return { ...started, owner: row.owner };
  }
  const prior = (task: number, id = "bounded-survey-parser", ref: string | undefined = H0): ConsideredEntry => {
    const row = board.get(task)!;
    return { repo: "repo:fixture/survey", id, pass: "bugs", paths: ["src/parser.ts"], reason: "Prior guard was sufficient", ...(ref ? { ref } : {}), source: { task, created: row.created, kind: "review" } };
  };
  return { tasks, board, bus, control, config, roles, deps, notices, start, prior, file: join(cwd, "hub.db") };
}

test("survey start creates one pinned read-only planner task, refuses duplicates and accepts only focus enum", async () => {
  const f = await fixture(), started = await f.start(), task = f.board.get(started.task)!;
  expect(task.class).toBe("plan"); expect(f.roles[started.owner as keyof typeof f.roles]).toContain("planner");
  expect(task.detail).toContain(H1); expect(task.detail).toContain("Do not edit"); expect(task.detail).toContain("never authority");
  expect(JSON.stringify(task)).not.toContain("repo:fixture/survey");
  await expect(f.tasks.surveyStart("user", {})).rejects.toThrow(/already open/);
  await expect(f.tasks.surveyStart("user", { focus: "src/parser.ts" })).rejects.toThrow(/focus/);
  await expect(f.tasks.surveyStart("codex", {})).rejects.toThrow(/person|conductor/);
  expect(f.board.list()).toHaveLength(1);
});

test("candidate reporting is inert until explicit vetting; confidence creates deduped backlog plans or investigation", async () => {
  const f = await fixture(), s = await f.start(), rows = [finding("high-parser", "high"), finding("medium-parser", "medium"), finding("low-parser", "low")];
  await f.tasks.surveyReport(s.owner, { id: s.task, findings: rows });
  expect(f.board.list()).toHaveLength(1);
  const vet = rows.map(row => ({ id: row.id, verdict: "vetted" }));
  const result = await f.tasks.surveyReport(s.owner, { id: s.task, vet });
  if (!result || !("createdIDs" in result)) throw new Error("expected recorded report");
  expect(result.createdIDs).toHaveLength(3);
  expect(result.createdIDs.map(id => f.board.get(id)!.class)).toEqual(["plan", "plan", "triage"]);
  for (const id of result.createdIDs) { const row = f.board.get(id)!; expect(row.state).toBe("backlog"); expect(row.owner).toBeNull(); expect(row.detail).toContain("Do not"); }
  const repeated = await f.tasks.surveyReport(s.owner, { id: s.task, vet });
  if (!repeated || !("dedupedIDs" in repeated)) throw new Error("expected replay receipt");
  expect(repeated.createdIDs).toEqual([]); expect(repeated.dedupedIDs).toEqual(result.createdIDs);
  expect(() => f.tasks.surveyShow("user", s.task)).not.toThrow();
});

test("unchanged and unknown rejections suppress vetted auto cards until an explicit reason appends reconsideration", async () => {
  for (const changed of [undefined, []] as const) {
    const f = await fixture(), s = await f.start(); f.control.changed = changed === undefined ? undefined : [];
    const rejection = f.prior(s.task), rejectedID = f.board.recordRejectedFinding(rejection);
    await f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()], vet: [{ id: rejection.id, verdict: "vetted" }] });
    expect(f.board.list()).toHaveLength(1);
    const result = await f.tasks.surveyReport(s.owner, { id: s.task, vet: [{ id: rejection.id, verdict: "vetted", reason: "New code evidence justifies reconsideration" }] });
    if (!result || !("createdIDs" in result)) throw new Error("expected explicit reconsideration receipt");
    expect(result.createdIDs).toHaveLength(1);
    const ledger = f.board.rejectedFindingsFor(rejection.repo, rejection.pass, rejection.id);
    expect(ledger.rows[0]?.id).toBe(rejectedID); expect(ledger.rows[0]?.entry).toEqual(rejection); expect(ledger.rows[0]?.reconsideredBy).toHaveLength(1);
  }
});

test("changed affected paths clear suppression, unrelated paths do not, and reads use the targeted ledger", async () => {
  for (const changed of [["src/parser.ts"], ["docs/unrelated.md"]]) {
    const f = await fixture(), s = await f.start(); f.control.changed = changed;
    const rejection = f.prior(s.task); f.board.recordRejectedFinding(rejection);
    const repoRead = f.board.rejectedFindings.bind(f.board);
    f.board.rejectedFindings = (repo, limit, selector) => { if (!selector) throw new Error("unbounded unrelated ledger read"); return repoRead(repo, limit, selector); };
    const result = await f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()], vet: [{ id: rejection.id, verdict: "vetted" }] });
    if (!result || !("createdIDs" in result)) throw new Error("expected bounded receipt");
    expect(result.createdIDs).toHaveLength(changed[0] === "src/parser.ts" ? 1 : 0);
    expect(result.items[0]?.change).toBe(changed[0] === "src/parser.ts" ? "changed" : "unchanged");
  }
});

test("a rejection decision appends once and owner/privacy/hold/lifecycle races cannot write", async () => {
  const f = await fixture(), s = await f.start();
  const report = { id: s.task, findings: [finding()], vet: [{ id: finding().id, verdict: "rejected", reason: "Already covered" }] };
  await f.tasks.surveyReport(s.owner, report); await f.tasks.surveyReport(s.owner, report);
  expect(f.board.rejectedFindingsFor("repo:fixture/survey", "bugs", finding().id).rows).toHaveLength(1);
  await expect(f.tasks.surveyReport(s.owner === "claude" ? "codex" : "claude", report)).rejects.toThrow(/assigned/);
  for (const kind of ["owner", "private", "hold", "off", "roles"] as const) {
    const r = await fixture(), t = await r.start(), before = r.board.statusRevision();
    r.control.screen = async () => {
      if (kind === "owner") r.board.update(t.task, "user", "owner changed", { owner: "codex" });
      if (kind === "private") r.control.private = true;
      if (kind === "hold") r.control.held = true;
      if (kind === "off") r.config.mode = "off";
      if (kind === "roles") r.roles[t.owner as keyof typeof r.roles] = [];
    };
    await expect(r.tasks.surveyReport(t.owner, { id: t.task, findings: [finding()] })).rejects.toThrow();
    expect(r.board.surveyFindings(t.survey)).toEqual([]); expect(r.board.list()).toHaveLength(1);
    if (kind !== "owner") expect(r.board.statusRevision()).toBe(before);
    expect(r.tasks.studiesPending()).toBe(0);
  }
});

test("security cards and conductor readback withhold paths and narrative, while authorized owner and person can read", async () => {
  const f = await fixture(), s = await f.start(), row = finding("security-parser-boundary", "high", "security");
  const result = await f.tasks.surveyReport(s.owner, { id: s.task, findings: [row], vet: [{ id: row.id, verdict: "vetted" }] });
  if (!result || !("createdIDs" in result)) throw new Error("expected security candidate receipt");
  const card = f.board.get(result.createdIDs[0]!)!;
  expect(card.refs).toEqual({}); expect(JSON.stringify(card)).not.toMatch(/IMPACT_CANARY|RISK_CANARY|FIX_CANARY|src\/parser.ts/);
  expect(JSON.stringify(f.tasks.surveyShow("kimi", s.task))).not.toMatch(/IMPACT_CANARY|RISK_CANARY|FIX_CANARY|src\/parser.ts/);
  expect(JSON.stringify(f.tasks.surveyShow("user", s.task))).toContain("IMPACT_CANARY");
  expect(JSON.stringify(f.tasks.surveyShow(s.owner, s.task))).toContain("IMPACT_CANARY");
  expect(s.owner).not.toBe("pi"); expect(f.board.get(s.task)!.reviewer).not.toBe("pi");
  expect(() => f.tasks.surveyShow("pi", s.task)).toThrow();
  f.control.deny = true;
  expect(f.tasks.surveyShow("user", s.task)).toEqual({ task: s.task, status: "private" });
});

test("off, private, child and held admission is refused before source or task writes", async () => {
  for (const kind of ["off", "private", "child", "hold"] as const) {
    const f = await fixture(kind === "off" ? "off" : "advise");
    if (kind === "private") f.control.private = true;
    if (kind === "hold") f.control.held = true;
    if (kind === "child") f.deps.requestAuthority = () => () => undefined;
    await expect(f.tasks.surveyStart("user", {})).rejects.toThrow();
    expect(f.control.sourceCalls).toEqual([]); expect(f.board.list()).toEqual([]);
  }
});

test("shared considered hooks retain positional and missing-ref rejections without matching positional IDs", async () => {
  const f = await fixture(), s = await f.start(), task = f.board.get(s.task)!;
  const positional = { id: "F1", pass: "bugs" as const, severity: "important" as const, disposition: "false_positive" as const };
  expect(await f.tasks.recordConsideredFinding(task, positional, "Prior interpretation rejected", "review")).toBeDefined();
  expect(f.tasks.consideredBefore(f.board.get(s.task)!, positional, H1)).toEqual({ rejectedBefore: false, change: "none", suppressed: false });
  const semantic = { ...positional, id: "legacy-no-ref" };
  await f.tasks.recordConsideredFinding(f.board.get(s.task)!, semantic, "No immutable source reference available", "audit");
  expect(f.tasks.consideredBefore(f.board.get(s.task)!, semantic, H1)).toEqual({ rejectedBefore: true, change: "unknown", suppressed: true });
});

test("targeted rejection inventories ignore unrelated overflow and same-key incompleteness remains suppressed", async () => {
  const f = await fixture(), s = await f.start(), entry = f.prior(s.task);
  f.board.recordRejectedFinding(entry);
  f.board.recordRejectedFinding({ ...entry, id: "unrelated-rejection" });
  expect(f.board.rejectedFindings(entry.repo, 1)).toEqual({ rows: [], complete: false });
  expect(f.board.rejectedFindingsFor(entry.repo, entry.pass, entry.id, 1).complete).toBe(true);
  expect(f.board.rejectedFindingsFor(entry.repo, entry.pass, "absent-semantic-id", 1)).toEqual({ rows: [], complete: true });
  const read = f.board.rejectedFindingsFor.bind(f.board);
  f.board.rejectedFindingsFor = (repo, pass, id, limit) => id === entry.id ? { rows: [], complete: false } : read(repo, pass, id, limit);
  await f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()], vet: [{ id: entry.id, verdict: "vetted" }] });
  expect(f.board.list()).toHaveLength(1);
  expect(f.tasks.consideredBefore(f.board.get(s.task)!, { id: entry.id, pass: entry.pass }, H1)).toEqual({ rejectedBefore: true, change: "unknown", suppressed: true });
});

test("private task upgrades and unavailable source diffs expose no survey details or successful clearing", async () => {
  const f = await fixture(), s = await f.start(), entry = f.prior(s.task);
  f.board.recordRejectedFinding(entry);
  f.deps.auditSource!.changed = () => { throw new Error("unavailable synthetic source"); };
  expect(f.tasks.consideredBefore(f.board.get(s.task)!, { id: entry.id, pass: entry.pass, path: "src/parser.ts" }, H1).change).toBe("unknown");
  f.board.update(s.task, "user", "private upgrade", { signals: ["pii"] });
  expect(f.tasks.surveyShow("user", s.task)).toEqual({ task: s.task, status: "private" });
  await expect(f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()] })).rejects.toThrow(/private/);
  expect(f.board.surveyFindings(s.survey)).toEqual([]);
});

test("foreign repository rejections cannot borrow this project's Git diff to clear suppression", async () => {
  const f = await fixture(), s = await f.start();
  f.board.update(s.task, "user", "repository changed", { refs: { repo: "foreign/project" } });
  const task = f.board.get(s.task)!, entry = { ...f.prior(s.task), repo: "repo:foreign/project" };
  f.board.recordRejectedFinding(entry); f.control.sourceCalls.length = 0;
  expect(f.tasks.consideredBefore(task, { id: entry.id, pass: entry.pass, path: "src/parser.ts" }, H1)).toEqual({ rejectedBefore: true, change: "unknown", suppressed: true });
  expect(f.control.sourceCalls).toEqual([]);
});

test("survey reports share the existing study shutdown drain and cannot commit after a held screen", async () => {
  const f = await fixture(), s = await f.start();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), captured = new Promise<void>(resolve => { entered = resolve; });
  f.control.screen = async () => { entered(); await waiting; };
  const report = f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()] });
  await captured;
  expect(f.tasks.studiesPending()).toBe(1);
  const stopped = f.tasks.stopStudies(); release();
  await expect(report).rejects.toThrow(/held/); await stopped;
  expect(f.tasks.studiesPending()).toBe(0); expect(f.board.surveyFindings(s.survey)).toEqual([]);
});

test("survey start loses role or hold authority during pre-insert screening without creating either row", async () => {
  for (const change of ["roles", "hold", "private"] as const) {
    const f = await fixture(), events: number[] = []; f.board.onChange = task => { events.push(task.id); };
    const revision = f.board.statusRevision();
    f.control.screen = async () => {
      if (change === "roles") f.roles.kimi = [];
      if (change === "hold") f.control.held = true;
      if (change === "private") f.control.private = true;
    };
    await expect(f.tasks.surveyStart("kimi", {})).rejects.toThrow();
    expect(f.board.list()).toEqual([]); expect(events).toEqual([]); expect(f.board.statusRevision()).toBe(revision);
    expect(f.board.surveyOpen("repo:fixture/survey")).toBeUndefined();
  }
});

test("survey ledger failure rolls the proposal and notifications back atomically", async () => {
  const f = await fixture(), events: number[] = []; f.board.onChange = task => { events.push(task.id); };
  const revision = f.board.statusRevision();
  f.board.surveyCreate = () => { throw new Error("synthetic survey ledger failure"); };
  await expect(f.tasks.surveyStart("user", {})).rejects.toThrow("synthetic survey ledger failure");
  expect(f.board.list()).toEqual([]); expect(events).toEqual([]); expect(f.notices).toEqual([]); expect(f.board.statusRevision()).toBe(revision);
  for (const peer of ["claude", "codex", "kimi", "pi"]) expect(f.bus.pendingEnvelopes(peer)).toEqual([]);
  expect(f.board.surveyOpen("repo:fixture/survey")).toBeUndefined();
});

test("the survey ledger exists before proposal observers, assignment notices and the start receipt", async () => {
  const f = await fixture(), observed: number[] = [], notices: number[] = [];
  f.board.onChange = (task, event) => {
    if (event.event !== "proposed") return;
    const survey = f.board.surveyOfTask(task.id, task.created);
    expect(survey).toBeDefined(); observed.push(survey!.id);
  };
  f.deps.notify = () => {
    const task = f.board.list()[0]; if (!task) return;
    const survey = f.board.surveyOfTask(task.id, task.created);
    expect(survey).toBeDefined(); notices.push(survey!.id);
  };
  const started = await f.tasks.surveyStart("user", {});
  expect(observed).toEqual([started.survey]); expect(notices.length).toBeGreaterThan(0);
  expect(notices.every(id => id === started.survey)).toBe(true);
  expect(f.board.surveyOfTask(started.task, f.board.get(started.task)!.created)?.id).toBe(started.survey);
});

test("unknown proposal privacy cannot commit a PII survey task without its ledger", async () => {
  const f = await fixture(), events: number[] = []; f.board.onChange = task => { events.push(task.id); };
  f.deps.piiScreen = async () => ({ label: "unknown", miss: "failed", ms: 0 });
  await expect(f.tasks.surveyStart("user", {})).rejects.toThrow(/privacy|cleared|PII|pii/);
  expect(f.board.list()).toEqual([]); expect(events).toEqual([]);
  expect(f.board.surveyOpen("repo:fixture/survey")).toBeUndefined();
});

test("new survey briefs and readback include public prior reasons but only security identity stubs", async () => {
  const f = await fixture();
  const source = f.board.propose("user", { title: "Historical public decision", class: "test" });
  const entry: ConsideredEntry = { repo: "repo:fixture/survey", id: finding().id, pass: "bugs", paths: ["src/parser.ts"], reason: "REJECTION_REASON_CANARY existing validation covers it", ref: H0,
    source: { task: source.id, created: source.created, kind: "review" } };
  f.board.recordRejectedFinding(entry);
  f.board.recordRejectedFinding({ ...entry, id: "security-prior-boundary", pass: "security", reason: "SECURITY_REASON_CANARY", paths: ["secret-surface.ts"] });
  const s = await f.start(), brief = f.board.get(s.task)!.detail;
  expect(brief).toContain(entry.id); expect(brief).toContain("REJECTION_REASON_CANARY"); expect(brief).toContain("change unknown");
  expect(brief).toContain("security-prior-boundary"); expect(brief).not.toContain("SECURITY_REASON_CANARY"); expect(brief).not.toContain("secret-surface.ts");
  await f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()] });
  const view = f.tasks.surveyShow("user", s.task);
  expect(JSON.stringify(view)).toContain("REJECTION_REASON_CANARY");
  expect(JSON.stringify(view)).not.toContain("repo:fixture/survey");
  const security = f.tasks.consideredDetails(entry.repo, "security-prior-boundary", "security", H1);
  expect(JSON.stringify(security)).not.toContain("SECURITY_REASON_CANARY");
});

test("saved private or sensitive rejection facts retain withheld local stubs without a model screen", async () => {
  for (const privateTask of [false, true]) {
    const f = await fixture(), s = await f.start();
    if (privateTask) f.board.update(s.task, "user", "private upgrade", { signals: ["pii"] });
    else f.control.deny = true;
    let screens = 0; f.deps.piiScreen = async () => { screens++; throw new Error("private text must not be screened"); };
    const task = f.board.get(s.task)!;
    await f.tasks.recordConsideredFinding(task, { id: "sensitive-rejected-finding", pass: "bugs", severity: "important", disposition: "false_positive", path: "src/private.ts:12" },
      "IMPACT_CANARY private reason\ncontinued", "review", H1);
    const row = f.board.rejectedFindingsFor("repo:fixture/survey", "bugs", "sensitive-rejected-finding").rows[0]!;
    expect(screens).toBe(0); expect(row.entry.withheld).toBe(true); expect(row.entry.reason).toBe("reason not recorded"); expect(row.entry.paths).toEqual([]);
    expect(JSON.stringify(f.tasks.consideredDetails(row.entry.repo, row.entry.id, row.entry.pass, H1))).not.toContain("IMPACT_CANARY");
  }
});

test("committed review false-positive findings append one-line considered reasons and failures cannot undo approval", async () => {
  for (const fail of [false, true]) {
    const f = await fixture(), proposed = f.board.propose("user", { title: "Review target", class: "test" });
    f.board.update(proposed.id, "user", "accepted", { owner: "claude", reviewer: "codex", state: "in_progress" });
    f.board.update(proposed.id, "claude", "done", { state: "in_review" });
    if (fail) f.board.recordRejectedFinding = () => { throw new Error("PRIVATE_STORAGE_FAILURE_CANARY"); };
    const result = await f.tasks.review("user", proposed.id, "approved", undefined, undefined, H1, undefined,
      [{ id: "false-positive-parser", pass: "bugs", severity: "important", disposition: "false_positive", path: "src/parser.ts:12", rationale: "Existing guard\nalready covers it" }]);
    expect(result.state).toBe("approved");
    await Promise.resolve();
    if (!fail) {
      const entry = f.board.rejectedFindingsFor("repo:fixture/survey", "bugs", "false-positive-parser").rows[0]!.entry;
      expect(entry.reason).toBe("Existing guard already covers it"); expect(entry.paths).toEqual(["src/parser.ts"]); expect(entry.ref).toBe(H1);
    }
    expect(f.notices.join("\n")).not.toContain("PRIVATE_STORAGE_FAILURE_CANARY");
  }
});

test("audit rejection records an actual stored finding with fixed missing verifier reason and a withheld public brief", async () => {
  const f = await fixture(); f.config.security = securityPolicy({ paths: ["src/**"] });
  const audit = await f.tasks.auditStart("user", {}), task = f.board.get(audit.task)!;
  if (!task.owner) throw new Error("expected an assigned synthetic auditor");
  f.tasks.accept(task.owner, task.id);
  await f.tasks.auditReport(task.owner, { id: task.id, findings: [{ id: "audit-parser-boundary", pass: "security", severity: "important", disposition: "open", path: "src/parser.ts:12",
    rationale: "FINDER_RATIONALE_CANARY", state: "confirmed", boundary: { principal: "fixture peer", control: "input guard", resource: "fixture state", result: "invalid input accepted" } }] });
  await f.tasks.auditReport("user", { id: task.id, verify: [{ finding: "audit-parser-boundary", verdict: "rejected" }] });
  const entry = f.board.rejectedFindingsFor("repo:fixture/survey", "security", "audit-parser-boundary").rows[0]!.entry;
  expect(entry.reason).toBe("reason not recorded"); expect(entry.withheld).toBe(true); expect(entry.ref).toBe(H1); expect(entry.source.kind).toBe("audit");
  expect(f.tasks.consideredBrief(entry.repo, H1, ["src/**"])).toContain("audit-parser-boundary");
  expect(f.tasks.consideredBrief(entry.repo, H1, ["src/**"])).not.toContain("FINDER_RATIONALE_CANARY");
});

test("survey recovery proof streams deterministic private counts and digest and refuses corrupt rows", async () => {
  const f = await fixture(); expect(f.board.hasSurveyState()).toBe(false);
  const s = await f.start(); expect(f.board.hasSurveyState()).toBe(true);
  const initial = f.board.surveyIntegrity(); expect(initial).toMatchObject({ surveys: 1, findings: 0, considered: 0 });
  await f.tasks.surveyReport(s.owner, { id: s.task, findings: [finding()], vet: [{ id: finding().id, verdict: "rejected", reason: "Already covered" }] });
  const proof = f.board.surveyIntegrity(); expect(proof).toEqual(f.board.surveyIntegrity());
  expect(proof).toMatchObject({ surveys: 1, findings: 1, considered: 1 }); expect(proof.digest).not.toBe(initial.digest);
  expect(JSON.stringify(proof)).not.toMatch(/IMPACT_CANARY|Already covered|fixture\/survey|src\/parser/);
  const db = new Database(f.file); db.query("UPDATE considered_findings SET body=?").run("PRIVATE_BAD_BODY_CANARY"); db.close();
  expect(() => f.board.surveyIntegrity()).toThrow("survey storage invalid");
});
