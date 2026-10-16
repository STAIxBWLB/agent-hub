import { accessSync, constants, lstatSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { registeredProjects } from "../cli/upgrade.ts";
import { ControlClient, readControl, type ControlDescriptor } from "./control-client.ts";
import { canonicalPath, hubHome, realPath } from "./project.ts";
import { processLiveness, type Liveness } from "../pi/process-signature.ts";
import type { Project } from "./registry.ts";

export interface ExpectedMemoryProfile {
  home: string;
  profile: "shared-v1" | "generation";
  generation?: string;
  selectorRevision: string;
}
export interface RunningMemoryProfile extends ExpectedMemoryProfile {
  agentMemVersion: string;
  state: "ready" | "disabled" | "stale" | "unavailable";
  skippedRows?: number;
}
export interface ProfileEvidence {
  project: Project;
  liveness: Liveness;
  descriptor?: ControlDescriptor;
  status?: unknown;
  /** Resolved only after authenticated status; unknown is never treated as a different home. */
  canonicalHome?: string;
}
export interface CheckedMemoryDaemon {
  projectId: string;
  projectRoot: string;
  pid: number | null;
  instanceId: string | null;
  hubVersion: string | null;
  agentMemVersion: string | null;
  memoryProfile: RunningMemoryProfile | null;
  scope: "same-home" | "different-home" | "unknown";
  ready: boolean;
  reason?: string;
}
export interface MemoryProfileCheck {
  ready: boolean;
  expected: ExpectedMemoryProfile;
  /** Only this registry was inventoried; other custom registries are outside this receipt. */
  registryHome?: string;
  daemons: CheckedMemoryDaemon[];
  reason?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const revision = (value: unknown): value is string => value === "absent" || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const generationCapable = (version: string): boolean => {
  const parts = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  return !!parts && (Number(parts[1]) > 0 || Number(parts[2]) >= 3);
};
function receipt(value: unknown): RunningMemoryProfile | undefined {
  if (!object(value) || typeof value.home !== "string" || !value.home || value.home.length > 4096 || !["shared-v1", "generation"].includes(String(value.profile))
    || !["ready", "disabled", "stale", "unavailable"].includes(String(value.state)) || !revision(value.selectorRevision) || typeof value.agentMemVersion !== "string"
    || value.profile === "generation" && (typeof value.generation !== "string" || !/^[a-f0-9]{32}$/.test(value.generation))
    || value.profile === "shared-v1" && value.generation !== undefined
    || value.skippedRows !== undefined && (!Number.isSafeInteger(value.skippedRows) || Number(value.skippedRows) < 0)) return undefined;
  return { home: value.home, profile: value.profile as RunningMemoryProfile["profile"], ...(value.generation ? { generation: value.generation as string } : {}),
    selectorRevision: value.selectorRevision, state: value.state as RunningMemoryProfile["state"], agentMemVersion: value.agentMemVersion,
    ...(value.skippedRows !== undefined ? { skippedRows: value.skippedRows as number } : {}) };
}

/** Evaluate finite evidence only; installed package metadata is deliberately not an input. */
export function evaluateMemoryProfileCheck(expected: ExpectedMemoryProfile, evidence: readonly ProfileEvidence[]): MemoryProfileCheck {
  const daemons: CheckedMemoryDaemon[] = [];
  for (const item of evidence) {
    if (item.liveness === "gone") continue;
    const { project, descriptor, status } = item;
    const result: CheckedMemoryDaemon = { projectId: project.id, projectRoot: project.root, pid: project.pid, instanceId: project.instanceId,
      hubVersion: null, agentMemVersion: null, memoryProfile: null, scope: "unknown", ready: false };
    const reject = (reason: string) => { result.reason = reason; daemons.push(result); };
    if (item.liveness !== "live" || !project.pidSignature || !project.instanceId || !project.pid) { reject("running owner identity is unknown"); continue; }
    if (!descriptor || descriptor.pid !== project.pid || descriptor.pidSignature !== project.pidSignature || descriptor.projectId !== project.id
      || descriptor.instanceId !== project.instanceId || descriptor.cwd !== project.root || !object(status) || status.pid !== project.pid
      || status.projectId !== project.id || status.instanceId !== project.instanceId || status.cwd !== project.root) { reject("authenticated running identity was not confirmed"); continue; }
    if (typeof status.version === "string") result.hubVersion = status.version;
    const bound = receipt(status.memoryProfile);
    if (!bound || !item.canonicalHome) { reject("running memory home/profile receipt is unavailable"); continue; }
    result.memoryProfile = bound; result.agentMemVersion = bound.agentMemVersion;
    if (item.canonicalHome !== expected.home) { result.scope = "different-home"; result.reason = "different canonical memory home"; daemons.push(result); continue; }
    result.scope = "same-home";
    if (!result.hubVersion || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(result.hubVersion) || !generationCapable(bound.agentMemVersion)) { reject("running memory library does not confirm generation support"); continue; }
    if (bound.state !== "ready") { reject("running memory binding is not ready"); continue; }
    if (bound.profile !== expected.profile || bound.generation !== expected.generation || bound.selectorRevision !== expected.selectorRevision) { reject("running memory binding differs from the selected profile"); continue; }
    result.ready = true; daemons.push(result);
  }
  const relevant = daemons.filter(row => row.scope !== "different-home");
  const ready = relevant.every(row => row.ready);
  return { ready, expected, daemons, ...(!relevant.length ? { reason: "no live binding in this registry for this memory home; quiesced in this inventory only" } : {}) };
}

/** Reuse the recovery planner's readonly SQLite reader: never constructs/migrates a Registry. */
export function readProfileCheckProjects(registryHome = hubHome()): Project[] {
  const absolute = resolve(registryHome), root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(cursor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("profile-check registry path unavailable"); }
    // Existing directory aliases are supported, but a dangling alias is not proof of an absent registry.
    if (stat.isSymbolicLink()) { try { stat = lstatSync(realPath(cursor)); } catch { throw new Error("profile-check registry path unavailable"); } }
    if (!stat.isDirectory() || !(Number(stat.mode) & 0o111)) throw new Error("profile-check registry path unavailable");
    accessSync(cursor, constants.X_OK);
  }
  const file = join(absolute, "registry.db");
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("profile-check registry unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || !(Number(stat.mode) & 0o444)) throw new Error("profile-check registry unavailable");
  accessSync(file, constants.R_OK);
  return registeredProjects(canonicalPath(absolute));
}

export async function probeMemoryProfile(project: Project): Promise<ProfileEvidence> {
  const liveness = project.pid ? processLiveness(project.pid, project.pidSignature) : project.instanceId ? "unknown" : "gone";
  const evidence: ProfileEvidence = { project, liveness };
  if (liveness !== "live" || !project.pidSignature || !project.instanceId) return evidence;
  const descriptor = readControl(project.stateDir);
  evidence.descriptor = descriptor;
  if (!descriptor || descriptor.pid !== project.pid || descriptor.pidSignature !== project.pidSignature || descriptor.projectId !== project.id
    || descriptor.instanceId !== project.instanceId || descriptor.cwd !== project.root) return evidence;
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(project.stateDir, { role: "console", projectId: project.id, instanceId: project.instanceId, projectRoot: project.root }, 3000, descriptor.protocol);
    const reply = await client.request({ t: "status" }, 5000);
    if (reply.t !== "status" || reply.ok === false) return evidence;
    evidence.status = reply.status;
    const bound = object(reply.status) ? receipt(reply.status.memoryProfile) : undefined;
    if (bound) evidence.canonicalHome = canonicalPath(bound.home);
    evidence.liveness = processLiveness(project.pid!, project.pidSignature);
  } catch { /* A timeout, old protocol or refusal is unknown evidence, never permission to migrate. */ }
  finally { client?.close(); }
  return evidence;
}

export async function checkMemoryProfiles(expected: ExpectedMemoryProfile, options: {
  registryHome?: string;
  projects?: readonly Project[];
  probe?: (project: Project) => Promise<ProfileEvidence>;
} = {}): Promise<MemoryProfileCheck> {
  let projects: readonly Project[];
  let registryHome = resolve(options.registryHome ?? hubHome());
  try { projects = options.projects ?? readProfileCheckProjects(registryHome); registryHome = canonicalPath(registryHome); }
  catch { return { ready: false, expected, registryHome, daemons: [], reason: "project registry could not be read without mutation" }; }
  const evidence: ProfileEvidence[] = [];
  for (const project of projects) evidence.push(await (options.probe ?? probeMemoryProfile)(project));
  return { ...evaluateMemoryProfileCheck({ ...expected, home: canonicalPath(expected.home) }, evidence), registryHome };
}

export function formatMemoryProfileCheck(result: MemoryProfileCheck): string {
  const lines = [`memory profile-check: ${result.ready ? "ready" : "not ready"}`, `home: ${result.expected.home}`, `selected: ${result.expected.profile}${result.expected.generation ? ` ${result.expected.generation}` : ""}`];
  if (result.registryHome) lines.push(`registry inventory: ${result.registryHome}`, "scope: this registry only; check other custom registries separately before migration");
  if (result.reason) lines.push(result.reason);
  for (const row of result.daemons) lines.push(`${row.projectId} pid:${row.pid ?? "unknown"} hub:${row.hubVersion ?? "unknown"} agent-mem:${row.agentMemVersion ?? "unknown"} ${row.memoryProfile?.profile ?? "unknown"}${row.memoryProfile?.generation ? ` ${row.memoryProfile.generation}` : ""}: ${row.ready ? "ready" : row.reason ?? "not ready"}`);
  return lines.join("\n");
}
