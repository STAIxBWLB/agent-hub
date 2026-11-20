import { expect, test } from "bun:test";
import { planRoadmapMirror, recoverMirrorBinding, readMirrorSnapshot } from "../src/hub/roadmap-sync.ts";
import { roadmapConfig } from "../src/hub/roadmap.ts";

test("mirror config is disabled by default and refuses unknown fields or authority values", () => {
  expect(roadmapConfig(undefined)).toEqual({ github_mirror: false, github_write: "off" });
  expect(roadmapConfig({ github_mirror: true, github_write: "conductor" })).toEqual({ github_mirror: true, github_write: "conductor" });
  for (const bad of [{ github_write: "planner" }, { github_mirror: "true" }, { unknown: true }]) expect(() => roadmapConfig(bad)).toThrow();
});

test("recovery binds only an unambiguous marker, never a matching title", () => {
  const marker = "<!-- ahub-roadmap:project:4 -->";
  const row = { number: 8, title: "Outcome", description: null };
  expect(recoverMirrorBinding(marker, "Outcome", [])).toEqual({ kind: "create", titleConflicts: [] });
  expect(recoverMirrorBinding(marker, "Outcome", [row])).toEqual({ kind: "create", titleConflicts: [8] });
  expect(recoverMirrorBinding(marker, "Outcome", [{ ...row, description: marker }])).toEqual({ kind: "bind", number: 8, titleConflicts: [] });
  expect(recoverMirrorBinding(marker, "Outcome", [{ ...row, description: marker }, { ...row, number: 2, description: marker }])).toEqual({ kind: "ambiguous", numbers: [2, 8], titleConflicts: [] });
  expect(() => recoverMirrorBinding("", "Outcome", [row])).toThrow("invalid roadmap marker");
});

test("new milestone preview contains creation only, with a separately bound membership preview", () => {
  const desired = { title: "Outcome", state: "open" as const, issues: [4], marker: "<!-- ahub-roadmap:project:4 -->" };
  const create = planRoadmapMirror("example/repo", desired, null, []);
  expect(create.calls).toEqual([["api", "repos/example/repo/milestones", "--hostname", "github.com", "--method", "POST", "-f", "title=Outcome", "-f", "state=open", "-f", "description=<!-- ahub-roadmap:project:4 -->"]]);
  const next = planRoadmapMirror("example/repo", desired, { number: 7, title: "Outcome", state: "open" }, [{ number: 4, milestone: null }]);
  expect(next.calls).toEqual([["api", "repos/example/repo/issues/4", "--hostname", "github.com", "--method", "PATCH", "-F", "milestone=7"]]);
  expect(next.fingerprint).not.toBe(create.fingerprint);
  expect(planRoadmapMirror("example/repo", desired, { number: 7, title: "Outcome", state: "open" }, [{ number: 4, milestone: 7 }]).calls).toEqual([]);
});

test("incomplete or duplicate remote membership cannot become a write plan", () => {
  const desired = { title: "Outcome", state: "open" as const, issues: [4], marker: "<!-- ahub-roadmap:project:4 -->" };
  const remote = { number: 7, title: "Outcome", state: "open" as const };
  expect(() => planRoadmapMirror("example/repo", desired, remote, [])).toThrow("incomplete");
  expect(() => planRoadmapMirror("example/repo", desired, remote, [{ number: 4, milestone: null }, { number: 4, milestone: null }])).toThrow("duplicate");
});

test("mirror reads all states, refuses incomplete pages and excludes pull requests", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(args[1]?.includes("/milestones?")
      ? [{ number: 7, title: "Outcome", state: "closed", description: "<!-- ahub-roadmap:project:4 -->", html_url: "https://github.com/example/repo/milestone/7" }]
      : [{ number: 4, milestone: { number: 7 }, html_url: "https://github.com/example/repo/issues/4", pull_request: false }, { number: 5, milestone: null, pull_request: true }]) };
  };
  const snapshot = await readMirrorSnapshot("example/repo", run);
  expect(snapshot.milestones).toMatchObject([{ number: 7, state: "closed" }]);
  expect(snapshot.issues).toEqual([{ number: 4, milestone: 7 }]);
  expect(calls.every(args => args[1]?.includes("state=all"))).toBe(true);
  await expect(readMirrorSnapshot("example/repo", async () => ({ code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))) }))).rejects.toThrow("duplicated");
  await expect(readMirrorSnapshot("example/repo", async () => ({ code: 1, stdout: "" }))).rejects.toThrow("unavailable");
});

