import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceipt, compare, loadCorpus, parseConfigs, policySummary, renderReceipt, sha256, changedKeys } from "../scripts/benchmarks/routing-corpus.ts";
import { checkReceipt, CORPUS_PATH, EVAL_CHECK_NAME, evalReport, formatRate, publishEval, readInput, RECEIPT_DIR, TEMPLATE, type CheckInput, type Gh } from "../scripts/check-routing-receipt.ts";
import { evalGateView, parseEvalMarkers, readEvalResult } from "../src/hub/eval-gate.ts";

// agent-hub #637 part 1 (hub task #321): a PR that changes templates/routing.toml needs a matching receipt. The check is pure over a CheckInput; the git reader and the
// script are exercised on real repositories below, which is how a fake PR is shown to fail.
const ROOT = join(import.meta.dir, "..");
const BASE = readFileSync(join(ROOT, TEMPLATE), "utf8");
const CORPUS_TEXT = readFileSync(join(ROOT, CORPUS_PATH), "utf8");
const corpus = loadCorpus(join(ROOT, CORPUS_PATH));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const swap = (text: string, from: string, to: string) => { expect(text).toContain(from); return text.replace(from, to); };
/** A harmless change the corpus does not see: a comment. */
const HARMLESS = swap(BASE, "# L1: task assignment.", "# L1: task assignment (a reworded comment).");
/** A change the corpus does see and blocks: PII routing off. */
const BAD = swap(BASE, 'pii = "local_only"', 'pii = "off"');
/** A change the corpus sees and does not block: a reviewer-neutral comment plus an unread key. */
const NEUTRAL = swap(BASE, 'stay_switch = "shadow"', 'stay_switch = "off"');

/** A real receipt for (base, head), exactly as `routing-gate.ts --receipt` writes it. */
function receiptFor(base: string, head: string, patch: (r: ReturnType<typeof buildReceipt>) => void = () => {}) {
  const { base: a, candidate: b } = parseConfigs(base, head);
  const receipt = buildReceipt(corpus, compare(corpus, a, b, "test"), { baseRef: "merge-base", baseSha256: sha256(base), candidateSha256: sha256(head), generated: "2026-10-28", changedKeys: changedKeys(policySummary(a), policySummary(b)), base: policySummary(a), candidate: policySummary(b) });
  patch(receipt);
  return { path: `${RECEIPT_DIR}/2026-10-28-routing-${sha256(head).slice(0, 8)}.md`, text: renderReceipt(receipt) };
}
const input = (head: string, receipts: CheckInput["receipts"], over: Partial<CheckInput> = {}): CheckInput => ({ changed: [TEMPLATE], baseTemplate: BASE, headTemplate: head, corpusText: CORPUS_TEXT, receipts, ...over });
const reason = (result: ReturnType<typeof checkReceipt>) => (result.ok ? "" : result.reason);

test("a PR that does not touch templates/routing.toml needs no receipt", () => {
  expect(checkReceipt(input(BASE, [], { changed: ["src/hub/tasks.ts", "docs/x.md"] }))).toMatchObject({ ok: true });
  expect(checkReceipt(input(BASE, [], { changed: [] }))).toMatchObject({ ok: true });
});

test("a PR that changes templates/routing.toml without any receipt fails and says how to make one", () => {
  const result = checkReceipt(input(NEUTRAL, []));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("no routing receipt");
  expect(reason(result)).toContain("routing-gate.ts --receipt");
});

test("a matching receipt for a passing change is accepted", () => {
  const result = checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]));
  expect(result).toMatchObject({ ok: true });
  expect((result as { note: string }).note).toContain("no PII or refusal regression");
  expect(checkReceipt(input(HARMLESS, [receiptFor(BASE, HARMLESS)]))).toMatchObject({ ok: true });
});

