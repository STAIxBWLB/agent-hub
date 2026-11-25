import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surveyInputProblem } from "../src/hub/advisor-survey.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { TASK_TOOL_NAMES, profileTaskTools } from "../src/hub/hub-tools.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { missingReadbackRefs, parseSpecReadbackReport, readbackLine, readbackSummary } from "../src/hub/spec-readback.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";

const report = { task: 42, proposes: "Publish the summary.", existing: "A reviewer reads the spec." };

test("accepts a bounded paraphrase or an explicit section the reader could not paraphrase", () => {
  const input = { ...report, proposes: "é".repeat(512), refs: ["src/hub/tasks.ts"] };
  expect(parseSpecReadbackReport(input)).toEqual(input);
  expect(parseSpecReadbackReport({ task: 42, cannot_paraphrase: "Storage" })).toEqual({ task: 42, cannot_paraphrase: "Storage" });
});

test("reports the field and limit without truncating excessive input", () => {
  const excessive = [
    [{ ...report, proposes: "é".repeat(513) }, "proposes", "1024"],
    [{ ...report, undefined: Array(17).fill({ term: "receipt", where: "Storage" }) }, "undefined", "16"],
    [{ ...report, open_decisions: Array(17).fill({ decision: "Who writes?", where: "Design" }) }, "open_decisions", "16"],
    [{ ...report, refs: Array(65).fill("src/hub/tasks.ts") }, "refs", "64"],
  ] as const;
  for (const [input, field, limit] of excessive) {
    expect(() => parseSpecReadbackReport(input)).toThrow();
    try {
      parseSpecReadbackReport(input);
    } catch (error) {
      const problem = surveyInputProblem(error);
      expect(problem?.field).toBe(field);
      expect(problem?.rule).toContain(limit);
    }
  }
});

test("rejects verdicts, mixed report forms and paths outside the repository", () => {
  expect(() => parseSpecReadbackReport({ ...report, verdict: "approved" })).toThrow();
  expect(() => parseSpecReadbackReport({ ...report, cannot_paraphrase: "Storage" })).toThrow();
  expect(() => parseSpecReadbackReport({ ...report, refs: ["../elsewhere"] })).toThrow();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-readback-")), board = new Board(join(root, "hub.db"));
  const close = () => { board.close(); rmSync(root, { recursive: true, force: true }); };
  const proposed = board.propose("user", { title: "Spec read-back", class: "implement" });
  const task = board.update(proposed.id, "user", "accepted", { owner: "claude", state: "in_progress" });
  const request = { task: task.id, taskCreated: task.created, repo: "STAIxBWLB/agent-hub", issue: 1658, lastEditedAt: "2026-11-23T00:36:36Z",
    updatedAt: "2026-11-23T00:36:36Z", reader: "kimi", by: "user", at: 5 };
  return { board, close, task, request };
}

test("keeps one request per task, issue and body edit time and reports the newest one", () => {
  const f = fixture();
  try {
    const id = f.board.readbackCreate(f.request);
    expect(f.board.readbackCreate(f.request)).toBe(id);
    expect(f.board.readbackOfTask(f.task.id, f.task.created, 1658, f.request.lastEditedAt)?.id).toBe(id);
    const edited = f.board.readbackCreate({ ...f.request, lastEditedAt: "2026-11-24T09:00:00Z", updatedAt: "2026-11-24T09:00:00Z" });
    expect(edited).not.toBe(id);
    expect(f.board.readbackLatest(f.task.id, f.task.created)?.id).toBe(edited);
    expect(f.board.readbackOfTask(f.task.id, f.task.created, 1658, f.request.lastEditedAt)?.id).toBe(id);
  } finally { f.close(); }
});

test("stores the report once and refuses a changed report or a path outside the repository", () => {
  const f = fixture();
  try {
    const id = f.board.readbackCreate(f.request), sent = { ...report, task: f.task.id };
    expect(f.board.readbackReport(id, sent, ["src/hub/tasks.ts"]).report).toEqual(sent);
    expect(f.board.readback(id)?.report).toEqual(sent);
    expect(f.board.readback(id)?.missingRefs).toEqual(["src/hub/tasks.ts"]);
    expect(f.board.readbackReport(id, sent, ["src/hub/tasks.ts"]).report).toEqual(sent);
    expect(() => f.board.readbackReport(id, { ...sent, proposes: "Something else." }, [])).toThrow();
    expect(() => f.board.readbackReport(id, sent, ["../elsewhere"])).toThrow();
    expect(f.board.readback(id)?.report).toEqual(sent);
  } finally { f.close(); }
});

test("names every read-back state in one line, so accept and status read the same way", () => {
  expect(readbackLine(undefined, 7)).toContain("none");
  expect(readbackLine({ state: "unavailable" }, 7)).toContain("unavailable");
  expect(readbackLine({ state: "stale" }, 7)).toContain("ahub sdlc readback start 7");
  expect(readbackSummary({ state: "current" })).toContain("requested");
  const current = { state: "current" as const, undefined: [{ term: "receipt", where: "Storage" }], open_decisions: [{ decision: "Who writes?", where: "Design" }], missing_refs: ["src/gone.ts"] };
  expect(readbackSummary(current)).toContain("1 undefined term");
  expect(readbackSummary(current)).toContain("1 open decision");
  expect(readbackSummary(current)).toContain("1 missing ref");
  expect(readbackSummary({ state: "current", missing_refs: [] })).toContain("0 missing refs");
});

test("counts a path the issue names that is absent from the default branch head", () => {
  const paths = ["src/hub/tasks.ts", "src/hub/no-such-readback-file.ts"];
  expect(missingReadbackRefs(process.cwd(), paths)).toEqual(["src/hub/no-such-readback-file.ts"]);
  expect(missingReadbackRefs(process.cwd(), ["src/hub/tasks.ts"])).toEqual([]);
  expect(missingReadbackRefs(process.cwd(), [])).toEqual([]);
});

test("publishes the report tool with the lifecycle's auxiliary tools, so an off project's tool list is unchanged", () => {
  const name = "hub_readback_report";
  expect(TASK_TOOL_NAMES.has(name)).toBe(true);
  const names = (tools: readonly { name: string }[]) => tools.map(tool => tool.name);
  expect(names(profileTaskTools("dev"))).not.toContain(name);
  expect(names(profileTaskTools("dev", undefined, false, false, true))).toContain(name);
});

const EDIT = { lastEditedAt: "2026-11-23T00:36:36Z", updatedAt: "2026-11-23T00:36:36Z" };
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() { this.setState("offline"); } async deliver() {} }

