import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRelease, newerVersion } from "../src/cli/recovery-package.ts";
import { endAgents, follow, operationLines, operationScreen, peerKind, planLines, planScreen, resetFlow, stepLabel, type ScreenIO, type UpgradeHost } from "../src/cli/upgrade-interactive.ts";
import { PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";
import { cancellableWait, nextChoices, type Inspection, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { operationPath, recoveryRunner, signedRunner, stopSignedRunner, writeOperation } from "../src/hub/recovery-store.ts";

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
    ask: async (question) => { asked.push(question); return answers.shift() ?? null; }, // out of answers: the input ended
    out: (line) => { out.push(line); },
    run: async (argv) => { ran.push(argv); return onRun(argv) ?? 0; },
    sleep: async () => {},
    interrupted: () => false,
    typed: () => false,
  };
  return { io, out, ran, asked };
}
function host(over: Partial<UpgradeHost> = {}): UpgradeHost {
  return { plan: async () => plan(), apply: async () => operation(), lock: () => undefined, read: () => operation(), runner: () => undefined,
    live: async () => ({ alpha: source() }), endPeer: async (_planned, peer) => `${peer.id}: ended`, runnerStoppable: () => true, stopRunner: async () => true, entry: MAIN, version: "0.6.0", ...over };
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
    "  claude  idle     own       reconnects by itself (unmanaged session; its terminal is left alone)",
    "  codex   busy     TUI       resumes its session in a new terminal (replaces term_codex)",
    "  kimi    idle     headless  restarts headless as a new session",
    "  pi      offline  -         offline, left as it is",
    "  in progress: codex is busy (apply waits up to 10 minutes for it, then leaves this hub running)",
  ]);
  // The running hub's own readiness blockers, when it reports them, and the plan's blockers at both levels.
  const blocked = planLines(plan({ source: source({ recovery: { waiting: ["codex is busy", "pending approvals"] } }), blockers: ["codex: original conversation ID is unknown"], freshStart: ["kimi"] }, ["shared Claude plugin installer is unavailable"]), "0.6.0");
  expect(blocked).toContain("  in progress: codex is busy, pending approvals (apply waits up to 10 minutes for it, then leaves this hub running)");
  expect(blocked).toContain("  blocker: codex: original conversation ID is unknown");
  expect(blocked).toContain("  kimi    idle     headless  restarts as a new session (no turn to lose)");
  expect(blocked.at(-1)).toBe("blocker: shared Claude plugin installer is unavailable");
  expect([stepLabel("commit:alpha"), stepLabel("install-global"), stepLabel("disposed: stop-and-archive (abandoned, not completed)")]).toEqual(["alpha: closing terminals and stopping the old hub", "installing the global CLI", "disposed: stop-and-archive (abandoned, not completed)"]);
});

test("apply is offered only without blockers, and an applied plan is followed to its end", async () => {
  const blocked = screen(["a", "q"]);
  let applied = 0;
  await planScreen(host({ plan: async () => plan({ blockers: ["claude: unmanaged session cannot reconnect"] }), apply: async () => { applied++; return operation(); } }), blocked.io);
  expect(applied).toBe(0);
  expect(blocked.asked[0]).toStartWith("Blocked: take the next action each blocker names, then refresh.\n[r] refresh  [k] end agents");
  expect(blocked.out.at(-1)).toBe("nothing was changed");

  const steps: Partial<RecoveryOperation>[] = [{ phase: "running", step: "stage" }, { phase: "running", step: "prepare:alpha" }, { phase: "running", step: "prepare:alpha" }, { phase: "running", step: "commit:alpha" }, { phase: "completed", step: "completed" }];
  const ok = screen(["a"]);
  await planScreen(host({ read: () => operation(steps.length > 1 ? steps.shift() : steps[0]), runner: () => 4242, live: async () => ({ alpha: source({ recovery: { waiting: ["codex is busy"] } }) }) }), ok.io);
  expect(ok.asked[0]).toBe("[a] apply  [r] refresh  [k] end agents  [j] plan as JSON  [x] reset a project's hub  [q] quit: ");
  const started = `operation ${ID} started; Enter opens its menu, Ctrl+C leaves, and neither stops the upgrade`;
  expect(ok.out.slice(ok.out.indexOf(started))).toEqual([
    started,
    "  staging the release", "  alpha: holding deliveries and waiting until the hub is quiet", "    waiting for: codex is busy",
    "  alpha: closing terminals and stopping the old hub", "  completed", "upgrade to 0.6.0 completed",
  ]);
  expect(ok.ran).toEqual([]);
});

