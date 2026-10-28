import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { CLASSES, type Task, type TaskClass } from "../../src/hub/board.ts";
import type { PeerState } from "../../src/hub/envelope.ts";
import { assign, parseRouting, type Routing } from "../../src/hub/routing.ts";

// agent-hub #637 part 1 (hub task #321): the frozen task-routing corpus, its evaluation by the pure `assign()`, the promotion comparison and the receipt format.
// Spec: issue #637 (B1 task routing, B2, B3) and the promotion rule in docs/agent-notes/benchmarks.md. Nothing here reads a clock, the network or a model.

export const PEERS = ["claude", "codex", "kimi", "pi", "local"] as const;
const PEER_STATES: readonly string[] = ["idle", "busy", "paused", "offline"];
const SIGNALS: readonly string[] = ["pii", "pii_path", "long_context", "urgent"];
const TASK_STATES: readonly string[] = ["proposed", "backlog", "approved", "cancelled"];
export type Guard = "pii" | "refusal";
export type Split = "train" | "test";

export interface RoutingCase {
  id: string;
  split: Split;
  /** One sentence: the rule of the policy this case pins, so a reader can judge the expectation without running anything. */
  note: string;
  /** A PII or refusal case: a candidate that regresses one is blocked, whatever it gains elsewhere. */
  guard?: Guard;
  task: { class: string; signals: string[]; reserved?: string; state?: string };
  /** Attached peers and their states; a peer that is not listed is not attached. */
  states: Record<string, string>;
  exclude?: string[];
  waitsFor?: number[];
  /** Written from the policy's documented rule, never copied from a run. `refusals` are `<role>:<peer>:<code>` strings that must appear. */
  expect: { owner: string | null; reviewer?: string | null; refusals?: string[] };
}
export interface Corpus {
  version: 1;
  surface: "task-routing";
  hash: string;
  defaults: { roles: Record<string, string[]> };
  cases: RoutingCase[];
}

/** JSON with every object's keys sorted, so the hash does not depend on how the file was written. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** The content hash of a corpus: everything but the `hash` field itself, the split of each case included. */
export function corpusHash(corpus: Omit<Corpus, "hash"> | Corpus): string {
  const { hash: _ignored, ...rest } = corpus as Corpus;
  return sha256(canonicalJson(rest));
}

