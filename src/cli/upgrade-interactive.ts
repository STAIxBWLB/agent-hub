import { recoveryArgv } from "../hub/recovery-store.ts";
import { cancellableWait, nextChoices, publicOperation, type Inspection, type PlannedProject, type RecoveryOperation, type RecoveryPeer, type UpgradePlan } from "./upgrade.ts";

/**
 * #272: the interactive screens of `ahub upgrade`, `ahub restart` and bare `ahub recovery`. They add no way to change
 * an operation: every action is an existing command (`recovery resume|abort|dispose`, `reset`) run for the person
 * through `io.run`, so each command's own refusals decide. The one thing a screen does itself is stop a runner that
 * only waits, and only one whose claim is verified (`runnerStoppable`).
 */

/** The terminal a screen talks to; tests script it. */
export interface ScreenIO {
  /** One trimmed line from the person; null when the input ended or they pressed Ctrl+C, which no prompt takes for text. */
  ask(question: string): Promise<string | null>;
  out(line: string): void;
  /** Run an ahub entry with the terminal attached (argv after `bun`); resolves with its exit code. */
  run(argv: string[]): Promise<number>;
  sleep(ms: number): Promise<void>;
  /** True from the person's Ctrl+C on: the screens leave, and nothing is stopped. */
  interrupted(): boolean;
  /** True once when a line was entered while nothing was asked (during a follow); that line is dropped. */
  typed(): boolean;
}

/** What the screens read and start. */
export interface UpgradeHost {
  plan(): Promise<UpgradePlan>;
  /** Check the reviewed plan again and start it as a detached operation; `interrupted` is asked last, before anything is created. */
  apply(plan: UpgradePlan, interrupted: () => boolean): Promise<RecoveryOperation>;
  /** End one attached agent now: close a TUI agent's terminal, or ask the hub to stop a headless one. One line of outcome. */
  endPeer(planned: PlannedProject, peer: RecoveryPeer): Promise<string>;
  /** The operation that holds the machine's recovery lock. */
  lock(): string | undefined;
  read(id: string): RecoveryOperation;
  runner(id: string): number | "unknown" | undefined;
  live(op: RecoveryOperation): Promise<Record<string, Inspection | undefined>>;
  /** Whether the runner's claim carries a process signature that still matches: the only kind a screen may stop. */
  runnerStoppable(id: string): boolean;
  /** Stop that verified runner and wait until it is gone; false when one still holds the operation. */
  stopRunner(id: string): Promise<boolean>;
  /** This release's CLI entry, for `reset`. */
  entry: string;
  /** This CLI's version. */
  version: string;
}

const yes = async (io: ScreenIO, question: string): Promise<boolean> => /^y(es)?$/i.test((await io.ask(question)) ?? "");
/** The way back after Ctrl+C: the operation's own coordinator, since the installed `ahub` may still be the older release (#215). */
const left = (op: { id: string; sourceRoot?: string }): string => `left: the runner keeps working; \`bun ${recoveryArgv(op, "status")[0]} recovery\` shows the operation and what can be done`;

/**
 * How an attached peer runs, which decides how it can be ended: a TUI agent in a terminal the plan could bind, a
 * headless agent the hub owns, or `unmanaged` (shown as `own`): a session the hub did not launch, or one it launched
 * whose terminal the plan could not bind (a person ends that one where it runs).
 */
export function peerKind(planned: PlannedProject, peer: RecoveryPeer): "tui" | "headless" | "unmanaged" | "offline" {
  if (peer.state === "offline") return "offline";
  if ((planned.terminals as { peer: string }[]).some((t) => t.peer === peer.id)) return "tui";
  if (peer.id === "claude" || peer.id === "codex" || (peer.id === "pi" && peer.args?.mode === "tui")) return "unmanaged";
  return "headless";
}

const STEPS: Record<string, string> = {
  stage: "staging the release", prepare: "holding deliveries and waiting until the hub is quiet", reprepare: "preparing the source again after an expired hold",
  commit: "closing terminals and stopping the old hub", restart: "restarting a target that stopped", start: "starting the new hub", restore: "restoring Codex and Pi sessions",
  "install-plugin": "installing the Claude plugin", "restore-claude": "restoring the Claude session and verifying the hub", release: "releasing held deliveries",
  "refresh-manager": "refreshing the dashboard manager", "install-global": "installing the global CLI", completed: "completed", cancelled: "cancelled",
};

