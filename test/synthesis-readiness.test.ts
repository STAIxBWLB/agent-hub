import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkSynthesis, inventoryBinding, parseSynthesisManifest, synthesisManifestCanonical, synthesisManifestHash,
  type SynthesisCurrent, type SynthesisCurrentClaim, type SynthesisManifestV1, type SynthesisReadiness } from "../src/hub/synthesis-readiness.ts";
import type { EvidenceLinkV1 } from "../src/hub/research-evidence.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const REV = "a".repeat(16), claimId = "claim:7:123:1";
function link(hex = "1", relation: EvidenceLinkV1["relation"] = "supports"): EvidenceLinkV1 {
  return { id: `ev:${hex.repeat(32)}`, taskId: 7, claimId, claimRevision: REV, revision: 1, recordedBy: "codex", sourceId: "src:" + "a".repeat(16),
    rawSha256: "b".repeat(64), projectionSha256: "c".repeat(64), projectionVersion: "fixture-v1", locator: { start: 0, end: 4 }, relation };
}
function fixture(rows: EvidenceLinkV1[] = [link()]) {
  const md = "A bounded conclusion [@paper].", bib = "@article{paper, title={Fixture}}";
  const manifest: SynthesisManifestV1 = { schemaVersion: 1, taskId: 7, taskCreated: 123,
    deliverable: { id: "d-" + "1".repeat(12), sha256: hash(md) }, bibliography: { id: "d-" + "2".repeat(12), sha256: hash(bib) },
    claims: [{ claimId, claimRevision: REV, inventory: inventoryBinding(rows, true)!, evidence: [{ id: rows[0]!.id, revision: rows[0]!.revision, citationKey: "paper" }] }] };
  const claim: SynthesisCurrentClaim = { claimId, claimRevision: REV, inventory: { links: rows, complete: true },
    resolutions: rows.map(row => ({ id: row.id, revision: row.revision, status: "resolved" })), judgment: { present: true } };
  const current: SynthesisCurrent = { taskId: 7, taskCreated: 123, deliverable: { ...manifest.deliverable, state: "unchanged", text: md },
    bibliography: { ...manifest.bibliography, state: "unchanged", text: bib }, claims: [claim] };
  return { manifest, current, claim, rows };
}
function report(value: SynthesisReadiness) {
  if (value.status === "private") throw new Error("expected a public structural report");
  return value;
}

test("#931 manifest canonicalization copies inert fields and preserves exact revision bindings", () => {
  const f = fixture(), parsed = parseSynthesisManifest(f.manifest);
  expect(parsed).toEqual(f.manifest); expect(parsed).not.toBe(f.manifest);
  expect(synthesisManifestCanonical({ ...f.manifest, taskCreated: 123 })).toBe(synthesisManifestCanonical(parsed));
  expect(synthesisManifestHash(parsed)).toMatch(/^[a-f0-9]{64}$/);
  const changed = { ...parsed, claims: [{ ...parsed.claims[0]!, claimRevision: "d".repeat(16) }] };
  expect(synthesisManifestHash(changed)).not.toBe(synthesisManifestHash(parsed));
});

test("#931 inert parser rejects getters, proxies, toJSON, sparse lists and unknown narrative without executing them", () => {
  const f = fixture(); let invoked = 0;
  const getter = { ...f.manifest }; Object.defineProperty(getter, "taskId", { enumerable: true, get() { invoked++; return 7; } });
  const proxy = new Proxy(f.manifest, { ownKeys() { invoked++; return []; } });
  const narrative = { ...f.manifest, toJSON() { invoked++; return f.manifest; } };
  const sparse: unknown[] = []; sparse.length = 1;
  for (const bad of [getter, proxy, narrative, { ...f.manifest, claims: sparse }]) expect(() => parseSynthesisManifest(bad)).toThrow("invalid synthesis manifest");
  expect(invoked).toBe(0);
});

test("#931 custom array prototypes cannot execute inherited map or species during validation", () => {
  for (const field of ["claims", "evidence"] as const) {
    const f = fixture(); let invoked = 0;
    const values = field === "claims" ? [...f.manifest.claims] : [...f.manifest.claims[0]!.evidence];
    Object.setPrototypeOf(values, Object.create(Array.prototype, { map: { get() { invoked++; return Array.prototype.map; } } }));
    const input = field === "claims" ? { ...f.manifest, claims: values } : { ...f.manifest, claims: [{ ...f.manifest.claims[0]!, evidence: values }] };
    expect(() => parseSynthesisManifest(input)).toThrow("invalid synthesis manifest");
    expect(invoked).toBe(0);
  }
  const f = fixture(); let species = 0;
  class CallerArray extends Array { static get [Symbol.species]() { species++; return Array; } }
  const claims = [...f.manifest.claims]; Object.setPrototypeOf(claims, CallerArray.prototype);
  expect(() => parseSynthesisManifest({ ...f.manifest, claims })).toThrow("invalid synthesis manifest");
  expect(species).toBe(0);
});

