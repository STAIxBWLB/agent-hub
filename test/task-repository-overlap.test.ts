import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task, type TaskPlan, type TaskRefs } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
async function fixture() {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-repo-overlap-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const hub = join(dir, "hub"), sibling = join(dir, "sibling");
  const git = (cwd: string, ...args: string[]) => {
    const result = hubGitSync(["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(result.status).toBe(0);
  };
  for (const [root, repo] of [[hub, "example/hub"], [sibling, "example/sibling"]]) {
    mkdirSync(join(root!, "test"), { recursive: true }); writeFileSync(join(root!, "test", "x.test.ts"), "fixture\n");
    git(root!, "init", "--quiet"); git(root!, "remote", "add", "origin", `https://github.com/${repo}.git`);
  }
  const board = new Board(join(hub, "hub.db")); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["codex", "kimi", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const notices: string[] = [], records: Parameters<NonNullable<TasksDeps["recordOverlap"]>>[] = [];
  const tasks = new Tasks({ board, bus, cwd: hub, project: "hub", repository: "example/hub", routing: () => loadRouting(hub), wipLimit: () => 16,
    coordination: () => true, capable: () => true, notify: line => notices.push(line), recordOverlap: (...args) => records.push(structuredClone(args)) });
  const claim = (owner: string, refs: TaskRefs, plan: TaskPlan = {}) => tasks.propose(owner, { owner, title: "repository fixture", class: "implement", refs, plan });
  return { dir, hub, sibling, tasks, board, bus, notices, records, claim };
}

test("#476 sibling absolute refs and relative test plan never overlap the hub repository", async () => {
  const f = await fixture();
  await f.claim("codex", { paths: [join(f.sibling, "test", "x.test.ts")] }, { paths: ["test"], symbols: ["sharedSymbol"] });
  const mine = await f.claim("kimi", { paths: ["test/x.test.ts"] }, { symbols: ["sharedSymbol"] });
  expect(f.tasks.overlaps(mine)).toBe(""); expect(f.records).toEqual([]); expect(f.tasks.cohorts.list()).toEqual([]);
});

for (const explicit of ["slug", "path", "alias"] as const) test(`#476 same sibling repository overlaps through inferred and explicit ${explicit} identity`, async () => {
  const f = await fixture(), alias = join(f.dir, "sibling-alias"); symlinkSync(f.sibling, alias);
  await f.claim("codex", { paths: [join(f.sibling, "test", "x.test.ts")] }, { paths: ["test"] });
  const repo = explicit === "slug" ? "EXAMPLE/SIBLING" : explicit === "path" ? f.sibling : alias;
  const mine = await f.claim("kimi", { repo, paths: ["test/x.test.ts"] });
  expect(f.tasks.overlaps(mine)).toContain("#1 (owner codex)");
  expect(f.records.at(-1)?.[2][0]?.paths).toEqual(["test/x.test.ts"]);
});

for (const repo of ["example/hub", "."] as const) test(`#476 explicit hub ${repo} and default identity preserve ordinary overlap bytes`, async () => {
  const f = await fixture();
  await f.claim("codex", { paths: ["test"] });
  const mine = await f.claim("kimi", { repo, paths: ["test/x.test.ts"] });
  expect(f.tasks.overlaps(mine)).toBe("Overlaps #1 (owner codex) on test/x.test.ts. Settle it with that owner via hub_send before editing those paths.");
  expect(f.records.at(-1)).toEqual([2, "kimi", [{ task: 1, owner: "codex", paths: ["test/x.test.ts"] }]]);
});

for (const field of ["symbols", "sections", "sources"] as const) test(`#476 ${field} are compared only inside one repository`, async () => {
  const f = await fixture(), plan = { [field]: ["shared-reference"] };
  await f.claim("codex", { repo: "example/sibling" }, plan);
  const mine = await f.claim("kimi", {}, plan);
  expect(f.tasks.overlaps(mine)).toBe(""); expect(f.records).toEqual([]);
});

test("#476 outside non-Git refs infer their common parent without treating a relative plan as hub paths", async () => {
  const f = await fixture(), outside = join(f.dir, "plain-project"); mkdirSync(join(outside, "test"), { recursive: true });
  writeFileSync(join(outside, "test", "x.test.ts"), "fixture\n");
  await f.claim("codex", { paths: [join(outside, "test", "x.test.ts")] }, { paths: ["test"] });
  const mine = await f.claim("kimi", { paths: ["test/x.test.ts"] });
  expect(f.tasks.overlaps(mine)).toBe("");
});

test("#476 conflicting refs and absolute plan repository evidence produces one body-free propose notice", async () => {
  const f = await fixture();
  await f.claim("codex", { paths: [join(f.sibling, "test", "x.test.ts")] }, { paths: [join(f.hub, "test", "x.test.ts")] });
  const mismatches = f.notices.filter(line => line.includes("refs and plan name different repositories"));
  expect(mismatches).toHaveLength(1);
  expect(mismatches[0]).not.toContain(f.sibling); expect(mismatches[0]).not.toContain(f.hub);
});

test("#476 propose and accept tools expose refs.repo and explain its use", () => {
  for (const name of ["hub_task_propose", "hub_task_accept"]) {
    const tool = TASK_TOOLS.find(item => item.name === name)!;
    expect(tool.description).toContain("refs.repo");
    expect(tool.inputSchema.properties.refs).toMatchObject({ properties: { repo: { type: "string" } } });
  }
});

test("#476 accepting repository metadata updates only through Tasks and scopes the accepted plan correctly", async () => {
  const f = await fixture();
  await f.claim("codex", { paths: [join(f.sibling, "test", "x.test.ts")] }, { paths: ["test"] });
  const assigned = await f.tasks.propose("user", { title: "accept fixture", class: "implement", owner: "kimi" });
  const accept = f.tasks.accept.bind(f.tasks) as (by: string, id: number, plan?: unknown, refs?: unknown) => Task;
  const mine = accept("kimi", assigned.id, { paths: ["test/x.test.ts"] }, { repo: "example/sibling" });
  expect(mine.refs.repo).toBe("example/sibling"); expect(f.tasks.overlaps(mine)).toContain("#1 (owner codex)");
});
