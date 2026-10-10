import { expect, test } from "bun:test";
import { join } from "node:path";
import { latestRelease, newerVersion } from "../src/cli/recovery-package.ts";
import { follow, operationLines, operationScreen, planLines, planScreen, resetFlow, stepLabel, type ScreenIO, type UpgradeHost } from "../src/cli/upgrade-interactive.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { cancellableWait, nextChoices, type Inspection, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

// #272. The screens only read, ask and run existing commands, so a scripted terminal and a fake host cover them; what
// the commands themselves accept is test/upgrade.test.ts's invariant.
const ID = "00000000-0000-4000-8000-000000000272";
const MAIN = join(PACKAGE_ROOT, "src/cli/main.js");
const project = { id: "alpha", root: "/alpha", stateDir: "/alpha/.agenthub/state", basePort: 4600, instanceId: "old", pid: 1 };
const source = (over: Partial<Inspection> = {}): Inspection => ({ state: "running", instanceId: "old", version: "0.5.0", protocol: PROTOCOL, blockers: [],
  peers: [{ id: "claude", state: "idle", sessionId: "s1" }, { id: "codex", state: "busy", threadId: "t1" }, { id: "kimi", state: "idle" }, { id: "pi", state: "offline" }], ...over });
const plan = (over: Partial<UpgradePlan["projects"][number]> = {}, blockers: string[] = []): UpgradePlan => ({ schema: 1, kind: "upgrade", version: "0.6.0", sourceRoot: PACKAGE_ROOT, sourceDigest: "d", fingerprint: "f", blockers,
  projects: [{ project, source: source(), terminals: [{ peer: "codex", handle: "term_codex" }], blockers: [], reconnectOnly: ["claude"], ...over }] });
const operation = (over: Partial<RecoveryOperation> = {}): RecoveryOperation => ({ schema: 1, id: ID, plan: plan(), createdAt: 0, updatedAt: 0, phase: "blocked", step: "prepare:alpha", sourceRoot: PACKAGE_ROOT,
  projects: [{ id: "alpha", phase: "pending", terminals: {} }], ...over });

function screen(answers: string[], onRun: (argv: string[]) => number | void = () => {}) {
  const out: string[] = [], ran: string[][] = [], asked: string[] = [];
  const io: ScreenIO = {
    ask: async (question) => { asked.push(question); return answers.shift() ?? "q"; },
    out: (line) => { out.push(line); },
    run: async (argv) => { ran.push(argv); return onRun(argv) ?? 0; },
    sleep: async () => {},
    interrupted: () => false,
  };
  return { io, out, ran, asked };
}
function host(over: Partial<UpgradeHost> = {}): UpgradeHost {
  return { plan: async () => plan(), apply: async () => operation(), lock: () => undefined, read: () => operation(), runner: () => undefined,
    live: async () => ({ alpha: source() }), stopRunner: async () => true, entry: MAIN, version: "0.6.0", ...over };
}

test("without --to the target is the registry's latest release, and only a newer target changes coordinator", async () => {
  const calls: string[][] = [];
  expect(await latestRelease(async (args) => { calls.push(args); return { code: 0, stdout: '"0.12.22"\n', stderr: "" }; })).toBe("0.12.22");
  expect(calls).toEqual([["npm", "view", "@staix/agent-hub", "version", "--json"]]);
  await expect(latestRelease(async () => ({ code: 1, stdout: "", stderr: "offline" }))).rejects.toThrow("name the release with --to");
  await expect(latestRelease(async () => ({ code: 0, stdout: '["0.12.21","0.12.22"]', stderr: "" }))).rejects.toThrow("unexpected latest release");
  await expect(latestRelease(async () => ({ code: 0, stdout: '"latest"', stderr: "" }))).rejects.toThrow("exact package version");
  expect([newerVersion("0.12.22", "0.12.21"), newerVersion("0.13.0", "0.12.99"), newerVersion("1.0.0", "0.99.99")]).toEqual([true, true, true]);
  expect([newerVersion("0.12.21", "0.12.21"), newerVersion("0.12.20", "0.12.21"), newerVersion("0.12.21-rc.1", "0.12.21"), newerVersion("0.9.9", "0.12.0")]).toEqual([false, false, false, false]);
});