test("#931 manifest count, identity, citation-key and selected-link bounds are enforced whole", () => {
  const f = fixture(), claim = f.manifest.claims[0]!;
  const bad = [
    { ...f.manifest, schemaVersion: 2 }, { ...f.manifest, claims: [] }, { ...f.manifest, taskId: Number.MAX_SAFE_INTEGER + 1 },
    { ...f.manifest, claims: [claim, claim] }, { ...f.manifest, claims: [{ ...claim, claimId: "claim:8:123:1" }] },
    { ...f.manifest, claims: [{ ...claim, claimRevision: "not-a-revision" }] },
    { ...f.manifest, claims: [{ ...claim, evidence: [{ ...claim.evidence[0]!, citationKey: "a".repeat(129) }] }] },
    { ...f.manifest, claims: [{ ...claim, evidence: [claim.evidence[0]!, claim.evidence[0]!] }] },
    { ...f.manifest, claims: Array.from({ length: 51 }, (_, i) => ({ ...claim, claimId: `claim:7:123:${i + 1}`, evidence: [] })) },
  ];
  for (const value of bad) expect(() => parseSynthesisManifest(value)).toThrow();
  const selected = Array.from({ length: 128 }, (_, i) => ({ id: `ev:${i.toString(16).padStart(32, "0")}`, revision: 1, citationKey: "paper" }));
  expect(() => parseSynthesisManifest({ ...f.manifest, claims: [{ ...claim, evidence: selected }, { ...claim, claimId: "claim:7:123:2", evidence: [{ id: "ev:" + "f".repeat(32), revision: 1, citationKey: "paper" }] }] })).toThrow();
});

test("#931 inventory binding covers all latest revisions, is order-independent and rejects incomplete/mixed/duplicate inputs", () => {
  const a = link(), b = link("2", "contradicts");
  expect(inventoryBinding([a, b], true)).toEqual(inventoryBinding([b, a], true));
  expect(inventoryBinding([a], true)?.revision).toBe(1);
  expect(inventoryBinding([a, { ...b, revision: 2 }], true)?.revision).toBe(3);
  for (const rows of [[a, a], [a, { ...b, claimId: "claim:7:123:2" }], [a, { ...b, taskId: 8 }], [a, { ...b, claimRevision: "d".repeat(16) }],
    [{ ...a, revision: Number.MAX_SAFE_INTEGER }, b], Array.from({ length: 129 }, () => a)]) expect(inventoryBinding(rows, true)).toBeUndefined();
  expect(inventoryBinding([a], false)).toBeUndefined();
  expect(inventoryBinding([{ link: a, status: "withdrawn" }], true)?.sha256).not.toBe(inventoryBinding([a], true)?.sha256);
  expect(inventoryBinding([{ ...a, relation: "context" }], true)?.sha256).not.toBe(inventoryBinding([a], true)?.sha256);
});

test("#931 ready means structural provenance only and a resolved bibliography alone is insufficient", () => {
  const f = fixture(), ready = report(checkSynthesis(f.manifest, f.current));
  expect(ready.status).toBe("ready"); expect(ready.scope).toBe("structural_provenance");
  const empty = fixture(); empty.manifest.claims[0]!.evidence = [];
  const noLink = report(checkSynthesis(empty.manifest, empty.current));
  expect(noLink.citations.state).toBe("resolved"); expect(noLink.status).not.toBe("ready");
  expect(noLink.claims[0]).toMatchObject({ evidenceLink: "missing", citationKey: "missing", judgment: "present" });
  f.claim.judgment = { present: false };
  const noJudgment = report(checkSynthesis(f.manifest, f.current));
  expect(noJudgment.claims[0]).toMatchObject({ evidenceLink: "present", locator: "resolved", judgment: "missing", contradiction: "none" });
  expect(noJudgment.status).toBe("not_ready");
});