test("a receipt for an earlier version of the file does not count", () => {
  const result = checkReceipt(input(NEUTRAL, [receiptFor(BASE, HARMLESS)]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("no receipt names this templates/routing.toml");
});

test("a receipt made against another current default is refused: it must name the default at the merge base", () => {
  const otherBase = swap(BASE, 'stay_switch = "shadow"', 'stay_switch = "enforce"');
  const result = checkReceipt(input(NEUTRAL, [receiptFor(otherBase, NEUTRAL)]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("not the default at the merge base");
});

test("a receipt for another corpus is refused, which is what a corpus change does to every earlier receipt", () => {
  const stale = receiptFor(BASE, NEUTRAL, r => { r.corpus_hash = "0".repeat(64); });
  const result = checkReceipt(input(NEUTRAL, [stale]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("was made for corpus");
});

test("a receipt on the train split is refused: the rule is read on the test split", () => {
  const train = receiptFor(BASE, NEUTRAL, r => { r.split = "train"; });
  expect(reason(checkReceipt(input(NEUTRAL, [train])))).toContain("test split");
});

test("a change the promotion rule blocks fails even with an honest receipt that says so", () => {
  const honest = receiptFor(BASE, BAD);
  expect(honest.text).toContain("Verdict: **blocked**");
  const result = checkReceipt(input(BAD, [honest]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("promotion rule blocks this change");
  expect(reason(result)).toContain("PII or refusal");
});

test("a receipt edited by hand to say pass is caught: the check recomputes the numbers from the two files", () => {
  const forged = receiptFor(BASE, BAD, r => { r.evidence.verdict = "pass"; r.evidence.reasons = []; r.evidence.guardRegressions = []; r.evidence.regressions = []; r.evidence.primary.candidateCorrect = r.evidence.primary.baseCorrect; });
  const result = checkReceipt(input(BAD, [forged]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("it is not what the corpus gives for these two files");
  expect(reason(result)).toContain("verdict differs");
  expect(reason(result)).toContain("it was edited or made from other files");
});

test("a receipt with the wrong file name, no machine block or a broken one is not a receipt", () => {
  const good = receiptFor(BASE, NEUTRAL);
  expect(reason(checkReceipt(input(NEUTRAL, [{ path: `${RECEIPT_DIR}/notes-routing-abc.md`, text: good.text }])))).toContain("file name is");
  expect(reason(checkReceipt(input(NEUTRAL, [{ path: good.path, text: "# A receipt\n\nVerdict: pass\n" }])))).toContain("no routing receipt");
  expect(reason(checkReceipt(input(NEUTRAL, [{ path: good.path, text: good.text.replace('"kind": "routing-receipt"', '"kind": "other"') }])))).toContain("no routing receipt");
});

test("the corpus is never changed in the same PR as the default it measures", () => {
  const result = checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)], { changed: [TEMPLATE, CORPUS_PATH] }));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("frozen corpus is never edited together");
});

test("a corpus whose hash was not refrozen fails the check", () => {
  const raw = JSON.parse(CORPUS_TEXT);
  raw.cases[0].note = "Edited without a refreeze, so the stored hash is stale for this content.";
  const result = checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)], { corpusText: JSON.stringify(raw) }));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("hash mismatch");
});

test("a deleted or newly created template is refused with its own reason", () => {
  expect(reason(checkReceipt(input(NEUTRAL, [], { headTemplate: undefined })))).toContain("cannot be removed");
  expect(reason(checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)], { baseTemplate: undefined })))).toContain("did not exist at the merge base");
});