test("the plan screen names each peer's fate, what is in progress and every blocker", () => {
  expect(planLines(plan(), "0.6.0")).toEqual([
    "upgrade to 0.6.0 (coordinator 0.6.0)", "",
    "alpha  /alpha  hub 0.5.0 (running)",
    "  claude  idle     reconnects by itself (unmanaged session; its terminal is left alone)",
    "  codex   busy     resumes its session in a new terminal (replaces term_codex)",
    "  kimi    idle     restarts headless as a new session",
    "  pi      offline  offline, left as it is",
    "  in progress: codex is busy (apply waits up to 10 minutes for it, then leaves this hub running)",
  ]);
  // The running hub's own readiness blockers, when it reports them, and the plan's blockers at both levels.
  const blocked = planLines(plan({ source: source({ recovery: { waiting: ["codex is busy", "pending approvals"] } }), blockers: ["codex: original conversation ID is unknown"], freshStart: ["kimi"] }, ["shared Claude plugin installer is unavailable"]), "0.6.0");
  expect(blocked).toContain("  in progress: codex is busy, pending approvals (apply waits up to 10 minutes for it, then leaves this hub running)");
  expect(blocked).toContain("  blocker: codex: original conversation ID is unknown");
  expect(blocked).toContain("  kimi    idle     restarts as a new session (no turn to lose)");
  expect(blocked.at(-1)).toBe("blocker: shared Claude plugin installer is unavailable");
  expect([stepLabel("commit:alpha"), stepLabel("install-global"), stepLabel("disposed: stop-and-archive (abandoned, not completed)")]).toEqual(["alpha: closing terminals and stopping the old hub", "installing the global CLI", "disposed: stop-and-archive (abandoned, not completed)"]);
});

test("apply is offered only without blockers, and an applied plan is followed to its end", async () => {
  const blocked = screen(["a", "q"]);
  let applied = 0;
  await planScreen(host({ plan: async () => plan({ blockers: ["claude: unmanaged session cannot reconnect"] }), apply: async () => { applied++; return operation(); } }), blocked.io);
  expect(applied).toBe(0);
  expect(blocked.asked[0]).toStartWith("Blocked: take the next action each blocker names, then refresh.\n[r] refresh");
  expect(blocked.out.at(-1)).toBe("nothing was changed");

  const steps: Partial<RecoveryOperation>[] = [{ phase: "running", step: "stage" }, { phase: "running", step: "prepare:alpha" }, { phase: "running", step: "prepare:alpha" }, { phase: "running", step: "commit:alpha" }, { phase: "completed", step: "completed" }];
  const ok = screen(["a"]);
  await planScreen(host({ read: () => operation(steps.length > 1 ? steps.shift() : steps[0]), runner: () => 4242, live: async () => ({ alpha: source({ recovery: { waiting: ["codex is busy"] } }) }) }), ok.io);
  expect(ok.asked[0]).toBe("[a] apply  [r] refresh  [j] plan as JSON  [x] reset a project's hub  [q] quit: ");
  expect(ok.out.slice(ok.out.indexOf(`operation ${ID} started; Ctrl+C stops following, never the upgrade`))).toEqual([
    `operation ${ID} started; Ctrl+C stops following, never the upgrade`,
    "  staging the release", "  alpha: holding deliveries and waiting until the hub is quiet", "    waiting for: codex is busy",
    "  alpha: closing terminals and stopping the old hub", "  completed", "upgrade to 0.6.0 completed",
  ]);
  expect(ok.ran).toEqual([]);
});

