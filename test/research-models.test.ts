import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { readEvents, turnModelFields, type ModelObservation, type StampedEvent } from "../src/hub/events.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { appendRecords, CSV_COLUMNS, formatResearch, readStores, researchReport, RESEARCH_SCHEMA, taskRecords, toCsv, type TaskRecord } from "../src/hub/research.ts";
import { profileEventValid } from "../src/hub/dogfood-profile.ts";

// #1402 T1: `turn_end` carries the model a native surface reported (with its evidence grade), research builds `ownerModels` from the owner's turns and groups by it.

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-research-models-${name}-`))); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
let clock = Date.parse("2026-11-01T00:00:00Z");
const at = () => new Date(clock += 60_000).toISOString();
const task = (id: number, event: string, state: string, extra: { owner?: string; reviewer?: string; by?: string } = {}): StampedEvent =>
  ({ v: 1, at: at(), type: "task", id, event, by: extra.by ?? "hub", state, owner: extra.owner ?? null, reviewer: extra.reviewer ?? null, class: "implement", pii: false } as StampedEvent);
const turn = (peer: string, id: number, extra: Record<string, unknown> = {}): StampedEvent =>
  ({ v: 1, at: at(), type: "turn_end", peer, turn: `${peer}#1.${id}`, ms: 1000, task: id, attribution: "delivery", ...extra } as StampedEvent);
const writer = { version: "test", source: "backfill" as const };
const approved = (id: number, owner: string, reviewer: string, between: StampedEvent[]): StampedEvent[] => [
  task(id, "proposed", "proposed", { reviewer }), task(id, "assigned", "in_progress", { owner, reviewer }), ...between,
  task(id, "done", "in_review", { owner, reviewer }), task(id, "approved", "approved", { owner, reviewer, by: reviewer }),
];
const records = (events: StampedEvent[]): TaskRecord[] => taskRecords(events, "p-1", writer);

test("turnModelFields keeps a safe label with a known grade whole, and drops anything else without repairing it", () => {
  expect(turnModelFields({ model: "gpt-5.5", evidence: "session" })).toEqual({ model: "gpt-5.5", modelEvidence: "session" });
  expect(turnModelFields({ model: "kimi-code/k3", evidence: "served" })).toEqual({ model: "kimi-code/k3", modelEvidence: "served" });
  const long = "m".repeat(161);
  for (const bad of [undefined, null, "gpt", {}, { model: "gpt-5.5" }, { evidence: "served" }, { model: "gpt-5.5", evidence: "guessed" }, { model: "has space", evidence: "served" },
    { model: "/etc/passwd", evidence: "served" }, { model: long, evidence: "served" }, { model: 7, evidence: "served" }, { model: "ok\nbad", evidence: "served" }])
    expect(turnModelFields(bad)).toEqual({});
  // Nothing but the id is stored.
  expect(Object.keys(turnModelFields({ model: "gpt-5.5", evidence: "served", token: "secret", path: "/x" } as unknown as ModelObservation))).toEqual(["model", "modelEvidence"]);
});

test("ownerModels come from the owner's turns, never the reviewer's; a Codex task reviewed by Claude is listed under the Codex model only", () => {
  const events = [
    ...approved(1, "codex", "claude", [
      turn("codex", 1, { model: "gpt-5.5", modelEvidence: "session" }),
      turn("claude", 1, { model: "claude-opus-5-5", modelEvidence: "served" }),
      { v: 1, at: at(), type: "usage", peer: "claude", source: "claude_transcript", id: "c1", servedModel: "claude-opus-5-5", totalTokens: 10, task: 1, attribution: "delivery" } as StampedEvent,
    ]),
  ];
  const [record] = records(events);
  expect(record!.ownerModels).toEqual([{ model: "gpt-5.5", evidence: "session" }]);
  // `models` stays the union, for compatibility.
  expect(record!.models).toEqual(["claude-opus-5-5"]);
  const report = researchReport([record!]);
  expect(Object.keys(report.byModel)).toEqual(["gpt-5.5"]);
  expect(report.modelEvidence).toEqual({ "gpt-5.5": "session" });
  expect(report.modelCoverage).toEqual({ tasks: 1, withModel: 1, grounded: 1, unknown: 0 });
});

