import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type PlanIssueMetadata } from "../src/hub/sdlc.ts";
import type { SpecsCheckReport } from "../src/hub/specs.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-roadmap-tasks-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const roles: Record<string, string[]> = { claude: ["conductor"], kimi: ["planner"], codex: ["implementer"] };
  const control: { private: boolean; observer: boolean; screening: boolean; screen?: () => Promise<void>; patterns?: string[] } = { private: false, observer: false, screening: false };
  const notices: string[] = [], routing = loadRouting(cwd);
  const specs: SpecsCheckReport = { specCount: 0, errors: 0, warnings: 0, stale: 0, truncated: false, freshness: [], items: [] };
  const tasks = new Tasks({ board, bus, cwd, project: "roadmap-fixture", repository: "example/repo", roles, notify: message => { notices.push(message); },
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_patterns: control.patterns ?? routing.signals.pii_patterns, pii_screen: control.screening ? "local" : "off" }, constraints: { ...routing.constraints, pii: "local_only" } }),
    privateTurn: () => control.private, reviewObserverInput: () => control.observer,
    operational: by => by === "claude" && roles.claude?.includes("conductor") === true,
    piiScreen: async () => { await control.screen?.(); return { label: "clear", ms: 0 }; },
    specsRead: action => action === "check" ? specs : { specs: [], errors: 0, truncated: false, items: [] }, sdlc: { config: () => sdlcConfig(undefined) } });
  return { cwd, board, bus, tasks, roles, control, notices, specs };
}
const fields = (title = "Outcome milestone") => ({ title, outcome: "Observable outcome", horizon: "now" as const, order: 0 });
function issueReceipt(board: Board, task: Task, issue: number, state: PlanIssueMetadata["state"], recordedAt = 1000) {
  return board.update(task.id, "user", "plan reviewed", { sdlc: { stage: "intent", repo: "example/repo", issue,
    planReview: { planner: "kimi", planningRevision: 0, recordedAt, issue: { repo: "example/repo", issue, state, editedAt: "2026-11-14T00:00:00Z" } } } });
}

test("person, planner and current conductor write; an ordinary peer only reads; stale revision has no effects", async () => {
  const f = fixture(), one = await f.tasks.milestoneNew("kimi", fields());
  const two = await f.tasks.milestoneNew("claude", fields("Conductor milestone"));
  expect(f.tasks.milestoneList("codex").map(row => row.id)).toEqual([one.id, two.id]);
  expect(f.tasks.milestoneShow("codex", one.id).title).toBe(fields().title);
  const before = f.board.milestones();
  await expect(f.tasks.milestoneNew("codex", fields("Not admitted"))).rejects.toThrow();
  await expect(f.tasks.milestoneEdit("codex", one.id, one.revision, { title: "Not admitted" })).rejects.toThrow();
  expect(() => f.tasks.milestoneLink("codex", one.id, "issue", "example/repo#1")).toThrow();
  expect(f.board.milestones()).toEqual(before);
  const updated = await f.tasks.milestoneEdit("kimi", one.id, one.revision, { title: "Updated" });
  await expect(f.tasks.milestoneEdit("kimi", one.id, one.revision, { title: "Stale" })).rejects.toThrow("revision");
  expect(f.board.milestone(one.id)?.title).toBe("Updated");
  expect(f.board.milestone(one.id)?.revision).toBe(updated.revision);
  f.tasks.milestoneOrder("kimi", one.id, 5);
  expect(f.tasks.milestoneList("codex").map(row => row.id)).toEqual([two.id, one.id]);
});

