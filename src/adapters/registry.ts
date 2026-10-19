import { AGY_DEFINITION } from "./agy/definition.ts";
import { AGY_REVIEWER_VARIANT } from "./definitions/reviewer-variants.ts";
import { builtinCliEntries } from "./definitions/native-cli-entry.ts";
import { builtinPreview } from "./definitions/native-cli-preview.ts";
import { DAEMON_PORTS } from "./definitions/native-factories.ts";
export { DAEMON_PORTS };
import { NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN } from "./definitions/builtin-metadata.ts";
import { QWEN_DEFINITION } from "./definitions/qwen.ts";
import type { AdapterDefinition, KindMap } from "./registry-types.ts";
import { types } from "node:util";

export type * from "./registry-types.ts";
export const ADAPTER_API = 1;

/** Ordered compatibility projections stay typed independently of definition implementation inference. */
export const KNOWN_PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
export const OPTIONAL_PEERS = ["qwen", "jcode", "agy"] as const;
export const SUPPORTED_PEERS = [...KNOWN_PEERS, ...OPTIONAL_PEERS] as const;
export const START_MODE_PEERS = ["pi", "codex", "kimi", "jcode"] as const;
export const OFFICE_PEER_ORDER: readonly string[] = KNOWN_PEERS;


function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const member of Object.values(value)) immutable(member, seen);
  return Object.freeze(value);
}

const fixedBuiltinDefinitions = new Set<AdapterDefinition>([...NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN, QWEN_DEFINITION, AGY_DEFINITION, AGY_REVIEWER_VARIANT]);
for (const definition of [...fixedBuiltinDefinitions]) if (definition.reviewerVariant) fixedBuiltinDefinitions.add(definition.reviewerVariant);

/** Keep the native catalog's order, independently of the legacy default-role object order. */
export const ADAPTERS: readonly AdapterDefinition[] = immutable([
  ...NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN.filter(definition => definition.kind !== "jcode"),
  QWEN_DEFINITION,
  ...NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN.filter(definition => definition.kind === "jcode"),
  AGY_DEFINITION,
]);
// Unavailable declarations are metadata, not supported native peers or launchers.
const declarationOnlyDefinitions: readonly AdapterDefinition[] = immutable([]);
const definitions = new Map<string, AdapterDefinition>();
for (const definition of [...ADAPTERS, ...declarationOnlyDefinitions]) {
  assertDaemonEngine(definition);
  assertNativeCapabilityScope(definition);
  if (definition.reviewerVariant) { assertDaemonEngine(definition.reviewerVariant); assertNativeCapabilityScope(definition.reviewerVariant); }
  if (definition.api !== ADAPTER_API || definitions.has(definition.kind)) throw new Error("invalid builtin adapter registry");
  definitions.set(definition.kind, definition);
}

/** Default kind slots derive from fixed reviewer policy, not a second vendor list in the host. */
export const REVIEW_POOL_KINDS: readonly string[] = Object.freeze([...definitions.values()].filter(definition => !!(definition.reviewerVariant ?? definition).reviewer).map(definition => definition.kind));
export const DEFAULT_REVIEW_POOL: readonly string[] = Object.freeze(ADAPTERS.filter(definition => (definition.reviewerVariant ?? definition).reviewer?.defaultPool === true).map(definition => definition.kind));

/** Native quota handoff platform names, distinct from per-delivery recall injection policy. */
export const QUOTA_HANDOFF_PLATFORMS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  ADAPTERS.flatMap(adapter => adapter.hooks?.recallPlatform ? [[adapter.kind, adapter.hooks.recallPlatform]] : []),
));

/** Own enumerable data field of a plain object, never a caller accessor or an inherited value. */
function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") && field.enumerable ? field.value : undefined;
}
/** Declaration reads never execute caller accessors or inherit another project's mapping. */
function declaredKind(id: string, instances: KindMap | undefined): string | undefined {
  if (!instances || typeof instances !== "object" || types.isProxy(instances) || Array.isArray(instances)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(instances))) return undefined;
  const field = Object.getOwnPropertyDescriptor(instances, id);
  if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return undefined;
  const entry: unknown = field.value;
  if (!entry || typeof entry !== "object" || types.isProxy(entry) || Array.isArray(entry)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return undefined;
  const kind = Object.getOwnPropertyDescriptor(entry, "kind");
  if (!kind || !Object.hasOwn(kind, "value") || !kind.enumerable || typeof kind.value !== "string" || !definitions.has(kind.value)) return undefined;
  const prefix = `${kind.value}-`;
  return /^[a-z][a-z0-9-]{0,31}$/.test(id) && id.startsWith(prefix) && /^[a-z0-9][a-z0-9-]*$/.test(id.slice(prefix.length)) ? kind.value : undefined;
}
/** Legacy ids retain their identity. Extra instances resolve only through the explicit project map. */
export function kindOf(id: string, instances?: KindMap): string | undefined {
  return definitions.has(id) ? id : typeof id === "string" ? declaredKind(id, instances) : undefined;
}
export function definitionOf(id: string, instances?: KindMap): AdapterDefinition | undefined {
  const kind = kindOf(id, instances);
  const definition = kind === undefined ? undefined : definitions.get(kind);
  // #223: only a declared extra (never the builtin id) with start_mode "headless" runs as the kind's reviewer variant.
  const declaration = ownField(instances, id), roles = ownField(declaration, "roles");
  const reviewerOnly = Array.isArray(roles) && !types.isProxy(roles) && roles.length === 1 && Object.getOwnPropertyDescriptor(roles, "0")?.value === "reviewer";
  const variant = definition?.reviewerVariant;
  const fresh = variant?.reviewer?.declaration === "automatic" || ownField(declaration, "review_mode") === "fresh";
  return variant && kind !== id && reviewerOnly && ownField(declaration, "start_mode") === "headless" && fresh ? variant : definition;
}
export function familyOf(id: string, instances?: KindMap): string | undefined {
  return definitionOf(id, instances)?.family;
}

