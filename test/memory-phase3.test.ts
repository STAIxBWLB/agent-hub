import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Briefs } from "../src/memory/brief.ts";
import { importClaudeMem } from "../src/memory/import.ts";
import { MemoryStore, type NoteInput } from "../src/memory/store.ts";
import { memoryMode } from "../src/hub/bench.ts";
import { researchReport, formatResearch, taskRecords } from "../src/hub/research.ts";
import type { StampedEvent } from "../src/hub/events.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

// #258 phase 3: claude-mem import, model-suggested edges kept out of evidence, and the measurement inputs.

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-mem3-${name}-`))); dirs.push(d); return d; };
const open = () => { const s = new MemoryStore({ home: temp("home") }); cleanup.push(() => s.close()); return s; };
const note = (text: string, over: Partial<NoteInput> = {}): NoteInput => ({ op: "note", project: "work/app", scope: "project", tier: "long", kind: "decision", peer: "codex", text, about: [], source: "hub", ...over });

test("claude-mem import copies the hub's notes of this project once, never model answers, PII or secrets, and never writes claude-mem", () => {
  const file = join(temp("cm"), "claude-mem.db");
  const db = new Database(file);
  db.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, text TEXT, narrative TEXT, created_at_epoch INTEGER, metadata TEXT)");
  const add = (project: string, title: string, text: string, metadata: unknown) => db.query("INSERT INTO observations (project, title, text, narrative, created_at_epoch, metadata) VALUES (?, ?, ?, NULL, ?, ?)").run(project, title, text, 1_790_000_000_000, metadata === null ? null : JSON.stringify(metadata));
  add("app", "agent-hub task #3: parser", "regex split fails on quotes", { peer: "codex", task: 3, kind: "fail" });
  add("app", "a decision", "the parser owns quoting", { peer: "claude", kind: "decision" });
  add("app", "ahub ask (model answer): why", "A: because", { peer: "hub", kind: "finding", source: "ahub ask" });
  add("app", "call", "phone 900101-1234567 back", { peer: "codex", kind: "finding" });
  add("app", "creds", "token: abcdefgh12345678", { peer: "codex", kind: "finding" });
  add("other", "elsewhere", "another repo's note", { peer: "codex", kind: "decision" });
  add("app", "native observation", "captured by a hook, not a hub note", null);
  db.close();
  const before = Bun.file(file).size;
  const s = open();
  const isPii = (t: string) => /\d{6}-\d{7}/.test(t);
  const r = importClaudeMem(s, { project: "github.com/o/app", chain: ["work", "app"], isPii, db: file });
  expect(r).toMatchObject({ read: 6, added: 2, skipped: { project: 1, model: 1, pii: 1, secret: 1 } });
  const got = s.list();
  expect(got.map((v) => v.text).sort()).toEqual(["regex split fails on quotes", "the parser owns quoting"]);
  expect(got.every((v) => v.tier === "long" && v.source === "claude-mem" && v.project === "github.com/o/app")).toBe(true);
  expect(got.find((v) => v.kind === "fail")!.about).toEqual(["task:github.com/o/app#3"]);
  // A second import adds nothing, and claude-mem's file is unchanged.
  expect(importClaudeMem(s, { project: "github.com/o/app", chain: ["work", "app"], isPii, db: file }).added).toBe(0);
  expect(Bun.file(file).size).toBe(before);
  expect(() => importClaudeMem(s, { project: "github.com/o/app", chain: ["app"], isPii, db: join(temp("none"), "missing.db") })).toThrow("no claude-mem store");
});

test("model-suggested edges are drawn but are not evidence until a person confirms them; a rejected one disappears", async () => {
  const s = open();
  const a = s.note(note("use a regex split", { about: ["path:src/csv.ts"] }));
  const b = s.note(note("never split with a regex", { about: ["path:src/other.ts"] }));
  const sid = s.suggest(a, b, "contradicts")!;
  expect(s.suggest(a, b, "contradicts")).toBeUndefined(); // once
  const related = () => s.related("work/app", ["path:src/csv.ts"], 8).map((v) => v.id);
  expect(related()).toEqual([a]);
  const edges = () => s.graph("work/app", `mem:${a}`).edges.filter((e) => e.from === `mem:${a}` && e.to === `mem:${b}`).map((e) => e.rel);
  expect(edges()).toEqual(["suggested contradicts"]);
  // Briefs read the same retrieval: an unconfirmed suggestion brings nothing along.
  const brief = new Briefs(undefined, "work/app", 8, () => s.related("work/app", ["path:src/csv.ts"], 8).map((v) => ({ id: `mem:${v.id}`, line: v.text })));
  expect(await brief.forTask("codex", { title: "t", refs: {} })).not.toContain("never split");
  s.judge(sid.slice(0, 8), "confirm", "user");
  expect(related()).toEqual([a, b]);
  expect(edges()).toEqual(["contradicts"]);
  const other = s.note(note("unrelated", { about: ["path:src/x.ts"] }));
  const rid = s.suggest(a, other, "same_topic")!;
  s.judge(rid, "reject", "user");
  expect(s.graph("work/app", `mem:${a}`).edges.some((e) => e.to === `mem:${other}`)).toBe(false);
  expect(s.suggestions().map((x) => x.status).sort()).toEqual(["confirmed", "rejected"]);
  // Review of #356: another project sees no suggestion between this project's entries, and cannot judge one.
  const third = s.suggest(b, other, "same_topic")!;
  expect(s.suggestions("work/other")).toEqual([]);
  expect(s.judge(third, "confirm", "user", "work/other")).toBeUndefined();
  expect(s.suggestions("work/app").map((x) => x.id)).toContain(third);
  for (const sub of ["confirm", "reject", "import"]) expect(classifyPeerCommand("memory", [sub, "x"])).toBe("console");
  expect(classifyPeerCommand("memory", ["suggestions"])).toBe("allowed");
});

test("briefs report what they carried, research records keep the counts, and the report splits tasks by a fail note in the brief", () => {
  const seen: unknown[] = [];
  const brief = new Briefs(undefined, "p", 8, () => [{ id: "mem:1", line: "fail", kind: "fail" }, { id: "mem:2", line: "decision", kind: "decision" }], (peer, task, counts) => seen.push({ peer, task, ...counts }));
  return brief.forTask("codex", { id: 4, title: "t", refs: {} }).then(() => {
    expect(seen).toEqual([{ peer: "codex", task: 4, native: 2, fails: 1, claudeMem: 0 }]);
    let t = Date.parse("2026-10-10T00:00:00Z");
    const at = () => new Date(t += 1000).toISOString();
    const task = (id: number, event: string, state: string): StampedEvent => ({ v: 1, at: at(), type: "task", id, event, by: "hub", state, owner: "codex", reviewer: null, class: "implement", pii: false });
    const events: StampedEvent[] = [
      task(1, "proposed", "in_progress"), { v: 1, at: at(), type: "memory_brief", peer: "codex", task: 1, native: 2, fails: 1, claudeMem: 0 }, task(1, "done", "approved"),
      task(2, "proposed", "in_progress"), { v: 1, at: at(), type: "memory_brief", peer: "codex", task: 2, native: 1, fails: 0, claudeMem: 3 }, task(2, "done", "approved"),
      task(3, "proposed", "in_progress"), task(3, "done", "approved"),
    ];
    const records = taskRecords(events, "p", { version: "t", source: "backfill" });
    expect(records.map((r) => r.briefs)).toEqual([{ delivered: 1, withFail: 1 }, { delivered: 1, withFail: 0 }, undefined]);
    const report = researchReport(records);
    expect(Object.keys(report.byMemoryBrief).sort()).toEqual(["a fail note in its brief", "brief without a fail note", "no brief recorded"]);
    expect(formatResearch(report).join("\n")).toContain("by memory brief");
    expect([memoryMode({ enabled: false }), memoryMode({ enabled: true }), memoryMode({ enabled: false, native: true }), memoryMode({ enabled: true, native: true })]).toEqual(["off", "claude-mem", "native", "both"]);
  });
});
