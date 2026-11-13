import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcMode } from "../src/hub/sdlc.ts";
import { parseSecurityPass, securityPassBlockers, securityPassView, securityPolicy, securityRequestLine, storedSecurityPass } from "../src/hub/security-pass.ts";
import { profileTaskTools } from "../src/hub/hub-tools.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

class Peer extends BasePeer {
  readonly got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}

const A = "a".repeat(40), B = "b".repeat(40), cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const sensitive = [{ path: "src/local/runner.ts", changeType: "MODIFIED" }, { path: "docs/readme.md", changeType: "MODIFIED" }];
const plain = [{ path: "docs/readme.md", changeType: "MODIFIED" }];
const toml = { paths: ["src/local/**", ".github/workflows/**", "scripts/release-*"], companions: ["agents", "local-ipc"] };
const pass = { covered: ["local runner"], not_covered: ["release scripts"] };
function rig(mode: SdlcMode, files: { path: string; changeType: string }[] = sensitive, security: unknown | null = toml) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-security-pass-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const claude = new Peer("claude"); bus.add(claude); void claude.start();
  const notices: string[] = [], state = { head: A, files, complete: true };
  const routing = loadRouting(cwd);
  const deps: TasksDeps = { cwd, project: "fixture", repository: "o/r", board, bus, routing: () => routing,
    notify: text => notices.push(text), share: () => {},
    sdlc: { config: () => sdlcConfig({ mode, required_checks: ["gate"], ...(security === null ? {} : { security }) }),
      gh: async args => ({ code: 0, stdout: JSON.stringify(args[0] === "pr"
        ? { headRefOid: state.head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], files: state.files, changedFiles: state.complete ? state.files.length : state.files.length + 1, unresolvedThreads: 0 }
        : { data: { repository: { pullRequest: { headRefOid: state.head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }, issue: { number: 1, labels: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) }) } };
  const tasks = new Tasks(deps);
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const create = () => {
    const row = board.propose("user", { title: "review fixture", class: "implement", plan: { paths: state.files.map(file => file.path) } });
    board.update(row.id, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    return board.update(row.id, "codex", "done", { state: "in_review", refs: { commit: state.head }, sdlc: { stage: "review", repo: "o/r", issue: 1, pr: 100 + row.id, localHead: state.head, localResult: "passed" } });
  };
  return { board, tasks, state, notices, create, claude };
}
const review = (tasks: Tasks, id: number, verdict: string, securityPass?: unknown, head: string | undefined = A, by = "claude"): Promise<Task> =>
  Reflect.apply(tasks.review, tasks, [by, id, verdict, undefined, undefined, head, undefined, undefined, securityPass]);

test("config: [security] validates paths in the config_paths language and a closed companion list", () => {
  expect(securityPolicy(toml)).toEqual({ paths: toml.paths, companions: ["agents", "local-ipc"] });
  expect(securityPolicy({ paths: ["a/**"] }).companions).toEqual([]);
  expect(() => securityPolicy({})).toThrow(/paths: required/);
  expect(() => securityPolicy({ paths: ["src/local/"] })).toThrow(/sdlc\.security\.paths/);
  expect(() => securityPolicy({ paths: ["a/**"], companions: ["nope"] })).toThrow(/companions/);
  expect(() => securityPolicy({ paths: ["a/**"], companions: ["agents", "agents"] })).toThrow(/companions/);
  expect(() => securityPolicy({ paths: ["a/**"], extra: 1 })).toThrow(/unknown field/);
  expect(() => securityPolicy([])).toThrow(/expected a table/);
  expect(sdlcConfig({ mode: "advise" }).security).toBeUndefined();
});

test("record: a pass names at least one unit, rejects overlaps, odd shapes and control characters", () => {
  expect(parseSecurityPass(pass)).toEqual({ covered: ["local runner"], notCovered: ["release scripts"] });
  expect(parseSecurityPass({ not_covered: ["x"] })).toEqual({ covered: [], notCovered: ["x"] });
  for (const bad of [{}, { covered: [] }, { covered: "x" }, { covered: ["a", "a"] }, { covered: ["a"], not_covered: ["a"] }, { covered: [""] }, { covered: ["a\u0000b"] },
    { covered: ["x".repeat(121)] }, { covered: Array.from({ length: 33 }, (_, i) => `u${i}`) }, { extra: 1, covered: ["a"] }, [], null, "x", { covered: [1] }]) {
    expect(() => parseSecurityPass(bad)).toThrow(/security_pass/);
  }
  expect(() => parseSecurityPass(new Proxy({ covered: ["a"] }, {}))).toThrow(/security_pass/);
  expect(() => parseSecurityPass({ get covered() { return ["a"]; } })).toThrow(/plain data/);
  expect(storedSecurityPass({ head: A, covered: ["a"], notCovered: [] })).toEqual({ head: A, covered: ["a"], notCovered: [] });
  expect(() => storedSecurityPass({ head: "zz", covered: ["a"], notCovered: [] })).toThrow(/invalid stored/);
  expect(() => storedSecurityPass({ covered: ["a"], notCovered: [], junk: 1 })).toThrow(/invalid stored/);
});

const evidence = (paths: string[], extra: Record<string, unknown> = {}) => ({ head: A, state: "OPEN", checks: [], paths, pathsComplete: true, typesComplete: true, ...extra }) as never;
test("view: required, recorded at this head only, not_required, and unknown whenever the inventory is incomplete", () => {
  const policy = securityPolicy(toml), record = { head: A, covered: ["u"], notCovered: [] };
  expect(securityPassView(undefined, evidence(["src/local/a.ts"]), undefined)).toBeUndefined();
  expect(securityPassView(policy, evidence(["src/local/a.ts", "x"]), undefined)).toMatchObject({ state: "required", matched: 1 });
  expect(securityPassView(policy, evidence(["scripts/release-tag.ts"]), undefined)?.state).toBe("required");
  expect(securityPassView(policy, evidence([".github/workflows/ci.yml"]), undefined)?.state).toBe("required");
  expect(securityPassView(policy, evidence(["src/local/a.ts"]), record)).toMatchObject({ state: "recorded", recorded: { covered: 1, notCovered: 0 } });
  expect(securityPassView(policy, evidence(["src/local/a.ts"]), { ...record, head: B })?.state).toBe("required");
  expect(securityPassView(policy, evidence(["src/local/a.ts"]), { covered: ["u"], notCovered: [] })?.state).toBe("required");
  expect(securityPassView(policy, evidence(["src/localx/a.ts", "docs/a.md"]), undefined)).toMatchObject({ state: "not_required", matched: 0 });
  expect(securityPassView(policy, evidence(["docs/a.md"], { pathsComplete: false }), undefined)?.state).toBe("unknown");
  expect(securityPassView(policy, evidence(["docs/a.md"], { typesComplete: false }), record)?.state).toBe("unknown");
  expect(securityPassView(policy, undefined, record)?.state).toBe("unknown");
  expect(JSON.stringify(securityPassView(policy, evidence(["src/local/secret-name.ts"]), undefined))).not.toContain("secret-name");
});

test("text: blockers and the request line name the checklist and the companions, and say nothing when not required", () => {
  const policy = securityPolicy(toml);
  const required = securityPassView(policy, evidence(["src/local/a.ts"]), undefined);
  expect(securityPassBlockers(required)[0]).toMatch(/security pass required.*1 security-sensitive path;/);
  expect(securityRequestLine(required)).toMatch(/REQUIRED.*docs\/agent-notes\/security-review\.md.*agents, local-ipc/);
  expect(securityPassBlockers(securityPassView(policy, evidence(["docs/a.md"], { pathsComplete: false }), undefined))[0]).toMatch(/applicability unknown/);
  const none = securityPassView(policy, evidence(["docs/a.md"]), undefined);
  expect(securityPassBlockers(none)).toEqual([]);
  expect(securityRequestLine(none)).toBeUndefined();
  expect(securityRequestLine(undefined)).toBeUndefined();
  expect(securityRequestLine(securityPassView(securityPolicy({ paths: ["a/**"] }), evidence(["a/b"]), undefined))).toMatch(/no companion configured/);
});

test("off: security_pass is refused with no board effect and the tool schema advertises none of it", async () => {
  const r = rig("off"), task = r.create(), before = JSON.stringify(r.board.get(task.id));
  await expect(review(r.tasks, task.id, "approved", pass)).rejects.toThrow(/lifecycle is off/);
  expect(JSON.stringify(r.board.get(task.id))).toBe(before);
  const props = (enabled: boolean) => profileTaskTools("dev", undefined, enabled).find(tool => tool.name === "hub_review")!.inputSchema.properties as Record<string, unknown>;
  expect(props(false)).not.toHaveProperty("security_pass");
  expect(props(true)).toHaveProperty("security_pass");
  // a custom stage list or profile with the lifecycle off still advertises nothing, on any tool
  for (const tools of [profileTaskTools("dev", ["intent", "build", "review"], false), profileTaskTools("research", undefined, false)]) expect(JSON.stringify(tools)).not.toContain("security_pass");
  expect(JSON.stringify(profileTaskTools("research", undefined, true).filter(tool => tool.name !== "hub_review"))).not.toContain("security_pass");
});

test("advise: an approval without a pass is recorded with a notice naming the pass; enforce refuses it with no board effect", async () => {
  const advise = rig("advise"), a = advise.create();
  const approved = await review(advise.tasks, a.id, "approved");
  expect(approved.history.at(-1)?.event).toBe("approved");
  expect(JSON.stringify(approved.history.at(-1)) + advise.notices.join("\n")).toMatch(/security pass required/);
  const enforce = rig("enforce"), e = enforce.create(), before = JSON.stringify(enforce.board.get(e.id));
  await expect(review(enforce.tasks, e.id, "approved")).rejects.toThrow(/security pass required/);
  expect(JSON.stringify(enforce.board.get(e.id))).toBe(before);
});

test("enforce: a pass recorded on the approving verdict satisfies the gate and is stored bound to the reviewed head", async () => {
  const r = rig("enforce"), task = r.create();
  const approved = await review(r.tasks, task.id, "approved", pass);
  expect(approved.history.at(-1)).toMatchObject({ event: "approved", securityPass: { head: A, covered: ["local runner"], notCovered: ["release scripts"] } });
});

test("enforce: an empty or malformed pass is refused before any board effect", async () => {
  const r = rig("enforce"), task = r.create(), before = JSON.stringify(r.board.get(task.id));
  for (const bad of [{}, { covered: [] }, "yes", { covered: ["a"], not_covered: ["a"] }]) await expect(review(r.tasks, task.id, "approved", bad)).rejects.toThrow(/security_pass/);
  expect(JSON.stringify(r.board.get(task.id))).toBe(before);
});

test("enforce: a pass recorded for an earlier head does not carry to a new head", async () => {
  const r = rig("enforce"), task = r.create();
  await review(r.tasks, task.id, "changes_requested", pass);
  r.board.update(task.id, "codex", "accepted", { state: "in_progress" });
  r.state.head = B;
  r.board.update(task.id, "codex", "done", { state: "in_review", refs: { commit: B }, sdlc: { ...r.board.get(task.id)!.sdlc!, localHead: B } });
  await expect(review(r.tasks, task.id, "approved", undefined, B)).rejects.toThrow(/security pass required/);
  expect((await review(r.tasks, task.id, "approved", pass, B)).history.at(-1)?.securityPass?.head).toBe(B);
});

test("enforce: a PR with no sensitive path needs no pass, and an incomplete inventory blocks as unknown", async () => {
  const quiet = rig("enforce", plain), q = quiet.create();
  expect((await review(quiet.tasks, q.id, "approved")).history.at(-1)?.event).toBe("approved");
  const partial = rig("enforce", plain), p = partial.create();
  partial.state.complete = false;
  await expect(review(partial.tasks, p.id, "approved")).rejects.toThrow(/applicability unknown/);
});

test("no [security] table: nothing changes, and a pass is still accepted but never required", async () => {
  const r = rig("enforce", sensitive, null), task = r.create();
  expect((await review(r.tasks, task.id, "approved")).history.at(-1)?.event).toBe("approved");
});

test("request: the review request tells the reviewer the pass is required, where the checklist is and which companions apply", async () => {
  const r = rig("advise"), task = r.create();
  (r.tasks as unknown as { sendReview(task: unknown, reviewer: string): void }).sendReview(r.board.get(task.id)!, "claude");
  await Bun.sleep(5);
  const body = r.claude.got.filter(e => e.kind === "review" && e.refs?.task === String(task.id)).at(-1)?.body ?? "";
  expect(body).not.toBe("");
  expect(body).toMatch(/Security pass: applicability unknown.*security-review\.md.*agents, local-ipc/);
  const quiet = rig("advise", plain, null), q = quiet.create();
  (quiet.tasks as unknown as { sendReview(task: unknown, reviewer: string): void }).sendReview(quiet.board.get(q.id)!, "claude");
  await Bun.sleep(5);
  expect(quiet.claude.got.filter(e => e.kind === "review").at(-1)?.body ?? "").not.toContain("Security pass");
});

import { readMergeQueue, type DeliveryTask } from "../src/hub/sdlc-queue.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";
// The queue reads the same complete inventory; a stub gh answers the list, the per-PR read and the final gates query like test/sdlc-queue.test.ts.
function queueGh(paths: string[], incomplete = false): SdlcGh {
  const M = "c".repeat(40), gates = { headRefOid: A, state: "OPEN", isDraft: false, baseRefName: "main", baseRefOid: M, changedFiles: paths.length + (incomplete ? 1 : 0), reviewDecision: "APPROVED",
    reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    statusCheckRollup: { contexts: { nodes: [{ name: "gate", conclusion: "SUCCESS" }], pageInfo: { hasNextPage: false } } } };
  return async args => {
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify([{ number: 1, headRefOid: A, baseRefName: "main", baseRefOid: M }]) };
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: A, isDraft: false, baseRefName: "main", baseRefOid: M, state: "OPEN", changedFiles: paths.length + (incomplete ? 1 : 0), statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], reviewDecision: "APPROVED", reviewRequests: [], unresolvedThreads: 0, files: paths.map(path => ({ path, changeType: "MODIFIED" })) }) };
    const query = args.find(arg => arg.startsWith("query=") && arg.includes("queue_p"));
    if (query) return { code: 0, stdout: JSON.stringify({ data: { repository: { queue_p1: gates, queue_i1: { number: 1, labels: { nodes: [], pageInfo: { hasNextPage: false } } }, pullRequests: { nodes: [{ number: 1, headRefOid: A, baseRefName: "main", baseRefOid: M }], pageInfo: { hasNextPage: false } } } } }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: A, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }, issue: { number: 1, labels: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  };
}
const queueTask = (securityPass?: { head?: string; covered: string[]; notCovered: string[] }): DeliveryTask => ({ id: 1, after: [], private: false, approval: { head: A, latestHead: A, mismatch: false, current: true }, latestHead: A, ...(securityPass ? { securityPass } : {}),
  receipt: { repo: "o/r", issue: 1, pr: 1, stage: "review", reviewedHead: A, localHead: A, localResult: "passed", head: A } as never });

