import { modelRoutingSha, modelRoutingSummary, type Comparison, type JudgeCase, type ModelRoutingCorpus, type Split } from "./model-routing-corpus.ts";
import type { Routing } from "../../src/hub/routing.ts";
import { safeModelLabel } from "../../src/omniroute/usage.ts";

// agent-hub #637 part 2 (hub task #324): the model-routing promotion receipt. Same idea as part 1's task-routing receipt (scripts/benchmarks/routing-corpus.ts): the CI check REBUILDS everything the
// files determine and compares it whole. What no file determines is what a model said; that is the `live` block, produced by hand with `model-routing-gate.ts --live`, and CI can only check its
// shape and its consistency (the scores are recomputed from the recorded verdicts, the aliases from the two templates, the served ids must be real model ids). See docs/agent-notes/benchmarks.md.

export const LIVE_NOT_RUN = "live-not-run" as const;
export type LiveOutcome = { alias: string; verdict: "approve" | "redo" | "unparsed" } | { alias: string; escalate: boolean | "unparsed" } | { alias: string; error: string };
export interface LiveCase { id: string; guard?: string; base: LiveOutcome; candidate: LiveOutcome }
export interface LiveEvidence {
  /** Every distinct served id the gateway reported for each alias asked. Never the alias itself: an alias is what was requested, not what answered. */
  served_models: Record<string, string[]>;
  cases: LiveCase[];
}
export interface ModelReceipt {
  kind: "model-routing-receipt"; version: 1; surface: "model-routing"; corpus_hash: string; split: Split;
  base: { ref: string; sha256: string; template_sha256: string; config: Record<string, unknown> };
  candidate: { sha256: string; template_sha256: string; config: Record<string, unknown> };
  changed_keys: string[];
  /** Whether the change moves what a model is asked or which one answers, so the live half is required. */
  live_required: boolean;
  served_models: typeof LIVE_NOT_RUN | Record<string, string[]>;
  live?: LiveEvidence;
  evidence: Comparison;
  generated: string;
}

/** The alias a judge case's judge call asks on this policy: the route's own `judge`, else its capable alias. Mirrors HubRouteRuntime (`config.judge ?? capable`). */
export function judgeAlias(routing: Routing, c: JudgeCase): string | undefined {
  const config = routing.hub_routes?.[c.route];
  if (!config) return undefined;
  return config.judge ?? config.capable ?? "coding";
}
export function scoreLive(c: JudgeCase, outcome: LiveOutcome): boolean {
  if ("error" in outcome) return false;
  if ("verdict" in outcome) return "verdict" in c.expect && outcome.verdict === c.expect.verdict;
  return "escalate" in c.expect && outcome.escalate === c.expect.escalate;
}
export interface LiveComparison { n: number; base: number; candidate: number; regressions: string[]; guardRegressions: string[]; verdict: "pass" | "blocked"; reasons: string[] }
/** Judge cases are held to the same rule as the deterministic ones: not worse overall, and no guard case (the injection case) that the default passed may fail. */
export function compareLive(corpus: ModelRoutingCorpus, live: LiveEvidence, split: Split = "test"): LiveComparison {
  const judges = corpus.cases.filter((c): c is JudgeCase => c.kind === "judge" && c.split === split);
  let base = 0, candidate = 0;
  const regressions: string[] = [];
  for (const c of judges) {
    const row = live.cases.find(item => item.id === c.id);
    const b = row ? scoreLive(c, row.base) : false, k = row ? scoreLive(c, row.candidate) : false;
    if (b) base++;
    if (k) candidate++;
    if (b && !k) regressions.push(c.id);
  }
  const guardRegressions = regressions.filter(id => judges.find(c => c.id === id)?.guard !== undefined);
  const reasons: string[] = [];
  if (candidate < base) reasons.push(`judge case pass count fell from ${base}/${judges.length} to ${candidate}/${judges.length}`);
  if (guardRegressions.length) reasons.push(`regressed guard judge case(s): ${guardRegressions.join(", ")}`);
  return { n: judges.length, base, candidate, regressions, guardRegressions, verdict: reasons.length ? "blocked" : "pass", reasons };
}

