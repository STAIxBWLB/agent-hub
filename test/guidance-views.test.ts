import { expect, test } from "bun:test";
import { parseGuidanceCommand, renderGuidance, renderGuidanceReceipt, validateGuidanceReceipt } from "../src/cli/guidance.ts";
import { guidanceLines, guidanceReceiptLines } from "../src/ui/guidance-view.ts";
import { terminalText } from "../src/cli/console-state.ts";
import {
  parseGuidancePageResult, parseGuidanceDiffResult, parseGuidanceWriteReceipt,
  parseGuidanceVariantV1, type GuidancePublicRecord, type GuidancePageResult, type GuidanceDiffResult,
} from "../src/hub/guidance-variants.ts";
import vectors from "./fixtures/guidance-variant-v1.json";

const id = vectors.golden.expectedId;
const current = { taskId: 42, taskCreated: 100, flowRevision: 3 };
function publicRecord(): GuidancePublicRecord {
  const record = vectors.golden.record;
  return {
    id, experimentId: "experiment-a", taskId: 42, taskCreated: 100, flowRevision: 3,
    roleId: record.baseline.roleId, layer: "project", baselineSha256: record.baseline.sha256,
    candidateSha256: record.candidate.sha256, changedSections: ["Scope"],
    bytes: { baseline: Buffer.byteLength(record.baseline.bytes), candidate: Buffer.byteLength(record.candidate.bytes), record: Buffer.byteLength(JSON.stringify(record)) },
    author: "codex", status: "declared", applicable: true, rationale: { ...record.rationale },
    evidence: [{ key: "a".repeat(64), status: "declared" }],
  };
}
const page = (): GuidancePageResult => ({ state: "available", current: { ...current }, records: [publicRecord()], truncated: false });
const diff = (): GuidanceDiffResult => ({
  state: "available", current: { ...current }, record: publicRecord(),
  sections: [
    { section: "Scope", before: "Check behavior.", after: "Check observable behavior." },
    { section: "Deliverables", before: "Report observations.", after: "Report observations." },
    { section: "Evidence", before: "Name the checks.", after: "Name the checks." },
  ],
  protectedSections: ["Not in scope", "Hub use", "Review duties"],
});
const receipt = () => ({ id, taskId: 42, experimentId: "experiment-a", status: "declared" as const, already: false });
const terminal = (lines: readonly string[]) => lines.map(line => terminalText(line).replace(/[\r\n]+/g, " "));

test("CLI parses exactly four flat selector commands without reading or rewriting a proposal", () => {
  expect(parseGuidanceCommand(["create", "--file", "/explicit nonexistent proposal.json", "--json"]))
    .toEqual({ op: "create", json: true, file: "/explicit nonexistent proposal.json" });
  expect(parseGuidanceCommand(["list", "--task", "42", "--task-created", "0"]))
    .toEqual({ op: "list", json: false, taskId: 42, taskCreated: 0 });
  expect(parseGuidanceCommand(["list", "--cursor", "Ab_09-token", "--task-created", "100", "--task", "42", "--json"]))
    .toEqual({ op: "list", json: true, taskId: 42, taskCreated: 100, cursor: "Ab_09-token" });
  expect(parseGuidanceCommand(["show", "--task", "42", "--task-created", "100", "--id", id]))
    .toEqual({ op: "show", json: false, taskId: 42, taskCreated: 100, id });
  expect(parseGuidanceCommand(["withdraw", "--revision", "0", "--id", id, "--task-created", "100", "--task", "42"]))
    .toEqual({ op: "withdraw", json: false, taskId: 42, taskCreated: 100, flowRevision: 0, id });
});

const scope = ["--task", "42", "--task-created", "100"];
for (const args of [
  [], ["activate"], ["create"], ["create", "--file"], ["create", "--file", ""], ["create", "proposal.json"],
  ["create", "--file=proposal.json"], ["create", "--file", "file", "--file", "other"],
  ["create", "--file", "file", "--json", "--json"], ["list", "--task", "42"], ["list", "--task-created", "100"],
  ["list", ...scope, "--experiment", "experiment-a"], ["list", ...scope, "--id", id],
  ["list", ...scope, "--task", "42"], ["show", ...scope], ["show", ...scope, "--id", id, "--cursor", "token"],
  ["withdraw", ...scope, "--id", id], ["withdraw", ...scope, "--revision", "1"],
  ["withdraw", ...scope, "--revision", "1", "--id", id, "--file", "file"],
  ["show", ...scope, "--id", id, "extra"], ["list", ...scope, "--"],
]) test(`CLI rejects malformed guidance grammar ${JSON.stringify(args)}`, () => { expect(() => parseGuidanceCommand(args)).toThrow("invalid guidance arguments"); });

