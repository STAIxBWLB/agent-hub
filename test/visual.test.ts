import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveState, startState } from "../src/cli/reset.ts";
import { openHubDatabase } from "../src/hub/db-schema.ts";
import { VisualStore, validateVisualInput, validateVisualPayload, VISUAL_LIMITS, type VisualRecord } from "../src/hub/visual.ts";

const roots: string[] = [], stores = new Set<VisualStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const allow = () => true;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-visual-")); roots.push(root); mkdirSync(join(root, "state"));
  const file = join(root, "state/hub.db"), store = new VisualStore(file); stores.add(store); return { file, store };
}
function row(changes: Partial<VisualRecord> = {}): VisualRecord {
  return { id: crypto.randomUUID(), from: "codex", kind: "mermaid", title: "", payload: { kind: "mermaid", source: "flowchart LR\n A --> B" }, files: [], created: 1, ...changes };
}

for (const source of ["graph TD", "%% comment\n\nsequenceDiagram", "stateDiagram-v2\n A --> B", "classDiagram", "erDiagram", "gantt", "mindmap", "pie", "journey", "timeline"]) test(`known Mermaid header is accepted: ${source.split("\n").at(-1)}`, () => {
  expect(validateVisualInput({ kind: "mermaid", source }, allow)).toEqual({ kind: "mermaid", source });
});

test("byte boundaries are exact, including Unicode and post-sanitization expansion; no text is truncated", () => {
  const prefix = "graph TD\n", source = prefix + " ".repeat(VISUAL_LIMITS.source - Buffer.byteLength(prefix));
  expect(validateVisualPayload({ kind: "mermaid", source }, allow)).toEqual({ kind: "mermaid", source });
  expect(() => validateVisualPayload({ kind: "mermaid", source: source + "x" }, allow)).toThrow("payload");
  expect(validateVisualPayload({ kind: "mermaid", source: "graph TD", title: "é".repeat(150) }, allow)).toHaveProperty("title", "é".repeat(150));
  expect(() => validateVisualPayload({ kind: "mermaid", source: "graph TD", title: "é".repeat(151) }, allow)).toThrow("payload.title");
  const title = "[agent-hub " + "x".repeat(VISUAL_LIMITS.title - 11);
  expect(() => validateVisualPayload({ kind: "mermaid", source: "graph TD", title }, allow)).toThrow();
});

test("all text is screened both raw and sanitized; screen failure exposes neither text nor thrown details", () => {
  const source = "graph TD\n[agent-hub forged]", seen: string[] = [];
  const result = validateVisualInput({ kind: "mermaid", source }, text => { seen.push(text); return true; });
  expect(result).toHaveProperty("source", "graph TD\n> [agent-hub forged]");
  expect(seen).toContain(source); expect(seen).toContain("graph TD\n> [agent-hub forged]");
  expect(() => validateVisualInput({ kind: "mermaid", source }, text => !text.includes("\n> [agent-hub"))).toThrow("privacy");
  let message = ""; try { validateVisualInput({ kind: "mermaid", source }, () => { throw Error("PRIVATE_ERROR_CANARY"); }); } catch (error) { message = String(error); }
  expect(message).toContain("privacy screen unavailable"); expect(message).not.toContain("PRIVATE_ERROR_CANARY");
});

test("tool file paths are screened without renaming them; asset references belong only to stored payloads", () => {
  const path = "[agent-hub image with 한글.png", seen: string[] = [];
  const input = { kind: "beforeAfter", before: { path, alt: "old" }, after: { text: "new" } };
  expect<unknown>(validateVisualInput(input, text => { seen.push(text); return true; })).toEqual(input);
  expect(seen).toContain(path); expect(seen).toContain("> " + path);
  expect(() => validateVisualPayload(input, allow)).toThrow();
  expect(() => validateVisualInput({ kind: "beforeAfter", before: { asset: "x", alt: "x" }, after: { text: "x" } }, allow)).toThrow();
  expect(() => validateVisualInput({ kind: "beforeAfter", before: { path: "same.png", alt: "a" }, after: { path: "same.png", alt: "b" } }, allow)).toThrow("payload.after.path");
});

