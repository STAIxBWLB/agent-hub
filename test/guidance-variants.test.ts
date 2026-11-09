import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import vectors from "./fixtures/guidance-variant-v1.json";
import { parseRole, taskRoleText } from "../src/hub/roles.ts";
import { parseExecutionReference } from "../src/hub/execution-reference.ts";
import {
  GuidanceVariantError, guidanceVariantKey, parseGuidanceVariantV1,
  renderGuidanceVariantV1, validateGuidanceVariantV1,
  type GuidanceVariantContext, type GuidanceVariantPayloadV1, type GuidanceVariantV1,
} from "../src/hub/guidance-variants.ts";

// Expected keys are independently constructed from the published fixed-order contract.
// No target helper generates fixture ids or expected canonical bytes.
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function canonical(value: GuidanceVariantPayloadV1): GuidanceVariantPayloadV1 {
  return {
    v: value.v, projectKey: value.projectKey, experimentId: value.experimentId,
    taskId: value.taskId, taskCreated: value.taskCreated, flowRevision: value.flowRevision,
    baseline: { roleId: value.baseline.roleId, layer: value.baseline.layer, sha256: value.baseline.sha256, bytes: value.baseline.bytes },
    candidate: { sha256: value.candidate.sha256, bytes: value.candidate.bytes },
    author: value.author,
    rationale: { problemHypothesis: value.rationale.problemHypothesis, expectedObservableDifference: value.rationale.expectedObservableDifference },
    evidenceRefs: value.evidenceRefs.map(ref => ({
      v: ref.v, tool: ref.tool, projectKey: ref.projectKey, kind: ref.kind, id: ref.id,
      ...(ref.revision === undefined ? {} : { revision: ref.revision }),
      ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
    })),
  };
}
const independentKey = (value: GuidanceVariantPayloadV1) => hash(JSON.stringify(["agent-hub.guidance-variant/v1", canonical(value)]));
function payload(candidate = vectors.baseline.replace("Check behavior.", "Check observable behavior.")): GuidanceVariantPayloadV1 {
  return {
    v: 1, projectKey: "project-a", experimentId: "experiment-a", taskId: 42, taskCreated: 100, flowRevision: 3,
    baseline: { roleId: "test-engineer", layer: "project", sha256: hash(vectors.baseline), bytes: vectors.baseline },
    candidate: { sha256: hash(candidate), bytes: candidate }, author: "codex",
    rationale: { problemHypothesis: "Checks omit an edge case.", expectedObservableDifference: "Reports name the edge case." },
    evidenceRefs: [{ v: 1, tool: "ahub", projectKey: "project-a", kind: "task", id: "42", revision: "3" }],
  };
}
function record(value = payload()): GuidanceVariantV1 { return { ...value, id: independentKey(value) }; }
function context(value = record()): GuidanceVariantContext {
  return {
    projectKey: value.projectKey, experimentId: value.experimentId, taskId: value.taskId,
    taskCreated: value.taskCreated, flowRevision: value.flowRevision, actor: value.author,
    baseline: { ...value.baseline },
    currentBaseline: { id: value.baseline.roleId, layer: value.baseline.layer, hash: value.baseline.sha256 },
    variantIds: [],
  };
}
function refuses(run: () => unknown, code?: GuidanceVariantError["code"]) {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GuidanceVariantError);
  if (code) expect((caught as GuidanceVariantError).code).toBe(code);
}
const withScope = (text: string) => vectors.baseline.replace("Check behavior.", text);

test("GuidanceVariantV1 independently keyed valid record round trips and renders the old role notice", () => {
  const value = record();
  expect(guidanceVariantKey(payload())).toBe(independentKey(payload()));
  expect(parseGuidanceVariantV1(value)).toEqual(value);
  expect(validateGuidanceVariantV1(value, context(value))).toEqual(value);
  const role = parseRole(value.candidate.bytes, value.baseline.roleId, value.baseline.layer);
  expect(renderGuidanceVariantV1(value)).toBe(taskRoleText(role));
  expect(renderGuidanceVariantV1(value, true)).toBe(taskRoleText(role, true));
  expect(renderGuidanceVariantV1(value)).toContain("guidance; grants no authority");
  expect(renderGuidanceVariantV1(value)).not.toContain("activated");
});