const fail = (message: string): never => { throw new Error(`routing corpus: ${message}`); };
/** Checks a parsed corpus. `allowStale` is for `--freeze` only: it accepts a hash that no longer matches, so the file can be refrozen. */
export function validateCorpus(raw: unknown, allowStale = false): Corpus {
  if (!raw || typeof raw !== "object") return fail("not an object");
  const corpus = raw as Corpus;
  if (corpus.version !== 1 || corpus.surface !== "task-routing") fail("version 1 and surface task-routing are required");
  if (typeof corpus.hash !== "string" || !Array.isArray(corpus.cases) || !corpus.cases.length) fail("hash and a nonempty cases list are required");
  if (!corpus.defaults || typeof corpus.defaults.roles !== "object") fail("defaults.roles is required");
  const ids = new Set<string>();
  for (const c of corpus.cases) {
    const where = `case ${JSON.stringify(c?.id)}`;
    if (typeof c?.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id)) fail(`${where}: id is lower-case letters, digits and hyphens`);
    if (ids.has(c.id)) fail(`${where}: duplicate id`);
    ids.add(c.id);
    if (c.split !== "train" && c.split !== "test") fail(`${where}: split is train or test`);
    if (typeof c.note !== "string" || !c.note.trim()) fail(`${where}: a note naming the rule is required`);
    if (c.guard !== undefined && c.guard !== "pii" && c.guard !== "refusal") fail(`${where}: guard is pii or refusal`);
    if (!(CLASSES as readonly string[]).includes(c.task?.class)) fail(`${where}: unknown class`);
    if (!Array.isArray(c.task.signals) || c.task.signals.some(signal => !SIGNALS.includes(signal))) fail(`${where}: unknown signal`);
    if (c.task.reserved !== undefined && !(PEERS as readonly string[]).includes(c.task.reserved)) fail(`${where}: unknown reserved peer`);
    if (c.task.state !== undefined && !TASK_STATES.includes(c.task.state)) fail(`${where}: unknown task state`);
    for (const [peer, state] of Object.entries(c.states ?? {})) if (!(PEERS as readonly string[]).includes(peer) || !PEER_STATES.includes(state)) fail(`${where}: bad peer state ${peer}=${state}`);
    for (const peer of c.exclude ?? []) if (!(PEERS as readonly string[]).includes(peer)) fail(`${where}: unknown excluded peer`);
    const expectOwner = c.expect?.owner;
    if (expectOwner !== null && !(PEERS as readonly string[]).includes(expectOwner as string)) fail(`${where}: expect.owner is a peer or null`);
    const reviewer = c.expect.reviewer;
    if (reviewer !== undefined && reviewer !== null && reviewer !== "user" && !(PEERS as readonly string[]).includes(reviewer)) fail(`${where}: expect.reviewer is a peer, user or null`);
    for (const refusal of c.expect.refusals ?? []) if (!/^(owner|reviewer):[a-z]+:[a-z-]+$/.test(refusal)) fail(`${where}: refusal ${refusal} is <role>:<peer>:<code>`);
  }
  for (const split of ["train", "test"] as const) for (const guard of ["pii", "refusal"] as const) {
    if (!corpus.cases.some(c => c.split === split && c.guard === guard)) fail(`the ${split} split needs at least one ${guard} guard case, or the promotion rule cannot be checked`);
  }
  if (!allowStale) {
    const actual = corpusHash(corpus);
    if (actual !== corpus.hash) fail(`hash mismatch: the file says ${corpus.hash}, its content is ${actual}. After an intended change run routing-gate.ts --freeze; every receipt for the old hash is then void`);
  }
  return corpus;
}
export function loadCorpus(path: string, allowStale = false): Corpus { return validateCorpus(JSON.parse(readFileSync(path, "utf8")), allowStale); }
/** Rewrites the file's hash to its content's after an intended change. Everything else is validated first; only the hash may be stale. */
export function freezeCorpus(path: string): { hash: string; stale: boolean } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Corpus;
  validateCorpus(raw, true);
  const hash = corpusHash(raw), stale = raw.hash !== hash;
  if (stale) writeFileSync(path, JSON.stringify({ ...raw, hash }, null, 2) + "\n");
  return { hash, stale };
}

export interface CaseResult { owner: string | null; reviewer: string | null; refusals: string[] }
/** The pure `assign()` on one case. */
export function runCase(c: RoutingCase, routing: Routing, defaults: Corpus["defaults"]): CaseResult {
  const task = { class: c.task.class as TaskClass, signals: c.task.signals as Task["signals"], reserved: c.task.reserved ?? null, ...(c.task.state ? { state: c.task.state as Task["state"] } : {}) };
  const assignment = assign(task as Parameters<typeof assign>[0], c.states as Record<string, PeerState>, routing, {
    roles: defaults.roles, ...(c.exclude ? { exclude: c.exclude } : {}), ...(c.waitsFor ? { waitsFor: c.waitsFor } : {}),
  });
  return { owner: assignment.owner ?? null, reviewer: assignment.reviewer ?? null, refusals: (assignment.refusals ?? []).map(row => `${row.role}:${row.peer}:${row.code}`).sort() };
}
export interface Score { owner: boolean; reviewer?: boolean; refusals: boolean; pass: boolean }
export function scoreCase(c: RoutingCase, result: CaseResult): Score {
  const owner = result.owner === c.expect.owner;
  const reviewer = c.expect.reviewer === undefined ? undefined : result.reviewer === c.expect.reviewer;
  const refusals = (c.expect.refusals ?? []).every(row => result.refusals.includes(row));
  return { owner, ...(reviewer === undefined ? {} : { reviewer }), refusals, pass: owner && reviewer !== false && refusals };
}
export interface Evaluated { id: string; guard?: Guard; expect: RoutingCase["expect"]; result: CaseResult; score: Score }
export function evaluate(corpus: Corpus, routing: Routing, split: Split): Evaluated[] {
  return corpus.cases.filter(c => c.split === split).map(c => { const result = runCase(c, routing, corpus.defaults); return { id: c.id, ...(c.guard ? { guard: c.guard } : {}), expect: c.expect, result, score: scoreCase(c, result) }; });
}