test("templates that do not parse give a reason, never an exception", () => {
  const broken = "this is [[not toml";
  const forged = receiptFor(BASE, NEUTRAL);
  const text = forged.text.replaceAll(sha256(NEUTRAL), sha256(broken));
  const bad = { path: forged.path.replace(sha256(NEUTRAL).slice(0, 8), sha256(broken).slice(0, 8)), text };
  const result = checkReceipt(input(broken, [bad]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toContain("the templates do not parse");
});

// Every field of a receipt that the two files determine is recomputed: a receipt that passes the verdict but lies about anything else is refused.
const tamper: [string, (r: ReturnType<typeof buildReceipt>) => void, string][] = [
  ["the candidate configuration emptied", r => { r.candidate.config = {}; }, "candidate differs"],
  ["the base configuration emptied", r => { r.base.config = {}; }, "base differs"],
  ["the changed keys erased", r => { r.changed_keys = []; }, "changed_keys differs"],
  ["a changed key invented", r => { r.changed_keys = ["classes.implement.peers"]; }, "changed_keys differs"],
  ["the reviewer metric inflated", r => { r.evidence.secondary.reviewer.candidate = 1; r.evidence.secondary.reviewer.base = 0.5; }, "secondary differs"],
  ["the whole-case rate changed", r => { r.evidence.secondary.fullCase.candidate = 0.123; }, "secondary differs"],
  ["the primary rate changed", r => { r.evidence.primary.candidate = 0.5; }, "primary differs"],
  ["the primary base rate changed", r => { r.evidence.primary.base = 0.75; }, "primary differs"],
  ["the primary metric renamed", r => { r.evidence.primary.metric = "something kinder"; }, "primary differs"],
  ["a case outcome rewritten", r => { r.evidence.cases[0]!.candidate.owner = "kimi"; }, "cases differs"],
  ["a case marked failing", r => { r.evidence.cases[0]!.candidatePass = false; }, "cases differs"],
  ["a case dropped", r => { r.evidence.cases = r.evidence.cases.slice(1); }, "cases differs"],
  ["the improvements invented", r => { r.evidence.improvements = ["pii-plan-nobody"]; }, "improvements differs"],
  ["the reasons rewritten", r => { r.evidence.reasons = ["fine"]; }, "reasons differs"],
  ["the served-model note rewritten", r => { r.served_models = "gpt-whatever"; }, "served_models differs"],
  ["an extra field added", r => { (r as unknown as Record<string, unknown>).approved_by = "someone"; }, "extra or missing field"],
  ["the surface changed", r => { (r as { surface: string }).surface = "model-routing"; }, "surface differs"],
  ["the version changed", r => { (r as { version: number }).version = 2; }, "no routing receipt"],
];
for (const [name, patch, expected] of tamper) {
  test(`a receipt with ${name} is refused although its verdict still says pass`, () => {
    const result = checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL, patch)]));
    expect(result.ok, name).toBe(false);
    expect(reason(result), name).toContain(expected);
  });
}

test("the human-readable part cannot be edited either: a summary or case table that disagrees with the data is refused", () => {
  const good = receiptFor(BASE, NEUTRAL);
  expect(checkReceipt(input(NEUTRAL, [good]))).toMatchObject({ ok: true });
  for (const [name, edit] of [
    ["the verdict line", (t: string) => t.replace("Verdict: **pass**", "Verdict: **pass** (reviewed and approved)")],
    ["a case row", (t: string) => t.replace("| pii-implement-local-offline | pii |", "| pii-implement-local-offline | none |")],
    ["the summary heading", (t: string) => t.replace("# Routing promotion receipt", "# Routing promotion receipt (approved)")],
    ["a trailing note", (t: string) => `${t}\nApproved by the conductor.\n`],
  ] as const) {
    const result = checkReceipt(input(NEUTRAL, [{ path: good.path, text: edit(good.text) }]));
    expect(result.ok, name).toBe(false);
    expect(reason(result), name).toContain("outside the machine block");
  }
  // line endings and trailing blank lines are not content
  expect(checkReceipt(input(NEUTRAL, [{ path: good.path, text: good.text.replace(/\n/g, "\r\n") + "\r\n\r\n" }]))).toMatchObject({ ok: true });
});

test("the receipt's own choices are bounded: a malformed date or base label, and a file name that does not carry them, are refused", () => {
  expect(reason(checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL, r => { r.generated = "tomorrow"; })])))).toContain("YYYY-MM-DD");
  expect(reason(checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL, r => { r.base.ref = "x y; rm -rf /"; })])))).toContain("short git ref label");
  const good = receiptFor(BASE, NEUTRAL);
  expect(reason(checkReceipt(input(NEUTRAL, [{ path: `${RECEIPT_DIR}/2026-01-01-routing-${sha256(NEUTRAL).slice(0, 8)}.md`, text: good.text }])))).toContain("the file name must be");
  // a different date and base label are honest choices, so a receipt made on another day against a branch name is accepted
  expect(checkReceipt(input(NEUTRAL, [receiptFor(BASE, NEUTRAL, r => { r.base.ref = "origin/main"; })]))).toMatchObject({ ok: true });
});

