import { DAEMON_PORTS } from "./definitions/native-factories.ts";
export { DAEMON_PORTS };
import { BUILTIN_DEFINITIONS_WITHOUT_QWEN } from "./definitions/builtin-metadata.ts";
import { QWEN_DEFINITION } from "./definitions/qwen.ts";
import type { AdapterDefinition } from "./registry-types.ts";

export type * from "./registry-types.ts";
export const ADAPTER_API = 1;

/** Ordered compatibility projections stay typed independently of definition implementation inference. */
export const KNOWN_PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
export const OPTIONAL_PEERS = ["qwen", "jcode"] as const;
export const SUPPORTED_PEERS = [...KNOWN_PEERS, ...OPTIONAL_PEERS] as const;
export const START_MODE_PEERS = ["pi", "codex", "kimi"] as const;
export const OFFICE_PEER_ORDER: readonly string[] = KNOWN_PEERS;


function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const member of Object.values(value)) immutable(member, seen);
  return Object.freeze(value);
}

/** Keep the native catalog's order, independently of the legacy default-role object order. */
export const ADAPTERS: readonly AdapterDefinition[] = immutable([
  ...BUILTIN_DEFINITIONS_WITHOUT_QWEN.filter(definition => definition.kind !== "jcode"),
  QWEN_DEFINITION,
  ...BUILTIN_DEFINITIONS_WITHOUT_QWEN.filter(definition => definition.kind === "jcode"),
]);
const definitions = new Map<string, AdapterDefinition>();
for (const definition of ADAPTERS) {
  assertDaemonEngine(definition);
  if (definition.api !== ADAPTER_API || definitions.has(definition.kind)) throw new Error("invalid builtin adapter registry");
  definitions.set(definition.kind, definition);
}

/** A1 registers kinds only. Undeclared suffixes never acquire a native kind or admission. */
export function kindOf(id: string): string | undefined {
  return definitions.has(id) ? id : undefined;
}
export function definitionOf(id: string): AdapterDefinition | undefined {
  return definitions.get(id);
}
export function familyOf(id: string): string | undefined {
  return definitionOf(id)?.family;
}

/** Compatibility projection order is observable in default role maps and planner selection. */
const ROLE_ORDER = ["claude", "codex", "kimi", "local", "pi", "qwen", "jcode"] as const;
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

/** Ordered catalog projections consumed by generic core hosts. */
export const STARTABLE_PEERS = SUPPORTED_PEERS;
export type SupportedPeer = typeof SUPPORTED_PEERS[number];
export function isSupportedPeer(peer: unknown): peer is SupportedPeer { return typeof peer === "string" && definitionOf(peer) !== undefined; }
export function isStartablePeer(peer: unknown): peer is SupportedPeer { return typeof peer === "string" && definitionOf(peer)?.start.conductorStartable === true; }

/** Body-free browser metadata, derived from the same native participation and managed-tool contracts. */
export const ADAPTER_DISPLAY = Object.fromEntries(ADAPTERS.map(adapter => [adapter.kind, {
  pullOnlyRead: adapter.attach?.pullOnlyForms?.includes("tui") === true,
  terminalApproval: adapter.trust.hubSandboxed,
}]));
