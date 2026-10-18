import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import type { TaskClass } from "../src/hub/board.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { readSpecEdit, sdlcConfig, specState, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";

// #481 S1 (AC2): person-only spec acceptance bound to the issue's body edit time; build entry needs it in enforce.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const EDITED = "2026-10-18T01:00:00Z", LATER = "2026-10-18T02:00:00Z";

function rig(mode: SdlcMode, taskClass: TaskClass = "implement", scenario: { plannerReview?: boolean; capacity?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-spec-")), board = new Board(join(dir, "hub.db")), notices: string[] = [];
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const issue = { lastEditedAt: EDITED as string | null, updatedAt: EDITED, fail: false };
  let calls = 0, pause: Promise<void> | undefined;
  const gh: SdlcGh = async args => {
    calls++;
    await pause;
    if (issue.fail) return { code: 1, stdout: "" };
    if (!args.join(" ").includes("issue(number")) return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 7, ...(scenario.plannerReview ? { state: "OPEN", createdAt: EDITED } : {}), lastEditedAt: issue.lastEditedAt, updatedAt: issue.updatedAt } } } }) };
  };
  const config = sdlcConfig({ mode, required_checks: ["gate"] });
  const bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ board, bus, ...(scenario.plannerReview ? { roles: { claude: ["planner"] } } : {}), ...(scenario.capacity === undefined ? {} : { wipLimit: () => scenario.capacity! }), cwd: dir, project: "spec", routing: () => loadRouting(dir), notify: text => notices.push(text), sdlc: { config: () => config, gh } });
  const task = board.propose(USER, { title: "build it", class: taskClass });
  board.update(task.id, USER, "assigned", { owner: "codex", reviewer: USER });
  const accept = async () => { await tasks.specGate("codex", task.id); return scenario.plannerReview ? tasks.acceptReviewed("codex", task.id) : tasks.accept("codex", task.id); };
  const acceptSpec = async () => {
    const accepted = tasks.acceptSpec(USER, task.id, { repo: "owner/repo", issue: 7, edit: (await readSpecEdit("owner/repo", 7, gh))! });
    if (scenario.plannerReview) await tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "S1 fixture: plan reviewed independently" });
    return accepted;
  };
  const hold = () => { let release!: () => void; pause = new Promise<void>(r => { release = r; }); return () => { pause = undefined; release(); }; };
  return { board, bus, tasks, id: task.id, notices, issue, gh, calls: () => calls, accept, acceptSpec, hold };
}

test("acceptance is the person's, stores identity and edit times only, and is dropped when the receipt is relinked", async () => {
  const r = rig("enforce");
  const edit = (await readSpecEdit("owner/repo", 7, r.gh))!;
  expect(() => r.tasks.acceptSpec("codex", r.id, { repo: "owner/repo", issue: 7, edit })).toThrow("spec acceptance is the person's");
  expect(() => r.tasks.recordLifecycle("codex", r.id, { acceptance: { repo: "owner/repo", issue: 7, lastEditedAt: null, updatedAt: EDITED, acceptedAt: 1 } })).toThrow("unsupported");
  const accepted = await r.acceptSpec();
  expect(accepted.sdlc?.acceptance).toMatchObject({ repo: "owner/repo", issue: 7, lastEditedAt: EDITED, updatedAt: EDITED });
  expect(JSON.stringify(accepted.sdlc)).not.toContain("body");
  expect(accepted.history.at(-1)).toMatchObject({ event: "spec accepted", by: USER });
  expect(() => r.tasks.acceptSpec(USER, r.id, { repo: "owner/repo", issue: 8, edit })).toThrow("links issue #7");
  expect(r.tasks.recordLifecycle(USER, r.id, { issue: 9 }).sdlc?.acceptance).toBeUndefined();
});

test("enforce refuses build entry until the spec is accepted, and again after a body edit; comments do not count", async () => {
  const r = rig("enforce", "implement", { plannerReview: true });
  await expect(r.accept()).rejects.toThrow("spec issue unknown");
  r.tasks.recordLifecycle("codex", r.id, { repo: "owner/repo", issue: 7 });
  await expect(r.accept()).rejects.toThrow("spec acceptance missing");
  expect(() => r.tasks.accept("codex", r.id)).toThrow("spec acceptance missing"); // the synchronous gate holds without specGate
  expect(r.board.get(r.id)?.state).toBe("proposed");
  await r.acceptSpec();
  r.issue.updatedAt = LATER; // a comment moves updatedAt only
  await r.tasks.specGate("codex", r.id);
  r.issue.lastEditedAt = LATER; // a body edit
  await expect(r.tasks.specGate("codex", r.id)).rejects.toThrow("spec changed after acceptance");
  expect((await r.tasks.lifecycleStatus(r.id)).spec).toEqual({ issue: 7, state: "changed" });
  r.issue.fail = true;
  await expect(r.tasks.specGate("codex", r.id)).rejects.toThrow("spec edit time unknown");
  r.issue.fail = false; await r.acceptSpec(); // re-acceptance at the new body
  expect((await r.accept()).state).toBe("in_progress");
  expect((await r.tasks.lifecycleStatus(r.id)).spec).toEqual({ issue: 7, state: "current" });
});

test("enforce refuses a build stage change without acceptance from the owner, never from the person", () => {
  const r = rig("enforce");
  r.tasks.recordLifecycle("codex", r.id, { repo: "owner/repo", issue: 7 });
  expect(() => r.tasks.recordLifecycle("codex", r.id, { stage: "build" })).toThrow("spec acceptance missing");
  expect(() => r.tasks.recordLifecycle("codex", r.id, { stage: "implement" })).toThrow("spec acceptance missing"); // the alias too
  expect(r.tasks.recordLifecycle(USER, r.id, { stage: "build" }).sdlc?.stage).toBe("build");
});

