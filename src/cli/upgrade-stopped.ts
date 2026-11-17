import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readControl } from "../hub/control-client.ts";
import { RecoveryDeferredHubError } from "../hub/deferred-hub.ts";
import { inspectProject, type ProjectInspection } from "../hub/lifecycle.ts";
import { canonicalPath, hubHome } from "../hub/project.ts";
import { recordProjectRuntime } from "../hub/project-runtime.ts";
import { createProjectRuntimeAccess, projectRuntimeFile, type ProjectRuntimeIdentity, type ProjectRuntimeSelection } from "../hub/project-runtime-state.ts";
import { recoveryLock } from "../hub/recovery-store.ts";
import { Registry, type Project } from "../hub/registry.ts";
import { readRestartSnapshot, restartPath } from "../hub/restart.ts";
import { processLiveness } from "../pi/process-signature.ts";
import { exactVersion, newerVersion, registryRelease, runCommand, stageCurrentRuntime, stageRelease, verifyRecoveryTarget, type RunCommand } from "./recovery-package.ts";
import { registeredProjects } from "./upgrade.ts";

/**
 * #1540: `ahub upgrade` for a project whose hub is stopped. It rewrites that project's `runtime.json` to the target and nothing else: no daemon, no terminal, no peer and no recovery
 * operation. The write is `recordProjectRuntime`, the verified-write path every startup uses, under the registry's runtime-capture lock.
 */
