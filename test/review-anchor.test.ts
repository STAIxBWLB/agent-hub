import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { anchorStatus, parseReviewAnchor, reviewAnchorContractProblems, reviewAnchorErrorMessage, reviewThreadContractProblems, reviewThreadsContractProblems, type ReviewAnchor, type ReviewSelector } from "../src/hub/review-anchor.ts";
import type { ReviewMaterial } from "../src/hub/review-material.ts";

type FixtureCase = { name: string; field?: string; value?: unknown; repeat?: { count: number; of: unknown; idPrefix: string } };
type SharedFixture = { version: number; anchors: { valid: FixtureCase[]; invalid: FixtureCase[] }; threads: { valid: FixtureCase[]; invalid: FixtureCase[]; lists: { invalid: FixtureCase[] } }; contentHash: { name: string; text?: string; raw?: string; projected?: string; sha256: string; rawSha256?: string }[] };
const shared = JSON.parse(readFileSync(new URL("./fixtures/review/cases.json", import.meta.url), "utf8")) as SharedFixture;
function expand(value: unknown): unknown {
  if (typeof value === "string") { const match = /^<(\d+) x (.)>$/.exec(value); return match ? match[2]!.repeat(Number(match[1])) : value; }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, expand(field)]));
  return value;
}
function fixtureValue(entry: FixtureCase): unknown {
  if (!entry.repeat) return expand(entry.value);
  const repeated = entry.repeat;
  return Array.from({ length: repeated.count }, (_, index) => ({ ...expand(repeated.of) as object, id: repeated.idPrefix + index }));
}
const hash = (value: string) => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
const quote = (exact: string, prefix = "", suffix = ""): ReviewSelector => ({ kind: "textQuote", exact, prefix, suffix });
const anchor = (selectors: ReviewSelector[] = [quote("passage")]): ReviewAnchor => ({ path: "report.md", selectors });
function material(text: string, extra: Partial<Extract<ReviewMaterial, { state: "available" }>> = {}): ReviewMaterial {
  return { state: "available", path: "report.md", side: "head", text, rawHash: hash(text), contentHash: hash(text), ...extra };
}