/**
 * #1658 T3/T4: a lifecycle task whose receipt names an issue, with a stubbed issue read. `cwd` is the git checkout the
 * ref check reads, kept apart from the board's temporary directory.
 */
async function readbackFixture(options: { proposer?: string; mode?: "advise" | "off"; edit?: { lastEditedAt: string | null; updatedAt: string } | null; reviewers?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-readback-tasks-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  const close = () => { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); };
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const config = sdlcConfig({ mode: options.mode ?? "advise", required_checks: [] });
  const edit = options.edit === undefined ? EDIT : options.edit;
  const reviewers = options.reviewers ?? ["codex"];
  const roles = Object.fromEntries(["claude", "codex", "kimi"].map(id => [id, [...(reviewers.includes(id) ? ["reviewer"] : ["implementer"]), ...(id === "kimi" ? ["planner"] : [])]]));
  const notices: string[] = [];
  const deps: TasksDeps = { cwd: process.cwd(), project: "readback-fixture", repository: "fixture/readback", board, bus, roles,
    notify: text => { notices.push(text); }, routing: () => loadRouting(root), piiScreen: async () => ({ label: "clear", ms: 0 }),
    sdlc: { config: () => config, gh: async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 1658, lastEditedAt: edit?.lastEditedAt ?? null, updatedAt: edit?.updatedAt ?? "2026-11-23T00:36:36Z" } } } }) }) } };
  const tasks = new Tasks(deps);
  const proposed = board.propose(options.proposer ?? "user", { title: "Spec read-back fixture", class: "implement" });
  const task = board.update(proposed.id, "user", "accepted", { owner: "claude", state: "in_progress", sdlc: { stage: "spec", repo: "fixture/readback", issue: 1658 } });
  return { tasks, board, bus, notices, task, close };
}