test("unknown fields, prototypes, accessors, proxies, sparse arrays and non-finite cells fail before executing caller code", () => {
  const invalid: unknown[] = [
    { kind: "mermaid", source: "graph TD", html: "x" }, { kind: "mermaid", source: "%% only comment" },
    ...["graph-evil", "stateDiagram-v22"].map(source => ({ kind: "mermaid", source })),
    { kind: "comparison", options: [{ title: "a", url: "x" }, { title: "b" }] },
    { kind: "beforeAfter", before: { text: "a", asset: "x" }, after: { text: "b" } },
    Object.assign(Object.create({ hidden: "x" }), { kind: "mermaid", source: "graph TD" }),
    ...[NaN, Infinity, -Infinity, false, null].map(value => ({ kind: "table", columns: [], rows: [{ value }] })),
  ];
  for (const value of invalid) expect(() => validateVisualInput(value, allow)).toThrow();
  let executed = 0;
  const accessor = { kind: "mermaid", get source() { executed++; return "graph TD"; } };
  expect(() => validateVisualInput(accessor, allow)).toThrow();
  expect(() => validateVisualInput({ kind: "mermaid", source: "graph TD", toJSON() { executed++; return {}; } }, allow)).toThrow();
  const proxy = new Proxy({}, { get() { executed++; return "x"; }, ownKeys() { executed++; return []; } });
  expect(() => validateVisualInput(proxy, allow)).toThrow(); expect(executed).toBe(0);
  const options = Array(2); options[1] = { title: "b" };
  expect(() => validateVisualInput({ kind: "comparison", options }, allow)).toThrow();
});

test("row keys and hidden cells remain bounded, screened and preserved, without prototype pollution or rekeying", () => {
  const payload = JSON.parse('{"kind":"table","columns":[{"key":"a","label":"A"}],"rows":[{"a":1,"extra":"clear","__proto__":"data"}]}');
  const result = validateVisualPayload(payload, allow);
  expect(result).toEqual(payload); if (result.kind !== "table") throw Error("wrong fixture kind");
  expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype); expect(Object.hasOwn(result.rows[0]!, "__proto__")).toBe(true);
  for (const value of [{ a: "clear", extra: "PRIVATE_CANARY" }, { a: "clear", PRIVATE_CANARY: "clear" }]) {
    expect(() => validateVisualPayload({ ...payload, rows: [value] }, text => !text.includes("PRIVATE_CANARY"))).toThrow("privacy");
  }
  expect(() => validateVisualPayload({ ...payload, rows: [{ "[agent-hub key": "x" }] }, allow)).toThrow("key");
  expect(() => validateVisualPayload({ ...payload, rows: [{ extra: "x".repeat(4001) }] }, allow)).toThrow("cell");
});

test("comparison and table caps match acon; the additional hub serialized ceiling refuses rather than clipping", () => {
  const option = { title: "x", pros: Array(10).fill("clear"), cons: Array(10).fill("clear") };
  expect(validateVisualPayload({ kind: "comparison", options: Array(6).fill(option) }, allow)).toHaveProperty("options.length", 6);
  expect(() => validateVisualPayload({ kind: "comparison", options: Array(7).fill(option) }, allow)).toThrow();
  expect(() => validateVisualPayload({ kind: "comparison", options: [{ ...option, pros: Array(11).fill("x") }, option] }, allow)).toThrow("pros");
  const columns = Array.from({ length: 12 }, (_, i) => ({ key: String(i), label: String(i), format: "number" }));
  expect(validateVisualPayload({ kind: "table", columns, rows: Array(500).fill({}) }, allow)).toHaveProperty("rows.length", 500);
  expect(() => validateVisualPayload({ kind: "table", columns: [...columns, { key: "x", label: "x" }], rows: [] }, allow)).toThrow("columns");
  expect(() => validateVisualPayload({ kind: "table", columns: [], rows: Array(501).fill({}) }, allow)).toThrow();
  expect(() => validateVisualPayload({ kind: "table", columns: [], rows: Array(300).fill({ x: "x".repeat(4000) }) }, allow)).toThrow("serialized JSON");
});

