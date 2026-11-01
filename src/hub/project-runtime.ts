import { resolve } from "node:path";
import { stageCurrentRuntime, verifyRecoveryTarget, newerVersion, exactVersion } from "../cli/recovery-package.ts";
import { hubHome, realPath } from "./project.ts";
import { Registry, type Project } from "./registry.ts";
import { processLiveness } from "../pi/process-signature.ts";
import { assertExecutableRuntimeRoot, createProjectRuntimeAccess, readProjectRuntime, writeProjectRuntimeState, type ProjectRuntimeAccess, type ProjectRuntimeIdentity, type ProjectRuntimeSelection } from "./project-runtime-state.ts";
export { readProjectRuntime } from "./project-runtime-state.ts";
export type { ProjectRuntimeIdentity, ProjectRuntimeSelection } from "./project-runtime-state.ts";

export const projectRuntimeRefusal = (version: string, detail?: string): Error => new Error(`this project runs ${version}; use ${version} or later / ahub upgrade${detail ? ` (${detail})` : ""}`);

export function verifyProjectRuntime(runtime: ProjectRuntimeSelection): ProjectRuntimeSelection {
  assertExecutableRuntimeRoot(runtime.root);
  try {
    if (realPath(runtime.root) !== runtime.root || verifyRecoveryTarget(runtime.kind, runtime.root, runtime.version) !== runtime.digest)
      throw new Error("runtime changed");
    return runtime;
  } catch { throw projectRuntimeRefusal(runtime.version, "recorded runtime is missing or changed"); }
}

/** Read-only caller admission also covers an already-running daemon; no capture is staged or hashed here. */
export function readProjectRuntimeForCaller(project: Project, invokingVersion: string, access?: ProjectRuntimeAccess): ProjectRuntimeIdentity | undefined {
  exactVersion(invokingVersion);
  const retained = readProjectRuntime(project, access);
  // ponytail: only updated resolver code honors runtime.json; bootstrap shared CLI to 0.26.0+ before relying on this floor.
  if (retained && newerVersion(retained.version, invokingVersion)) throw projectRuntimeRefusal(retained.version);
  return retained;
}

/** Selectors first ship in 0.26.0; unmodified earlier published CLIs cannot honor this record. */
export function resolveProjectRuntime(project: Project, invokingVersion: string, sourceRoot = resolve(import.meta.dir, "../.."), registry?: Registry, access?: ProjectRuntimeAccess): ProjectRuntimeSelection {
  const retained = readProjectRuntimeForCaller(project, invokingVersion, access);
  if (retained) return verifyProjectRuntime(retained);
  const staged = stageCurrentRuntime(sourceRoot, invokingVersion, hubHome(), registry);
  return { ...staged, kind: "restart" };
}

export function recordProjectRuntime(project: Project, runtime: ProjectRuntimeSelection, instanceId: string | null, registry: Registry, access?: ProjectRuntimeAccess): void {
  const admitted = access ?? createProjectRuntimeAccess(project);
  registry.runtimeCaptureLocked(() => {
    const current = registry.get(project.id);
    if (!current || current.root !== project.root || current.stateDir !== project.stateDir
      || instanceId !== null && current.instanceId !== instanceId
      || instanceId === null && current.instanceId && processLiveness(current.pid, current.pidSignature) !== "gone")
      throw new Error("project runtime owner changed; refresh before starting");
    verifyProjectRuntime(runtime);
    writeProjectRuntimeState(project, runtime, instanceId, admitted);
  });
}

/** A null instance is a pending selection, never consent to replace a later capture choice. */
export function confirmProjectRuntime(project: Project, runtime: ProjectRuntimeSelection, observed: { version?: unknown; instanceId?: unknown }, registry: Registry, access?: ProjectRuntimeAccess): void {
  const admitted = access ?? createProjectRuntimeAccess(project);
  registry.runtimeCaptureLocked(() => {
    const saved = readProjectRuntime(project, admitted);
    if (!saved || saved.version !== runtime.version || saved.root !== runtime.root || saved.digest !== runtime.digest || saved.kind !== runtime.kind
      || observed.version !== runtime.version || typeof observed.instanceId !== "string" || !observed.instanceId
      || saved.instanceId !== null && saved.instanceId !== observed.instanceId)
      throw projectRuntimeRefusal(saved?.version ?? runtime.version, "runtime selection changed before readiness");
    recordProjectRuntime(project, runtime, observed.instanceId, registry, admitted);
  });
}
