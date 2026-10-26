import { AGY_DEFINITION } from "./agy/definition.ts";
import { AGY_REVIEWER_VARIANT } from "./definitions/reviewer-variants.ts";
import { builtinCliEntries } from "./definitions/native-cli-entry.ts";
import { builtinPreview } from "./definitions/native-cli-preview.ts";
import { DAEMON_PORTS } from "./definitions/native-factories.ts";
export { DAEMON_PORTS };
import { NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN } from "./definitions/builtin-metadata.ts";
import { QWEN_DEFINITION } from "./definitions/qwen.ts";
import { configuredAcpDefinitions } from "./configured-acp.ts";
import type { AdapterDefinition, KindMap, ProjectAdapterCatalog } from "./registry-types.ts";
import { types } from "node:util";

export type * from "./registry-types.ts";
import { ADAPTER_API } from "./adapter-api.ts";
export { ADAPTER_API };



function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const member of Object.values(value)) immutable(member, seen);
  return Object.freeze(value);
}

const fixedBuiltinDefinitions = new Set<AdapterDefinition>([...NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN, QWEN_DEFINITION, AGY_DEFINITION, AGY_REVIEWER_VARIANT]);
for (const definition of [...fixedBuiltinDefinitions]) {
  if (definition.reviewerVariant) fixedBuiltinDefinitions.add(definition.reviewerVariant);
  if (definition.headlessVariant) fixedBuiltinDefinitions.add(definition.headlessVariant);
}

/** Native proof authority belongs only to the original fixed definition objects, variants included. */
export function isFixedBuiltinDefinition(definition: AdapterDefinition | undefined): boolean {
  return definition !== undefined && fixedBuiltinDefinitions.has(definition);
}

/** Keep the native catalog's order, independently of the legacy default-role object order. */
export const ADAPTERS: readonly AdapterDefinition[] = immutable([
  ...NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN.filter(definition => definition.kind !== "jcode"),
  QWEN_DEFINITION,
  ...NATIVE_BUILTIN_DEFINITIONS_WITHOUT_QWEN.filter(definition => definition.kind === "jcode"),
  AGY_DEFINITION,
]);
export interface AdapterLists {
  readonly KNOWN_PEERS: readonly string[]; readonly OPTIONAL_PEERS: readonly string[]; readonly SUPPORTED_PEERS: readonly string[];
  readonly START_MODE_PEERS: readonly string[]; readonly ROLE_ORDER: readonly string[]; readonly HELP_ORDER: readonly string[]; readonly PLANNER_PEERS: readonly string[];
}
/** Pure builtin projections. Unranked definitions retain their source order after ranked definitions. */
export function deriveAdapterLists(definitions: readonly AdapterDefinition[]): AdapterLists {
  const ordered = (field: "roleRank" | "startRank" | "helpRank", eligible = (_definition: AdapterDefinition) => true) => definitions
    .map((definition, index) => ({ definition, index })).filter(({ definition }) => eligible(definition))
    .sort((left, right) => {
      const a = left.definition.projection?.[field], b = right.definition.projection?.[field];
      if (a === undefined) return b === undefined ? left.index - right.index : 1;
      if (b === undefined) return -1;
      return a - b || left.index - right.index;
    }).map(({ definition }) => definition.kind);
  const KNOWN_PEERS = definitions.filter(definition => !definition.optional).map(definition => definition.kind);
  const OPTIONAL_PEERS = definitions.filter(definition => definition.optional).map(definition => definition.kind);
  return immutable({ KNOWN_PEERS, OPTIONAL_PEERS, SUPPORTED_PEERS: [...KNOWN_PEERS, ...OPTIONAL_PEERS],
    START_MODE_PEERS: ordered("startRank", definition => definition.start.forms.includes("tui") && definition.start.forms.includes("headless")),
    ROLE_ORDER: ordered("roleRank"), HELP_ORDER: ordered("helpRank"),
    PLANNER_PEERS: definitions.filter(definition => definition.projection?.plannerEligible === true).map(definition => definition.kind),
  });
}
export const { KNOWN_PEERS, OPTIONAL_PEERS, SUPPORTED_PEERS, START_MODE_PEERS, ROLE_ORDER, PLANNER_PEERS } = deriveAdapterLists(ADAPTERS);
export const OFFICE_PEER_ORDER: readonly string[] = KNOWN_PEERS;