test("a start files one request to a reviewer-role peer that is not the proposer, and a repeat returns that request", async () => {
  const f = await readbackFixture();
  try {
    const started = await f.tasks.specReadbackStart("user", f.task.id);
    expect(started.state).toBe("requested");
    expect(started.reader).toBe("codex");
    const row = f.board.readback(started.readback!)!;
    expect(row).toMatchObject({ task: f.task.id, repo: "fixture/readback", issue: 1658, lastEditedAt: EDIT.lastEditedAt, reader: started.reader });
    expect(f.board.readbackLatest(f.task.id, f.task.created)?.id).toBe(started.readback);
    expect((await f.tasks.specReadbackStart("user", f.task.id)).readback).toBe(started.readback);
    expect(f.board.readbackLatest(f.task.id, f.task.created)?.report).toBeUndefined();
  } finally { f.close(); }
  const proposed = await readbackFixture({ proposer: "codex", reviewers: ["codex", "kimi"] });
  try { expect((await proposed.tasks.specReadbackStart("user", proposed.task.id)).reader).toBe("kimi"); }
  finally { proposed.close(); }
});

test("a start refuses a task with no issue or an off lifecycle with a named continuation", async () => {
  const f = await readbackFixture();
  try {
    const bare = f.board.propose("user", { title: "No spec yet", class: "implement" });
    f.board.update(bare.id, "user", "accepted", { owner: "claude", state: "in_progress" });
    await expect(f.tasks.specReadbackStart("user", bare.id)).rejects.toThrow(/names no spec issue.*ahub sdlc readback start/);
  } finally { f.close(); }
  const off = await readbackFixture({ mode: "off" });
  try { await expect(off.tasks.specReadbackStart("user", off.task.id)).rejects.toThrow(/lifecycle on/); }
  finally { off.close(); }
});

test("no eligible reader answers unavailable and writes nothing; the proposer is never chosen", async () => {
  const f = await readbackFixture({ proposer: "codex" });
  try {
    const before = f.board.readbackLatest(f.task.id, f.task.created);
    const result = await f.tasks.specReadbackStart("user", f.task.id);
    expect(result.state).toBe("unavailable");
    expect(result.reason).toMatch(/roster a reviewer-role peer/);
    expect(f.board.readbackLatest(f.task.id, f.task.created)).toEqual(before);
  } finally { f.close(); }
});

test("only the bound reader reports, once; the ref check counts missing paths and the grant closes after it", async () => {
  const f = await readbackFixture();
  try {
    const started = await f.tasks.specReadbackStart("user", f.task.id), reader = started.reader!;
    expect(f.tasks.specReadbackReader(f.task.id, f.task.created, reader)).toBe(true);
    await expect(f.tasks.specReadbackReport("claude", { ...report, task: f.task.id })).rejects.toThrow(/no spec read-back request/);
    const written = await f.tasks.specReadbackReport(reader, { ...report, task: f.task.id, refs: ["src/hub/tasks.ts", "src/hub/no-such-readback-file.ts"] });
    expect(written).toMatchObject({ task: f.task.id, readback: started.readback, missing_refs: ["src/hub/no-such-readback-file.ts"] });
    expect(f.tasks.specReadbackReader(f.task.id, f.task.created, reader)).toBe(false);
    expect(await f.tasks.specReadbackReport(reader, { ...report, task: f.task.id, refs: ["src/hub/tasks.ts", "src/hub/no-such-readback-file.ts"] })).toMatchObject({ readback: started.readback });
    await expect(f.tasks.specReadbackReport(reader, { ...report, task: f.task.id, proposes: "Something else." })).rejects.toThrow();
  } finally { f.close(); }
});

test("status reads none, then unavailable, current and stale against the issue body", async () => {
  const f = await readbackFixture();
  try {
    expect(f.tasks.readbackView(f.task, EDIT)).toEqual({ state: "none" });
    expect(f.tasks.readbackView(f.task, undefined)).toEqual({ state: "unavailable" });
    const started = await f.tasks.specReadbackStart("user", f.task.id);
    expect(f.tasks.readbackView(f.task, EDIT)).toEqual({ state: "current" });
    await f.tasks.specReadbackReport(started.reader!, { ...report, task: f.task.id, undefined: [{ term: "receipt", where: "Storage" }] });
    expect(f.tasks.readbackView(f.task, EDIT)).toMatchObject({ state: "current", undefined: [{ term: "receipt", where: "Storage" }], missing_refs: [] });
    expect(f.tasks.readbackView(f.task, { lastEditedAt: "2026-11-24T09:00:00Z" })).toEqual({ state: "stale" });
  } finally { f.close(); }
});