test("when several receipts exist, one matching receipt is enough, and the reasons of the others are reported only if none matches", () => {
  const good = receiptFor(BASE, NEUTRAL), old = receiptFor(BASE, HARMLESS);
  expect(checkReceipt(input(NEUTRAL, [old, good]))).toMatchObject({ ok: true });
  const staleOnly = receiptFor(BASE, NEUTRAL, r => { r.corpus_hash = "f".repeat(64); });
  expect(checkReceipt(input(NEUTRAL, [old, staleOnly])).ok).toBe(false);
});

// ---- real git: the reader and the script, on a fake PR ----
function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = realpathTemp();
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
function realpathTemp(): string { const dir = mkdtempSync(join(tmpdir(), "ahub-routing-receipt-")); dirs.push(dir); return dir; }
/** Runs the REAL script's logic against `dir` (the script resolves its repo from its own location, so the reader is called with the fixture's root). */
const run = (dir: string, base: string) => checkReceipt(readInput(dir, base));

test("a fake PR that changes templates/routing.toml without a receipt fails; with the matching receipt it passes; with a receipt for another version it fails again", () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, TEMPLATE), NEUTRAL);
  git("add", "-A"); git("commit", "-qm", "change the default");
  const without = run(dir, "main");
  expect(without.ok).toBe(false);
  expect(reason(without)).toContain("no routing receipt");
  const receipt = receiptFor(BASE, NEUTRAL);
  writeFileSync(join(dir, receipt.path), receipt.text);
  git("add", "-A"); git("commit", "-qm", "add the receipt");
  expect(run(dir, "main")).toMatchObject({ ok: true });
  // the PR is amended: a second edit to the template leaves the receipt naming the earlier file
  writeFileSync(join(dir, TEMPLATE), swap(NEUTRAL, "# L1: task assignment.", "# L1: task assignment (amended)."));
  git("add", "-A"); git("commit", "-qm", "amend the default");
  const amended = run(dir, "main");
  expect(amended.ok).toBe(false);
  expect(reason(amended)).toContain("no receipt names this templates/routing.toml");
});

test("a fake PR that does not touch the template passes with no receipt, and the reader compares against the merge base, not the base tip", () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "README.md"), "x\n"); git("add", "-A"); git("commit", "-qm", "docs only");
  expect(run(dir, "main")).toMatchObject({ ok: true });
  // main moves on (another PR changed the template); this PR still did not, so it is not asked for a receipt
  git("checkout", "-q", "main"); writeFileSync(join(dir, TEMPLATE), NEUTRAL); git("add", "-A"); git("commit", "-qm", "main changes the default"); git("checkout", "-q", "pr");
  expect(run(dir, "main")).toMatchObject({ ok: true });
});

