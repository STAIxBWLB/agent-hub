#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildReceipt, changedKeys, compare, freezeCorpus, loadCorpus, parseConfigs, policySummary, renderReceipt, sha256, type Split } from "./routing-corpus.ts";

// agent-hub #637 part 1 (hub task #321): the task-routing promotion gate.
//   bun scripts/benchmarks/routing-gate.ts                         the current default against itself on the test split: prints the numbers
//   bun scripts/benchmarks/routing-gate.ts --receipt [--base <ref>] [--out <file>]
//                                                                  compares templates/routing.toml in the work tree with the default at <ref>
//                                                                  (default: the merge base with origin/main) and writes docs/verification/<date>-routing-<sha8>.md
//   bun scripts/benchmarks/routing-gate.ts --freeze                rewrites the corpus hash after an intended corpus change (every earlier receipt is then void)
// Exit status: 0 when the verdict is pass, 1 when the promotion rule blocks, 2 on a usage or corpus error. No clock but the date in the file name and no model is used.

const ROOT = resolve(import.meta.dir, "../..");
const CORPUS = join(ROOT, "scripts/benchmarks/routing-corpus.json");
const TEMPLATE = "templates/routing.toml";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string) => process.argv.includes(name);
const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

/** The template as committed at `ref`; a ref with no template is an error, never an empty policy. */
function templateAt(ref: string): string {
  try { return execFileSync("git", ["-C", ROOT, "show", `${ref}:${TEMPLATE}`], { encoding: "utf8" }); }
  catch { throw new Error(`${TEMPLATE} does not exist at ${ref}`); }
}
function defaultBase(): string {
  for (const ref of ["origin/main", "main"]) { try { return git("merge-base", ref, "HEAD"); } catch { /* try the next */ } }
  throw new Error("no origin/main or main to compare against; pass --base <ref>");
}

async function main(): Promise<number> {
  if (flag("--freeze")) {
    const { hash, stale } = freezeCorpus(CORPUS);
    console.log(stale ? `corpus refrozen: hash ${hash}. Every receipt for the old hash is void: regenerate them.` : `corpus unchanged: hash ${hash}`);
    return 0;
  }
  const corpus = loadCorpus(CORPUS);
  const split = (arg("--split") ?? "test") as Split;
  if (split !== "test" && split !== "train") { console.error("--split is test or train"); return 2; }
  if (!flag("--receipt")) {
    const text = readFileSync(join(ROOT, TEMPLATE), "utf8");
    const { base } = parseConfigs(text, text);
    const result = compare(corpus, base, base, split);
    console.log(`corpus ${corpus.hash.slice(0, 12)}: ${corpus.cases.length} cases, ${result.n} in the ${split} split`);
    console.log(`${result.primary.metric}: ${(result.primary.base * 100).toFixed(1)}% (${result.primary.baseCorrect}/${result.n})`);
    console.log(`reviewer accuracy (${result.secondary.reviewer.n}): ${(result.secondary.reviewer.base * 100).toFixed(1)}%; whole-case pass rate: ${(result.secondary.fullCase.base * 100).toFixed(1)}%`);
    for (const row of result.cases.filter(c => !c.basePass)) console.log(`FAIL ${row.id}: expected ${JSON.stringify(row.expect)}, got owner ${row.base.owner}, reviewer ${row.base.reviewer}, refusals ${row.base.refusals.join(",") || "none"}`);
    return result.cases.every(c => c.basePass) ? 0 : 1;
  }
  const baseRef = arg("--base") ?? defaultBase();
  const baseText = templateAt(baseRef), candidateText = readFileSync(join(ROOT, TEMPLATE), "utf8");
  const { base, candidate } = parseConfigs(baseText, candidateText);
  const comparison = compare(corpus, base, candidate, split);
  const baseSummary = policySummary(base), candidateSummary = policySummary(candidate);
  const generated = new Date().toISOString().slice(0, 10);
  const receipt = buildReceipt(corpus, comparison, { baseRef, baseSha256: sha256(baseText), candidateSha256: sha256(candidateText), generated, changedKeys: changedKeys(baseSummary, candidateSummary), base: baseSummary, candidate: candidateSummary });
  const out = arg("--out") ?? join(ROOT, "docs/verification", `${generated}-routing-${receipt.candidate.sha256.slice(0, 8)}.md`);
  if (existsSync(out) && !flag("--force")) { console.error(`${out} exists; pass --force to replace it`); return 2; }
  writeFileSync(out, renderReceipt(receipt));
  console.log(`receipt: ${out}`);
  console.log(`verdict ${comparison.verdict}: ${comparison.primary.metric} ${(comparison.primary.base * 100).toFixed(1)}% -> ${(comparison.primary.candidate * 100).toFixed(1)}%${comparison.reasons.length ? `; ${comparison.reasons.join("; ")}` : ""}`);
  return comparison.verdict === "pass" ? 0 : 1;
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (error) { console.error(`routing-gate: ${(error as Error).message}`); process.exit(2); }
}
