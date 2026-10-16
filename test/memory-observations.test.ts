import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore } from "@staix/agent-mem";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { MemoryTelemetry } from "../src/hub/memory-candidates.ts";
import { MemoryObservations, type MemoryContext, type MemoryObservationContext } from "../src/hub/memory-observations.ts";
import type { MemoryScreen } from "../src/hub/read-tools.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const screen: MemoryScreen = rows => rows.filter(row => !JSON.stringify(row).includes("WITHHELD"));
const initialContext = { session: "session-1", turn: "turn-1", task: "task-1" };

function fixture(context: MemoryContext = () => initialContext) {
  const home = mkdtempSync(join(tmpdir(), "ahub-memory-observations-")), project = "agent-hub";
  const store = new MemoryStore({ home, deferPromotions: true });
  const sidecar = new CandidateStore({ home });
  let sidecarClosed = false;
  const closeSidecar = () => { if (!sidecarClosed) { sidecar.close(); sidecarClosed = true; } };
  cleanup.push(() => { closeSidecar(); store.close(); rmSync(home, { recursive: true, force: true }); });
  const note = (text: string, about: string[] = []) => store.note({ op: "note", project, tier: "long", scope: "project", kind: "decision", peer: "codex", source: "person", text, about });
  const id = note("visible personal decision");
  const telemetry = new MemoryTelemetry(sidecar, store, project, screen);
  const observations = new MemoryObservations(telemetry, context);
  const preface = newEnvelope(HUB, `mem:${id.slice(0, 8)} decision long: visible personal decision`, { to: ["codex"], kind: "presence" });
  return { observations, sidecar, store, project, id, note, preface, closeSidecar, counters: () => sidecar.counters(project) };
}

test("unknown or private context records neither render, delivery nor citation", () => {
  const { observations, preface, counters } = fixture(() => undefined);
  observations.delivery("codex", "private-delivery", [preface], "rendered");
  observations.delivery("codex", "private-delivery", [preface], "delivered");
  observations.cite("codex", preface.body, "private-citation");
  expect(counters()).toEqual([]);
});

test("acknowledgement in the original session retains the render task and turn after the active turn changes", () => {
  let current: MemoryObservationContext = { ...initialContext };
  const { observations, preface, counters, id, project } = fixture(() => current);
  observations.delivery("codex", "delivery-1", [preface], "rendered");
  current = { session: "session-1", turn: "turn-2", task: "task-2" };
  observations.delivery("codex", "delivery-1", [preface], "delivered");
  observations.delivery("codex", "delivery-1", [preface], "delivered");
  expect(counters()).toHaveLength(1);
  expect(counters()[0]).toMatchObject({ key: { entryId: id, project, deliveryId: "delivery-1", ...initialContext }, rendered: 1, delivered: 1, cited: null });
});

test("changed-session, wrong-peer and unobserved acknowledgements never fabricate delivery", () => {
  let current: MemoryObservationContext = { ...initialContext };
  const { observations, preface, counters } = fixture(() => current);
  observations.delivery("codex", "delivery-1", [preface], "rendered");
  observations.delivery("claude", "delivery-1", [preface], "delivered");
  expect(counters()[0]?.delivered).toBeNull();
  current = { session: "session-2", turn: "turn-2", task: "task-2" };
  observations.delivery("codex", "delivery-1", [preface], "delivered");
  // Once rejected for a changed session it cannot later be attributed to the old one.
  current = { ...initialContext };
  observations.delivery("codex", "delivery-1", [preface], "delivered");
  observations.delivery("codex", "never-rendered", [preface], "delivered");
  expect(counters()).toHaveLength(1);
  expect(counters()[0]).toMatchObject({ rendered: 1, delivered: null, cited: null });
});