for (const operation of ["create", "list", "show", "withdraw"] as const) for (const flag of ["--actor", "--author", "--person", "--authority", "--live-test", "--owner", "--experiment-id"])
  test(`${operation} refuses delegated ${flag} grammar`, () => {
    const args = operation === "create" ? ["create", "--file", "file"] : operation === "list" ? [operation, ...scope]
      : operation === "show" ? [operation, ...scope, "--id", id] : [operation, ...scope, "--revision", "3", "--id", id];
    expect(() => parseGuidanceCommand([...args, flag, "user"])).toThrow("invalid guidance arguments");
  });

for (const number of ["-1", "+1", "01", "1.0", "1e2", " 1", "1 ", "1\n", "9007199254740992", "NaN", "Infinity"])
  test(`task number grammar rejects ${JSON.stringify(number)}`, () => {
    expect(() => parseGuidanceCommand(["list", "--task", number, "--task-created", "100"])).toThrow();
    expect(() => parseGuidanceCommand(["list", "--task", "42", "--task-created", number])).toThrow();
    expect(() => parseGuidanceCommand(["withdraw", ...scope, "--id", id, "--revision", number])).toThrow();
  });
test("CLI hash and cursor bounds reject trailing newline, Unicode, controls and oversized tokens", () => {
  for (const hash of [id + "\n", id.toUpperCase(), id.slice(1), id + "a", "g".repeat(64)])
    expect(() => parseGuidanceCommand(["show", ...scope, "--id", hash])).toThrow();
  for (const cursor of ["", "a.b", "a b", "a\tb", "a\nb", "é", "a".repeat(513)])
    expect(() => parseGuidanceCommand(["list", ...scope, "--cursor", cursor])).toThrow();
  expect(parseGuidanceCommand(["list", ...scope, "--cursor", "a".repeat(512)]).op).toBe("list");
  expect(() => parseGuidanceCommand(["list", "--task", "0", "--task-created", "100"])).toThrow();
  for (const file of ["line\nbreak", "tab\tfile", "--json"])
    expect(() => parseGuidanceCommand(["create", "--file", file])).toThrow();
});

test("shared public parsers retain the current wrapper separately from immutable historical metadata", () => {
  const value = page();
  expect(parseGuidancePageResult(value)).toEqual(value);
  expect(parseGuidanceDiffResult(diff())).toEqual(diff());
  expect(parseGuidancePageResult({ state: "unavailable" })).toEqual({ state: "unavailable" });
  expect(parseGuidanceDiffResult({ state: "unavailable" })).toEqual({ state: "unavailable" });
  const historical = { state: "available", current: { ...current, flowRevision: 4 }, records: [{ ...publicRecord(), applicable: false }], truncated: false };
  expect(parseGuidancePageResult(historical)).toEqual(historical);
  const withheld = { ...publicRecord(), experimentId: "withheld", rationale: { problemHypothesis: "withheld", expectedObservableDifference: "withheld" } };
  expect(parseGuidancePageResult({ ...value, state: "available", records: [withheld] })).toEqual({ ...value, state: "available", records: [withheld] });
});

