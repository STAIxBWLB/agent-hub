import { expect, test } from "bun:test";
import { evidenceLinkCanonical, evidenceLinkId, parseEvidenceLink, parseEvidenceRecord, type EvidenceLinkV1 } from "../src/hub/research-evidence.ts";

function proposal() {
  return {
    claimId: "claim:7:123:1", claimRevision: "0123456789abcdef", sourceId: "src:0123456789abcdef",
    rawSha256: "a".repeat(64), projectionSha256: "b".repeat(64), projectionVersion: "text/plain@1",
    locator: { start: 0, end: 1 }, relation: "supports" as const, taskId: 7,
  };
}
function stored(): EvidenceLinkV1 {
  const input = parseEvidenceRecord(proposal());
  return { ...input, id: evidenceLinkId(input, "codex"), recordedBy: "codex" };
}

test("evidence proposals default only the first revision and stored links require host identity", () => {
  const initial = parseEvidenceRecord(proposal());
  expect(initial.revision).toBe(1);
  expect(initial).not.toHaveProperty("id");
  expect(initial).not.toHaveProperty("recordedBy");
  expect(() => parseEvidenceRecord({ ...proposal(), recordedBy: "user" })).toThrow();
  expect(() => parseEvidenceRecord({ ...proposal(), recordedBy: undefined })).toThrow();
  expect(() => parseEvidenceRecord({ ...proposal(), revision: 2 })).toThrow("existing link");
  const link = stored();
  expect(parseEvidenceRecord({ ...proposal(), id: link.id, revision: 2 })).toMatchObject({ id: link.id, revision: 2 });
  expect(parseEvidenceLink(link)).toEqual(link);
  for (const field of ["id", "recordedBy", "revision"] as const) {
    const incomplete: Record<string, unknown> = { ...link }; delete incomplete[field];
    expect(() => parseEvidenceLink(incomplete)).toThrow();
  }
});

test("support and counterevidence preserve distinct source references without adding judgment or narrative fields", () => {
  const support = stored();
  const contrary = parseEvidenceLink({ ...support, id: "ev:" + "c".repeat(32), sourceId: "src:fedcba9876543210", relation: "contradicts", locator: { start: 9, end: 40 } });
  expect(support.claimId).toBe(contrary.claimId);
  expect(support.claimRevision).toBe(contrary.claimRevision);
  expect(support.sourceId).not.toBe(contrary.sourceId);
  expect(contrary.relation).toBe("contradicts");
  expect(parseEvidenceRecord({ ...proposal(), relation: "context" }).relation).toBe("context");
  expect(Object.keys(support).sort()).toEqual(["id", "claimId", "claimRevision", "sourceId", "rawSha256", "projectionSha256", "projectionVersion", "locator", "relation", "recordedBy", "taskId", "revision"].sort());
  for (const field of ["excerpt", "body", "claimText", "origin", "path", "page", "section", "verdict", "verified", "judgment"]) {
    expect(() => parseEvidenceRecord({ ...proposal(), [field]: "PRIVATE_EVIDENCE_CANARY" })).toThrow();
    expect(() => parseEvidenceLink({ ...support, [field]: "PRIVATE_EVIDENCE_CANARY" })).toThrow();
  }
  for (const field of ["page", "section", "excerpt", "unit", "text"]) {
    expect(() => parseEvidenceRecord({ ...proposal(), locator: { start: 0, end: 1, [field]: "invented" } })).toThrow();
  }
});

test("locator proposals use nonempty safe half-open bounds with a 4096 scalar span ceiling", () => {
  for (const locator of [{ start: 0, end: 4096 }, { start: Number.MAX_SAFE_INTEGER - 4096, end: Number.MAX_SAFE_INTEGER }, { start: 8, end: 9 }]) {
    expect(parseEvidenceRecord({ ...proposal(), locator }).locator).toEqual(locator);
  }
  for (const locator of [
    { start: 0, end: 4097 }, { start: 0, end: 0 }, { start: 9, end: 8 }, { start: -1, end: 1 },
    { start: 0.5, end: 1 }, { start: 0, end: 1.5 }, { start: NaN, end: 1 }, { start: 0, end: Infinity },
    { start: 0, end: Number.MAX_SAFE_INTEGER + 1 }, { start: "0", end: 1 }, { start: 0 }, { end: 1 }, null, [],
  ]) expect(() => parseEvidenceRecord({ ...proposal(), locator })).toThrow();
  // T1 records proposed bounds only. Resolving Unicode projection contents is the separate T2 contract.
});

