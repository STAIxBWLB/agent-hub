import { expect, test } from "bun:test";
import { experimentStatus, parseExperimentAttempt, parseExperimentEvent, parseExperimentProtocol, projectExperimentEvidence, protocolHash,
  type DeclaredExperimentEvent, type DeclaredExperimentEventInput, type ExperimentProtocolContract } from "../src/hub/research-experiments.ts";

const HASH = "a".repeat(64), SOURCE = "src:0123456789abcdef", RUN = "01234567-0123-0123-0123-0123456789ab";
function protocol(): ExperimentProtocolContract {
  return { campaignId: "rc-0123456789ab", campaignRevision: 1, lineage: "fixture", claimIds: ["claim-one"], inputs: [{ sourceId: SOURCE, sha256: HASH }],
    code: { commit: "b".repeat(40) }, environment: { descriptor: "Python 3.12 on Linux with API_KEY and HOME variable names", hash: HASH },
    method: "Compare bounded synthetic inputs", parameters: { alpha: 0.05, flags: [true, false, null], label: "", sizes: [1, 2] }, seeds: [0, 42, -1],
    evaluator: { id: "accuracy", version: "v1", hash: HASH }, metrics: [{ name: "accuracy", unit: "fraction", direction: "higher" }],
    role: "baseline", splits: ["test"], resourceLimits: [{ name: "elapsed", value: 10, unit: "seconds" }], sealed: false };
}
function event(input: DeclaredExperimentEventInput, seq: number): DeclaredExperimentEvent {
  return { ...parseExperimentEvent(input, protocol()), seq, at: seq * 1000, provenance: "declared" };
}

test("protocol parsing returns detached bounded data and hashes normalized object keys with meaningful list order", () => {
  const input = protocol(), parsed = parseExperimentProtocol(input), hash = protocolHash(parsed);
  expect(parsed).toEqual(input); expect(parsed).not.toBe(input); expect(parsed.inputs).not.toBe(input.inputs);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(protocolHash(parseExperimentProtocol(Object.fromEntries(Object.entries(input).reverse())))).toBe(hash);
  input.seeds.reverse(); expect(protocolHash(input)).not.toBe(hash);
  input.method = "Changed method"; expect(parsed.method).toBe("Compare bounded synthetic inputs");
});

test("closed protocol boundaries refuse authority, generated metadata and caller evidence elevation", () => {
  for (const key of ["protocolHash", "project", "createdBy", "approved", "provenance", "command", "extra"]) {
    expect(() => parseExperimentProtocol({ ...protocol(), [key]: "caller value" }), key).toThrow("unknown field");
  }
  for (const [key, patch] of [["environment", { ...protocol().environment, env: { API_KEY: "value" } }],
    ["evaluator", { ...protocol().evaluator, provenance: "host-observed" }], ["inputs", [{ sourceId: SOURCE, sha256: HASH, text: "source contents" }]],
    ["metrics", [{ ...protocol().metrics[0], provenance: "host-observed" }]]] as Array<[string, unknown]>) {
    expect(() => parseExperimentProtocol({ ...protocol(), [key]: patch }), key).toThrow("unknown field");
  }
});

test("protocol source/hash/code and campaign identities are exact, unique and mutually exclusive", () => {
  for (const patch of [{ campaignId: "another-project" }, { campaignRevision: 0 }, { inputs: [{ sourceId: `${SOURCE}\n`, sha256: HASH }] },
    { inputs: [{ sourceId: SOURCE, sha256: "A".repeat(64) }] }, { code: { commit: "b".repeat(39) } },
    { code: { commit: "b".repeat(40), deliverable: { id: "d-0123456789ab", sha256: HASH } } }, { code: {} }]) {
    expect(() => parseExperimentProtocol({ ...protocol(), ...patch })).toThrow();
  }
  const repeated = protocol(); repeated.inputs.push({ ...repeated.inputs[0]! }); expect(() => parseExperimentProtocol(repeated)).toThrow("duplicate");
  const artifact = protocol(); artifact.code = { deliverable: { id: "d-0123456789ab", sha256: HASH } };
  expect(parseExperimentProtocol(artifact).code).toEqual(artifact.code);
});

test("environment descriptors retain permitted prose and variable names but reject assignment shapes and known secrets", () => {
  expect(parseExperimentProtocol(protocol()).environment.descriptor).toContain("API_KEY and HOME");
  for (const descriptor of ["API_KEY=value", "Python 3.12; export TOKEN = value", 'Linux {"API_KEY": "value"}', "PASSWORD: value", "Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.signature"]) {
    expect(() => parseExperimentProtocol({ ...protocol(), environment: { descriptor } }), descriptor).toThrow("environment");
  }
  expect(() => parseExperimentProtocol({ ...protocol(), environment: { descriptor: "Linux", hash: "wrong" } })).toThrow("environment.hash");
});

