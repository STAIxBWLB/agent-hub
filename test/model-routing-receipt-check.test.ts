import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRouting } from "../src/hub/routing.ts";
import { sha256 } from "../scripts/benchmarks/routing-corpus.ts";
import { changedModelKeys, compare, liveRequired, loadModelCorpus, modelRoutingSha, modelRoutingSummary, type JudgeCase } from "../scripts/benchmarks/model-routing-corpus.ts";
import { buildModelReceipt, LIVE_NOT_RUN, modelReceiptShape, parseModelReceipt, renderModelReceipt, type LiveEvidence, type ModelReceipt } from "../scripts/benchmarks/model-routing-receipt.ts";
import { runLive, type JudgeChat } from "../scripts/benchmarks/model-routing-gate.ts";
import { checkModelReceipt, CORPUS_PATH, readInput, RECEIPT_DIR, TEMPLATE, type CheckInput } from "../scripts/check-model-routing-receipt.ts";

// agent-hub #637 part 2 (hub task #324): a PR that changes the model-routing keys of templates/routing.toml needs a matching receipt. The check is pure over a CheckInput; the git reader and the
// script are exercised on real repositories below, which is how a fake PR is shown to fail. No test here, and no check, touches the network.
const ROOT = join(import.meta.dir, "..");
const BASE = readFileSync(join(ROOT, TEMPLATE), "utf8");
const CORPUS_TEXT = readFileSync(join(ROOT, CORPUS_PATH), "utf8");
const corpus = loadModelCorpus(join(ROOT, CORPUS_PATH));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const swap = (text: string, from: string, to: string) => { expect(text).toContain(from); return text.replace(from, to); };
/** A change only task routing sees: peer order in a class. Not a model-routing key. */
const TASK_ONLY = swap(BASE, 'peers = ["claude", "codex"]\nlocal_allowed = false\n\n[classes.implement]', 'peers = ["codex", "claude"]\nlocal_allowed = false\n\n[classes.implement]');
/** A deterministic model-routing change the corpus passes: a longer capable hold. */
const HOLD = swap(BASE, "hold_turns = 2", "hold_turns = 3");
/** A change the corpus sees and blocks. */
const BAD = swap(BASE, "confirmations = 2", "confirmations = 1");
/** A change that moves what a judge model is: the advisor's capable alias. */
const ALIAS = swap(BASE, 'type = "advisor"\nefficient = "fast"\ncapable = "coding"', 'type = "advisor"\nefficient = "fast"\ncapable = "fast"');

const sound: JudgeChat = async (alias, messages) => ({ content: String(messages[0]!.content).startsWith("You are a senior") ? "REDO: show the test run" : JSON.stringify({ escalate: false, category: "none", new_evidence: false, reason: "ok" }), servedModel: `served/${alias}-v1` });
const live = (base: string, head: string, chat: JudgeChat = sound): Promise<LiveEvidence> => runLive(corpus, parseRouting(base), parseRouting(head), chat, "test");

/** A real receipt for (base, head), exactly as `model-routing-gate.ts --receipt` writes it. */
async function receiptFor(base: string, head: string, evidence?: LiveEvidence, patch: (r: ModelReceipt) => void = () => {}) {
  const a = parseRouting(base), b = parseRouting(head);
  const changed = changedModelKeys(modelRoutingSummary(a), modelRoutingSummary(b));
  const receipt = buildModelReceipt(corpus, await compare(corpus, a, b, "test"), a, b, { baseRef: "merge-base", baseTemplateSha: sha256(base), candidateTemplateSha: sha256(head), generated: "2026-10-29", changedKeys: changed, liveRequired: liveRequired(changed) }, evidence);
  patch(receipt);
  return { path: `${RECEIPT_DIR}/2026-10-29-modelrouting-${modelRoutingSha(b).slice(0, 8)}.md`, text: renderModelReceipt(receipt, corpus) };
}
const input = (head: string, receipts: CheckInput["receipts"], over: Partial<CheckInput> = {}): CheckInput => ({ changed: [TEMPLATE], baseTemplate: BASE, headTemplate: head, corpusText: CORPUS_TEXT, receipts, ...over });
const reason = (result: Awaited<ReturnType<typeof checkModelReceipt>>) => (result.ok ? "" : result.reason);
/** Rewrites a receipt's machine block through `edit` and leaves the rest of the document as the gate wrote it. */
const withBlock = (text: string, edit: (receipt: Record<string, any>) => void): string => {
  const match = /```json receipt\n([\s\S]*?)\n```/.exec(text)!;
  const value = JSON.parse(match[1]!);
  edit(value);
  return text.replace(match[1]!, JSON.stringify(value, null, 2));
};

