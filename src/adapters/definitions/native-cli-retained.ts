import type { AdapterDefinition } from "../registry-types.ts";

/** Explain a retained launch setting using only metadata from the selected adapter definition. */
export function retainedLaunchWarning(status: unknown, peer: string, definition: AdapterDefinition): string | undefined {
  const keys = definition.cli.launchConfigKeys;
  const retained = (status as { retainedConfig?: unknown } | undefined)?.retainedConfig;
  if (!keys?.length || !Array.isArray(retained)) return;
  const pending = retained.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const key = (row as { key?: unknown }).key;
    return typeof key === "string" && keys.some(candidate => key === candidate || key.startsWith(`${candidate}.`)) ? [key] : [];
  });
  const unique = [...new Set(pending)];
  return unique.length ? `ahub: config retained: ${unique.join(", ")}; starting ${peer} with the running value; run ahub settings reload to apply the file's value` : undefined;
}