test("queue: enforce blocks a PR with a sensitive path and no pass at its head; a pass at the head, a quiet PR and an unknown inventory read as expected", async () => {
  const config = sdlcConfig({ mode: "enforce", required_checks: ["gate"], security: toml }), secured = sdlcConfig({ mode: "advise", required_checks: ["gate"], security: toml });
  const missing = await readMergeQueue("o/r", config, [queueTask()], queueGh(["src/local/a.ts"]));
  expect(missing.rows[0]?.securityPass).toMatchObject({ state: "required", matched: 1 });
  expect(missing.rows[0]?.ready).toBe(false);
  expect(missing.rows[0]?.blockers.join("\n")).toMatch(/security pass required/);
  expect(JSON.stringify(missing)).not.toContain("src/local/a.ts");
  const stale = await readMergeQueue("o/r", config, [queueTask({ head: B, covered: ["x"], notCovered: [] })], queueGh(["src/local/a.ts"]));
  expect(stale.rows[0]?.securityPass?.state).toBe("required");
  const given = await readMergeQueue("o/r", config, [queueTask({ head: A, covered: ["x"], notCovered: [] })], queueGh(["src/local/a.ts"]));
  expect(given.rows[0]?.securityPass).toMatchObject({ state: "recorded", recorded: { covered: 1, notCovered: 0 } });
  expect(given.rows[0]?.blockers.join("\n")).not.toMatch(/security pass/);
  expect(given.rows[0]?.ready).toBe(true);
  const quiet = await readMergeQueue("o/r", config, [queueTask()], queueGh(["docs/a.md"]));
  expect(quiet.rows[0]?.securityPass?.state).toBe("not_required");
  expect(quiet.rows[0]?.ready).toBe(true);
  const unknown = await readMergeQueue("o/r", config, [queueTask()], queueGh(["docs/a.md"], true));
  expect(unknown.rows[0]?.securityPass?.state).toBe("unknown");
  expect(unknown.rows[0]?.ready).toBe(false);
  const advise = await readMergeQueue("o/r", secured, [queueTask()], queueGh(["src/local/a.ts"]));
  expect(advise.rows[0]?.securityPass?.state).toBe("required");
  expect(advise.rows[0]?.blockers.join("\n")).not.toMatch(/security pass required/);
  const unconfigured = await readMergeQueue("o/r", sdlcConfig({ mode: "enforce", required_checks: ["gate"] }), [queueTask()], queueGh(["src/local/a.ts"]));
  expect(unconfigured.rows[0]).not.toHaveProperty("securityPass");
  expect(unconfigured.rows[0]?.ready).toBe(true);
});