test("protocol lists, finite scalar parameters and safe integer seeds have explicit ceilings", () => {
  for (const parameters of [{ value: Infinity }, { value: NaN }, { value: { nested: true } }, { value: [[1]] },
    { value: new Array(65).fill(1) }, Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, index])),
    { constructor: "reserved" }, { "Uppercase": 1 }]) {
    expect(() => parseExperimentProtocol({ ...protocol(), parameters })).toThrow("parameters");
  }
  for (const seeds of [[1.5], [Number.MAX_SAFE_INTEGER + 1], new Array(257).fill(1)]) expect(() => parseExperimentProtocol({ ...protocol(), seeds })).toThrow("seeds");
  for (const patch of [{ claimIds: new Array(33).fill("c") }, { inputs: new Array(65).fill({ sourceId: SOURCE, sha256: HASH }) },
    { metrics: new Array(33).fill(protocol().metrics[0]) }, { splits: new Array(17).fill("s") }, { resourceLimits: new Array(17).fill(protocol().resourceLimits[0]) }]) {
    expect(() => parseExperimentProtocol({ ...protocol(), ...patch })).toThrow();
  }
  expect(() => parseExperimentProtocol({ ...protocol(), resourceLimits: [{ name: "time", value: -1, unit: "seconds" }] })).toThrow("resourceLimits");
  const variants = protocol(); variants.role = "variant"; variants.variantOf = HASH; variants.supersedes = HASH;
  expect(parseExperimentProtocol(variants).variantOf).toBe(HASH);
  expect(() => parseExperimentProtocol({ ...protocol(), variantOf: HASH })).toThrow("variantOf");
});

test("UTF-8 and whole-body ceilings reject whole protocols", () => {
  expect(parseExperimentProtocol({ ...protocol(), method: "가".repeat(1365) }).method).toHaveLength(1365);
  expect(() => parseExperimentProtocol({ ...protocol(), method: "가".repeat(1366) })).toThrow("method");
  expect(() => parseExperimentProtocol({ ...protocol(), parameters: { label: "가".repeat(171) } })).toThrow("parameters");
  const large = protocol(); large.parameters = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`p${index}`, new Array(64).fill("x".repeat(512))]));
  expect(() => parseExperimentProtocol(large)).toThrow("64 KiB");
});

test("accessors, proxies and sparse lists never execute caller code", () => {
  let touched = 0;
  const trap = new Proxy({}, { ownKeys() { touched++; throw new Error("trap executed"); }, getPrototypeOf() { touched++; throw new Error("trap executed"); } });
  expect(() => parseExperimentProtocol(trap)).toThrow("plain data object");
  expect(() => parseExperimentProtocol({ ...protocol(), parameters: trap })).toThrow("plain data object");
  const accessor = protocol(); Object.defineProperty(accessor, "method", { get() { touched++; return "bad"; } });
  expect(() => parseExperimentProtocol(accessor)).toThrow("accessors");
  expect(() => parseExperimentProtocol({ ...protocol(), seeds: new Array(1) })).toThrow("dense data list");
  expect(touched).toBe(0);
});

test("attempt input requires immutable identity inputs and cannot claim status, actor, time or provenance", () => {
  const input = { protocolHash: HASH, taskId: 2, phase: "final" as const, idempotencyKey: "fixture receipt", retryOf: "ra-0123456789ab" };
  expect(parseExperimentAttempt(input)).toEqual(input);
  for (const key of ["attemptId", "project", "status", "startedAt", "at", "provenance", "createdBy"]) expect(() => parseExperimentAttempt({ ...input, [key]: "forged" })).toThrow("unknown field");
  for (const patch of [{ taskId: 0 }, { phase: "approved" }, { idempotencyKey: "가".repeat(22) }, { retryOf: "../../receipt" }]) expect(() => parseExperimentAttempt({ ...input, ...patch })).toThrow();
  expect(parseExperimentAttempt({ ...input, retryOf: undefined, reproducesAttemptId: "ra-abcdef012345" }).reproducesAttemptId).toBe("ra-abcdef012345");
});

test("events admit only declared bodies and exact protocol metrics", () => {
  for (const patch of [{ provenance: "host-observed" }, { seq: 1 }, { at: 1 }, { evidence: "forged" }]) {
    expect(() => parseExperimentEvent({ kind: "metric", body: { name: "accuracy", value: 1 }, ...patch }, protocol())).toThrow("unknown field");
  }
  expect(() => parseExperimentEvent({ kind: "attestation", body: {} })).toThrow("separate authority");
  expect(() => parseExperimentEvent({ kind: "metric", body: { name: "undeclared", value: 1 } }, protocol())).toThrow("not declared");
  for (const value of [Infinity, NaN, "1", null]) expect(() => parseExperimentEvent({ kind: "metric", body: { name: "accuracy", value } }, protocol())).toThrow("finite number");
  expect(parseExperimentEvent({ kind: "end", body: { status: "failed", run: RUN, exitStatus: 1, reason: "Synthetic failure" } })).toMatchObject({ kind: "end" });
  expect(() => parseExperimentEvent({ kind: "end", body: { status: "succeeded", durationMs: 10 } })).toThrow("unknown field");
  expect(() => parseExperimentEvent({ kind: "end", body: { status: "succeeded", run: "../../state" } })).toThrow("invalid identifier");
});

