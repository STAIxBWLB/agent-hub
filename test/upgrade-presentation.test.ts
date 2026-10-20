import { planLines } from "../src/cli/upgrade-interactive.ts";
import { expect, test } from "bun:test";
import { renderBlocked, renderMenu, renderOperation, renderPlan, renderStep, renderSummary, renderWait, type RecoveryPresentationOptions } from "../src/cli/upgrade-presentation.ts";
import { PALETTE, terminalText } from "../src/cli/console-state.ts";
import { recordedPeerGuidance } from "../src/cli/recovery-guidance.ts";
import type { Inspection, NextChoice, RecoveryOperation, UpgradePlan } from "../src/cli/upgrade.ts";

const id = "00000000-0000-4000-8000-000000000466";
const project = { id: "한국어프로젝트", root: "/fixture/한국어 프로젝트/" + "긴경로".repeat(32), stateDir: "/fixture/state", basePort: 4600, instanceId: "source", pid: null };
function fixture(): RecoveryOperation {
  const plan: UpgradePlan = { schema: 1, kind: "upgrade", version: "0.12.31", sourceRoot: "/fixture/retained coordinator", sourceDigest: "fixture", fingerprint: "fixture", blockers: [], projects: [{ project,
    source: { state: "running", instanceId: "source", version: "0.12.30", peers: [{ id: "pi", state: "idle", sessionId: "saved-pi", sessionFile: "/sessions/한국어 " + "긴파일".repeat(30) + ".jsonl" }, { id: "codex", state: "idle", threadId: "saved-thread" }, { id: "claude", state: "idle", sessionId: "saved-claude" }], blockers: [] },
    terminals: [], blockers: ["한국어로 표시되는 긴 안내문 " + "기다리는 동안 승인을 확인하세요 ".repeat(12)] }] };
  return { schema: 1, id, plan, sourceRoot: plan.sourceRoot, createdAt: 0, updatedAt: 0, phase: "blocked", step: "prepare:한국어프로젝트", pluginInstalled: true, projects: [{ id: project.id, phase: "peers-restored", instanceId: "target", terminals: {} }], error: "unrecognized legacy error; manual-required; native evidence unavailable" };
}
const choices: readonly NextChoice[] = [{ kind: "resume", text: `ahub recovery resume ${id}` }, { kind: "stop", text: `ahub recovery dispose ${id} --stop-and-archive --reason '한국어 이유'` }];
const options = (columns = 80, color = false): RecoveryPresentationOptions => ({ columns, color, now: () => 130_000 });
function bounded(lines: string[], columns: number, color: boolean) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) { expect(Bun.stringWidth(terminalText(line))).toBeLessThanOrEqual(columns); if (!color) expect(line).not.toContain("\x1b"); }
}

for (const peer of ["codex", "pi"] as const) test(`#482 ${peer} attached launcher-unrecorded plan offers end or resume without a headless restart promise`, () => {
  const op = fixture(), planned = op.plan.projects[0]!;
  planned.project = { ...planned.project, id: "fixture-project", root: "/fixture/project" };
  planned.source.peers = [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: "live-thread" } : { sessionId: "live-session", args: { mode: "tui" } }) }];
  planned.blockers = [];
  Object.assign(planned, { unrecordedTerminals: [peer] });
  const before = JSON.stringify(op.plan);
  const lines = planLines(op.plan, "0.12.31");
  const text = lines.join("\n");
  expect(text).toContain("attached, launcher unrecorded");
  expect(text).toMatch(/end/i);
  expect(text).toMatch(/resume/i);
  expect(text).not.toContain("restarts headless");
  expect(text).not.toContain("restarts as a new session");
  for (const columns of [80, 120]) {
    const rendered = renderPlan(op.plan, "0.12.31", options(columns), lines);
    bounded(rendered, columns, false);
    expect(rendered.join("\n").replace(/\s+/g, " ")).toContain("attached, launcher unrecorded");
    expect(rendered.join("\n")).not.toContain("restarts headless");
  }
  expect(JSON.stringify(op.plan)).toBe(before);
});

