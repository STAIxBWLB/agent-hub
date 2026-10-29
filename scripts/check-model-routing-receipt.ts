#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseRouting } from "../src/hub/routing.ts";
import { canonicalJson, sha256 } from "./benchmarks/routing-corpus.ts";
import { changedModelKeys, compare, liveRequired, modelRoutingSha, modelRoutingSummary, validateModelCorpus } from "./benchmarks/model-routing-corpus.ts";
import { buildModelReceipt, compareLive, LIVE_NOT_RUN, liveProblem, parseModelReceipt, renderModelReceipt } from "./benchmarks/model-routing-receipt.ts";

/** Line endings and trailing blank lines are not content: a checkout that rewrites them must not fail a receipt. */
const normalize = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\s+$/, "");

// agent-hub #637 part 2 (hub task #324): fail a PR that changes the MODEL-ROUTING keys of templates/routing.toml without a receipt that matches them. The rule is the "Model-routing promotion
// rule" in docs/agent-notes/benchmarks.md. No model runs here: the check reads files and git and REBUILDS the deterministic comparison from the corpus and the two templates. The live half (what a
// judge model answered, and which model the gateway served) is produced by hand with `model-routing-gate.ts --live`; CI checks its shape and consistency, never the claim that a model said it.
// Run by .github/workflows/routing-receipt.yml; by hand: `bun scripts/check-model-routing-receipt.ts [<base>]`.

export const TEMPLATE = "templates/routing.toml";
export const CORPUS_PATH = "scripts/benchmarks/model-routing-corpus.json";
export const RECEIPT_DIR = "docs/verification";
const RECEIPT_NAME = /^\d{4}-\d{2}-\d{2}-modelrouting-[0-9a-f]{8}\.md$/;

export interface CheckInput {
  /** Repo-relative paths the PR changes against its merge base. */
  changed: readonly string[];
  baseTemplate: string | undefined;
  headTemplate: string | undefined;
  corpusText: string;
  /** Every `docs/verification/*-modelrouting-*.md` at the head. */
  receipts: readonly { path: string; text: string }[];
}
export type CheckResult = { ok: true; note: string } | { ok: false; reason: string };