test("Ctrl+C leaves, Enter opens the menu, a lost runner ends the follow, and none of them touches the operation", async () => {
  // The way back names the operation's own coordinator: the installed ahub may still be the older release.
  const left = `left: the runner keeps working; \`bun ${MAIN} recovery\` shows the operation and what can be done`;
  const interrupted = screen([]);
  let reads = 0;
  interrupted.io.interrupted = () => reads++ > 0;
  expect(await follow(host({ read: () => operation({ phase: "running", step: "start:alpha" }), runner: () => 4242 }), interrupted.io, ID)).toBe("left");
  expect(interrupted.out).toEqual(["  alpha: starting the new hub", left]);
  // From the plan screen the same Ctrl+C ends the session: no screen is drawn on a terminal that may be gone.
  const applied = screen(["a"]);
  let pressed = false;
  applied.io.interrupted = () => pressed;
  let held = false;
  await planScreen(host({ apply: async () => { held = true; return operation(); }, read: () => { pressed = true; return operation({ phase: "running", step: "stage" }); }, runner: () => 4242, lock: () => held ? ID : undefined }), applied.io);
  expect(applied.out.at(-1)).toBe(left);
  expect(applied.asked).toHaveLength(1);
  // A line entered while following opens the operation's menu; the runner works on.
  const entered = screen(["a", "q"]);
  let lines = 0;
  entered.io.typed = () => lines++ === 2;
  let locked = false;
  await planScreen(host({ apply: async () => { locked = true; return operation(); }, read: () => operation({ phase: "running", step: "prepare:alpha" }), runner: () => 4242, lock: () => locked ? ID : undefined }), entered.io);
  expect(entered.asked).toEqual(["[a] apply  [r] refresh  [k] end agents  [j] plan as JSON  [x] reset a project's hub  [q] quit: ", "> "]);
  expect(entered.out).toContain("  [w] follow its progress");
  const lost = screen([]);
  expect(await follow(host({ read: () => operation({ phase: "running", step: "restore:alpha" }) }), lost.io, ID)).toBe("open");
  // A Ctrl+C while the plan is checked again starts nothing, and an interrupted screen is not drawn once more.
  const regret = screen(["a"]);
  let stop = false, created = 0;
  regret.io.interrupted = () => stop;
  await planScreen(host({ apply: async (_plan, interrupted) => { stop = true; if (interrupted()) throw new Error("interrupted; nothing was started"); created++; return operation(); } }), regret.io);
  expect(created).toBe(0);
  expect(regret.out.at(-1)).toBe("ahub: interrupted; nothing was started");
  const gone = screen(["e", "y"]);
  let asks = 0;
  gone.io.interrupted = () => asks >= 2;
  const ask = gone.io.ask;
  gone.io.ask = async (question) => { asks++; return asks >= 2 ? null : ask(question); };
  const drawn = () => gone.out.filter((line) => line.startsWith("upgrade to 0.6.0: operation")).length;
  expect(await operationScreen(host(), gone.io, ID)).toBe("quit");
  expect(drawn()).toBe(1);
  for (const s of [interrupted, applied, lost]) expect(s.ran).toEqual([]);
});