/** What a live block must be, given the corpus and the two policies, or a sentence naming the first thing wrong. Never reads the network. */
export function liveProblem(corpus: ModelRoutingCorpus, base: Routing, candidate: Routing, live: unknown, split: Split = "test"): string | undefined {
  if (!live || typeof live !== "object") return "the live block is missing";
  const { served_models, cases } = live as Partial<LiveEvidence>;
  if (!served_models || typeof served_models !== "object" || Array.isArray(served_models)) return "served_models is an object of alias to the served ids";
  if (!Array.isArray(cases)) return "the live block has no cases";
  const judges = corpus.cases.filter((c): c is JudgeCase => c.kind === "judge" && c.split === split);
  if (cases.length !== judges.length || judges.some((c, i) => cases[i]?.id !== c.id)) return `the live cases must be exactly the corpus's ${split} judge cases, in order: ${judges.map(c => c.id).join(", ")}`;
  const aliases = new Set<string>();
  for (const [i, c] of judges.entries()) {
    const row = cases[i]!;
    for (const [side, routing, outcome] of [["base", base, row.base], ["candidate", candidate, row.candidate]] as const) {
      const alias = judgeAlias(routing, c);
      if (alias === undefined) return `${c.id}: the ${side} policy has no route ${c.route}`;
      if (!outcome || typeof outcome !== "object" || outcome.alias !== alias) return `${c.id}: the ${side} outcome must name the judge alias the ${side} policy asks (${alias})`;
      const kinds = ["verdict" in outcome, "escalate" in outcome, "error" in outcome].filter(Boolean).length;
      if (kinds !== 1) return `${c.id}: the ${side} outcome is one of a verdict, an escalate flag or an error`;
      if ("verdict" in outcome && !["approve", "redo", "unparsed"].includes(outcome.verdict)) return `${c.id}: the ${side} verdict is approve, redo or unparsed`;
      if ("escalate" in outcome && typeof outcome.escalate !== "boolean" && outcome.escalate !== "unparsed") return `${c.id}: the ${side} escalate is true, false or unparsed`;
      if (("verdict" in outcome && c.judge !== "advisor") || ("escalate" in outcome && c.judge !== "escalation")) return `${c.id}: the ${side} outcome is the wrong kind for a ${c.judge} case`;
      // A call that failed or came back without a served id is no evidence either way: a receipt made of such calls would pass a candidate nobody measured.
      if ("error" in outcome) return `${c.id}: the ${side} judge call has no answer (${String(outcome.error).slice(0, 120)}); rerun --live once the gateway answers every call`;
      aliases.add(alias);
    }
  }
  for (const alias of aliases) {
    const served = served_models[alias];
    if (!Array.isArray(served) || !served.length) return `no served model id is recorded for alias ${alias}: a live receipt names what answered, taken from the gateway response`;
    for (const id of served) {
      if (safeModelLabel(id) === undefined) return `served id ${JSON.stringify(id)} for alias ${alias} is not a model id`;
      if (id === alias) return `served id for alias ${alias} is the alias itself: that is what was asked, not what answered`;
    }
  }
  const extra = Object.keys(served_models).filter(alias => !aliases.has(alias));
  if (extra.length) return `served_models names aliases no judge case asked: ${extra.join(", ")}`;
  return undefined;
}