/** The decision. A pure function of its input: the same input always gives the same answer, and nothing in it touches the network. */
export async function checkModelReceipt(input: CheckInput): Promise<CheckResult> {
  // A receipt is a file anyone can edit: whatever shape it has, the answer is a reason, never an exception.
  try { return await decide(input); } catch (error) { return { ok: false, reason: `the receipt could not be checked: ${(error as Error).message}` }; }
}
async function decide(input: CheckInput): Promise<CheckResult> {
  if (!input.changed.includes(TEMPLATE)) return { ok: true, note: `${TEMPLATE} is unchanged: no model-routing receipt is needed` };
  if (input.headTemplate === undefined) return { ok: false, reason: `${TEMPLATE} was deleted; the shipped routing default cannot be removed` };
  if (input.baseTemplate === undefined) return { ok: false, reason: `${TEMPLATE} did not exist at the merge base, so there is no current default to compare against; run bun scripts/benchmarks/model-routing-gate.ts --receipt` };
  let base, candidate;
  try { base = parseRouting(input.baseTemplate); candidate = parseRouting(input.headTemplate); }
  catch (error) { return { ok: false, reason: `the templates do not parse: ${(error as Error).message}` }; }
  const baseSummary = modelRoutingSummary(base), candidateSummary = modelRoutingSummary(candidate);
  const baseKeys = modelRoutingSha(base), headKeys = modelRoutingSha(candidate);
  // Task-routing keys (peers, signals, constraints) are part 1's. A change that leaves every model-routing key as it was needs no model-routing receipt.
  if (baseKeys === headKeys) return { ok: true, note: `${TEMPLATE} changed but no model-routing key did: no model-routing receipt is needed` };
  const needs = `the model-routing keys of ${TEMPLATE} changed (${changedModelKeys(baseSummary, candidateSummary).join(", ")}), so this PR needs a model-routing receipt (bun scripts/benchmarks/model-routing-gate.ts --receipt, then commit the file it writes under ${RECEIPT_DIR}/)`;
  // The frozen corpus is the measuring stick: it does not change in the same PR as the default it measures.
  if (input.changed.includes(CORPUS_PATH)) return { ok: false, reason: `${CORPUS_PATH} changes in the same PR as the model-routing keys; a frozen corpus is never edited together with the default it measures. Land the corpus change first (with its refreeze), then the default.` };
  let corpus;
  try { corpus = validateModelCorpus(JSON.parse(input.corpusText)); }
  catch (error) { const message = (error as Error).message; return { ok: false, reason: message.startsWith("model-routing corpus") ? message : `model-routing corpus ${CORPUS_PATH} cannot be read: ${message}` }; }
  const candidates = input.receipts.flatMap(file => { const receipt = parseModelReceipt(file.text.replace(/\r\n/g, "\n")); return receipt ? [{ file, receipt }] : []; });
  if (!candidates.length) return { ok: false, reason: `no model-routing receipt under ${RECEIPT_DIR}/; ${needs}` };
  const named = candidates.filter(({ receipt }) => receipt.candidate.sha256 === headKeys);
  if (!named.length) return { ok: false, reason: `no receipt names these model-routing keys (sha256 ${headKeys.slice(0, 12)}); a receipt for an earlier version of them does not count. ${needs}` };
  const problems: string[] = [];
  const baseTemplateSha = sha256(input.baseTemplate), headTemplateSha = sha256(input.headTemplate);
  for (const { file, receipt } of named) {
    const here = `${file.path}: `;
    if (!RECEIPT_NAME.test(file.path.split("/").at(-1) ?? "")) { problems.push(`${here}the file name is <date>-modelrouting-<sha8>.md`); continue; }
    if (receipt.corpus_hash !== corpus.hash) { problems.push(`${here}it was made for corpus ${receipt.corpus_hash.slice(0, 12)}, the corpus is ${corpus.hash.slice(0, 12)}; regenerate it`); continue; }
    if (receipt.base.sha256 !== baseKeys) { problems.push(`${here}its current default (${receipt.base.sha256.slice(0, 12)}) is not the default at the merge base (${baseKeys.slice(0, 12)}); regenerate it against the current default`); continue; }
    if (receipt.split !== "test") { problems.push(`${here}the promotion rule is read on the test split, not ${receipt.split}`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receipt.generated)) { problems.push(`${here}generated is a YYYY-MM-DD date`); continue; }
    if (typeof receipt.base.ref !== "string" || !/^[\w./~^@-]{1,100}$/.test(receipt.base.ref)) { problems.push(`${here}base.ref is a short git ref label`); continue; }
    if (!file.path.endsWith(`${receipt.generated}-modelrouting-${headKeys.slice(0, 8)}.md`)) { problems.push(`${here}the file name must be ${receipt.generated}-modelrouting-${headKeys.slice(0, 8)}.md (its date and the first 8 digits of the candidate's model-routing sha256)`); continue; }
    // The live block is the one thing the files do not determine, so it is taken from the receipt and checked for shape and consistency; everything else is rebuilt.
    const changed = changedModelKeys(baseSummary, candidateSummary), needsLive = liveRequired(changed);
    const claimsLive = receipt.served_models !== LIVE_NOT_RUN || receipt.live !== undefined;
    if (needsLive && !claimsLive) { problems.push(`${here}the change moves ${changed.filter(path => liveRequired([path])).join(", ")}, so a model answers differently: the receipt needs the live half (model-routing-gate.ts --receipt --live), and it says ${LIVE_NOT_RUN}`); continue; }
    if (claimsLive) {
      const problem = liveProblem(corpus, base, candidate, receipt.live, "test");
      if (problem) { problems.push(`${here}the live half is not valid: ${problem}`); continue; }
      if (canonicalJson(receipt.served_models) !== canonicalJson(receipt.live!.served_models)) { problems.push(`${here}served_models is not the served ids of the live block`); continue; }
    }
    const again = await compare(corpus, base, candidate, "test");
    const expected = buildModelReceipt(corpus, again, base, candidate, { baseRef: receipt.base.ref, baseTemplateSha, candidateTemplateSha: headTemplateSha, generated: receipt.generated, changedKeys: changed, liveRequired: needsLive }, claimsLive ? receipt.live : undefined);
    if (canonicalJson(receipt) !== canonicalJson(expected)) {
      const field = ["verdict", "primary", "secondary", "regressions", "guardRegressions", "improvements", "cases", "n", "reasons"].find(key => canonicalJson((receipt.evidence as unknown as Record<string, unknown>)?.[key]) !== canonicalJson((expected.evidence as unknown as Record<string, unknown>)[key]))
        ?? ["base", "candidate", "changed_keys", "live_required", "overall", "served_models", "surface", "kind", "version", "split"].find(key => canonicalJson((receipt as unknown as Record<string, unknown>)[key]) !== canonicalJson((expected as unknown as Record<string, unknown>)[key])) ?? "a field";
      problems.push(`${here}it is not what the corpus gives for these two files: ${field} differs (it says ${receipt.evidence?.verdict}, ${receipt.evidence?.primary?.candidateCorrect}/${receipt.evidence?.n}; recomputed ${again.verdict}, ${again.primary.candidateCorrect}/${again.n}). Regenerate it with model-routing-gate.ts --receipt.`);
      continue;
    }
    if (normalize(file.text) !== normalize(renderModelReceipt(expected, corpus))) { problems.push(`${here}the text outside the machine block (the summary and the case tables) is not what the gate renders for this data; it was edited. Regenerate it with model-routing-gate.ts --receipt.`); continue; }
    if (again.verdict !== "pass") { problems.push(`${here}the promotion rule blocks this change: ${again.reasons.join("; ")}`); continue; }
    if (claimsLive) {
      const live = compareLive(corpus, receipt.live!, "test");
      if (live.verdict !== "pass") { problems.push(`${here}the promotion rule blocks this change on the judge cases: ${live.reasons.join("; ")}`); continue; }
    }
    return { ok: true, note: `${file.path} matches: corpus ${corpus.hash.slice(0, 12)}, deterministic ${again.primary.baseCorrect}/${again.n} to ${again.primary.candidateCorrect}/${again.n}, no PII or hard-override regression, live half ${claimsLive ? "recorded" : LIVE_NOT_RUN}` };
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
  const receipts = readdirSync(dir).filter(name => /-modelrouting-/.test(name) && name.endsWith(".md")).map(name => ({ path: `${RECEIPT_DIR}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
  return { changed, baseTemplate: show(root, mergeBase, TEMPLATE), headTemplate: show(root, "HEAD", TEMPLATE), corpusText: readFileSync(join(root, CORPUS_PATH), "utf8"), receipts };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  const base = args.find(arg => !arg.startsWith("--")) ?? process.env.BASE_SHA ?? "origin/main";
  try {
    const result = await checkModelReceipt(readInput(root, base));
    if (result.ok) { console.log(`model-routing receipt: OK (${result.note})`); process.exit(0); }
    console.error(`model-routing receipt: ${result.reason}`);
    process.exit(1);
  } catch (error) { console.error(`model-routing receipt: could not run the check (${(error as Error).message})`); process.exit(2); }
}
