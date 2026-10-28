#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compare, parseConfigs, parseReceipt, sha256, validateCorpus, type Corpus } from "./benchmarks/routing-corpus.ts";

// agent-hub #637 part 1 (hub task #321): fail a PR that changes templates/routing.toml without a receipt that matches it.
// The rule is the "Routing promotion rule" in docs/agent-notes/benchmarks.md. No model runs here: the check reads files and git, and RECOMPUTES the comparison from the
// corpus and the two templates, so a receipt that was edited by hand cannot pass. Run by .github/workflows/routing-receipt.yml; by hand: `bun scripts/check-routing-receipt.ts [<base>]`.

export const TEMPLATE = "templates/routing.toml";
export const CORPUS_PATH = "scripts/benchmarks/routing-corpus.json";
export const RECEIPT_DIR = "docs/verification";
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
  const candidates = input.receipts.flatMap(file => { const receipt = parseReceipt(file.text); return receipt ? [{ file, receipt }] : []; });
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
    let again;
    try { const { base, candidate } = parseConfigs(input.baseTemplate, input.headTemplate); again = compare(corpus, base, candidate, "test"); }
    catch (error) { problems.push(`${here}the templates do not parse: ${(error as Error).message}`); continue; }
    const stated = receipt.evidence;
    if (stated.verdict !== again.verdict || stated.primary.baseCorrect !== again.primary.baseCorrect || stated.primary.candidateCorrect !== again.primary.candidateCorrect
      || stated.n !== again.n || JSON.stringify(stated.regressions) !== JSON.stringify(again.regressions) || JSON.stringify(stated.guardRegressions) !== JSON.stringify(again.guardRegressions)) {
      problems.push(`${here}its numbers are not what the corpus gives for these two files (it says ${stated.verdict}, ${stated.primary.candidateCorrect}/${stated.n}; recomputed ${again.verdict}, ${again.primary.candidateCorrect}/${again.n}); it was edited or made from other files`);
      continue;
    }
    if (again.verdict !== "pass") { problems.push(`${here}the promotion rule blocks this change: ${again.reasons.join("; ")}`); continue; }
    return { ok: true, note: `${file.path} matches: corpus ${corpus.hash.slice(0, 12)}, owner top-1 ${again.primary.baseCorrect}/${again.n} to ${again.primary.candidateCorrect}/${again.n}, no PII or refusal regression` };
  }
  return { ok: false, reason: problems.join("\n") };
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
  const base = process.argv[2] ?? process.env.BASE_SHA ?? "origin/main";
  try {
    const result = checkReceipt(readInput(root, base));
    if (result.ok) { console.log(`routing receipt: OK (${result.note})`); process.exit(0); }
    console.error(`routing receipt: ${result.reason}`);
    process.exit(1);
  } catch (error) { console.error(`routing receipt: could not run the check (${(error as Error).message})`); process.exit(2); }
}
