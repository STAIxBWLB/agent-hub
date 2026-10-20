import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task, type TaskPlan, type TaskRefs } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { resolveProfile } from "../src/hub/profiles.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
async function fixture(allPlanKeys = false) {
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
  const routing = loadRouting(hub);
  const profileData = allPlanKeys ? resolveProfile("dev", { plan_keys: ["paths", "symbols", "sections", "sources", "signatures", "insertion_points"] }) : undefined;
  const tasks = new Tasks({ ...(profileData ? { profileData } : {}), board, bus, cwd: hub, project: "hub", repository: "example/hub", routing: () => routing, wipLimit: () => 16,
    coordination: () => true, capable: () => true, notify: line => notices.push(line), recordOverlap: (...args) => records.push(structuredClone(args)) });
  const claim = (owner: string, refs: TaskRefs, plan: TaskPlan = {}) => tasks.propose(owner, { owner, title: "repository fixture", class: "implement", refs, plan });
  return { dir, hub, sibling, tasks, board, bus, notices, records, claim, routing };
}

test("#476 sibling absolute refs and relative test plan never overlap the hub repository", async () => {
  const f = await fixture();
  await f.claim("codex", { paths: [join(f.sibling, "test", "x.test.ts")] }, { paths: ["test"], symbols: ["sharedSymbol"] });
  const mine = await f.claim("kimi", { paths: ["test/x.test.ts"] }, { symbols: ["sharedSymbol"] });
  expect(f.tasks.overlaps(mine)).toBe(""); expect(f.records).toEqual([]); expect(f.tasks.cohorts.list()).toEqual([]);
});

for (const inferredFirst of [false, true]) test(`#476 explicit slug with an absolute plan shares its inferred checkout (inferred first: ${inferredFirst})`, async () => {
  const f = await fixture();
  const inferred = () => f.claim("codex", { paths: [join(f.sibling, "test", "x.test.ts")] });
  const named = () => f.claim("kimi", { repo: "example/sibling" }, { paths: [join(f.sibling, "test", "x.test.ts")] });
  if (inferredFirst) { await inferred(); const mine = await named(); expect(f.tasks.overlaps(mine)).toContain("#1 (owner codex)"); }
  else { await named(); const mine = await inferred(); expect(f.tasks.overlaps(mine)).toContain("#1 (owner kimi)"); }
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
  const f = await fixture(field !== "symbols"), plan: TaskPlan = { [field]: ["shared-reference"] };
  const first = await f.claim("codex", { repo: "example/sibling" }, plan);
  expect(first.plan?.[field]).toEqual(["shared-reference"]);
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

test("#476 correcting a task repository removes its obsolete cohort membership", async () => {
  const f = await fixture();
  const incumbent = await f.claim("codex", { paths: ["test"] });
  const moved = await f.claim("kimi", { paths: ["test/x.test.ts"] });
  expect(f.tasks.cohorts.of(moved.id)?.members.has(incumbent.id)).toBe(true);
  const accept = f.tasks.accept.bind(f.tasks) as (by: string, id: number, plan?: unknown, refs?: unknown) => Task;
  const next = accept("kimi", moved.id, undefined, { repo: "example/sibling" });
  expect(f.tasks.overlaps(next)).toBe("");
  expect(f.tasks.cohorts.of(next.id)).toBeUndefined();
});


test("#476 accept repository metadata cannot alter file intent or persist sensitive names", async () => {
  const f = await fixture();
  const task = await f.tasks.propose("user", { title: "accept guard fixture", class: "implement", owner: "kimi" });
  const accept = f.tasks.accept.bind(f.tasks) as (by: string, id: number, plan?: unknown, refs?: unknown) => Task;
  const before = f.board.get(task.id)!;
  expect(() => accept("kimi", task.id, undefined, { paths: ["other.ts"] })).toThrow("only repo");
  f.routing.signals.pii_patterns.push("SYNTH-PRIVATE-REPO");
  expect(() => accept("kimi", task.id, undefined, { repo: "SYNTH-PRIVATE-REPO" })).toThrow("private or sensitive");
  const synthetic = ["sk", "A".repeat(32)].join("-");
  expect(() => accept("kimi", task.id, undefined, { repo: synthetic })).toThrow("private or sensitive");
  expect(f.board.get(task.id)).toEqual(before);
});


test("#476 unchanged repository metadata never repeats Git probes on overlap reads", async () => {
  const f = await fixture();
  const repositories = f.tasks["repositories"] as unknown as { git(dir: string, args: string[]): string | undefined };
  const read = spyOn(repositories, "git");
  try {
    await f.claim("codex", { paths: ["test"] });
    expect(read.mock.calls).toHaveLength(0);
    const external = await f.claim("kimi", { paths: [join(f.sibling, "test", "x.test.ts")] }, { paths: ["test"] });
    const probes = read.mock.calls.length;
    expect(probes).toBeGreaterThan(0);
    for (let count = 0; count < 20; count++) f.tasks.overlaps(external);
    expect(read.mock.calls).toHaveLength(probes);
  } finally { read.mockRestore(); }
});

test("#476 the authenticated accept tool carries repository metadata through the host", async () => {
  const f = await fixture();
  const assigned = await f.tasks.propose("user", { title: "host accept fixture", class: "implement", owner: "kimi" });
  const { DEFAULT_CONFIG, startDaemon } = await import("../src/hub/daemon.ts");
  const { ControlClient } = await import("../src/hub/control-client.ts");
  const daemon = await startDaemon({ cwd: f.hub, stateDir: f.hub, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  const owner = await ControlClient.connect(f.hub, { role: "tools", peer: "kimi" });
  try {
    const reply = await owner.request({ t: "task", op: "hub_task_accept", args: { id: assigned.id, refs: { repo: "example/sibling" }, plan: { paths: ["test"] } } });
    expect(reply.ok).toBe(true);
    expect(f.board.get(assigned.id)?.refs.repo).toBe("example/sibling");
  } finally { owner.close(); await daemon.stop(); }
});