test("the script exits 0 on this repository and prints the verdict, and exits 2 when it cannot run", () => {
  // The script resolves its repository from its own path, so it is run against the real one: this branch's template is unchanged against HEAD.
  const ok = Bun.spawnSync([process.execPath, join(ROOT, "scripts/check-routing-receipt.ts"), "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toContain("routing receipt: OK");
  const unrunnable = Bun.spawnSync([process.execPath, join(ROOT, "scripts/check-routing-receipt.ts"), "no-such-ref"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  expect(unrunnable.exitCode).toBe(2);
  expect(unrunnable.stderr.toString()).toContain("could not run the check");
});

test("the CI workflow runs this check on pull requests, with full history and the PR base, and runs no model", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/routing-receipt.yml", import.meta.url)).text();
  expect(workflow).toContain("pull_request:");
  expect(workflow).toContain("fetch-depth: 0");
  expect(workflow).toContain("github.event.pull_request.head.sha");
  expect(workflow).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}");
  expect(workflow).toContain('bun scripts/check-routing-receipt.ts "$BASE_SHA"');
  expect(workflow).not.toMatch(/OMNIROUTE|api[_-]?key|secrets\./i);
  expect(workflow).toContain("permissions:\n  contents: read");
});

// ---- #481 S5: the check is the repository's eval check, so it emits the markers readEvalResult parses ----
const HEAD = "a".repeat(40), REPO = "STAIxBWLB/agent-hub";
/** A fake `gh` that behaves like the Checks API for one repository: it stores check runs and answers the `--jq` shapes the publisher and readEvalResult use. */
function fakeChecks(initial: { id: number; name: string; head_sha: string; status: string; conclusion: string | null; output: { title: string | null; summary: string | null } }[] = []) {
  const runs = [...initial];
  const calls: string[][] = [];
  let nextId = 1000;
  const gh: Gh = (args, stdin) => {
    calls.push(args);
    const url = args.find(arg => arg.startsWith("repos/")) ?? "";
    const wants = (jq: string | undefined) => jq ?? "";
    if (args.includes("-X") && args[args.indexOf("-X") + 1] === "POST") {
      const body = JSON.parse(stdin!);
      const run = { id: nextId++, name: body.name, head_sha: body.head_sha, status: body.status, conclusion: body.conclusion, output: { title: body.output.title, summary: body.output.summary } };
      runs.push(run); return { code: 0, stdout: `${run.id}\n` };
    }
    if (args.includes("-X") && args[args.indexOf("-X") + 1] === "PATCH") {
      const id = Number(url.split("/").at(-1)), body = JSON.parse(stdin!), run = runs.find(row => row.id === id)!;
      Object.assign(run, { status: body.status, conclusion: body.conclusion, output: { title: body.output.title, summary: body.output.summary } }); return { code: 0, stdout: `${id}\n` };
    }
    const name = decodeURIComponent(/check_name=([^&]+)/.exec(url)?.[1] ?? ""), head = /commits\/([a-f0-9]{40})\//.exec(url)?.[1];
    const mine = runs.filter(row => row.head_sha === head && (!name || row.name === name));
    if (wants(args[args.indexOf("--jq") + 1]).startsWith("[.check_runs[]|select")) return { code: 0, stdout: JSON.stringify(mine.map(row => row.id)) };
    // readEvalResult's shape: {total_count, check_runs:[{name,status,conclusion,head_sha,text}]}
    return { code: 0, stdout: JSON.stringify({ total_count: mine.length, check_runs: mine.map(row => ({ name: row.name, status: row.status, conclusion: row.conclusion, head_sha: row.head_sha, text: `${row.output.title ?? ""} ${row.output.summary ?? ""}`.slice(0, 1000) })) }) };
  };
  return { gh, runs, calls };
}
const ghForHub = (checks: ReturnType<typeof fakeChecks>) => async (args: string[]) => checks.gh(args);
/** A complete, passed configuration PR at HEAD: the shape `PrEvidence` really has (paths, pathsComplete, typesComplete). */
const EVIDENCE = { head: HEAD, state: "OPEN", checks: [{ name: EVAL_CHECK_NAME, state: "passed" }], review: "unknown", unresolved: 0, pendingReviews: 0, paths: ["templates/routing.toml"], fileChanges: [{ path: "templates/routing.toml", change: "modified" }], pathsComplete: true, typesComplete: true } as never;

test("formatRate gives only values the hub's marker accepts: 0, 1 or a decimal in [0,1], never a percent sign or a fraction", () => {
  expect(formatRate(24, 24)).toBe("1");
  expect(formatRate(0, 24)).toBe("0");
  expect(formatRate(0, 0)).toBe("0");
  expect(formatRate(23, 24)).toBe("0.9583");
  expect(formatRate(1, 2)).toBe("0.5");
  expect(formatRate(1, 3)).toBe("0.3333");
  for (const [c, n] of [[24, 24], [0, 5], [1, 3], [2, 3], [7, 8], [19, 24], [1, 1000]] as const) {
    const markers = parseEvalMarkers(`eval_pass_rate=${formatRate(c, n)} eval_suite=abc`);
    expect(markers.passRate, `${c}/${n}`).toBeDefined();
    expect(Math.abs(markers.passRate! - c / n)).toBeLessThan(0.0001);
  }
});

test("the eval report carries owner top-1 accuracy on the test split and the corpus hash prefix, in markers the hub's parser reads back exactly", () => {
  const ok = evalReport(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]), { ok: true, note: "fine" });
  expect(ok.conclusion).toBe("success");
  expect(ok.passRate).toBe("1");
  expect(ok.suite).toBe(corpus.hash.slice(0, 12));
  expect(ok.title).toContain(`${EVAL_CHECK_NAME} passed`);
  expect(parseEvalMarkers(ok.title)).toEqual({ passRate: 1, suite: corpus.hash.slice(0, 12) });
  expect(parseEvalMarkers(`${ok.title} ${ok.summary}`)).toEqual({ passRate: 1, suite: corpus.hash.slice(0, 12) }); // the summary adds no marker of its own
  expect(ok.summary).toContain("24/24");
  expect(ok.summary).toContain(corpus.hash);
  // a change that breaks the candidate's own routing lowers the reported rate: the number is the head's, not a constant
  const bad = evalReport(input(BAD, []), { ok: false, reason: "no receipt" });
  expect(bad.conclusion).toBe("failure");
  expect(bad.title).toContain("failed");
  expect(Number(bad.passRate)).toBeLessThan(1);
  expect(parseEvalMarkers(bad.title).passRate).toBe(Number(bad.passRate));
});

