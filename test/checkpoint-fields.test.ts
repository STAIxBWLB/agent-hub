import { expect, test } from "bun:test";
import { CHECKPOINT_FIELDS, CHECKPOINT_FIELDS_SENTENCE, CHECKPOINT_TOTAL_MAX_CHARS, checkpointFieldCount, parseCheckpointFields, renderCheckpoint } from "../src/hub/checkpoint-fields.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { buildResearchQuality } from "../src/hub/research-quality.ts";
import type { StampedEvent } from "../src/hub/events.ts";

const refusal = (args: Record<string, unknown>) => { try { parseCheckpointFields(args); } catch (e) { return e; } return undefined; };

test("AC1: a call with only summary renders the summary byte for byte and carries no field", () => {
  const fields = parseCheckpointFields({ summary: "  half done  " });
  expect(fields).toEqual({});
  expect(checkpointFieldCount(fields)).toBe(0);
  expect(renderCheckpoint("was halfway through the parser", fields)).toBe("was halfway through the parser");
  // Absent, null, empty and blank fields are all "missing", never invented.
  expect(parseCheckpointFields({ done: undefined, next: null, traps: "", verified_by: "  \n " })).toEqual({});
  // A summary-only call keeps its old behavior at any length: the total cap binds only a call that carries fields.
  const long = "x".repeat(CHECKPOINT_TOTAL_MAX_CHARS * 2);
  expect(renderCheckpoint(long, {})).toBe(long);
});

test("AC2: the fields render after the summary in the fixed order, whatever order the caller sent them, and missing ones are omitted", () => {
  const sent = { traps: "the cache is shared", next: "wire the tool", done: "parser", verified_by: "bun test parser" };
  const fields = parseCheckpointFields(sent);
  expect(checkpointFieldCount(fields)).toBe(4);
  expect(renderCheckpoint("S", fields)).toBe("S\n\nDone:\nparser\n\nNext:\nwire the tool\n\nVerified by:\nbun test parser\n\nTraps:\nthe cache is shared");
  expect(renderCheckpoint("S", fields)).not.toContain("In progress");
  const all = parseCheckpointFields({ traps: "t", verified_by: "v", next: "n", in_progress: "i", done: "d" });
  const text = renderCheckpoint("S", all);
  expect(CHECKPOINT_FIELDS).toEqual(["done", "in_progress", "next", "verified_by", "traps"]);
  const positions = ["Done:", "In progress:", "Next:", "Verified by:", "Traps:"].map(h => text.indexOf(h));
  expect(positions.every(p => p > 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  // CRLF input renders as LF.
  expect(parseCheckpointFields({ done: "a\r\nb" }).done).toBe("a\nb");
});

test("AC3: a field over 5 lines or over 200 characters in a line is refused with the field and the limit named, never truncated", () => {
  const tooMany = refusal({ done: "1\n2\n3\n4\n5\n6" });
  expect(tooMany).toBeInstanceOf(PreEffectToolRefusal);
  expect((tooMany as Error).message).toBe("checkpoint field done has 6 lines; the limit is 5 lines");
  expect(refusal({ done: "1\n2\n3\n4\n5" })).toBeUndefined();
  const tooLong = refusal({ traps: `ok\n${"y".repeat(201)}` });
  expect(tooLong).toBeInstanceOf(PreEffectToolRefusal);
  expect((tooLong as Error).message).toBe("checkpoint field traps line 2 has 201 characters; the limit is 200 characters per line");
  expect(refusal({ traps: "y".repeat(200) })).toBeUndefined();
  // Characters, not bytes: 200 multibyte characters fit.
  expect(refusal({ next: "한".repeat(200) })).toBeUndefined();
  expect((refusal({ next: 5 }) as Error).message).toBe("checkpoint field next must be a string");
  // The total stays within what a handoff keeps (3000): 5 full fields would not fit, and the refusal names the total.
  const full = parseCheckpointFields(Object.fromEntries(CHECKPOINT_FIELDS.map(name => [name, Array(5).fill("z".repeat(200)).join("\n")])));
  expect(() => renderCheckpoint("S", full)).toThrow(`the limit is ${CHECKPOINT_TOTAL_MAX_CHARS} characters in total`);
  expect(renderCheckpoint("S", parseCheckpointFields({ done: Array(5).fill("z".repeat(200)).join("\n") })).length).toBeLessThanOrEqual(CHECKPOINT_TOTAL_MAX_CHARS);
});

test("the tool and the request text name the five fields in their render order", () => {
  const tool = TASK_TOOLS.find(t => t.name === "hub_checkpoint")!;
  const properties = (tool.inputSchema as { properties: Record<string, unknown>; required: string[] }).properties;
  expect(Object.keys(properties)).toEqual(["summary", "done", "in_progress", "next", "verified_by", "traps", "request_id"]);
  expect((tool.inputSchema as { required: string[] }).required).toEqual(["summary"]);
  expect(tool.description).toContain(CHECKPOINT_FIELDS_SENTENCE);
  const order = CHECKPOINT_FIELDS.map(name => CHECKPOINT_FIELDS_SENTENCE.indexOf(`${name} (`));
  expect(order.every(p => p > 0) && [...order].sort((a, b) => a - b).join() === order.join()).toBe(true);
});

const at = (n: number) => new Date(Date.UTC(2026, 10, 15, 0, n)).toISOString();
const checkpoint = (n: number, fields: string[], peer = "codex"): StampedEvent => ({ type: "checkpoint", peer, reason: "quota", fields, at: at(n) } as StampedEvent);

test("AC4: the research quality report counts checkpoints by how many fields each had and by field, null when none was saved", () => {
  const none = buildResearchQuality([], [], {}, id => id);
  expect(none.events.checkpoints).toBeNull();
  const q = buildResearchQuality([], [checkpoint(1, []), checkpoint(2, ["done", "next"]), checkpoint(3, ["done", "traps", "next"]), checkpoint(4, ["next", "next", "bogus"])], {}, id => id);
  expect(q.events.checkpoints).toEqual({ total: 4, byFieldCount: { "0": 1, "1": 1, "2": 1, "3": 1 }, byField: { done: 2, next: 3, traps: 1 } });
  expect(q.events.present).toMatchObject({ checkpoint: 4 });
  // Names only: nothing a peer wrote can reach the report.
  expect(JSON.stringify(q.events.checkpoints)).not.toContain("bogus");
});
