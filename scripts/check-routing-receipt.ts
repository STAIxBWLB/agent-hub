#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildReceipt, canonicalJson, changedKeys, compare, evaluate, parseConfigs, parseReceipt, policySummary, renderReceipt, sha256, validateCorpus, type Comparison, type Corpus, type Receipt } from "./benchmarks/routing-corpus.ts";

/** Line endings and trailing blank lines are not content: a checkout that rewrites them must not fail a receipt. */
const normalize = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\s+$/, "");

// agent-hub #637 part 1 (hub task #321): fail a PR that changes templates/routing.toml without a receipt that matches it.
// The rule is the "Routing promotion rule" in docs/agent-notes/benchmarks.md. No model runs here: the check reads files and git, and RECOMPUTES the comparison from the
// corpus and the two templates, so a receipt that was edited by hand cannot pass. Run by .github/workflows/routing-receipt.yml; by hand: `bun scripts/check-routing-receipt.ts [<base>]`.

export const TEMPLATE = "templates/routing.toml";
export const CORPUS_PATH = "scripts/benchmarks/routing-corpus.json";
export const RECEIPT_DIR = "docs/verification";
/** The check run that carries the eval markers (#481 S5): the person sets `eval_check = "routing-eval"` in .agenthub/sdlc.toml. It is a SEPARATE run, created through the Checks API, because a Actions job's own check run has no title or summary the hub could read. */
export const EVAL_CHECK_NAME = "routing-eval";
const RECEIPT_NAME = /^\d{4}-\d{2}-\d{2}-routing-[0-9a-f]{8}\.md$/;

export interface CheckInput {
  /** Repo-relative paths the PR changes against its merge base. */
  changed: readonly string[];
  /** `templates/routing.toml` at the merge base and at the head; undefined when the file does not exist there. */
  baseTemplate: string | undefined;
  headTemplate: string | undefined;
  /** The head's corpus file. */
  corpusText: string;
  /** Every `docs/verification/*-routing-*.md` at the head. */
  receipts: readonly { path: string; text: string }[];
}
export type CheckResult = { ok: true; note: string } | { ok: false; reason: string };