test("output reference hashes remain declared and host-hash requests cannot supply them", () => {
  expect(parseExperimentEvent({ kind: "output", body: { id: "d-0123456789ab", sha256: HASH } })).toMatchObject({ body: { sha256: HASH } });
  expect(parseExperimentEvent({ kind: "output", body: { path: "results/table.csv", format: "csv", version: "v1" } })).toMatchObject({ body: { path: "results/table.csv" } });
  for (const body of [{ path: "results.csv", format: "csv", sha256: HASH }, { id: "d-0123456789ab", path: "results.csv", format: "csv" },
    { path: "../outside.csv", format: "csv" }, { path: "/outside.csv", format: "csv" }, { id: "d-0123456789ab", provenance: "host-observed" }]) {
    expect(() => parseExperimentEvent({ kind: "output", body })).toThrow();
  }
});

test("status uses terminal events and keeps task completion distinct from experiment success", () => {
  const start = event({ kind: "start", body: { startedAt: 100 } }, 1);
  expect(experimentStatus([], "in_progress")).toBe("declared");
  expect(experimentStatus([start], "in_progress")).toBe("running");
  for (const taskState of ["approved", "cancelled", "closed"]) {
    expect(experimentStatus([], taskState)).toBe("unknown"); expect(experimentStatus([start], taskState)).toBe("unknown");
  }
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const end = event({ kind: "end", body: { status } }, 2);
    expect(experimentStatus([end, start], "approved")).toBe(status);
  }
  const end = event({ kind: "end", body: { status: "failed" } }, 2);
  expect(() => experimentStatus([start, end, { ...end, seq: 3 }], "in_progress")).toThrow("at most one");
  expect(() => experimentStatus([start, { ...start }], "in_progress")).toThrow("ordering");
});

test("projections never infer host evidence, environment hashes, output hashes or timing", () => {
  const p = protocol(); delete p.environment.hash;
  const events = [event({ kind: "start", body: {} }, 1), event({ kind: "metric", body: { name: "accuracy", value: 0.8 } }, 2),
    event({ kind: "output", body: { id: "d-0123456789ab", sha256: HASH } }, 3), event({ kind: "output", body: { path: "result.csv", format: "csv" } }, 4),
    event({ kind: "end", body: { status: "succeeded", exitStatus: 0, run: RUN } }, 5)];
  const view = projectExperimentEvidence(p, events);
  expect(view.environment.hash).toEqual({ value: null, provenance: "unknown" });
  expect(view.sealed).toEqual({ value: false, provenance: "declared" });
  expect(view.exitStatus).toEqual({ value: 0, provenance: "declared" }); expect(view.run).toEqual({ value: RUN, provenance: "declared" });
  for (const value of [view.startedAt, view.endedAt, view.durationMs, view.queueTime, view.cancelled, view.timedOut]) expect(value).toEqual({ value: null, provenance: "unknown" });
  expect(view.outputs[0]?.sha256).toEqual({ value: HASH, provenance: "declared" });
  expect(view.outputs[1]?.sha256).toEqual({ value: null, provenance: "unknown" });
  expect(view.metrics[0]?.latest).toEqual({ value: 0.8, provenance: "declared" });
  expect(projectExperimentEvidence(p, []).metrics[0]?.latest).toEqual({ value: null, provenance: "unknown" });
  expect(JSON.stringify(view)).not.toContain("host-observed");
});

test("host check projections require matching finished task/commit and keep absent timing fields unknown", async () => {
  const { checkRunObservation } = await import("../src/hub/research-experiments.ts");
  const receipt = {run:RUN,task:2,sha:"b".repeat(40),status:"finished",exit:1,timed_out:false,cancelled:false,duration_ms:42,created:1000,tail:"not evidence"};
  expect(checkRunObservation(receipt,RUN,2,protocol())).toEqual({source:"check",evidence:RUN,values:{exitStatus:1,timedOut:false,cancelled:false,durationMs:42,queueTime:1000}});
  for (const patch of [{task:3},{sha:"c".repeat(40)},{status:"running"},{duration_ms:-1},{created:NaN},{cancelled:"false"},{exit:Infinity}]) {
    expect(checkRunObservation({...receipt,...patch},RUN,2,protocol())).toBeUndefined();
  }
  const missing=checkRunObservation({...receipt,exit:null},RUN,2,protocol())!;
  expect(missing.values.exitStatus).toBeUndefined();
  expect(Object.keys(missing.values)).not.toContain("startedAt");
  expect(Object.keys(missing.values)).not.toContain("endedAt");
  expect(checkRunObservation(new Proxy(receipt,{}),RUN,2,protocol())).toBeUndefined();
});