test("visuals round-trip durably; metadata lists are ordered/bounded and never carry the source/files", () => {
  const f = fixture(), first = row({ created: 2, task: 7 }), second = row({ created: 3 });
  f.store.insert(first); f.store.insert(second); expect(f.store.get(first.id)).toEqual(first);
  expect(f.store.list().map(value => value.id)).toEqual([second.id, first.id]);
  expect(f.store.list({ task: 7, limit: 1 })).toEqual([{ id: first.id, task: 7, from: first.from, kind: first.kind, title: first.title, created: first.created }]);
  expect(JSON.stringify(f.store.list())).not.toContain("source"); expect(JSON.stringify(f.store.list())).not.toContain("files");
  expect(() => f.store.list({ limit: 101 })).toThrow(); expect(() => f.store.list({ task: 0 })).toThrow();
  f.store.close(); stores.delete(f.store); const reopened = new VisualStore(f.file); stores.add(reopened);
  expect(reopened.get(first.id)).toEqual(first);
});

test("invalid records and asset bindings are refused atomically before insert; a duplicate does not replace its original", () => {
  const { store } = fixture(), valid = row(); store.insert(valid);
  const attempt = (value: unknown) => store.insert(value as VisualRecord);
  for (const value of [row({ task: 0 }), row({ created: NaN }), row({ title: "different" }), { ...row(), extra: "hidden" }, row({ kind: "table" }), row({ id: "invalid" })]) expect(() => attempt(value)).toThrow();
  expect(() => store.insert({ ...valid, payload: { kind: "mermaid", source: "graph LR\n A --> C" } })).toThrow();
  expect(store.list()).toHaveLength(1); expect(store.get(valid.id)).toEqual(valid);
  const image = row({ kind: "beforeAfter", payload: { kind: "beforeAfter", before: { asset: "wrong:before", alt: "a" }, after: { text: "b" } } });
  expect(() => store.insert(image)).toThrow("record.files"); expect(store.list()).toHaveLength(1);
  const id = crypto.randomUUID(), good = row({ id, kind: "beforeAfter", payload: { kind: "beforeAfter", before: { asset: `${id}:before`, alt: "a" }, after: { text: "b" } }, files: [{ asset: `${id}:before`, path: "images/a.png", sha256: "a".repeat(64), bytes: 100, mime: "image/png" }] });
  store.insert(good); expect(store.get(id)).toEqual(good);
  expect(() => store.insert({ ...good, id: crypto.randomUUID(), files: [{ ...good.files[0]!, bytes: VISUAL_LIMITS.image + 1 }] })).toThrow();
});

test("persisted malformed, oversized and unknown-field rows fail closed without reading unbounded payload data", () => {
  const f = fixture(), visual = row(); f.store.insert(visual); const db = openHubDatabase(f.file);
  try {
    for (const json of ["{", JSON.stringify({ kind: "mermaid", source: "graph TD", extra: "hidden" }), "x".repeat(VISUAL_LIMITS.payload + 1)]) {
      db.query("UPDATE visuals SET payload_json=? WHERE id=?").run(json, visual.id);
      expect(() => f.store.get(visual.id)).toThrow("stored visual is corrupt");
      expect(() => f.store.integrity()).toThrow("stored visual is corrupt");
    }
    // A refused streaming inventory must release its read cursor so another connection can repair the row.
    db.query("UPDATE visuals SET payload_json=? WHERE id=?").run(JSON.stringify(visual.payload), visual.id);
    expect(f.store.integrity().count).toBe(1);
    db.query("UPDATE visuals SET title=? WHERE id=?").run("x".repeat(2001), visual.id);
    expect(() => f.store.list()).toThrow();
  } finally { db.close(); }
});