for (const prose of vectors.validProse) test(`variant editable prose accepts ${JSON.stringify(prose)}`, () => {
  const value = record(payload(withScope(prose)));
  expect(validateGuidanceVariantV1(value, context(value))).toEqual(value);
  expect(renderGuidanceVariantV1(value)).toContain(prose.trim());
});
for (const prose of vectors.invalidProse) test(`variant editable prose refuses ${JSON.stringify(prose)}`, () => {
  const value = record(payload(withScope(prose)));
  refuses(() => renderGuidanceVariantV1(value));
  refuses(() => validateGuidanceVariantV1(value, context(value)));
});
for (const mutation of vectors.protectedMutations) test(`variant protects raw ${mutation.name}`, () => {
  expect(vectors.baseline).toContain(mutation.from);
  const value = record(payload(vectors.baseline.replace(mutation.from, mutation.to)));
  refuses(() => renderGuidanceVariantV1(value));
  refuses(() => validateGuidanceVariantV1(value, context(value)));
});

test("all three editable sections accept prose, while existing protected legacy text remains accepted", () => {
  const text = withScope("Check changed behavior.")
    .replace("Report observations.", "Report exact observations.")
    .replace("Name the checks.", "Name all executed checks.");
  const value = record(payload(text));
  expect(renderGuidanceVariantV1(value)).toContain("Use hub_task_done for handoff.");
  expect(renderGuidanceVariantV1(value, true)).toContain("Review the evidence.");
  expect(validateGuidanceVariantV1(value, context(value))).toEqual(value);
});

test("canonical key ignores insertion order but binds every payload field and raw snapshot byte", () => {
  const original = payload();
  const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(original).reverse());
  reordered.baseline = Object.fromEntries(Object.entries(original.baseline).reverse());
  reordered.rationale = Object.fromEntries(Object.entries(original.rationale).reverse());
  reordered.evidenceRefs = original.evidenceRefs.map(ref => Object.fromEntries(Object.entries(ref).reverse()));
  expect(guidanceVariantKey(reordered as unknown as GuidanceVariantPayloadV1)).toBe(independentKey(original));
  const changes: GuidanceVariantPayloadV1[] = [
    { ...original, projectKey: "project-b" }, { ...original, experimentId: "experiment-b" },
    { ...original, taskId: 43 }, { ...original, taskCreated: 101 }, { ...original, flowRevision: 4 },
    { ...original, author: "kimi" }, { ...original, baseline: { ...original.baseline, layer: "shipped" } },
    { ...original, rationale: { ...original.rationale, problemHypothesis: "Checks omit another case." } },
    { ...original, rationale: { ...original.rationale, expectedObservableDifference: "Reports name another case." } },
    { ...original, evidenceRefs: [{ ...original.evidenceRefs[0]!, revision: "4" }] },
    payload(withScope("Check café behavior.")), payload(withScope("Check café behavior.")),
  ];
  for (const changed of changes) {
    expect(guidanceVariantKey(changed)).toBe(independentKey(changed));
    expect(guidanceVariantKey(changed)).not.toBe(independentKey(original));
  }
  expect(guidanceVariantKey(changes[changes.length - 1]!)).not.toBe(guidanceVariantKey(changes[changes.length - 2]!));
});