test("a PR that does not touch templates/routing.toml needs no receipt", async () => {
  expect(await checkModelReceipt(input(BASE, [], { changed: ["README.md"] }))).toMatchObject({ ok: true });
});
test("a template change that leaves every model-routing key alone needs no model-routing receipt: it is part 1's", async () => {
  const result = await checkModelReceipt(input(TASK_ONLY, []));
  expect(result).toMatchObject({ ok: true });
  expect(result.ok && result.note).toContain("no model-routing key did");
  expect(await checkModelReceipt(input(swap(BASE, "# agent-hub routing:", "# agent-hub routing (reworded):"), []))).toMatchObject({ ok: true });
});
test("a model-routing change with no receipt fails, names the keys that changed and says how to make one", async () => {
  const result = await checkModelReceipt(input(HOLD, []));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("no model-routing receipt");
  expect(reason(result)).toContain("hub_routes.hub/stage.hold_turns");
  expect(reason(result)).toContain("model-routing-gate.ts --receipt");
});
test("a matching receipt for a deterministic change is accepted with the live half marked not run", async () => {
  const result = await checkModelReceipt(input(HOLD, [await receiptFor(BASE, HOLD)]));
  expect(result).toMatchObject({ ok: true });
  expect(result.ok && result.note).toContain("live half live-not-run");
});
test("a change to an alias is refused with a live-not-run receipt, and accepted with a live half whose served ids are real", async () => {
  const notRun = await checkModelReceipt(input(ALIAS, [await receiptFor(BASE, ALIAS)]));
  expect(notRun.ok).toBe(false);
  expect(reason(notRun)).toContain("needs the live half");
  expect(reason(notRun)).toContain("hub_routes.hub/advisor.capable");
  expect(reason(notRun)).toContain("live-not-run");
  const ok = await checkModelReceipt(input(ALIAS, [await receiptFor(BASE, ALIAS, await live(BASE, ALIAS))]));
  expect(ok).toMatchObject({ ok: true });
  expect(ok.ok && ok.note).toContain("live half recorded");
});
test("a live half that is wrong is refused: an alias as the served id, a served id missing, a failed call, a judge that now misses a case", async () => {
  const good = await live(BASE, ALIAS);
  const bad = async (mutate: (l: LiveEvidence) => void) => { const l: LiveEvidence = JSON.parse(JSON.stringify(good)); mutate(l); return reason(await checkModelReceipt(input(ALIAS, [await receiptFor(BASE, ALIAS, l)]))); };
  expect(await bad(l => { l.served_models.coding = ["coding"]; })).toContain("is the alias itself");
  expect(await bad(l => { delete l.served_models.fast; })).toContain("no served model id is recorded for alias fast");
  expect(await bad(l => { l.cases[0]!.candidate = { alias: "fast", error: "HTTP 503" }; })).toContain("has no answer");
  const judge = corpus.cases.find((c): c is JudgeCase => c.kind === "judge" && c.guard === "injection")!;
  expect(await bad(l => { l.cases.find(c => c.id === judge.id)!.candidate = { alias: "fast", verdict: "approve" }; })).toContain("blocks this change on the judge cases");
});
test("a receipt that hides the live half behind served_models, or whose served_models differs from its live block, is refused", async () => {
  const good = await live(BASE, ALIAS);
  const claimed = await receiptFor(BASE, ALIAS, good);
  const text = withBlock(claimed.text, r => { r.served_models = { coding: ["served/other"], fast: ["served/fast-v1"] }; });
  expect(reason(await checkModelReceipt(input(ALIAS, [{ path: claimed.path, text }])))).toContain("served_models is not the served ids of the live block");
  const dropped = withBlock(claimed.text, r => { delete r.live; });
  expect(reason(await checkModelReceipt(input(ALIAS, [{ path: claimed.path, text: dropped }])))).toContain("the live block is missing");
});
test("a receipt for an earlier version of the keys does not count, nor does one made against another current default or another corpus", async () => {
  const earlier = await receiptFor(BASE, HOLD);
  const amended = swap(HOLD, "hold_turns = 3", "hold_turns = 4");
  expect(reason(await checkModelReceipt(input(amended, [earlier])))).toContain("no receipt names these model-routing keys");
  const otherBase = swap(BASE, "max_reviews = 1", "max_reviews = 2");
  const against = await receiptFor(otherBase, swap(otherBase, "hold_turns = 2", "hold_turns = 3"));
  expect(reason(await checkModelReceipt(input(swap(otherBase, "hold_turns = 2", "hold_turns = 3"), [against], { baseTemplate: BASE })))).toContain("is not the default at the merge base");
  const forged = withBlock((await receiptFor(BASE, HOLD)).text, r => { r.corpus_hash = "0".repeat(64); });
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: earlier.path, text: forged }])))).toContain("it was made for corpus");
});
test("a receipt on the train split is refused: the rule is read on the test split", async () => {
  const receipt = await receiptFor(BASE, HOLD);
  const text = withBlock(receipt.text, r => { r.split = "train"; });
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: receipt.path, text }])))).toContain("test split");
});
test("a change the promotion rule blocks fails even with an honest receipt that says so, and the reason names the regressions", async () => {
  const honest = await receiptFor(BASE, BAD);
  expect(honest.text).toContain("Verdict: **blocked**");
  const result = await checkModelReceipt(input(BAD, [honest]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("promotion rule blocks this change");
  expect(reason(result)).toContain("pass rate fell");
});
test("a receipt edited by hand to say pass is caught: the check recomputes the numbers from the two files", async () => {
  const honest = await receiptFor(BASE, BAD);
  const forged = withBlock(honest.text, r => { r.evidence.verdict = "pass"; r.evidence.reasons = []; r.evidence.primary.candidateCorrect = r.evidence.n; r.evidence.primary.candidate = 1; r.evidence.regressions = []; r.evidence.guardRegressions = []; });
  const result = await checkModelReceipt(input(BAD, [{ path: honest.path, text: forged }]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("it is not what the corpus gives for these two files");
  expect(reason(result)).toContain("differs");
});
const TAMPER: [string, (r: Record<string, any>) => void, RegExp][] = [
  ["the base configuration", r => { r.base.config.stay_switch = "off"; }, /base differs/],
  ["the candidate configuration", r => { r.candidate.config.local.route = "hub/plan"; }, /candidate differs/],
  ["the changed keys", r => { r.changed_keys = []; }, /changed_keys differs/],
  ["the live_required flag", r => { r.live_required = true; }, /live_required differs/],
  ["one case's outcome", r => { r.evidence.cases[0].candidate = { route: "x", model: "y" }; }, /cases differs/],
  ["the improvements", r => { r.evidence.improvements = ["invented"]; }, /improvements differs/],
  ["the kind of surface", r => { r.surface = "task-routing"; }, /surface differs/],
  ["the template digest", r => { r.candidate.template_sha256 = "f".repeat(64); }, /candidate differs/],
];
for (const [name, edit, message] of TAMPER) {
  test(`tampering with ${name} is caught by the rebuild`, async () => {
    const real = await receiptFor(BASE, HOLD);
    const result = await checkModelReceipt(input(HOLD, [{ path: real.path, text: withBlock(real.text, edit) }]));
    expect(result.ok).toBe(false);
    expect(reason(result)).toMatch(message);
  });
}
test("the human-readable part cannot be edited either: a summary or case table that disagrees with the data is refused", async () => {
  const real = await receiptFor(BASE, HOLD);
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: real.path, text: swap(real.text, "Verdict: **pass**", "Verdict: **pass** (reviewed by a person)") }])))).toContain("outside the machine block");
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: real.path, text: swap(real.text, "| stage-fresh-task-efficient |  | efficient/default ok | efficient/default ok |", "| stage-fresh-task-efficient |  | efficient/default ok | capable/override ok |") }])))).toContain("outside the machine block");
  // line endings and trailing blank lines are not content
  expect(await checkModelReceipt(input(HOLD, [{ path: real.path, text: real.text.replace(/\n/g, "\r\n") + "\r\n\r\n" }]))).toMatchObject({ ok: true });
});
test("the receipt's own choices are bounded: a malformed date or base label, and a file name that does not carry them, are refused", async () => {
  const real = await receiptFor(BASE, HOLD);
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: real.path, text: withBlock(real.text, r => { r.generated = "yesterday"; }) }])))).toContain("YYYY-MM-DD");
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: real.path, text: withBlock(real.text, r => { r.base.ref = "not a ref; rm -rf"; }) }])))).toContain("base.ref");
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: `${RECEIPT_DIR}/2026-10-30-modelrouting-${modelRoutingSha(parseRouting(HOLD)).slice(0, 8)}.md`, text: real.text }])))).toContain("the file name must be");
  expect(reason(await checkModelReceipt(input(HOLD, [{ path: `${RECEIPT_DIR}/notes.md`, text: real.text }])))).toContain("<date>-modelrouting-<sha8>.md");
});
test("the corpus is never changed in the same PR as the keys it measures, and a corpus whose hash was not refrozen fails", async () => {
  const real = await receiptFor(BASE, HOLD);
  expect(reason(await checkModelReceipt(input(HOLD, [real], { changed: [TEMPLATE, CORPUS_PATH] })))).toContain("never edited together");
  const stale = JSON.parse(CORPUS_TEXT); stale.cases[0].note = "A reworded note without a refreeze.";
  expect(reason(await checkModelReceipt(input(HOLD, [real], { corpusText: JSON.stringify(stale) })))).toContain("hash mismatch");
  expect(reason(await checkModelReceipt(input(HOLD, [real], { corpusText: "not json" })))).toContain("model-routing corpus");
});
test("a deleted or newly created template and templates that do not parse give their own reason, never an exception", async () => {
  expect(reason(await checkModelReceipt(input(BASE, [], { headTemplate: undefined })))).toContain("was deleted");
  expect(reason(await checkModelReceipt(input(BASE, [], { baseTemplate: undefined })))).toContain("did not exist at the merge base");
  expect(reason(await checkModelReceipt(input("[hub_routes.\"hub/x\"]\ntype = \"nonsense\"\n", [])))).not.toBe("");
  expect(reason(await checkModelReceipt(input("this = = not toml", [])))).toContain("do not parse");
});
test("one matching receipt is enough, and the reasons of the others are reported only if none matches", async () => {
  const good = await receiptFor(BASE, HOLD);
  const junk = { path: `${RECEIPT_DIR}/2026-10-01-modelrouting-deadbeef.md`, text: "no block here" };
  expect(await checkModelReceipt(input(HOLD, [junk, good]))).toMatchObject({ ok: true });
  const forged = { path: good.path, text: withBlock(good.text, r => { r.evidence.n = 1; }) };
  const result = await checkModelReceipt(input(HOLD, [junk, forged]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("differs");
});
const MALFORMED: [string, (r: Record<string, any>) => void][] = [
  ["a null evidence", r => { r.evidence = null; }],
  ["an evidence that is a list", r => { r.evidence = []; }],
  ["a candidate that is a string", r => { r.candidate = "x"; }],
  ["a base digest that is not hex", r => { r.base.sha256 = "zz"; }],
  ["a missing live_required", r => { delete r.live_required; }],
  ["a split that is a number", r => { r.split = 3; }],
  ["a live block that is a string", r => { r.live = "x"; r.served_models = { coding: ["a"] }; }],
  ["a live block of the wrong shape", r => { r.live = { served_models: [], cases: 3 }; r.served_models = { a: ["b"] }; }],
];
for (const [name, edit] of MALFORMED) {
  test(`a receipt with ${name} is skipped or refused with a reason and never throws`, async () => {
    const real = await receiptFor(BASE, HOLD);
    const result = await checkModelReceipt(input(HOLD, [{ path: real.path, text: withBlock(real.text, edit) }]));
    expect(result.ok).toBe(false);
    expect(reason(result)).not.toBe("");
  });
}
test("modelReceiptShape accepts a real receipt and refuses non-objects and part 1's receipts", async () => {
  const real = parseModelReceipt((await receiptFor(BASE, HOLD)).text)!;
  expect(modelReceiptShape(real)).toBe(true);
  for (const value of [null, 3, "x", [], {}, { ...real, kind: "routing-receipt" }, { ...real, version: 2 }]) expect(modelReceiptShape(value)).toBe(false);
  expect(real.served_models).toBe(LIVE_NOT_RUN);
  expect(parseModelReceipt("```json receipt\n{not json\n```")).toBeUndefined();
});

// ---- real repositories: the git reader, the script and the workflow ----
function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "ahub-model-receipt-")); dirs.push(dir);
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "templates")); mkdirSync(join(dir, "scripts/benchmarks"), { recursive: true }); mkdirSync(join(dir, RECEIPT_DIR), { recursive: true });
  writeFileSync(join(dir, TEMPLATE), BASE);
  writeFileSync(join(dir, CORPUS_PATH), CORPUS_TEXT);
  writeFileSync(join(dir, RECEIPT_DIR, "README.md"), "x\n");
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "pr");
  return { dir, git };
}
const run = (dir: string, base: string) => checkModelReceipt(readInput(dir, base));