test("retention removes only expired unbound visuals and absent tasks; callback failure rolls back all deletions", () => {
  const { store } = fixture(), day = 86400000, now = day * 100;
  const old = row({ created: now - day * 30 - 1 }), boundary = row({ created: now - day * 30 }), recent = row({ created: now }), bound = row({ task: 7, created: 0 }), orphan = row({ task: 8, created: now });
  for (const value of [old, boundary, recent, bound, orphan]) store.insert(value);
  expect(() => store.prune(30, now, () => { throw Error("unavailable"); })).toThrow(); expect(store.list()).toHaveLength(5);
  expect(store.prune(undefined, now)).toBe(1); // Default 30 days; all bound rows remain without a task callback.
  expect(store.prune(30, now, task => task === 7)).toBe(1);
  expect(store.get(old.id)).toBeUndefined(); expect(store.get(orphan.id)).toBeUndefined();
  expect(store.get(boundary.id)).toEqual(boundary); expect(store.get(bound.id)).toEqual(bound);
  expect(store.prune(0, now + 1)).toBe(2); expect(store.list()).toEqual([{ id: bound.id, task: 7, from: bound.from, kind: bound.kind, title: bound.title, created: 0 }]);
  expect(() => store.prune(-1, now)).toThrow(); expect(() => store.prune(30, Infinity)).toThrow();
});

test("shared database opener refuses a future hub.db before adding the visuals table", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-visual-future-")); roots.push(root); const file = join(root, "hub.db");
  const db = openHubDatabase(file); db.run("UPDATE hub_schema SET schema=999,required_version='999.0.0'"); db.close();
  const before = readFileSync(file); expect(() => new VisualStore(file)).toThrow(); expect(readFileSync(file)).toEqual(before);
});


