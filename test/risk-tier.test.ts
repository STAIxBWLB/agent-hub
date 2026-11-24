import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { deriveRiskTier, riskPolicy, withoutRisk } from "../src/hub/risk-tier.ts";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
const POLICY = { high: ["src/hub/sdlc-merge.ts"], low: ["docs/**"] };
const evidence = (head: string, paths: string[], complete = true) => ({ head, paths, pathsComplete: complete, typesComplete: complete });
const cleanup: (() => void)[] = [];
process.on("exit", () => { for (const close of cleanup.splice(0).reverse()) close(); });

test("AC1: a change that touches only low paths is low, and one high path among many makes it high", () => {
  const low = deriveRiskTier(POLICY, [], evidence(HEAD, ["docs/a.md", "docs/design/b.md"]), HEAD);
  expect(low).toEqual({ tier: "low", head: HEAD, matched: 2 });
  const high = deriveRiskTier(POLICY, [], evidence(HEAD, ["docs/a.md", "src/hub/sdlc-merge.ts", "src/hub/tasks.ts", "docs/c.md"]), HEAD);
  expect(high).toEqual({ tier: "high", head: HEAD, matched: 1 });
});

test("AC1: a path no pattern names is medium, and its count is the unmatched paths only", () => {
  expect(deriveRiskTier(POLICY, [], evidence(HEAD, ["docs/a.md", "src/hub/tasks.ts", "src/hub/board.ts"]), HEAD)).toEqual({ tier: "medium", head: HEAD, matched: 2 });
  expect(deriveRiskTier(POLICY, [], evidence(HEAD, ["src/hub/tasks.ts"]), HEAD)).toEqual({ tier: "medium", head: HEAD, matched: 1 });
});

test("AC1: a [security] path is high even when [risk] names no high path at all", () => {
  expect(deriveRiskTier({ high: [], low: ["docs/**"] }, ["src/local/**"], evidence(HEAD, ["src/local/deny.ts", "docs/a.md"]), HEAD)).toEqual({ tier: "high", head: HEAD, matched: 1 });
});

test("AC2: a tier is a statement about one head, so evidence for another head derives nothing", () => {
  expect(deriveRiskTier(POLICY, [], evidence(OTHER, ["docs/a.md"]), HEAD)).toBeUndefined();
  expect(deriveRiskTier(POLICY, [], evidence(HEAD, ["docs/a.md"]), OTHER)).toBeUndefined();
});

test("AC4: no [risk] table derives nothing, and neither does an incomplete, unreadable or empty inventory", () => {
  expect(deriveRiskTier(undefined, [], evidence(HEAD, ["docs/a.md"]), HEAD)).toBeUndefined();
  expect(deriveRiskTier(POLICY, [], evidence(HEAD, ["docs/a.md"], false), HEAD)).toBeUndefined();
  expect(deriveRiskTier(POLICY, [], undefined, HEAD)).toBeUndefined();
  expect(deriveRiskTier(POLICY, [], evidence(HEAD, []), HEAD)).toBeUndefined();
});

test("the [risk] table accepts globs and refuses what the pattern language refuses", () => {
  expect(riskPolicy({ high: ["src/hub/sdlc-*.ts"], low: ["docs/**", "*.md"] })).toEqual({ high: ["src/hub/sdlc-*.ts"], low: ["docs/**", "*.md"] });
  expect(riskPolicy({ low: ["docs/**"] })).toEqual({ high: [], low: ["docs/**"] });
  expect(() => riskPolicy({ middle: ["src/**"] })).toThrow("sdlc.risk.middle: unknown field");
  expect(() => riskPolicy({})).toThrow("sdlc.risk: name at least one of high and low");
  expect(() => riskPolicy({ high: ["src/**"], low: ["src/**"] })).toThrow('sdlc.risk: "src/**" is named in both high and low');
  expect(() => riskPolicy({ high: ["src/"] })).toThrow("sdlc.risk.high: expected at most");
  expect(() => riskPolicy(["src/**"])).toThrow("sdlc.risk: expected a table");
});

