import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type TaskPlan } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcMode } from "../src/hub/sdlc.ts";
import { gitAuditSource } from "../src/hub/audit-source.ts";
import { hubGitEnv, hubGitSync } from "../src/hub/git.ts";
import { profileTaskTools, roleContract, TASK_TOOLS } from "../src/hub/hub-tools.ts";

const BASE = "a".repeat(40), HEAD = "b".repeat(40), cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function rig(mode: SdlcMode = "advise") {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-plan-drift-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const state = { mode, paths: ["src/a.ts", "README.md"] as string[] | undefined, missing: false, failure: false, private: false, reads: [] as string[] };
  const deps: TasksDeps = { cwd, repository: "o/r", project: "fixture", board, bus, routing: () => loadRouting(cwd), notify: () => {},
    privateTurn: () => state.private,
    sdlc: { config: () => sdlcConfig({ mode: state.mode }) },
    auditSource: {
      head: () => { throw new Error("checkout HEAD must never substitute for task head"); },
      resolve: ref => { state.reads.push(ref); if (state.failure) throw new Error("unreadable"); return state.missing ? undefined : ref; },
      defaultTip: () => { state.reads.push("defaultTip"); return state.missing ? undefined : HEAD; },
      mergeBase: (from, to) => { state.reads.push(`mergeBase:${from}:${to}`); return state.missing ? undefined : from === BASE ? BASE : HEAD; },
      changed: (from, to) => { state.reads.push(`${from}..${to}`); return state.paths; },
    },
  };
  const tasks = new Tasks(deps);
  cleanups.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  function card(plan: TaskPlan = { paths: ["src"], base: BASE }, head: string | null = HEAD) {
    const task = board.propose("user", { title: "plan drift fixture", class: "triage", plan, refs: head ? { commit: head } : {} });
    return board.update(task.id, "user", "assigned", { owner: "codex" });
  }
  return { cwd, board, tasks, deps, state, card };
}

function graph() {
  const r = rig();
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", r.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      encoding: "utf8", env: hubGitEnv(process.env, { repositoryIsolation: true, readOnlyDiagnostic: true }), timeout: 3000, maxBuffer: 64 * 1024 });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed`);
    return result.stdout.trim();
  };
  git("init", "-b", "main"); mkdirSync(join(r.cwd, "src"));
  const commit = (file: string) => { writeFileSync(join(r.cwd, file), file + "\n"); git("add", "--", file); git("commit", "-m", "fixture change"); return git("rev-parse", "HEAD"); };
  const base = commit("src/base.ts");
  const tip = (sha: string) => { git("update-ref", "refs/remotes/origin/main", sha); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"); };
  tip(base); r.deps.auditSource = gitAuditSource(r.cwd);
  return { ...r, git, commit, base, tip };
}

test("#1403 accept reads only local default upstream tip, requires no task head, and never substitutes checkout HEAD", async () => {
  const r = graph(), upstream = r.commit("src/upstream.ts"); r.tip(upstream);
  r.git("checkout", "-b", "task", r.base); r.commit("src/own.ts");
  const row = r.card({ paths: ["src"], base: r.base }, null), accepted = await r.tasks.acceptReviewed("codex", row.id);
  expect(accepted.state).toBe("in_progress"); expect(accepted.refs.commit).toBeUndefined();
  const advice = r.tasks.planGuardText(accepted);
  expect(advice).toContain("at accept"); expect(advice).toContain("drift: changed (src/upstream.ts)"); expect(advice).not.toContain("own.ts");
});

test("#1403 done excludes own commits and reports only integrated upstream movement", async () => {
  for (const scenario of ["own", "upstream", "both", "not-integrated"] as const) {
    const r = graph();
    const upstream = scenario === "own" ? r.base : r.commit("src/upstream.ts"); r.tip(upstream);
    r.git("checkout", "-b", "task", r.base);
    if (scenario !== "upstream") r.commit("src/own.ts");
    if (scenario !== "not-integrated") r.git("merge", "--no-edit", upstream);
    const head = r.git("rev-parse", "HEAD"), row = r.card({ paths: ["src"], base: r.base }, head);
    r.tasks.accept("codex", row.id); const done = await r.tasks.done("codex", row.id, undefined, { commit: head });
    expect(done.state).toBe("approved");
    const advice = r.tasks.takeDoneNote(done.id)!; expect(advice).toContain("at done"); expect(advice).not.toContain("own.ts");
    expect(advice).toContain(scenario === "own" || scenario === "not-integrated" ? "drift: none" : "drift: changed (src/upstream.ts)");
  }
});

