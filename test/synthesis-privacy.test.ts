import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceRegistry, sourceProjectionReceipt } from "../src/hub/sources.ts";
import { readEvidenceSource, sourceRead, type EvidenceSourcePolicy, type SourceEvidenceRegistry } from "../src/hub/source-read.ts";
import type { EvidenceLinkV1 } from "../src/hub/research-evidence.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-synthesis-privacy-")); cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const registry = new SourceRegistry(cwd), text = "앞🙂근거 SOURCE_TEXT_CANARY 끝", bytes = Buffer.from(text), projection = sourceProjectionReceipt(bytes, text)!;
  const source = registry.add({ bytes, text, projection, kind: "file", origin: "PRIVATE_ORIGIN_CANARY/paper.txt", private: false });
  let marks = 0;
  const observed: SourceEvidenceRegistry = { get: id => registry.get(id), readText: id => registry.readText(id), readRaw: id => registry.readRaw(id),
    markPrivate: id => { marks++; return registry.markPrivate(id); } };
  const link: EvidenceLinkV1 = { id: "ev:" + "a".repeat(32), taskId: 7, claimId: "claim:7:123:1", claimRevision: "b".repeat(16), revision: 1, recordedBy: "codex",
    sourceId: source.id, rawSha256: projection.rawSha256, projectionSha256: projection.projectionSha256, projectionVersion: projection.projectionVersion,
    locator: { start: 0, end: 3 }, relation: "supports" };
  const policy: EvidenceSourcePolicy = { privacyReadOnly: true, valid: () => true, screen: async () => true, canReadPrivate: async () => false,
    projectionVersion: receipt => receipt.projectionVersion };
  return { registry, observed, source, text, link, policy, marks: () => marks };
}

test("#931 observational synthesis reads invoke the existing screen and resolve only after a clear result", async () => {
  const f = fixture(), screened: string[] = [], before = f.registry.get(f.source.id);
  f.policy.screen = async text => { screened.push(text); return true; };
  const result = await readEvidenceSource(f.observed, f.link, f.policy);
  expect(result.resolution.status).toBe("resolved");
  expect(screened).toEqual([f.text]); expect(f.marks()).toBe(0);
  expect(f.registry.get(f.source.id)).toEqual(before);
  if (result.resolution.status !== "resolved") throw new Error("expected screened registered provenance");
  expect(result.resolution.excerpt).toBe("앞🙂근");
});

for (const outcome of ["false", "throw", "unknown", "missing"] as const) test(`#931 observational ${outcome} screen is unavailable without privacy writes or excerpts`, async () => {
  const f = fixture(), before = f.registry.get(f.source.id);
  f.policy.screen = async () => {
    if (outcome === "throw") throw new Error("SCREEN_ERROR_CANARY");
    if (outcome === "unknown") return "unknown" as unknown as boolean;
    if (outcome === "missing") return undefined as unknown as boolean;
    return false;
  };
  const result = await readEvidenceSource(f.observed, f.link, f.policy);
  expect(result).toEqual({ resolution: { status: "unavailable", cause: "source_unavailable" } });
  expect(f.marks()).toBe(0); expect(f.registry.get(f.source.id)).toEqual(before);
  expect(JSON.stringify(result)).not.toMatch(/SOURCE_TEXT_CANARY|PRIVATE_ORIGIN_CANARY|SCREEN_ERROR_CANARY|excerpt/);
});

test("#931 direct observational sourceRead refuses a failed screen before markPrivate", async () => {
  const f = fixture(); f.policy.screen = async () => false;
  await expect(sourceRead(f.observed, { id: f.source.id }, f.policy)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.marks()).toBe(0); expect(f.registry.get(f.source.id)?.private).toBe(false);
});

for (const screenResult of [true, false] as const) test(`#931 an external privacy upgrade during an awaited ${screenResult ? "clear" : "failed"} screen stays withheld`, async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const screening = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.policy.screen = async () => { entered(); await gate; return screenResult; };
  const pending = readEvidenceSource(f.observed, f.link, f.policy);
  await screening;
  f.registry.markPrivate(f.source.id); // A different authority's real monotonic upgrade, not the read-only check.
  release();
  const result = await pending;
  expect(result).toEqual({ resolution: { status: "unavailable", cause: "private" } });
  expect(f.marks()).toBe(0); expect(f.registry.get(f.source.id)?.private).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/SOURCE_TEXT_CANARY|PRIVATE_ORIGIN_CANARY|excerpt/);
});

test("#931 ordinary evidence/source reads retain the existing failed-screen monotonic privacy upgrade", async () => {
  const source = fixture(); delete source.policy.privacyReadOnly; source.policy.screen = async () => false;
  const result = await sourceRead(source.observed, { id: source.source.id }, source.policy);
  expect(result).toEqual({ id: source.source.id, kind: "file", private: true });
  expect(source.marks()).toBe(1); expect(source.registry.get(source.source.id)?.private).toBe(true);
  const evidence = fixture(); delete evidence.policy.privacyReadOnly; evidence.policy.screen = async () => false;
  expect(await readEvidenceSource(evidence.observed, evidence.link, evidence.policy)).toEqual({ resolution: { status: "unavailable", cause: "private" } });
  expect(evidence.marks()).toBe(1); expect(evidence.registry.get(evidence.source.id)?.private).toBe(true);
});

test("#931 privacyReadOnly remains a host policy port, never a public sourceRead argument", async () => {
  const f = fixture(); let screened = false;
  f.policy.screen = async () => { screened = true; return true; };
  await expect(sourceRead(f.observed, { id: f.source.id, privacyReadOnly: true }, f.policy)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(screened).toBe(false); expect(f.marks()).toBe(0);
});