test("sdlcConfig parses [risk] and a project without one keeps no risk field", () => {
  expect(sdlcConfig({ mode: "advise", risk: { high: ["src/hub/sdlc-merge.ts"] } }).risk).toEqual({ high: ["src/hub/sdlc-merge.ts"], low: [] });
  expect(sdlcConfig({ mode: "advise" })).not.toHaveProperty("risk");
  expect(() => sdlcConfig({ mode: "advise", risk: { high: ["src/**"], middling: [] } })).toThrow("sdlc.risk.middling: unknown field");
  expect(() => sdlcConfig({ mode: "advise", risky: {} })).toThrow("sdlc.risky: unknown field");
});

test("a re-filed receipt drops the tier the replaced filing carried", () => {
  expect(withoutRisk({ stage: "review", risk: { tier: "high", head: HEAD, matched: 1 }, pr: 7 })).toEqual({ stage: "review", pr: 7 });
  expect(withoutRisk(undefined)).toBeUndefined();
});

function rig(risk: object | undefined) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-risk-tier-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const notices: string[] = [], hooks: { head?: string; files?: string[]; changedFiles?: number } = {};
  const gh: SdlcGh = async args => {
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: hooks.head, state: "OPEN", statusCheckRollup: [], reviewDecision: "", reviewRequests: [], files: (hooks.files ?? []).map(path => ({ path, changeType: "MODIFIED" })), changedFiles: hooks.changedFiles ?? (hooks.files ?? []).length }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: hooks.head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  };
  const tasks = new Tasks({ cwd, board, bus, roles: { codex: ["implementer"], claude: ["reviewer"] }, project: "fixture", routing: () => loadRouting(cwd), notify: text => notices.push(text),
    sdlc: { config: () => sdlcConfig({ mode: "advise", required_checks: [], ...(risk ? { risk } : {}) }), gh } });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { tasks, board, hooks };
}

test("AC2: done records the tier of the filed head and a re-file recomputes it at the new head", async () => {
  const r = rig(POLICY);
  const task = r.board.propose("user", { title: "documented change", class: "implement" });
  r.board.update(task.id, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude", refs: { commit: HEAD },
    sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head: HEAD, localHead: HEAD, localResult: "passed" } });
  r.hooks.head = HEAD; r.hooks.files = ["docs/a.md", "docs/b.md"];
  const first = await r.tasks.done("codex", task.id, "docs only", { commit: HEAD });
  expect(first.sdlc?.risk).toEqual({ tier: "low", head: HEAD, matched: 2 });

  r.hooks.head = OTHER; r.hooks.files = ["docs/a.md", "src/hub/sdlc-merge.ts"];
  const second = await r.tasks.done("codex", task.id, "now the merge gate", { commit: OTHER });
  expect(second.sdlc?.risk).toEqual({ tier: "high", head: OTHER, matched: 1 });

  // A head whose inventory the hub cannot read completely records no tier: the receipt this re-file started from dropped the tier of the
  // head it replaced, so an unreadable filing is never classified as the one before it.
  const THIRD = "c".repeat(40);
  r.hooks.head = THIRD; r.hooks.files = ["docs/a.md"]; r.hooks.changedFiles = 2;
  const third = await r.tasks.done("codex", task.id, "the inventory no longer matches", { commit: THIRD });
  expect(third.sdlc).not.toHaveProperty("risk");
});

test("AC4: a project with no [risk] table files exactly as before", async () => {
  const r = rig(undefined);
  const task = r.board.propose("user", { title: "documented change", class: "implement" });
  r.board.update(task.id, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude", refs: { commit: HEAD },
    sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head: HEAD, localHead: HEAD, localResult: "passed" } });
  r.hooks.head = HEAD; r.hooks.files = ["src/hub/sdlc-merge.ts"];
  const filed = await r.tasks.done("codex", task.id, "no policy", { commit: HEAD });
  expect(filed.state).toBe("in_review");
  expect(filed.sdlc).not.toHaveProperty("risk");
});