/** Compatibility projection order is observable in default role maps and planner selection. */
const ROLE_ORDER = ["claude", "codex", "kimi", "local", "pi", "qwen", "jcode", "agy"] as const;
export const PLANNER_PEERS = ["claude", "codex", "kimi", "qwen", "jcode"] as const;

/** Callers own their role arrays, independent of immutable native policy. */
export function defaultPeerRoles(includeOptional = false): Record<string, string[]> {
  return Object.fromEntries(ROLE_ORDER.filter(peer => includeOptional || !definitionOf(peer)!.optional)
    .map(peer => [peer, [...definitionOf(peer)!.roles]]));
}

/** Preserve the tool schema's legacy preferred order without spreading native names into tools. */
const CONDUCTOR_START_PRIORITY = ["local", "kimi", "pi"] as const;
export const CONDUCTOR_START_PEERS = [
  ...CONDUCTOR_START_PRIORITY,
  ...ADAPTERS.filter(adapter => !(CONDUCTOR_START_PRIORITY as readonly string[]).includes(adapter.kind)).map(adapter => adapter.kind),
];

/** A missing definition retains external-id admission; Pi's legacy enabled switch controls its default only. */
export function defaultRosterEnabled(peer: string, piEnabled: boolean): boolean {
  const definition = definitionOf(peer);
  if (!definition) return true;
  return definition.kind === "pi" ? piEnabled : definition.defaultOnRoster ?? false;
}

/** A factory must name one existing engine; metadata never creates a caller-controlled port. */
export function assertDaemonEngine(definition: Pick<AdapterDefinition, "start">): void {
  const engine = definition.start.daemonPort;
  if (definition.start.create && engine === undefined || engine !== undefined && !Object.hasOwn(DAEMON_PORTS, engine)) throw new Error("invalid adapter daemon engine");
}

/** Host-global native quirks are not capabilities a config-only or external definition may opt into. */
export function assertNativeCapabilityScope(definition: AdapterDefinition): void {
  if (fixedBuiltinDefinitions.has(definition)) return;
  const declared = (block: object | undefined, key: string): boolean => block !== undefined && key in block;
  const restricted: [string, boolean][] = [
    ["start.acpCommand", declared(definition.start, "acpCommand")],
    ["attach.admission", declared(definition.attach, "admission")],
    ["budget.resetSoftTokensOnResume", declared(definition.budget, "resetSoftTokensOnResume")],
    ["session.crashIdentity", declared(definition.session, "crashIdentity")],
    ["start.daemonPort pi-rpc", definition.start.daemonPort === "pi-rpc"],
    ["routing", definition.routing !== undefined],
    ["reviewerVariant", definition.reviewerVariant !== undefined],
    ["reviewer", definition.reviewer !== undefined],
    ["hooks.factsHook", declared(definition.hooks, "factsHook")],
  ];
  const field = restricted.find(([, present]) => present)?.[0];
  if (field) throw new Error(`${field} is restricted to fixed builtin adapter definitions`);
}

/** Ordered catalog projections consumed by generic core hosts. */
export const STARTABLE_PEERS = SUPPORTED_PEERS;
export type SupportedPeer = typeof SUPPORTED_PEERS[number];
export function isSupportedPeer(peer: unknown, instances?: KindMap): peer is string {
  if (typeof peer !== "string") return false;
  if (ADAPTERS.some(definition => definition.kind === peer)) return true;
  const kind = declaredKind(peer, instances);
  const runtime = ADAPTERS.find(definition => definition.kind === kind), resolved = definitionOf(peer, instances);
  return runtime !== undefined && resolved !== undefined && (resolved === runtime || resolved.reviewer?.unavailable === undefined);
}
export function isStartablePeer(peer: unknown): peer is SupportedPeer { return isSupportedPeer(peer) && definitionOf(peer)?.start.conductorStartable === true; }

/** Body-free browser metadata, derived from the same native participation and managed-tool contracts. */
export const ADAPTER_DISPLAY = Object.fromEntries(ADAPTERS.map(adapter => [adapter.kind, {
  pullOnlyRead: adapter.attach?.pullOnlyForms?.includes("tui") === true,
  terminalApproval: adapter.trust.hubSandboxed,
}]));

export { NATIVE_CONFIG_BLOCKS, nativeConfigurationDefaults, mergeNativeConfiguration, retainNativeRouting } from "./definitions/native-config-defaults.ts";

/** Private fixed-builtin preview implementation; not an adapter extension or configurable callback. */
export function builtinPreviewOf(id: string) {
  const definition = definitionOf(id);
  return definition ? builtinPreview(definition) : undefined;
}

/** Fixed builtin doctor metadata and pure observed-value projections; the CLI retains all probe effects. */
export { DOCTOR_TOOL_PROBES, DOCTOR_MEMORY_CAPTURE_PEERS, DOCTOR_PLUGIN_PROBE, nativeDoctorCheck, nativeDoctorRecoveryIdentity, nativeDoctorOptionalProbes } from "./definitions/native-cli-doctor.ts";

/** Internal fixed builtin CLI entries; public AdapterDefinition and NativeHooks expose no execution extension. */
export const BUILTIN_CLI_ENTRIES = Object.freeze(builtinCliEntries.map(entry => {
  const definition = definitionOf(entry.command);
  if (!definition) throw new Error("builtin CLI entry has no adapter definition");
  return Object.freeze({ ...entry, definition });
}));

/** Private fixed-builtin stream presentation; does not widen the public palette object. */
export { nativeStreamTone } from "./definitions/native-display.ts";