/** A receipt step (`commit:<project>`) in a person's words; a step this release does not know is shown as it is. */
export function stepLabel(step: string): string {
  const at = step.indexOf(":"), name = at < 0 ? step : step.slice(0, at);
  return STEPS[name] ? `${at < 0 ? "" : `${step.slice(at + 1)}: `}${STEPS[name]}` : step;
}

function peerAction(planned: PlannedProject, peer: RecoveryPeer): string {
  if (peer.state === "offline") return "offline, left as it is";
  if (planned.reconnectOnly?.includes(peer.id)) return "reconnects by itself (unmanaged session; its terminal is left alone)";
  if (planned.freshStart?.includes(peer.id)) return "restarts as a new session (no turn to lose)";
  const terminal = (planned.terminals as { peer: string; handle: string }[]).find((t) => t.peer === peer.id);
  if (terminal) return `resumes its session in a new terminal (replaces ${terminal.handle})`;
  return peer.id === "pi" ? "restarts headless on its recorded session" : "restarts headless as a new session";
}

const KINDS = { tui: "TUI", headless: "headless", unmanaged: "own", offline: "-" } as const;

/** What the source says keeps it from being quiet; an older hub names only its busy peers. */
const inProgress = (source: Inspection): string[] => source.recovery?.waiting ?? source.peers.filter((p) => p.state === "busy").map((p) => `${p.id} is busy`);

export function planLines(plan: UpgradePlan, current: string): string[] {
  const lines = [plan.kind === "upgrade" ? `upgrade to ${plan.version} (coordinator ${current})` : `restart on ${plan.version}`];
  for (const p of plan.projects) {
    lines.push("", `${p.project.id}  ${p.project.root}  hub ${p.source.version ?? "unknown"} (${p.source.state})`);
    const width = Math.max(0, ...p.source.peers.map((peer) => peer.id.length));
    for (const peer of p.source.peers) lines.push(`  ${peer.id.padEnd(width)}  ${peer.state.padEnd(7)}  ${KINDS[peerKind(p, peer)].padEnd(8)}  ${peerAction(p, peer)}`);
    const waiting = inProgress(p.source);
    if (waiting.length) lines.push(`  in progress: ${waiting.join(", ")} (apply waits up to 10 minutes for it, then leaves this hub running)`);
    for (const blocker of p.blockers) lines.push(`  blocker: ${blocker}`);
  }
  if (plan.blockers.length) lines.push("");
  for (const blocker of plan.blockers) lines.push(`blocker: ${blocker}`);
  return lines;
}

const ago = (ms: number): string => ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;

export function operationLines(op: RecoveryOperation, runner: number | "unknown" | undefined, now: number): string[] {
  const held = runner === "unknown" ? "; whether a runner holds it cannot be read" : runner ? `; runner ${runner} is working` : op.phase === "running" ? "; no runner holds it (the last one stopped mid-step)" : "";
  const lines = [`${op.plan.kind} to ${op.plan.version}: operation ${op.id}`, `  ${op.phase} at "${stepLabel(op.step)}", updated ${ago(now - op.updatedAt)} ago${held}`];
  for (const p of op.projects) {
    const effects = Object.entries(p.terminals).map(([key, value]) => value === "pending" || value === "failed" ? `${key} ${value}` : key);
    lines.push(`  ${p.id}  ${p.phase}${effects.length ? `  (${effects.join(", ")})` : ""}${p.restarts?.length ? `  restarts ${p.restarts.length}` : ""}`);
  }
  // The error ends with the commands status would print; the menu below offers them instead.
  if (op.error) lines.push(`  error: ${op.error.split("; next actions: ")[0]}`);
  return lines;
}

/**
 * Print steps and readiness waits until the operation completes, blocks or loses its runner ("open"), the person
 * enters a line (also "open": the menu), or presses Ctrl+C ("left"). `scheduled` is the receipt's `updatedAt` from
 * before a runner was scheduled (resume, a fresh session): until that runner writes, the receipt still shows the state
 * it was scheduled from, which is not the outcome.
 */
