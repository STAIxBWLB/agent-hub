import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { evidenceLinkCanonical, evidenceLinkId, parseEvidenceLink, parseEvidenceRecord, type EvidenceLinkV1, type EvidenceRecordInput } from "../src/hub/research-evidence.ts";
import { checkSynthesis, inventoryBinding, synthesisManifestHash, type SynthesisCurrent, type SynthesisManifestV1 } from "../src/hub/synthesis-readiness.ts";

const claimRevision = "a".repeat(16), raw = "b".repeat(64), projection = "c".repeat(64), sourceId = "src:" + "d".repeat(16), id = "ev:" + "1".repeat(32);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function legacy(): EvidenceRecordInput {
  return { claimId: "claim:7:123:1", claimRevision, sourceId, rawSha256: raw, projectionSha256: projection,
    projectionVersion: "fixture-v1", locator: { start: 0, end: 4 }, relation: "supports", taskId: 7, revision: 1 };
}
function stored(): EvidenceLinkV1 {
  const { status: _omitted, ...input } = legacy();
  return { ...input, id, recordedBy: "codex" };
}

test("#931 withdrawal preserves the exact legacy canonical bytes and initial-id hash input", () => {
  // Frozen old field ordering, independent of the current parser/canonicalizer implementation.
  const inputBytes = `{"claimId":"claim:7:123:1","claimRevision":"${claimRevision}","sourceId":"${sourceId}","rawSha256":"${raw}","projectionSha256":"${projection}","projectionVersion":"fixture-v1","locator":{"start":0,"end":4},"relation":"supports","taskId":7,"revision":1,"recordedBy":"codex"}`;
  const canonicalBytes = `{"id":"${id}","claimId":"claim:7:123:1","claimRevision":"${claimRevision}","sourceId":"${sourceId}","rawSha256":"${raw}","projectionSha256":"${projection}","projectionVersion":"fixture-v1","locator":{"start":0,"end":4},"relation":"supports","recordedBy":"codex","taskId":7,"revision":1}`;
  const expectedId = `ev:${sha(inputBytes).slice(0, 32)}`;
  expect(evidenceLinkId(legacy(), "codex")).toBe(expectedId);
  expect(evidenceLinkId({ ...legacy(), status: "active" }, "codex")).toBe(expectedId);
  expect(parseEvidenceRecord({ ...legacy(), status: "active" })).toEqual(legacy());
  expect(evidenceLinkCanonical(stored())).toBe(canonicalBytes);
  expect(evidenceLinkCanonical({ ...stored(), status: "active" } as unknown as EvidenceLinkV1)).toBe(canonicalBytes);
  expect(parseEvidenceLink(stored())).not.toHaveProperty("status");
});

test("#931 withdrawal requires an existing-id later revision and remains explicit in canonical storage", () => {
  expect(() => parseEvidenceRecord({ ...legacy(), status: "withdrawn" })).toThrow(/later revision/);
  expect(() => parseEvidenceRecord({ ...legacy(), revision: 2, status: "withdrawn" })).toThrow(/existing link/);
  const input = { ...legacy(), id, revision: 2, status: "withdrawn" as const };
  expect(parseEvidenceRecord(input)).toEqual(input);
  expect(evidenceLinkId(input, "codex")).toBe(id);
  const link = parseEvidenceLink({ ...input, recordedBy: "codex" });
  expect(link.status).toBe("withdrawn");
  expect(evidenceLinkCanonical(link).endsWith('"revision":2,"status":"withdrawn"}')).toBe(true);
  expect(inventoryBinding([link], true)?.revision).toBe(2);
  expect(inventoryBinding([link], true)?.sha256).not.toBe(inventoryBinding([stored()], true)?.sha256);
});

test("#931 withdrawal parser rejects unsupported status/fields and inert-input traps without effects", () => {
  let invoked = 0;
  const input = { ...legacy(), id, revision: 2 };
  const getter = { ...input }; Object.defineProperty(getter, "status", { enumerable: true, get() { invoked++; return "withdrawn"; } });
  const locatorGetter = { ...input, locator: Object.defineProperty({}, "start", { enumerable: true, get() { invoked++; return 0; } }) };
  const proxy = new Proxy(input, { ownKeys() { invoked++; return []; } });
  const toJSON = { ...input, toJSON() { invoked++; return input; } };
  for (const value of [getter, locatorGetter, proxy, toJSON, { ...input, reason: "PRIVATE_WITHDRAWAL_CANARY" },
    ...[null, 1, false, {}, "inactive", "Withdrawn"].map(status => ({ ...input, status }))]) {
    expect(() => parseEvidenceRecord(value)).toThrow();
  }
  expect(invoked).toBe(0);
  expect(() => parseEvidenceLink({ ...stored(), revision: 1, status: "withdrawn" })).toThrow(/later revision/);
});

test("#931 stored withdrawn unselected links stay inventory-bound but need no active provenance", () => {
  const support = stored(), counter = { ...stored(), id: "ev:" + "2".repeat(32), relation: "contradicts" as const };
  const withdrawn = parseEvidenceLink({ ...counter, revision: 2, status: "withdrawn" });
  const md = "Fixture claim [@paper]", bib = "@article{paper, title={Fixture}}";
  const manifest: SynthesisManifestV1 = { schemaVersion: 1, taskId: 7, taskCreated: 123,
    deliverable: { id: "d-" + "1".repeat(12), sha256: sha(md) }, bibliography: { id: "d-" + "2".repeat(12), sha256: sha(bib) },
    claims: [{ claimId: support.claimId, claimRevision, inventory: inventoryBinding([support, counter], true)!, evidence: [{ id: support.id, revision: 1, citationKey: "paper" }] }] };
  const current: SynthesisCurrent = { taskId: 7, taskCreated: 123, deliverable: { ...manifest.deliverable, state: "unchanged", text: md },
    bibliography: { ...manifest.bibliography, state: "unchanged", text: bib }, claims: [{ claimId: support.claimId, claimRevision,
      inventory: { links: [support, withdrawn], complete: true }, contradictionHistory: { ids: [counter.id], complete: true },
      resolutions: [{ id: support.id, revision: 1, status: "resolved" }], judgment: { present: true, verdict: "supported" } }] };
  const stale = checkSynthesis(manifest, current);
  expect(stale.status).toBe("stale");
  manifest.claims[0]!.inventory = inventoryBinding([support, withdrawn], true)!;
  const unresolved = checkSynthesis(manifest, current);
  expect(unresolved.status).toBe("not_ready");
  if (!("claims" in unresolved)) throw new Error("expected public structural statuses");
  expect(unresolved.claims[0]).toMatchObject({ inventory: "current", provenance: "resolved", locator: "resolved", contradiction: "withdrawn" });
  current.claims![0]!.judgment = { present: true, verdict: "supported", manifestSha256: synthesisManifestHash(manifest), disposition: "resolved" };
  expect(checkSynthesis(manifest, current).status).toBe("ready");
  manifest.claims[0]!.evidence = [{ id: withdrawn.id, revision: 2, citationKey: "paper" }];
  expect(checkSynthesis(manifest, current).status).not.toBe("ready");
});