export type StoppedOutcome = "retarget" | "current" | "running" | "refused";
export interface StoppedRow {
  project: Project;
  outcome: StoppedOutcome;
  /** What inspection read: only `stopped` and `missing` are this module's to plan alone; any other reading belongs to the ordinary recovery plan. */
  inspected: string;
  /** The recorded version, for `retarget` and `current`; absent when the project records no runtime yet. */
  from?: string;
  /** Identity of the recorded selection the plan read, so the apply refuses a record that changed meanwhile. */
  before?: string;
  cause?: string;
  next?: string;
  command?: string;
}
export interface StoppedPlan {
  schema: 1;
  kind: "upgrade";
  mode: "runtime-selection";
  scope: "project" | "all-stopped";
  version: string;
  integrity?: string;
  rows: StoppedRow[];
  blockers: string[];
  fingerprint: string;
}
export interface StoppedResult { id: string; root: string; outcome: "retargeted" | "failed"; from?: string; to: string; cause?: string }
export interface StoppedDeps {
  home?: string;
  inspect?: (project: Project) => Promise<ProjectInspection>;
  /** Stage and verify the target once; the default is the same staging a scoped recovery uses. */
  stage?: (version: string, integrity: string, run: RunCommand) => Promise<{ root: string; digest: string }>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
const selectionKey = (runtime: ProjectRuntimeIdentity | undefined): string => runtime
  ? JSON.stringify([runtime.version, runtime.root, runtime.digest, runtime.kind, runtime.instanceId]) : "none";
const fingerprintOf = (plan: Omit<StoppedPlan, "fingerprint">): string => createHash("sha256").update(JSON.stringify({
  scope: plan.scope, version: plan.version, integrity: plan.integrity, blockers: plan.blockers,
  rows: plan.rows.map(row => [row.project.id, row.project.root, row.outcome, row.inspected, row.from, row.before, row.cause]),
})).digest("hex");

async function classify(project: Project, version: string, inspect: NonNullable<StoppedDeps["inspect"]>, home: string): Promise<StoppedRow> {
  let inspected = "unknown";
  const refuse = (cause: string, next: string): StoppedRow => ({ project, outcome: "refused", inspected, cause, next });
  let state: ProjectInspection;
  try { state = await inspect(project); }
  catch (error) { return refuse(`inspection failed: ${message(error)}`, `check \`ahub doctor\`, then run this again`); }
  inspected = state.state;
  if (state.state === "running") return { project, outcome: "running", inspected, command: `ahub --project ${project.id} upgrade --to ${version}` };
  if (state.state === "missing") return refuse("project directory is missing", `restore ${project.root}, or forget the registration with \`ahub projects remove ${project.id}\``);
  // Only a positive reading of "stopped" qualifies: unknown, unavailable, starting, stopping and incompatible are never read as stopped.
  if (state.state !== "stopped") return refuse(`its hub is not verifiably stopped (${state.state}${state.error ? `: ${message(state.error)}` : ""})`, `wait for it to settle or run \`ahub --project ${project.id} status\`, then run this again`);
  if (!existsSync(join(project.root, ".agenthub", "config.json"))) return refuse("project is not initialized", `run \`ahub init\` in ${project.root} first, or forget it with \`ahub projects remove ${project.id}\``);
  // restart.json exists only while a restart snapshot is unreleased (a released one is renamed away); a corrupt one counts too.
  if (existsSync(restartPath(project.stateDir))) {
    let held = "";
    try { held = readRestartSnapshot(project.stateDir, { projectRoot: project.root, projectId: project.id })?.operationId ?? ""; }
    catch (error) { if (!(error instanceof RecoveryDeferredHubError)) throw error; }
    return refuse(held ? `it holds the unreleased restart snapshot of recovery operation ${held}` : "it holds a restart snapshot that cannot be read",
      `start it with \`ahub --project ${project.id} up\` and finish or abort that operation with \`ahub recovery status\`, then run this again`);
  }
  try {
    const owner = recoveryLock(home, project.root);
    if (owner) return refuse(`recovery operation ${owner} holds this project`, `finish it with \`ahub recovery status ${owner}\`, then run this again`);
  } catch (error) { return refuse(`the recovery lock cannot be read: ${message(error)}`, "check `ahub doctor`, then run this again"); }
  let retained: ProjectRuntimeIdentity | undefined;
  try { retained = createProjectRuntimeAccess(project).read(); }
  catch (error) { return refuse(message(error), `inspect ${projectRuntimeFile(project)} (keep it out of git, or remove it), then run this again`); }
  const before = selectionKey(retained);
  if (retained && (retained.version === version || newerVersion(retained.version, version))) return { project, outcome: "current", inspected, from: retained.version, before };
  return { project, outcome: "retarget", inspected, ...(retained ? { from: retained.version } : {}), before };
}

/**
 * Plan the runtime-selection-only retarget of one project (`selection.root`) or of every registered project (`"all"`). Each project is read independently, so one refusal never blocks another.
 * A single project that is not stopped is the caller's business (the ordinary recovery plan); here it reads as `running` or `refused`.
 */
export async function planStoppedRetargets(version: string, selection: { root: string } | "all", run: RunCommand = runCommand, deps: StoppedDeps = {}): Promise<StoppedPlan> {
  exactVersion(version);
  const home = deps.home ?? hubHome(), inspect = deps.inspect ?? ((project: Project) => inspectProject(project));
  const all = selection === "all";
  const wanted = all ? undefined : canonicalPath(selection.root);
  const projects = registeredProjects(home).filter(project => wanted === undefined || project.root === wanted);
  const rows: StoppedRow[] = [];
  for (const project of projects) rows.push(await classify(project, version, inspect, home));
  const blockers: string[] = [];
  if (!all) {
    if (!rows.length) blockers.push(`project is not registered: ${wanted}`);
    for (const row of rows) if (row.outcome === "refused") blockers.push(`${row.project.id}: ${row.cause}; ${row.next}`);
  }
  const release = rows.some(row => row.outcome === "retarget") ? await registryRelease(version, run) : undefined;
  const body: Omit<StoppedPlan, "fingerprint"> = { schema: 1, kind: "upgrade", mode: "runtime-selection", scope: all ? "all-stopped" : "project", version,
    ...(release ? { integrity: release.integrity } : {}), rows, blockers };
  return { ...body, fingerprint: fingerprintOf(body) };
}

async function defaultStage(version: string, integrity: string, run: RunCommand): Promise<{ root: string; digest: string }> {
  const staged = await stageRelease(version, integrity, run, hubHome(), true);
  return stageCurrentRuntime(staged.root, version);
}

/** The write itself, atomic with its own checks under the registry's runtime-capture lock: a hub that started after planning, a new snapshot, a hold or a changed record refuses. */
function retargetOne(row: StoppedRow, selection: ProjectRuntimeSelection, home: string): void {
  const access = createProjectRuntimeAccess(row.project); // Git-trust check; callers create it before taking the registry lock
  const registry = new Registry(join(home, "registry.db"));
  try {
    registry.runtimeCaptureLocked(() => {
      const current = registry.get(row.project.id);
      if (!current || current.root !== row.project.root || current.stateDir !== row.project.stateDir) throw new Error("project registration changed; plan again");
      const started = "a hub started for this project after planning; nothing was written";
      if (current.instanceId && processLiveness(current.pid, current.pidSignature) !== "gone") throw new Error(started);
      const control = readControl(current.stateDir);
      if (control && processLiveness(control.pid, control.pidSignature) !== "gone") throw new Error(started);
      if (existsSync(restartPath(current.stateDir))) throw new Error("a restart snapshot appeared after planning; nothing was written");
      const owner = recoveryLock(home, current.root);
      if (owner) throw new Error(`recovery operation ${owner} holds this project; nothing was written`);
      if (selectionKey(access.read()) !== row.before) throw new Error("the recorded runtime changed after planning; plan again");
      // ponytail: a starter that published its pending selection (instance null) but whose daemon has not claimed the registry yet is seen only as an unchanged record; a start marker under the lock would close that window.
      recordProjectRuntime(current, selection, null, registry, access);
    });
  } finally { registry.close(); }
}

/** Apply the `retarget` rows of a plan: stage and verify the target once, then write each project independently. A failed project never stops the others. */
export async function applyStoppedRetargets(plan: StoppedPlan, run: RunCommand = runCommand, deps: StoppedDeps = {}): Promise<StoppedResult[]> {
  const home = deps.home ?? hubHome();
  const rows = plan.rows.filter(row => row.outcome === "retarget");
  if (!rows.length) return [];
  const failed = (row: StoppedRow, cause: string): StoppedResult => ({ id: row.project.id, root: row.project.root, outcome: "failed", ...(row.from ? { from: row.from } : {}), to: plan.version, cause });
  let selection: ProjectRuntimeSelection;
  try {
    if (!plan.integrity) throw new Error("the plan carries no release identity");
    const target = await (deps.stage ?? defaultStage)(plan.version, plan.integrity, run);
    if (verifyRecoveryTarget("upgrade", target.root, plan.version) !== target.digest) throw new Error("the staged package changed after verification");
    selection = { version: plan.version, root: target.root, digest: target.digest, kind: "upgrade" };
  } catch (error) { return rows.map(row => failed(row, `staging the target failed: ${message(error)}; no runtime was changed`)); }
  return rows.map(row => {
    try { retargetOne(row, selection, home); }
    catch (error) { return failed(row, message(error)); }
    return { id: row.project.id, root: row.project.root, outcome: "retargeted" as const, ...(row.from ? { from: row.from } : {}), to: plan.version };
  });
}