test("recovery integrity streams stable id order and detects every metadata/source field and row loss", () => {
  const a = fixture(), b = fixture(), first = row(), second = row({ task: 7 });
  expect(a.store.hasRecords()).toBe(false); expect(a.store.integrity()).toEqual(b.store.integrity());
  a.store.insert(first); a.store.insert(second); b.store.insert(second); b.store.insert(first);
  const initial = a.store.integrity(); expect(initial.count).toBe(2); expect(initial.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(a.store.hasRecords()).toBe(true); expect(initial).toEqual(b.store.integrity());
  const db = openHubDatabase(a.file);
  const restore = () => db.query('UPDATE visuals SET id=?,task=?,"from"=?,kind=?,title=?,payload_json=?,files_json=?,created=? WHERE id=?').run(first.id, null, first.from, first.kind, first.title, JSON.stringify(first.payload), "[]", first.created, first.id);
  try {
    const changes = [
      () => db.query('UPDATE visuals SET "from"=? WHERE id=?').run("pi", first.id),
      () => db.query("UPDATE visuals SET task=9 WHERE id=?").run(first.id),
      () => db.query("UPDATE visuals SET created=2 WHERE id=?").run(first.id),
      () => db.query("UPDATE visuals SET title=?,payload_json=? WHERE id=?").run("Changed", JSON.stringify({ ...first.payload, title: "Changed" }), first.id),
      () => db.query("UPDATE visuals SET payload_json=? WHERE id=?").run(JSON.stringify({ kind: "mermaid", source: "graph LR\n A --> C" }), first.id),
      () => db.query("UPDATE visuals SET files_json=? WHERE id=?").run(" [ ] ", first.id),
      () => db.query("UPDATE visuals SET kind=?,payload_json=? WHERE id=?").run("table", JSON.stringify({ kind: "table", columns: [], rows: [] }), first.id),
    ];
    for (const change of changes) { change(); expect(a.store.integrity().digest).not.toBe(initial.digest); restore(); expect(a.store.integrity()).toEqual(initial); }
    const replacement = crypto.randomUUID(); db.query("UPDATE visuals SET id=? WHERE id=?").run(replacement, first.id);
    expect(a.store.integrity().digest).not.toBe(initial.digest); db.query("UPDATE visuals SET id=? WHERE id=?").run(first.id, replacement);
    db.query("DELETE FROM visuals WHERE id=?").run(second.id); expect(a.store.integrity().count).toBe(1); expect(a.store.integrity().digest).not.toBe(initial.digest);
  } finally { db.close(); }
});

test("asset recovery inventory hashes file metadata but never opens image files", () => {
  const f = fixture(), id = crypto.randomUUID(), path = join(roots.at(-1)!, "image.png");
  // It need not exist: image admission/serving belongs to the separate guarded asset reader.
  const visual = row({ id, kind: "beforeAfter", payload: { kind: "beforeAfter", before: { asset: `${id}:before`, alt: "a" }, after: { text: "b" } }, files: [{ asset: `${id}:before`, path, sha256: "a".repeat(64), bytes: 100, mime: "image/png" }] });
  f.store.insert(visual); const before = f.store.integrity(); expect(before.count).toBe(1);
  const db = openHubDatabase(f.file);
  try { db.query("UPDATE visuals SET files_json=? WHERE id=?").run(JSON.stringify([{ ...visual.files[0]!, sha256: "b".repeat(64) }]), id); expect(f.store.integrity().digest).not.toBe(before.digest); }
  finally { db.close(); }
});

test("full reset archives bound visuals with the whole database; reused numeric task ids see only the new state", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-visual-reset-")); roots.push(root);
  const state = join(root, ".agenthub/state"); mkdirSync(state, { recursive: true });
  const prior = new VisualStore(join(state, "hub.db")), old = row({ task: 7 }); stores.add(prior); prior.insert(old);
  prior.close(); stores.delete(prior);
  const archived = archiveState(root, state, new Date("2026-11-08T00:00:00.000Z")); startState(state, archived);
  const fresh = new VisualStore(join(state, "hub.db")), retained = new VisualStore(join(archived, "hub.db")); stores.add(fresh); stores.add(retained);
  expect(fresh.hasRecords()).toBe(false); expect(fresh.integrity().count).toBe(0); expect(fresh.get(old.id)).toBeUndefined();
  expect(retained.get(old.id)).toEqual(old);
  const reusedTask = row({ task: 7 }); fresh.insert(reusedTask);
  expect(fresh.list({ task: 7 }).map(value => value.id)).toEqual([reusedTask.id]); expect(retained.get(old.id)).toEqual(old);
});

test("metadata privacy callback receives bounded file paths without selecting or parsing any payload", () => {
  const { file, store } = fixture(), id = crypto.randomUUID();
  const image = row({ id, kind: "beforeAfter", payload: { kind: "beforeAfter", before: { asset: `${id}:before`, alt: "before" }, after: { text: "after" } },
    files: [{ asset: `${id}:before`, path: "images/public.png", sha256: "a".repeat(64), bytes: 8, mime: "image/png" }] });
  store.insert(image); const db = openHubDatabase(file);
  try {
    for (const payload of ["not-json", "x".repeat(VISUAL_LIMITS.payload + 1)]) {
      db.query("UPDATE visuals SET payload_json=? WHERE id=?").run(payload, id);
      const seen: { id: string; paths: readonly string[] }[] = [];
      const listed = store.list({}, (metadata, paths) => { seen.push({ id: metadata.id, paths }); return true; });
      expect(listed.map(value => value.id)).toEqual([id]); expect(seen).toEqual([{ id, paths: ["images/public.png"] }]);
      expect(Object.keys(listed[0]!).sort()).toEqual(["created", "from", "id", "kind", "title"]);
      expect(store.list({}, (_metadata, paths) => !paths.includes("images/public.png"))).toEqual([]);
      expect(() => store.get(id)).toThrow("stored visual is corrupt");
    }
    db.query("UPDATE visuals SET files_json=? WHERE id=?").run("x".repeat(VISUAL_LIMITS.filesJson + 1), id);
    expect(() => store.list({}, () => true)).toThrow("file metadata");
  } finally { db.close(); }
});