export async function follow(host: UpgradeHost, io: ScreenIO, id: string, scheduled?: number): Promise<"completed" | "open" | "left"> {
  let step = "", waiting = "", unowned = 0, tick = 0;
  for (;; tick++) {
    const op = host.read(id);
    if (io.interrupted()) { io.out(left(op)); return "left"; }
    if (io.typed()) return "open";
    const unwritten = scheduled !== undefined && op.updatedAt === scheduled;
    if (!unwritten) {
      scheduled = undefined;
      if (op.step !== step) { step = op.step; waiting = ""; tick = 0; io.out(`  ${stepLabel(step)}`); }
      if (op.phase === "completed") return "completed";
      if (op.phase === "cancelled" || op.phase === "blocked") return "open";
    }
    // A runner claims and writes a moment after it is spawned: only 5 s without either reads as gone.
    unowned = host.runner(id) === undefined || unwritten ? unowned + 1 : 0;
    if (unowned > 20) return "open";
    if (!unwritten && /^(re)?prepare:/.test(step) && tick % 8 === 0) {
      const live = await host.live(op).catch(() => ({} as Record<string, Inspection | undefined>));
      // A hub that is not ready and names no cause (one older than #272 lists only busy peers and approvals) still waits.
      const held = Object.values(live).some((i) => i?.recovery?.operationId === id && i.recovery.ready === false);
      const now = [...new Set(Object.values(live).flatMap((i) => i?.recovery?.waiting ?? []))].join(", ") || (held ? "the hub is not quiet yet (it names no cause: a completion check, a task command or a Pi call may be in flight)" : "");
      if (now && now !== waiting) io.out(`    waiting for: ${now}`);
      waiting = now;
    }
    await io.sleep(250);
  }
}

/**
 * End attached agents before the upgrade, by kind or by name: an ended agent is offline in the next plan, so it is
 * neither waited for nor restored. True when at least one was asked to end.
 */