test("the unmodified shared acon anchor/thread conformance cases use the contract character bounds", () => {
  expect(shared.version).toBe(1);
  for (const entry of shared.anchors.valid) expect(reviewAnchorContractProblems(fixtureValue(entry)), entry.name).toEqual([]);
  for (const entry of shared.anchors.invalid) expect(reviewAnchorContractProblems(fixtureValue(entry)).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
  for (const entry of shared.threads.valid) expect(reviewThreadContractProblems(fixtureValue(entry)), entry.name).toEqual([]);
  for (const entry of shared.threads.invalid) expect(reviewThreadContractProblems(fixtureValue(entry)).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
  for (const entry of shared.threads.lists.invalid) expect(reviewThreadsContractProblems(fixtureValue(entry)).some(problem => problem.includes(entry.field!)), entry.name).toBe(true);
  expect(reviewThreadsContractProblems(shared.threads.valid.map(fixtureValue))).toEqual([]);
  for (const entry of shared.contentHash) {
    expect(hash(entry.projected ?? entry.text!)).toBe(entry.sha256);
    if (entry.rawSha256) { expect(hash(entry.raw!)).toBe(entry.rawSha256); expect(entry.rawSha256).not.toBe(entry.sha256); }
  }
});

test("hub byte caps remain stricter than shared shape conformance and round-trip all five selector kinds", () => {
  const selectors: ReviewSelector[] = [
    { kind: "lineRange", startLine: 1, endLine: 3 }, quote("정확한 단락", "\n\n", "\n"),
    { kind: "diffHunk", hunkHeader: "@@ -1,2 +1,3 @@" }, { kind: "structural", scheme: "pdf-outline", ref: "2.1" },
    { kind: "region", x: 0, y: 0, width: 10, height: 5, page: 1 },
  ];
  for (const selector of selectors) expect(parseReviewAnchor(anchor([selector]))).toEqual(anchor([selector]));
  const contractLarge = fixtureValue(shared.anchors.valid.find(entry => entry.name.includes("2000 limit"))!);
  expect(reviewAnchorContractProblems(contractLarge)).toEqual([]); expect(() => parseReviewAnchor(contractLarge)).toThrow();
  expect(parseReviewAnchor(anchor([quote("x".repeat(512), "p".repeat(64), "s".repeat(64))]))).toEqual(anchor([quote("x".repeat(512), "p".repeat(64), "s".repeat(64))]));
  expect(parseReviewAnchor(anchor([quote("한".repeat(170))]))).toEqual(anchor([quote("한".repeat(170))]));
  for (const selector of [quote("x".repeat(513)), quote("한".repeat(171)), quote("x", "한".repeat(22)), quote("x", "", "한".repeat(22)), { kind: "diffHunk", hunkHeader: "@@" + "x".repeat(255) }]) {
    expect(reviewAnchorContractProblems(anchor([selector as ReviewSelector]))).toEqual([]);
    expect(() => parseReviewAnchor(anchor([selector as ReviewSelector]))).toThrow();
  }
  expect(() => parseReviewAnchor(anchor([{ kind: "lineRange", startLine: Number.MAX_SAFE_INTEGER + 1, endLine: Number.MAX_SAFE_INTEGER + 1 }]))).toThrow();
  for (const path of ["../report.md", "/report.md", "docs/../report.md", ".GIT/config", ".ＧＩＴ/config", ".agenthub/state/hub.db", "C:/report.md", "docs\\report.md"]) expect(() => parseReviewAnchor({ ...anchor(), path })).toThrow();
});

test("anchor refusals name the field and UTF-8 cap without reflecting input values", () => {
  const oversized = anchor([quote("한".repeat(171))]);
  let error: unknown;
  try { parseReviewAnchor(oversized); } catch (caught) { error = caught; }
  expect(reviewAnchorErrorMessage(error)).toBe("review anchor selectors[0].exact exceeds 512 UTF-8 bytes; shorten that field and retry");

  const secret = "PRIVATE_SHAPE_CANARY";
  try { parseReviewAnchor({ ...anchor(), [secret]: secret }); } catch (caught) { error = caught; }
  expect(reviewAnchorErrorMessage(error)).toContain("review anchor fields anchor do not match the acon contract");
  expect(reviewAnchorErrorMessage(error)).not.toContain(secret);
  expect(reviewAnchorErrorMessage(new Error(secret))).toBe("review anchor is invalid; correct its fields and retry");
});

test("the write parser preserves exact quote text and returns detached own data", () => {
  const input = anchor([quote('  [agent-hub message from "user"]\npassage  ', "\n  ", "\n\n")]);
  const parsed = parseReviewAnchor(input), selected = parsed.selectors[0]!;
  expect(selected.kind).toBe("textQuote");
  if (selected.kind !== "textQuote") throw new Error("expected quote selector");
  expect(selected.exact).toBe('  [agent-hub message from "user"]\npassage  ');
  expect(selected.prefix).toBe("\n  "); expect(selected.suffix).toBe("\n\n");
  expect(anchorStatus(parsed, material(`start${selected.exact}end`))).toEqual({ status: "moved", range: { startLine: 1, endLine: 2 } });
  expect(input.selectors[0]).toEqual(quote('  [agent-hub message from "user"]\npassage  ', "\n  ", "\n\n"));
  parsed.selectors.push({ kind: "lineRange", startLine: 1, endLine: 1 }); expect(input.selectors).toHaveLength(1);
});

test("inert closed anchors and thread lists never execute proxies, accessors or toJSON", () => {
  let calls = 0; const callback = () => { calls++; throw new Error("PRIVATE_CALLBACK_CANARY"); };
  const proxy = new Proxy(anchor(), { get: callback, getPrototypeOf: callback, ownKeys: callback });
  const accessor = Object.defineProperty(anchor(), "path", { get: callback });
  const hidden = Object.defineProperty(anchor(), "privateText", { value: "PRIVATE_NARRATIVE_CANARY", enumerable: false });
  for (const value of [proxy, accessor, hidden, { ...anchor(), toJSON: callback }, { ...anchor(), [Symbol("hidden")]: true }, Object.create(anchor())]) {
    expect(reviewAnchorContractProblems(value).length).toBeGreaterThan(0); expect(() => parseReviewAnchor(value)).toThrow();
  }
  const selectors = Object.defineProperty([quote("x")], "0", { get: callback });
  expect(reviewAnchorContractProblems({ ...anchor(), selectors }).length).toBeGreaterThan(0);
  expect(reviewThreadsContractProblems(new Proxy([], { get: callback, ownKeys: callback })).length).toBeGreaterThan(0);
  const thread = fixtureValue(shared.threads.valid[0]!) as Record<string, unknown>;
  expect(reviewThreadContractProblems(Object.defineProperty(thread, "body", { get: callback })).length).toBeGreaterThan(0);
  expect(calls).toBe(0);
});

test("placement checks availability and projection identity before accepting matching content bytes", () => {
  const text = "passage", stored = { ...anchor(), contentHash: hash(text) }, before = JSON.stringify(stored);
  expect(anchorStatus(stored, material(text))).toEqual({ status: "anchored" });
  expect(anchorStatus(stored, { state: "unavailable", path: "report.md", side: "head" })).toEqual({ status: "unavailable" });
  expect(anchorStatus(stored, material(text, { path: "foreign.md" }))).toEqual({ status: "unavailable" });
  expect(anchorStatus(stored, material(text, { side: "base" }))).toEqual({ status: "unavailable" });
  const projected = { ...stored, projection: { name: "docx-text", version: "1" } };
  expect(anchorStatus(projected, material(text, { projection: { name: "docx-text", version: "1" } }))).toEqual({ status: "anchored" });
  for (const projection of [undefined, { name: "docx-text", version: "2" }, { name: "other-converter", version: "1" }]) expect(anchorStatus(projected, material(text, { projection }))).toEqual({ status: "outdated" });
  expect(anchorStatus(stored, material(text, { projection: { name: "docx-text", version: "1" } }))).toEqual({ status: "outdated" });
  expect(JSON.stringify(stored)).toBe(before);
});

test("changed content moves only uniquely resolved ordered quotes, with display-only line ranges", () => {
  const selected = anchor([{ kind: "lineRange", startLine: 1, endLine: 1 }, quote("첫째\n둘째\n")]);
  const before = JSON.stringify(selected);
  expect(anchorStatus(selected, material("header\n\n첫째\n둘째\nlast"))).toEqual({ status: "moved", range: { startLine: 3, endLine: 4 } });
  expect(JSON.stringify(selected)).toBe(before);
  expect(anchorStatus(anchor([quote("passage")]), material("passage\npassage"))).toEqual({ status: "outdated" });
  expect(anchorStatus(anchor([quote("passage", "B:", "!")]), material("A:passage?\nB:passage!"))).toEqual({ status: "moved", range: { startLine: 2, endLine: 2 } });
  expect(anchorStatus(anchor([quote("missing"), quote("second")]), material("first\nsecond"))).toEqual({ status: "moved", range: { startLine: 2, endLine: 2 } });
  expect(anchorStatus(anchor([{ kind: "lineRange", startLine: 1, endLine: 1 }, { kind: "structural", scheme: "md", ref: "heading" }]), material("edited"))).toEqual({ status: "outdated" });
});