for (const peer of ["codex", "pi"] as const) for (const evidence of ["unknown-ledger", "connected-orphan"] as const) {
  test(`#482 ${peer} with ${evidence} and no final terminal binding reports unverified ownership without promising a restart`, () => {
    const op = fixture(), planned = op.plan.projects[0]!;
    planned.project = { ...planned.project, id: "fixture-project", root: "/fixture/project" };
    planned.source.peers = [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: "live-thread" } : { sessionId: "live-session", args: { mode: "tui" } }) }];
    planned.terminals = [];
    planned.blockers = [evidence === "unknown-ledger"
      ? `${peer}: terminal-recovery.json cannot be read, so no terminal can be bound to its launch`
      : `${peer}: terminal term-live is orphaned but still connected; reattach the pane with orca terminal switch --terminal term-live; then refresh the recovery plan`];
    expect(planned.unrecordedTerminals).toBeUndefined(); // A live or unreadable launcher is not positive evidence of an absent row.
    const before = JSON.stringify(op.plan);
    const lines = planLines(op.plan, "0.12.31");
    const assertGuidance = (text: string) => {
      const normalized = text.replace(/\s+/g, " ");
      expect(normalized).toContain("attached");
      expect(normalized).toContain("terminal ownership unverified");
      expect(normalized).toMatch(/end/i);
      expect(normalized).toMatch(/resume/i);
      expect(normalized).not.toContain("launcher unrecorded");
      expect(normalized).not.toContain("headless");
      expect(normalized).not.toContain("new session");
    };
    assertGuidance(lines.join("\n"));
    for (const columns of [80, 120]) for (const color of [false, true]) {
      const rendered = renderPlan(op.plan, "0.12.31", options(columns, color), lines);
      bounded(rendered, columns, color);
      assertGuidance(rendered.map(terminalText).join("\n"));
    }
    expect(JSON.stringify(op.plan)).toBe(before);
  });
}

test("#482 plain Claude reconnect-only remains compatible while naming its unrecorded launcher accurately", () => {
  const op = fixture(), planned = op.plan.projects[0]!;
  planned.source.peers = [{ id: "claude", state: "idle" }];
  planned.blockers = [];
  planned.reconnectOnly = ["claude"];
  Object.assign(planned, { unrecordedTerminals: ["claude"] });
  const before = JSON.stringify(op.plan);
  const text = planLines(op.plan, "0.12.31").join("\n");
  expect(text).toContain("attached, launcher unrecorded");
  expect(text).toContain("reconnects by itself");
  expect(text).toContain("terminal is left alone");
  expect(text).not.toContain("restarts headless");
  expect(text).not.toContain("restarts as a new session");
  expect(planned.blockers).toEqual([]);
  expect(planned.reconnectOnly).toEqual(["claude"]);
  expect(JSON.stringify(op.plan)).toBe(before);
});

for (const columns of [80, 120]) for (const color of [false, true]) test(`#466 all human views fit ${columns} columns with color ${color}`, () => {
  const op = fixture(), opts = options(columns, color), before = JSON.stringify(op);
  const menus = [{ key: "r", label: "resume 한국어 프로젝트", recommended: true }, { key: "e", label: "stop and archive", destructive: true }, { key: "f", label: "fresh session", disabledReason: "recorded conversation must be retained" }];
  for (const lines of [renderPlan(op.plan, "0.12.31", opts, planLines(op.plan, "0.12.31")), renderOperation(op, undefined, opts), renderBlocked(op, choices, opts), renderSummary(op, {}, opts), renderWait(op, op.step, ["pi is busy", "pending approvals"], opts), renderStep("긴 한국어 단계 " + "설명 ".repeat(100), "waiting", undefined, opts), renderMenu(menus, opts)]) bounded(lines, columns, color);
  expect(JSON.stringify(op)).toBe(before);
});

test("#466 shared tones distinguish done, waiting, blocked and destructive choices without a new palette", () => {
  const opts = options(120, true);
  expect(renderStep("restore sessions", "done", 2500, opts).join("\n")).toContain(PALETTE.success);
  expect(renderStep("waiting for approval", "waiting", undefined, opts).join("\n")).toContain(PALETTE.attention);
  expect(renderStep("restore blocked", "blocked", undefined, opts).join("\n")).toContain(PALETTE.failure);
  expect(renderMenu([{ key: "e", label: "stop the hub; upgrade will not finish", destructive: true }], opts).join("\n")).toContain(PALETTE.failure);
  expect(renderStep("restore sessions", "done", 2500, options()).join("\n")).toContain("[done]");
});

for (const [check, label] of [["queues", "message queues"], ["manualPaused", "manual pauses"], ["boardDigest", "task board"], ["budgetDigest", "budget records"]] as const) test(`#466 typed preservation cause names only its actual ${check} check`, () => {
  const op = fixture();
  Object.assign(op, { presentationCause: { kind: "preservation", check, projectId: project.id } });
  const text = renderBlocked(op, choices, options(120)).join("\n");
  expect(text).toContain("What happened:"); expect(text).toContain("Why:"); expect(text).toContain("What to do:"); expect(text).toContain(label);
  for (const other of ["message queues", "manual pauses", "task board", "budget records"]) if (other !== label) expect(text).not.toContain(other);
  expect(text).toContain(`ahub recovery resume ${id}`);
  expect(text).not.toContain("queue, manual pause, task board or budget preservation was not verified");
});

