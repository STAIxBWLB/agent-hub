import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "../src/hub/packs.ts";
import { parseResearchRunners, parseAttemptReceipt, runnerSealing, verifyAttemptReceipt,
  type AttemptReceiptV1, type RunnerVerificationContext } from "../src/hub/research-runner.ts";

// Ephemeral fixture key only. No runner connection, process, credential or real experiment.
const fixtureKey = generateKeyPairSync("ed25519");
const publicKey = fixtureKey.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PROJECT = "public-project/fixture", HASH = "a".repeat(64), COMMIT = "b".repeat(40);
function receipt(): AttemptReceiptV1 {
  return { receiptId: "receipt-1", runner: "fixture", projectId: PROJECT, attemptId: "ra-0123456789ab", protocolHash: HASH,
    codeCommit: COMMIT, imageDigest: `sha256:${"c".repeat(64)}`,
    containers: [{ id: "candidate", role: "candidate" }, { id: "evaluator", role: "evaluator" }],
    mounts: [{ container: "candidate", path: "/outputs", readOnly: false, purpose: "candidate-output" },
      { container: "evaluator", path: "/evaluation", readOnly: true, purpose: "evaluator-code" }],
    network: "none", resourceLimits: [{ name: "cpu", value: 1, unit: "core" }], startedAt: 100, endedAt: 200, exitStatus: 0,
    outputs: [{ name: "result.json", sha256: "d".repeat(64) }], metricsFile: { name: "metrics.json", sha256: "e".repeat(64) } };
}
function context(): RunnerVerificationContext {
  return { runners: { fixture: { publicKey, projects: [PROJECT], revoked: false } }, projectId: PROJECT,
    attempt: { id: "ra-0123456789ab", projectId: PROJECT, protocolHash: HASH, codeCommit: COMMIT } };
}
function signature(body: unknown, prefix = "agent-hub.runner-receipt/v1" + String.fromCharCode(0)): string {
  return sign(null, Buffer.from(prefix + canonicalJson(body), "utf8"), fixtureKey.privateKey).toString("base64");
}

test("#1018 verifies the domain-separated canonical Ed25519 body as runner-attested evidence", () => {
  const body = receipt(), signed = signature(body);
  expect(verifyAttemptReceipt(body, signed, context())).toEqual({ receipt: body, provenance: "runner-attested", sealed: true });
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  expect(verifyAttemptReceipt(reordered, signed, context()).receipt).toEqual(body);
  expect(() => verifyAttemptReceipt(body, signature(body, ""), context())).toThrow("signature");
  expect(() => verifyAttemptReceipt(body, signature(body, "agent-hub.runner-receipt/v1"), context())).toThrow("signature");
  expect(() => verifyAttemptReceipt(body, signature(body, "agent-hub.runner-receipt/v2" + String.fromCharCode(0)), context())).toThrow("signature");
  expect(() => verifyAttemptReceipt({ ...body, exitStatus: 1 }, signed, context())).toThrow("signature");
  expect(() => verifyAttemptReceipt({ ...body, outputs: [{ name: "result.json", sha256: "f".repeat(64) }] }, signed, context())).toThrow("signature");
});

test("#1018 checks the current registration, revocation, exact project and attempt identity", () => {
  const body = receipt(), signed = signature(body);
  const contexts: RunnerVerificationContext[] = [
    { ...context(), runners: {} },
    { ...context(), runners: { fixture: { publicKey, projects: [PROJECT], revoked: true } } },
    { ...context(), runners: { fixture: { publicKey, projects: [PROJECT + " "], revoked: false } } },
    { ...context(), projectId: PROJECT + " " },
    { ...context(), attempt: undefined },
    { ...context(), attempt: { ...context().attempt!, id: "ra-ffffffffffff" } },
    { ...context(), attempt: { ...context().attempt!, projectId: "another-project" } },
    { ...context(), attempt: { ...context().attempt!, protocolHash: "f".repeat(64) } },
    { ...context(), attempt: { ...context().attempt!, codeCommit: "f".repeat(40) } },
  ];
  for (const current of contexts) expect(() => verifyAttemptReceipt(body, signed, current)).toThrow();
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  expect(() => verifyAttemptReceipt(body, signed, { ...context(), runners: { fixture: { publicKey: other, projects: [PROJECT], revoked: false } } })).toThrow("signature");
  // A valid id must never resolve an inherited registration.
  const inherited = { ...body, runner: "constructor" };
  expect(() => verifyAttemptReceipt(inherited, signature(inherited), { ...context(), runners: {} })).toThrow("unknown runner");
  const own = { ...context(), runners: { constructor: { publicKey, projects: [PROJECT], revoked: false } } };
  expect(verifyAttemptReceipt(inherited, signature(inherited), own).provenance).toBe("runner-attested");
});

