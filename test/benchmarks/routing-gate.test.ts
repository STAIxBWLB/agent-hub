import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEERS, buildReceipt, canonicalJson, changedKeys, compare, corpusHash, evaluate, freezeCorpus, loadCorpus, parseConfigs, parseReceipt, policySummary, renderReceipt, runCase, scoreCase, sha256, validateCorpus, type Corpus, type RoutingCase } from "../../scripts/benchmarks/routing-corpus.ts";
import { assign, parseRouting } from "../../src/hub/routing.ts";

// agent-hub #637 part 1 (hub task #321): the frozen task-routing corpus and the pure assign() gate. Spec: issue #637, "Routing promotion rule" in docs/agent-notes/benchmarks.md.
const ROOT = join(import.meta.dir, "../..");
const CORPUS = join(ROOT, "scripts/benchmarks/routing-corpus.json"); // names /scripts/benchmarks/routing-corpus.json" for scripts/changed-tests.mjs
const TEMPLATE_TEXT = readFileSync(join(ROOT, "templates/routing.toml"), "utf8");
const corpus = (): Corpus => loadCorpus(CORPUS);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-routing-gate-")); dirs.push(dir); return dir; };
const edited = (from: string, to: string) => { expect(TEMPLATE_TEXT).toContain(from); return TEMPLATE_TEXT.replace(from, to); };

test("the corpus has a split, a content hash, both guards on both splits, and board-shaped cases", () => {
  const c = corpus();
  expect(c.surface).toBe("task-routing");
  expect(c.hash).toBe(corpusHash(c));
  expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(c.cases.length).toBeGreaterThanOrEqual(40);
  for (const split of ["train", "test"] as const) {
    const rows = c.cases.filter(row => row.split === split);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.some(row => row.guard === "pii"), `${split} pii guard`).toBe(true);
    expect(rows.some(row => row.guard === "refusal"), `${split} refusal guard`).toBe(true);
    expect(rows.some(row => row.guard === "pii" && row.expect.owner === "local"), `${split}: a PII case that must reach local`).toBe(true);
    expect(rows.some(row => row.guard === "pii" && row.expect.owner === null), `${split}: a PII case that must reach nobody`).toBe(true);
  }
  expect(new Set(c.cases.map(row => row.id)).size).toBe(c.cases.length);
  // board-shaped: every task class, and every signal, appears
  expect(new Set(c.cases.map(row => row.task.class))).toEqual(new Set(["plan", "implement", "bulk_edit", "test", "review", "summarize", "triage"]));
  expect(new Set(c.cases.flatMap(row => row.task.signals))).toEqual(new Set(["pii", "pii_path", "long_context", "urgent"]));
  // every peer state the policy distinguishes is exercised
  expect(new Set(c.cases.flatMap(row => Object.values(row.states)))).toEqual(new Set(["idle", "busy", "paused", "offline"]));
  for (const row of c.cases) expect(row.note.length, row.id).toBeGreaterThan(20);
});