test("a fake PR that changes a model-routing key without a receipt fails; with the matching receipt it passes; with a receipt for another version it fails again", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, TEMPLATE), HOLD);
  git("add", "-A"); git("commit", "-qm", "change the default");
  const without = await run(dir, "main");
  expect(without.ok).toBe(false);
  expect(reason(without)).toContain("no model-routing receipt");
  const receipt = await receiptFor(BASE, HOLD);
  writeFileSync(join(dir, receipt.path), receipt.text);
  git("add", "-A"); git("commit", "-qm", "add the receipt");
  expect(await run(dir, "main")).toMatchObject({ ok: true });
  writeFileSync(join(dir, TEMPLATE), swap(HOLD, "hold_turns = 3", "hold_turns = 4"));
  git("add", "-A"); git("commit", "-qm", "amend the default");
  expect(reason(await run(dir, "main"))).toContain("no receipt names these model-routing keys");
});
test("a fake PR that changes only task routing, or nothing, passes with no receipt, and the reader compares against the merge base, not the base tip", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, TEMPLATE), TASK_ONLY); git("add", "-A"); git("commit", "-qm", "task routing only");
  expect(await run(dir, "main")).toMatchObject({ ok: true });
  git("checkout", "-q", "main"); writeFileSync(join(dir, TEMPLATE), HOLD); git("add", "-A"); git("commit", "-qm", "main changes a model-routing key"); git("checkout", "-q", "pr");
  expect(await run(dir, "main")).toMatchObject({ ok: true });
});
test("a part 1 receipt in docs/verification is not read as a model-routing receipt, and the reader only lists -modelrouting- files", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, RECEIPT_DIR, "2026-10-28-routing-f0bb8ad0.md"), "```json receipt\n{\"kind\":\"routing-receipt\",\"version\":1}\n```\n");
  writeFileSync(join(dir, TEMPLATE), HOLD);
  git("add", "-A"); git("commit", "-qm", "x");
  const read = readInput(dir, "main");
  expect(read.receipts).toEqual([]);
  expect(reason(await checkModelReceipt(read))).toContain("no model-routing receipt");
});
test("the script exits 0 on this repository and prints the verdict, and exits 2 when it cannot run", () => {
  const ok = Bun.spawnSync([process.execPath, join(ROOT, "scripts/check-model-routing-receipt.ts"), "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("model-routing receipt: OK");
  const unrunnable = Bun.spawnSync([process.execPath, join(ROOT, "scripts/check-model-routing-receipt.ts"), "no-such-ref"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(unrunnable.exitCode).toBe(2);
  expect(unrunnable.stderr.toString()).toContain("could not run the check");
});
test("the CI workflow runs this check on pull requests, with full history and the PR base, with no gateway, key or secret", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/routing-receipt.yml", import.meta.url)).text();
  expect(workflow).toContain("pull_request:");
  expect(workflow).toContain("fetch-depth: 0");
  expect(workflow).toContain("github.event.pull_request.head.sha");
  expect(workflow).toContain('bun scripts/check-model-routing-receipt.ts "$BASE_SHA"');
  expect(workflow).toContain('bun scripts/check-routing-receipt.ts "$BASE_SHA" --publish');
  expect(workflow).not.toMatch(/OMNIROUTE|api[_-]?key|secrets\.|--live/i);
  expect(workflow).toContain("permissions:\n  contents: read");
});
