import { types } from "node:util";
import { ADAPTERS, defaultPeerRoles, definitionOf, type AdapterDefinition, type StartForm } from "../adapters/registry.ts";
import { isPermissionMode, type PermissionMode } from "./permission-mode.ts";

export interface InstanceConfig {
  kind: string;
  roles?: string[];
  start_mode?: StartForm;
  permission_mode?: PermissionMode;
  worktree?: string;
}
export type InstancesConfig = Readonly<Record<string, InstanceConfig>>;
export interface InstanceCatalogEntry { id: string; kind: string; definition: AdapterDefinition; config?: InstanceConfig }
const MAX_INSTANCES = 64;
const FLOW_ROLES = new Set(["planner", "implementer", "verifier", "reviewer", "conductor"]);
const PEER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED = new Set(["user", "hub", "digest"]);
const fail = (field: string, reason: string): never => { throw new Error(`${field}: ${reason}`); };

/** Inspect only ordinary own data descriptors; accessors, proxies, symbols and custom prototypes are not config. */
function fields(value: unknown, field: string): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return fail(field, "must be a plain own-data object");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(value));
  if (Object.values(descriptors).some(entry => !Object.hasOwn(entry, "value") || !entry.enumerable)) return fail(field, "must contain enumerable data fields only");
  return descriptors;
}
function roles(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return fail(field, "must be a role array");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(value));
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length > FLOW_ROLES.size || Object.keys(descriptors).length !== length + 1) return fail(field, "invalid role array");
  const out: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable || typeof descriptor.value !== "string" || !FLOW_ROLES.has(descriptor.value) || out.includes(descriptor.value)) return fail(field, "roles must be known and unique");
    out.push(descriptor.value);
  }
  return out;
}

/** Pure I2 declaration validation. Physical worktree and startup authority checks belong to the bound host. */
export function validateInstances(raw: unknown): InstancesConfig {
  const result: Record<string, InstanceConfig> = Object.create(null);
  if (raw === undefined) return Object.freeze(result);
  const declarations = fields(raw, "instances");
  if (Object.keys(declarations).length > MAX_INSTANCES) return fail("instances", "at most 64 extra instances are supported");
  for (const [id, descriptor] of Object.entries(declarations)) {
    if (!PEER_ID.test(id) || RESERVED.has(id) || definitionOf(id)) return fail("instances", "ids must be nonreserved extra instance ids, not builtin ids");
    const path = `instances.${id}`, entry = fields(descriptor.value, path);
    if (Object.keys(entry).some(key => !["kind", "roles", "start_mode", "permission_mode", "worktree"].includes(key))) return fail(path, "unsupported field");
    const kind: unknown = entry.kind?.value;
    if (typeof kind !== "string") return fail(`${path}.kind`, "must name a native kind");
    const definition = definitionOf(kind), prefix = `${kind}-`;
    if (!definition) return fail(`${path}.kind`, "unknown native kind");
    if (!id.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]*$/.test(id.slice(prefix.length))) return fail(path, "id must be <kind>-<name>");
    if (!definition.start.create || !definition.start.forms.includes("headless") || !["env", "acp-session"].includes(definition.identity.mcp)) return fail(`${path}.kind`, "unsupported in I2; a headless factory with env or ACP-session identity is required, not channel-only or project-file identity");
    const value: InstanceConfig = { kind };
    if (entry.roles) { value.roles = roles(entry.roles.value, `${path}.roles`); Object.freeze(value.roles); }
    if (entry.start_mode) {
      if (entry.start_mode.value !== "headless") return fail(`${path}.start_mode`, "I2 extra instances require headless mode");
      value.start_mode = "headless";
    }
    if (entry.permission_mode) {
      if (!isPermissionMode(entry.permission_mode.value)) return fail(`${path}.permission_mode`, "must be ask, ask-when-needed or never-ask");
      value.permission_mode = entry.permission_mode.value;
    }
    if (entry.worktree) {
      const worktree: unknown = entry.worktree.value;
      if (typeof worktree !== "string" || !worktree.trim() || Buffer.byteLength(worktree) > 4096 || /\p{Cc}/u.test(worktree)) return fail(`${path}.worktree`, "must be a nonempty control-free path of at most 4096 UTF-8 bytes");
      value.worktree = worktree;
    }
    result[id] = Object.freeze(value);
  }
  return Object.freeze(result);
}

/** Each call derives a fresh project-local projection, without registration or suffix discovery. */
export function instanceCatalog(declarations?: InstancesConfig): readonly InstanceCatalogEntry[] {
  const instances = validateInstances(declarations);
  return Object.freeze([
    ...ADAPTERS.map(definition => Object.freeze({ id: definition.kind, kind: definition.kind, definition })),
    ...Object.entries(instances).map(([id, config]) => Object.freeze({ id, kind: config.kind, definition: definitionOf(config.kind)!, config })),
  ]);
}
export function instancePeerIds(declarations?: InstancesConfig): string[] { return instanceCatalog(declarations).map(entry => entry.id); }
export function instanceDefaultRoles(declarations?: InstancesConfig, includeOptional = true): Record<string, string[]> {
  const result = defaultPeerRoles(includeOptional);
  for (const [id, config] of Object.entries(validateInstances(declarations))) result[id] = [...(config.roles ?? definitionOf(config.kind)!.roles)];
  return result;
}