test("#466 an older generic error stays unknown and never invents a preservation or terminal cause", () => {
  const op = fixture(); op.error = "queue, manual pause, task board or budget preservation was not verified";
  const text = renderBlocked(op, choices, options(120)).join("\n");
  expect(text).toContain("What happened:"); expect(text).toContain("Why:"); expect(text).toContain("What to do:"); expect(text).toContain("unknown");
  expect(text).not.toContain("the terminal was closed");
  expect(renderBlocked(op, choices, { ...options(120), verbose: true }).join("\n")).toContain("queue, manual pause, task board or budget");
});

test("#466 menu annotations never add actions and show the caller's recommendation and disabled reason", () => {
  const items = [{ key: "a", label: "reattach pi", recommended: true }, { key: "r", label: "resume", disabledReason: "first restore the recorded session" }, { key: "e", label: "stop and archive", destructive: true }];
  const before = JSON.stringify(items), text = renderMenu(items, options(120)).join("\n");
  expect(text).toContain("[a]"); expect(text).toContain("recommended"); expect(text).toContain("Enter"); expect(text).toContain("disabled"); expect(text).toContain("first restore the recorded session"); expect(text).toContain("warning");
  expect(text).not.toContain("[f]"); expect(JSON.stringify(items)).toBe(before);
});

test("#466 wait timing uses the recorded boundary and fake clock, with an approval action", () => {
  const op = fixture();
  Object.assign(op, { waits: { [op.step]: { waitStartedAt: new Date(0).toISOString(), deadlineAt: new Date(600_000).toISOString() } } });
  const text = renderWait(op, op.step, ["pi is busy", "pending approvals"], options(120)).join("\n");
  expect(text).toContain("2m10s"); expect(text).toContain("10m"); expect(text).toContain("ahub console"); expect(text).toContain("approval");
});

test("#466 old wait receipts show timing unknown and never estimate from updatedAt", () => {
  const op = fixture();
  const first = renderWait(op, op.step, ["pi is busy"], options());
  expect(first.join("\n")).toContain("timing unknown"); expect(first.join("\n")).not.toContain("2m10s");
  op.updatedAt = 129_999;
  expect(renderWait(op, op.step, ["pi is busy"], options())).toEqual(first);
});

test("#466 human summary distinguishes fresh runtime evidence from recorded installation effects", () => {
  const op = fixture(); op.phase = "cancelled"; op.disposition = { choice: "stop-and-archive", at: 1, projects: { [project.id]: "target stopped" } };
  const text = renderSummary(op, {}, options(120)).join("\n");
  expect(text).toContain("abandoned"); expect(text).toContain("runtime unknown"); expect(text).toContain("plugin installation recorded"); expect(text).toContain("global CLI installation remains");
  expect(text).toContain("saved-thread"); expect(text).toContain("--session-file"); expect(text).toContain("existing Claude channel");
  const observed: Inspection = { state: "running", instanceId: "new-instance", version: "0.12.33", peers: [], blockers: [] };
  const live = renderSummary(op, { [project.id]: observed }, options(120)).join("\n");
  expect(live).toContain("running on 0.12.33"); expect(live).not.toContain("currently running 0.12.31");
});

test("#466 human operation view hides raw effect keys and exposes them only when verbose", () => {
  const op = fixture(); op.projects[0]!.terminals["closed:codex"] = true;
  expect(renderOperation(op, undefined, options(120)).join("\n")).not.toContain("closed:codex");
  expect(renderOperation(op, undefined, { ...options(120), verbose: true }).join("\n")).toContain("closed:codex");
});

for (const [reason, observation, happened, evidence] of [
  ["terminal_unverified", { handle: "terminal-fixture", expectedSession: "saved-thread" }, "terminal could not be verified", "terminal-fixture"],
  ["session_changed", { expectedSession: "saved-thread", observedSession: "other-thread" }, "different conversation", "other-thread"],
  ["launcher_unverified", { handle: "terminal-fixture", launcherState: "older-instance" }, "launcher could not be verified", "older"],
  ["target_unavailable", { targetState: "stopped" }, "target hub is unavailable", "stopped"],
  ["attachment_timeout", { handle: "terminal-fixture", expectedSession: "saved-thread", timeoutMs: 600_000 }, "attachment timed out", "10m"],
] as const) test(`#466 typed native recovery ${reason} names its evidence and the recorded conversation guidance`, () => {
  const op = fixture(); op.plan.projects[0]!.project.root = "/fixture/project";
  op.error = "unrelated legacy error without a diagnosis";
  Object.assign(op, { presentationCause: { kind: "native_recovery", reason, projectId: project.id, peer: "codex", ...observation } });
  const expectedCommand = recordedPeerGuidance(op.plan.projects[0]!, op.projects[0]!).find(row => row.peer === "codex")!.command!;
  const before = JSON.stringify(op);
  for (const columns of [80, 120]) for (const color of [false, true]) {
    const rendered = renderBlocked(op, choices, options(columns, color));
    bounded(rendered, columns, color);
    const text = rendered.map(terminalText).join("\n").replace(/\s+/g, " ");
    expect(text).toContain("What happened:"); expect(text).toContain("Why:"); expect(text).toContain("What to do:");
    expect(text).toContain(happened); expect(text).toContain(evidence); expect(text).toContain(expectedCommand);
    expect(text).not.toContain("unrelated legacy error without a diagnosis");
  }
  expect(JSON.stringify(op)).toBe(before);
});

