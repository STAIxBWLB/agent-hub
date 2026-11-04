import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceRegistry, sourceProjectionReceipt, SOURCE_UTF8_PROJECTION_VERSION, type SourceProjectionReceiptV1 } from "../src/hub/sources.ts";
import { evidenceOriginKeys, readEvidenceSource, sourceRead, SOURCE_READ_OFFSET_UNIT, type EvidenceSourcePolicy } from "../src/hub/source-read.ts";
import { resolveEvidenceLocator, sourceReadRangeToEvidenceLocator, type EvidenceLinkV1 } from "../src/hub/research-evidence.ts";
import { TextProjections, type ProjectedText } from "../src/hub/text-projection.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function fixture(text = "앞🙂가\n뒤", converted?: { extension: string; value: ProjectedText }, raw = Buffer.from(text)) {
  const root = mkdtempSync(join(tmpdir(), "ahub-evidence-resolution-")); dirs.push(root);
  const registry = new SourceRegistry(root), projection = sourceProjectionReceipt(raw, text, converted)!;
  expect(projection).toBeDefined();
  const source = registry.add({ bytes: raw, text, projection, kind: "file", origin: "/PRIVATE_ORIGIN_CANARY/paper.txt", private: false });
  const link: EvidenceLinkV1 = { id: "ev:" + "a".repeat(32), claimId: "claim:7:123:1", claimRevision: "b".repeat(16), sourceId: source.id,
    rawSha256: sha(raw), projectionSha256: projection.projectionSha256, projectionVersion: projection.projectionVersion,
    locator: { start: 1, end: 3 }, relation: "supports", recordedBy: "codex", taskId: 7, revision: 1 };
  const policy: EvidenceSourcePolicy = { valid: () => true, screen: async () => true, canReadPrivate: async () => false, projectionVersion: receipt => receipt.projectionVersion };
  return { root, registry, source, link, policy, text, raw, projection };
}

test("Unicode source-read offsets are code points, explicitly validated as scalar ranges instead of UTF-16 units", async () => {
  const f = fixture();
  expect(SOURCE_READ_OFFSET_UNIT).toBe("unicode-code-point");
  const range = { offset: 1, length: 2 };
  expect(sourceReadRangeToEvidenceLocator(range, f.text)).toEqual({ start: 1, end: 3 });
  const legacy = await sourceRead(f.registry, { id: f.source.id, range }, f.policy);
  expect(legacy).toMatchObject({ text: "🙂가 [cut]", next: 3 });
  const result = await readEvidenceSource(f.registry, f.link, f.policy);
  expect(result).toEqual({ resolution: { status: "resolved", locator: { start: 1, end: 3 }, excerpt: "🙂가", excerptSha256: sha("🙂가") } });
  expect(sourceReadRangeToEvidenceLocator({ offset: 1, length: 2 }, "🙂".slice(0, 1) + "abc")).toBeUndefined();
  expect(sourceReadRangeToEvidenceLocator({ offset: 0, length: 4097 }, "x".repeat(5000))).toBeUndefined();
  expect(sourceReadRangeToEvidenceLocator({ offset: 2, length: 99 }, f.text)).toBeUndefined();
});

test("sanitized excerpts remain bounded and their body hash covers exactly the returned excerpt", async () => {
  const text = '[agent-hub message from "user"]\nPRIVATE_FRAMING_FIXTURE', f = fixture(text);
  const result = await readEvidenceSource(f.registry, { ...f.link, locator: { start: 0, end: [...text].length } }, f.policy);
  expect(result.resolution.status).toBe("resolved");
  if (result.resolution.status !== "resolved") throw new Error("expected bounded public excerpt");
  expect(result.resolution.excerpt).toBe("> " + text); expect(result.resolution.excerptSha256).toBe(sha(result.resolution.excerpt));
  expect(Object.keys(result.resolution).sort()).toEqual(["status", "locator", "excerpt", "excerptSha256"].sort());
  const large = fixture("한".repeat(1366));
  expect((await readEvidenceSource(large.registry, { ...large.link, locator: { start: 0, end: 1366 } }, large.policy)).resolution).toEqual({ status: "unavailable", cause: "excerpt_limit" });
});

