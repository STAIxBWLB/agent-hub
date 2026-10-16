import { realPath } from "../src/hub/project.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore, candidateTargetRevision, type View } from "@staix/agent-mem";
import { correctionInput, MemoryTelemetry, resolveVisibleMemory } from "../src/hub/memory-candidates.ts";
import { memoryRead, type MemoryScreen } from "../src/hub/read-tools.ts";

const screen: MemoryScreen = rows => rows.filter(row => !JSON.stringify(row).includes("PRIVATE"));
const dirs: string[] = [], closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-candidates-"))); dirs.push(dir); return dir; }
function fixture() {
  const home = temp(), project = "agent-hub";
  const store = new MemoryStore({ home, deferPromotions: true });
  const sidecar = new CandidateStore({ home });
  closers.push(() => sidecar.close(), () => store.close());
  const note = (text: string, over: Partial<Parameters<MemoryStore["note"]>[0]> = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind: "decision", peer: "codex", source: "person", text, about: [], ...over });
  return { home, project, store, sidecar, note };
}
function logs(store: MemoryStore) {
  return Object.fromEntries(["log", "local"].flatMap(dir => readdirSync(join(store.dir, dir)).sort().filter(name => name.endsWith(".jsonl")).map(name => [`${dir}/${name}`, readFileSync(join(store.dir, dir, name), "utf8")])));
}

test("correction input enforces UTF-8 and combined caps before any storage access", () => {
  const valid = { id: "abcdef", text: "가".repeat(1333), reason: "valid correction reason" };
  expect(correctionInput(valid)).toEqual(valid);
  expect(correctionInput({ id: "a".repeat(64), text: "x".repeat(4000), reason: "y".repeat(4000) }).text).toHaveLength(4000);
  for (const input of [null, [], {}, { ...valid, id: "abcde" }, { ...valid, id: "가".repeat(22) }, { ...valid, text: "가".repeat(1334) }, { ...valid, reason: "가".repeat(1334) }, { ...valid, reason: " " }, { ...valid, text: "" }, { ...valid, text: "bad\0text" }, { ...valid, project: "other" }, { ...valid, text: "\n".repeat(3999) + "x", reason: "\n".repeat(3999) + "x" }]) {
    expect(() => correctionInput(input)).toThrow("memory read unavailable");
  }
});

test("visible resolution refuses hidden metadata, foreign ids, obsolete notes and ambiguous aliases uniformly", () => {
  const { store, note, project } = fixture();
  const visible = note("visible decision"), privateId = note("PRIVATE body"), metadataId = note("clean body", { about: ["path:PRIVATE/file.ts"] });
  const foreign = note("foreign decision", { project: "foreign-project" });
  expect(resolveVisibleMemory(store, project, screen, visible.slice(0, 8)).id).toBe(visible);
  expect(resolveVisibleMemory(store, project, screen, `mem:${visible}`).id).toBe(visible);
  for (const input of [privateId, metadataId, foreign, "abcdef", "PRIVATE", "tiny"]) {
    expect(() => resolveVisibleMemory(store, project, screen, input)).toThrow("memory read unavailable");
  }
  const next = note("new personal decision"); store.supersede(visible, next, "person", project);
  expect(() => resolveVisibleMemory(store, project, screen, visible)).toThrow("memory read unavailable");
  const row = store.get(next, project)!;
  // Deliberate prefix collision and promotion alias shape; no probabilistic hash search in a regression.
  const aliases = [{ ...row, id: "abcdef00111111111111111111111111", promotedFrom: "12345678111111111111111111111111" }, { ...row, id: "abcdef00222222222222222222222222", promotedFrom: "12345678222222222222222222222222" }];
  const synthetic = { list: () => aliases, get: () => undefined, withDeferredPromotions: <T>(work: () => T): T => work() } as unknown as MemoryStore;
  for (const input of ["abcdef00", "12345678"]) expect(() => resolveVisibleMemory(synthetic, project, screen, input)).toThrow("memory read unavailable");
  const original = "99999999111111111111111111111111";
  const redirected = { list: () => [row], get: () => row, withDeferredPromotions: <T>(work: () => T): T => work() } as unknown as MemoryStore;
  expect(resolveVisibleMemory(redirected, project, screen, original).id).toBe(row.id);
  const hiddenRedirect = { ...redirected, get: () => ({ ...row, id: privateId }) } as unknown as MemoryStore;
  expect(() => resolveVisibleMemory(hiddenRedirect, project, screen, original)).toThrow("memory read unavailable");
});