test("mirror binding reuses import marks, is idempotent and refuses either identity collision", async () => {
  const { Board } = await import("../src/hub/board.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "roadmap-binding-")), board = new Board(join(dir, "hub.db"));
  try {
    const a = board.newMilestone({ title: "A", outcome: "One" }, "user");
    const b = board.newMilestone({ title: "B", outcome: "Two" }, "user");
    board.bindMirrorMilestone("Example/Repo", a.id, 7);
    board.bindMirrorMilestone("example/repo", a.id, 7);
    expect(board.mirrorMilestone("example/repo", a.id)).toBe(7);
    expect(board.importedMilestone("example/repo", 7)).toBe(a.id);
    expect(() => board.bindMirrorMilestone("example/repo", b.id, 7)).toThrow("conflicts");
    expect(() => board.bindMirrorMilestone("example/repo", a.id, 8)).toThrow("conflicts");
    const imported = board.importMilestone("example/repo", 9, { title: "C", outcome: "Three" }, "user");
    expect(board.mirrorMilestone("example/repo", imported.milestone.id)).toBe(9);
  } finally { board.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Tasks previews fixed writes, requires confirmation and persists a two-phase mirror without real GitHub", async () => {
  const { Board } = await import("../src/hub/board.ts");
  const { Bus } = await import("../src/hub/bus.ts");
  const { Tasks } = await import("../src/hub/tasks.ts");
  const { loadRouting } = await import("../src/hub/routing.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "roadmap-sync-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const remote: any[] = [], issues = [{ number: 4, milestone: null as null | { number: number }, html_url: "https://github.com/example/repo/issues/4", pull_request: false }], writes: string[][] = [];
  let origin: string | undefined = "example/repo";
  const gh = async (args: string[]) => {
    if (args[1]?.includes("/milestones?")) return { code: 0, stdout: JSON.stringify(remote) };
    if (args[1]?.includes("/issues?")) return { code: 0, stdout: JSON.stringify(issues) };
    writes.push(args);
    if (args[1] === "repos/example/repo/milestones") {
      const created = { number: 7, title: "Outcome", state: "open", description: args.find(s => s.startsWith("description="))!.slice(12), html_url: "https://github.com/example/repo/milestone/7" };
      remote.push(created); return { code: 0, stdout: JSON.stringify(created) };
    }
    if (args[1] === "repos/example/repo/issues/4") { issues[0]!.milestone = { number: 7 }; return { code: 0, stdout: "{}" }; }
    return { code: 1, stdout: "" };
  };
  const tasks = new Tasks({ cwd: dir, board, bus, project: "project", repository: "example/repo", routing: () => loadRouting(dir),
    roadmapGh: gh, roadmapOrigin: () => origin, roadmapConfig: () => ({ github_mirror: true, github_write: "off" }), notify: () => {} });
  try {
    const milestone = board.newMilestone({ title: "Outcome", outcome: "Deliver" }, "user");
    board.linkMilestone(milestone.id, "issue", "example/repo#4", "user", milestone.revision);
    const first = await tasks.roadmapSync("user");
    expect(first.calls).toHaveLength(1); expect(first.calls[0]).toContain(`description=<!-- ahub-roadmap:project:${milestone.id} -->`);
    origin = "other/repo"; await expect(tasks.roadmapSync("user", { apply: true, confirm: first.fingerprint })).rejects.toThrow("origin"); origin = "example/repo";
    await expect(tasks.roadmapSync("user", { apply: true })).rejects.toThrow("preview changed"); expect(writes).toHaveLength(0);
    await expect(tasks.roadmapSync("codex", { apply: true, confirm: first.fingerprint })).rejects.toThrow("require the person"); expect(writes).toHaveLength(0);
    await tasks.roadmapSync("user", { apply: true, confirm: first.fingerprint }); expect(board.mirrorMilestone("example/repo", milestone.id)).toBe(7);
    const second = await tasks.roadmapSync("user"); expect(second.calls).toHaveLength(1);
    await tasks.roadmapSync("user", { apply: true, confirm: second.fingerprint });
    expect((await tasks.roadmapSync("user")).calls).toEqual([]); expect(writes).toHaveLength(2);
    const other = board.newMilestone({ title: "Other", outcome: "Deliver" }, "user");
    board.bindMirrorMilestone("example/repo", other.id, 8);
    remote.push({ number: 8, title: "Other", state: "open", description: "", html_url: "https://github.com/example/repo/milestone/8" });
    const current = board.milestone(milestone.id)!;
    board.unlinkMilestone(milestone.id, "issue", "example/repo#4", "user", current.revision);
    board.linkMilestone(other.id, "issue", "example/repo#4", "user", other.revision);
    const moved = await tasks.roadmapSync("user");
    expect(moved.calls).toEqual([["api", "repos/example/repo/issues/4", "--hostname", "github.com", "--method", "PATCH", "-F", "milestone=8"]]);
    const privateTask = board.propose("user", { title: "PRIVATE_CANARY", class: "plan", signals: ["pii"] });
    board.linkMilestone(other.id, "task", String(privateTask.id), "user", board.milestone(other.id)!.revision);
    await expect(tasks.roadmapSync("user")).rejects.toThrow("withheld");
    expect(JSON.stringify(writes)).not.toContain("PRIVATE_CANARY");
  } finally { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); }
});
