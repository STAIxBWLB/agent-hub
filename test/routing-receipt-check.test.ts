import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceipt, compare, loadCorpus, parseConfigs, policySummary, renderReceipt, sha256, changedKeys } from "../scripts/benchmarks/routing-corpus.ts";
import { checkReceipt, CORPUS_PATH, readInput, RECEIPT_DIR, TEMPLATE, type CheckInput } from "../scripts/check-routing-receipt.ts";

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
  expect(reason(result)).toContain("its numbers are not what the corpus gives");
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
  const bad = { ...forged, text: forged.text.replaceAll(sha256(NEUTRAL), sha256(broken)) };
  const result = checkReceipt(input(broken, [bad]));
  expect(result.ok).toBe(false);
  expect(reason(result)).toMatch(/do not parse|numbers are not/);
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