test("evidence identifiers, hashes, projection versions and integer metadata reject malformed boundaries", () => {
  for (const patch of [
    { id: "ev:" + "a".repeat(31) }, { id: "ev:" + "A".repeat(32) },
    { claimId: "claim:0:123:1" }, { claimId: "claim:7:123:0" }, { claimId: "claim:7:123:51" },
    { claimId: "claim:07:123:1" }, { claimId: "claim:7:0123:1" }, { claimId: "claim:9007199254740992:123:1" },
    { claimRevision: "a".repeat(15) }, { claimRevision: "A".repeat(16) },
    { sourceId: "https://example.test/paper" }, { sourceId: "doi:10.1234/example" }, { sourceId: "src:" + "A".repeat(16) },
    { rawSha256: "a".repeat(63) }, { rawSha256: "A".repeat(64) }, { projectionSha256: "b".repeat(65) },
    { projectionVersion: "" }, { projectionVersion: "v".repeat(65) }, { projectionVersion: "v 1" }, { projectionVersion: "v\n1" },
    { taskId: 0 }, { taskId: 1.5 }, { taskId: Number.MAX_SAFE_INTEGER + 1 }, { revision: 0 }, { revision: NaN }, { revision: "1" },
    { relation: "verified" }, { relation: "SUPPORTS" },
  ]) expect(() => parseEvidenceRecord({ ...proposal(), ...patch })).toThrow();
  expect(parseEvidenceRecord({ ...proposal(), claimId: "claim:7:0:50", projectionVersion: "v".repeat(64) }).claimId).toBe("claim:7:0:50");
  expect(parseEvidenceLink({ ...stored(), recordedBy: "x".repeat(128) }).recordedBy).toHaveLength(128);
  for (const recordedBy of ["", "x".repeat(129), "user name", "user\nname", 7]) {
    expect(() => parseEvidenceLink({ ...stored(), recordedBy })).toThrow();
  }
});

test("closed evidence data rejects proxies, accessors and serialization callbacks without running them", () => {
  let calls = 0;
  const run = () => { calls++; throw new Error("untrusted evidence callback executed"); };
  const proxy = new Proxy(proposal(), { get: run, ownKeys: run, getPrototypeOf: run, getOwnPropertyDescriptor: run });
  const accessor = Object.defineProperty(proposal(), "claimId", { get: run });
  const serializer = { ...proposal(), toJSON: run };
  const hiddenSerializer = Object.defineProperty(proposal(), "toJSON", { value: run, enumerable: false });
  const hiddenUnknown = Object.defineProperty(proposal(), "excerpt", { value: "PRIVATE_EVIDENCE_CANARY", enumerable: false });
  const symbolic = { ...proposal(), [Symbol("hidden narrative")]: "PRIVATE_EVIDENCE_CANARY" };
  for (const value of [proxy, accessor, serializer, hiddenSerializer, hiddenUnknown, symbolic, Object.create(proposal()), [], new Date(), null]) {
    expect(() => parseEvidenceRecord(value)).toThrow();
  }
  const locatorProxy = new Proxy({ start: 0, end: 1 }, { get: run, ownKeys: run, getPrototypeOf: run });
  const locatorAccessor = Object.defineProperty({ end: 1 }, "start", { get: run });
  const locatorHidden = Object.defineProperty({ start: 0, end: 1 }, "excerpt", { value: "PRIVATE_EVIDENCE_CANARY", enumerable: false });
  for (const locator of [locatorProxy, locatorAccessor, locatorHidden, { start: 0, end: 1, toJSON: run }]) {
    expect(() => parseEvidenceRecord({ ...proposal(), locator })).toThrow();
  }
  const storedAccessor = Object.defineProperty(stored(), "recordedBy", { get: run });
  expect(() => evidenceLinkCanonical(storedAccessor)).toThrow();
  expect(calls).toBe(0);
  expect(parseEvidenceRecord(Object.assign(Object.create(null), proposal()))).toEqual(parseEvidenceRecord(proposal()));
});

test("initial identity and canonical records are deterministic across key order and detached from caller mutation", () => {
  const input = proposal(), normalized = parseEvidenceRecord(input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  expect(evidenceLinkId(parseEvidenceRecord(reordered), "codex")).toBe(evidenceLinkId(normalized, "codex"));
  expect(evidenceLinkId(parseEvidenceRecord({ ...input, revision: 1 }), "codex")).toBe(evidenceLinkId(normalized, "codex"));
  expect(evidenceLinkId(normalized, "codex")).toMatch(/^ev:[0-9a-f]{32}$/);
  expect(evidenceLinkId(normalized, "pi")).not.toBe(evidenceLinkId(normalized, "codex"));
  expect(evidenceLinkId(parseEvidenceRecord({ ...input, relation: "contradicts" }), "codex")).not.toBe(evidenceLinkId(normalized, "codex"));
  const link = stored(), canonical = evidenceLinkCanonical(link);
  expect(evidenceLinkCanonical(Object.fromEntries(Object.entries(link).reverse()) as unknown as EvidenceLinkV1)).toBe(canonical);
  expect(JSON.parse(canonical)).toEqual(link);
  expect(evidenceLinkId(parseEvidenceRecord({ ...input, id: link.id, revision: 2 }), "codex")).toBe(link.id);
  const snapshot = parseEvidenceLink(link);
  input.locator.end = 9; link.locator.end = 17;
  expect(normalized.locator).toEqual({ start: 0, end: 1 });
  expect(snapshot.locator).toEqual({ start: 0, end: 1 });
  snapshot.locator.start = 4;
  expect(link.locator.start).toBe(0);
  expect(JSON.parse(canonical).locator).toEqual({ start: 0, end: 1 });
});