test("the gate reproduces the current default's numbers: every case on both splits passes", () => {
  const c = corpus(), { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  for (const split of ["train", "test"] as const) {
    const rows = evaluate(c, base, split);
    expect(rows.filter(row => !row.score.pass).map(row => `${row.id}: ${JSON.stringify(row.result)}`), split).toEqual([]);
  }
  const result = compare(c, base, base, "test");
  expect(result.primary).toMatchObject({ base: 1, candidate: 1, baseCorrect: 24, candidateCorrect: 24 });
  expect(result.verdict).toBe("pass");
  expect(result.regressions).toEqual([]);
  expect(result.n).toBe(24);
  expect(compare(c, base, base, "train").n).toBe(23);
});

test("the corpus freezes the roles it routes with, so a change to the shipped roles cannot move it", () => {
  const c = corpus();
  expect(c.defaults.roles.claude).toEqual(["planner", "reviewer"]);
  expect(Object.keys(c.defaults.roles).sort()).toEqual([...PEERS].sort());
});

test("a corpus whose content changed without a refreeze is refused, and so is any malformed one", () => {
  const raw = JSON.parse(readFileSync(CORPUS, "utf8")) as Corpus;
  expect(() => validateCorpus({ ...raw, cases: raw.cases.map((c, i) => (i ? c : { ...c, expect: { ...c.expect, owner: "kimi" } })) })).toThrow("hash mismatch");
  expect(() => validateCorpus({ ...raw, cases: raw.cases.map((c, i) => (i ? c : { ...c, split: c.split === "test" ? "train" : "test" })) })).toThrow("hash mismatch"); // the split is part of the hash
  const bad = (mutate: (c: RoutingCase) => RoutingCase, reason: string) => expect(() => validateCorpus({ ...raw, cases: [mutate(structuredClone(raw.cases[0]!)), ...raw.cases.slice(1)] }, true), reason).toThrow(reason);
  bad(c => ({ ...c, id: "Bad Id" }), "id is");
  bad(c => ({ ...c, split: "val" as never }), "split is train or test");
  bad(c => ({ ...c, note: "" }), "note");
  bad(c => ({ ...c, guard: "x" as never }), "guard is");
  bad(c => ({ ...c, task: { ...c.task, class: "nope" } }), "unknown class");
  bad(c => ({ ...c, task: { ...c.task, signals: ["weird"] } }), "unknown signal");
  bad(c => ({ ...c, states: { ghost: "idle" } }), "bad peer state");
  bad(c => ({ ...c, states: { pi: "sleeping" } }), "bad peer state");
  bad(c => ({ ...c, expect: { owner: "ghost" } }), "expect.owner");
  bad(c => ({ ...c, expect: { owner: "pi", refusals: ["nonsense"] } }), "refusal");
  expect(() => validateCorpus({ ...raw, cases: [{ ...raw.cases[0]!, id: raw.cases[1]!.id }, ...raw.cases.slice(1)] }, true)).toThrow("duplicate id");
  expect(() => validateCorpus({ ...raw, cases: raw.cases.filter(c => !(c.split === "test" && c.guard === "pii")) }, true)).toThrow("test split needs at least one pii guard");
  expect(() => validateCorpus({ ...raw, cases: raw.cases.filter(c => !(c.split === "train" && c.guard === "refusal")) }, true)).toThrow("train split needs at least one refusal guard");
  expect(() => validateCorpus(null)).toThrow();
  expect(() => validateCorpus({ ...raw, version: 2 }, true)).toThrow("version 1");
});

test("the hash covers content, not formatting: key order and whitespace do not change it", () => {
  const raw = JSON.parse(readFileSync(CORPUS, "utf8")) as Corpus;
  const reordered = JSON.parse(JSON.stringify(raw, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))) as Corpus;
  expect(corpusHash(reordered)).toBe(corpusHash(raw));
  expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("freezeCorpus rewrites only a stale hash, and is a no-op on a frozen file", () => {
  const dir = temp(), file = join(dir, "corpus.json");
  copyFileSync(CORPUS, file);
  expect(freezeCorpus(file)).toEqual({ hash: corpus().hash, stale: false });
  const raw = JSON.parse(readFileSync(file, "utf8")) as Corpus;
  raw.cases[0]!.note = "A changed note for the first case, so the hash is stale.";
  writeFileSync(file, JSON.stringify(raw));
  expect(() => loadCorpus(file)).toThrow("hash mismatch");
  const result = freezeCorpus(file);
  expect(result.stale).toBe(true);
  expect(result.hash).not.toBe(corpus().hash);
  expect(loadCorpus(file).hash).toBe(result.hash);
  writeFileSync(file, JSON.stringify({ ...raw, cases: [] }));
  expect(() => freezeCorpus(file)).toThrow("nonempty cases"); // a refreeze never launders a broken corpus
});

test("the expectations are the policy's documented rules, not a copy of one run: they pin cases a plausible default change would flip", () => {
  const c = corpus(), { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  const edits: [string, string, string][] = [
    ["PII constraint off", 'pii = "local_only"', 'pii = "off"'],
    ["implement drops local", 'peers = ["pi", "local", "codex", "kimi"]', 'peers = ["pi", "codex", "kimi"]'],
    ["implement is codex only", 'peers = ["pi", "local", "codex", "kimi"]', 'peers = ["codex"]'],
    ["kimi before codex", 'peers = ["pi", "local", "codex", "kimi"]', 'peers = ["pi", "local", "kimi", "codex"]'],
    ["review peers reversed", '[classes.review]\npeers = ["claude", "codex"]', '[classes.review]\npeers = ["codex", "claude"]'],
    ["plan may use pi and local", '[classes.plan]\npeers = ["claude", "codex"]\nlocal_allowed = false', '[classes.plan]\npeers = ["pi", "claude", "codex"]\nlocal_allowed = true'],
    ["long context allowed for local", 'long_context = "skip_local"', 'long_context = "off"'],
    ["long-context window raised", "long_context_tokens = 120000", "long_context_tokens = 300000"],
    ["paused peers still used", 'budget_paused = "skip_peer"', 'budget_paused = "off"'],
    ["summarize on dgx", '[classes.summarize]\npeers = ["pi", "local", "kimi"]\nfixed_model = "fast"\npi_backend = "mlx"', '[classes.summarize]\npeers = ["pi", "local", "kimi"]\nfixed_model = "fast"\npi_backend = "dgx"'],
    ["pi mlx window raised", "mlx_max_context_tokens = 16000", "mlx_max_context_tokens = 262144"],
  ];
  for (const [name, from, to] of edits) {
    const result = compare(c, base, parseRouting(edited(from, to)), "test");
    expect(result.verdict, name).toBe("blocked");
    expect(result.regressions.length, name).toBeGreaterThan(0);
  }
  // keys the assignment does not read never move a case
  for (const [name, from, to] of [["stay_switch", 'stay_switch = "shadow"', 'stay_switch = "off"'], ["hub route threshold", "confidence_threshold = 0.5", "confidence_threshold = 0.7"], ["comment", "# L1: task assignment.", "# L1: task assignment (edited)."]] as const) {
    expect(compare(c, base, parseRouting(edited(from, to)), "test").verdict, name).toBe("pass");
  }
});

test("any regression on a PII case blocks, even when the owner metric rises elsewhere", () => {
  const c = corpus(), { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  const off = parseRouting(edited('pii = "local_only"', 'pii = "off"'));
  const result = compare(c, base, off, "test");
  expect(result.guardRegressions.length).toBeGreaterThan(0);
  for (const id of result.guardRegressions) expect(c.cases.find(row => row.id === id)!.guard).toBeDefined();
  expect(result.reasons.join(" ")).toContain("PII or refusal");
  expect(result.verdict).toBe("blocked");
  // A synthetic corpus where the candidate GAINS owner accuracy on a plain case but loses a PII case: still blocked. The base cannot place an implement
  // task on kimi (its class list has no kimi when only kimi is attached and the class is `test` with kimi removed), so the candidate that adds kimi gains it.
  const without = parseRouting(edited('[classes.triage]\npeers = ["pi", "local", "kimi"]', '[classes.triage]\npeers = ["pi", "local"]'));
  const plain: RoutingCase = { id: "plain-case", split: "test", note: "triage with only kimi attached goes to kimi, which the base class list does not allow.", task: { class: "triage", signals: [] }, states: { kimi: "idle" }, expect: { owner: "kimi" } };
  const piiCase = c.cases.find(row => row.split === "test" && row.guard === "pii" && row.expect.owner === "local")!;
  expect(piiCase, "the test split holds a PII case that must reach local").toBeDefined();
  const synthetic: Corpus = { ...c, cases: [plain, piiCase] };
  const candidate = parseRouting(TEMPLATE_TEXT.replace('pii = "local_only"', 'pii = "off"'));
  const swapped = compare(synthetic, without, candidate, "test");
  expect(swapped.primary.baseCorrect, "the base fails the plain case").toBe(1); // only the PII case passes under the base
  expect(swapped.improvements).toEqual(["plain-case"]);
  expect(swapped.primary.candidateCorrect, "the candidate gains the plain case and loses the PII one").toBe(1);
  expect(swapped.guardRegressions).toEqual([piiCase.id]);
  expect(swapped.verdict).toBe("blocked");
  // and the same synthetic corpus passes when the candidate keeps the PII constraint: the gain alone is promotable
  const kept = compare(synthetic, without, parseRouting(TEMPLATE_TEXT), "test");
  expect(kept.guardRegressions).toEqual([]);
  expect(kept.primary.candidateCorrect).toBe(2);
  expect(kept.verdict).toBe("pass");
});

test("a candidate that is not worse and regresses no guard passes, with the improvement named", () => {
  const c = corpus(), { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  // Move the baseline off the shipped default so the candidate (the shipped default) improves on it.
  const worse = parseRouting(edited('peers = ["pi", "local", "codex", "kimi"]', 'peers = ["pi", "codex", "kimi"]'));
  const result = compare(c, worse, base, "test");
  expect(result.verdict).toBe("pass");
  expect(result.improvements.length).toBeGreaterThan(0);
  expect(result.primary.candidateCorrect).toBeGreaterThan(result.primary.baseCorrect);
});

test("an owner-only regression with no guard case blocks on the primary metric alone", () => {
  const c = corpus();
  const plain = c.cases.filter(row => row.split === "test" && !row.guard && row.expect.owner === "pi");
  expect(plain.length).toBeGreaterThan(0);
  const synthetic: Corpus = { ...c, cases: [...plain.slice(0, 1), ...c.cases.filter(row => row.split === "test" && row.guard)] };
  const { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  const onlyCodex = parseRouting(edited('peers = ["pi", "local", "codex", "kimi"]', 'peers = ["pi", "local", "codex", "kimi"]').replace('[classes.bulk_edit]\npeers = ["pi", "local", "kimi"]', '[classes.bulk_edit]\npeers = ["kimi"]').replace('[classes.test]\npeers = ["pi", "local", "kimi", "codex"]', '[classes.test]\npeers = ["kimi"]').replace('[classes.implement]\npeers = ["pi", "local", "codex", "kimi"]', '[classes.implement]\npeers = ["kimi"]'));
  const result = compare(synthetic, base, onlyCodex, "test");
  expect(result.primary.candidateCorrect).toBeLessThan(result.primary.baseCorrect);
  expect(result.reasons.join(" ")).toContain("owner top-1 accuracy fell");
  expect(result.verdict).toBe("blocked");
});

test("the harness runs the real assign(): a case's result equals assign() called directly", () => {
  const c = corpus(), { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  const row = c.cases.find(r => r.id === "pii-implement-local-only")!;
  const direct = assign({ class: "implement", signals: ["pii"] as never, reserved: null }, row.states as never, base, { roles: c.defaults.roles });
  expect(runCase(row, base, c.defaults)).toEqual({ owner: direct.owner ?? null, reviewer: direct.reviewer ?? null, refusals: (direct.refusals ?? []).map(r => `${r.role}:${r.peer}:${r.code}`).sort() });
  expect(scoreCase(row, runCase(row, base, c.defaults)).pass).toBe(true);
  expect(scoreCase(row, { owner: "pi", reviewer: "user", refusals: [] }).pass).toBe(false);
  expect(scoreCase(row, { owner: "local", reviewer: "claude", refusals: ["owner:pi:pii", "owner:codex:pii", "owner:kimi:pii"] }).pass).toBe(false); // the reviewer is wrong
  expect(scoreCase(row, { owner: "local", reviewer: "user", refusals: [] }).pass).toBe(false); // a stated refusal is missing
});

test("policySummary and changedKeys name what differs, and ignore load bookkeeping", () => {
  const a = parseRouting(TEMPLATE_TEXT), b = parseRouting(edited('peers = ["pi", "local", "codex", "kimi"]', 'peers = ["pi", "codex", "kimi"]'));
  expect(changedKeys(policySummary(a), policySummary(a))).toEqual([]);
  expect(changedKeys(policySummary(a), policySummary(b))).toEqual(["classes.implement.peers"]);
  expect(Object.keys(policySummary(a))).not.toContain("sources");
  expect(Object.keys(policySummary(a))).toContain("hub_routes");
});

test("a receipt renders a human summary, one machine block and a per-case table, and reads back", () => {
  const c = corpus(), { base } = parseConfigs(TEMPLATE_TEXT, TEMPLATE_TEXT);
  const comparison = compare(c, base, base, "test");
  const receipt = buildReceipt(c, comparison, { baseRef: "abc123", baseSha256: sha256(TEMPLATE_TEXT), candidateSha256: sha256(TEMPLATE_TEXT), generated: "2026-10-28", changedKeys: [], base: policySummary(base), candidate: policySummary(base) });
  const text = renderReceipt(receipt);
  expect(text).toContain("# Routing promotion receipt");
  expect(text).toContain(c.hash.slice(0, 12));
  expect(text).toContain("Verdict: **pass**");
  expect(text).toContain("none (the same policy)");
  expect(text).toContain("Served model ids: not applicable: task routing calls no model");
  expect(text).toContain("| Case | Guard | Expected | Current default | Candidate |");
  expect(text.match(/\| pii-implement-local-only \|/g)).toBeNull(); // a train-split case is not in the test-split table
  expect(text).toContain("| pii-implement-local-offline | pii |");
  expect(parseReceipt(text)).toEqual(receipt);
  expect(parseReceipt("no block here")).toBeUndefined();
  expect(parseReceipt("```json receipt\n{ not json\n```")).toBeUndefined();
  expect(parseReceipt('```json receipt\n{"kind":"other","version":1}\n```')).toBeUndefined();
});

test("the gate script prints the current default's numbers and exits 0, and --receipt writes a receipt that names the files", () => {
  const gate = join(ROOT, "scripts/benchmarks/routing-gate.ts"); // /scripts/benchmarks/routing-gate.ts"
  const run = (args: string[]) => Bun.spawnSync([process.execPath, gate, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const plain = run([]);
  expect(plain.exitCode).toBe(0);
  const out = plain.stdout.toString();
  expect(out).toContain("owner top-1 accuracy: 100.0% (24/24)");
  expect(out).toContain(corpus().hash.slice(0, 12));
  const dir = temp(), file = join(dir, "r.md");
  const head = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  const made = run(["--receipt", "--base", head, "--out", file]);
  expect(made.exitCode, made.stderr.toString()).toBe(0);
  const receipt = parseReceipt(readFileSync(file, "utf8"))!;
  expect(receipt.corpus_hash).toBe(corpus().hash);
  expect(receipt.candidate.sha256).toBe(sha256(TEMPLATE_TEXT));
  expect(run(["--receipt", "--base", head, "--out", file]).exitCode).toBe(2); // never overwrites without --force
  expect(run(["--receipt", "--base", head, "--out", file, "--force"]).exitCode).toBe(0);
  expect(run(["--split", "nope"]).exitCode).toBe(2);
  expect(run(["--receipt", "--base", "no-such-ref", "--out", join(dir, "x.md")]).exitCode).toBe(2);
});
