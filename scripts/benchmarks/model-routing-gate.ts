#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatMessage } from "../../src/omniroute/client.ts";
import { OmniRoute } from "../../src/omniroute/client.ts";
import { parseRouting, type Routing } from "../../src/hub/routing.ts";
import { normalizeConversation } from "../../src/models/route/normalize.ts";
import { advisorJudgeRequest, escalationJudgeRequest, decodeAdvisorReply, decodeEscalationReply } from "../../src/models/route/judge.ts";
import { sha256 } from "./routing-corpus.ts";
import { changedModelKeys, compare, freezeModelCorpus, liveRequired, loadModelCorpus, modelRoutingSummary, type JudgeCase, type ModelRoutingCorpus, type Split } from "./model-routing-corpus.ts";
import { buildModelReceipt, compareLive, judgeAlias, liveProblem, renderModelReceipt, type LiveCase, type LiveEvidence, type LiveOutcome } from "./model-routing-receipt.ts";

// agent-hub #637 part 2 (hub task #324): the model-routing promotion gate.
//   bun scripts/benchmarks/model-routing-gate.ts                    the current default against itself on the test split: prints the numbers (no model is called)
//   bun scripts/benchmarks/model-routing-gate.ts --receipt [--base <ref>] [--out <file>] [--live]
//                                                                   compares the model-routing keys of templates/routing.toml in the work tree with the default at <ref> (default: the merge base
//                                                                   with origin/main) and writes docs/verification/<date>-modelrouting-<sha8>.md. Without --live the receipt says `live-not-run`.
//   bun scripts/benchmarks/model-routing-gate.ts --freeze           rewrites the corpus hash after an intended corpus change (every earlier receipt is then void)
// --live is the by-hand half: it asks the real judge model of each policy the corpus's judge cases, through the gateway, and writes the served model ids the gateway reported. It needs
// AGENTHUB_OMNIROUTE_URL and OMNIROUTE_API_KEY in the environment, exits 2 without them before any request, and refuses to write a receipt whose served id is missing or is the alias.
// Exit status: 0 when the verdict is pass, 1 when the promotion rule blocks, 2 on a usage, corpus or environment error.

const ROOT = resolve(import.meta.dir, "../..");
const CORPUS = join(ROOT, "scripts/benchmarks/model-routing-corpus.json");
export const TEMPLATE = "templates/routing.toml";