test("done/dropped require the person through every write surface and closed milestones stay final", async () => {
  const f = fixture(), one = await f.tasks.milestoneNew("user", fields());
  for (const state of ["done", "dropped"] as const) {
    for (const by of ["kimi", "claude"]) {
      await expect(f.tasks.milestoneNew(by, { ...fields("Smuggled state"), state })).rejects.toThrow("person");
      await expect(f.tasks.milestoneEdit(by, one.id, one.revision, { state })).rejects.toThrow("person");
      expect(() => f.tasks.milestoneState(by, one.id, state)).toThrow("person");
    }
  }
  expect(f.board.milestones()).toHaveLength(1);
  f.tasks.milestoneState("kimi", one.id, "planned");
  f.tasks.milestoneState("claude", one.id, "active");
  const settled = f.tasks.milestoneState("user", one.id, "done"), before = f.board.milestone(one.id);
  expect(settled.state).toBe("done");
  await expect(f.tasks.milestoneEdit("user", one.id, settled.revision, { title: "Reopened" })).rejects.toThrow();
  expect(() => f.tasks.milestoneState("user", one.id, "active")).toThrow();
  expect(() => f.tasks.milestoneLink("kimi", one.id, "spec", "hub.goal")).toThrow();
  expect(f.board.milestone(one.id)).toEqual(before);
});

test("source issue inheritance is repository qualified and explicit task placement wins everywhere", async () => {
  const f = fixture(), inherited = await f.tasks.milestoneNew("user", fields("Inherited")), explicit = await f.tasks.milestoneNew("user", fields("Explicit"));
  const imported = f.board.propose("user", { title: "Imported work", class: "implement", external: { provider: "github", repo: "example/repo", issue: 42, url: "https://github.com/example/repo/issues/42" } });
  const foreign = f.board.propose("user", { title: "Different repository", class: "implement", external: { provider: "github", repo: "other/repo", issue: 42, url: "https://github.com/other/repo/issues/42" } });
  f.tasks.milestoneLink("kimi", inherited.id, "issue", "Example/Repo#42");
  let view = f.tasks.milestoneShow("codex", inherited.id);
  expect(view.tasks.map(task => task.id)).toEqual([imported.id]);
  expect(view.tasks[0]?.placement).toEqual({ rule: "source-issue", issue: "example/repo#42" });
  expect(view.tasks.some(task => task.id === foreign.id)).toBe(false);
  f.tasks.milestoneLink("claude", explicit.id, "task", String(imported.id));
  expect(f.tasks.milestoneShow("codex", inherited.id).tasks).toEqual([]);
  expect(f.tasks.milestoneShow("codex", explicit.id).tasks[0]?.placement).toEqual({ rule: "explicit" });
  f.tasks.milestoneUnlink("kimi", explicit.id, "task", String(imported.id));
  view = f.tasks.milestoneShow("codex", inherited.id);
  expect(view.tasks[0]?.id).toBe(imported.id);
  const plan = f.board.propose("user", { title: "Lifecycle issue", class: "plan" });
  issueReceipt(f.board, plan, 42, "OPEN");
  expect(f.tasks.milestoneShow("codex", inherited.id).tasks.map(task => task.id)).toContain(plan.id);
});

test("rollup uses cached issue evidence, spec freshness and train states; missing evidence stays unknown", async () => {
  const f = fixture(), milestone = await f.tasks.milestoneNew("user", fields());
  const task = f.board.propose("user", { title: "Approved plan", class: "plan" });
  f.board.update(task.id, "user", "accepted", { state: "in_progress" });
  issueReceipt(f.board, f.board.get(task.id)!, 42, "CLOSED");
  f.board.update(task.id, "user", "approved", { state: "approved" });
  for (const ref of ["example/repo#42", "example/repo#43"]) f.tasks.milestoneLink("kimi", milestone.id, "issue", ref);
  for (const id of ["fresh.spec", "stale.spec", "unverified.spec", "missing.spec"]) f.tasks.milestoneLink("kimi", milestone.id, "spec", id);
  f.specs.freshness = [{ id: "fresh.spec", path: "docs/fresh.md", state: "fresh", commitsSince: 0, dirty: false }, { id: "stale.spec", path: "docs/stale.md", state: "stale", commitsSince: 1, dirty: false }, { id: "unverified.spec", path: "docs/unverified.md", state: "unverified", commitsSince: null, dirty: null }];
  const release = f.board.newRelease("train", "Delivery", 0);
  f.board.updateRelease(release.id, { state: "active" }, 0); f.board.updateRelease(release.id, { state: "frozen" }, 1); f.board.updateRelease(release.id, { state: "shipped" }, 2);
  f.tasks.milestoneLink("kimi", milestone.id, "release", String(release.id));
  const view = f.tasks.milestoneShow("codex", milestone.id);
  expect(view.rollup.tasks).toMatchObject({ approved: 1, total: 1 });
  expect(view.rollup.issues).toMatchObject({ closed: 1, total: 2, unknown: 1 });
  expect(view.rollup.specs).toMatchObject({ fresh: 1, stale: 1, unverified: 1, unknown: 1, total: 4 });
  expect(view.rollup.releases).toMatchObject({ shipped: 1, total: 1, unknown: 0 });
  expect(view.issues.find(issue => issue.ref === "example/repo#42")?.state).toBe("closed");
  expect(view.issues.find(issue => issue.ref === "example/repo#43")?.state).toBe("unknown");
  const contradictory = f.board.propose("user", { title: "Conflicting receipt", class: "plan" });
  issueReceipt(f.board, contradictory, 42, "OPEN");
  expect(f.tasks.milestoneShow("codex", milestone.id).issues.find(issue => issue.ref === "example/repo#42")?.state).toBe("unknown");
});