test("follow stops on an interrupt or a lost runner and leaves the operation alone", async () => {
  const interrupted = screen([]);
  let pressed = 0;
  interrupted.io.interrupted = () => pressed++ === 1; // the first read clears an earlier Ctrl+C; the second is this one
  expect(await follow(host({ read: () => operation({ phase: "running", step: "start:alpha" }), runner: () => 4242 }), interrupted.io, ID)).toBe("open");
  expect(interrupted.out).toEqual(["  alpha: starting the new hub", "stopped following; the runner keeps working"]);
  const lost = screen([]);
  expect(await follow(host({ read: () => operation({ phase: "running", step: "restore:alpha" }) }), lost.io, ID)).toBe("open");
  expect(lost.ran).toEqual([]);
});

test("an open operation's screen offers what next offers and runs the chosen command", async () => {
  // A blocked preflight with its source still running as planned: resume, abort and stop-and-archive, no fresh session.
  const blocked = operation({ error: "alpha: active turns, approvals or completion checks did not finish; source runtime left running; next actions: bun x recovery resume" });
  expect(nextChoices(blocked, undefined, { alpha: source() }).map((c) => c.kind)).toEqual(["resume", "abort", "stop"]);
  let state = blocked;
  const cancel = screen(["c"], () => { state = operation({ phase: "cancelled", step: "cancelled" }); });
  expect(await operationScreen(host({ read: () => state }), cancel.io, ID)).toBe("ended");
  expect(cancel.ran).toEqual([[MAIN, "recovery", "abort", ID]]);
  expect(cancel.out.filter((line) => line.startsWith("  ["))).toEqual([
    "  [r] resume (after the step the error names)", "  [c] cancel (no runtime was stopped; nothing to roll back)",
    "  [e] end: stop and archive (the upgrade is abandoned, not completed)", "  [x] end, then reset a project's hub", "  [s] refresh", "  [j] receipt as JSON", "  [q] quit (the operation stays as it is)",
  ]);
  expect(cancel.out).toContain("  error: alpha: active turns, approvals or completion checks did not finish; source runtime left running");
  expect(cancel.out.at(-1)).toBe(`operation ${ID} is cancelled; the recovery lock is free`);

  // With effects recorded abort would refuse, so cancel is not on the menu, and an unknown key changes nothing.
  const stopped = operation({ projects: [{ id: "alpha", phase: "stopped", terminals: { "closed:codex": true }, commitSent: true }] });
  const effects = screen(["c", "q"]);
  expect(await operationScreen(host({ read: () => stopped, live: async () => ({ alpha: { state: "stopped", peers: [], blockers: [], snapshot: ID } }) }), effects.io, ID)).toBe("quit");
  expect(effects.ran).toEqual([]);
  expect(effects.out.some((line) => line.startsWith("  [c]"))).toBe(false);
  expect(effects.out).toContain("  alpha  stopped  (closed:codex)");

  // Resume schedules the runner through the operation's own coordinator, then follows it.
  let resumed = blocked;
  const resume = screen(["r"], () => { resumed = operation({ phase: "completed", step: "completed" }); });
  expect(await operationScreen(host({ read: () => resumed }), resume.io, ID)).toBe("completed");
  expect(resume.ran).toEqual([[MAIN, "recovery", "resume", ID]]);
});