test("record identity, snapshot hashes and closed unsigned payload are validated independently", () => {
  const value = record();
  for (const bad of [
    { ...value, id: "a".repeat(64) }, { ...value, id: value.id.toUpperCase() },
    { ...value, baseline: { ...value.baseline, sha256: "a".repeat(64) } },
    { ...value, candidate: { ...value.candidate, sha256: "a".repeat(64) } },
    { ...value, candidate: { ...value.candidate, bytes: value.candidate.bytes + "\n" } },
  ]) refuses(() => parseGuidanceVariantV1(bad));
  refuses(() => guidanceVariantKey({ ...payload(), id: value.id } as unknown as GuidanceVariantPayloadV1));
  for (const field of ["tested", "authority", "status", "time", "active", "approved", "toJSON"])
    refuses(() => parseGuidanceVariantV1({ ...value, [field]: true }));
  for (const field of ["baseline", "candidate", "rationale"] as const)
    refuses(() => parseGuidanceVariantV1({ ...value, [field]: { ...value[field], authority: true } }));
  for (const mutation of [{ v: 2 }, { taskId: 0 }, { taskId: 1.5 }, { taskCreated: -1 }, { flowRevision: -1 }, { flowRevision: Infinity }])
    refuses(() => parseGuidanceVariantV1({ ...value, ...mutation }));
});

test("host binding refuses actor, task incarnation, experiment, frozen baseline and current baseline changes", () => {
  const value = record(), original = context(value);
  const otherRoleBytes = original.baseline.bytes.replace("id: test-engineer", "id: other");
  const changedBaselineBytes = original.baseline.bytes.replace("Check behavior.", "Check another behavior.");
  const changes: GuidanceVariantContext[] = [
    { ...original, actor: "kimi" }, { ...original, projectKey: "project-b" }, { ...original, experimentId: "experiment-b" },
    { ...original, taskId: 43 }, { ...original, taskCreated: 101 }, { ...original, flowRevision: 4 },
    { ...original, baseline: { ...original.baseline, roleId: "other", bytes: otherRoleBytes, sha256: hash(otherRoleBytes) } },
    { ...original, baseline: { ...original.baseline, layer: "shipped" } },
    { ...original, baseline: { ...original.baseline, bytes: changedBaselineBytes, sha256: hash(changedBaselineBytes) } },
    { ...original, currentBaseline: { ...original.currentBaseline, id: "other" } },
    { ...original, currentBaseline: { ...original.currentBaseline, layer: "shipped" } },
    { ...original, currentBaseline: { ...original.currentBaseline, hash: "a".repeat(64) } },
  ];
  for (const changed of changes) refuses(() => validateGuidanceVariantV1(value, changed), "changed");
  // A frozen snapshot with inconsistent raw bytes/hash is malformed host data,
  // distinct from a structurally valid baseline that differs from the record.
  refuses(() => validateGuidanceVariantV1(value, {
    ...original, baseline: { ...original.baseline, sha256: "a".repeat(64) },
  }), "invalid");
  refuses(() => validateGuidanceVariantV1(value, {
    ...original, baseline: { ...original.baseline, bytes: original.baseline.bytes + "\n" },
  }), "invalid");
  // The actor comparison is identity only; this pure API has no board/authority admission.
  const foreign = record({ ...payload(), author: "another-peer" });
  expect(validateGuidanceVariantV1(foreign, context(foreign))).toEqual(foreign);
});

test("all historical variant ids count toward sixteen, with duplicate replay allowed at the cap", () => {
  const value = record(), original = context(value);
  const sixteen = Array.from({ length: 16 }, (_, index) => hash(`historical-${index}`));
  expect(validateGuidanceVariantV1(value, { ...original, variantIds: sixteen.slice(0, 15) })).toEqual(value);
  refuses(() => validateGuidanceVariantV1(value, { ...original, variantIds: sixteen }), "limit");
  expect(validateGuidanceVariantV1(value, { ...original, variantIds: [value.id, ...sixteen.slice(0, 15)] })).toEqual(value);
  refuses(() => validateGuidanceVariantV1(value, { ...original, variantIds: [...sixteen, value.id] }));
});