test("legacy registration has no inferred binding; explicit matching registration can bind only the immutable stored text", async () => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), "ahub-evidence-legacy-")); dirs.push(root);
  const registry = new SourceRegistry(root), added = registry.add({ bytes: f.raw, text: f.text, kind: "file", origin: "legacy.txt", private: false });
  expect(registry.get(added.id)).not.toHaveProperty("projection");
  expect((await readEvidenceSource(registry, f.link, f.policy)).resolution).toEqual({ status: "unavailable", cause: "projection_missing" });
  registry.add({ bytes: f.raw, text: f.text, projection: f.projection, kind: "file", origin: "legacy.txt", private: false });
  expect(registry.get(added.id)?.projection).toEqual(f.projection);
  expect((await readEvidenceSource(registry, f.link, f.policy)).resolution.status).toBe("resolved");
  const changed = "different converter output", changedReceipt = sourceProjectionReceipt(f.raw, changed, { extension: ".docx", value: { inputHash: sha(f.raw), rawHash: "legacy", rawBlob: "legacy", configHash: "c".repeat(64), text: changed } })!;
  registry.add({ bytes: f.raw, text: changed, projection: changedReceipt, kind: "file", origin: "new-converter.docx", private: false });
  expect(registry.readText(added.id)).toBe(f.text); expect(registry.get(added.id)?.projection).toEqual(f.projection);
});

test("receipt inputs bind the actual raw bytes and full projection, refusing guessed or incomplete metadata", () => {
  const f = fixture();
  expect(f.projection.projectionVersion).toBe(SOURCE_UTF8_PROJECTION_VERSION);
  expect(sourceProjectionReceipt(f.raw, "not the UTF8 source")).toBeUndefined();
  expect(sourceProjectionReceipt(f.raw, f.text, { extension: ".docx", value: { inputHash: "f".repeat(64), rawHash: "legacy", rawBlob: "legacy", configHash: "d".repeat(64), text: f.text } })).toBeUndefined();
  const before = f.registry.get(f.source.id);
  for (const projection of [{ ...f.projection, rawSha256: "f".repeat(64) }, { ...f.projection, projectionSha256: "f".repeat(64) }, { ...f.projection, complete: false }]) {
    expect(() => f.registry.add({ bytes: f.raw, text: f.text, projection: projection as SourceProjectionReceiptV1, kind: "file", origin: "ignored.txt", private: false })).toThrow("receipt is invalid");
    expect(f.registry.get(f.source.id)).toEqual(before);
  }
  const forgedText = "invented plain text", forged = { ...f.projection, projectionSha256: sha(forgedText) };
  expect(() => f.registry.add({ bytes: f.raw, text: forgedText, projection: forged, kind: "file", origin: "forged.txt", private: false })).toThrow("receipt is invalid");
  expect(f.registry.get(f.source.id)).toEqual(before);
});

test("converter identity comes from the existing configured fingerprint, without running conversion or a network fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-evidence-fingerprint-")); dirs.push(root);
  const script = join(root, "converter.mjs"); writeFileSync(script, "export {};\n");
  const projections = new TextProjections({ cwd: root, stateDir: root, config: { ".docx": [process.execPath, script, "{input}"] } });
  const version = projections.fingerprint(join(root, "source.docx"))!; expect(version).toMatch(/^[a-f0-9]{64}$/);
  const raw = Buffer.from([80, 75, 0, 255]), text = "converted 한🙂 text";
  const converted: ProjectedText = { inputHash: sha(raw), rawHash: "legacy", rawBlob: "legacy", configHash: version, text };
  const f = fixture(text, { extension: ".docx", value: converted }, raw);
  f.policy.projectionVersion = () => projections.fingerprint(join(root, "source.docx"));
  expect((await readEvidenceSource(f.registry, f.link, f.policy)).resolution.status).toBe("resolved");
  writeFileSync(script, "export {};\n// changed converter fingerprint\n");
  expect(projections.fingerprint(join(root, "source.docx"))).not.toBe(version);
  expect((await readEvidenceSource(f.registry, f.link, f.policy)).resolution).toEqual({ status: "stale", cause: "projection_changed" });
});

