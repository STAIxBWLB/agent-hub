import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseClaimVerdict } from "../src/hub/board.ts";
import { checkSynthesis, inventoryBinding, synthesisManifestHash, type SynthesisCurrent, type SynthesisManifestV1 } from "../src/hub/synthesis-readiness.ts";
import type { EvidenceLinkV1 } from "../src/hub/research-evidence.ts";

const manifestSha256 = "a".repeat(64);
test("#901 synthesis disposition is additive and leaves legacy verdict shape unchanged", () => {
  const legacy = { slot: 1, verdict: "supported", model: "fixture-model", modelVerdict: "unclear" } as const;
  expect(parseClaimVerdict(legacy, 2)).toEqual(legacy);
  expect(parseClaimVerdict({ slot: 1, verdict: "unclear" }, 1)).toEqual({ slot: 1, verdict: "unclear" });
  for (const disposition of ["resolved", "qualified"] as const) {
    const input = { ...legacy, synthesis: { manifestSha256, disposition } };
    const result = parseClaimVerdict(input, 2);
    expect(result).toEqual(input); expect(result.synthesis).not.toBe(input.synthesis);
    expect(result).not.toHaveProperty("list"); // The existing host stamps claim-list authority, never this caller parser.
  }
});

test("#901 synthesis hash and disposition use a closed bounded shape", () => {
  const base = { slot: 1, verdict: "supported" };
  for (const synthesis of [null, [], {}, { manifestSha256 }, { disposition: "qualified" },
    ...["", "a".repeat(63), "A".repeat(64), "g".repeat(64), 4].map(hash => ({ manifestSha256: hash, disposition: "qualified" })),
    ...["supported", "accepted", "QUALIFIED", true].map(disposition => ({ manifestSha256, disposition })),
    { manifestSha256, disposition: "resolved", note: "PRIVATE_JUDGMENT_CANARY" }]) {
    expect(() => parseClaimVerdict({ ...base, synthesis }, 1)).toThrow();
  }
  expect(() => parseClaimVerdict({ ...base, list: "f".repeat(16) }, 1)).toThrow();
  expect(() => parseClaimVerdict({ ...base, slot: 2, synthesis: { manifestSha256, disposition: "qualified" } }, 1)).toThrow();
  expect(() => parseClaimVerdict({ ...base, slot: 51 }, 100)).toThrow();
});

test("#901 verdict and nested synthesis proxies/getters/toJSON are refused without invocation", () => {
  let invoked = 0;
  const base = { slot: 1, verdict: "supported" }, synthesis = { manifestSha256, disposition: "qualified" };
  const getter = { ...base }; Object.defineProperty(getter, "synthesis", { enumerable: true, get() { invoked++; return synthesis; } });
  const nestedGetter = { ...synthesis }; Object.defineProperty(nestedGetter, "manifestSha256", { enumerable: true, get() { invoked++; return manifestSha256; } });
  const rootProxy = new Proxy(base, { ownKeys() { invoked++; return []; } });
  const nestedProxy = new Proxy(synthesis, { ownKeys() { invoked++; return []; } });
  for (const input of [getter, rootProxy, { ...base, synthesis: nestedGetter }, { ...base, synthesis: nestedProxy },
    { ...base, toJSON() { invoked++; return base; } }, { ...base, synthesis: { ...synthesis, toJSON() { invoked++; return synthesis; } } }]) {
    expect(() => parseClaimVerdict(input, 1)).toThrow();
  }
  expect(invoked).toBe(0);
});

test("#901 parsed person disposition closes only the exact currently bound structural manifest", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex"), claimRevision = "b".repeat(16);
  const support: EvidenceLinkV1 = { id: "ev:" + "1".repeat(32), taskId: 7, claimId: "claim:7:123:1", claimRevision, revision: 1, recordedBy: "codex",
    sourceId: "src:" + "c".repeat(16), rawSha256: "d".repeat(64), projectionSha256: "e".repeat(64), projectionVersion: "fixture-v1", locator: { start: 0, end: 4 }, relation: "supports" };
  const counter = { ...support, id: "ev:" + "2".repeat(32), relation: "contradicts" as const };
  const md = "An explicitly qualified conclusion [@paper]", bib = "@article{paper, title={Fixture}}";
  const manifest: SynthesisManifestV1 = { schemaVersion: 1, taskId: 7, taskCreated: 123,
    deliverable: { id: "d-" + "1".repeat(12), sha256: sha(md) }, bibliography: { id: "d-" + "2".repeat(12), sha256: sha(bib) },
    claims: [{ claimId: support.claimId, claimRevision, inventory: inventoryBinding([support, counter], true)!, evidence: [{ id: support.id, revision: 1, citationKey: "paper" }] }] };
  const current: SynthesisCurrent = { taskId: 7, taskCreated: 123, deliverable: { ...manifest.deliverable, state: "unchanged", text: md },
    bibliography: { ...manifest.bibliography, state: "unchanged", text: bib }, claims: [{ claimId: support.claimId, claimRevision,
      inventory: { links: [support, counter], complete: true }, resolutions: [support, counter].map(link => ({ id: link.id, revision: 1, status: "resolved" as const })), judgment: { present: true } }] };
  expect(checkSynthesis(manifest, current).status).toBe("not_ready"); // A legacy supported verdict never closes declared counterevidence.
  const verdict = parseClaimVerdict({ slot: 1, verdict: "supported", synthesis: { manifestSha256: synthesisManifestHash(manifest), disposition: "qualified" } }, 1);
  current.claims![0]!.judgment = { present: true, ...verdict.synthesis };
  const ready = checkSynthesis(manifest, current);
  expect(ready.status).toBe("ready");
  if (!("claims" in ready)) throw new Error("expected separate human/provenance statuses");
  expect(ready.claims[0]).toMatchObject({ judgment: "present", contradiction: "qualified", provenance: "resolved" });
  current.claims![0]!.judgment = { present: true, ...verdict.synthesis, manifestSha256: "f".repeat(64) };
  const stalePersonBinding = checkSynthesis(manifest, current);
  expect(stalePersonBinding.status).toBe("not_ready");
  if (!("claims" in stalePersonBinding)) throw new Error("expected contradiction status");
  expect(stalePersonBinding.claims[0]?.contradiction).toBe("open");
});
