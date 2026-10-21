import { types } from "node:util";
import { ADAPTER_API } from "./adapter-api.ts";
import type { AdapterDefinition } from "./registry-types.ts";
export interface ExternalAdapterMetadata { readonly kind: string; readonly displayName: string }
const MAX_MODULES = 16;
const fail = (reason: string): never => { throw new Error(`external adapter: ${reason}`); };
export function moduleDataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return fail("plain own-data object required");
  const fields: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(value));
  if (Object.values(fields).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) return fail("accessors and hidden fields are unsupported");
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
export function moduleText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /[\p{Cc}\p{Cf}]/u.test(value)) return fail("bounded control-free text required");
  return value;
}
export function moduleArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Object.getOwnPropertySymbols(value).length) return fail("bounded array required");
  const fields: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(value));
  if (Object.keys(fields).length !== value.length + 1) return fail("dense array required");
  return Array.from({ length: value.length }, (_, index) => {
    const field = fields[String(index)];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return fail("array data fields required");
    return field.value;
  });
}
/** Bounded inert metadata, usable by CLI/config readers without executing module callbacks. */
export function externalAdapterMetadata(raw: unknown): readonly ExternalAdapterMetadata[] {
  if (raw === undefined) return Object.freeze([]);
  const rows = moduleArray(raw, MAX_MODULES).map(value => {
    const row = moduleDataObject(value), kind = row.kind;
    if (Object.keys(row).some(key => !["kind", "displayName"].includes(key)) || typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(kind)) return fail("invalid external display metadata");
    return Object.freeze({ kind, displayName: moduleText(row.displayName, 256) });
  });
  if (new Set(rows.map(row => row.kind)).size !== rows.length) return fail("duplicate external display metadata");
  return Object.freeze(rows);
}
export function externalMetadataDefinitions(raw: unknown): readonly AdapterDefinition[] {
  return Object.freeze(externalAdapterMetadata(raw).map(({ kind, displayName }): AdapterDefinition => ({
    api: ADAPTER_API, kind, family: kind, displayName, transport: "acp", roles: [], optional: true, defaultOnRoster: false,
    trust: { onPrem: false, hubSandboxed: false }, identity: { mcp: "acp-session" }, permission: { genericAcp: {}, unmanaged: "external adapter metadata; authority belongs to the running daemon" },
    start: { forms: ["headless"], defaultForm: "headless", conductorStartable: true, hubSwitches: [], ownedFlags: [] },
    session: { idField: "sessionId", currentId: () => undefined }, turnEnd: "adapter",
    cli: { command: kind, startWords: () => [kind] }, display: { palette: { fg: "white", bg: "black" } },
  })));
}
