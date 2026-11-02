import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type TaskState } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

const A = "a".repeat(40), B = "b".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_messages: Envelope[]) {}
}
async function rig(options: { mode?: SdlcMode; state?: TaskState; linked?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-review-head-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  for (const name of ["codex", "claude"]) { const peer = new Peer(name); bus.add(peer); await peer.start(); }
  let currentHead = A;
  const calls: string[][] = [];
  const gh: SdlcGh = async args => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: currentHead, state: "OPEN", isDraft: false, reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [], files: [], changedFiles: 0, baseRefName: "main", baseRefOid: A, headRefName: "fix/head" }) };
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    if (query.includes("reviewThreads")) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: currentHead, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
    return { code: 1, stdout: "" }; // Every read stays in this fixture; never fall through to gh.
  };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "head-fixture", repository: "owner/repo", routing: () => loadRouting(dir), notify: () => {},
    sdlc: { config: () => sdlcConfig({ mode: options.mode ?? "advise", required_checks: [] }), gh } });
  cleanups.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const t = board.propose(USER, { title: "synthetic head binding", class: "implement", refs: { repo: "owner/repo", commit: A } });
  board.update(t.id, USER, "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
  board.update(t.id, "codex", "done", { state: "in_review", ...(options.linked === false ? {} : { sdlc: { repo: "owner/repo", pr: 7, head: A, reviewedHead: A, localHead: A, localResult: "passed" as const } }) });
  if (options.state === "changes_requested" || options.state === "in_progress") board.update(t.id, "claude", "changes_requested", { state: "changes_requested" });
  if (options.state === "in_progress") board.update(t.id, "codex", "accepted", { state: "in_progress" });
  return { tasks, board, id: t.id, calls, move: (head: string) => { currentHead = head; } };
}
async function refusal(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); }
}
function ownerNextStep(message: string | undefined) {
  expect(message).toBeDefined();
  expect(message).toContain("hub_task_done");
  expect(message).toContain("refs.commit");
}

test("review head mismatch identifies both full heads and the owner re-file step without effects", async () => {
  const r = await rig({ mode: "off", linked: false });
  const before = r.board.get(r.id)!;
  const message = await refusal(() => r.tasks.review("claude", r.id, "approved", "synthetic", undefined, B));
  expect(message).toContain(A); expect(message).toContain(B); ownerNextStep(message);
  expect(r.board.get(r.id)).toEqual(before);
});

for (const state of ["in_review", "changes_requested", "in_progress"] as const) test(`a moved PR cannot leave a stale head on a ${state} re-file without refs.commit`, async () => {
  const r = await rig({ state }); r.move(B);
  const before = r.board.get(r.id)!;
  const message = await refusal(() => r.tasks.done("codex", r.id, `synthetic re-file for https://github.com/owner/repo/pull/7, new head ${B}`));
  if (message) {
    ownerNextStep(message);
    expect(message).toContain(A);
    expect(r.board.get(r.id)).toEqual(before);
  } else {
    const after = r.board.get(r.id)!;
    expect(after.refs.commit).toBe(B);
    expect(after.sdlc?.reviewedHead === undefined || after.sdlc.reviewedHead === B).toBe(true);
    expect(r.calls.some(args => args[0] === "pr" && args[1] === "view")).toBe(true);
  }
});

test("an omitted-head approval refuses a known moved PR rather than approving the recorded head", async () => {
  const r = await rig(); r.move(B);
  const before = r.board.get(r.id)!;
  const message = await refusal(() => r.tasks.review("claude", r.id, "approved", "synthetic no explicit head"));
  expect(message).toContain(A); expect(message).toContain(B); ownerNextStep(message);
  expect(r.board.get(r.id)).toEqual(before);
});

test("an unchanged PR still permits legacy omitted-head approval", async () => {
  const r = await rig();
  const approved = await r.tasks.review("claude", r.id, "approved", "synthetic current head");
  expect(approved.state).toBe("approved");
  expect(approved.sdlc?.reviewedHead).toBe(A);
});