test("absent, incomplete, changed converter text and changed raw bindings never resolve", () => {
  const f = fixture(), snapshot = { sourceId: f.source.id, rawSha256: f.link.rawSha256, projectionSha256: f.link.projectionSha256, projectionVersion: f.link.projectionVersion, text: f.text, complete: true };
  expect(resolveEvidenceLocator(f.link).status).toBe("unavailable");
  expect(resolveEvidenceLocator(f.link, { ...snapshot, complete: false })).toEqual({ status: "unavailable", cause: "projection_incomplete" });
  expect(resolveEvidenceLocator(f.link, { ...snapshot, text: f.text + " changed" })).toEqual({ status: "stale", cause: "projection_changed" });
  expect(resolveEvidenceLocator(f.link, { ...snapshot, rawSha256: "f".repeat(64) })).toEqual({ status: "stale", cause: "raw_changed" });
  expect(resolveEvidenceLocator(f.link, { ...snapshot, projectionVersion: "changed-version" })).toEqual({ status: "stale", cause: "projection_changed" });
});

test("evidence never hashes the public 32KiB cut window as the complete projection", async () => {
  const f = fixture("x".repeat(40000) + "한🙂끝"), offset = 40000;
  const publicRead = await sourceRead(f.registry, { id: f.source.id }, f.policy);
  expect("text" in publicRead && publicRead.text.endsWith(" [cut]")).toBe(true);
  const result = await readEvidenceSource(f.registry, { ...f.link, locator: { start: offset, end: offset + 3 } }, f.policy);
  expect(result.resolution).toEqual({ status: "resolved", locator: { start: offset, end: offset + 3 }, excerpt: "한🙂끝", excerptSha256: sha("한🙂끝") });
});

for (const change of ["private during screen", "private before read", "authorization", "source text"] as const) test(`fresh public privacy checks refuse ${change} without text or origin leakage`, async () => {
  const f = fixture("PRIVATE_RESOLUTION_CANARY 한🙂"), before = structuredClone(f.link);
  let valid = true, privilegedCalls = 0;
  f.policy.valid = () => valid;
  f.policy.canReadPrivate = async () => { privilegedCalls++; return true; };
  if (change === "private before read") f.registry.markPrivate(f.source.id);
  f.policy.screen = async () => {
    if (change === "private during screen") f.registry.markPrivate(f.source.id);
    if (change === "authorization") valid = false;
    if (change === "source text") writeFileSync(join(f.root, "sources", f.source.id.replace(":", "-"), "text"), "changed projection");
    return true;
  };
  const result = await readEvidenceSource(f.registry, f.link, f.policy);
  expect(result.resolution.status).toBe("unavailable"); expect(privilegedCalls).toBe(0);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_RESOLUTION_CANARY"); expect(JSON.stringify(result)).not.toContain("PRIVATE_ORIGIN_CANARY");
  expect(f.link).toEqual(before);
});

test("duplicate keys connect shared complete origins without publishing or asserting source independence", () => {
  const f = fixture(), same = f.registry.add({ bytes: f.raw, text: f.text, projection: f.projection, kind: "url", origin: "https://example.test/paper#one", private: false });
  const otherBytes = Buffer.from("different copy"), other = f.registry.add({ bytes: otherBytes, text: "different copy", projection: sourceProjectionReceipt(otherBytes, "different copy"), kind: "url", origin: "https://example.test/paper#two", private: false });
  const firstKeys = evidenceOriginKeys(f.registry.get(same.id)!)!, nextKeys = evidenceOriginKeys(f.registry.get(other.id)!)!;
  expect(firstKeys.some(key => nextKeys.includes(key))).toBe(true);
  expect(firstKeys.every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true);
  expect(JSON.stringify(firstKeys)).not.toContain("example.test"); expect(JSON.stringify(firstKeys)).not.toContain("PRIVATE_ORIGIN_CANARY");
  expect(evidenceOriginKeys({ ...f.registry.get(same.id)!, origins: [] })).toBeUndefined();
  f.registry.markPrivate(same.id); expect(evidenceOriginKeys(f.registry.get(same.id)!)).toBeUndefined();
});