test("#931 whole-report readiness requires every current declared claim in the manifest", () => {
  const f = fixture(), secondLink = { ...link("2"), claimId: "claim:7:123:2" };
  const second: SynthesisCurrentClaim = { claimId: secondLink.claimId, claimRevision: REV, inventory: { links: [secondLink], complete: true },
    resolutions: [{ id: secondLink.id, revision: 1, status: "resolved" }], judgment: { present: true } };
  f.current.claims = [f.claim, second];
  const partial = report(checkSynthesis(f.manifest, f.current));
  expect(partial.claims[0]?.next).toEqual([]); expect(partial.claimCoverage).toBe("partial");
  expect(partial.status).toBe("not_ready"); expect(partial.next).toContain("complete_manifest_claims");
  f.manifest.claims.push({ claimId: secondLink.claimId, claimRevision: REV, inventory: inventoryBinding([secondLink], true)!, evidence: [{ id: secondLink.id, revision: 1, citationKey: "paper" }] });
  const complete = report(checkSynthesis(f.manifest, f.current));
  expect(complete.claimCoverage).toBe("complete"); expect(complete.status).toBe("ready");
});

test("#931 missing or malformed full declared-claim lists are unknown, including foreign incarnation and duplicate slots", () => {
  for (const claims of [undefined, null, {}, [null], [], [fixture().claim, fixture().claim],
    [{ ...fixture().claim, claimId: "claim:7:124:1" }], [{ ...fixture().claim, claimRevision: "bad" }]]) {
    const f = fixture(); f.current.claims = claims as unknown as SynthesisCurrent["claims"];
    const result = report(checkSynthesis(f.manifest, f.current));
    expect(result.status).not.toBe("ready");
    expect(result.claimCoverage).toBe(Array.isArray(claims) && claims.length === 0 ? "partial" : "unknown");
    expect(result.next).toContain("complete_manifest_claims");
  }
});

test("#931 absent judgment and open contradiction are independent actionable statuses", () => {
  const f = fixture([link(), link("2", "contradicts")]); f.claim.judgment = { present: false };
  const result = report(checkSynthesis(f.manifest, f.current));
  expect(result.claims[0]).toMatchObject({ citationKey: "resolved", locator: "resolved", judgment: "missing", contradiction: "open" });
  expect(result.next).toContain("record_person_judgment"); expect(result.next).toContain("resolve_contradiction");
  f.claim.judgment = { present: true };
  expect(report(checkSynthesis(f.manifest, f.current)).claims[0]?.contradiction).toBe("open");
});

test("#931 only current exact-manifest person qualification/resolution closes declared contradictions", () => {
  for (const disposition of ["resolved", "qualified"] as const) {
    const f = fixture([link(), link("2", "contradicts")]);
    f.claim.judgment = { present: true, manifestSha256: "f".repeat(64), disposition };
    expect(report(checkSynthesis(f.manifest, f.current)).claims[0]?.contradiction).toBe("open");
    f.claim.judgment.manifestSha256 = synthesisManifestHash(f.manifest);
    expect(report(checkSynthesis(f.manifest, f.current)).claims[0]?.contradiction).toBe(disposition);
    expect(checkSynthesis(f.manifest, f.current).status).toBe("ready");
    f.claim.judgment.present = false;
    expect(report(checkSynthesis(f.manifest, f.current)).claims[0]?.contradiction).toBe("open");
  }
});

test("#931 ready then new unselected counterevidence invalidates the complete inventory and prior qualification", () => {
  const f = fixture(); f.claim.judgment = { present: true, manifestSha256: synthesisManifestHash(f.manifest), disposition: "qualified" };
  expect(checkSynthesis(f.manifest, f.current).status).toBe("ready");
  f.claim.inventory = { links: [...f.rows, link("2", "contradicts")], complete: true };
  const result = report(checkSynthesis(f.manifest, f.current));
  expect(result.status).toBe("stale"); expect(result.binding).toBe("stale");
  expect(result.claims[0]).toMatchObject({ inventory: "stale", evidenceLink: "present", judgment: "present", contradiction: "open" });
});

test("#931 revision, reclassification and withdrawal of even unselected links invalidate the old manifest", () => {
  for (const change of ["revision", "relation", "withdrawal"] as const) {
    const f = fixture([link(), link("2", "context")]), other = f.rows[1]!;
    f.claim.inventory = { complete: true, links: [f.rows[0]!, change === "withdrawal" ? { link: other, status: "withdrawn" } : { ...other, ...(change === "revision" ? { revision: 2 } : { relation: "contradicts" as const }) }] };
    expect(checkSynthesis(f.manifest, f.current).status).toBe("stale");
  }
});

