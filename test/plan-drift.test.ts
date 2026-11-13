import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type TaskPlan } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcMode } from "../src/hub/sdlc.ts";
import { profileTaskTools, TASK_TOOLS } from "../src/hub/hub-tools.ts";

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
      changed: (from, to) => { state.reads.push(`${from}..${to}`); return state.paths; },
    },
  };
  const tasks = new Tasks(deps);
  cleanups.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  function card(plan: TaskPlan = { paths: ["src"], base: BASE }, head: string | undefined = HEAD) {
    const task = board.propose("user", { title: "plan drift fixture", class: "triage", plan, refs: head ? { commit: head } : {} });
    return board.update(task.id, "user", "assigned", { owner: "codex" });
  }
  return { board, tasks, deps, state, card };
}

test("#1403 accept and done tool readbacks compare base to the recorded task head, advice only", async () => {
  const r = rig(), row = r.card();
  const accepted = await r.tasks.acceptReviewed("codex", row.id);
  expect(accepted.state).toBe("in_progress");
  expect(r.tasks.planGuardText(accepted)).toContain("drift: changed (src/a.ts)");
  r.state.paths = [];
  const done = await r.tasks.done("codex", row.id, undefined, { commit: HEAD });
  expect(done.state).toBe("approved");
  expect(r.tasks.takeDoneNote(done.id)).toContain("drift: none");
  expect(r.state.reads).toContain(`${BASE}..${HEAD}`);
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

test("#1403 missing task head and foreign repository never read the checkout", () => {
  const r = rig(), missing = r.card();
  const withoutHead = r.board.update(missing.id, "user", "metadata", { refs: { commit: undefined } });
  expect(r.tasks.planGuardText(withoutHead)).toContain("drift: unknown");
  const foreign = r.board.update(missing.id, "user", "metadata", { refs: { repo: "other/project", commit: HEAD } });
  expect(r.tasks.planGuardText(foreign)).toContain("drift: unknown");
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
  expect(r.tasks.overlaps(accepted)).toBeDefined();
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