test("an owner's build stage change re-reads the body edit time; other stages and the person are not gated", async () => {
  const r = rig("enforce");
  r.tasks.recordLifecycle("codex", r.id, { repo: "owner/repo", issue: 7 });
  await expect(r.tasks.specStageGate("codex", r.id, { stage: "build" })).rejects.toThrow("spec acceptance missing");
  await r.acceptSpec();
  await r.tasks.specStageGate("codex", r.id, { stage: "build" });
  r.issue.lastEditedAt = LATER; // a body edit after acceptance: the synchronous gate alone sees only "unknown"
  await expect(r.tasks.specStageGate("codex", r.id, { stage: "build" })).rejects.toThrow("spec changed after acceptance");
  await expect(r.tasks.specStageGate("codex", r.id, { stage: "implement" })).rejects.toThrow("spec changed after acceptance");
  await r.tasks.specStageGate("codex", r.id, { stage: "review" });
  await r.tasks.specStageGate(USER, r.id, { stage: "build" });
  expect(rig("advise").tasks.specStageGate("codex", 1, { stage: "build" })).resolves.toBeUndefined();
});

test("a self-claim and a done without accept start build work only from an accepted spec in enforce; advise notifies", async () => {
  const r = rig("enforce", "implement", { capacity: 2 });
  r.bus.add({ id: "codex", state: "idle", deliver: async () => {}, start: async () => {}, stop: async () => {} });
  const claimed = await r.tasks.propose("codex", { title: "claim it", class: "implement", owner: "codex" });
  expect(claimed).toMatchObject({ owner: "codex", state: "proposed" });
  expect(claimed.history.map(h => h.event)).not.toContain("accepted");
  expect(r.notices.join(" ")).toContain("SDLC build entry blocked: spec issue unknown");
  await expect(r.tasks.done("codex", r.id, "finished")).rejects.toThrow("spec issue unknown");
  expect(r.board.get(r.id)?.state).toBe("proposed");
  expect(r.board.get(r.id)?.history.map(h => h.event)).toEqual(["proposed", "assigned"]);
  const advise = rig("advise", "implement", { capacity: 2 });
  advise.bus.add({ id: "codex", state: "idle", deliver: async () => {}, start: async () => {}, stop: async () => {} });
  expect((await advise.tasks.propose("codex", { title: "claim it", class: "implement", owner: "codex" })).state).toBe("in_progress");
  expect(advise.notices.join(" ")).toContain("SDLC build entry advice: spec issue unknown");
});

test("a spec readback is fenced: a relink and acceptance during the read refuse the stale reading", async () => {
  for (const stage of [false, true]) {
    const r = rig("enforce");
    r.tasks.recordLifecycle("codex", r.id, { repo: "owner/repo", issue: 7 });
    await r.acceptSpec();
    const release = r.hold();
    const gate = stage ? r.tasks.specStageGate("codex", r.id, { stage: "build" }) : r.tasks.specGate("codex", r.id);
    const outcome = gate.then(() => "passed", (e: Error) => e.message);
    await Bun.sleep(0);
    r.tasks.recordLifecycle(USER, r.id, { issue: 8 });
    r.tasks.acceptSpec(USER, r.id, { repo: "owner/repo", issue: 8, edit: { lastEditedAt: EDITED, updatedAt: EDITED } });
    release();
    expect(await outcome).toContain("changed during the spec readback");
  }
});

test("advise notifies an owner's build stage change without a current acceptance", async () => {
  const r = rig("advise");
  r.tasks.recordLifecycle("codex", r.id, { repo: "owner/repo", issue: 7 });
  await r.tasks.specStageGate("codex", r.id, { stage: "build" });
  expect(r.notices.join(" ")).toContain("SDLC build entry advice: ");
  expect(r.notices.join(" ")).toContain("spec acceptance missing");
});

test("advise only notifies, off reads nothing, and non-build classes are not gated", async () => {
  const advise = rig("advise");
  expect((await advise.accept()).state).toBe("in_progress");
  expect(advise.notices.join(" ")).toContain("SDLC build entry advice: spec issue unknown");
  const off = rig("off");
  expect((await off.accept()).state).toBe("in_progress");
  expect(off.calls()).toBe(0); expect(off.notices.join(" ")).not.toContain("SDLC");
  expect((await off.tasks.lifecycleStatus(off.id)).spec).toBeUndefined();
  const review = rig("enforce", "review");
  expect((await review.accept()).state).toBe("in_progress");
});

test("specState reads only the stored identity and the body edit time", () => {
  const receipt = { stage: "spec", repo: "owner/repo", issue: 7, acceptance: { repo: "owner/repo", issue: 7, lastEditedAt: null, updatedAt: EDITED, acceptedAt: 1 } };
  expect(specState(receipt, { lastEditedAt: null, updatedAt: LATER })).toBe("current"); // never edited, then commented
  expect(specState(receipt, { lastEditedAt: LATER, updatedAt: LATER })).toBe("changed");
  expect(specState(receipt, undefined)).toBe("unknown");
  expect(specState({ ...receipt, issue: 8 }, undefined)).toBe("missing");
});

test("ahub sdlc accept is refused to agent shells and live tests", () => {
  expect(classifyPeerCommand("sdlc", ["accept", "5", "--issue", "7"])).toBe("console");
  expect(liveTestRefusal("sdlc", ["accept", "5", "--issue", "7"])).toBe(true);
});
