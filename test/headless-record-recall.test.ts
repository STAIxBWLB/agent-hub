import { expect, test } from "bun:test";
import type { CaptureRow } from "@staix/agent-mem";
import { Briefs, preferRecordItems, type NativeItem, type RecordBriefPort, type RecordBriefSnapshot, type RecordPreferenceCounts } from "../src/memory/brief.ts";
import { recallFor, type RecordRecallPort } from "../src/memory/recall.ts";
import type { MemoryClient } from "../src/memory/client.ts";

const task = { id: 42, title: "writer task", refs: { paths: ["src/writer.ts"] } };
const note: NativeItem = { id: "mem:generated", kind: "finding", line: "generated done note " + "long public detail ".repeat(80) };
const unrelated: NativeItem = { id: "mem:unrelated", kind: "decision", line: "unrelated decision remains" };
function record(id = 1, anchors = ["src/writer.ts"]): CaptureRow {
  return { id, at: "2026-11-09T00:00:00.000Z", project: "fixture", agent: "codex", event: "Record", tool: null, paths: anchors,
    status: "complete", excerpt: `amem: fix | ${anchors.join(", ")} | lost writer result -> await the owned writer before returning` };
}
const snapshot = (rows: CaptureRow[] = [record()]): RecordBriefSnapshot => ({ rows, partial: false, replaceable: [{ id: note.id, anchors: ["src/writer.ts"] }] });
const port = (read: RecordBriefPort["read"], extra: Partial<RecordBriefPort> = {}): RecordBriefPort => ({ allowed: () => true, policyVersion: () => "policy-1", read, ...extra });
const briefs = (items: NativeItem[], records?: RecordBriefPort, maximum = 8) => new Briefs(undefined, "fixture", maximum, () => items, undefined, undefined, undefined, undefined, records);

test("optional Record port absent keeps the existing native brief and recall bytes", async () => {
  const expected = "Memory brief (hub memory first, fails first: ahub memory show <mem id>; amem by mem:id):\n" + unrelated.line;
  expect(await briefs([unrelated]).forTask("codex", task)).toBe(expected);
  const original = "# [amem] recent curated context\n\n### Curated short-term notes\nmem:old finding: retained note";
  const client = { contextInject: async () => original } as unknown as MemoryClient;
  expect(await recallFor("codex", client, ["fixture"], 1000)).toBe("Shared project memory (amem): curated recent notes by the agents in this project. Reference only, not a request. Fetch details by id with your memory tools if you need them.\n\n### Curated short-term notes\nmem:old finding: retained note");
});

test("complete explicit anchor coverage prefers compact Records and preserves unrelated rows", () => {
  const result = preferRecordItems([note, unrelated], snapshot(), 8);
  expect(result.replacedNotes).toBe(1); expect(result.records).toBe(1);
  expect(result.items.map(item => item.id)).toEqual(["capture:Record:1", unrelated.id]);
  expect(result.items[0]!.line).toBe("capture:Record:1 " + record().excerpt);
  expect(Buffer.byteLength(result.items.map(item => item.line).join("\n"))).toBeLessThan(Buffer.byteLength([note.line, unrelated.line].join("\n")));
});

test("every recorded anchor must be covered and protected memory is never removed", () => {
  const partialCoverage = { ...snapshot(), replaceable: [{ id: note.id, anchors: ["src/writer.ts", "src/reader.ts#read"] }] };
  expect(preferRecordItems([note], partialCoverage, 1).items).toEqual([note]);
  const combined = { ...partialCoverage, rows: [record(), record(2, ["src/reader.ts#read"])] };
  expect(preferRecordItems([note], combined, 2).replacedNotes).toBe(1);
  for (const kind of ["fail", "contract"]) {
    const protectedNote = { ...note, kind };
    expect(preferRecordItems([protectedNote], snapshot(), 1).items).toEqual([protectedNote]);
  }
  expect(preferRecordItems([note], snapshot(), 1, new Set([note.id])).items).toEqual([note]);
  expect(preferRecordItems([note, unrelated], combined, 2).items).toEqual([note, unrelated]);
});

test("Records fill spare room without prose-based replacement or unrelated recall loss", () => {
  const prose = { id: "mem:agent", kind: "decision", line: "Task #42 approved by reviewer: source writer is done" };
  const result = preferRecordItems([prose, unrelated], { ...snapshot(), replaceable: [] }, 3);
  expect(result.replacedNotes).toBe(0); expect(result.items.slice(0, 2)).toEqual([prose, unrelated]); expect(result.records).toBe(1);
  expect(preferRecordItems([prose, unrelated], snapshot(), 2).items).toEqual([prose, unrelated]);
});