test("#1403 Git misses, equal nonexistent SHAs and thrown reads remain unknown", async () => {
  for (const failure of ["missing", "failure", "inventory"] as const) {
    const r = rig(), row = r.card({ base: HEAD, paths: ["src"] });
    if (failure === "inventory") r.state.paths = undefined; else r.state[failure] = true;
    const accepted = r.tasks.accept("codex", row.id);
    expect(r.tasks.planGuardText(accepted)).toContain("drift: unknown");
    expect((await r.tasks.done("codex", row.id)).state).toBe("approved");
    expect(r.tasks.takeDoneNote(row.id)).toContain("drift: unknown");
  }
});

test("#1403 unknown and changed drift are not enforce gates", async () => {
  for (const paths of [undefined, ["src/a.ts"]]) {
    const r = rig("enforce"); r.state.paths = paths;
    const row = r.card(), accepted = await r.tasks.acceptReviewed("codex", row.id);
    expect(accepted.state).toBe("in_progress");
    expect(r.tasks.planGuardText(accepted)).toContain(`drift: ${paths ? "changed" : "unknown"}`);
  }
});

test("#1403 accept needs no task head and foreign repository never reads the project Git source", () => {
  const r = rig(), missing = r.card();
  const withoutHead = r.board.update(missing.id, "user", "metadata", { refs: { commit: undefined } });
  expect(r.tasks.planGuardText(withoutHead)).toContain("drift: changed");
  r.state.reads.length = 0;
  const foreign = r.board.update(missing.id, "user", "metadata", { refs: { repo: "other/project", commit: HEAD } });
  expect(r.tasks.planGuardText(foreign)).toContain("drift: unknown");
  const foreignArtifact = r.board.update(missing.id, "user", "metadata", { refs: { repo: undefined, commit: HEAD }, sdlc: { stage: "build", repo: "other/project", head: HEAD } });
  expect(r.tasks.planGuardText(foreignArtifact)).toContain("drift: unknown");
  expect(r.state.reads).toEqual([]);
});

test("#1403 lifecycle off and private work add no readback or Git reads", () => {
  for (const mode of ["off", "advise"] as const) {
    const r = rig(mode), row = r.card(); r.state.private = mode !== "off";
    expect(r.tasks.planGuardText(row)).toBe("");
    expect(r.tasks.takeDoneNote(row.id)).toBeUndefined();
    expect(r.state.reads).toEqual([]);
  }
  const r = rig(), row = r.card();
  const pii = r.board.update(row.id, "user", "metadata", { signals: ["pii"] });
  expect(r.tasks.planGuardText(pii)).toBe("");
  expect(r.tasks.publicView(pii).plan).toEqual({});
});

test("#1403 cold intent survives storage and the task brief, verify is text only", () => {
  const r = rig(), row = r.card({ paths: ["src"] });
  const plan = { paths: ["src"], base: BASE, out_of_scope: ["./src//private/"], stop_if: ["  API changes  "], steps: [{ description: " Edit source ", verify: " touch must-not-run; expect absent " }] };
  const accepted = r.tasks.accept("codex", row.id, plan);
  expect(r.board.get(row.id)?.plan).toEqual({ ...plan, out_of_scope: ["src/private"], stop_if: ["API changes"], steps: [{ description: "Edit source", verify: "touch must-not-run; expect absent" }] });
  expect(r.tasks.publicView(accepted).plan).toEqual(r.board.get(row.id)?.plan);
  expect(existsSync(join(r.cwd, "must-not-run"))).toBe(false);
});

test("#1403 malformed cold intent is refused pre-effect; off preserves old ignored-input behavior", () => {
  const invalid = [{ base: "main" }, { base: "A".repeat(40) }, { stop_if: ["x".repeat(513)] }, { out_of_scope: Array(33).fill("src") }, { steps: [{ description: "a", verify: 5 }] }, { steps: [{ description: "a", execute: "x" }] }];
  for (const fields of invalid) {
    const r = rig(), row = r.card();
    expect(() => r.tasks.accept("codex", row.id, { paths: ["src"], ...fields })).toThrow(/plan\./);
    expect(r.board.get(row.id)).toEqual(row);
  }
  const r = rig("off"), row = r.card({ paths: ["src"] });
  expect(r.tasks.accept("codex", row.id, { paths: ["src"], base: "ignored", steps: "ignored" }).plan).toEqual({ paths: ["src"] });
});

test("#1403 every new free-text intent field enters the existing accept privacy screen", () => {
  for (const fields of [{ stop_if: ["patient 900101-1234567"] }, { out_of_scope: ["patient 900101-1234567"] }, { steps: [{ description: "patient 900101-1234567" }] }, { steps: [{ description: "check", verify: "patient 900101-1234567" }] }]) {
    const r = rig(), row = r.card({ paths: ["src"] });
    expect(() => r.tasks.accept("codex", row.id, { paths: ["src"], ...fields })).toThrow(/PII/);
    expect(r.board.get(row.id)).toEqual(row);
  }
});

