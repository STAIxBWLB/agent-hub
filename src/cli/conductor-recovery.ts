import { existsSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, readControl } from "../hub/control-client.ts";
import { loadConfig } from "../hub/daemon.ts";
import { captureRecoveryPolicy } from "../hub/recovery-policy.ts";
import { authorizeConductorRecovery, assertConductorRecovery, retireConductorRecovery, RecoveryAuthorityError, type ConductorRecoveryBinding } from "../hub/recovery-authority.ts";
import { operationPath } from "../hub/recovery-store.ts";
import { readRestartSnapshot } from "../hub/restart.ts";
import { processLiveness } from "../pi/process-signature.ts";
import { packageDigest } from "./recovery-package.ts";
import type { Project } from "../hub/registry.ts";
import { planFingerprint, type RecoveryOperation, type UpgradePlan } from "./upgrade.ts";
import { realPath } from "../hub/project.ts";

const unavailable = (): never => { throw new RecoveryAuthorityError(); };
function validateConductorOperation(op: RecoveryOperation): void {
  try {
    const { fingerprint, ...body } = op.plan;
    if (op.schema !== 1 || !["restart", "upgrade"].includes(op.plan.kind) || planFingerprint(body) !== fingerprint || !op.plan.projects.length
      || op.plan.projects.length > 128 || new Set(op.plan.projects.map(row => row.project.id)).size !== op.plan.projects.length) unavailable();
  } catch { unavailable(); }
}
export function conductorRecoveryBinding(op: RecoveryOperation, project: Project, peer: string): ConductorRecoveryBinding {
  validateConductorOperation(op);
  const planned = op.plan.projects.find(row => row.project.id === project.id);
  if (!planned?.source.instanceId || op.plan.projects.some(row => row.terminals.length > 0) || !op.targetRoot || !op.targetDigest || !op.targetFeatures?.includes("conductor_recovery") || op.disposition || op.audit?.length || op.freshOverride) unavailable();
  const policy = captureRecoveryPolicy(project, peer, loadConfig(project.root));
  return { schema: 1, operationId: op.id, peer, kind: op.plan.kind, projectId: project.id, projectRoot: project.root, stateDir: project.stateDir,
    sourceInstanceId: planned.source.instanceId, targetRoot: op.targetRoot, targetDigest: op.targetDigest, planFingerprint: op.plan.fingerprint, ...policy };
}
export async function conductorRecoveryRequest(project: Project, peer: string, message: Record<string, unknown>): Promise<any> {
  const descriptor = readControl(project.stateDir);
  if (!descriptor?.instanceId || !descriptor.features?.includes("conductor_recovery")) unavailable();
  const client = await ControlClient.connect(project.stateDir, { role: "tools", peer, projectId: project.id, projectRoot: project.root, instanceId: descriptor.instanceId });
  try {
    if (!client.features.includes("conductor_recovery")) unavailable();
    const result = await client.request(message, 30_000);
    if (result.ok !== true) unavailable();
    return result;
  } finally { client.close(); }
}
/** No hold, lock, staging or package effect precedes proof in every affected project. */
export async function preflightConductorRecovery(plan: Pick<UpgradePlan, "projects" | "kind">, peer: string): Promise<void> {
  if (!plan.projects.length || plan.projects.some(row => row.terminals.length > 0)) unavailable();
  for (const row of plan.projects) {
    const result = await conductorRecoveryRequest(row.project, peer, { t: "recovery_authority", op: "authorize", command: plan.kind });
    if (row.source.instanceId && result.instanceId !== row.source.instanceId) unavailable();
  }
}
/** This is called only before the new public receipt exists; resume can never mint a grant. */
export async function issueConductorOperation(op: RecoveryOperation, peer: string): Promise<void> {
  if (existsSync(operationPath(op.id))) unavailable();
  await preflightConductorRecovery(op.plan, peer);
  for (const row of op.plan.projects) {
    const binding = conductorRecoveryBinding(op, row.project, peer);
    await conductorRecoveryRequest(row.project, peer, { t: "recovery_authority", op: "issue", binding, plan: op.plan });
  }
}
function localAuthority(op: RecoveryOperation, project: Project, peer: string) {
  const expected = conductorRecoveryBinding(op, project, peer);
  if (packageDigest(op.sourceRoot, { ownDependencies: true }) !== op.plan.sourceDigest || packageDigest(expected.targetRoot, { ownDependencies: true }) !== expected.targetDigest) unavailable();
  return authorizeConductorRecovery(project.stateDir, expected, () => {
    try { return JSON.stringify(conductorRecoveryBinding(op, project, peer)) === JSON.stringify(expected); } catch { return false; }
  });
}
/** Synchronous fence for the already authenticated private bootstrap's local effect boundaries. */
export function assertConductorOperationLocal(op: RecoveryOperation, peer: string): void {
  validateConductorOperation(op);
  for (const row of op.plan.projects) assertConductorRecovery(localAuthority(op, row.project, peer));
}
export async function authorizeConductorOperation(op: RecoveryOperation, peer: string): Promise<void> {
  validateConductorOperation(op);
  const proofs = [];
  for (const row of op.plan.projects) {
    const proof = localAuthority(op, row.project, peer);
    proofs.push(proof);
    const descriptor = readControl(row.project.stateDir);
    if (descriptor) {
      if (!descriptor.pid || !descriptor.pidSignature) unavailable();
      const live = processLiveness(descriptor.pid, descriptor.pidSignature);
      if (live !== "gone") {
        if (live !== "live") unavailable();
        await conductorRecoveryRequest(row.project, peer, { t: "recovery_authority", op: "verify", binding: proof.binding });
      } else requireConductorCheckpoint(op, row.project);
    } else requireConductorCheckpoint(op, row.project);
    assertConductorRecovery(proof);
  }
  // A can change while B answers: every project is checked again after the last await.
  for (const proof of proofs) assertConductorRecovery(proof);
}
export async function requireOwnedConductorTarget(op: RecoveryOperation, project: Project, peer: string): Promise<void> {
  const binding = conductorRecoveryBinding(op, project, peer);
  const result = await conductorRecoveryRequest(project, peer, { t: "recovery_authority", op: "verify", binding });
  if (result.target !== true || result.operationId !== op.id || !["restored", "released"].includes(result.phase)) unavailable();
}
export function requireConductorCheckpoint(op: RecoveryOperation, project: Project): void {
  const snapshot = readRestartSnapshot(project.stateDir, { projectRoot: project.root, projectId: project.id, operationId: op.id });
  if (!snapshot || snapshot.operationId !== op.id || snapshot.sourceInstanceId !== op.plan.projects.find(row => row.project.id === project.id)?.source.instanceId) unavailable();
}
export function retireConductorOperation(op: RecoveryOperation, peer: string): void {
  if (op.phase !== "completed" && op.phase !== "cancelled") unavailable();
  for (const row of op.plan.projects) retireConductorRecovery(localAuthority(op, row.project, peer));
}
/** Private launcher continuation, only the reviewed target and a captured effect, never arbitrary console argv. */
export async function authorizeConductorLaunch(op: RecoveryOperation, peer: string, root: string, targetRoot: string, command: string, args: readonly string[]): Promise<void> {
  if (!["pending", "running", "blocked"].includes(op.phase)) unavailable();
  await authorizeConductorOperation(op, peer);
  if (!op.targetRoot || realPath(targetRoot) !== realPath(op.targetRoot)) unavailable();
  const planned = op.plan.projects.find(row => row.project.root === root);
  if (!planned) unavailable();
  if (command === "up" && args.length === 0) {
    const descriptor = readControl(planned.project.stateDir);
    if (descriptor && processLiveness(descriptor.pid, descriptor.pidSignature) !== "gone") unavailable();
    requireConductorCheckpoint(op, planned.project); return;
  }
  if (command === "setup" && op.plan.kind === "upgrade" && args.length === 1 && args[0] === "--yes") {
    for (const row of op.plan.projects) await requireOwnedConductorTarget(op, row.project, peer);
    await authorizeConductorOperation(op, peer); return;
  }
  unavailable();
}