function arg(args: readonly string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
function templateAt(ref: string): string {
  try { return execFileSync("git", ["-C", ROOT, "show", `${ref}:${TEMPLATE}`], { encoding: "utf8" }); }
  catch { throw new Error(`${TEMPLATE} does not exist at ${ref}`); }
}
function defaultBase(): string {
  for (const ref of ["origin/main", "main"]) { try { return git("merge-base", ref, "HEAD"); } catch { /* try the next */ } }
  throw new Error("no origin/main or main to compare against; pass --base <ref>");
}

/** One model call: what was asked and what the gateway said, including the model it reports having served. */
export type JudgeChat = (alias: string, messages: ChatMessage[], maxTokens: number) => Promise<{ content: string; servedModel?: string }>;

/**
 * Asks each judge case of the split to each policy's judge alias and scores nothing itself: it records the verdict class. The served id of every answer comes from the response; an answer
 * without one is an error for that case, never an alias standing in. Judge requests are the real prompts (`advisorJudgeRequest`, `escalationJudgeRequest`), as `HubRouteRuntime` builds them.
 */
export async function runLive(corpus: ModelRoutingCorpus, base: Routing, candidate: Routing, chat: JudgeChat, split: Split = "test"): Promise<LiveEvidence> {
  const judges = corpus.cases.filter((c): c is JudgeCase => c.kind === "judge" && c.split === split);
  const served = new Map<string, Set<string>>();
  const ask = async (routing: Routing, c: JudgeCase): Promise<LiveOutcome> => {
    const alias = judgeAlias(routing, c);
    if (alias === undefined) throw new Error(`the policy has no route ${c.route}`);
    const conversation = normalizeConversation(c.messages);
    const request = c.judge === "advisor" ? advisorJudgeRequest(conversation, c.latest) : escalationJudgeRequest(conversation, c.turn ?? 1);
    let answer: { content: string; servedModel?: string };
    try { answer = await chat(alias, [{ role: "system", content: request.systemPrompt }, ...request.messages], request.maxOutputTokens); }
    catch (error) { return { alias, error: `the call failed: ${(error as Error).message}`.slice(0, 200) }; }
    if (!answer.servedModel) return { alias, error: "the gateway reported no served model for this call" };
    if (answer.servedModel === alias) return { alias, error: "the gateway reported the alias as the served model" };
    (served.get(alias) ?? served.set(alias, new Set()).get(alias)!).add(answer.servedModel);
    if (c.judge === "advisor") return { alias, verdict: decodeAdvisorReply(answer.content)?.kind ?? "unparsed" };
    const verdict = decodeEscalationReply(answer.content);
    return { alias, escalate: verdict ? verdict.escalate : "unparsed" };
  };
  const cases: LiveCase[] = [];
  for (const c of judges) cases.push({ id: c.id, ...(c.guard ? { guard: c.guard } : {}), base: await ask(base, c), candidate: await ask(candidate, c) });
  return { served_models: Object.fromEntries([...served].sort(([a], [b]) => a.localeCompare(b)).map(([alias, ids]) => [alias, [...ids].sort()])), cases };
}

/** The real gateway as a JudgeChat. Refuses, before any request, when the environment names no gateway or key. */
export function gatewayChat(env: Record<string, string | undefined> = process.env): JudgeChat {
  if (!env.AGENTHUB_OMNIROUTE_URL?.trim() || !env.OMNIROUTE_API_KEY?.trim()) throw new Error("--live needs AGENTHUB_OMNIROUTE_URL and OMNIROUTE_API_KEY in the environment (no request was made)");
  const client = new OmniRoute();
  return async (alias, messages, maxTokens) => {
    const result = await client.chat({ model: alias, messages, max_tokens: maxTokens, temperature: 0 }, { signal: AbortSignal.timeout(60_000) });
    return { content: result.message.content ?? "", ...(result.servedModel ? { servedModel: result.servedModel } : {}) };
  };
}

export interface GateOptions { args: readonly string[]; chat?: JudgeChat; now?: () => Date; root?: string }
export async function main(options: GateOptions): Promise<number> {
  const { args } = options, root = options.root ?? ROOT, corpusPath = join(root, "scripts/benchmarks/model-routing-corpus.json");
  if (args.includes("--freeze")) {
    const { hash, stale } = freezeModelCorpus(corpusPath);
    console.log(stale ? `corpus refrozen: hash ${hash}. Every receipt for the old hash is void: regenerate them.` : `corpus unchanged: hash ${hash}`);
    return 0;
  }
  const corpus = loadModelCorpus(corpusPath);
  const split = (arg(args, "--split") ?? "test") as Split;
  if (split !== "test" && split !== "train") { console.error("--split is test or train"); return 2; }
  if (!args.includes("--receipt")) {
    const text = readFileSync(join(root, TEMPLATE), "utf8"), routing = parseRouting(text);
    const result = await compare(corpus, routing, routing, split);
    console.log(`corpus ${corpus.hash.slice(0, 12)}: ${corpus.cases.length} cases (${corpus.cases.filter(c => c.kind === "judge").length} judge, scored only by --live), ${result.n} deterministic in the ${split} split`);
    console.log(`${result.primary.metric}: ${(result.primary.base * 100).toFixed(1)}% (${result.primary.baseCorrect}/${result.n})`);
    for (const row of result.cases.filter(c => !c.basePass)) console.log(`FAIL ${row.id}: ${JSON.stringify(row.base)}`);
    return result.cases.every(c => c.basePass) ? 0 : 1;
  }
  let chat = options.chat;
  if (args.includes("--live") && !chat) { try { chat = gatewayChat(); } catch (error) { console.error(`model-routing-gate: ${(error as Error).message}`); return 2; } }
  const baseRef = arg(args, "--base") ?? defaultBase();
  const baseText = templateAt(baseRef), candidateText = readFileSync(join(root, TEMPLATE), "utf8");
  const base = parseRouting(baseText), candidate = parseRouting(candidateText);
  const comparison = await compare(corpus, base, candidate, split);
  const changed = changedModelKeys(modelRoutingSummary(base), modelRoutingSummary(candidate));
  const needsLive = liveRequired(changed);
  let live: LiveEvidence | undefined;
  if (args.includes("--live")) {
    live = await runLive(corpus, base, candidate, chat!, split);
    const problem = liveProblem(corpus, base, candidate, live, split);
    if (problem) { console.error(`model-routing-gate: no receipt written: ${problem}`); return 2; }
  }
  const generated = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const receipt = buildModelReceipt(corpus, comparison, base, candidate, { baseRef, baseTemplateSha: sha256(baseText), candidateTemplateSha: sha256(candidateText), generated, changedKeys: changed, liveRequired: needsLive }, live);
  const out = arg(args, "--out") ?? join(root, "docs/verification", `${generated}-modelrouting-${receipt.candidate.sha256.slice(0, 8)}.md`);
  if (existsSync(out) && !args.includes("--force")) { console.error(`${out} exists; pass --force to replace it`); return 2; }
  writeFileSync(out, renderModelReceipt(receipt, corpus));
  console.log(`receipt: ${out}`);
  const liveVerdict = live ? compareLive(corpus, live, split) : undefined;
  const reasons = [...comparison.reasons, ...(liveVerdict?.reasons ?? [])];
  console.log(`verdict ${reasons.length ? "blocked" : "pass"}: ${comparison.primary.metric} ${(comparison.primary.base * 100).toFixed(1)}% -> ${(comparison.primary.candidate * 100).toFixed(1)}%${reasons.length ? `; ${reasons.join("; ")}` : ""}`);
  if (needsLive && !live) console.log("note: this change moves an alias or a judge, so CI will want the live half: rerun with --live (needs a gateway and key)");
  return reasons.length ? 1 : 0;
}

if (import.meta.main) {
  try { process.exit(await main({ args: process.argv.slice(2) })); }
  catch (error) { console.error(`model-routing-gate: ${(error as Error).message}`); process.exit(2); }
}
