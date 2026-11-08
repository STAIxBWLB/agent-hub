import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore, RECORD_INSTRUCTION, parseRecordLines } from "@staix/agent-mem";
import { RecordCapture, stripRecordLines, type RecordCaptureCounts, type RecordCapturePolicy } from "../src/memory/records.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const record = "amem: fix | src/run.ts#run | synthetic hang/cause -> synthetic fix";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-records-")); roots.push(root);
  const cwd = join(root, "project"), memoryDir = join(root, "memory"); mkdirSync(cwd);
  let eligible = true, records = true, current = true, policyReads = 0;
  const observations: RecordCaptureCounts[] = [];
  const policy: RecordCapturePolicy = { records: true, current: () => current, cwd, memoryDir, project: "synthetic-project", peer: "codex",
    turn: "synthetic-turn", session: "synthetic-session", at: new Date().toISOString(), publicText: () => true, denyPath: () => false };
  const capture = new RecordCapture({ eligible: () => eligible, policy: () => { policyReads++; return { ...policy, records }; }, observe: count => observations.push(count) });
  const rows = () => {
    const store = new CaptureStore({ memoryDir, project: policy.project, cwd, readOnly: true });
    try { return store.rows({ limit: 10 }); } finally { store.close(); }
  };
  return { root, cwd, memoryDir, policy, capture, observations, rows, policyReads: () => policyReads,
    eligible: (value: boolean) => { eligible = value; }, records: (value: boolean) => { records = value; }, current: (value: boolean) => { current = value; } };
}
test("instruction is the exact imported package instruction, never a copied or assembled prompt", () => {
  const f = fixture(); expect(f.capture.instruction()).toBe(RECORD_INSTRUCTION);
  expect(existsSync(f.memoryDir)).toBe(false); expect(f.observations).toEqual([]);
});
test("valid records use direct library storage and host attribution, without forwarding internal lines", () => {
  const f = fixture(), second = "amem: decision | - | synthetic decision";
  const input = `Shared answer\n${record}\n${second}`;
  const result = f.capture.finish(input);
  expect(result).toEqual({ text: "Shared answer\n", accepted: 2, dropped: 0, bytes: Buffer.byteLength(record) + Buffer.byteLength(second) });
  const rows = f.rows(); expect(rows).toHaveLength(2);
  expect(rows.map(row => row.excerpt)).toEqual(parseRecordLines(input).records.map(item => item.line));
  expect(rows[0]).toMatchObject({ project: f.policy.project, agent: "codex", event: "Record", paths: ["src/run.ts#run"], at: f.policy.at });
  for (const row of rows) {
    expect(row.session).toMatch(/^[a-f0-9]{16}$/); expect(row.status).toMatch(/^turn:[a-f0-9]{16}$/);
    expect(JSON.stringify(row)).not.toContain(f.policy.session); expect(JSON.stringify(row)).not.toContain(f.policy.turn);
  }
  expect(rows[0]!.session).toBe(rows[1]!.session);
  expect(f.observations).toEqual([{ accepted: 2, dropped: 0, bytes: result.bytes }]);
  expect(Object.keys(f.observations[0]!).sort()).toEqual(["accepted", "bytes", "dropped"]);
});
test("excluded turns do not read policy/config, open storage or emit observations, but still strip markers", () => {
  for (const kind of ["private", "remote", "review", "ineligible"]) {
    let reads = 0, observations = 0;
    const capture = new RecordCapture({ eligible: () => false,
      policy: () => { reads++; throw Error(`${kind} turn reached configuration`); }, observe: () => { observations++; throw Error("excluded observation"); } });
    expect(capture.instruction()).toBeUndefined();
    expect(capture.finish(`Shared\namem: invalid ${kind}`)).toEqual({ text: "Shared\n", accepted: 0, dropped: 0, bytes: 0 });
    capture.close(); expect(reads).toBe(0); expect(observations).toBe(0);
  }
});
test("records false or missing is disabled at instruction and final boundaries", () => {
  const f = fixture(); f.records(false);
  expect(f.capture.instruction()).toBeUndefined(); expect(f.capture.finish(record)).toEqual({ text: "", accepted: 0, dropped: 0, bytes: 0 });
  expect(existsSync(f.memoryDir)).toBe(false); expect(f.observations).toEqual([]);
  const absent = new RecordCapture({ eligible: () => true, policy: () => undefined });
  expect(absent.instruction()).toBeUndefined(); expect(absent.finish(record).accepted).toBe(0);
  const missing = new RecordCapture({ eligible: () => true, policy: () => ({ current() { throw Error("missing flag must stop first"); } } as unknown as RecordCapturePolicy) });
  expect(missing.instruction()).toBeUndefined(); expect(missing.finish(record)).toEqual({ text: "", accepted: 0, dropped: 0, bytes: 0 });
});
test("opt-out or exclusion after instruction is rechecked before final storage", () => {
  const f = fixture(); expect(f.capture.instruction()).toBe(RECORD_INSTRUCTION);
  f.records(false); expect(f.capture.finish(record).accepted).toBe(0); expect(existsSync(f.memoryDir)).toBe(false);
  f.records(true); expect(f.capture.instruction()).toBe(RECORD_INSTRUCTION);
  const reads = f.policyReads(); f.eligible(false); expect(f.capture.finish(record).accepted).toBe(0);
  expect(f.policyReads()).toBe(reads); expect(f.observations).toEqual([]);
});
test("invalid, fenced, quoted, private-span and excess record lines are stripped and counted without parser duplication", () => {
  const f = fixture();
  const input = ["Shared", "amem: malformed", "```", record, "```", `> ${record}`, "", `amem: decision | - | <private>synthetic-private</private>`, record,
    "amem: decision | - | second", "amem: decision | - | third"].join("\n");
  const parsed = parseRecordLines(input); expect(parsed.records).toHaveLength(2);
  const result = f.capture.finish(input); expect(result.text).not.toContain("amem:"); expect(result.text).not.toContain("synthetic-private");
  expect(result.accepted).toBe(2); expect(result.dropped).toBe(5);
  expect(f.rows().map(row => row.excerpt)).toEqual(parsed.records.map(item => item.line));
});
test("host PII/secret/deny screening drops whole records before opening a store", () => {
  const blocked = [
    (p: RecordCapturePolicy) => { p.publicText = () => false; },
    (p: RecordCapturePolicy) => { p.publicText = () => { throw Error("screen unavailable"); }; },
    (p: RecordCapturePolicy) => { p.denyPath = value => value === "src/run.ts"; },
    (p: RecordCapturePolicy) => { p.denyPath = () => { throw Error("deny unavailable"); }; },
  ];
  for (const block of blocked) {
    const f = fixture(); block(f.policy); const result = f.capture.finish(record);
    expect(result).toEqual({ text: "", accepted: 0, dropped: 1, bytes: 0 }); expect(existsSync(f.memoryDir)).toBe(false);
  }
  const secret = fixture(); expect(secret.capture.finish("amem: decision | - | api_key=synthetic-credential-only").accepted).toBe(0);
  expect(existsSync(secret.memoryDir)).toBe(false);
});
test("whole-batch preflight notices current-turn exclusion before any store or observation", () => {
  const f = fixture(); f.policy.publicText = text => { if (text.includes("second")) f.current(false); return true; };
  expect(f.capture.finish(`${record}\namem: decision | - | second`)).toEqual({ text: "", accepted: 0, dropped: 0, bytes: 0 });
  expect(existsSync(f.memoryDir)).toBe(false); expect(f.observations).toEqual([]);
});
test("package caps refuse an entire Record rather than storing a silently clipped excerpt", () => {
  const f = fixture(); mkdirSync(f.memoryDir); const config = join(f.memoryDir, "amem.config.json"), raw = JSON.stringify({ excerptBytes: 20 }); writeFileSync(config, raw);
  expect(f.capture.finish(record)).toEqual({ text: "", accepted: 0, dropped: 1, bytes: 0 });
  expect(f.rows()).toEqual([]); expect(readFileSync(config, "utf8")).toBe(raw);
});
test("storage/config and observation errors cannot leak internal records or fail the shared answer", () => {
  const f = fixture(); writeFileSync(f.memoryDir, "owned fixture blocks a directory");
  expect(f.capture.finish(`Shared\n${record}`)).toEqual({ text: "Shared\n", accepted: 0, dropped: 1, bytes: 0 });
  const broken = new RecordCapture({ eligible: () => true, policy: () => { throw Error("synthetic config error canary"); } });
  expect(broken.instruction()).toBeUndefined(); expect(broken.finish(`Shared\n${record}`)).toEqual({ text: "Shared\n", accepted: 0, dropped: 0, bytes: 0 });
  const observed = fixture(), throwing = new RecordCapture({ eligible: () => true, policy: () => observed.policy, observe: () => { throw Error("synthetic observation error"); } });
  expect(throwing.finish(record).accepted).toBe(1); expect(observed.rows()).toHaveLength(1);
});
test("stable per-turn receipts deduplicate replay even when a preceding record was denied", () => {
  const f = fixture(), first = "amem: decision | - | first";
  f.policy.publicText = text => !text.includes("first");
  expect(f.capture.finish(`${first}\n${record}`).accepted).toBe(1); expect(f.rows()).toHaveLength(1);
  f.policy.publicText = () => true;
  expect(f.capture.finish(`${first}\n${record}`).accepted).toBe(2); expect(f.rows()).toHaveLength(2);
});
test("strip handles LF, CRLF and bare CR without changing other bytes, including invalid markers", () => {
  const ordinary = "Shared  \r\nnext\nlast\rfinal"; expect(stripRecordLines(ordinary)).toBe(ordinary);
  expect(stripRecordLines("Shared\ramem: invalid\rnext\r\namem: also invalid\r\nlast\namem: invalid")).toBe("Shared\rnext\r\nlast\n");
  expect(stripRecordLines("amem: invalid\n  amem: invalid\r> amem: invalid\r\nShared")).toBe("Shared");
});