test("presence and native task briefs render memory while ordinary quoted citations only cite", () => {
  const { observations, preface, counters, id } = fixture();
  const brief = newEnvelope(HUB, `Task #1\nMemory brief (hub memory first):\nmem:${id} decision long: decision`, { to: ["codex"], kind: "task" });
  const quoted = newEnvelope("claude", `An earlier answer quoted mem:${id}`, { to: ["codex"] });
  observations.delivery("codex", "preface", [preface], "rendered");
  observations.delivery("codex", "brief", [brief], "rendered");
  observations.delivery("codex", "quoted", [quoted], "rendered");
  observations.delivery("codex", "quoted", [quoted], "delivered");
  observations.cite("codex", quoted.body, "quote-citation", [quoted]);
  const rows = counters();
  expect(rows).toHaveLength(3);
  expect(rows.find(row => row.key.deliveryId === "preface")).toMatchObject({ rendered: 1, delivered: null, cited: null });
  expect(rows.find(row => row.key.deliveryId === "brief")).toMatchObject({ rendered: 1, delivered: null, cited: null });
  expect(rows.find(row => row.key.deliveryId === "quote-citation")).toMatchObject({ rendered: null, delivered: null, cited: 1 });
  expect(rows.some(row => row.key.deliveryId === "quoted")).toBe(false);
});

test("citation counter keys resolve only project-visible screened memories and remain idempotent", () => {
  const { observations, counters, id, note, store, project } = fixture();
  const hidden = note("WITHHELD private text"), metadata = note("ordinary text", ["path:WITHHELD/file.ts"]);
  const foreign = store.note({ op: "note", project: "foreign-project", scope: "project", tier: "long", kind: "decision", peer: "codex", source: "person", text: "foreign note", about: [] });
  const text = `mem:${id} mem:${id.slice(0, 8)} mem:${hidden} mem:${metadata} mem:${foreign} mem:deadbeef`;
  observations.cite("codex", text, "citation");
  observations.cite("codex", text, "citation");
  expect(counters()).toHaveLength(1);
  expect(counters()[0]).toMatchObject({ key: { entryId: id, project, deliveryId: "citation", ...initialContext }, rendered: null, delivered: null, cited: 1 });
  expect(JSON.stringify(counters())).not.toContain("WITHHELD");
});

test("any private envelope suppresses render and citation and makes an earlier public delivery unknown", () => {
  const { observations, preface, counters } = fixture();
  const privateEnv = newEnvelope("user", "synthetic private material", { to: ["codex"], private: true });
  observations.delivery("codex", "private-render", [preface, privateEnv], "rendered");
  observations.delivery("codex", "private-render", [preface], "delivered");
  observations.cite("codex", preface.body, "private-citation", [privateEnv]);
  expect(counters()).toEqual([]);
  observations.delivery("codex", "public-render", [preface], "rendered");
  observations.delivery("codex", "public-render", [preface, privateEnv], "delivered");
  observations.delivery("codex", "public-render", [preface], "delivered");
  expect(counters()).toHaveLength(1);
  expect(counters()[0]).toMatchObject({ rendered: 1, delivered: null, cited: null });
});

test("context and closed-sidecar exceptions fail open without invented measurements", () => {
  let throws = true;
  const { observations, preface, counters, closeSidecar } = fixture(() => { if (throws) throw new Error("context unavailable"); return initialContext; });
  expect(() => observations.delivery("codex", "context-error", [preface], "rendered")).not.toThrow();
  expect(() => observations.cite("codex", preface.body, "context-error")).not.toThrow();
  expect(counters()).toEqual([]);
  throws = false;
  observations.delivery("codex", "public-render", [preface], "rendered");
  throws = true;
  expect(() => observations.delivery("codex", "public-render", [preface], "delivered")).not.toThrow();
  expect(counters()[0]).toMatchObject({ rendered: 1, delivered: null });
  throws = false;
  closeSidecar();
  expect(() => observations.delivery("codex", "closed-render", [preface], "rendered")).not.toThrow();
  expect(() => observations.delivery("codex", "closed-render", [preface], "delivered")).not.toThrow();
  expect(() => observations.cite("codex", preface.body, "closed-citation")).not.toThrow();
});
