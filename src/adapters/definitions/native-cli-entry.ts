import type { AdapterDefinition } from "../registry-types.ts";
import type { BuiltinCliEntry } from "./native-cli-entry-types.ts";

/** Project only the trusted definitions supplied by the host, preserving their order. */
export function builtinCliEntries(definitions: readonly AdapterDefinition[]): readonly BuiltinCliEntry[] {
  return Object.freeze(definitions.flatMap(definition => definition.cli.entry
    ? [Object.freeze({ ...definition.cli.entry, command: definition.cli.command })]
    : []));
}