test("evidence addresses use closed central grammar, canonical uniqueness and the sixteen item limit", () => {
  const base = payload(), ref = base.evidenceRefs[0]!;
  const sixteen = Array.from({ length: 16 }, (_, index) => ({ ...ref, id: String(index) }));
  expect(parseGuidanceVariantV1(record({ ...base, evidenceRefs: sixteen })).evidenceRefs).toHaveLength(16);
  refuses(() => parseGuidanceVariantV1(record({ ...base, evidenceRefs: [...sixteen, { ...ref, id: "17" }] })), "invalid");
  const reversed = Object.fromEntries(Object.entries(ref).reverse()) as unknown as typeof ref;
  refuses(() => parseGuidanceVariantV1(record({ ...base, evidenceRefs: [ref, reversed] })));
  for (const change of [{ tool: "unknown" }, { kind: "bad/kind" }, { revision: null }, { sha256: "A".repeat(64) }, { resolve: true }]) {
    // Deliberately not independently canonicalized: malformed input must fail before any key use.
    refuses(() => parseGuidanceVariantV1({ ...record(), evidenceRefs: [{ ...ref, ...change }] }));
  }
  const opaque = record({ ...base, evidenceRefs: [{ ...ref, id: "/not/a/resolver" }] });
  expect(parseGuidanceVariantV1(opaque).evidenceRefs[0]!.id).toBe("/not/a/resolver");
});

test("rationale bounds use fixed-order object JSON UTF8 bytes including keys and quote escapes", () => {
  const base = payload();
  const fixed = { problemHypothesis: "A.", expectedObservableDifference: "B." };
  const overhead = Buffer.byteLength(JSON.stringify(fixed)) - 4;
  const make = (filler: string) => ({ problemHypothesis: `A${filler}.`, expectedObservableDifference: "B." });
  const exact = make("a".repeat(2000 - overhead - 4));
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(2000);
  expect(parseGuidanceVariantV1(record({ ...base, rationale: exact })).rationale).toEqual(exact);
  refuses(() => parseGuidanceVariantV1(record({ ...base, rationale: make("a".repeat(2001 - overhead - 4)) })), "invalid");
  const utf8 = make("가".repeat(700));
  expect(JSON.stringify(utf8).length).toBeLessThan(2000);
  expect(Buffer.byteLength(JSON.stringify(utf8))).toBeGreaterThan(2000);
  refuses(() => parseGuidanceVariantV1(record({ ...base, rationale: utf8 })), "invalid");
  const escaped = make('"'.repeat(1000));
  expect(escaped.problemHypothesis.length + escaped.expectedObservableDifference.length).toBeLessThan(2000);
  refuses(() => parseGuidanceVariantV1(record({ ...base, rationale: escaped })), "invalid");
});

test("file UTF8 cap and complete notice UTF16 cap refuse before presentation", () => {
  const huge = record(payload(withScope("가".repeat(2800) + ".")));
  expect(huge.candidate.bytes.length).toBeLessThan(8192);
  expect(Buffer.byteLength(huge.candidate.bytes)).toBeGreaterThan(8192);
  refuses(() => parseGuidanceVariantV1(huge));
  const base = payload();
  const bodyStart = base.candidate.bytes.indexOf("\n\n## Scope") + 1;
  const prefix = base.candidate.bytes.slice(0, bodyStart);
  const body = base.candidate.bytes.slice(bodyStart).trimEnd();
  const noticeHeader = `Task role ${base.baseline.roleId} [${base.baseline.layer}, ${base.candidate.sha256}] (guidance; grants no authority):\n`;
  const padding = 2000 - noticeHeader.length - body.length;
  const exactBytes = prefix + body.replace("Check observable behavior.", "Check observable behavior" + "a".repeat(padding) + ".") + "\n";
  const exact = record(payload(exactBytes));
  expect(renderGuidanceVariantV1(exact).length).toBe(2000);
  const over = record(payload(exactBytes.replace("Check observable behavior", "Check observable behaviora")));
  refuses(() => renderGuidanceVariantV1(over));
});

