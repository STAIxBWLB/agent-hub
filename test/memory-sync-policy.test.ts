import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, readMigrationPrefix, readMigrationSources, syncMemory, type NoteInput, type Visibility } from "@staix/agent-mem";
import { createMemorySyncPolicy, inspectDeclinedMemoryRows, projectMemorySyncText } from "../src/hub/memory-sync-policy.ts";

const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-memory-sync-policy-")); dirs.push(dir); return dir; };
const privateRemote = { visibility: async (): Promise<Visibility> => "private" };
const note = (text: string, over: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project: "work/app", scope: "project", tier: "long", kind: "decision", peer: "codex", text, about: [], source: "hub", ...over });

test("outbound projection excludes only agent-mem generated fields and keeps every content field", () => {
  const projected = projectMemorySyncText({ id: "generated", schema: 1, op: "note", at: "now", machine: "m", actor: "a", target: "generated", promotedFrom: "generated", supersedes: "generated", expires: "generated", by: "generated", tier: "long", scope: "project", kind: "decision", source: "hub", project: "project text", peer: "peer text", task: "task text", about: ["about text"], title: "title text", text: "body text", milestones: ["milestone text"], futureText: "unknown text" });
  expect(projected).toEqual({ project: "project text", peer: "peer text", task: "task text", about: ["about text"], title: "title text", text: "body text", milestones: ["milestone text"], futureText: "unknown text" });
});

test("policy matches configured sync rules for forgotten physical originals and reports ids without text", async () => {
  const home = temp();
  writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: ["decline-me"] }));
  const store = new MemoryStore({ memoryDir: home }); stores.push(store);
  const id = store.note(note("a decision with decline-me in its body"));
  store.forget(id, "user");
  const policy = createMemorySyncPolicy({ home });
  const original = readMigrationSources(home).filter(source => source.path === `log/${store.machine.id}.jsonl`)
    .flatMap(source => readMigrationPrefix(home, source).toString("utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>))
    .find(row => row.id === id)!;
  expect(policy.screen(original)).toMatchObject({ ok: false, rule: "configured standalone policy: personal data, configured pattern, or deny path" });
  const originalTargets = store.openedSyncTargets.bind(store), originalPrunePort = store.prunePort.bind(store);
  let targetCalls = 0, prunePortCalls = 0;
  store.openedSyncTargets = () => { targetCalls++; return originalTargets(); };
  store.prunePort = () => { prunePortCalls++; return originalPrunePort(); };
  const inspected = inspectDeclinedMemoryRows(store, policy);
  expect(inspected).toMatchObject({ complete: false, reason: "declined-row inspection requires a bounded public agent-mem API" });
  expect([targetCalls, prunePortCalls]).toEqual([0, 0]);
  store.openedSyncTargets = originalTargets;
  store.prunePort = originalPrunePort;
  expect(JSON.stringify(inspected)).not.toContain("decline-me");
  expect(inspected.declinedIdsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const synced = await syncMemory(store, { ...privateRemote, screen: row => policy.screen(row).ok });
  expect(synced).toMatchObject({ ok: false, pushed: false, error: expect.stringContaining("configured privacy policy declines") });
});

test("host narrowing sees projected business fields and exposes only a closed safe rule category", () => {
  const home = temp();
  const policy = createMemorySyncPolicy({ home, hostScreen: row => row.peer === "private peer name" ? { ok: false, rule: "hub privacy policy: PII pattern or private path" } : { ok: true } });
  expect(policy.screen({ id: "id", peer: "private peer name", text: "safe" })).toEqual({ ok: false, rule: "hub privacy policy: PII pattern or private path" });
  expect(policy.screen({ id: "private-looking-generated-id", peer: "safe", text: "safe" })).toEqual({ ok: true });
  const untrustedLabel = createMemorySyncPolicy({ home, hostScreen: () => ({ ok: false, rule: "private peer name and secret pattern" }) });
  expect(untrustedLabel.screen({ peer: "safe", text: "safe" })).toEqual({ ok: false, rule: "hub privacy policy" });
});

test("projection rejects accessors and proxies without invoking them", () => {
  const home = temp();
  let getterCalls = 0, proxyTraps = 0, hostCalls = 0;
  const policy = createMemorySyncPolicy({ home, hostScreen: () => { hostCalls++; return { ok: true }; } });
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "text", { enumerable: true, get: () => { getterCalls++; return "unsafe"; } });
  const proxy = new Proxy({}, { ownKeys: () => { proxyTraps++; return []; } }) as Record<string, unknown>;
  expect(policy.screen(accessor)).toEqual({ ok: false, rule: "configured standalone policy: invalid input" });
  expect(policy.screen(proxy)).toEqual({ ok: false, rule: "configured standalone policy: invalid input" });
  expect([getterCalls, proxyTraps, hostCalls]).toEqual([0, 0, 0]);
});

test("an own __proto__ content field remains visible to standalone screening", () => {
  const home = temp();
  const row = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(row, "__proto__", { value: "canary-value", enumerable: true, configurable: true, writable: true });
  const policy = createMemorySyncPolicy({ home, piiPatterns: ["canary-value"] });
  expect(policy.screen(row)).toMatchObject({ ok: false, rule: "configured standalone policy: personal data, configured pattern, or deny path" });
});

test("unreadable configured policy never degrades to an empty inspection", () => {
  const home = temp();
  writeFileSync(join(home, "amem.config.json"), "{bad json");
  expect(() => createMemorySyncPolicy({ home })).toThrow();
});