test("a resumed operation is followed from the receipt it was scheduled on, not taken for still blocked", async () => {
  // The real command only schedules a detached runner: the receipt stays blocked until that runner claims and writes.
  const blocked = operation({ updatedAt: 10, error: "alpha: source runtime left running; next actions: resume" });
  const after: RecoveryOperation[] = [blocked, blocked, blocked, operation({ phase: "running", step: "commit:alpha", updatedAt: 11 }), operation({ phase: "completed", step: "completed", updatedAt: 12 })];
  let scheduled = false, runner: number | undefined;
  const s = screen(["r"], () => { scheduled = true; });
  const read = () => { if (!scheduled) return blocked; if (after.length <= 3) runner = 4242; return after.length > 1 ? after.shift()! : after[0]!; };
  expect(await operationScreen(host({ read, runner: () => runner }), s.io, ID)).toBe("completed");
  expect(s.ran).toEqual([[MAIN, "recovery", "resume", ID]]);
  expect(s.out.slice(-3)).toEqual(["  alpha: closing terminals and stopping the old hub", "  completed", "upgrade to 0.6.0 completed"]);
  expect(s.asked).toEqual(["> "]); // the menu was not drawn a second time over the old error
  // A fresh-session choice records itself before it schedules the runner: the follow starts from that write, not from
  // the menu's receipt, so the still-blocked receipt is not taken for the outcome either.
  const failed = operation({ updatedAt: 20, targetRoot: PACKAGE_ROOT, error: "alpha: codex restoration failed; next actions: resume", plan: plan({ terminals: [{ peer: "codex", handle: "term_codex", sessionId: "t1" }] }),
    projects: [{ id: "alpha", phase: "started", commitSent: true, instanceId: "new", terminals: { "closed:codex": true, "restored:codex": "failed" } }] });
  const target = (): Inspection => ({ state: "running", instanceId: "new", version: "0.6.0", protocol: PROTOCOL, peers: [], blockers: [], recovery: { operationId: ID, phase: "restored", ready: true } });
  const chosen = { ...failed, updatedAt: 21, projects: [{ ...failed.projects[0]!, fresh: { codex: { lost: "t1", reason: "gone", at: 21 } } }] };
  const steps: RecoveryOperation[] = [chosen, chosen, { ...chosen, phase: "running", step: "restore:alpha", updatedAt: 22 }, operation({ phase: "completed", step: "completed", updatedAt: 23 })];
  let disposed = false;
  const fresh = screen(["f", "its rollout is gone"], () => { disposed = true; });
  expect(await operationScreen(host({ read: () => !disposed ? failed : steps.length > 1 ? steps.shift()! : steps[0]!, runner: () => disposed && steps.length <= 2 ? 4242 : undefined, live: async () => ({ alpha: target() }) }), fresh.io, ID)).toBe("completed");
  expect(fresh.ran).toEqual([[MAIN, "recovery", "dispose", ID, "--fresh-session", "codex", "--reason", "its rollout is gone"]]);
  expect(fresh.asked).toEqual(["> ", "Reason for losing codex's conversation [Enter: go back]: "]);
  expect(fresh.out).toContain("  [f] start codex as a new session (its conversation is recorded as lost)");
  // A runner that never writes (it refused the receipt) is waited for 5 s of ticks, then the screen shows what is there.
  const never = screen(["r", "q"]);
  await operationScreen(host({ read: () => blocked }), never.io, ID);
  expect(never.asked).toEqual(["> ", "> "]);
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
  const resume = screen(["r"], () => { resumed = operation({ phase: "completed", step: "completed", updatedAt: 1 }); });
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
  // The receipt is read again at the key press: a runner that moved on while the menu was read is not stopped.
  const moved = screen(["c"]);
  let drawn = false;
  const movedStops: string[] = [];
  await operationScreen(host({ runner: () => 4242, stopRunner: async (id) => { movedStops.push(id); return true; },
    read: () => { if (!drawn) { drawn = true; return waiting; } return operation({ phase: "running", step: "commit:alpha", projects: [{ id: "alpha", phase: "prepared", terminals: { "closed:codex": true }, commitSent: true }] }); } }), moved.io, ID);
  expect(movedStops).toEqual([]);
  expect(moved.ran).toEqual([]);
  expect(moved.out).toContain("the runner moved on; nothing was stopped or cancelled");
  // A claim without a matching process signature is never signalled: cancel is not on the menu.
  const unsigned = screen(["c", "q"]);
  await operationScreen(host({ read: () => waiting, runner: () => 4242, runnerStoppable: () => false, stopRunner: async (id) => { movedStops.push(id); return true; } }), unsigned.io, ID);
  expect(movedStops).toEqual([]);
  expect(unsigned.out.some((line) => line.startsWith("  [c]"))).toBe(false);
  expect(unsigned.out).toContain("  cancel is not offered: this runner's claim cannot be verified (an older coordinator's, or unreadable); a live runner gives up its wait after 10 minutes");
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
  // Ctrl+C or the end of input at the reason prompt is not a reason: nothing is ended, for end and for a fresh session.
  const noReason = screen(["e", "y"]);
  await operationScreen(host(), noReason.io, ID);
  expect(noReason.asked.at(-2)).toBe("Reason for the audit [Enter: ended from the upgrade screen]: ");
  expect(noReason.ran).toEqual([]);
  // A cancel from the screen offers the reset next; declining it changes nothing more.
  let cancelled = operation(), free = false;
  const then = screen(["c", "y", "r", "y"], (argv) => { if (argv.includes("abort")) { cancelled = operation({ phase: "cancelled", step: "cancelled" }); free = true; } });
  expect(await operationScreen(host({ read: () => cancelled, lock: () => free ? undefined : ID }), then.io, ID)).toBe("ended");
  expect(then.asked).toContain("Reset a project's hub now? [y/N] ");
  expect(then.ran).toEqual([[MAIN, "recovery", "abort", ID], [MAIN, "--project", "/alpha", "reset"], [MAIN, "--project", "/alpha", "reset", "--yes"]]);
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
  expect(s.asked).toEqual(["> ", "Reset a project's hub now? [y/N] ", "Plan again? [y/N] "]);
});