test("parsed records are independent deeply frozen snapshots", () => {
  const original = record();
  const input = {
    ...original, baseline: { ...original.baseline }, candidate: { ...original.candidate },
    rationale: { ...original.rationale }, evidenceRefs: original.evidenceRefs.map(ref => ({ ...ref })),
  };
  const parsed = parseGuidanceVariantV1(input);
  expect(parsed).not.toBe(input);
  for (const item of [parsed, parsed.baseline, parsed.candidate, parsed.rationale, parsed.evidenceRefs, parsed.evidenceRefs[0]])
    expect(Object.isFrozen(item)).toBe(true);
  input.candidate.bytes = "MUTATED_INPUT";
  input.rationale.problemHypothesis = "Changed input.";
  input.evidenceRefs[0]!.id = "changed";
  expect(parsed.candidate.bytes).not.toBe("MUTATED_INPUT");
  expect(parsed.rationale.problemHypothesis).toBe("Checks omit an edge case.");
  expect(parsed.evidenceRefs[0]!.id).toBe("42");
});

test("accessors, proxies, inherited objects, symbols and nonenumerable fields execute nothing", () => {
  let invoked = 0;
  const value = record();
  const accessor = { ...value };
  Object.defineProperty(accessor, "author", { enumerable: true, get() { invoked++; return value.author; } });
  refuses(() => parseGuidanceVariantV1(accessor));
  const nested = { ...value.baseline };
  Object.defineProperty(nested, "bytes", { enumerable: true, get() { invoked++; return value.baseline.bytes; } });
  refuses(() => parseGuidanceVariantV1({ ...value, baseline: nested }));
  const proxy = new Proxy(value, {
    getPrototypeOf() { invoked++; return Object.prototype; },
    ownKeys(target) { invoked++; return Reflect.ownKeys(target); },
    get(target, key, receiver) { invoked++; return Reflect.get(target, key, receiver); },
  });
  refuses(() => parseGuidanceVariantV1(proxy));
  refuses(() => guidanceVariantKey(proxy as unknown as GuidanceVariantPayloadV1));
  refuses(() => renderGuidanceVariantV1(proxy));
  refuses(() => parseGuidanceVariantV1(Object.create(value)));
  refuses(() => parseGuidanceVariantV1({ ...value, [Symbol("authority")]: true }));
  const hidden = { ...value };
  Object.defineProperty(hidden, "author", { value: value.author, enumerable: false });
  refuses(() => parseGuidanceVariantV1(hidden));
  const sparse = new Array(1);
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: sparse }));
  const array = [...value.evidenceRefs];
  Object.defineProperty(array, "0", { enumerable: true, get() { invoked++; return value.evidenceRefs[0]; } });
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: array }));
  const decorated = Object.assign([...value.evidenceRefs], { authority: true });
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: decorated }));
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: new Proxy([...value.evidenceRefs], { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } }) }));
  expect(invoked).toBe(0);
});

test("rationale prose and failures never expose caller snapshot bytes", () => {
  const secret = "PRIVATE_VARIANT_CANARY";
  const base = payload();
  for (const text of vectors.invalidProse) {
    const bad = record({ ...base, rationale: { ...base.rationale, problemHypothesis: text } });
    refuses(() => parseGuidanceVariantV1(bad));
  }
  let message = "";
  try { parseGuidanceVariantV1({ ...record(), candidate: { sha256: "a".repeat(64), bytes: secret } }); }
  catch (error) { message = String(error); }
  expect(message).not.toBe("");
  expect(message).not.toContain(secret);
});