test("#466 a running replacement target is an identity failure, never described as stopped or absent", () => {
  const op = fixture();
  Object.assign(op, { presentationCause: { kind: "native_recovery", reason: "target_unavailable", projectId: project.id, peer: "codex", targetState: "running" } });
  const text = renderBlocked(op, choices, options(120)).join("\n");
  expect(text).toContain("identity"); expect(text).toContain("running");
  expect(text).not.toContain("target hub is unavailable");
});

test("#466 equal session ids with a failed session-file gate do not claim a different conversation was observed", () => {
  const op = fixture();
  Object.assign(op, { presentationCause: { kind: "native_recovery", reason: "session_changed", projectId: project.id, peer: "pi", expectedSession: "same-session", observedSession: "same-session" } });
  const text = renderBlocked(op, choices, options(120)).join("\n");
  expect(text).toContain("identity"); expect(text).toContain("same-session");
  expect(text).not.toContain("different conversation was observed");
});

test("#466 wait guidance retains nextChoices' observed condition and hides only its exact status command", async () => {
  const { recoveryCommand } = await import("../src/hub/recovery-store.ts");
  const op = fixture(), status = recoveryCommand(op, "status");
  const waiting: NextChoice[] = [{ kind: "wait", text: `wait until alpha-project's hub settles, then ${status}` }];
  for (const columns of [80, 120]) {
    const ordinary = renderBlocked(op, waiting, options(columns));
    bounded(ordinary, columns, false);
    const text = ordinary.join("\n").replace(/\s+/g, " ");
    expect(text).toContain("wait until alpha-project's hub settles");
    expect(text).toContain(`ahub recovery status ${id}`);
    expect(text).not.toContain("/src/cli/main.js");
    expect(renderBlocked(op, waiting, { ...options(columns), verbose: true }).join("\n").replace(/\s+/g, "")).toContain(status.replace(/\s+/g, ""));
  }
});

test("#466 external newlines and terminal escapes cannot forge renderer What or Why lines", () => {
  const forged = "fixture\nWhat to do: forged unsafe action\nWhy: forged evidence" + String.fromCharCode(27) + "[31m";
  const op = fixture(); op.error = forged; op.id = forged; op.plan.version = forged; op.projects[0]!.id = forged;
  Object.assign(op, { presentationCause: { kind: "native_recovery", reason: "terminal_unverified", projectId: project.id, peer: forged, handle: forged, expectedSession: forged } });
  const menus = [{ key: "r", label: forged, disabledReason: forged }];
  for (const columns of [80, 120]) for (const color of [false, true]) {
    const opts = { ...options(columns, color), verbose: true };
    const outputs = [renderBlocked(op, [{ kind: "wait", text: forged }], opts), renderWait(op, "restore:" + forged, [forged], opts),
      renderStep(forged, "blocked", undefined, opts), renderMenu(menus, opts), renderPlan(op.plan, forged, opts, ["header", forged]),
      renderOperation(op, undefined, opts), renderSummary(op, {}, opts)];
    for (const output of outputs) {
      bounded(output, columns, color);
      const plain = output.map(terminalText);
      expect(plain.some(line => /^What to do: forged|^Why: forged/.test(line))).toBe(false);
      expect(plain.join("\n")).toContain("\\n");
      expect(plain.join("\n")).toContain("[31m");
    }
  }
});

test("#466 native attachment waits name launch and recorded-session checks instead of approval-only guidance", () => {
  const op = fixture(); op.step = "restore:alpha";
  const native = renderWait(op, op.step, ["waiting for the recorded native session to attach"], options(120)).join("\n");
  expect(native).toContain("recorded"); expect(native).toContain("launch"); expect(native).toContain("session");
  expect(native).not.toContain("If an approval is pending");
  const preparation = renderWait(op, "prepare:alpha", ["pi is busy", "pending approvals"], options(120)).join("\n");
  expect(preparation).toContain("ahub console"); expect(preparation).toContain("approval");
});