export async function endAgents(host: UpgradeHost, io: ScreenIO, endable: { planned: PlannedProject; peer: RecoveryPeer }[]): Promise<boolean> {
  type Agent = (typeof endable)[number];
  // An upgrade plans every running project and each has its own claude or codex: with several, a name carries its project.
  const several = new Set(endable.map((e) => e.planned.project.id)).size > 1;
  const full = (e: Agent) => `${e.planned.project.id}/${e.peer.id}`, label = (e: Agent) => several ? full(e) : e.peer.id;
  const of = (kind: string) => endable.filter((e) => peerKind(e.planned, e.peer) === kind);
  const tui = of("tui"), headless = of("headless");
  const choices = [...(tui.length ? [`[t] the TUI agents (${tui.map(label).join(", ")})`] : []), ...(headless.length ? [`[h] the headless agents (${headless.map(label).join(", ")})`] : []), "or names separated by spaces", "[Enter] none"];
  const words = new Set(((await io.ask(`End which agents? ${choices.join("  ")}: `)) ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const picked = new Set<Agent>(), unknown: string[] = [], ambiguous: string[] = [];
  for (const word of words) {
    const named = word === "t" ? tui : word === "h" ? headless : endable.filter((e) => word === full(e) || word === e.peer.id);
    if (word === "t" || word === "h" || named.length === 1) for (const e of named) picked.add(e);
    else (named.length ? ambiguous : unknown).push(word);
  }
  if (unknown.length) io.out(`not an agent that can be ended here: ${unknown.join(", ")}`);
  if (ambiguous.length) io.out(`${ambiguous.join(", ")}: attached in several projects; name the one to end with its project (${endable.filter((e) => ambiguous.includes(e.peer.id)).map(full).join(", ")})`);
  const chosen = endable.filter((e) => picked.has(e));
  if (!chosen.length) { io.out("no agent was ended"); return false; }
  if (!(await yes(io, `End ${chosen.map(label).join(", ")} now? A TUI agent's terminal is closed, a turn in progress is cut, and none of them is restored by the upgrade. [y/N] `))) { io.out("no agent was ended"); return false; }
  let asked = 0;
  for (const e of chosen) {
    if (io.interrupted()) { io.out(`interrupted: ${chosen.length - asked} of ${chosen.length} left alone (${chosen.slice(asked).map(label).join(", ")})`); break; }
    io.out(`  ${await host.endPeer(e.planned, e.peer)}`);
    asked++;
  }
  return asked > 0;
}

/** `ahub reset` for one project: the scope, its dry run, a confirmation, then the reset itself. */
export async function resetFlow(host: UpgradeHost, io: ScreenIO, projects: { id: string; root: string }[]): Promise<void> {
  if (host.lock()) return io.out("an operation holds the recovery lock; cancel or end it before a reset");
  let project = projects[0];
  if (projects.length > 1) {
    projects.forEach((p, i) => io.out(`  ${i + 1}  ${p.id}  ${p.root}`));
    project = projects[Number(await io.ask("Reset which project? [number, Enter: none] ")) - 1];
  }
  if (!project) return io.out("nothing was reset");
  const scope = ((await io.ask("[r] runtime reset (deliveries, holds, pauses, session pointers)  [a] full reset (archive the state directory)  [Enter] none: ")) ?? "").toLowerCase();
  if (scope !== "r" && scope !== "a") return io.out("nothing was reset");
  const reset = [host.entry, "--project", project.root, "reset", ...(scope === "a" ? ["--all"] : [])];
  if ((await io.run(reset)) !== 0) return; // the dry run: it lists and changes nothing
  if (!(await yes(io, `Apply this reset of ${project.id}? [y/N] `))) return io.out("nothing was reset");
  await io.run([...reset, "--yes"]);
}

/** One open operation: what it did, and the choices `status` would name, run on the spot. */
export async function operationScreen(host: UpgradeHost, io: ScreenIO, id: string): Promise<"completed" | "ended" | "quit"> {
  for (let acted = false, reset = false; ;) {
    if (io.interrupted()) return "quit";
    const op = host.read(id), runner = host.runner(id);
    if (op.phase === "completed") { io.out(`${op.plan.kind} to ${op.plan.version} completed`); return "completed"; }
    if (op.phase === "cancelled") {
      io.out(`operation ${id} is ${op.disposition ? "ended (abandoned, not completed)" : "cancelled"}; the recovery lock is free`);
      // Ended from this screen: the reset the person may have come for is one key away.
      if (acted && !reset && await yes(io, "Reset a project's hub now? [y/N] ")) await resetFlow(host, io, op.plan.projects.map((p) => p.project));
      return "ended";
    }
    const live = runner ? {} : await host.live(op);
    io.out("");
    for (const line of operationLines(op, runner, Date.now())) io.out(line);
    const run = async (action: "resume" | "abort" | "dispose", flags: string[] = []) => { acted = true; return (await io.run(recoveryArgv(op, action, flags))) === 0; };
    // A runner scheduled by a command has not written yet: follow from the receipt as that command left it (resume
    // writes nothing, a fresh-session choice records itself first).
    const followed = async (): Promise<boolean> => (await follow(host, io, id, host.read(id).updatedAt)) === "left";
    const end = async (): Promise<boolean> => {
      if (!(await yes(io, "End this operation? Its own targets are stopped and the upgrade is abandoned, not completed. [y/N] "))) return false;
      const reason = await io.ask("Reason for the audit [Enter: ended from the upgrade screen]: ");
      if (reason === null) return false; // Ctrl+C or the end of input is never a reason
      return run("dispose", ["--stop-and-archive", "--reason", reason.slice(0, 500) || "ended from the upgrade screen"]);
    };
    // An act returns true when the person left (Ctrl+C in a follow).
    const menu = new Map<string, { label: string; act: () => Promise<boolean | void> }>();
    if (typeof runner === "number") {
      menu.set("w", { label: "follow its progress", act: async () => (await follow(host, io, id)) === "left" });
      if (cancellableWait(op) && host.runnerStoppable(id)) menu.set("c", { label: "cancel: stop the waiting runner and cancel (nothing was closed or stopped)", act: async () => {
        // Decided again on the receipt as it is now: the runner may have moved on while the menu was read.
        if (!cancellableWait(host.read(id)) || !host.runnerStoppable(id)) return io.out("the runner moved on; nothing was stopped or cancelled");
        if (await host.stopRunner(id)) await run("abort");
        else io.out("the runner could not be stopped; nothing was cancelled");
      } });
      else if (cancellableWait(op)) io.out("  cancel is not offered: this runner's claim cannot be verified (an older coordinator's, or unreadable); a live runner gives up its wait after 10 minutes");
    }
    for (const choice of nextChoices(op, runner, live)) {
      if (choice.kind === "wait") { if (typeof runner !== "number") io.out(`  ${choice.text}`); }
      else if (choice.kind === "resume") menu.set("r", { label: `resume${op.error ? " (after the step the error names)" : ""}`, act: async () => (await run("resume")) && followed() });
      else if (choice.kind === "abort") menu.set("c", { label: "cancel (no runtime was stopped; nothing to roll back)", act: async () => { await run("abort"); } });
      else if (choice.kind === "fresh") menu.set(menu.has("f") ? `f-${choice.peer}` : "f", { label: `start ${choice.peer} as a new session (its conversation is recorded as lost)`, act: async () => {
        const reason = await io.ask(`Reason for losing ${choice.peer}'s conversation [Enter: go back]: `);
        return !!reason && (await run("dispose", ["--fresh-session", choice.peer!, "--reason", reason.slice(0, 500)])) && followed();
      } });
      else {
        menu.set("e", { label: "end: stop and archive (the upgrade is abandoned, not completed)", act: async () => { await end(); } });
        menu.set("x", { label: "end, then reset a project's hub", act: async () => { if (await end()) { reset = true; await resetFlow(host, io, op.plan.projects.map((p) => p.project)); } } });
      }
    }
    menu.set("s", { label: "refresh", act: async () => {} });
    menu.set("j", { label: "receipt as JSON", act: async () => io.out(JSON.stringify(publicOperation(op, runner, live), null, 2)) });
    for (const [key, item] of menu) io.out(`  [${key}] ${item.label}`);
    io.out("  [q] quit (the operation stays as it is)");
    const answer = await io.ask("> ");
    if (answer === null || answer.toLowerCase() === "q") return "quit";
    if ((await menu.get(answer.toLowerCase())?.act()) === true) return "quit";
  }
}

/** The plan, reviewed with the person: apply and follow, or an open operation's screen first. */
export async function planScreen(host: UpgradeHost, io: ScreenIO): Promise<void> {
  for (let touched = false; ;) {
    if (io.interrupted()) return;
    const owner = host.lock();
    if (owner) {
      if ((await operationScreen(host, io, owner)) !== "ended") return;
      if (!(await yes(io, "Plan again? [y/N] "))) return;
      continue;
    }
    const plan = await host.plan();
    if (io.interrupted()) return;
    io.out("");
    for (const line of planLines(plan, host.version)) io.out(line);
    const blocked = plan.blockers.length > 0 || plan.projects.some((p) => p.blockers.length > 0);
    if (!plan.projects.length) io.out(plan.kind === "upgrade" ? `no hub is running, so nothing is carried over: install with \`bun add -g @staix/agent-hub@${plan.version}\`, then \`ahub setup\`` : "this project's hub is not running: `ahub up` starts it");
    const endable = plan.projects.flatMap((p) => p.source.peers.filter((peer) => ["tui", "headless"].includes(peerKind(p, peer))).map((peer) => ({ planned: p, peer })));
    const keys = [...(blocked ? [] : ["[a] apply"]), "[r] refresh", ...(endable.length ? ["[k] end agents"] : []), "[j] plan as JSON", ...(plan.projects.length ? ["[x] reset a project's hub"] : []), "[q] quit"];
    const answer = (await io.ask(`${blocked ? "Blocked: take the next action each blocker names, then refresh.\n" : ""}${keys.join("  ")}: `))?.toLowerCase() ?? "q";
    if (answer === "q") return touched ? undefined : io.out("nothing was changed");
    if (answer === "j") io.out(JSON.stringify(plan, null, 2));
    else if (answer === "x" && plan.projects.length) { touched = true; await resetFlow(host, io, plan.projects.map((p) => p.project)); }
    else if (answer === "k" && endable.length) touched = (await endAgents(host, io, endable)) || touched;
    else if (answer === "a" && !blocked) {
      touched = true;
      let op: RecoveryOperation;
      try { op = await host.apply(plan, () => io.interrupted()); } catch (error) { io.out(`ahub: ${(error as Error).message}`); continue; }
      io.out(`operation ${op.id} started; Enter opens its menu, Ctrl+C leaves, and neither stops the ${plan.kind}`);
      const end = await follow(host, io, op.id);
      if (end === "completed") return io.out(`${plan.kind} to ${plan.version} completed`);
      if (end === "left") return;
      // Blocked, cancelled or left to its runner: the lock check above opens its screen, or plans again once it is free.
    }
  }
}