test("with no readable corpus or template there are no markers: a gap the hub shows, never a made-up number", () => {
  const broken = evalReport(input(NEUTRAL, [], { corpusText: "{ not json" }), { ok: false, reason: "x" });
  expect(broken.conclusion).toBe("failure");
  expect(broken.passRate).toBeUndefined();
  expect(parseEvalMarkers(`${broken.title} ${broken.summary}`)).toEqual({});
  const stale = JSON.parse(CORPUS_TEXT); stale.cases[0].note = "edited without a refreeze, so the stored hash is stale";
  expect(evalReport(input(NEUTRAL, [], { corpusText: JSON.stringify(stale) }), { ok: false, reason: "x" }).passRate).toBeUndefined();
  expect(evalReport(input(NEUTRAL, [], { headTemplate: undefined, baseTemplate: undefined }), { ok: false, reason: "x" }).passRate).toBeUndefined();
});

test("publishing creates one routing-eval check run at the head, and a rerun UPDATES it: the hub reads exactly one run of that name", async () => {
  const checks = fakeChecks();
  const first = publishEval(checks.gh, REPO, HEAD, evalReport(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]), { ok: true, note: "fine" }));
  expect(first.action).toBe("created");
  expect(checks.runs).toHaveLength(1);
  expect(checks.runs[0]).toMatchObject({ name: "routing-eval", head_sha: HEAD, status: "completed", conclusion: "success" });
  const second = publishEval(checks.gh, REPO, HEAD, evalReport(input(BAD, []), { ok: false, reason: "no receipt" }));
  expect(second).toEqual({ id: first.id, action: "updated" });
  expect(checks.runs).toHaveLength(1);
  expect(checks.runs[0]).toMatchObject({ conclusion: "failure" });
  expect(checks.runs[0]!.output.title).toContain("failed");
  // another head gets its own run
  publishEval(checks.gh, REPO, "b".repeat(40), evalReport(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]), { ok: true, note: "fine" }));
  expect(checks.runs).toHaveLength(2);
});