test("public records cannot acquire raw snapshots, addresses, private attribution or authority fields", () => {
  for (const extra of [
    { variant: vectors.golden.record }, { baseline: vectors.golden.record.baseline }, { candidate: vectors.golden.record.candidate },
    { source: "PRIVATE_ATTRIBUTION_CANARY" }, { createdAt: 1000 }, { createdBy: "codex" }, { withdrawn: { by: "user", at: 2000 } },
    { tested: true }, { authority: "user" }, { active: true },
  ]) {
    expect(() => parseGuidancePageResult({ state: "available", current, records: [{ ...publicRecord(), ...extra }], truncated: false })).toThrow();
    expect(() => parseGuidanceDiffResult({ ...diff(), record: { ...publicRecord(), ...extra } })).toThrow();
  }
  const address = { v: 1, tool: "ares", projectKey: "foreign", kind: "claim", id: "PRIVATE_OPAQUE_CANARY" };
  expect(() => parseGuidancePageResult({ state: "available", current, records: [{ ...publicRecord(), evidence: [{ key: "a".repeat(64), status: "declared", reference: address }] }], truncated: false })).toThrow();
});

test("public diff formatting accepts inline tab and LF but refuses other controls", () => {
  const original = diff();
  if (original.state !== "available") throw new Error("the diff fixture must be available");
  const withText = (text: string) => ({ ...original, sections: original.sections.map(section => ({ ...section, before: text })) });
  expect(() => parseGuidanceDiffResult(withText("Check\tbehavior.\nReport observations."))).not.toThrow();
  for (const control of ["\r", String.fromCharCode(27), String.fromCharCode(1)])
    expect(() => parseGuidanceDiffResult(withText("Check" + control + "behavior."))).toThrow();
});

test("page and diff reject malformed wrappers, protected bodies, incomplete sections and unsupported states", () => {
  for (const extra of [{ reason: "missing" }, { records: [] }, { current }]) {
    expect(() => parseGuidancePageResult({ state: "unavailable", ...extra })).toThrow();
    expect(() => parseGuidanceDiffResult({ state: "unavailable", ...extra })).toThrow();
  }
  for (const value of [
    { ...page(), unknown: true }, { ...page(), current: { ...current, actor: "user" } },
    { ...page(), current: { ...current, taskCreated: -1 } }, { ...page(), state: "pending" },
    { ...page(), records: [publicRecord(), publicRecord()] },
    { ...page(), records: [{ ...publicRecord(), status: "active" }] },
    { ...page(), records: [{ ...publicRecord(), candidateSha256: "a".repeat(64) + "\n" }] },
    { ...page(), records: [{ ...publicRecord(), taskCreated: current.taskCreated + 1 }] },
  ]) expect(() => parseGuidancePageResult(value)).toThrow();
  const original = diff();
  if (original.state !== "available") throw new Error("invalid fixture");
  for (const value of [
    { ...original, before: "PRIVATE_HEADER_CANARY" },
    { ...original, protectedSections: [{ section: "Not in scope", before: "PRIVATE_PROTECTED_CANARY" }] },
    { ...original, protectedSections: ["Not in scope", "Hub use"] },
    { ...original, sections: original.sections.slice(1) },
    { ...original, sections: [...original.sections, { section: "Hub use", before: "Private body.", after: "Private body." }] },
    { ...original, sections: original.sections.map(section => ({ ...section, raw: "PRIVATE_SNAPSHOT_CANARY" })) },
    { ...original, sections: original.sections.map(section => ({ ...section, after: "x".repeat(8193) })) },
  ]) expect(() => parseGuidanceDiffResult(value)).toThrow();
});

test("page wire ceiling is thirty-two rows and a bounded signed-source cursor", () => {
  const records = Array.from({ length: 32 }, (_, index) => ({ ...publicRecord(), id: index.toString(16).padStart(64, "0") }));
  const bounded = { state: "available", current, records, truncated: true, cursor: "A".repeat(512) };
  expect(parseGuidancePageResult(bounded)).toEqual(bounded);
  expect(() => parseGuidancePageResult({ ...bounded, records: [...records, { ...publicRecord(), id: "f".repeat(64) }] })).toThrow();
  expect(() => parseGuidancePageResult({ ...bounded, cursor: "A".repeat(513) })).toThrow();
  expect(() => parseGuidancePageResult({ ...bounded, cursor: "token\n" })).toThrow();
  expect(() => parseGuidancePageResult({ ...bounded, cursor: undefined })).toThrow();
});