test("#931 unchanged full inventory still needs fresh provenance for every unselected active link", () => {
  for (const status of ["stale", "unavailable", undefined] as const) {
    const f = fixture([link(), link("2", "context")]);
    expect(checkSynthesis(f.manifest, f.current).status).toBe("ready");
    f.claim.resolutions = [{ id: f.rows[0]!.id, revision: 1, status: "resolved" },
      ...(status ? [{ id: f.rows[1]!.id, revision: 1, status }] : [])];
    const result = report(checkSynthesis(f.manifest, f.current));
    expect(result.claims[0]).toMatchObject({ inventory: "current", locator: "resolved", provenance: status ?? "unknown" });
    expect(result.status).toBe(status === "stale" ? "stale" : "unknown");
    expect(result.next).toContain("resolve_locator");
  }
  const privateSource = fixture([link(), link("2", "context")]);
  privateSource.claim.resolutions = [{ id: privateSource.rows[0]!.id, revision: 1, status: "resolved" }, { id: privateSource.rows[1]!.id, revision: 1, status: "private" }];
  expect(checkSynthesis(privateSource.manifest, privateSource.current)).toEqual({ taskId: 7, status: "private" });
});

test("#931 withdrawn inventory rows stay hash-bound without requiring active source provenance", () => {
  const f = fixture([link(), link("2", "contradicts")]);
  f.claim.inventory = { links: [f.rows[0]!, { link: f.rows[1]!, status: "withdrawn" }], complete: true };
  f.manifest.claims[0]!.inventory = inventoryBinding(f.claim.inventory.links, true)!;
  f.claim.resolutions = [{ id: f.rows[0]!.id, revision: 1, status: "resolved" }];
  const result = report(checkSynthesis(f.manifest, f.current));
  expect(result.status).toBe("ready"); expect(result.claims[0]).toMatchObject({ inventory: "current", provenance: "resolved", locator: "resolved", contradiction: "none" });
});

test("#931 changed claim, source projection/locator and final artifact cannot retain readiness", () => {
  const claim = fixture(); claim.claim.claimRevision = "d".repeat(16);
  expect(checkSynthesis(claim.manifest, claim.current).status).toBe("stale");
  const source = fixture(); source.claim.resolutions = [{ id: source.rows[0]!.id, revision: 1, status: "stale" }];
  expect(report(checkSynthesis(source.manifest, source.current)).claims[0]?.locator).toBe("stale");
  expect(checkSynthesis(source.manifest, source.current).status).toBe("stale");
  const artifact = fixture(); artifact.current.deliverable = { ...artifact.current.deliverable!, state: "changed", sha256: hash("new report") };
  expect(report(checkSynthesis(artifact.manifest, artifact.current)).deliverable).toBe("changed");
  expect(checkSynthesis(artifact.manifest, artifact.current).status).toBe("stale");
  const inconsistent = fixture(); inconsistent.current.deliverable!.text = "changed text with an old claimed hash";
  expect(checkSynthesis(inconsistent.manifest, inconsistent.current).status).toBe("stale");
});

test("#931 missing/truncated inventories, absent source resolution and text stay unknown, never empty success", () => {
  for (const kind of ["incomplete", "absent", "resolution", "text"] as const) {
    const f = fixture();
    if (kind === "incomplete") f.claim.inventory!.complete = false;
    if (kind === "absent") f.claim.inventory = undefined;
    if (kind === "resolution") f.claim.resolutions = undefined;
    if (kind === "text") f.current.bibliography!.text = undefined;
    expect(checkSynthesis(f.manifest, f.current).status).toBe("unknown");
  }
  const f = fixture(); f.claim.inventory = { complete: true, links: [] };
  expect(checkSynthesis(f.manifest, f.current).status).toBe("stale");
});

test("#931 private snapshots are neutral and public results contain no keys, texts, origins, excerpts or paths", () => {
  const f = fixture(); f.current.private = true;
  expect(checkSynthesis(f.manifest, f.current)).toEqual({ taskId: 7, status: "private" });
  f.current.private = false;
  f.claim.resolutions = [{ id: f.rows[0]!.id, revision: 1, status: "private" }];
  expect(checkSynthesis(f.manifest, f.current)).toEqual({ taskId: 7, status: "private" });
  f.claim.resolutions = [{ id: f.rows[0]!.id, revision: 1, status: "resolved" }];
  const result = JSON.stringify(checkSynthesis(f.manifest, f.current));
  expect(result).not.toMatch(/paper|bounded conclusion|Fixture|sourceId|rawSha256|projectionSha256|recordedBy|citationKey":"paper|origin|excerpt|path/);
});
