import { createHash } from "node:crypto";
import { readFileSync, lstatSync, mkdirSync } from "node:fs";
import { types } from "node:util";
import { atomicPrivateJSON } from "./recovery-store.ts";
import { realPath } from "./project.ts";
import { isAbsolute, join } from "node:path";
import type { ExternalModuleIdentity } from "../adapters/external-modules.ts";
import type { InstanceConfig } from "./instances.ts";

/** Portable identity only. No catalog epoch, child handle or live-owner authority survives a restart. */
export interface ExternalInstanceBinding {
  readonly schema: 1;
  readonly projectRoot: string;
  readonly instance: string;
  readonly kind: string;
  readonly modulePath: string;
  readonly sha256: string;
  readonly api: number;
  readonly capabilityDigest: string;
  readonly policyDigest: string;
  readonly executionCwd: string;
}
const KEYS = ["schema", "projectRoot", "instance", "kind", "modulePath", "sha256", "api", "capabilityDigest", "policyDigest", "executionCwd"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const word = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && Buffer.byteLength(value) <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
export function validExternalInstanceBinding(value: unknown, projectRoot?: string, instance?: string): value is ExternalInstanceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, "value") || !field.enumerable) || Object.getOwnPropertySymbols(value).length) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== KEYS.length || Object.keys(row).some(key => !KEYS.includes(key)) || row.schema !== 1 || row.api !== 1) return false;
  if (!["sha256", "capabilityDigest", "policyDigest"].every(key => typeof row[key] === "string" && /^[a-f0-9]{64}$/.test(row[key] as string))) return false;
  if (!["instance", "kind"].every(key => typeof row[key] === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(row[key] as string))) return false;
  if (!word(row.projectRoot, 4096) || !isAbsolute(row.projectRoot) || !word(row.executionCwd, 4096) || !isAbsolute(row.executionCwd) || !word(row.modulePath, 4096) || isAbsolute(row.modulePath) || row.modulePath.split("/").some(part => part === ".." || !part)) return false;
  return (projectRoot === undefined || row.projectRoot === projectRoot) && (instance === undefined || row.instance === instance);
}
export function externalInstanceBinding(identity: ExternalModuleIdentity, instance: string, declaration: InstanceConfig, roles: readonly string[], executionCwd: string): ExternalInstanceBinding {
  const policyDigest = hash({ kind: declaration.kind, roles: [...roles].sort(), form: "headless", worktree: declaration.worktree, readOnly: declaration.readOnly === true, permission: declaration.permission_mode ?? null });
  return Object.freeze({ schema: 1, ...identity, instance, kind: declaration.kind, policyDigest, executionCwd });
}
export function sameExternalInstanceBinding(left: ExternalInstanceBinding, right: ExternalInstanceBinding): boolean {
  return KEYS.every(key => left[key as keyof ExternalInstanceBinding] === right[key as keyof ExternalInstanceBinding]);
}

/** Private host record; native ids are correlation, never liveness/ownership proof. */
export interface ExternalInstanceRecord { readonly externalInstance: ExternalInstanceBinding; readonly sessionId: string }
export function externalInstanceStateDir(stateDir: string, instance: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(instance)) throw new Error("invalid external instance id");
  const parent = join(realPath(stateDir), "instances"), result = join(parent, instance);
  for (const directory of [parent, result]) {
    try { const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink() || realPath(directory) !== directory) throw new Error("external instance state namespace changed"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(directory, { mode: 0o700 }); }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realPath(directory) !== directory) throw new Error("external instance state namespace changed");
  }
  return result;
}
export function readExternalInstanceRecord(stateDir: string, instance: string): ExternalInstanceRecord | undefined {
  const file = join(stateDir, "instances", instance, "external-instance.json");
  let raw: unknown;
  try { const parent = lstatSync(join(stateDir, "instances")); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("external instance state namespace changed"); if (realPath(join(stateDir, "instances", instance)) !== join(realPath(stateDir), "instances", instance)) throw new Error("external instance state namespace changed"); if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("invalid external instance record"); raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("external instance record is unreadable"); }
  const row = raw as Partial<ExternalInstanceRecord>;
  if (!row || Object.keys(row).length !== 2 || !validExternalInstanceBinding(row.externalInstance, undefined, instance) || !word(row.sessionId, 4096)) throw new Error("invalid external instance record");
  return Object.freeze({ externalInstance: Object.freeze(row.externalInstance), sessionId: row.sessionId });
}
export function writeExternalInstanceRecord(stateDir: string, binding: ExternalInstanceBinding, sessionId: string): void {
  if (!validExternalInstanceBinding(binding) || !word(sessionId, 4096)) throw new Error("invalid external instance record");
  atomicPrivateJSON(join(externalInstanceStateDir(stateDir, binding.instance), "external-instance.json"), { externalInstance: binding, sessionId });
}
