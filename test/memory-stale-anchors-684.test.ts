import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { MemoryStore, memoryProjectKey, migrateShards, shardDir, taskKey, type View } from "@staix/agent-mem";
import { memoryStaleAnchorsCommand } from "../src/cli/memory.ts";
import { HELP } from "../src/cli/help.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { Board } from "../src/hub/board.ts";
import type { CodeFactResult } from "../src/hub/code-facts.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { formatMemoryStaleAnchors, memoryStaleAnchors, MEMORY_STALE_SCAN_LIMIT, unavailableMemoryStaleAnchors, type MemoryStaleAnchorOptions } from "../src/hub/memory-stale-anchors.ts";
import { MEMORY_SYMBOL_LIMIT } from "../src/hub/memory-symbols.ts";

const HEAD = "a".repeat(40), cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function temp() { const root = mkdtempSync(join(tmpdir(), "ahub684-stale-")); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
function note(index: number, about: string[], extra: Partial<View> = {}): View {
  return { id: index.toString(16).padStart(32, "0"), at: "2026-10-24T00:00:00.000Z", machine: "fixture", project: "fixture", scope: "project", tier: "long", kind: "finding", peer: "person", title: null, text: "public note", task: null, about, source: "person", supersededBy: null, supersedes: [], promotedFrom: null, expiresAt: null, local: false, ...extra };
}
const absent = async (): Promise<CodeFactResult<{ exists: boolean; ambiguous: boolean }>> => ({ state: "known", value: { exists: false, ambiguous: false } });
function setup(notes: View[]) {
  const pages: Array<{ project: string; limit: number }> = [], calls: string[] = []; let deferred = false;
  const store: MemoryStaleAnchorOptions["store"] = {
    withDeferredPromotions<T>(run: () => T): T { deferred = true; try { return run(); } finally { deferred = false; } },
    readPage(window) {
      expect(deferred).toBe(true); pages.push(window);
      const start = window.after?.position ?? 0, rows = notes.slice(start, start + window.limit), end = start + rows.length;
      return { rows, ...(end < notes.length ? { next: { position: end, id: rows.at(-1)!.id, at: rows.at(-1)!.at } } : {}) };
    },
  };
  let allowed = (value: string) => !value.includes("PRIVATE_MARKER"), deny: string[] = [], project = "fixture", cwd = "/fixture", repo = "owner/repo", head: string | undefined = HEAD;
  const options: MemoryStaleAnchorOptions = { cwd, project, store, now: () => 0,
    publicMetadataText: text => allowed(text), context: () => ({ cwd, project, repo, deny, allowed: text => allowed(text) }),
    head: () => head, exists: async (_repo, _head, name) => { calls.push(name); return absent(); },
  };
  return { options, pages, calls, allowed(value: typeof allowed) { allowed = value; }, deny(value: string[]) { deny = value; }, project(value: string) { project = value; }, cwd(value: string) { cwd = value; }, repo(value: string) { repo = value; }, head(value: string | undefined) { head = value; } };
}

test("#684 only known unambiguous absence at the pinned current HEAD is stale", async () => {
  const r = setup([note(1, ["symbol:A.run@src/a.ts"]), note(2, ["symbol:B.run@src/b.ts"]), note(3, ["symbol:C.run@src/c.ts"]), note(4, ["symbol:D.run@src/d.ts"]), note(5, ["symbol:E.run@src/e.ts"])]);
  r.options.exists = async (repo, head, name) => {
    expect(repo).toBe("/fixture"); expect(head).toBe(HEAD);
    if (name === "A.run") return absent();
    if (name === "B.run") return { state: "known", value: { exists: true, ambiguous: false } };
    if (name === "C.run") return { state: "known", value: { exists: false, ambiguous: true } };
    if (name === "D.run") return { state: "known", value: {} } as unknown as CodeFactResult<{ exists: boolean; ambiguous: boolean }>;
    return { state: "unknown" };
  };
  const report = await memoryStaleAnchors(r.options);
  expect(report).toMatchObject({ head: HEAD, stale: 1, unknown: 4, queried: 5 });
  expect(report.rows.map(row => row.reason)).toEqual(["absent", "present-path-unverified", "ambiguous", "unavailable", "unavailable"]);
});

test("#684 private, denied, noncanonical and foreign evidence never reaches code facts or echoes withheld anchors", async () => {
  const r = setup([note(1, ["symbol:A.run@src/a.ts"], { text: "PRIVATE_MARKER" }), note(2, ["symbol:PRIVATE_MARKER@src/private.ts"]), note(3, ["symbol:C.run@denied/a.ts"]), note(4, ["symbol:run"]), note(5, ["symbol:E.run@src/e.ts"], { project: "other-project" })]);
  r.deny(["denied/**"]);
  const report = await memoryStaleAnchors(r.options);
  expect(report).toMatchObject({ stale: 0, unknown: 5, queried: 0 }); expect(r.calls).toEqual([]);
  expect(JSON.stringify(report)).not.toContain("PRIVATE_MARKER"); expect(JSON.stringify(report)).not.toContain("denied/a.ts");
});

test("#684 reset-safe own task proof permits only its redundant legacy about node", async () => {
  const own = "fixture#3@100", calls: string[] = [];
  const r = setup([note(1, ["task:fixture#3", `task:${own}`, "symbol:A.run@src/a.ts"], { task: own })]);
  r.options.taskPrivacy = key => { calls.push(key); return "public"; };
  expect(await memoryStaleAnchors(r.options)).toMatchObject({ stale: 1, unknown: 0, queried: 1 });
  expect(calls.every(key => key === own)).toBe(true);
  for (const links of [["task:fixture#9"], ["task:fixture#3"], ["task:other#3@100"]]) {
    const legacy = setup([note(1, [...links, "symbol:A.run@src/a.ts"])]); legacy.options.taskPrivacy = () => "public";
    expect(await memoryStaleAnchors(legacy.options)).toMatchObject({ stale: 0, queried: 0, unknown: 1 });
  }
});

test("#684 structural task numbers retain existing PII screening parity without stripping arbitrary symbol digits", async () => {
  const r = setup([note(1, ["task:fixture#3", "task:fixture#3@123456789", "symbol:A.run@src/a.ts"], { task: "fixture#3@123456789" })]);
  r.allowed(text => !/[0-9]{6}/.test(text)); r.options.taskPrivacy = () => "public";
  expect(await memoryStaleAnchors(r.options)).toMatchObject({ stale: 1, queried: 1 });
  const text = setup([note(1, ["symbol:A.run@src/a.ts"], { text: "123456789" })]); text.allowed(value => !/[0-9]{6}/.test(value));
  expect(await memoryStaleAnchors(text.options)).toMatchObject({ queried: 0, stale: 0 });
  const symbol = setup([note(1, ["symbol:A.run123456789@src/a.ts"])]); symbol.allowed(value => !/[0-9]{6}/.test(value));
  expect(await memoryStaleAnchors(symbol.options)).toMatchObject({ queried: 0, stale: 0 });
});

test("#684 current task privacy is required before query and refreshed after awaited facts", async () => {
  for (const initial of ["private", "unknown"] as const) {
    const r = setup([note(1, ["symbol:A.run@src/a.ts"], { task: "fixture#3@100" })]); r.options.taskPrivacy = () => initial;
    const report = await memoryStaleAnchors(r.options); expect(report.queried).toBe(0); expect(report.stale).toBe(0); expect(JSON.stringify(report)).not.toContain("A.run");
  }
  const r = setup([note(1, ["symbol:A.run@src/a.ts"], { task: "fixture#3@100" })]); let state: "public" | "private" = "public";
  r.options.taskPrivacy = () => state; r.options.exists = async () => { state = "private"; return absent(); };
  const report = await memoryStaleAnchors(r.options); expect(report.queried).toBe(1); expect(report.stale).toBe(0); expect(JSON.stringify(report)).not.toContain("A.run");
});

test("#684 final projection withholds an earlier stale anchor after a later await changes deny policy", async () => {
  const r = setup([note(1, ["symbol:A.run@src/a.ts"]), note(2, ["symbol:B.run@src/b.ts"])]);
  r.options.exists = async (_repo, _head, name) => { if (name === "B.run") r.deny(["src/a.ts"]); return absent(); };
  const report = await memoryStaleAnchors(r.options);
  expect(report).toMatchObject({ queried: 2, stale: 1, unknown: 1 }); expect(report.rows[0]?.anchor).toBeUndefined(); expect(JSON.stringify(report)).not.toContain("src/a.ts");
});
test("#684 final privacy projection follows owned query teardown", async () => {
  const r = setup([note(1, ["symbol:A.run@src/a.ts"])]);
  r.options.finishQueries = async () => { r.allowed(() => false); };
  const report = await memoryStaleAnchors(r.options);
  expect(report.queried).toBe(1); expect(report.stale).toBe(0); expect(report.unknown).toBe(1); expect(JSON.stringify(report)).not.toContain("A.run");
});

for (const field of ["cwd", "project", "repo"] as const) test(`#684 ${field} identity drift after facts cannot produce stale or echo anchors`, async () => {
  const r = setup([note(1, ["symbol:A.run@src/a.ts"])]);
  r.options.exists = async () => { r[field]("changed"); return absent(); };
  const report = await memoryStaleAnchors(r.options); expect(report.stale).toBe(0); expect(report.unknown).toBe(1); expect(JSON.stringify(report)).not.toContain("A.run");
});

test("#684 HEAD drift and missing code facts stay unknown", async () => {
  const r = setup([note(1, ["symbol:A.run@src/a.ts"])]); r.options.exists = async () => { r.head("b".repeat(40)); return absent(); };
  expect(await memoryStaleAnchors(r.options)).toMatchObject({ stale: 0, unknown: 1 });
  const noHead = setup([note(1, ["symbol:A.run@src/a.ts"])]); noHead.head(undefined);
  expect(await memoryStaleAnchors(noHead.options)).toMatchObject({ queried: 0, stale: 0, unknown: 1 });
});

test("#684 note inventory and code-facts starts have explicit bounds, including one unseen extra row", async () => {
  const r = setup(Array.from({ length: MEMORY_STALE_SCAN_LIMIT + 1 }, (_, index) => note(index + 1, index === MEMORY_STALE_SCAN_LIMIT ? ["symbol:Extra.run@src/a.ts"] : [])));
  const report = await memoryStaleAnchors(r.options);
  expect(report).toMatchObject({ scanned: MEMORY_STALE_SCAN_LIMIT, queried: 0, truncated: true, state: "unknown" });
  expect(r.pages.map(page => page.limit)).toEqual([64, 64, 64, 64, 1]);
  const many = setup(Array.from({ length: MEMORY_SYMBOL_LIMIT + 1 }, (_, index) => note(index + 1, [`symbol:S${index}.run@src/a.ts`])));
  expect(await memoryStaleAnchors(many.options)).toMatchObject({ queried: MEMORY_SYMBOL_LIMIT, truncated: true });
  const timed = setup([note(1, ["symbol:A.run@src/a.ts"]), note(2, ["symbol:B.run@src/b.ts"])]); let clock = 0;
  timed.options.now = () => clock; timed.options.exists = async () => { clock = 3000; return absent(); };
  expect(await memoryStaleAnchors(timed.options)).toMatchObject({ queried: 1, truncated: true, unknown: 1 });
});

function gitProject() { const cwd = temp(); expect(hubGitSync(["-C", cwd, "init", "-q"], { encoding: "utf8" }).status).toBe(0); return cwd; }
function logs(store: MemoryStore): string[] { return ["log", "local"].flatMap(folder => readdirSync(join(store.dir, folder)).sort().map(name => readFileSync(join(store.dir, folder, name), "utf8"))); }
test("#684 existing injected-store inspection defers promotions and preserves log and candidate bytes", async () => {
  const cwd = gitProject(), home = temp(), store = new MemoryStore({ home, screen: () => "promote" }); cleanup.push(() => store.close());
  const project = memoryProjectKey(cwd), key = taskKey(project, { id: 3, created: 100 });
  const id = store.note({ op: "note", project, scope: "project", tier: "short", kind: "decision", peer: "person", source: "person", text: "public retained memory", task: key, about: ["symbol:A.run@src/a.ts", `task:${project}#3`, `task:${key}`] });
  store.withDeferredPromotions(() => store.settle(key, "person"));
  const candidate = join(store.dir, "candidates.db"); writeFileSync(candidate, "private candidate sentinel"); const before = logs(store), bytes = readFileSync(candidate);
  const report = await memoryStaleAnchorsCommand(cwd, { store, facts: { exists: absent }, head: () => HEAD, taskPrivacy: () => "public", now: () => 0 });
  expect(report).toMatchObject({ stale: 1, unknown: 0 }); expect(report.rows[0]?.id).toBe(id);
  expect(logs(store)).toEqual(before); expect(readFileSync(candidate)).toEqual(bytes);
});

test("#684 current read-only board PII and reset identity prevent inspection despite public historical note text", async () => {
  const cwd = gitProject(), home = temp(), stateDir = temp(), board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const store = new MemoryStore({ home }); cleanup.push(() => store.close()); const project = memoryProjectKey(cwd);
  const task = board.propose("user", { title: "public historical work", class: "implement", signals: ["pii"] });
  const memory = store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "public historical note", task: taskKey(project, task), about: ["symbol:A.run@src/a.ts"] });
  let calls = 0; const opts = { store, stateDir, facts: { exists: async () => { calls++; return absent(); } }, head: () => HEAD, now: () => 0 };
  const report = await memoryStaleAnchorsCommand(cwd, opts); expect(report.stale).toBe(0); expect(report.queried).toBe(0); expect(calls).toBe(0); expect(JSON.stringify(report)).not.toContain("A.run");
  store.forget(memory, "person", project); board.update(task.id, "user", "fixture now public", { signals: [] });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "old reset identity", task: taskKey(project, { id: task.id, created: task.created + 1 }), about: ["symbol:Reset.run@src/reset.ts"] });
  const reset = await memoryStaleAnchorsCommand(cwd, opts); expect(reset.queried).toBe(0); expect(calls).toBe(0); expect(JSON.stringify(reset)).not.toContain("Reset.run");
  const unknown = await memoryStaleAnchorsCommand(cwd, { ...opts, stateDir: join(stateDir, "missing") }); expect(unknown.queried).toBe(0); expect(calls).toBe(0);
});