/** The decision. Pure: the same input always gives the same answer. */
export function checkReceipt(input: CheckInput): CheckResult {
  const templateChanged = input.changed.includes(TEMPLATE);
  if (!templateChanged) return { ok: true, note: `${TEMPLATE} is unchanged: no receipt is needed` };
  const needs = `${TEMPLATE} changed, so this PR needs a promotion receipt (bun scripts/benchmarks/routing-gate.ts --receipt, then commit the file it writes under ${RECEIPT_DIR}/)`;
  if (input.headTemplate === undefined) return { ok: false, reason: `${TEMPLATE} was deleted; the shipped routing default cannot be removed` };
  if (input.baseTemplate === undefined) return { ok: false, reason: `${TEMPLATE} did not exist at the merge base, so there is no current default to compare against; ${needs}` };
  // The frozen corpus is the measuring stick: it does not change in the same PR as the default it measures.
  if (input.changed.includes(CORPUS_PATH)) return { ok: false, reason: `${CORPUS_PATH} changes in the same PR as ${TEMPLATE}; a frozen corpus is never edited together with the default it measures. Land the corpus change first (with its refreeze), then the default change with a receipt` };
  let corpus: Corpus;
  try { corpus = validateCorpus(JSON.parse(input.corpusText)); }
  catch (error) { return { ok: false, reason: (error as Error).message }; }
  const headSha = sha256(input.headTemplate), baseSha = sha256(input.baseTemplate);
  const candidates = input.receipts.flatMap(file => { const receipt = parseReceipt(file.text.replace(/\r\n/g, "\n")); return receipt ? [{ file, receipt }] : []; });
  if (!candidates.length) return { ok: false, reason: `no routing receipt under ${RECEIPT_DIR}/; ${needs}` };
  const named = candidates.filter(({ receipt }) => receipt.candidate.sha256 === headSha);
  if (!named.length) return { ok: false, reason: `no receipt names this ${TEMPLATE} (sha256 ${headSha.slice(0, 12)}); a receipt for an earlier version of the file does not count. ${needs}` };
  const problems: string[] = [];
  for (const { file, receipt } of named) {
    const here = `${file.path}: `;
    if (!RECEIPT_NAME.test(file.path.split("/").at(-1) ?? "")) { problems.push(`${here}the file name is <date>-routing-<sha8>.md`); continue; }
    if (receipt.corpus_hash !== corpus.hash) { problems.push(`${here}it was made for corpus ${receipt.corpus_hash.slice(0, 12)}, the corpus is ${corpus.hash.slice(0, 12)}; regenerate it`); continue; }
    if (receipt.base.sha256 !== baseSha) { problems.push(`${here}its current default (${receipt.base.sha256.slice(0, 12)}) is not the default at the merge base (${baseSha.slice(0, 12)}); regenerate it against the current default`); continue; }
    if (receipt.split !== "test") { problems.push(`${here}the promotion rule is read on the test split, not ${receipt.split}`); continue; }
    // The receipt may choose only two things the files do not determine: its date and the label of the base ref. Everything else, the configurations, the changed
    // keys, every metric and every per-case outcome, is REBUILT from the corpus and the two files, and the machine block and the whole document must equal that.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receipt.generated)) { problems.push(`${here}generated is a YYYY-MM-DD date`); continue; }
    if (typeof receipt.base.ref !== "string" || !/^[\w./~^@-]{1,100}$/.test(receipt.base.ref)) { problems.push(`${here}base.ref is a short git ref label`); continue; }
    if (!file.path.endsWith(`${receipt.generated}-routing-${headSha.slice(0, 8)}.md`)) { problems.push(`${here}the file name must be ${receipt.generated}-routing-${headSha.slice(0, 8)}.md (its date and the first 8 digits of the candidate's sha256)`); continue; }
    let again: Comparison, expected: Receipt;
    try {
      const { base, candidate } = parseConfigs(input.baseTemplate, input.headTemplate);
      again = compare(corpus, base, candidate, "test");
      const baseSummary = policySummary(base), candidateSummary = policySummary(candidate);
      expected = buildReceipt(corpus, again, { baseRef: receipt.base.ref, baseSha256: baseSha, candidateSha256: headSha, generated: receipt.generated, changedKeys: changedKeys(baseSummary, candidateSummary), base: baseSummary, candidate: candidateSummary });
    } catch (error) { problems.push(`${here}the templates do not parse: ${(error as Error).message}`); continue; }
    if (canonicalJson(receipt) !== canonicalJson(expected)) {
      const field = ["verdict", "primary", "secondary", "regressions", "guardRegressions", "improvements", "cases", "n", "reasons"].find(key => canonicalJson((receipt.evidence as Record<string, unknown>)?.[key]) !== canonicalJson((expected.evidence as Record<string, unknown>)[key]))
        ?? ["base", "candidate", "changed_keys", "served_models", "surface", "kind", "version", "split"].find(key => canonicalJson((receipt as unknown as Record<string, unknown>)[key]) !== canonicalJson((expected as unknown as Record<string, unknown>)[key])) ?? "an extra or missing field";
      problems.push(`${here}it is not what the corpus gives for these two files: ${field} differs (it says ${receipt.evidence?.verdict}, ${receipt.evidence?.primary?.candidateCorrect}/${receipt.evidence?.n}; recomputed ${again.verdict}, ${again.primary.candidateCorrect}/${again.n}); it was edited or made from other files. Regenerate it with routing-gate.ts --receipt`);
      continue;
    }
    // The human-readable part is rendered from the same data: a summary or table edited by hand no longer matches.
    if (normalize(file.text) !== normalize(renderReceipt(expected))) { problems.push(`${here}the text outside the machine block (the summary and the case table) is not what the gate renders for this data; it was edited. Regenerate it with routing-gate.ts --receipt`); continue; }
    if (again.verdict !== "pass") { problems.push(`${here}the promotion rule blocks this change: ${again.reasons.join("; ")}`); continue; }
    return { ok: true, note: `${file.path} matches: corpus ${corpus.hash.slice(0, 12)}, owner top-1 ${again.primary.baseCorrect}/${again.n} to ${again.primary.candidateCorrect}/${again.n}, no PII or refusal regression` };
  }
  return { ok: false, reason: problems.join("\n") };
}

// ---- the eval marker contract (#481 S5, src/hub/eval-gate.ts readEvalResult): `eval_pass_rate=<0..1>` and `eval_suite=<version>` in a completed check run's title or summary ----
export interface EvalReport { conclusion: "success" | "failure"; title: string; summary: string; passRate?: string; suite?: string }

/** A rate the hub's marker accepts: 0, 1, or 0.<1 to 6 digits>, never a percent sign or a fraction. */
export function formatRate(correct: number, n: number): string {
  if (!n) return "0";
  const text = (correct / n).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return text === "" ? "0" : text;
}

/**
 * What the `routing-eval` check run reports for this head: the owner top-1 accuracy of the HEAD's templates/routing.toml on the test split (a score of the shipped
 * default, not of the change), the corpus hash prefix as the suite version, and a conclusion that is the receipt check's own. With no readable corpus or template
 * there are no markers, so the hub shows the gap instead of a number nobody measured.
 */
export function evalReport(input: CheckInput, result: CheckResult): EvalReport {
  const conclusion = result.ok ? "success" : "failure";
  const verdict = result.ok ? result.note : result.reason;
  try {
    const corpus = validateCorpus(JSON.parse(input.corpusText));
    const text = input.headTemplate ?? input.baseTemplate;
    if (text === undefined) throw new Error(`${TEMPLATE} is missing`);
    const rows = evaluate(corpus, parseConfigs(text, text).base, "test");
    const correct = rows.filter(row => row.score.owner).length, passRate = formatRate(correct, rows.length), suite = corpus.hash.slice(0, 12);
    return { conclusion, passRate, suite, title: `${EVAL_CHECK_NAME} ${result.ok ? "passed" : "failed"} eval_pass_rate=${passRate} eval_suite=${suite}`,
      summary: `Owner top-1 accuracy of this head's ${TEMPLATE} on the test split: ${correct}/${rows.length}, corpus ${corpus.hash}. ${verdict}`.slice(0, 600) };
  } catch (error) {
    return { conclusion: "failure", title: `${EVAL_CHECK_NAME} could not run`, summary: `No pass rate was measured: ${(error as Error).message}`.slice(0, 600) };
  }
}