export interface ReceiptMeta { baseRef: string; baseTemplateSha: string; candidateTemplateSha: string; generated: string; changedKeys: string[]; liveRequired: boolean }
export function buildModelReceipt(corpus: ModelRoutingCorpus, comparison: Comparison, base: Routing, candidate: Routing, meta: ReceiptMeta, live?: LiveEvidence): ModelReceipt {
  return {
    kind: "model-routing-receipt", version: 1, surface: "model-routing", corpus_hash: corpus.hash, split: comparison.split,
    base: { ref: meta.baseRef, sha256: modelRoutingSha(base), template_sha256: meta.baseTemplateSha, config: modelRoutingSummary(base) },
    candidate: { sha256: modelRoutingSha(candidate), template_sha256: meta.candidateTemplateSha, config: modelRoutingSummary(candidate) },
    changed_keys: meta.changedKeys, live_required: meta.liveRequired,
    served_models: live ? live.served_models : LIVE_NOT_RUN, ...(live ? { live } : {}), evidence: comparison, generated: meta.generated,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const show = (result: unknown): string => {
  const r = result as { error?: string; turns?: { tier: string; source: string | null; judgeCalls: number; outcome: string }[]; route?: string | null; model?: string };
  if (r.error) return `error: ${r.error}`;
  if (r.turns) return r.turns.map(t => `${t.tier}${t.source ? `/${t.source}` : ""}${t.judgeCalls ? ` j${t.judgeCalls}` : ""}${t.outcome !== "none" ? ` ${t.outcome}` : ""}`).join(" > ");
  return `${r.route ?? "direct"} / ${r.model}`;
};
const outcomeText = (o: LiveOutcome): string => ("error" in o ? `error` : "verdict" in o ? o.verdict : `escalate ${o.escalate}`);

/** The document: a summary, one machine block the CI check rebuilds, and the per-case tables. */
export function renderModelReceipt(receipt: ModelReceipt, corpus?: ModelRoutingCorpus): string {
  const e = receipt.evidence;
  const served = receipt.served_models === LIVE_NOT_RUN ? LIVE_NOT_RUN : Object.entries(receipt.served_models).map(([alias, ids]) => `${alias} -> ${ids.join(", ")}`).join("; ");
  const lines = [
    `# Model-routing promotion receipt: ${receipt.candidate.sha256.slice(0, 8)}`,
    "",
    `Surface: ${receipt.surface}. Corpus ${receipt.corpus_hash.slice(0, 12)}, split \`${receipt.split}\` (${e.n} deterministic cases). Generated ${receipt.generated}.`,
    `Verdict: **${e.verdict}**${e.reasons.length ? ` (${e.reasons.join("; ")})` : ""}.`,
    "",
    `- Current default (\`${receipt.base.ref}\`): model-routing keys sha256 \`${receipt.base.sha256}\`, template sha256 \`${receipt.base.template_sha256}\``,
    `- Candidate (\`templates/routing.toml\`): model-routing keys sha256 \`${receipt.candidate.sha256}\`, template sha256 \`${receipt.candidate.template_sha256}\``,
    `- Keys that differ: ${receipt.changed_keys.length ? receipt.changed_keys.map(key => `\`${key}\``).join(", ") : "none (the same model-routing keys)"}`,
    `- Live half required: ${receipt.live_required ? "yes (the change moves an alias or a judge, so a model answers differently)" : receipt.changed_keys.length ? "no (the change moves only a deterministic decision the corpus runs through the real code)" : "no (no model-routing key changed: this is the baseline of the shipped default against itself)"}`,
    `- Served model ids: ${served}`,
    "",
    "| Metric | Current default | Candidate |", "| --- | --- | --- |",
    `| ${e.primary.metric} (primary) | ${pct(e.primary.base)} (${e.primary.baseCorrect}/${e.n}) | ${pct(e.primary.candidate)} (${e.primary.candidateCorrect}/${e.n}) |`,
    ...Object.entries(e.secondary.kinds).map(([kind, row]) => `| ${kind} cases (${row.n}) | ${pct(row.base)} | ${pct(row.candidate)} |`),
    "",
    `Regressions: ${e.regressions.length ? e.regressions.join(", ") : "none"}. PII or hard-override regressions: ${e.guardRegressions.length ? e.guardRegressions.join(", ") : "none"}. Improvements: ${e.improvements.length ? e.improvements.join(", ") : "none"}.`,
    "",
    "```json receipt", JSON.stringify(receipt, null, 2), "```", "",
    "## Deterministic cases", "", "Each cell is the tier, why (`override`, `hold`, `dimensions`), judge calls (`jN`) and advisor outcome per turn; a selection case shows route / alias. A mark is whether the case passes.", "",
    "| Case | Guard | Current default | Candidate |", "| --- | --- | --- | --- |",
    ...e.cases.map(row => `| ${row.id} | ${row.guard ?? ""} | ${show(row.base)} ${row.basePass ? "ok" : "FAIL"} | ${show(row.candidate)} ${row.candidatePass ? "ok" : "FAIL"} |`),
    "",
  ];
  if (receipt.live && corpus) {
    const judges = corpus.cases.filter((c): c is JudgeCase => c.kind === "judge" && c.split === receipt.split);
    const live = compareLive(corpus, receipt.live, receipt.split);
    lines.push(`## Live judge cases (produced by hand, not checked by CI beyond shape and scores)`, "",
      `Judge pass count: ${live.base}/${live.n} current default, ${live.candidate}/${live.n} candidate. Verdict: **${live.verdict}**${live.reasons.length ? ` (${live.reasons.join("; ")})` : ""}.`, "",
      "| Case | Guard | Expected | Current default | Candidate |", "| --- | --- | --- | --- | --- |",
      ...receipt.live.cases.map((row, i) => { const c = judges[i]!; return `| ${row.id} | ${c.guard ?? ""} | ${"verdict" in c.expect ? c.expect.verdict : `escalate ${(c.expect as { escalate: boolean }).escalate}`} | ${outcomeText(row.base)} ${scoreLive(c, row.base) ? "ok" : "FAIL"} | ${outcomeText(row.candidate)} ${scoreLive(c, row.candidate) ? "ok" : "FAIL"} |`; }), "");
  }
  return lines.join("\n");
}
/** The machine block of a receipt document, or undefined when it has none or it does not parse. */
export function parseModelReceipt(text: string): ModelReceipt | undefined {
  const match = /```json receipt\n([\s\S]*?)\n```/.exec(text);
  if (!match) return undefined;
  try { const value = JSON.parse(match[1]!) as unknown; return modelReceiptShape(value) ? value : undefined; } catch { return undefined; }
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isSha = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
/** The fields a reader dereferences before it compares anything; a block without them is skipped, never an exception. */
export function modelReceiptShape(value: unknown): value is ModelReceipt {
  if (!isObject(value) || value.kind !== "model-routing-receipt" || value.version !== 1) return false;
  const { base, candidate, evidence } = value;
  return isObject(base) && isSha(base.sha256) && isSha(base.template_sha256) && typeof base.ref === "string" && isObject(candidate) && isSha(candidate.sha256) && isSha(candidate.template_sha256)
    && typeof value.corpus_hash === "string" && (value.split === "test" || value.split === "train") && typeof value.generated === "string" && isObject(evidence) && typeof value.live_required === "boolean";
}
