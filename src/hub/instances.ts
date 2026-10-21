import { types } from "node:util";
import { defaultPeerRoles, definitionOf, type AdapterDefinition, type StartForm, type ProjectAdapterCatalog } from "../adapters/registry.ts";
import { isPermissionMode, type PermissionMode } from "./permission-mode.ts";

export interface InstanceConfig {
  kind: string;
  roles?: string[];
  start_mode?: StartForm;
  permission_mode?: PermissionMode;
  review_mode?: "fresh";
  worktree?: string;
  readOnly?: boolean;
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

/** Declaration support is explicit policy, independent of the native MCP binding mechanism. */
export function supportsHeadlessInstances(definition: AdapterDefinition): boolean {
  return definition.instances?.mode === "headless" && !!definition.start.create && definition.start.forms.includes("headless");
}

/** Resolve project declarations only through their captured, explicit catalog. */
export function instanceDefinitionOf(id: string, declarations: InstancesConfig | undefined, catalog: ProjectAdapterCatalog): AdapterDefinition | undefined {
  return catalog.definitionOf(id, declarations);
}

/** Pure I2 validation; physical worktree and startup authority stay host-bound. */
export function validateInstances(raw: unknown, catalog: ProjectAdapterCatalog): InstancesConfig {
  const resolve = catalog.definitionOf;
  const result: Record<string, InstanceConfig> = Object.create(null);
  if (raw === undefined) return Object.freeze(result);
  const declarations = fields(raw, "instances");
  if (Object.keys(declarations).length > MAX_INSTANCES) return fail("instances", "at most 64 extra instances are supported");
  for (const [id, descriptor] of Object.entries(declarations)) {
    if (!PEER_ID.test(id) || RESERVED.has(id) || resolve(id)) return fail("instances", "ids must be nonreserved extra instance ids, not builtin ids");
    const path = `instances.${id}`, entry = fields(descriptor.value, path);
    if (Object.keys(entry).some(key => !["kind", "roles", "start_mode", "permission_mode", "worktree", "review_mode", "readOnly"].includes(key))) return fail(path, "unsupported field");
    const kind: unknown = entry.kind?.value;
    if (typeof kind !== "string") return fail(`${path}.kind`, "must name a native kind");
    const definition = resolve(kind), prefix = `${kind}-`;
    if (!definition) return fail(`${path}.kind`, "unknown native kind");
    if (!id.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]*$/.test(id.slice(prefix.length))) return fail(path, "id must be <kind>-<name>");
    const declaredRoles = entry.roles ? roles(entry.roles.value, `${path}.roles`) : [];
    const reviewer = (definition.reviewerVariant ?? definition).reviewer;
    const reviewerOnly = entry.start_mode?.value === "headless" && declaredRoles.length === 1 && declaredRoles[0] === "reviewer";
    if (entry.review_mode && (entry.review_mode.value !== "fresh" || !reviewerOnly || !reviewer)) return fail(`${path}.review_mode`, "fresh requires reviewer-only roles, headless mode and a declared fresh-review capability");
    const freshReviewer = reviewerOnly && !!reviewer && (reviewer.declaration === "automatic" || entry.review_mode?.value === "fresh");
    if (definition.routing?.reviewOnly && !freshReviewer) return fail(path, "a review-only kind requires headless roles exactly [\"reviewer\"]");
    if (freshReviewer && entry.worktree) return fail(`${path}.worktree`, "a fresh reviewer reads the project checkout: worktree is not supported");
    if (freshReviewer && entry.permission_mode) return fail(`${path}.permission_mode`, "a fresh reviewer has a fixed read-only policy");
    // An external instance runs only in the person's terminal; its definition bounds the declared roles.
    const external = definition.instances?.mode === "external";
    const runtime = freshReviewer ? definition.reviewerVariant ?? definition : definition;
    const unavailableReviewer = freshReviewer && !!(definition.reviewerVariant ?? definition).reviewer?.unavailable;
    if (!unavailableReviewer && runtime.instances?.mode !== "external" && !supportsHeadlessInstances(runtime)) return fail(`${path}.kind`, definition.reviewerVariant ? 'unsupported; this kind only declares headless reviewer instances with roles exactly ["reviewer"]' : "unsupported; explicit external instance policy or a headless instance policy with a headless factory is required");
    if (external) {
      const declared = entry.roles ? roles(entry.roles.value, `${path}.roles`) : [];
      // #223: a headless one is the kind's reviewer variant, one fresh hub-run session per review request.
      if (entry.start_mode && definition.reviewerVariant) {
        if (entry.worktree) return fail(path, "a headless reviewer reads the project checkout: worktree is not supported");
        if (declared.length !== 1 || declared[0] !== "reviewer") return fail(`${path}.roles`, "a headless channel-kind instance is a reviewer: roles must be exactly [\"reviewer\"]");
      } else {
        if (entry.start_mode || entry.worktree) return fail(path, "a channel instance starts only from the person's terminal (ahub <kind> --as <id>): start_mode and worktree are not supported; a headless reviewer declares roles [\"reviewer\"] and start_mode \"headless\"");
        const allowed = definition.instances?.roles ?? definition.roles;
        if (!declared.length || declared.some(role => !allowed.includes(role))) return fail(`${path}.roles`, "a channel instance must declare its roles: reviewer and/or planner");
      }
    } else {
      const allowed = runtime.instances?.roles;
      if (allowed && (declaredRoles.length ? declaredRoles : runtime.roles).some(role => !allowed.includes(role))) return fail(`${path}.roles`, "roles must fit the definition's instance policy");
    }
    if (entry.readOnly) {
      if (typeof entry.readOnly.value !== "boolean") return fail(`${path}.readOnly`, "must be a boolean");
      if (!runtime.permission.genericAcp?.readOnly) return fail(`${path}.readOnly`, "native adapter has no verified read-only mode");
      if (entry.readOnly.value && entry.permission_mode) return fail(`${path}.permission_mode`, "read-only instances cannot select a permission mode");
    }
    const value: InstanceConfig = { kind, ...(entry.review_mode ? { review_mode: "fresh" as const } : {}) };
    if (entry.readOnly) value.readOnly = entry.readOnly.value as boolean;
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
export function instanceCatalog(declarations: InstancesConfig | undefined, catalog: ProjectAdapterCatalog): readonly InstanceCatalogEntry[] {
  const instances = validateInstances(declarations, catalog);
  return Object.freeze([
    ...catalog.definitions.map(definition => Object.freeze({ id: definition.kind, kind: definition.kind, definition })),
    ...Object.entries(instances).map(([id, config]) => Object.freeze({ id, kind: config.kind, definition: catalog.definitionOf(id, instances)!, config })),
  ]);
}
export function instancePeerIds(declarations: InstancesConfig | undefined, catalog: ProjectAdapterCatalog): string[] { return instanceCatalog(declarations, catalog).map(entry => entry.id); }
export function instanceDefaultRoles(declarations: InstancesConfig | undefined, includeOptional: boolean, catalog: ProjectAdapterCatalog): Record<string, string[]> {
  const result = defaultPeerRoles(includeOptional);
  for (const definition of catalog.definitions) if (!definitionOf(definition.kind) && (includeOptional || !definition.optional)) result[definition.kind] = [...definition.roles];
  const instances = validateInstances(declarations, catalog);
  for (const [id, config] of Object.entries(instances)) result[id] = [...(config.roles ?? catalog.definitionOf(id, instances)!.roles)];
  return result;
}

/** One precedence rule for startup, native launch and recovery; ordinary roles may use the instance id or its kind. */
export function effectiveInstanceRoles(id: string, declarations: InstancesConfig | undefined, policyRoles: Readonly<Record<string, readonly string[]>>, catalog: ProjectAdapterCatalog): string[] {
  const definition = catalog.definitionOf(id, declarations);
  if (!definition) throw new Error(`${id}: no declared native instance`);
  const declaration = declarations && Object.hasOwn(declarations, id) ? declarations[id] : undefined;
  const ownRoles = (key: string): readonly string[] | undefined => Object.hasOwn(policyRoles, key) ? policyRoles[key] : undefined;
  return [...(declaration?.roles ?? ownRoles(id) ?? ownRoles(definition.kind) ?? definition.roles)];
}