test("typed refusals distinguish protected bytes, prose and host drift with fixed safe text", () => {
  const value = record();
  const metadata = record(payload(value.candidate.bytes.replace("name: Test engineer", "name: Other engineer")));
  refuses(() => renderGuidanceVariantV1(metadata), "protected");
  const prose = record(payload(withScope("Check value=other.")));
  refuses(() => renderGuidanceVariantV1(prose), "prose");
  const rationale = record({ ...payload(), rationale: { ...payload().rationale, problemHypothesis: "Check value=other." } });
  refuses(() => parseGuidanceVariantV1(rationale), "prose");
  refuses(() => validateGuidanceVariantV1(value, { ...context(value), actor: "someone-else" }), "changed");
  const messages: string[] = [];
  for (const bytes of ["PRIVATE_FIRST_CANARY", "PRIVATE_SECOND_CANARY"]) {
    try { parseGuidanceVariantV1({ ...value, candidate: { sha256: "a".repeat(64), bytes } }); }
    catch (error) { messages.push(String(error)); }
  }
  expect(messages).toHaveLength(2);
  expect(messages[0]).toBe(messages[1]);
  expect(messages[0]).not.toContain("PRIVATE_");
});

test("nested executable data and host context accessors are refused without invoking them", () => {
  const value = record();
  let invoked = 0;
  for (const field of ["candidate", "rationale"] as const) {
    const nested = new Proxy(value[field], { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
    refuses(() => parseGuidanceVariantV1({ ...value, [field]: nested }));
  }
  const executable = { ...value, toJSON() { invoked++; return value; } };
  refuses(() => parseGuidanceVariantV1(executable));
  const host = context(value);
  Object.defineProperty(host, "actor", { enumerable: true, get() { invoked++; return value.author; } });
  refuses(() => validateGuidanceVariantV1(value, host));
  expect(invoked).toBe(0);
});

test("canonical full record cap is independent of every individual snapshot, rationale and reference cap", () => {
  // Korean letters cost three UTF8 bytes per UTF16 unit. Each file and notice
  // stays valid alone; the two raw snapshots still contribute almost 10 KiB.
  const baselineBytes = withScope("Check " + "가".repeat(1450) + ".");
  const candidateBytes = baselineBytes.replace("Check 가", "Check 나");
  const base = payload(candidateBytes);
  const large: GuidanceVariantPayloadV1 = {
    ...base,
    baseline: { ...base.baseline, bytes: baselineBytes, sha256: hash(baselineBytes) },
    rationale: { problemHypothesis: "A" + "a".repeat(1800) + ".", expectedObservableDifference: "B." },
    // Opaque address strings admit quotes and backslashes. Their raw UTF8
    // lengths meet central limits while JSON escaping doubles those bytes.
    evidenceRefs: Array.from({ length: 16 }, (_, index) => ({
      v: 1 as const, tool: "ahub" as const, projectKey: '"'.repeat(256), kind: "k".repeat(64),
      id: "\\".repeat(254) + String(index).padStart(2, "0"),
      revision: '"'.repeat(128), sha256: "a".repeat(64),
    })),
  };
  for (const snapshot of [large.baseline, large.candidate]) {
    expect(Buffer.byteLength(snapshot.bytes, "utf8")).toBeLessThanOrEqual(8192);
    const role = parseRole(snapshot.bytes, large.baseline.roleId, large.baseline.layer);
    expect(taskRoleText(role).length).toBeLessThanOrEqual(2000);
    expect(taskRoleText(role, true).length).toBeLessThanOrEqual(2000);
  }
  expect(Buffer.byteLength(JSON.stringify(large.rationale), "utf8")).toBeLessThanOrEqual(2000);
  expect(large.evidenceRefs).toHaveLength(16);
  for (const ref of large.evidenceRefs) {
    expect(parseExecutionReference(ref)).toEqual(ref);
    expect(Buffer.byteLength(ref.projectKey, "utf8")).toBe(256);
    expect(Buffer.byteLength(ref.id, "utf8")).toBe(256);
    expect(Buffer.byteLength(ref.revision!, "utf8")).toBe(128);
  }
  expect(new Set(large.evidenceRefs.map(ref => JSON.stringify(ref))).size).toBe(16);
  const full = { id: independentKey(large), ...canonical(large) };
  expect(Buffer.byteLength(JSON.stringify(full), "utf8")).toBeGreaterThan(32768);
  refuses(() => parseGuidanceVariantV1(full), "invalid");
  refuses(() => guidanceVariantKey(large), "invalid");
});

test("content hashes and host variant ids require exact lowercase hex width without trailing newline", () => {
  const value = record(), host = context(value);
  for (const malformed of [
    { ...value, id: value.id + "\n" },
    { ...value, baseline: { ...value.baseline, sha256: value.baseline.sha256 + "\n" } },
    { ...value, candidate: { ...value.candidate, sha256: value.candidate.sha256 + "\n" } },
  ]) refuses(() => parseGuidanceVariantV1(malformed), "invalid");
  refuses(() => validateGuidanceVariantV1(value, { ...host, variantIds: [value.id + "\n"] }), "invalid");
  refuses(() => validateGuidanceVariantV1(value, { ...host, currentBaseline: { ...host.currentBaseline, hash: host.currentBaseline.hash + "\n" } }), "invalid");
  const refHash = record({ ...payload(), evidenceRefs: [{ ...payload().evidenceRefs[0]!, sha256: "a".repeat(64) + "\n" }] });
  refuses(() => parseGuidanceVariantV1(refHash), "invalid");
});

test("new variant boundary rejects nonenumerable and executable reference containers without narrowing opaque ids", () => {
  const value = record();
  const hidden = { ...value.evidenceRefs[0]! };
  Object.defineProperty(hidden, "id", { value: hidden.id, enumerable: false });
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: [hidden] }), "invalid");
  let invoked = 0;
  const getter = { ...value.evidenceRefs[0]! };
  Object.defineProperty(getter, "id", { enumerable: true, get() { invoked++; return "42"; } });
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: [getter] }), "invalid");
  const proxy = new Proxy(value.evidenceRefs[0]!, { ownKeys() { invoked++; return []; }, getPrototypeOf() { invoked++; return Object.prototype; } });
  refuses(() => parseGuidanceVariantV1({ ...value, evidenceRefs: [proxy] }), "invalid");
  expect(invoked).toBe(0);
  const opaque = record({ ...payload(), evidenceRefs: [{ ...value.evidenceRefs[0]!, id: "https://opaque.invalid/a?b=c" }] });
  expect(parseGuidanceVariantV1(opaque).evidenceRefs[0]!.id).toBe("https://opaque.invalid/a?b=c");
});

test("author and host actor exclude control characters at the new variant boundary", () => {
  const malformed = record({ ...payload(), author: "codex\n" });
  refuses(() => parseGuidanceVariantV1(malformed), "invalid");
  const value = record();
  refuses(() => validateGuidanceVariantV1(value, { ...context(value), actor: "codex\n" }), "invalid");
});

test("published complete golden record has the independently generated literal V1 id", () => {
  // Fixture hashes/id were generated with Python stdlib hashlib and compact
  // ensure_ascii=False JSON, independently of this module and the target code.
  const golden = vectors.golden.record;
  const { id, ...unsigned } = golden;
  expect(id).toBe(vectors.golden.expectedId);
  expect(guidanceVariantKey(unsigned as unknown as GuidanceVariantPayloadV1)).toBe(vectors.golden.expectedId);
  const parsed = parseGuidanceVariantV1(golden);
  expect<unknown>(parsed).toEqual(golden);
  expect(parsed.id).toBe(vectors.golden.expectedId);
  const role = parseRole(golden.candidate.bytes, golden.baseline.roleId, "project");
  expect(renderGuidanceVariantV1(golden)).toBe(taskRoleText(role));
  expect(renderGuidanceVariantV1(golden, true)).toBe(taskRoleText(role, true));
});
