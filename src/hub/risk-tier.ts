import { configPathList, matchConfigPath } from "./eval-gate.ts";
import { completePlanInventory } from "./plan-conformance.ts";

/**
 * #1645 T1: the risk tier of a filed change, derived from its complete file inventory. Pure: no clock, no I/O, no board, and never
 * the worktree. `[risk]` in `.agenthub/sdlc.toml` names the paths that make a change `high` and the ones that keep it `low`; a path
 * no pattern names is `medium`, and a path `[security]` names is always `high`, so a project with a security table can never derive
 * `low` from a change the security pass treats as sensitive. The tier names are this repository's closed set, never a model's word for one, and they stay
 * unexported: the one place outside this file that spells a tier's rules is `riskMinimum`, which the verdict, the plan review and the merge gate all read
 * (#1645 T3).
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

/** The one-review floor of the workspace lifecycle: no tier and no plan goes below it (#1645, "Family constraint"). */
const RISK_REVIEW_FLOOR = 1;

/**
 * #1645 T3: what one tier owes. The floor is one reviewer on every tier and this file is the only place it is spelled, so raising it moves
 * the verdict check, the plan-review report, the review request, the brief and the merge gate together. `high` adds a verifier card, which is
 * a task of class `test` (docs/sdlc.md's own lifecycle table gives that stage the acting role verifier/reviewer) owned by a peer other than
 * the implementer. That is the person's table of 2026-11-25 and nothing else.
 */
interface RiskMinimum { reviewers: number; verifier: boolean }
export function riskMinimum(tier: RiskTier): RiskMinimum {
  return { reviewers: RISK_REVIEW_FLOOR, verifier: tier === "high" };
}

/**
 * A board card as the verdict check sees it: only the fields that say which change it verified and for whom. A verifier is identified by what
 * the board already records and never by a new field - class `test`, the subject's repository and branch, the filed head in `refs.commit`, an
 * approved state and another peer's owner - so #1645 T3 invents no card shape and no board column.
 */
export interface RiskCard { id: number; class: string; state: string; owner: string | null; repo?: string; branch?: string; commit?: string }
/** The filed change a verifier answers to: its branch and head, and whoever implemented it. */
interface RiskSubject { repo?: string; branch?: string; head?: string; implementer: string | null }

/** The approved verifier card of this exact change, or `undefined`. A card that verified an older head is not one: a tier is a statement about one head. */
function riskVerifier(cards: readonly RiskCard[], subject: RiskSubject): RiskCard | undefined {
  if (!subject.head || !subject.branch) return undefined;
  const repo = subject.repo?.toLowerCase();
  return cards.find(card => card.class === "test" && card.state === "approved" && card.owner !== null && card.owner !== subject.implementer
    && card.branch === subject.branch && card.commit === subject.head && (repo === undefined || card.repo === undefined || card.repo.toLowerCase() === repo));
}

/** What the receipt's tier says about the head being judged, with the verifier the board holds for it. `undefined` for another head, never a carried tier. */
export interface RiskView { tier: RiskTier; head: string; matched: number; branch?: string; minimum: RiskMinimum; verifier?: { id: number; owner: string | null } }
export function riskView(risk: RiskRecord | undefined, cards: readonly RiskCard[], subject: RiskSubject): RiskView | undefined {
  if (!risk || risk.head !== subject.head) return undefined;
  const minimum = riskMinimum(risk.tier), verifier = minimum.verifier ? riskVerifier(cards, subject) : undefined;
  return { tier: risk.tier, head: risk.head, matched: risk.matched, ...(subject.branch ? { branch: subject.branch } : {}), minimum, ...(verifier ? { verifier: { id: verifier.id, owner: verifier.owner } } : {}) };
}

/**
 * #1645 T3, AC3 and AC5's display: what this head owes its tier and whether the board holds it, in one line the review request, the brief, the
 * task view and a verdict's note all print. The command that supplies a missing card is not here: a refusal writes its own continuation, and
 * `scripts/refusal-inventory.ts` reads a command only from the site that throws it.
 */
export function riskLine(view: RiskView): string {
  const decided = `${view.matched} path${view.matched === 1 ? "" : "s"} decided it`;
  const owes = view.minimum.verifier ? "one reviewer plus a verifier card by another peer" : "one reviewer";
  if (view.minimum.verifier && !view.verifier) return `risk ${view.tier} (${decided}); minimum ${owes}; no verifier card by another peer is approved at this head`;
  const met = view.verifier ? `; verifier card ${view.verifier.id} is approved` : "";
  return `risk ${view.tier} (${decided}); minimum ${owes}${met}`;
}

/**
 * #1645 T4, AC5: a plan's `review` metadata is cost metadata and may ask for more than the floor, never less. No tier exists before a filed
 * inventory, so the plan-review report compares against the floor; where a tier does exist (the review request and the merge gate) the caller
 * passes that tier's minimum, because `high` owes the verifier card as well.
 */
export function riskPlanFloor(review: { scope?: string; reviewers?: number } | undefined, minimum: RiskMinimum = riskMinimum("low")): string | undefined {
  const asked = review?.scope === "none" ? 0 : review?.reviewers;
  if (asked === undefined || asked >= minimum.reviewers) return undefined;
  const owes = `${minimum.reviewers} reviewer${minimum.reviewers === 1 ? "" : "s"}${minimum.verifier ? " plus a verifier card" : ""}`;
  return `plan review asked for ${asked} reviewer${asked === 1 ? "" : "s"}, below the minimum of ${owes}`;
}