test("a usage event's served model grades served, a requested one only configured, and the strongest grade per model wins", () => {
  const usage = (id: string, extra: Record<string, unknown>) => ({ v: 1, at: at(), type: "usage", peer: "pi", source: "omniroute", id, totalTokens: 5, task: 1, attribution: "delivery", ...extra }) as StampedEvent;
  const [record] = records(approved(1, "pi", "claude", [
    usage("a", { requestedModel: "qwen-x" }), usage("b", { requestedModel: "qwen-y", servedModel: "qwen-y" }),
    turn("pi", 1, { model: "qwen-x", modelEvidence: "session" }), usage("c", { requestedModel: "qwen-y" }),
  ]));
  expect(record!.ownerModels).toEqual([{ model: "qwen-x", evidence: "session" }, { model: "qwen-y", evidence: "served" }]);
});

test("a task whose owner used two models counts under each; the row label carries the weakest grade when it is not served", () => {
  const first = records(approved(1, "codex", "claude", [turn("codex", 1, { model: "gpt-5.5", modelEvidence: "served" }), turn("codex", 1, { model: "gpt-5.4", modelEvidence: "served" })]));
  const second = records(approved(2, "codex", "claude", [turn("codex", 2, { model: "gpt-5.5", modelEvidence: "configured" })]));
  const report = researchReport([...first, ...second]);
  expect(report.byModel["gpt-5.4"]!.tasks).toBe(1);
  expect(report.byModel["gpt-5.5"]!.tasks).toBe(2);
  expect(Object.keys(report.byModel)).toEqual(["gpt-5.4", "gpt-5.5"]);
  expect(report.modelEvidence).toEqual({ "gpt-5.4": "served", "gpt-5.5": "configured" });
  expect(formatResearch(report).join("\n")).toContain("gpt-5.5 (configured)");
});

test("old events without a model still group as unknown, and the report says how many tasks have none", () => {
  const [record] = records(approved(1, "codex", "claude", [turn("codex", 1), { v: 1, at: at(), type: "usage", peer: "claude", source: "claude_transcript", id: "c1", servedModel: "claude-opus-5-5", totalTokens: 1, task: 1, attribution: "delivery" } as StampedEvent]));
  expect(record!.ownerModels).toEqual([]);
  const report = researchReport([record!]);
  expect(Object.keys(report.byModel)).toEqual(["unknown"]);
  expect(report.modelCoverage).toEqual({ tasks: 1, withModel: 0, grounded: 0, unknown: 1 });
  expect(formatResearch(report).join("\n")).toContain("1 of 1 tasks have no owner model");
  // A record stored before #1402 has no field at all, and loads as unknown.
  const { ownerModels: _drop, ...old } = record!;
  const legacy = researchReport([old as TaskRecord]);
  expect(Object.keys(legacy.byModel)).toEqual(["unknown"]);
});

test("an unsafe model label on an event never reaches a record", () => {
  const [record] = records(approved(1, "codex", "claude", [turn("codex", 1, { model: "/Users/x/secret", modelEvidence: "served" }), turn("codex", 1, { model: "gpt-5.5", modelEvidence: "bogus" })]));
  expect(record!.ownerModels).toEqual([]);
});

test("the CSV gets ownerModels as an additive trailing column", () => {
  const [record] = records(approved(1, "codex", "claude", [turn("codex", 1, { model: "gpt-5.5", modelEvidence: "session" })]));
  expect(CSV_COLUMNS.at(-1)).toBe("ownerModels");
  const [head, row] = toCsv([record!]).split("\n");
  expect(head!.split(",").at(-1)).toBe("ownerModels");
  expect(row!.endsWith(",gpt-5.5:session")).toBe(true);
  expect(record!.schema).toBe(RESEARCH_SCHEMA);
});

test("the dogfood profile accepts the new fields and refuses an unsafe one", () => {
  const base = { v: 1, at: "2026-11-01T00:00:00Z", type: "turn_end", peer: "codex", turn: "t", ms: 1 };
  expect(profileEventValid({ ...base, model: "gpt-5.5", modelEvidence: "session" })).toBe(true);
  expect(profileEventValid(base)).toBe(true);
  expect(profileEventValid({ ...base, model: "/x", modelEvidence: "session" })).toBe(false);
  expect(profileEventValid({ ...base, model: "gpt-5.5", modelEvidence: "guess" })).toBe(false);
});

class ModelPeer extends BasePeer {
  observed: unknown;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) { this.setState("busy"); queueMicrotask(() => this.setState("idle")); }
  observedModel() { return this.observed as ModelObservation | undefined; }
}