test("a newly private issue reference is withheld from inherited placement on every readback", async () => {
  const f = fixture(), milestone = await f.tasks.milestoneNew("user", fields());
  const ref = "example/repo#42", imported = f.board.propose("user", { title: "Ordinary inherited work", class: "plan", external: { provider: "github", repo: "example/repo", issue: 42, url: "https://github.com/example/repo/issues/42" } });
  f.tasks.milestoneLink("kimi", milestone.id, "issue", ref);
  expect(f.tasks.milestoneShow("codex", milestone.id).tasks[0]?.placement).toEqual({ rule: "source-issue", issue: ref });
  const stored = f.board.milestoneLinks(milestone.id), before = f.board.get(imported.id);
  f.control.patterns = [ref];
  for (const by of ["user", "codex"]) {
    const view = f.tasks.milestoneShow(by, milestone.id);
    expect(view.tasks).toEqual([]);
    expect(view.withheld).toBe(1);
    expect(view.links).toEqual([]);
    expect(view.issues).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(ref);
    expect(JSON.stringify(f.tasks.milestoneList(by))).not.toContain(ref);
  }
  expect(f.board.milestoneLinks(milestone.id)).toEqual(stored);
  expect(f.board.get(imported.id)).toEqual(before);
});

test("private task content and ids are absent from public rows, links, histories and notices", async () => {
  const f = fixture(), milestone = await f.tasks.milestoneNew("user", fields());
  const secret = f.board.propose("user", { title: "ROADMAP_PRIVATE_TITLE_CANARY", detail: "ROADMAP_PRIVATE_DETAIL_CANARY", class: "implement", signals: ["pii_path"] });
  f.tasks.milestoneLink("user", milestone.id, "task", String(secret.id));
  for (const by of ["user", "codex"]) {
    const view = f.tasks.milestoneShow(by, milestone.id);
    expect(view.withheld).toBe(1);
    expect(view.tasks).toEqual([]);
    expect(view.links.some(link => link.kind === "task")).toBe(false);
    expect(JSON.stringify(view)).not.toContain("ROADMAP_PRIVATE_");
    expect(JSON.stringify(f.tasks.milestoneList(by))).not.toContain("ROADMAP_PRIVATE_");
    expect(view.history.every(entry => !("ref" in entry) && !("task" in entry))).toBe(true);
  }
  expect(f.notices.join("\n")).not.toContain("ROADMAP_PRIVATE_");
});

test("private/observer contexts and a privacy or role change during screening refuse without writes", async () => {
  const f = fixture();
  for (const key of ["private", "observer"] as const) {
    f.control[key] = true;
    expect(() => f.tasks.milestoneList("codex")).toThrow();
    await expect(f.tasks.milestoneNew("kimi", fields())).rejects.toThrow();
    f.control[key] = false;
  }
  f.control.screening = true;
  f.control.screen = async () => { f.control.private = true; };
  await expect(f.tasks.milestoneNew("kimi", fields())).rejects.toThrow();
  expect(f.board.milestones()).toEqual([]);
  f.control.private = false;
  f.control.screen = async () => { f.roles.kimi = []; };
  await expect(f.tasks.milestoneNew("kimi", fields())).rejects.toThrow();
  expect(f.board.milestones()).toEqual([]);
});