const rate = (correct: number, n: number): number => (n ? Math.round((correct / n) * 10000) / 10000 : 0);
export interface Comparison {
  split: Split;
  n: number;
  /** The primary metric: owner top-1 accuracy. */
  primary: { metric: string; base: number; candidate: number; baseCorrect: number; candidateCorrect: number };
  secondary: { reviewer: { n: number; base: number; candidate: number }; fullCase: { base: number; candidate: number } };
  /** Cases the base passed and the candidate fails (any kind), and the guard cases among them. */
  regressions: string[];
  guardRegressions: string[];
  improvements: string[];
  verdict: "pass" | "blocked";
  reasons: string[];
  cases: { id: string; guard?: Guard; expect: RoutingCase["expect"]; base: CaseResult; candidate: CaseResult; basePass: boolean; candidatePass: boolean }[];
}
/** The promotion rule: the candidate is not worse on the primary metric and regresses no PII or refusal case. */
export function compare(corpus: Corpus, base: Routing, candidate: Routing, split: Split = "test"): Comparison {
  const a = evaluate(corpus, base, split), b = evaluate(corpus, candidate, split);
  const n = a.length;
  const baseCorrect = a.filter(row => row.score.owner).length, candidateCorrect = b.filter(row => row.score.owner).length;
  const reviewerRows = (rows: Evaluated[]) => rows.filter(row => row.score.reviewer !== undefined);
  const regressions = a.flatMap((row, i) => (row.score.pass && !b[i]!.score.pass ? [row.id] : []));
  const improvements = a.flatMap((row, i) => (!row.score.pass && b[i]!.score.pass ? [row.id] : []));
  const guardRegressions = regressions.filter(id => a.find(row => row.id === id)!.guard !== undefined);
  const reasons: string[] = [];
  if (candidateCorrect < baseCorrect) reasons.push(`owner top-1 accuracy fell from ${baseCorrect}/${n} to ${candidateCorrect}/${n}`);
  if (guardRegressions.length) reasons.push(`regressed PII or refusal case(s): ${guardRegressions.join(", ")}`);
  return {
    split, n,
    primary: { metric: "owner top-1 accuracy", base: rate(baseCorrect, n), candidate: rate(candidateCorrect, n), baseCorrect, candidateCorrect },
    secondary: {
      reviewer: { n: reviewerRows(a).length, base: rate(reviewerRows(a).filter(row => row.score.reviewer).length, reviewerRows(a).length), candidate: rate(reviewerRows(b).filter(row => row.score.reviewer).length, reviewerRows(b).length) },
      fullCase: { base: rate(a.filter(row => row.score.pass).length, n), candidate: rate(b.filter(row => row.score.pass).length, n) },
    },
    regressions, guardRegressions, improvements, verdict: reasons.length ? "blocked" : "pass", reasons,
    cases: a.map((row, i) => ({ id: row.id, ...(row.guard ? { guard: row.guard } : {}), expect: row.expect, base: row.result, candidate: b[i]!.result, basePass: row.score.pass, candidatePass: b[i]!.score.pass })),
  };
}