test("the daemon writes the observed model on turn_end, and neither field when the adapter reports nothing or a label it must refuse", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-turn-model-"));
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd: join(import.meta.dir, ".."), stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const peer = new ModelPeer("fixture", 60_000); daemon.bus.add(peer); await peer.start();
  const file = join(stateDir, "events.jsonl");
  const ends = () => readEvents(file).filter(e => e.type === "turn_end" && e.peer === "fixture") as Extract<StampedEvent, { type: "turn_end" }>[];
  const run = async (observed: unknown) => {
    const before = ends().length; peer.observed = observed;
    daemon.bus.publish(newEnvelope(USER, "work", { to: ["fixture"] }));
    for (let i = 0; i < 300 && ends().length === before; i++) await Bun.sleep(10);
    expect(ends().length).toBe(before + 1);
    return ends().at(-1)!;
  };
  expect(await run({ model: "gpt-5.5", evidence: "session" })).toMatchObject({ model: "gpt-5.5", modelEvidence: "session" });
  const none = await run(undefined); expect("model" in none).toBe(false); expect("modelEvidence" in none).toBe(false);
  const bad = await run({ model: "/etc/passwd", evidence: "served" }); expect("model" in bad).toBe(false); expect("modelEvidence" in bad).toBe(false);
});

test("by model keeps the model id as the key and carries the grade as data; an owner model literally named unknown stays apart from the no-model row", () => {
  const graded = records(approved(1, "codex", "claude", [turn("codex", 1, { model: "gpt-5.5", modelEvidence: "session" })]));
  const none = records(approved(2, "codex", "claude", [turn("codex", 2)]));
  const report = researchReport([...graded, ...none]);
  expect(Object.keys(report.byModel)).toEqual(["gpt-5.5", "unknown"]);
  expect(report.modelEvidence).toEqual({ "gpt-5.5": "session" });
  const text = formatResearch(report).join("\n");
  expect(text).toContain("gpt-5.5 (session)");
  expect(text).toContain("run ahub research backfill");
  // A placeholder id never becomes an observation, and a stored one reads as no model: it cannot merge with, or stand beside, the no-model row.
  const placeholder = records(approved(3, "pi", "claude", [{ v: 1, at: at(), type: "usage", peer: "pi", source: "omniroute", id: "u", requestedModel: "unknown", totalTokens: 1, task: 3, attribution: "delivery" } as StampedEvent]));
  expect(placeholder[0]!.ownerModels).toEqual([]);
  const stored = { ...graded[0]!, task: 9, ownerModels: [{ model: "Unknown", evidence: "served" as const }] };
  expect(Object.keys(researchReport([stored]).byModel)).toEqual(["unknown"]);
  expect(researchReport([stored]).modelCoverage).toEqual({ tasks: 1, withModel: 0, grounded: 0, unknown: 1 });
});

test("a held pre-#1402 row is filled by a backfill that can prove an owner model, so the stored task groups under it; a held row with the field stays final", () => {
  const home = temp("backfill-models");
  const events = approved(1, "codex", "claude", [
    { v: 1, at: at(), type: "usage", peer: "codex", source: "omniroute", id: "u1", servedModel: "gpt-5.5", totalTokens: 9, task: 1, attribution: "delivery" } as StampedEvent,
    turn("codex", 1)]);
  const [rebuilt] = taskRecords(events, "p-1", writer);
  const { ownerModels: _drop, ...old } = rebuilt!;
  expect(appendRecords("p-1", [old as TaskRecord], home)).toBe(1);
  expect(Object.keys(researchReport(readStores("p-1", home)).byModel)).toEqual(["unknown"]);
  expect(appendRecords("p-1", [rebuilt!], home)).toBe(1);
  expect(Object.keys(researchReport(readStores("p-1", home)).byModel)).toEqual(["gpt-5.5"]);
  // Final once it has the field: a later rebuild with a different list does not replace it, and a rebuild with no model never replaces a held row.
  expect(appendRecords("p-1", [{ ...rebuilt!, ownerModels: [{ model: "other", evidence: "served" }] }], home)).toBe(0);
  const bare = temp("backfill-models-bare");
  expect(appendRecords("p-1", [old as TaskRecord], bare)).toBe(1);
  expect(appendRecords("p-1", [{ ...rebuilt!, ownerModels: [] }], bare)).toBe(0);
});