test("#1018 absent observations stay unknown by absence and cannot establish sealing", () => {
  const full = receipt();
  const body = { receiptId: full.receiptId, runner: full.runner, projectId: full.projectId, attemptId: full.attemptId, protocolHash: full.protocolHash };
  const result = verifyAttemptReceipt(body, signature(body), context());
  expect(result).toEqual({ receipt: body, provenance: "runner-attested", sealed: false });
  for (const name of ["codeCommit", "imageDigest", "containers", "mounts", "network", "resourceLimits", "startedAt", "endedAt", "exitStatus", "outputs", "metricsFile"])
    expect(Object.hasOwn(result.receipt, name)).toBe(false);
});

test("#1018 signed but missing, empty or inconsistent isolation remains unsealed", () => {
  const negative: AttemptReceiptV1[] = [];
  const noContainers = receipt(); delete noContainers.containers; negative.push(noContainers);
  const noMounts = receipt(); delete noMounts.mounts; negative.push(noMounts);
  negative.push({ ...receipt(), containers: [] }, { ...receipt(), mounts: [] },
    { ...receipt(), containers: [{ id: "candidate", role: "candidate" }] },
    { ...receipt(), containers: [{ id: "evaluator", role: "evaluator" }] },
    { ...receipt(), containers: [{ id: "same", role: "candidate" }, { id: "same", role: "evaluator" }] },
    { ...receipt(), containers: [...receipt().containers!, { id: "candidate", role: "candidate" }] },
    { ...receipt(), mounts: [...receipt().mounts!, { container: "missing", path: "/other", readOnly: true, purpose: "other" }] },
    { ...receipt(), mounts: [{ container: "evaluator", path: "/evaluation", readOnly: false, purpose: "evaluator-code" }] },
    { ...receipt(), mounts: [{ container: "evaluator", path: "/evaluation", readOnly: false, purpose: "evaluator-data" }] },
    { ...receipt(), mounts: [...receipt().mounts!, { container: "candidate", path: "/leaked-data", readOnly: true, purpose: "evaluator-data" }] },
    { ...receipt(), mounts: [{ container: "candidate", path: "/evaluation", readOnly: true, purpose: "evaluator-code" }] },
    { ...receipt(), mounts: [{ container: "evaluator", path: "/evaluation", readOnly: true, purpose: "other" }] },
    { ...receipt(), mounts: [{ container: "other", path: "/evaluation", readOnly: true, purpose: "evaluator-data" }],
      containers: [...receipt().containers!, { id: "other", role: "other" }] });
  for (const body of negative) {
    expect(parseAttemptReceipt(body)).toEqual(body);
    expect(runnerSealing(body)).toBe(false);
    expect(verifyAttemptReceipt(body, signature(body), context())).toEqual({ receipt: body, provenance: "runner-attested", sealed: false });
  }
  const dataOnly = { ...receipt(), mounts: [{ container: "evaluator", path: "/evaluation", readOnly: true, purpose: "evaluator-data" as const }] };
  expect(verifyAttemptReceipt(dataOnly, signature(dataOnly), context()).sealed).toBe(true);
});

