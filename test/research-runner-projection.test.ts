import { expect, test } from "bun:test";
import { declaredExperimentEvents, parseExperimentEvent, projectExperimentWithObservations, projectRunnerReceipt,
  type ExperimentEvent, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";
import type { AttemptReceiptV1 } from "../src/hub/research-runner.ts";

const HASH = "a".repeat(64), COMMIT = "b".repeat(40);
const protocol = (): ExperimentProtocolContract => ({ campaignId: "rc-0123456789ab", campaignRevision: 1, lineage: "fixture", claimIds: [],
  inputs: [], code: { commit: COMMIT }, environment: { descriptor: "Synthetic CPU fixture" }, method: "Project fixture evidence only",
  parameters: {}, seeds: [1], evaluator: { id: "fixture", version: "v1" }, metrics: [], role: "baseline", splits: [], resourceLimits: [], sealed: false });
const receipt = (): AttemptReceiptV1 => ({ receiptId: "receipt-one", runner: "fixture-runner", projectId: "fixture-project", attemptId: "ra-0123456789ab", protocolHash: HASH });
const sealedReceipt = (): AttemptReceiptV1 => ({ ...receipt(), codeCommit: COMMIT, imageDigest: `sha256:${HASH}`,
  containers: [{ id: "candidate-one", role: "candidate" }, { id: "evaluator-one", role: "evaluator" }],
  mounts: [{ container: "evaluator-one", path: "/evaluator", readOnly: true, purpose: "evaluator-code" }],
  network: "none", resourceLimits: [{ name: "cpus", value: 1, unit: "core" }], startedAt: 100, endedAt: 200, exitStatus: 0,
  outputs: [{ name: "result.json", sha256: HASH }], metricsFile: { name: "metrics.json", sha256: HASH } });
const unknown = { value: null, provenance: "unknown" } as const;

test("runner projection labels every carried field runner-attested and leaves existing evidence separate", () => {
  const p = protocol(), body = sealedReceipt(), before = projectExperimentWithObservations(p, [], []);
  const projection = projectRunnerReceipt(p, body);
  expect(projection).toMatchObject({ receiptId: body.receiptId, runner: body.runner, provenance: "runner-attested",
    sealing: { value: true, provenance: "runner-attested", evidence: body.receiptId },
    codeMatch: { value: true, provenance: "runner-attested", evidence: body.receiptId } });
  for (const [field, value] of Object.entries(body)) {
    if (["receiptId", "runner", "projectId", "attemptId", "protocolHash"].includes(field)) continue;
    expect(projection.values[field], field).toEqual({ value, provenance: "runner-attested", evidence: body.receiptId });
  }
  expect(JSON.stringify(projection)).not.toContain("host-observed");
  expect(before).toEqual(projectExperimentWithObservations(p, [], []));
  expect(before.declared.sealed).toEqual({ value: false, provenance: "declared" });
  expect(before.measured).toEqual([]);
  body.mounts![0]!.path = "/changed";
  expect(projection.values.mounts!.value).toEqual([{ container: "evaluator-one", path: "/evaluator", readOnly: true, purpose: "evaluator-code" }]);
});

test("missing receipt fields remain unknown and cannot manufacture a code match or verified sealing", () => {
  const p = protocol(), projection = projectRunnerReceipt(p, receipt());
  expect(Object.keys(projection.values).sort()).toEqual(["codeCommit", "imageDigest", "containers", "mounts", "network", "resourceLimits", "startedAt", "endedAt", "exitStatus", "outputs", "metricsFile"].sort());
  for (const value of Object.values(projection.values)) expect(value).toEqual(unknown);
  expect(projection.codeMatch).toEqual(unknown);
  expect(projection.sealing).toEqual({ value: false, provenance: "declared" });
  p.sealed = true;
  expect(projectRunnerReceipt(p, receipt()).sealing).toEqual({ value: true, provenance: "declared" });
});

test("each incomplete or inconsistent isolation case retains the declared sealing claim", () => {
  const full = sealedReceipt();
  const cases: AttemptReceiptV1[] = [receipt(), { ...full, containers: [] }, { ...full, mounts: [] },
    { ...full, containers: [{ id: "candidate-one", role: "candidate" }] },
    { ...full, containers: [{ id: "same", role: "candidate" }, { id: "same", role: "evaluator" }] },
    { ...full, mounts: [{ ...full.mounts![0]!, container: "missing" }] },
    { ...full, mounts: [{ ...full.mounts![0]!, readOnly: false }] },
    { ...full, mounts: [{ ...full.mounts![0]!, container: "candidate-one" }] },
    { ...full, mounts: [{ ...full.mounts![0]!, purpose: "other" }] }];
  for (const body of cases) for (const sealed of [false, true]) {
    expect(projectRunnerReceipt({ ...protocol(), sealed }, body).sealing).toEqual({ value: sealed, provenance: "declared" });
  }
});

test("a deliverable protocol keeps a signed commit as an independent claim with unknown code match", () => {
  const p = protocol(); p.code = { deliverable: { id: "d-0123456789ab", sha256: HASH } };
  const body = { ...receipt(), codeCommit: COMMIT }, projection = projectRunnerReceipt(p, body);
  expect(projection.values.codeCommit).toEqual({ value: COMMIT, provenance: "runner-attested", evidence: body.receiptId });
  expect(projection.codeMatch).toEqual(unknown);
  expect(projectRunnerReceipt(p, receipt()).codeMatch).toEqual(unknown);
  expect(() => projectRunnerReceipt(protocol(), { ...body, codeCommit: "c".repeat(40) })).toThrow("protocol commit mismatch");
});

test("projection revalidates bounded receipt data without treating caller fields as host evidence", () => {
  expect(() => projectRunnerReceipt(protocol(), { ...receipt(), network: "host" } as unknown as AttemptReceiptV1)).toThrow("network");
  expect(() => projectRunnerReceipt(protocol(), { ...receipt(), provenance: "host-observed" } as unknown as AttemptReceiptV1)).toThrow("unknown field");
  expect(() => projectRunnerReceipt(protocol(), { ...receipt(), outputs: [{ name: "result", sha256: "bad" }] })).toThrow("sha256");
});

test("generated runner attestation events never become declared or measured observations", () => {
  const attestation: ExperimentEvent = { kind: "attestation", body: { receiptId: "receipt-one" }, seq: 2, at: 200, provenance: "runner-attested" };
  const start: ExperimentEvent = { kind: "start", body: { startedAt: 100 }, seq: 1, at: 100, provenance: "declared" };
  expect(declaredExperimentEvents([start, attestation])).toEqual([start]);
  const projection = projectExperimentWithObservations(protocol(), [start, attestation], []);
  expect(projection.declared.startedAt).toEqual({ value: 100, provenance: "declared" });
  expect(projection.measured).toEqual([]);
  expect(() => parseExperimentEvent({ kind: "attestation", body: { receiptId: "receipt-one" } }, protocol())).toThrow();
  expect(() => projectExperimentWithObservations(protocol(), [start, attestation], [{ eventSeq: 2,
    observation: { source: "check", evidence: "01234567-0123-0123-0123-0123456789ab", values: { exitStatus: 0, timedOut: false, cancelled: false, durationMs: 1, createdAt: 200 } } }])).toThrow("declared event is unavailable");
});