// Unavailable declarations are metadata, not supported native peers or launchers.
const declarationOnlyDefinitions: readonly AdapterDefinition[] = immutable([]);
const definitions = new Map<string, AdapterDefinition>();
for (const definition of [...ADAPTERS, ...declarationOnlyDefinitions]) {
  assertDefinitionCoherence(definition);
  assertNativeCapabilityScope(definition);
  if (definition.reviewerVariant) { assertDefinitionCoherence(definition.reviewerVariant); assertNativeCapabilityScope(definition.reviewerVariant); }
  if (definition.headlessVariant) { assertDefinitionCoherence(definition.headlessVariant); assertNativeCapabilityScope(definition.headlessVariant); }
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
function declaredKind(id: string, instances: KindMap | undefined, catalog: ReadonlyMap<string, AdapterDefinition> = definitions): string | undefined {
  if (!instances || typeof instances !== "object" || types.isProxy(instances) || Array.isArray(instances)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(instances))) return undefined;
  const field = Object.getOwnPropertyDescriptor(instances, id);
  if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return undefined;
  const entry: unknown = field.value;
  if (!entry || typeof entry !== "object" || types.isProxy(entry) || Array.isArray(entry)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return undefined;
  const kind = Object.getOwnPropertyDescriptor(entry, "kind");
  if (!kind || !Object.hasOwn(kind, "value") || !kind.enumerable || typeof kind.value !== "string" || !catalog.has(kind.value)) return undefined;
  const prefix = `${kind.value}-`;
  return /^[a-z][a-z0-9-]{0,31}$/.test(id) && id.startsWith(prefix) && /^[a-z0-9][a-z0-9-]*$/.test(id.slice(prefix.length)) ? kind.value : undefined;
}
/** Legacy ids retain their identity. Extra instances resolve only through the explicit project map. */
export function kindOf(id: string, instances?: KindMap): string | undefined {
  return definitions.has(id) ? id : typeof id === "string" ? declaredKind(id, instances) : undefined;
}
export function definitionOf(id: string, instances?: KindMap): AdapterDefinition | undefined {
  const kind = kindOf(id, instances);
  return resolvedDefinition(id, kind, instances, definitions);
}
function resolvedDefinition(id: string, kind: string | undefined, instances: KindMap | undefined, catalog: ReadonlyMap<string, AdapterDefinition>): AdapterDefinition | undefined {
  const definition = kind === undefined ? undefined : catalog.get(kind);
  // #223: only a declared extra (never the builtin id) with start_mode "headless" runs as the kind's reviewer variant.
  const declaration = ownField(instances, id), roles = ownField(declaration, "roles");
  const reviewerOnly = Array.isArray(roles) && !types.isProxy(roles) && roles.length === 1 && Object.getOwnPropertyDescriptor(roles, "0")?.value === "reviewer";
  const variant = definition?.reviewerVariant;
  const fresh = variant?.reviewer?.declaration === "automatic" || ownField(declaration, "review_mode") === "fresh";
  const headless = kind !== id && ownField(declaration, "start_mode") === "headless";
  if (variant && headless && reviewerOnly && fresh) return variant;
  const roleValues = Array.isArray(roles) && !types.isProxy(roles) && roles.length <= 4 ? Array.from({ length: roles.length }, (_, index) => Object.getOwnPropertyDescriptor(roles, String(index))?.value) : [];
  const writerRoles = roleValues.includes("implementer") && roleValues.every(role => role === "implementer" || role === "verifier");
  return headless && writerRoles && definition?.headlessVariant ? definition.headlessVariant : definition;
}
export function familyOf(id: string, instances?: KindMap): string | undefined {
  return definitionOf(id, instances)?.family;
}

/** Compile one captured, host-trusted declaration set; never register native policy globally. */
export function createProjectAdapterCatalog(rawAdapters?: unknown, externalDefinitions: readonly AdapterDefinition[] = []): ProjectAdapterCatalog {
  const configured = configuredAcpDefinitions(rawAdapters, [...definitions.keys()]);
  for (const definition of configured) { assertDefinitionCoherence(definition); assertNativeCapabilityScope(definition); }
  const seen = new Set([...definitions.keys(), ...configured.map(item => item.kind)]);
  for (const definition of externalDefinitions) {
    if (definition.api !== ADAPTER_API || seen.has(definition.kind)) throw new Error("external adapter kind or API collision");
    assertDefinitionCoherence(definition); assertNativeCapabilityScope(definition);
    seen.add(definition.kind);
  }
  const external = immutable([...externalDefinitions]);
  const entries = Object.freeze([...ADAPTERS, ...configured, ...external]);
  const catalog = new Map([...definitions, ...[...configured, ...external].map(definition => [definition.kind, definition] as const)]);
  const kindOf = (id: string, instances?: KindMap): string | undefined => catalog.has(id) ? id : typeof id === "string" ? declaredKind(id, instances, catalog) : undefined;
  const definitionOf = (id: string, instances?: KindMap): AdapterDefinition | undefined => resolvedDefinition(id, kindOf(id, instances), instances, catalog);
  return Object.freeze({ definitions: entries, externalDefinitions: external, kindOf, definitionOf,
    familyOf: (id: string, instances?: KindMap) => definitionOf(id, instances)?.family,
    isSupportedPeer: (id: unknown, instances?: KindMap): id is string => {
      if (typeof id !== "string") return false;
      const kind = kindOf(id, instances), runtime = kind === undefined ? undefined : catalog.get(kind), resolved = definitionOf(id, instances);
      return runtime !== undefined && resolved !== undefined && (kind === id || resolved === runtime || resolved.reviewer?.unavailable === undefined);
    },
  });
}

/** Compatibility projection order is observable in default role maps and planner selection. */


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

/** Structural registry contract only: native telemetry readers are never executed during loading. */
export function assertDefinitionCoherence(definition: AdapterDefinition): void {
  const fail = (field: string, reason: string): never => { throw new Error(`${definition.kind}.${field}: ${reason}`); };
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  assertDaemonEngine(definition);
  if (definition.identity.mcp === "channel-plugin" && definition.transport !== "claude-channel" && definition.transport !== "ws-pull") {
    fail("identity.mcp", "channel-plugin requires claude-channel or ws-pull transport");
  }
  if (definition.turnEnd === "native-hook" && definition.transport !== "claude-channel" && !definition.hooks?.factsHook) {
    fail("turnEnd", "native-hook requires the Claude transport or a native factsHook");
  }
  const projection = definition.projection;
  if (projection !== undefined) {
    if (!projection || typeof projection !== "object" || Array.isArray(projection) || Object.keys(projection).some(key => !["roleRank", "startRank", "helpRank", "plannerEligible"].includes(key))) fail("projection", "invalid projection metadata");
    for (const field of ["roleRank", "startRank", "helpRank"] as const) if (projection[field] !== undefined && (typeof projection[field] !== "number" || !Number.isFinite(projection[field]))) fail(`projection.${field}`, "rank must be finite");
    if (projection.plannerEligible !== undefined && typeof projection.plannerEligible !== "boolean") fail("projection.plannerEligible", "boolean required");
  }
  const attach = definition.attach, pullOnly = attach?.pullOnlyForms;
  if (pullOnly !== undefined) {
    if (!Array.isArray(pullOnly) || pullOnly.some(form => !definition.start.forms.includes(form))) fail("attach.pullOnlyForms", "each pull-only form must be a supported start form");
  }
  if (definition.transport === "ws-pull" || definition.transport === "claude-channel" || definition.instances?.mode === "external") {
    if (attach?.externalHello !== true) fail("attach.externalHello", "external transport or instance admission requires an explicit hello policy");
  }
  if (definition.transport === "ws-pull" && !pullOnly?.length) fail("attach.pullOnlyForms", "ws-pull requires a nonempty pull-only contract");
  if (attach?.admission !== undefined) {
    if (!attach.admission || typeof attach.admission !== "object") fail("attach.admission", "admission must declare its refusal policy");
    if (!definition.start.forms.includes("tui") || !pullOnly?.includes("tui")) fail("attach.admission", "native admission requires a supported pull-only TUI form");
    for (const field of ["reservedRefusal", "watchRefusal"] as const) {
      if (!nonempty(attach.admission[field])) fail(`attach.admission.${field}`, "admission refusal text must be nonempty");
    }
  }
  if (definition.budget !== undefined) {
    if (!nonempty(definition.budget?.account)) fail("budget.account", "declared budget account must be a nonempty string");
    for (const field of ["reader", "context"] as const) {
      const reader = definition.budget[field];
      if (reader === undefined) continue;
      if (!reader || typeof reader !== "object") fail(`budget.${field}`, "telemetry reader must be an object");
      if (!nonempty(reader.source)) fail(`budget.${field}.source`, "telemetry source must be a nonempty string");
      if (typeof reader.read !== "function") fail(`budget.${field}.read`, "telemetry read must be callable");
    }
  }
  if (definition.reviewerVariant && !definition.reviewerVariant.reviewer) fail("reviewerVariant.reviewer", "reviewer variant lacks reviewer policy");
  if (definition.headlessVariant && (definition.headlessVariant.transport !== "hub-native" || !definition.headlessVariant.start.create || definition.headlessVariant.instances?.mode !== "headless")) fail("headlessVariant", "implementer variant requires its headless hub-native factory");
  if (definition.reviewer?.unavailable && (definition.start.create || definition.reviewer.backend)) fail("reviewer", "unavailable reviewer must remain metadata-only");
}

/** Host-global native quirks are not capabilities a config-only or external definition may opt into. */
export function assertNativeCapabilityScope(definition: AdapterDefinition): void {
  if (isFixedBuiltinDefinition(definition)) return;
  const declared = (block: object | undefined, key: string): boolean => block !== undefined && key in block;
  const restricted: [string, boolean][] = [
    ["start.acpCommand", declared(definition.start, "acpCommand")],
    ["attach.admission", declared(definition.attach, "admission")],
    ["budget.resetSoftTokensOnResume", declared(definition.budget, "resetSoftTokensOnResume")],
    ["session.crashIdentity", declared(definition.session, "crashIdentity")],
    ["session.nativeRevert", declared(definition.session, "nativeRevert")],
    ["start.daemonPort pi-rpc", definition.start.daemonPort === "pi-rpc"],
    ["start.daemonPort qwen-dual", definition.start.daemonPort === "qwen-dual"],
    ["start.createTui", declared(definition.start, "createTui")],
    ["routing", definition.routing !== undefined],
    ["projection", definition.projection !== undefined],
    ["instances.nativeHome", declared(definition.instances, "nativeHome")], // #685: a fixed-builtin assumption, one native data home per declared instance
    ["instances.modelSelect", declared(definition.instances, "modelSelect")], // #844: a fixed-builtin assumption, one validated model word per declared headless instance
    ["identity.currentChild", declared(definition.identity, "currentChild")],
    ["reviewerVariant", definition.reviewerVariant !== undefined],
    ["headlessVariant", definition.headlessVariant !== undefined],
    ["start.daemonPort claude-implementer", definition.start.daemonPort === "claude-implementer"],
    ["reviewer", definition.reviewer !== undefined],
    ["hooks.factsHook", declared(definition.hooks, "factsHook")],
    ["cli.entry", declared(definition.cli, "entry")],
    ["cli.preview", declared(definition.cli, "preview")],
    ["cli.usage", declared(definition.cli, "usage")],
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

/** Definition-owned CLI entries are restricted to fixed builtins, never config or external execution extensions. */
export const BUILTIN_CLI_ENTRIES = Object.freeze(builtinCliEntries(ADAPTERS).map(entry => {
  const definition = definitionOf(entry.command);
  if (!definition) throw new Error("builtin CLI entry has no adapter definition");
  return Object.freeze({ ...entry, definition });
}));

/** Private fixed-builtin stream presentation; does not widen the public palette object. */
export { nativeStreamTone } from "./definitions/native-display.ts";
