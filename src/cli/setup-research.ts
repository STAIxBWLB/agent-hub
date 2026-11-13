import { readAutonomyDefaults, writeMachineResearch } from "../hub/autonomy-defaults.ts";

/** Explicit person-only setup choice. Ordinary setup neither reads nor writes the research default. */
export function setupResearchDefault(home: string, roots: readonly string[], enabled: boolean | undefined): string | undefined {
  if (enabled === undefined) return undefined;
  const held = readAutonomyDefaults(home, roots);
  try { writeMachineResearch(home, enabled, held.fingerprint, roots); }
  catch { throw new Error("Research default was not saved: defaults.json is unsafe or changed; check its ownership, mode and schema, then rerun ahub setup --research or --no-research."); }
  return `Research records for new projects: ${enabled ? "on" : "off"} (saved in this machine's defaults; ahub init inherits it). Upgrade every hub and CLI on this machine to 0.36 or later first: a version from before 0.36 treats the whole file as untrusted, so its machine autonomy preset falls back to off and its start-agent default to the shipped one.`;
}