test("a runner that only waits can be cancelled; one past its first effect cannot", async () => {
  const waiting = operation({ phase: "running", step: "prepare:alpha" });
  expect(cancellableWait(waiting)).toBe(true);
  expect([operation({ phase: "running", step: "stage" }), operation({ phase: "running", step: "commit:alpha", projects: [{ id: "alpha", phase: "prepared", terminals: {} }] }),
    operation({ phase: "running", step: "prepare:alpha", projects: [{ id: "alpha", phase: "pending", terminals: { "closed:codex": true } }] }),
    operation({ phase: "running", step: "prepare:alpha", projects: [{ id: "alpha", phase: "prepared", terminals: {}, commitSent: true }] })].map(cancellableWait)).toEqual([false, false, false, false]);
  let state = waiting, runner: number | undefined = 4242;
  const stops: string[] = [];
  const s = screen(["c"], () => { state = operation({ phase: "cancelled", step: "cancelled" }); });
  expect(await operationScreen(host({ read: () => state, runner: () => runner, stopRunner: async (id) => { stops.push(id); runner = undefined; return true; } }), s.io, ID)).toBe("ended");
  expect(stops).toEqual([ID]);
  expect(s.ran).toEqual([[MAIN, "recovery", "abort", ID]]);
  expect(s.out).toContain("  [w] follow its progress");
  // A runner that does not stop keeps its operation: nothing is aborted under it.
  const stuck = screen(["c", "q"]);
  await operationScreen(host({ read: () => waiting, runner: () => 4242, stopRunner: async () => false }), stuck.io, ID);
  expect(stuck.ran).toEqual([]);
  expect(stuck.out).toContain("the runner could not be stopped; nothing was cancelled");
  // Past the wait, only following is offered.
  const busy = screen(["c", "q"]);
  await operationScreen(host({ read: () => operation({ phase: "running", step: "restore:alpha" }), runner: () => 4242 }), busy.io, ID);
  expect(busy.ran).toEqual([]);
  expect(operationLines(operation({ phase: "running", step: "restore:alpha", updatedAt: 1000 }), 4242, 4000)[1]).toBe('  running at "alpha: restoring Codex and Pi sessions", updated 3s ago; runner 4242 is working');
});

test("end asks first and records a reason, and a reset shows its dry run before it is applied", async () => {
  let state = operation(), locked = true;
  const s = screen(["x", "y", "", "r", "y"], (argv) => { if (argv.includes("--stop-and-archive")) { state = operation({ phase: "cancelled", step: "disposed", disposition: { choice: "stop-and-archive", at: 1, projects: {} } }); locked = false; } });
  expect(await operationScreen(host({ read: () => state, lock: () => locked ? ID : undefined }), s.io, ID)).toBe("ended");
  expect(s.ran).toEqual([
    [MAIN, "recovery", "dispose", ID, "--stop-and-archive", "--reason", "ended from the upgrade screen"],
    [MAIN, "--project", "/alpha", "reset"],
    [MAIN, "--project", "/alpha", "reset", "--yes"],
  ]);
  expect(s.out.at(-1)).toBe(`operation ${ID} is ended (abandoned, not completed); the recovery lock is free`);
  // Declining the confirmation, a refused dry run and a held lock each stop before anything is reset.
  const declined = screen(["e", "n", "q"]);
  await operationScreen(host(), declined.io, ID);
  expect(declined.ran).toEqual([]);
  const refused = screen(["a"], () => 1);
  await resetFlow(host(), refused.io, [project]);
  expect(refused.ran).toEqual([[MAIN, "--project", "/alpha", "reset", "--all"]]);
  const held = screen(["r", "y"]);
  await resetFlow(host({ lock: () => ID }), held.io, [project]);
  expect(held.ran).toEqual([]);
  expect(held.out).toEqual(["an operation holds the recovery lock; cancel or end it before a reset"]);
  const chosen = screen(["2", "r", "n"]);
  await resetFlow(host(), chosen.io, [project, { ...project, id: "beta", root: "/beta" }]);
  expect(chosen.ran).toEqual([[MAIN, "--project", "/beta", "reset"]]);
  expect(chosen.out.at(-1)).toBe("nothing was reset");
});

test("a held lock opens the operation's screen before any plan is made", async () => {
  let plans = 0, state = operation(), locked = true;
  const s = screen(["c", "n"], () => { state = operation({ phase: "cancelled", step: "cancelled" }); locked = false; });
  await planScreen(host({ plan: async () => { plans++; return plan(); }, read: () => state, lock: () => locked ? ID : undefined }), s.io);
  expect(plans).toBe(0);
  expect(s.asked).toEqual(["> ", "Plan again? [y/N] "]);
});
