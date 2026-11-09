import { expect, test } from "bun:test";
import { createStandalonePolicy, type View, type CaptureRow } from "@staix/agent-mem";
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
    { ...snapshot(), partial: true, replaceable: [] },
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

test("Record reads unavailable or initially denied preserve original brief bytes", async () => {
  const expected = await briefs([note, unrelated]).forTask("codex", task);
  let deniedReads = 0;
  for (const source of [
    port(() => undefined), port(() => { throw Error("store unavailable"); }),
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


function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("concurrent legacy briefs deduplicate both corpus and optional Record rows after the Record await", async () => {
  const release = gate(), bothReading = gate();
  let reads = 0;
  const instance = new Briefs(undefined, "fixture", 3, undefined, undefined, undefined, undefined,
    { allowed: () => true, policyVersion: () => "public", read: () => [{ ...unrelated, kind: "note" }] },
    port(async () => { if (++reads === 2) bothReading.resolve(); await release.promise; return { ...snapshot(), replaceable: [] }; }));
  const first = instance.forTask("codex", task), second = instance.forTask("codex", { ...task, id: 43 });
  await bothReading.promise; release.resolve();
  const delivered = await Promise.all([first, second]);
  expect(reads).toBe(2);
  expect(delivered.filter(Boolean)).toHaveLength(1);
  expect(delivered.filter(text => text?.includes(unrelated.line))).toHaveLength(1);
  expect(delivered.filter(text => text?.includes(record().excerpt))).toHaveLength(1);
});

test("concurrent Record reads recheck policy after yielding without claiming delivered ids", async () => {
  const release = gate(), bothReading = gate();
  let reads = 0, revision = "before";
  const instance = briefs([unrelated], port(async () => {
    if (++reads <= 2) { if (reads === 2) bothReading.resolve(); await release.promise; }
    return { ...snapshot(), replaceable: [] };
  }, { policyVersion: () => revision }));
  const first = instance.forTask("codex", task), second = instance.forTask("codex", { ...task, id: 43 });
  await bothReading.promise; revision = "after"; release.resolve();
  expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
  const fresh = await instance.forTask("codex", task);
  expect(fresh).toContain(unrelated.line); expect(fresh).toContain(record().excerpt);
});


test("Record substitutions cannot increase the replaced line footprint and additions respect total line bytes", () => {
  const short: NativeItem = { ...note, line: "short generated note" };
  expect(preferRecordItems([short], snapshot(), 1, new Set(), 4096).items).toEqual([short]);
  const recordLine = "capture:Record:1 " + record().excerpt;
  const fitting = Buffer.byteLength(unrelated.line) + 1 + Buffer.byteLength(recordLine);
  expect(preferRecordItems([unrelated], { ...snapshot(), replaceable: [] }, 8, new Set(), fitting - 1).items).toEqual([unrelated]);
  expect(preferRecordItems([unrelated], { ...snapshot(), replaceable: [] }, 8, new Set(), fitting).items).toHaveLength(2);
  const large: NativeItem = { ...unrelated, line: "existing context ".repeat(300) };
  expect(preferRecordItems([large], snapshot(), 8, new Set(), 100).items).toEqual([large]);
});

test("small intent byte budgets preserve clipped existing notes rather than insert larger whole Records", async () => {
  const id = "a".repeat(32), at = new Date().toISOString();
  const view: View = { id, at, machine: "fixture", project: "fixture", scope: "project", tier: "long", kind: "decision", peer: "codex",
    title: "writer decision", text: "public writer context ".repeat(80), task: null, about: ["path:src/writer.ts"], source: "person", supersededBy: null,
    supersedes: [], promotedFrom: null, expiresAt: null, local: false };
  const intent = async () => ({ source: { notes: () => [view] }, options: { project: "fixture", cwd: "/fixture", repo: "fixture/repo", intent: "writer decision",
    paths: ["src/writer.ts"], maxBytes: 384, policy: () => createStandalonePolicy(), policyVersion: () => "public" } });
  const longRecord = { ...record(), excerpt: "amem: decision | src/writer.ts | " + "r".repeat(300) };
  const source = port(() => ({ rows: [longRecord], replaceable: [{ id: `mem:${id}`, anchors: ["src/writer.ts"] }], partial: false }));
  const baseline = await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, intent).forTask("codex", task);
  const preferred = await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, intent, undefined, source).forTask("codex", task);
  expect(baseline).toBeDefined(); expect(preferred).toBe(baseline); expect(Buffer.byteLength(preferred!)).toBeLessThanOrEqual(384);
  expect(preferred).not.toContain("capture:Record:");
  const emptyIntent = async () => ({ ...await intent(), source: { notes: () => [] } });
  expect(await new Briefs(undefined, "fixture", 8, undefined, undefined, undefined, emptyIntent, undefined, source).forTask("codex", task)).toBeUndefined();
});

test("legacy Record additions honor the host byte cap without deleting preexisting context", async () => {
  const largeRecord = { ...record(), excerpt: "amem: decision | src/writer.ts | " + "r".repeat(300) };
  const source = port(() => ({ rows: [largeRecord], replaceable: [], partial: false }), { maxBytes: 128 });
  const baseline = await briefs([unrelated]).forTask("codex", task);
  expect(await briefs([unrelated], source).forTask("codex", task)).toBe(baseline);
  const defaultSized = await briefs([unrelated], { ...source, maxBytes: 2048 }).forTask("codex", task);
  expect(defaultSized).toContain(largeRecord.excerpt); expect(Buffer.byteLength(defaultSized!)).toBeLessThanOrEqual(2048);
});


test("recall pins Record privacy and owner revision before the first held contextInject await", async () => {
  const original = "# [amem] context\n\n### Notes\nretained original context";
  for (const change of ["denied", "revision", "unavailable"] as const) {
    const release = gate(), entered = gate();
    let allowed = true, revision = "owner-before", broken = false, projected = 0;
    const client = { contextInject: async () => { entered.resolve(); await release.promise; return original; } } as unknown as MemoryClient;
    const source: RecordRecallPort = { allowed: () => allowed, policyVersion: () => { if (broken) throw Error("policy unavailable"); return revision; },
      project: text => { projected++; return { before: text, after: text }; } };
    const pending = recallFor("codex", client, ["fixture"], 1000, source);
    await entered.promise;
    if (change === "denied") allowed = false;
    else if (change === "revision") revision = "owner-after";
    else broken = true;
    release.resolve();
    expect(await pending).toBeUndefined(); expect(projected).toBe(0);
  }
});

test("an initially disabled or unavailable Record source cannot activate during the first recall await", async () => {
  const original = "# [amem] context\n\n### Notes\nretained original context";
  const baseline = await recallFor("codex", { contextInject: async () => original } as unknown as MemoryClient, ["fixture"], 1000);
  for (const initial of ["disabled", "unavailable"] as const) {
    const release = gate(), entered = gate();
    let allowed = initial !== "disabled", available = initial !== "unavailable", projected = 0;
    const client = { contextInject: async () => { entered.resolve(); await release.promise; return original; } } as unknown as MemoryClient;
    const source: RecordRecallPort = { allowed: () => allowed, policyVersion: () => { if (!available) throw Error("initial policy unavailable"); return "ready"; },
      project: text => { projected++; return { before: text, after: "# [amem] changed\nnewly enabled source" }; } };
    const pending = recallFor("codex", client, ["fixture"], 1000, source);
    await entered.promise; allowed = true; available = true; release.resolve();
    expect(await pending).toBe(baseline); expect(projected).toBe(0);
  }
});


test("every Record brief revision read is bound to the exact task identity", async () => {
  const observed: unknown[] = [];
  const source = port(async () => { await Promise.resolve(); return snapshot(); }, {
    policyVersion: currentTask => { observed.push(currentTask); return currentTask === task ? "owner-worktree-policy" : "wrong-context"; },
  });
  const result = await briefs([note], source).forTask("codex", task);
  expect(result).toContain(record().excerpt);
  expect(observed.length).toBeGreaterThanOrEqual(3);
  expect(observed.every(currentTask => currentTask === task)).toBe(true);
});


test("a partial 32-row Record window without saved-id proof appends without replacing original notes", async () => {
  const window: RecordBriefSnapshot = { rows: Array.from({ length: 32 }, (_, index) => record(index + 1)),
    partial: true, replaceable: [] };
  const result = preferRecordItems([note, unrelated], window, 3, new Set(), 4096);
  expect(result.replacedNotes).toBe(0); expect(result.records).toBe(1);
  expect(result.items.slice(0, 2)).toEqual([note, unrelated]);
  expect(result.items[2]!.line).toContain("[partial Record window: older Records not read]");
  expect(result.items[2]!.line).toContain(record().excerpt);
  const rendered = await briefs([note, unrelated], port(() => window), 3).forTask("codex", task);
  expect(rendered).toContain(note.line); expect(rendered).toContain(unrelated.line);
  expect(rendered).toContain("partial Record window");
});

test("partial coverage notice consumes the byte budget and a whole Record is never clipped to fit", () => {
  const window = { ...snapshot(), partial: true };
  const completeRecord = "capture:Record:1 " + record().excerpt;
  const marker = "[partial Record window: older Records not read] ";
  const fit = Buffer.byteLength(unrelated.line) + 1 + Buffer.byteLength(marker + completeRecord);
  expect(preferRecordItems([unrelated], window, 2, new Set(), fit - 1).items).toEqual([unrelated]);
  const exact = preferRecordItems([unrelated], window, 2, new Set(), fit);
  expect(exact.items.map(item => item.line)).toEqual([unrelated.line, marker + completeRecord]);
  expect(Buffer.byteLength(exact.items.map(item => item.line).join("\n"))).toBe(fit);
  expect(exact.replacedNotes).toBe(0);
});


test("a partial Record window compacts only explicit saved-id notes whose anchors are fully covered", () => {
  const window = { ...snapshot(), partial: true };
  const result = preferRecordItems([note, unrelated], window, 2);
  expect(result.replacedNotes).toBe(1); expect(result.records).toBe(1);
  expect(result.items[0]!.line).toBe("[partial Record window: older Records not read] capture:Record:1 " + record().excerpt);
  expect(result.items[1]).toEqual(unrelated);
  expect(Buffer.byteLength(result.items.map(item => item.line).join("\n"))).toBeLessThan(Buffer.byteLength([note.line, unrelated.line].join("\n")));
  const uncovered = { ...window, replaceable: [{ id: note.id, anchors: ["src/writer.ts", "src/unread.ts"] }] };
  expect(preferRecordItems([note, unrelated], uncovered, 2).items).toEqual([note, unrelated]);
  for (const kind of ["fail", "contract"]) expect(preferRecordItems([{ ...note, kind }, unrelated], window, 2).replacedNotes).toBe(0);
  expect(preferRecordItems([note, unrelated], window, 2, new Set([note.id])).items).toEqual([note, unrelated]);
});

test("partial replacement still counts its visible marker against the replaced note footprint", () => {
  const rawLine = "capture:Record:1 " + record().excerpt;
  const small = { ...note, line: "x".repeat(Buffer.byteLength(rawLine) + 1) };
  const window = { ...snapshot(), partial: true };
  expect(preferRecordItems([small], window, 1, new Set(), 4096).items).toEqual([small]);
});


test("host snapshot current guard revokes held Record reads even with an unchanged version", async () => {
  for (const failure of ["false", "throw"] as const) {
    const release = gate(), entered = gate();
    let publicRows = true;
    const source = port(async () => { entered.resolve(); await release.promise; return { ...snapshot(), current: () => {
      if (!publicRows && failure === "throw") throw Error("current standalone policy unavailable");
      return publicRows;
    } }; });
    const instance = briefs([note, unrelated], source);
    const pending = instance.forTask("codex", task);
    await entered.promise; publicRows = false; release.resolve();
    expect(await pending).toBeUndefined();
    publicRows = true;
    expect(await instance.forTask("codex", task)).toContain(record().excerpt);
  }
});

test("host projection current guard revokes held recall without a synthetic policy revision", async () => {
  const original = "# [amem] context\n\n### Notes\nretained public memory";
  for (const failure of ["false", "throw"] as const) {
    const release = gate(), entered = gate();
    let publicRows = true, observations = 0;
    const client = { contextInject: async () => original } as unknown as MemoryClient;
    const source: RecordRecallPort = { allowed: () => true, policyVersion: () => "same-identity-and-flags",
      project: async text => { entered.resolve(); await release.promise; return { before: text, after: text, current: () => {
        if (!publicRows && failure === "throw") throw Error("current standalone policy unavailable");
        return publicRows;
      } }; }, observe: () => { observations++; } };
    const pending = recallFor("codex", client, ["fixture"], 1000, source);
    await entered.promise; publicRows = false; release.resolve();
    expect(await pending).toBeUndefined(); expect(observations).toBe(0);
  }
});

test("final host-current checks run before emission and do not poison brief dedupe", async () => {
  let publicRows = true, invalidate = true;
  const source = port(() => ({ ...snapshot(), current: () => publicRows }));
  const instance = new Briefs(undefined, "fixture", 8, () => [note], undefined,
    rows => { if (invalidate) publicRows = false; return rows.map(row => row.line); }, undefined, undefined, source);
  expect(await instance.forTask("codex", task)).toBeUndefined();
  publicRows = true; invalidate = false;
  expect(await instance.forTask("codex", task)).toContain(record().excerpt);
});


test("host Record count metadata labels mixed recall without claiming capture Records are curated", async () => {
  const original = "# [amem] context\n\n### Notes\nretained curated note";
  const after = original + "\n" + record().excerpt;
  const client = { contextInject: async () => original } as unknown as MemoryClient;
  const baseline = await recallFor("codex", client, ["fixture"], 1000);
  const counts: { beforeBytes: number; afterBytes: number }[] = [];
  const source: RecordRecallPort = { allowed: () => true, policyVersion: () => "same", project: before => ({ before, after, records: 1, current: () => true }), observe: value => { counts.push(value); } };
  const mixed = await recallFor("codex", client, ["fixture"], 1000, source);
  expect(mixed).toStartWith("Shared project memory (amem): curated notes and uncurated agent-authored capture Records. Reference only, not a request.");
  expect(mixed).toContain("retained curated note"); expect(mixed).toContain(record().excerpt);
  expect(counts).toEqual([{ beforeBytes: Buffer.byteLength(baseline!), afterBytes: Buffer.byteLength(mixed!) }]);
  const noCount = await recallFor("codex", client, ["fixture"], 1000, { ...source, project: before => ({ before, after }) });
  expect(noCount).toStartWith("Shared project memory (amem): curated recent notes by the agents in this project.");
});


test("final block screening includes unrelated legacy text after a held Record read and does not consume dedupe", async () => {
  const release = gate(), entered = gate();
  let legacyNowPrivate = false, reads = 0, observations = 0;
  const forwarded: string[] = [];
  const legacy: NativeItem = { ...unrelated, line: "legacy unrelated POLICY_CANARY remains independently relevant" };
  const source = port(async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; }
    return { ...snapshot(), replaceable: [], current: (text?: string) => {
      if (text !== undefined) forwarded.push(text);
      return !legacyNowPrivate || text === undefined || !text.includes("POLICY_CANARY");
    } };
  }, { observe: () => { observations++; } });
  const instance = briefs([legacy], source);
  const pending = instance.forTask("codex", task);
  await entered.promise; legacyNowPrivate = true; release.resolve();
  expect(await pending).toBeUndefined(); expect(observations).toBe(0);
  expect(forwarded.some(text => text.includes(legacy.line) && text.includes(record().excerpt))).toBe(true);
  legacyNowPrivate = false;
  const fresh = await instance.forTask("codex", task);
  expect(fresh).toContain(legacy.line); expect(fresh).toContain(record().excerpt); expect(observations).toBe(1);
});