test("receipt shape and correlation stay unconfirmed on malformed or different write replies", () => {
  const expected = { id, taskId: 42 };
  expect(parseGuidanceWriteReceipt(receipt())).toEqual(receipt());
  expect(validateGuidanceReceipt(receipt(), expected)).toEqual(receipt());
  expect(validateGuidanceReceipt({ ...receipt(), experimentId: "withheld" }, expected).experimentId).toBe("withheld");
  expect(validateGuidanceReceipt({ ...receipt(), status: "withdrawn", already: true }, expected).status).toBe("withdrawn");
  expect(validateGuidanceReceipt({ ...receipt(), status: "withdrawn" }, { ...expected, status: "withdrawn" }).status).toBe("withdrawn");
  for (const value of [
    { ...receipt(), id: "b".repeat(64) }, { ...receipt(), taskId: 43 }, { ...receipt(), status: "active" },
    { ...receipt(), already: "true" }, { ...receipt(), variant: vectors.golden.record }, { ...receipt(), authority: "user" },
    { ...receipt(), id: id + "\n" }, { ...receipt(), private: "PRIVATE_RECEIPT_CANARY" },
  ]) expect(() => validateGuidanceReceipt(value, expected)).toThrow("guidance write reply is unconfirmed");
  expect(() => validateGuidanceReceipt(receipt(), { ...expected, status: "withdrawn" })).toThrow("unconfirmed");
});

test("closed reply parsers never run getters, proxy traps or producer serialization hooks", () => {
  let calls = 0;
  for (const parse of [parseGuidancePageResult, parseGuidanceDiffResult, parseGuidanceWriteReceipt]) {
    const accessor = { get state() { calls++; return "available"; } };
    expect(() => parse(accessor)).toThrow();
    expect(() => parse(new Proxy({}, { ownKeys() { calls++; return []; } }))).toThrow();
    expect(() => parse({ toJSON() { calls++; return {}; } })).toThrow();
  }
  expect(calls).toBe(0);
});

test("CLI and shared human views render the same admitted data without mutating legacy records", () => {
  const old = JSON.stringify(vectors.golden.record), parsedOld = parseGuidanceVariantV1(vectors.golden.record);
  const list = parseGuidancePageResult(page()), shown = parseGuidanceDiffResult(diff()), acknowledged = parseGuidanceWriteReceipt(receipt());
  expect(renderGuidance(list)).toEqual(terminal(guidanceLines(list)));
  expect(renderGuidance(shown)).toEqual(terminal(guidanceLines(shown)));
  expect(renderGuidanceReceipt(acknowledged)).toEqual(terminal(guidanceReceiptLines(acknowledged)));
  expect(renderGuidance({ state: "unavailable" }).join("\n")).toContain("unavailable");
  const rendered = [...renderGuidance(list), ...renderGuidance(shown)].join("\n");
  expect(rendered).toContain("Scope"); expect(rendered).toContain("Check observable behavior.");
  for (const privateText of [parsedOld.baseline.bytes, parsedOld.candidate.bytes, "Use hub_task_done for handoff.", "Review the evidence.", "source: Independent local conformance fixture."])
    expect(rendered).not.toContain(privateText);
  expect(JSON.stringify(vectors.golden.record)).toBe(old); expect(parsedOld).toEqual(vectors.golden.record);
});

test("terminal renderer removes controls even from a violated upstream typed precondition", () => {
  const value = diff();
  if (value.state !== "available") throw new Error("invalid fixture");
  const control = String.fromCharCode(27), unsafe = `${control}[31mVisible canary.${control}[0m`;
  const unsafeResult = { ...value, sections: value.sections.map(section => ({ ...section, after: unsafe + "\nSecond line." })) };
  const rendered = renderGuidance(unsafeResult).join("\n");
  expect(rendered).not.toContain(control); expect(rendered).toContain("Visible canary.");
  const original = JSON.stringify(value);
  renderGuidance(value); expect(JSON.stringify(value)).toBe(original);
});


test("protected section names reject nested serialization hooks without invoking them", () => {
  let calls = 0;
  const original = diff();
  if (original.state !== "available") throw new Error("invalid fixture");
  const nested = { toJSON() { calls++; return "Not in scope"; } };
  expect(() => parseGuidanceDiffResult({ ...original, protectedSections: [nested, "Hub use", "Review duties"] })).toThrow();
  expect(calls).toBe(0);
});