/** A `gh` call: arguments and optional stdin in, status and stdout out. Injected so the publisher is tested without a network. */
export type Gh = (args: string[], stdin?: string) => { code: number; stdout: string; stderr?: string };
export const realGh: Gh = (args, stdin) => {
  const run = spawnSync("gh", args, { encoding: "utf8", input: stdin, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

/**
 * Creates the `routing-eval` check run at `head`, or updates the one that is already there: the hub reads exactly one completed run of that name at a head, so a rerun
 * must replace its result and never add a second. Needs `checks: write`.
 */
export function publishEval(gh: Gh, repository: string, head: string, report: EvalReport): { id: number; action: "created" | "updated" } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.startsWith("-")) throw new Error("GITHUB_REPOSITORY is owner/name");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("the head is a full 40-digit commit sha");
  const found = gh(["api", `repos/${repository}/commits/${head}/check-runs?check_name=${EVAL_CHECK_NAME}&per_page=10`, "--jq", `[.check_runs[]|select(.name=="${EVAL_CHECK_NAME}")|.id]`]);
  if (found.code !== 0) throw new Error(`could not list check runs: ${(found.stderr ?? "").trim().slice(0, 200) || `gh exit ${found.code}`}`);
  const ids = JSON.parse(found.stdout.trim() || "[]") as number[];
  const body = JSON.stringify({ name: EVAL_CHECK_NAME, head_sha: head, status: "completed", conclusion: report.conclusion, output: { title: report.title, summary: report.summary } });
  const existing = ids[0];
  const write = existing === undefined
    ? gh(["api", "-X", "POST", `repos/${repository}/check-runs`, "--input", "-", "--jq", ".id"], body)
    : gh(["api", "-X", "PATCH", `repos/${repository}/check-runs/${existing}`, "--input", "-", "--jq", ".id"], body);
  if (write.code !== 0) throw new Error(`could not ${existing === undefined ? "create" : "update"} the ${EVAL_CHECK_NAME} check run: ${(write.stderr ?? "").trim().slice(0, 200) || `gh exit ${write.code}`}`);
  return { id: Number(write.stdout.trim()) || existing || 0, action: existing === undefined ? "created" : "updated" };
}

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const show = (root: string, ref: string, path: string): string | undefined => { try { return git(root, "show", `${ref}:${path}`); } catch { return undefined; } };

/** Reads git and the work tree into a CheckInput. `base` is the PR base (branch tip or sha); the merge base with HEAD is what the PR changes from. */
export function readInput(root: string, base: string): CheckInput {
  const mergeBase = git(root, "merge-base", base, "HEAD").trim();
  const changed = git(root, "diff", "--name-only", mergeBase, "HEAD").split("\n").filter(Boolean);
  const dir = join(root, RECEIPT_DIR);
  const receipts = readdirSync(dir).filter(name => /-routing-/.test(name) && name.endsWith(".md")).map(name => ({ path: `${RECEIPT_DIR}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
  return { changed, baseTemplate: show(root, mergeBase, TEMPLATE), headTemplate: show(root, "HEAD", TEMPLATE), corpusText: readFileSync(join(root, CORPUS_PATH), "utf8"), receipts };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2), publish = args.includes("--publish");
  const base = args.find(arg => !arg.startsWith("--")) ?? process.env.BASE_SHA ?? "origin/main";
  try {
    const input = readInput(root, base);
    const result = checkReceipt(input), report = evalReport(input, result);
    if (report.passRate !== undefined) console.log(`${EVAL_CHECK_NAME}: eval_pass_rate=${report.passRate} eval_suite=${report.suite}`);
    if (publish) {
      // A failed publish never hides the receipt verdict. It is a warning, and the hub then shows the eval gate as not reported (a gap, and a blocker in enforce).
      try {
        const head = process.env.HEAD_SHA || git(root, "rev-parse", "HEAD").trim();
        const done = publishEval(realGh, process.env.GITHUB_REPOSITORY ?? "", head, report);
        console.log(`${EVAL_CHECK_NAME}: ${done.action} check run ${done.id} at ${head.slice(0, 12)} (${report.conclusion})`);
      } catch (error) { console.log(`::warning title=${EVAL_CHECK_NAME} not published::${(error as Error).message}`); }
    }
    if (result.ok) { console.log(`routing receipt: OK (${result.note})`); process.exit(0); }
    console.error(`routing receipt: ${result.reason}`);
    process.exit(1);
  } catch (error) { console.error(`routing receipt: could not run the check (${(error as Error).message})`); process.exit(2); }
}