test("#1403 cold plan schemas are lifecycle-only for dev, other profiles and nested split", () => {
  expect(profileTaskTools()).toBe(TASK_TOOLS);
  for (const enabled of [false, true]) for (const profile of ["dev", "research", "writing"] as const) {
    const tools = profileTaskTools(profile, undefined, enabled);
    for (const name of ["hub_task_propose", "hub_task_accept", "hub_backlog_split"]) {
      const tool = tools.find(t => t.name === name)!;
      const properties = tool.inputSchema.properties as any;
      const plan = name === "hub_backlog_split" ? properties.parts.items.properties.plan : properties.plan;
      for (const field of ["base", "out_of_scope", "stop_if", "steps"]) expect(Object.hasOwn(plan.properties, field)).toBe(enabled);
    }
  }
});


test("#1403 forbidden files still produce base drift when inside plan.paths", () => {
  const r = rig(), row = r.card({ base: BASE, paths: ["src"], out_of_scope: ["src/private"] });
  r.state.paths = ["src/private/a.ts"];
  expect(r.tasks.planGuardText(row)).toContain("drift: changed (src/private/a.ts)");
});

test("#1403 current privacy state withholds drift names from public readback", () => {
  const r = rig(), row = r.card();
  r.state.paths = ["src/patient 900101-1234567.ts"];
  expect(r.tasks.planGuardText(row)).toContain("drift: unknown");
  expect(r.tasks.planGuardText(row)).not.toContain("900101");
});


test("#1403 planner cold-readable role guidance is lifecycle-only", () => {
  expect(roleContract("codex", { codex: ["planner"] })).not.toContain("out_of_scope");
  expect(roleContract("codex", { codex: ["planner"] }, [], "dev", true)).toContain("steps with verify commands and expected results");
});


test("#1403 missing default, shallow and unrelated histories remain unknown with real local Git", () => {
  for (const kind of ["missing", "wrong-target", "shallow", "unrelated", "base-after-endpoint"] as const) {
    const r = graph(); let base = r.base, head = r.base;
    if (kind === "missing") r.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    if (kind === "wrong-target") r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main");
    if (kind === "shallow") writeFileSync(join(r.cwd, ".git", "shallow"), r.base + "\n");
    if (kind === "unrelated") { r.git("checkout", "--orphan", "unrelated"); r.git("rm", "-r", "--cached", "."); head = r.commit("src/unrelated.ts"); r.tip(head); }
    if (kind === "base-after-endpoint") { r.git("checkout", "-b", "task"); base = head = r.commit("src/own.ts"); }
    const row = r.card({ base, paths: ["src"] }, head);
    expect(r.tasks.planGuardText(row)).toContain("drift: unknown");
    expect(r.tasks.takeDoneNote(row.id)).toContain("drift: unknown");
  }
});

test("#1403 moving local default ref, absent optional ports, and missing recorded done head remain unknown", () => {
  const moving = rig(), row = moving.card(); let calls = 0;
  moving.deps.auditSource!.defaultTip = () => ++calls === 1 ? HEAD : BASE;
  expect(moving.tasks.planGuardText(row)).toContain("drift: unknown");
  const absent = rig(), legacy = absent.card(); delete absent.deps.auditSource!.defaultTip;
  expect(absent.tasks.planGuardText(legacy)).toContain("drift: unknown"); expect(absent.state.reads).toEqual([]);
  const missing = rig(), noHead = missing.card({ base: BASE, paths: ["src"] }, null);
  expect(missing.tasks.takeDoneNote(noHead.id)).toContain("drift: unknown");
});

test("#1403 no-base intent stays silent without any upstream Git reads", () => {
  const r = rig(), row = r.card({ paths: ["src"] });
  expect(r.tasks.planGuardText(row)).toBe(""); expect(r.tasks.takeDoneNote(row.id)).toBeUndefined(); expect(r.state.reads).toEqual([]);
});


test("#1403 ambiguous criss-cross merge bases never choose one upstream endpoint", () => {
  const r = graph(), left = r.commit("src/left.ts");
  r.git("checkout", "-b", "right", r.base); const right = r.commit("src/right.ts");
  const tree = r.git("rev-parse", `${left}^{tree}`);
  const upstream = r.git("commit-tree", tree, "-p", left, "-p", right, "-m", "fixture merge one");
  const taskHead = r.git("commit-tree", tree, "-p", right, "-p", left, "-m", "fixture merge two"); r.tip(upstream);
  expect(r.deps.auditSource!.mergeBase!(taskHead, upstream)).toBeUndefined();
  const row = r.card({ base: r.base, paths: ["src"] }, taskHead);
  expect(r.tasks.takeDoneNote(row.id)).toContain("drift: unknown");
});
