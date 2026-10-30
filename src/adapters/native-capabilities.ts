// #445 C1: what the hub can read of a native peer's own skills and commands, and the only versions it was probed on (C0 receipt, 2026-10-30).
// Vendor identities and listing shapes live here, in the adapter layer, never in the core rules of `src/hub/capabilities.ts` (the #451 registry guard).
import { buildManifest, type Candidate, type CapabilityManifest, type FlatSchema } from "../hub/capabilities.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The only native versions whose listings were probed (C0 receipt, 2026-10-30). Any other version lists nothing until a new receipt covers it. */
export const NATIVE_PINS = Object.freeze({
  kimi: { agent: "Kimi Code CLI", version: "2.3.2" },
  qwen: { agent: "qwen-code", version: "0.26.1" },
  codex: { agent: "codex", version: "0.166.0" },
} as const);
const STRING_INPUT: FlatSchema = { type: "object", properties: { input: { type: "string" } }, additionalProperties: false };
const QWEN_SKILL_SOURCES = ["bundled-skill", "skill-dir-command"];

/**
 * An ACP `available_commands_update` as the capabilities of a probed Kimi or Qwen. Only entries that can be told apart as skills are listed (Qwen by
 * `_meta.source`, Kimi by its `skill:` prefix): a builtin such as `compact` or `clear` changes session or host state and is never listed. A native
 * listing carries no schema and no class, so each entry takes the one-string input and declares no class at all (`sideEffect` is absent, not `read`): the
 * person's share class is then the only one that counts, and with none it is `destructive` and refused (O6). Any other agent or version gives an empty manifest.
 */
export function acpManifest(agent: unknown, version: unknown, update: unknown, observedAt: number): CapabilityManifest {
  const empty: CapabilityManifest = { capabilities: [], observedAt };
  const kind = agent === NATIVE_PINS.kimi.agent && version === NATIVE_PINS.kimi.version ? "kimi"
    : agent === NATIVE_PINS.qwen.agent && version === NATIVE_PINS.qwen.version ? "qwen" : undefined;
  if (!kind || !object(update) || !Array.isArray(update.availableCommands)) return empty;
  const candidates: Candidate[] = [];
  for (const command of update.availableCommands) {
    if (!object(command) || typeof command.name !== "string") continue;
    const meta = object(command._meta) ? command._meta : {};
    const skill = kind === "kimi" ? command.name.startsWith("skill:") : typeof meta.source === "string" && QWEN_SKILL_SOURCES.includes(meta.source);
    if (skill) candidates.push({ kind: "command", name: command.name, description: command.description, inputSchema: STRING_INPUT, source: "acp", invoke: "native" });
  }
  return buildManifest(candidates, observedAt);
}

/** A Codex `skills/list` answer as capabilities, on the probed version only. Only a skill that says `enabled: true` is listed: a flag that is missing or unreadable is not consent. */
export function codexSkillsManifest(version: unknown, result: unknown, observedAt: number): CapabilityManifest {
  const candidates: Candidate[] = [];
  if (version === NATIVE_PINS.codex.version && object(result) && Array.isArray(result.data)) {
    for (const entry of result.data) {
      if (!object(entry) || !Array.isArray(entry.skills)) continue;
      for (const skill of entry.skills) {
        if (!object(skill) || skill.enabled !== true) continue;
        candidates.push({ kind: "skill", name: skill.name, description: skill.shortDescription ?? skill.description, inputSchema: STRING_INPUT, source: "codex-skills", invoke: "native" });
      }
    }
  }
  return buildManifest(candidates, observedAt);
}