test("#1018 rejects malformed, private and foreign keys and noncanonical signatures without exposing them", () => {
  const invalidKeys = [publicKey + "\n", publicKey.slice(0, -1), "not-a-key", fixtureKey.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).toString("base64")];
  for (const key of invalidKeys) {
    try { parseResearchRunners({ fixture: { publicKey: key, projects: [PROJECT], revoked: false } }); throw new Error("accepted key"); }
    catch (error) { expect((error as Error).message).toContain("publicKey"); expect((error as Error).message).not.toContain(key); }
  }
  const body = receipt(), signed = signature(body);
  for (const value of [signed + "\n", signed.slice(0, -1), signed.replace(/=+$/, ""), "a".repeat(88), Buffer.alloc(64)])
    expect(() => verifyAttemptReceipt(body, value, context())).toThrow("signature");
});

test("#1018 strict data parsers reject prototypes, proxies, accessors and execution-shaped extras", () => {
  let touched = false;
  const getter = Object.defineProperty({}, "receiptId", { enumerable: true, get() { touched = true; throw new Error("getter ran"); } });
  const proxy = new Proxy({}, { getPrototypeOf() { touched = true; throw new Error("proxy ran"); } });
  const listGetter = [receipt().containers![0]];
  Object.defineProperty(listGetter, "0", { get() { touched = true; throw new Error("list getter ran"); } });
  for (const body of [getter, proxy, Object.create(receipt()), { ...receipt(), [Symbol("extra")]: 1 }, { ...receipt(), command: "never execute" },
    { ...receipt(), provenance: "host-observed" }, { ...receipt(), containers: listGetter }, { ...receipt(), containers: Array(1) },
    { ...receipt(), containers: new Proxy([], {}) }, { ...receipt(), mounts: [{ ...receipt().mounts![0], command: "never execute" }] }])
    expect(() => parseAttemptReceipt(body)).toThrow();
  expect(touched).toBe(false);
  expect(() => parseResearchRunners(proxy)).toThrow();
  expect(() => parseResearchRunners({ fixture: Object.defineProperty({}, "publicKey", { get() { touched = true; return publicKey; } }) })).toThrow();
  expect(touched).toBe(false);
  expect(() => parseResearchRunners({ fixture: { publicKey, projects: [PROJECT], revoked: false, privateKey: "unavailable" } })).toThrow("unknown field");
});

test("#1018 enforces UTF-8, list, number and whole-body bounds before verification", () => {
  const body = receipt();
  for (const changed of [{ receiptId: "Uppercase" }, { projectId: "한".repeat(171) }, { containers: Array(65).fill(body.containers![0]) },
    { mounts: Array(257).fill(body.mounts![0]) }, { outputs: Array(65).fill(body.outputs![0]) }, { resourceLimits: Array(17).fill(body.resourceLimits![0]) },
    { startedAt: -1 }, { endedAt: 99 }, { exitStatus: Infinity }, { resourceLimits: [{ name: "cpu", value: NaN, unit: "core" }] },
    { metricsFile: { name: "metrics", sha256: "wrong" } }, { network: "unknown" }, { codeCommit: undefined },
    { mounts: [{ ...body.mounts![0], readOnly: "true" }] }]) expect(() => parseAttemptReceipt({ ...body, ...changed })).toThrow();
  expect(() => parseAttemptReceipt({ ...body, mounts: Array.from({ length: 256 }, () => ({ ...body.mounts![0]!, path: "a".repeat(512) })) })).toThrow("64 KiB");
  expect(() => parseResearchRunners(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`runner-${index}`, { publicKey, projects: [PROJECT], revoked: false }])))).toThrow("16 runners");
  expect(() => parseResearchRunners({ fixture: { publicKey, projects: Array.from({ length: 65 }, (_, index) => `project-${index}`), revoked: false } })).toThrow("64 items");
  expect(() => parseResearchRunners({ fixture: { publicKey, projects: [PROJECT, PROJECT], revoked: false } })).toThrow("duplicate projects");
  expect(() => parseResearchRunners({ fixture: { publicKey, projects: [PROJECT], revoked: "false" } })).toThrow("revoked");
});