test("#684 a task scoped to another repository cannot make its historical anchor stale against this project", async () => {
  const cwd = gitProject(), home = temp(), stateDir = temp(), board = new Board(join(stateDir, "hub.db")); cleanup.push(() => board.close());
  const store = new MemoryStore({ home }); cleanup.push(() => store.close()); const project = memoryProjectKey(cwd);
  const task = board.propose("user", { title: "public sibling task", class: "implement", refs: { repo: "owner/another-project", paths: ["src/public.ts"] } });
  store.note({ op: "note", project, scope: "project", tier: "long", kind: "finding", peer: "person", source: "person", text: "public old sibling note", task: taskKey(project, task), about: ["symbol:Sibling.run@src/public.ts"] });
  let calls = 0;
  const report = await memoryStaleAnchorsCommand(cwd, { store, stateDir, facts: { exists: async () => { calls++; return absent(); } }, head: () => HEAD, now: () => 0 });
  expect(report).toMatchObject({ queried: 0, stale: 0, unknown: 1 }); expect(calls).toBe(0); expect(JSON.stringify(report)).not.toContain("Sibling.run");
});

test("#684 doctor never bootstraps absent memory or a missing project shard", async () => {
  const cwd = gitProject(), root = temp(), missing = join(root, "uninitialized"), prior = process.env.AMEM_HOME; let calls = 0;
  const opts = { facts: { exists: async () => { calls++; return absent(); } }, head: () => HEAD, now: () => 0 };
  try {
    process.env.AMEM_HOME = missing;
    expect(await memoryStaleAnchorsCommand(cwd, opts)).toMatchObject({ state: "unknown", unknown: null, queried: 0 }); expect(existsSync(missing)).toBe(false);
    const legacy = new MemoryStore({ home: root }); const memory = legacy.dir; legacy.close();
    await migrateShards({ memoryDir: memory, generation: "1".repeat(32), mode: "apply", authorizedPerson: true, tty: true }); process.env.AMEM_HOME = memory;
    const project = memoryProjectKey(cwd), shard = shardDir(memory, project); expect(existsSync(shard)).toBe(false);
    const before = readFileSync(join(memory, "machine.json")); expect(await memoryStaleAnchorsCommand(cwd, opts)).toMatchObject({ state: "unknown", queried: 0 });
    expect(existsSync(shard)).toBe(false); expect(readFileSync(join(memory, "machine.json"))).toEqual(before); expect(calls).toBe(0);
  } finally { if (prior === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = prior; }
});

test("#684 doctor flag dispatches the host report only and preserves console identity and default behavior", async () => {
  const source = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8"), marker = "doctor: async () => {", start = source.indexOf(marker) + marker.length, end = source.indexOf('    if (args.includes("--orphans"))', start);
  expect(start).toBeGreaterThan(marker.length); expect(end).toBeGreaterThan(start);
  async function run(args: string[]) {
    const seen: unknown[] = [], out: string[] = [];
    const result = await runInNewContext(`(async()=>{${source.slice(start, end)};return "default";})()`, { args, cwd: "/fixture", stateDir: "/state", outputOptions: () => ({ json: args.includes("--json") }), fail: (message: string) => { throw new Error(message); }, console: { log: (line: string) => out.push(line) }, memoryStaleAnchorsCommand: async (...args: unknown[]) => { seen.push(args); return unavailableMemoryStaleAnchors(); }, formatMemoryStaleAnchors });
    return { result, seen, out };
  }
  const report = await run(["--stale-anchors", "--json"]); expect(report.seen).toEqual([["/fixture", { stateDir: "/state" }]]); expect(JSON.parse(report.out[0]!).state).toBe("unknown");
  expect((await run([])).result).toBe("default"); expect((await run([])).seen).toEqual([]);
  await expect(run(["--stale-anchors", "--orphans"])).rejects.toThrow("doctor --stale-anchors [--json]");
  expect(classifyPeerCommand("doctor", ["--stale-anchors"])).toBe("console"); expect(classifyPeerCommand("doctor", [])).toBe("console");
  expect(HELP.some(entry => entry.usage === "ahub doctor --stale-anchors [--json]")).toBe(true);
});