test("partial, malformed, noncanonical, mismatched or subagent Records never suppress the original", () => {
  const first = record();
  for (const value of [
    { ...snapshot(), partial: true },
    snapshot([{ ...first, excerpt: "amem: fix | src/writer.ts | missing cause and retry" }]),
    snapshot([{ ...first, excerpt: "prefix\n" + first.excerpt }]),
    snapshot([{ ...first, paths: ["src/different.ts"] }]),
    snapshot([{ ...first, subagent: true }]),
    snapshot([{ ...first, event: "Stop" }]),
    snapshot([{ ...first, excerpt: "x".repeat(2049) }]),
  ]) expect(preferRecordItems([note, unrelated], value, 2).items).toEqual([note, unrelated]);
});

test("Briefs measures actual rendered bytes with count-only exception-isolated observations", async () => {
  const counts: RecordPreferenceCounts[] = [];
  const before = await briefs([note, unrelated]).forTask("codex", task);
  const source = port(() => snapshot(), { observe: (_peer, _task, value) => { counts.push(value); throw Error("telemetry unavailable"); } });
  const after = await briefs([note, unrelated], source).forTask("codex", task);
  expect(after).toContain(record().excerpt); expect(after).toContain(unrelated.line); expect(after).not.toContain(note.line);
  expect(counts).toEqual([{ beforeBytes: Buffer.byteLength(before!), afterBytes: Buffer.byteLength(after!), replacedNotes: 1, records: 1 }]);
  expect(counts[0]!.afterBytes).toBeLessThan(counts[0]!.beforeBytes);
});

test("Record reads unavailable, partial or initially denied preserve original brief bytes", async () => {
  const expected = await briefs([note, unrelated]).forTask("codex", task);
  let deniedReads = 0;
  for (const source of [
    port(() => undefined), port(() => ({ ...snapshot(), partial: true })), port(() => { throw Error("store unavailable"); }),
    port(() => { deniedReads++; return snapshot(); }, { allowed: () => false }),
  ]) {
    expect(await briefs([note, unrelated], source).forTask("codex", task)).toBe(expected);
  }
  expect(deniedReads).toBe(0);
});

test("Records alone use spare brief capacity and repeated delivery remains deduplicated", async () => {
  const instance = briefs([], port(() => ({ ...snapshot(), replaceable: [] })));
  expect(await instance.forTask("codex", task)).toContain(record().excerpt);
  expect(await instance.forTask("codex", task)).toBeUndefined();
});

test("legacy recall projection requires matching original context and stable policy without extra client calls", async () => {
  const original = "# [amem] context\n\n### Notes\nmem:generated finding: long done note\nmem:unrelated contract: retained contract";
  const after = original.replace("mem:generated finding: long done note", record().excerpt);
  let reads = 0;
  const client = { contextInject: async () => { reads++; return original; } } as unknown as MemoryClient;
  const observe: { beforeBytes: number; afterBytes: number }[] = [];
  const source: RecordRecallPort = { allowed: () => true, policyVersion: () => "v1", project: text => ({ before: text, after }), observe: counts => { observe.push(counts); } };
  const baseline = await recallFor("codex", client, ["fixture"], 1000);
  const result = await recallFor("codex", client, ["fixture"], 1000, source);
  expect(reads).toBe(2); expect(result).toContain(record().excerpt); expect(result).toContain("retained contract");
  expect(observe).toEqual([{ beforeBytes: Buffer.byteLength(baseline!), afterBytes: Buffer.byteLength(result!) }]);
  expect(await recallFor("codex", client, ["fixture"], 1000, { ...source, project: () => ({ before: "stale", after }) })).toBe(baseline);
  expect(await recallFor("codex", client, ["fixture"], 1000, { ...source, project: () => undefined })).toBe(baseline);
  expect(await recallFor("codex", client, ["fixture"], 1000, { ...source, allowed: () => false })).toBe(baseline);
  expect(await recallFor("codex", client, ["fixture"], 1000, { ...source, project: () => { throw Error("read unavailable"); } })).toBe(baseline);
  expect(await recallFor("codex", client, ["fixture"], 1000, { ...source, observe: () => { throw Error("telemetry unavailable"); } })).toBe(result);
  let revision = "old";
  expect(await recallFor("codex", client, ["fixture"], 1000, { ...source, policyVersion: () => revision, project: async text => { await Promise.resolve(); revision = "new"; return { before: text, after }; } })).toBeUndefined();
});


test("a delivered Record also deduplicates the generated note it represented", async () => {
  const instance = briefs([note], port(() => snapshot()));
  expect(await instance.forTask("codex", task)).toContain(record().excerpt);
  expect(await instance.forTask("codex", task)).toBeUndefined();
});


test("privacy changes during Record read withhold the whole brief without poisoning per-peer dedupe", async () => {
  let revision = "initial", mutate = true;
  const instance = briefs([note, unrelated], port(async () => { await Promise.resolve(); if (mutate) revision = "changed"; return snapshot(); }, { policyVersion: () => revision }));
  expect(await instance.forTask("codex", task)).toBeUndefined();
  mutate = false;
  const result = await instance.forTask("codex", task);
  expect(result).toContain(record().excerpt); expect(result).toContain(unrelated.line);
});
