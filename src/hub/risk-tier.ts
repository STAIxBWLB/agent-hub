import { configPathList, matchConfigPath } from "./eval-gate.ts";
import { completePlanInventory } from "./plan-conformance.ts";

/**
 * #1645 T1: the risk tier of a filed change, derived from its complete file inventory. Pure: no clock, no I/O, no board, and never
 * the worktree. `[risk]` in `.agenthub/sdlc.toml` names the paths that make a change `high` and the ones that keep it `low`; a path
 * no pattern names is `medium`, and a path `[security]` names is always `high`, so a project with a security table can never derive
 * `low` from a change the security pass treats as sensitive. The tier names are this repository's closed set, never a model's word
 * for one, which is why they stay unexported until something outside this file spells one (#1645 T3's review table).
 */
const RISK_TIERS = ["low", "medium", "high"] as const;
type RiskTier = (typeof RISK_TIERS)[number];
/** Globs only, in the `config_paths` pattern language: no model call ever decides a tier. */
export interface RiskPolicy { high: string[]; low: string[] }

/**
 * Validated at load, like `securityPolicy`: unknown fields, a non-table, an empty table, a repeated pattern or a pattern outside the
 * language are refused with the language spelled out, because these names are printed back in review requests and merge gates.
 */
export function riskPolicy(value: unknown): RiskPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sdlc.risk: expected a table with high and low");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== "high" && key !== "low") throw new Error(`sdlc.risk.${key}: unknown field (use high and low)`);
  if (raw.high === undefined && raw.low === undefined) throw new Error("sdlc.risk: name at least one of high and low (for example high = [\"src/hub/sdlc-merge.ts\"], low = [\"docs/**\"])");
  const high = raw.high === undefined ? [] : configPathList(raw.high, "sdlc.risk.high");
  const low = raw.low === undefined ? [] : configPathList(raw.low, "sdlc.risk.low");
  const both = high.find(pattern => low.includes(pattern));
  if (both !== undefined) throw new Error(`sdlc.risk: "${both}" is named in both high and low`);
  return { high, low };
}

/** What a filing recorded: the tier, the head it was derived for, and how many changed paths decided it. A tier for another head is never read. */
export interface RiskRecord { tier: RiskTier; head: string; matched: number }

/** The lifecycle receipt a re-file starts from: the tier it carried belonged to the head that filing replaced, so it is dropped rather than read across heads. */
export function withoutRisk<T extends object>(receipt: T | undefined): Omit<T, "risk"> | undefined {
  if (!receipt) return undefined;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(receipt)) if (key !== "risk") rest[key] = value;
  return rest as Omit<T, "risk">;
}

/**
 * `undefined` when no `[risk]` table exists (the project keeps today's behaviour), when the inventory is incomplete or unreadable
 * (never `medium` by default: an unreadable change is not a classified one), when the PR changed no file at all, or when the evidence
 * belongs to a head other than the one being filed: a tier is a statement about one inventory, so it is never carried across heads.
 */
export function deriveRiskTier(policy: RiskPolicy | undefined, securityPaths: readonly string[], evidence: { head: string; paths: readonly string[]; pathsComplete?: boolean; typesComplete?: boolean } | undefined, head: string | undefined): RiskRecord | undefined {
  if (!policy || !evidence || !head || evidence.head !== head) return undefined;
  const inventory = completePlanInventory(evidence);
  if (inventory === undefined || !inventory.length) return undefined;
  const matching = (patterns: readonly string[]): number => inventory.filter(path => patterns.some(pattern => matchConfigPath(pattern, path))).length;
  const high = matching([...securityPaths, ...policy.high]);
  if (high) return { tier: "high", head: evidence.head, matched: high };
  const low = matching(policy.low);
  if (low === inventory.length) return { tier: "low", head: evidence.head, matched: low };
  return { tier: "medium", head: evidence.head, matched: inventory.length - low };
}