test("DRY RUN: what the publisher writes is exactly what the hub's readEvalResult parses, and the eval gate view shows the rate and suite", async () => {
  const checks = fakeChecks();
  publishEval(checks.gh, REPO, HEAD, evalReport(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]), { ok: true, note: "fine" }));
  const read = await readEvalResult(REPO, HEAD, EVAL_CHECK_NAME, ghForHub(checks));
  expect(read).toEqual({ check: "routing-eval", head: HEAD, read: true, passRate: 1, suite: corpus.hash.slice(0, 12) });
  const view = evalGateView({ configPaths: ["templates/**"], evalCheck: EVAL_CHECK_NAME, mode: "advise" } as never,
    EVIDENCE, read);
  expect(view).toMatchObject({ applies: "config", state: "passed", check: "routing-eval", passRate: 1, suite: corpus.hash.slice(0, 12), gaps: [] });
  // without the markers the same passed check is the gap the spec names, so the markers are what closes it
  const bare = fakeChecks([{ id: 1, name: "routing-eval", head_sha: HEAD, status: "completed", conclusion: "success", output: { title: null, summary: null } }]);
  const none = await readEvalResult(REPO, HEAD, EVAL_CHECK_NAME, ghForHub(bare));
  expect(none).toEqual({ check: "routing-eval", head: HEAD, read: true });
  expect(evalGateView({ configPaths: ["templates/**"], evalCheck: EVAL_CHECK_NAME, mode: "advise" } as never,
    EVIDENCE, none)!.gaps).toHaveLength(1);
});

test("the Actions job's own check run (named routing-receipt) has no title or summary, which is why the markers ride a separate run", async () => {
  const checks = fakeChecks([{ id: 5, name: "routing-receipt", head_sha: HEAD, status: "completed", conclusion: "success", output: { title: null, summary: null } }]);
  expect(await readEvalResult(REPO, HEAD, "routing-receipt", ghForHub(checks))).toEqual({ check: "routing-receipt", head: HEAD, read: true });
  publishEval(checks.gh, REPO, HEAD, evalReport(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]), { ok: true, note: "fine" }));
  expect((await readEvalResult(REPO, HEAD, EVAL_CHECK_NAME, ghForHub(checks))).passRate).toBe(1);
});

test("a publish that fails throws a reason and never reports success: bad repository or head, a refused list, a refused write", () => {
  const report = evalReport(input(NEUTRAL, [receiptFor(BASE, NEUTRAL)]), { ok: true, note: "fine" });
  const never: Gh = () => { throw new Error("must not be called"); };
  expect(() => publishEval(never, "not a repo", HEAD, report)).toThrow("owner/name");
  expect(() => publishEval(never, "-x/y", HEAD, report)).toThrow("owner/name");
  expect(() => publishEval(never, REPO, "abc", report)).toThrow("40-digit");
  expect(() => publishEval(() => ({ code: 1, stdout: "", stderr: "HTTP 403" }), REPO, HEAD, report)).toThrow("could not list check runs: HTTP 403");
  const listsThenFails: Gh = args => (args.includes("POST") ? { code: 1, stdout: "", stderr: "Resource not accessible by integration" } : { code: 0, stdout: "[]" });
  expect(() => publishEval(listsThenFails, REPO, HEAD, report)).toThrow("could not create the routing-eval check run: Resource not accessible");
});

test("the workflow publishes the eval check run with the right permission, head and token, and the receipt verdict still decides the job", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/routing-receipt.yml"), "utf8");
  expect(workflow).toContain("permissions:\n  contents: read\n  checks: write");
  expect(workflow).toContain('bun scripts/check-routing-receipt.ts "$BASE_SHA" --publish');
  expect(workflow).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
  expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
  expect(workflow).toContain("GITHUB_REPOSITORY: ${{ github.repository }}");
  expect(workflow).toContain("`routing-eval`");
  expect(workflow).not.toMatch(/OMNIROUTE|secrets\./i);
});

test("the script prints the markers, exits with the receipt verdict, and a publish it cannot make is a warning that never changes the exit status", () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "scripts/check-routing-receipt.ts"), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, GITHUB_REPOSITORY: "", HEAD_SHA: "" } });
  const plain = run("HEAD");
  expect(plain.exitCode).toBe(0);
  expect(plain.stdout.toString()).toContain(`routing-eval: eval_pass_rate=1 eval_suite=${corpus.hash.slice(0, 12)}`);
  const publishing = run("HEAD", "--publish");
  expect(publishing.exitCode).toBe(0);
  expect(publishing.stdout.toString()).toContain("::warning title=routing-eval not published::");
  expect(publishing.stdout.toString()).toContain("routing receipt: OK");
});