test("only a runner whose claim carries a matching process signature is stopped", async () => {
  const home = mkdtempSync(join(tmpdir(), "ahub-signed-runner-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    // A real claim by another process, as a runner makes it: signed with that process's own signature.
    const signed = "00000000-0000-4000-8000-0000000002a1";
    writeOperation(signed, {}, home);
    const claimer = join(home, "claim.ts");
    writeFileSync(claimer, `import { claimRunner } from ${JSON.stringify(join(PACKAGE_ROOT, "src/hub/recovery-store.ts"))};\nclaimRunner(${JSON.stringify(signed)}, ${JSON.stringify(home)});\nconsole.log("claimed");\nsetInterval(() => {}, 1000);\n`);
    const runner = Bun.spawn([process.execPath, claimer], { stdout: "pipe", stderr: "ignore" });
    children.push(runner);
    const reader = runner.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("claimed");
    expect(recoveryRunner(signed, home)).toBe(runner.pid);
    expect(signedRunner(signed, home)).toBe(runner.pid);
    expect(await stopSignedRunner(signed, home)).toBe(true);
    await runner.exited;
    expect(recoveryRunner(signed, home)).toBeUndefined();

    // A claim from before signatures (0.12.20 or older): its pid may be anyone's by now. It is waited for, never signalled.
    const unsigned = "00000000-0000-4000-8000-0000000002a2";
    writeOperation(unsigned, {}, home);
    const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    children.push(bystander);
    const db = new Database(`${operationPath(unsigned, home)}.runner.db`, { create: true });
    db.run("CREATE TABLE runner (slot INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL)");
    db.query("INSERT INTO runner (slot, pid, nonce) VALUES (1, ?, 'old')").run(bystander.pid);
    db.close();
    expect(recoveryRunner(unsigned, home)).toBe(bystander.pid);
    expect(signedRunner(unsigned, home)).toBeUndefined();
    expect(await stopSignedRunner(unsigned, home, 300)).toBe(false);
    expect(alive(bystander.pid)).toBe(true);
    // No claim at all: nothing holds the operation, so there is nothing to stop.
    const free = "00000000-0000-4000-8000-0000000002a3";
    writeOperation(free, {}, home);
    expect([signedRunner(free, home), await stopSignedRunner(free, home)]).toEqual([undefined, true]);
  } finally {
    for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("agents are ended by kind or by name, only after a confirmation, and only the ones that can be", async () => {
  const planned = plan({ source: source({ peers: [{ id: "claude", state: "busy", sessionId: "s1" }, { id: "codex", state: "idle", threadId: "t1" }, { id: "kimi", state: "busy" }, { id: "pi", state: "idle", args: { mode: "headless" } }, { id: "local", state: "offline" }] }),
    terminals: [{ peer: "claude", handle: "term_claude" }, { peer: "codex", handle: "term_codex" }], reconnectOnly: [] }).projects[0]!;
  expect(planned.source.peers.map((peer) => peerKind(planned, peer))).toEqual(["tui", "tui", "headless", "headless", "offline"]);
  // A Claude or Codex the plan could not bind to a terminal, and Pi in a terminal of its own, are not the hub's to end.
  const loose = { ...planned, terminals: [] };
  expect([{ id: "claude", state: "idle" }, { id: "codex", state: "idle" }, { id: "pi", state: "idle", args: { mode: "tui" } }, { id: "kimi", state: "idle" }].map((peer) => peerKind(loose, peer))).toEqual(["unmanaged", "unmanaged", "unmanaged", "headless"]);
  const endable = planned.source.peers.filter((peer) => peer.state !== "offline").map((peer) => ({ planned, peer }));
  const ended: string[] = [];
  const h = host({ endPeer: async (_p, peer) => { ended.push(peer.id); return `${peer.id}: ended`; } });
  const question = "End which agents? [t] the TUI agents (claude, codex)  [h] the headless agents (kimi, pi)  or names separated by spaces  [Enter] none: ";
  const tui = screen(["t", "y"]);
  expect(await endAgents(h, tui.io, endable)).toBe(true);
  expect(tui.asked).toEqual([question, "End claude, codex now? A TUI agent's terminal is closed, a turn in progress is cut, and none of them is restored by the upgrade. [y/N] "]);
  expect(tui.out).toEqual(["  claude: ended", "  codex: ended"]);
  expect(await endAgents(h, screen(["h", "y"]).io, endable)).toBe(true);
  expect(await endAgents(h, screen(["kimi codex", "y"]).io, endable)).toBe(true);
  expect(ended).toEqual(["claude", "codex", "kimi", "pi", "codex", "kimi"]);
  // Declined, nothing chosen, an interrupt, and a name that is not an endable agent: nobody is ended.
  ended.length = 0;
  for (const answers of [["t", "n"], [""], [], ["t"], ["local nobody"]]) expect(await endAgents(h, screen([...answers]).io, endable)).toBe(false);
  expect(ended).toEqual([]);
  const mixed = screen(["local kimi", "y"]);
  await endAgents(h, mixed.io, endable);
  expect(mixed.out).toEqual(["not an agent that can be ended here: local", "  kimi: ended"]);
  // Ctrl+C while the first one is being ended: the rest are left alone, and the screen says which.
  const stopped = screen(["t", "y"]);
  let pressed = false;
  stopped.io.interrupted = () => pressed;
  ended.length = 0;
  expect(await endAgents(host({ endPeer: async (_p, peer) => { ended.push(peer.id); pressed = true; return `${peer.id}: ended`; } }), stopped.io, endable)).toBe(true);
  expect(ended).toEqual(["claude"]);
  expect(stopped.out).toEqual(["  claude: ended", "interrupted: 1 of 2 left alone (codex)"]);
  // An upgrade plans every running project and a peer id is attached in each: with several, every agent carries its
  // project in the question, the confirmation and the outcome, and a bare name that two projects share selects none.
  const beta = plan({ project: { ...project, id: "beta", root: "/beta" }, source: source({ peers: [{ id: "claude", state: "idle", sessionId: "s2" }, { id: "kimi", state: "idle" }, { id: "local", state: "idle" }] }), terminals: [{ peer: "claude", handle: "term_beta" }], reconnectOnly: [] }).projects[0]!;
  const both = [...endable, ...beta.source.peers.map((peer) => ({ planned: beta, peer }))];
  const across: string[] = [];
  const two = host({ endPeer: async (p, peer) => { across.push(`${p.project.id}/${peer.id}`); return `${p.project.id}/${peer.id}: ended`; } });
  const kinds = screen(["t", "y"]);
  await endAgents(two, kinds.io, both);
  expect(kinds.asked).toEqual([
    "End which agents? [t] the TUI agents (alpha/claude, alpha/codex, beta/claude)  [h] the headless agents (alpha/kimi, alpha/pi, beta/kimi, beta/local)  or names separated by spaces  [Enter] none: ",
    "End alpha/claude, alpha/codex, beta/claude now? A TUI agent's terminal is closed, a turn in progress is cut, and none of them is restored by the upgrade. [y/N] ",
  ]);
  expect(kinds.out).toEqual(["  alpha/claude: ended", "  alpha/codex: ended", "  beta/claude: ended"]);
  across.length = 0;
  const bare = screen(["claude kimi", "y"]);
  expect(await endAgents(two, bare.io, both)).toBe(false);
  expect(bare.out).toEqual(["claude, kimi: attached in several projects; name the one to end with its project (alpha/claude, alpha/kimi, beta/claude, beta/kimi)", "no agent was ended"]);
  expect(bare.asked).toHaveLength(1);
  // `project/peer` is exactly that one; a bare name only one project has attached is that one too.
  const named = screen(["beta/claude local codex", "y"]);
  expect(await endAgents(two, named.io, both)).toBe(true);
  expect(named.asked[1]).toStartWith("End alpha/codex, beta/claude, beta/local now? ");
  expect(across).toEqual(["alpha/codex", "beta/claude", "beta/local"]);
  // From the plan screen: the ended agents are offline in the plan that follows.
  let gone = false;
  const flow = screen(["k", "t", "y", "q"]);
  await planScreen(host({ endPeer: async (_p, peer) => { gone = true; return `${peer.id}: terminal term_codex closed`; },
    plan: async () => gone ? plan({ source: source({ peers: [{ id: "codex", state: "offline" }, { id: "kimi", state: "idle" }] }), terminals: [], reconnectOnly: [] }) : plan({ reconnectOnly: [] }) }), flow.io);
  expect(flow.out).toContain("  codex: terminal term_codex closed");
  expect(flow.out).toContain("  codex  offline  -         offline, left as it is");
  expect(flow.out.at(-1)).not.toBe("nothing was changed");
});