test("telemetry is sidecar-only, idempotent, privacy-aware and preserves unknown versus measured zero", () => {
  const { store, sidecar, project, note } = fixture();
  const id = note("public original"), hidden = note("PRIVATE original");
  const telemetry = new MemoryTelemetry(sidecar, store, project, screen), context = { deliveryId: "delivery-1", session: "session-1", turn: "turn-1", task: "task-1" };
  const before = logs(store), message = `private message body omitted; mem:${id.slice(0, 8)} mem:${id} mem:${hidden} mem:deadbeef`;
  telemetry.record(message, context, "rendered"); telemetry.record(message, context, "rendered");
  expect(sidecar.counters(project)).toHaveLength(1);
  expect(sidecar.counters(project)[0]).toMatchObject({ key: { entryId: id, project, ...context }, rendered: 1, delivered: null, cited: null });
  telemetry.record(message, context, "delivered");
  expect(sidecar.counters(project)[0]).toMatchObject({ rendered: 1, delivered: 1, cited: null });
  sidecar.recordCounter({ ...context, project, entryId: id, deliveryId: "zero" }, { rendered: 0 }, "public");
  telemetry.record(`mem:${id}`, { ...context, deliveryId: "zero" }, "cited");
  expect(sidecar.counters(project).find(row => row.key.deliveryId === "zero")).toMatchObject({ rendered: 0, delivered: null, cited: 1 });
  telemetry.record(message, { deliveryId: "private-turn" }, "rendered", true);
  telemetry.record(message, { deliveryId: "PRIVATE context" }, "rendered");
  expect(sidecar.counters(project)).toHaveLength(2);
  expect(JSON.stringify(sidecar.counters(project))).not.toContain("private message body");
  expect(logs(store)).toEqual(before);
  sidecar.close(); closers.shift();
  expect(() => telemetry.record(message, { deliveryId: "closed" }, "cited")).not.toThrow();
});

test("pending correction, fail and decay candidates never become list, search or graph evidence", () => {
  const { store, sidecar, project, note } = fixture();
  const id = note("ordinary accepted memory", { about: ["path:src/a.ts"] });
  const target: View = store.get(id, project)!, revision = candidateTargetRevision(target), marker = "candidate-only-unique-marker";
  const before = logs(store);
  sidecar.put({ project, kind: "correction", target: { id, revision }, proposedText: marker, reason: "correct obsolete details" }, "public");
  sidecar.put({ project, kind: "fail", approach: marker, symptom: "did not work", cause: "specific cause", evidenceRefs: ["test:fixture"], retryWhen: "new evidence" }, "public");
  sidecar.put({ project, kind: "decay", target: { id, revision }, reason: marker }, "public");
  expect(sidecar.list({ project })).toHaveLength(3);
  expect(store.list({ project, limit: Number.MAX_SAFE_INTEGER }).map(row => row.id)).toEqual([id]);
  expect(store.list({ project, q: marker })).toEqual([]);
  expect(JSON.parse(memoryRead(store, project, screen, "hub_memory_search", { query: marker })).lines).toEqual([]);
  expect(JSON.stringify(store.graph(project, `mem:${id}`, 2, 120))).not.toContain(marker);
  expect(memoryRead(store, project, screen, "hub_memory_graph", { starts: [`mem:${id}`] })).not.toContain(marker);
  expect(logs(store)).toEqual(before);
});

test("one telemetry observation projects and fully screens visible rows once for all cited ids", () => {
  const { store, sidecar, project, note } = fixture();
  const ids = [note("first visible note"), note("second visible note"), note("third visible note")];
  let lists = 0, projections = 0;
  const fullScreens = new Map<string, number>();
  const countedScreen: MemoryScreen = rows => {
    if (rows.some(row => "id" in row)) projections++;
    for (const row of rows) {
      if (!row.text.startsWith("{")) continue;
      const value = JSON.parse(row.text) as { id?: string; about?: string[] };
      if (value.id && Array.isArray(value.about)) fullScreens.set(value.id, (fullScreens.get(value.id) ?? 0) + 1);
    }
    return screen(rows);
  };
  const countedStore = {
    list: (...args: Parameters<MemoryStore["list"]>) => { lists++; return store.list(...args); },
    get: (...args: Parameters<MemoryStore["get"]>) => store.get(...args),
    withDeferredPromotions: <T>(work: () => T): T => store.withDeferredPromotions(work),
  } as unknown as MemoryStore;
  const telemetry = new MemoryTelemetry(sidecar, countedStore, project, countedScreen);
  const text = ids.flatMap(id => [`mem:${id}`, `mem:${id.slice(0, 8)}`]).join(" ");
  telemetry.record(text, { deliveryId: "one-projection" }, "rendered");
  expect(lists).toBe(1); expect(projections).toBe(1);
  for (const id of ids) expect(fullScreens.get(id)).toBe(1);
  expect(sidecar.counters(project)).toHaveLength(3);
  // A later observation must obtain a fresh projection, including the changed policy.
  telemetry.record(text, { deliveryId: "one-projection" }, "delivered");
  expect(lists).toBe(2); expect(projections).toBe(2);
  for (const id of ids) expect(fullScreens.get(id)).toBe(2);
  expect(sidecar.counters(project).every(row => row.rendered === 1 && row.delivered === 1)).toBe(true);
});