/** What a reviewer reads as "the configuration": everything of the parsed policy except the load bookkeeping. Model-routing keys are included so a diff shows them, though this corpus does not exercise them. */
export function policySummary(routing: Routing): Record<string, unknown> {
  const { sources: _sources, retired: _retired, ...policy } = routing as Routing & { sources?: unknown; retired?: unknown };
  return JSON.parse(canonicalJson(policy)) as Record<string, unknown>;
}
/** Dotted paths whose value differs between two policy summaries. */
export function changedKeys(a: unknown, b: unknown, prefix = ""): string[] {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (object(a) && object(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => changedKeys(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  return canonicalJson(a) === canonicalJson(b) ? [] : [prefix];
}

export interface ReceiptMeta {
  baseRef: string;
  baseSha256: string;
  candidateSha256: string;
  generated: string;
  changedKeys: string[];
  base: Record<string, unknown>;
  candidate: Record<string, unknown>;
}
export interface Receipt {
  kind: "routing-receipt";
  version: 1;
  surface: "task-routing";
  corpus_hash: string;
  split: Split;
  base: { ref: string; sha256: string; config: Record<string, unknown> };
  candidate: { sha256: string; config: Record<string, unknown> };
  changed_keys: string[];
  served_models: string;
  evidence: Omit<Comparison, "cases"> & { cases: Comparison["cases"] };
  generated: string;
}
export const SERVED_MODELS_NOTE = "not applicable: task routing calls no model. Model-routing keys (hub_routes, local.route, fixed_model) are not exercised by this corpus; their corpus and served model ids are #637 part 2.";

export function buildReceipt(corpus: Corpus, comparison: Comparison, meta: ReceiptMeta): Receipt {
  return { kind: "routing-receipt", version: 1, surface: "task-routing", corpus_hash: corpus.hash, split: comparison.split,
    base: { ref: meta.baseRef, sha256: meta.baseSha256, config: meta.base }, candidate: { sha256: meta.candidateSha256, config: meta.candidate },
    changed_keys: meta.changedKeys, served_models: SERVED_MODELS_NOTE, evidence: comparison, generated: meta.generated };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const cell = (result: CaseResult) => `${result.owner ?? "none"}${result.reviewer !== null ? ` / ${result.reviewer}` : ""}`;
/** The receipt document: a short human summary, one machine block the CI check reads and recomputes, and the per-case table. */
export function renderReceipt(receipt: Receipt): string {
  const e = receipt.evidence;
  const lines = [
    `# Routing promotion receipt: ${receipt.candidate.sha256.slice(0, 8)}`,
    "",
    `Surface: ${receipt.surface}. Corpus ${receipt.corpus_hash.slice(0, 12)}, split \`${receipt.split}\` (${e.n} cases). Generated ${receipt.generated}.`,
    `Verdict: **${e.verdict}**${e.reasons.length ? ` (${e.reasons.join("; ")})` : ""}.`,
    "",
    `- Current default (\`${receipt.base.ref}\`): sha256 \`${receipt.base.sha256}\``,
    `- Candidate (\`templates/routing.toml\`): sha256 \`${receipt.candidate.sha256}\``,
    `- Keys that differ: ${receipt.changed_keys.length ? receipt.changed_keys.map(key => `\`${key}\``).join(", ") : "none (the same policy)"}`,
    `- Served model ids: ${receipt.served_models}`,
    "",
    "| Metric | Current default | Candidate |", "| --- | --- | --- |",
    `| ${e.primary.metric} (primary) | ${pct(e.primary.base)} (${e.primary.baseCorrect}/${e.n}) | ${pct(e.primary.candidate)} (${e.primary.candidateCorrect}/${e.n}) |`,
    `| reviewer accuracy (${e.secondary.reviewer.n} cases) | ${pct(e.secondary.reviewer.base)} | ${pct(e.secondary.reviewer.candidate)} |`,
    `| whole-case pass rate | ${pct(e.secondary.fullCase.base)} | ${pct(e.secondary.fullCase.candidate)} |`,
    "",
    `Regressions: ${e.regressions.length ? e.regressions.join(", ") : "none"}. PII or refusal regressions: ${e.guardRegressions.length ? e.guardRegressions.join(", ") : "none"}. Improvements: ${e.improvements.length ? e.improvements.join(", ") : "none"}.`,
    "",
    "```json receipt", JSON.stringify(receipt, null, 2), "```", "",
    "## Cases", "", "Each cell is `owner / reviewer`. A mark is whether the case passes (owner, reviewer where stated, and the stated refusals).", "",
    "| Case | Guard | Expected | Current default | Candidate |", "| --- | --- | --- | --- | --- |",
    ...e.cases.map(row => `| ${row.id} | ${row.guard ?? ""} | ${row.expect.owner ?? "none"}${row.expect.reviewer !== undefined ? ` / ${row.expect.reviewer ?? "none"}` : ""} | ${cell(row.base)} ${row.basePass ? "ok" : "FAIL"} | ${cell(row.candidate)} ${row.candidatePass ? "ok" : "FAIL"} |`),
    "",
  ];
  return lines.join("\n");
}
/** The machine block of a receipt document, or undefined when it has none or it does not parse. */
export function parseReceipt(text: string): Receipt | undefined {
  const match = /```json receipt\n([\s\S]*?)\n```/.exec(text);
  if (!match) return undefined;
  try { const value = JSON.parse(match[1]!) as Receipt; return value?.kind === "routing-receipt" && value.version === 1 ? value : undefined; } catch { return undefined; }
}
/** The configurations of a base and a candidate routing.toml text, parsed with the shipped loader. */
export function parseConfigs(baseText: string, candidateText: string): { base: Routing; candidate: Routing } {
  return { base: parseRouting(baseText), candidate: parseRouting(candidateText) };
}
