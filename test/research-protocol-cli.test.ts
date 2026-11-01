import { expect, test } from "bun:test";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
import { parseStudyArgs, STUDY_USAGE } from "../src/cli/study.ts";
import { renderStudyReceipt } from "../src/cli/study-output.ts";
import type { Span } from "../src/cli/console-state.ts";

const HASH = "a".repeat(64), EVALUATOR = "b".repeat(64), ID = "rc-0123456789ab";
const plain = (rows: Span[][]) => rows.map(row => row.map(span => span.text).join("")).join("\n");

test("study approve-protocol parses one exact lowercase protocol hash into its console operation", () => {
  const argv = ["approve-protocol", HASH] as const;
  const parsed = parseStudyArgs(argv);
  expect(parsed).toEqual({ op: "approve_protocol", hash: HASH });
  if ("usage" in parsed) throw new Error("the valid protocol hash was refused");
  expect(`study_${parsed.op}`).toBe("study_approve_protocol");
  expect(argv).toEqual(["approve-protocol", HASH]);
  expect(STUDY_USAGE).toContain("approve-protocol <hash>");
});

test("study approve-protocol refuses missing, malformed and excess operands using the existing usage result", () => {
  for (const operands of [["approve-protocol"], ["approve-protocol", ""], ["approve-protocol", HASH.slice(1)], ["approve-protocol", HASH + "a"],
    ["approve-protocol", "A".repeat(64)], ["approve-protocol", "g".repeat(64)], ["approve-protocol", HASH + "\n"],
    ["approve-protocol", " " + HASH], ["approve-protocol", HASH, "1"], ["approve-protocol", HASH, "--yes"], ["approve_protocol", HASH]]) {
    expect(parseStudyArgs(operands), JSON.stringify(operands)).toMatchObject({ usage: expect.stringContaining(STUDY_USAGE) });
  }
});

test("all pre-existing study forms retain their request shapes", () => {
  const cases: [string[], unknown][] = [
    [["draft", "3", "contract.json"], { op: "draft", parentTaskId: 3, file: "contract.json" }],
    [["revise", ID, "2", "revised.json"], { op: "revise", id: ID, revision: 2, file: "revised.json" }],
    [["approve", ID, "2"], { op: "approve", id: ID, revision: 2 }],
    [["close", ID, "2", "--reason", "Synthetic", "study", "complete"], { op: "close", id: ID, revision: 2, reason: "Synthetic study complete" }],
    [["show"], { op: "show" }], [["show", ID], { op: "show", id: ID }], [["show", "--after", ID], { op: "show", after: ID }],
  ];
  for (const [argv, expected] of cases) expect(parseStudyArgs(argv)).toEqual(expected);
});

test("approve-protocol stays person-only and cannot be delegated by an agent live test", () => {
  expect(classifyPeerCommand("study", ["approve-protocol", HASH])).toBe("console");
  expect(liveTestRefusal("study", ["approve-protocol", HASH])).toBe(true);
  expect(classifyPeerCommand("study", ["show", ID])).toBe("allowed");
});

test("protocol approval receipt renders only identities and approval metadata, preserving its input JSON", () => {
  const receipt = { protocolHash: HASH, evaluatorHash: EVALUATOR, approvedBy: "user", approvedAt: Date.UTC(2026, 10, 1),
    protocol: { method: "PRIVATE_PROTOCOL_BODY_CANARY" }, note: "PRIVATE_APPROVAL_NOTE_CANARY", units: [{ unitId: "PRIVATE_UNIT_CANARY" }] };
  const before = JSON.stringify(receipt), rendered = plain(renderStudyReceipt("approve_protocol", receipt));
  expect(rendered).toContain("Research protocol approval");
  expect(rendered).toContain(HASH); expect(rendered).toContain(EVALUATOR); expect(rendered).toContain("user"); expect(rendered).toContain("2026-11-01 00:00:00 UTC");
  expect(rendered).not.toContain("PRIVATE_"); expect(rendered).not.toContain("Research campaign");
  expect(JSON.stringify(receipt)).toBe(before);
});

test("missing approval metadata renders unknown without inventing a campaign receipt or a successful approval", () => {
  const rendered = plain(renderStudyReceipt("approve_protocol", { protocolHash: "invalid", evaluatorHash: null, approvedAt: Infinity }));
  expect(rendered).toContain("unknown"); expect(rendered).not.toContain("invalid"); expect(rendered).not.toContain("approved as");
  expect(rendered).not.toContain("revision 0"); expect(rendered).not.toContain("#0");
});
