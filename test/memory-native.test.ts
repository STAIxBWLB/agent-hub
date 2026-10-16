import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { memoryCommand } from "../src/cli/memory.ts";
import { Briefs } from "../src/memory/brief.ts";
import { citedIds, gather } from "../src/hub/ask.ts";
import { Board } from "../src/hub/board.ts";
import { extractNodes, MemoryStore } from "../src/memory/store.ts";

// #258 phase 1 through the hub: notes from the task flow land in tiers, approval promotes, PII and secrets stay out,
// and the dashboard, briefs and the CLI read the same store.

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (name: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `ahub-memnative-${name}-`))); dirs.push(d); return d; };
const until = async (condition: () => boolean | Promise<boolean>, label: string, attempts = 200, interval = 10) => {
  for (let i = 0; i < attempts && !(await condition()); i++) await Bun.sleep(interval);
  if (!(await condition())) throw new Error(`timed out waiting for ${label}`);
};
const MARKERS = ["900101-1234567", "SECRET-PII-TITLE", "SECRET-PII-DETAIL"];

async function hub(home: string, extra: Partial<typeof DEFAULT_CONFIG> = {}) {
  const root = temp("project"), stateDir = join(root, "state");
  mkdirSync(stateDir); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "csv.ts"), "");
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home;
  cleanup.push(() => { if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; });
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "p-mem", instanceId: "i-mem", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true }, ...extra } });
  cleanup.push(() => daemon.stop());
  for (const peer of ["worker", "claude"]) { const c = await ControlClient.connect(stateDir, { role: "peer", peer }); cleanup.push(() => c.close()); }
  await until(() => daemon.bus.peers.get("worker")?.state === "idle" && daemon.bus.peers.get("claude")?.state === "idle", "peers attached");
  const as = async (peer: string) => { const c = await ControlClient.connect(stateDir, { role: "tools", peer }); cleanup.push(() => c.close()); return c; };
  const worker = await as("worker"), claude = await as("claude");
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => console_.close());
  const op = async (c: ControlClient, name: string, args: Record<string, unknown>) => {
    const reply = await c.request({ t: "task", op: name, args });
    if (!reply.ok) throw new Error(reply.error);
    return reply.text as string;
  };
  /** The refusal text of a call the hub must refuse. */
  const refused = async (c: ControlClient, name: string, args: Record<string, unknown>) => {
    const reply = await c.request({ t: "task", op: name, args });
    if (reply.ok) throw new Error(`${name} was not refused: ${reply.text}`);
    return String(reply.error);
  };
  return { root, stateDir, daemon, worker, claude, console: console_, op, refused };
}

test("notes on an open task are short-term; approval promotes decisions, contracts and fails; PII and secrets never enter the store", async () => {
  const home = temp("home");
  const h = await hub(home);
  await h.op(h.worker, "hub_task_propose", { title: "fix quoted commas", class: "implement", owner: "worker", refs: { paths: ["src/csv.ts"] }, plan: { paths: ["src/csv.ts"], symbols: ["parse"] } });
  expect(await h.op(h.worker, "hub_remember", { text: "regex split fails on quoted commas", kind: "fail", task: 1 })).toMatch(/hub memory [0-9a-f]{8}, short-term/);
  await h.op(h.worker, "hub_remember", { text: "the parser now owns quoting", kind: "decision", task: 1 });
  await h.op(h.worker, "hub_remember", { text: "csv files here are small", kind: "finding", task: 1 });
  await h.op(h.claude, "hub_remember", { text: "every reader goes through parse", kind: "contract", horizon: "long", scope: "shared" });
  expect(await h.refused(h.worker, "hub_remember", { text: "token: abcdefgh12345678", kind: "finding" })).toContain("looks like it holds a secret");
  expect(await h.refused(h.worker, "hub_remember", { text: "x", horizon: "forever" })).toContain("horizon");
  // A PII task: nothing about it is saved, by tool or by the hub's own notes.
  await h.op(h.claude, "hub_task_propose", { title: "SECRET-PII-TITLE call 900101-1234567", detail: "SECRET-PII-DETAIL", class: "implement" });
  expect(await h.refused(h.worker, "hub_remember", { text: "about it", task: 2 })).toContain("PII task");
  expect(await h.refused(h.worker, "hub_remember", { text: "call 900101-1234567 later" })).toContain("PII pattern");

  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  const project = store.list()[0]!.project;
  expect(store.list({ tier: "short" }).map((v) => v.kind).sort()).toEqual(["decision", "fail", "finding"]);
  expect(store.list({ tier: "long" })).toMatchObject([{ kind: "contract", scope: "shared", peer: "claude" }]);
  // Edges from the task's refs and plan, and the task itself; `by` is the peer that saved it.
  const fail = store.list({ kind: "fail" })[0]!;
  expect(fail.about).toEqual(expect.arrayContaining(["path:src/csv.ts", "symbol:parse@src/csv.ts", `task:${fail.task}`])); // the task node carries its proposal time
  expect(store.graph(project, `mem:${fail.id}`).edges).toContainEqual({ from: `mem:${fail.id}`, to: "peer:worker", rel: "by" });

  const done = await h.op(h.worker, "hub_task_done", { id: 1, summary: "quoted commas parse" });
  if (done.includes("in_review")) await h.op(h.claude, "hub_review", { id: 1, verdict: "approved", note: "good" });
  await until(() => { store.refresh(); return store.list({ tier: "long" }).length >= 4; }, "promotion");
  const long = store.list({ tier: "long" });
  expect(long.map((v) => v.kind).sort()).toEqual(expect.arrayContaining(["contract", "decision", "fail"]));
  expect(long.some((v) => v.kind === "finding")).toBe(false);
  expect(store.list({ tier: "short" }).every((v) => v.kind === "finding")).toBe(true);
  expect(store.list({ tier: "short" }).every((v) => v.expiresAt !== null)).toBe(true); // the approval started their clock

  // No PII marker anywhere in the logs or the index.
  const files = ["log", "local"].flatMap((d) => readdirSync(join(home, "memory", d)).map((f) => join(home, "memory", d, f)));
  for (const file of [...files, join(home, "memory", "index.db")]) for (const m of MARKERS) expect(readFileSync(file, "latin1")).not.toContain(m);

  // The dashboard's Memory section: one tier, filtered, with the neighbourhood and detail of the selected node.
  const snap = await h.console.request({ t: "ui_snapshot", after: 0, memory: { tier: "long", kind: "fail", node: `mem:${long.find((v) => v.kind === "fail")!.id}`, hops: 2 } });
  const memory = snap.memory as { counts: { long: number }; entries: { kind: string }[]; graph: { nodes: { id: string }[]; edges: unknown[] }; detail: { kind: string; about: string[] } };
  expect(memory.entries.map((e) => e.kind)).toEqual(["fail"]);
  expect(memory.detail).toMatchObject({ kind: "fail" });
  expect(memory.graph.nodes.map((n) => n.id)).toContain("path:src/csv.ts");
  expect(memory.counts.long).toBeGreaterThanOrEqual(4);
  for (const m of MARKERS) expect(JSON.stringify(snap.memory)).not.toContain(m);
  // A malformed query reads as no filter, never an error.
  expect((await h.console.request({ t: "ui_snapshot", after: 0, memory: { tier: 7, kind: ["x"], hops: "x" } })).memory).toMatchObject({ tier: "long" });

  // The CLI reads the same store; changing it is a person's.
  expect(await memoryCommand(["list", "--tier", "long"], h.root, { store })).toContain("long-term");
  expect(await memoryCommand(["search", "quoted"], h.root, { store })).toContain("regex split fails");
  await expect(memoryCommand(["list", "--since", "yesterday-ish"], h.root, { store })).rejects.toThrow("--since");
  expect(classifyPeerCommand("memory", ["search", "x"])).toBe("allowed");
  expect(classifyPeerCommand("memory", ["--json"])).toBe("allowed");
  for (const sub of ["forget", "promote", "demote", "supersede", "rebuild", "graph"]) expect(classifyPeerCommand("memory", [sub, "x"])).toBe("console");
}, 30_000);

test("briefs go through the graph: a linked fail first, a superseded decision dropped, another project's shared entry in and its private one out", () => {
  const home = temp("brief"), cwd = temp("cwd");
  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  const note = (project: string, kind: "decision" | "fail" | "contract", text: string, about: string[], extra = {}) => store.note({ op: "note", project, scope: "project", tier: "long", kind, peer: "codex", text, about, source: "hub", ...extra });
  const old = note("A", "decision", "old decision about parse", ["symbol:parse@src/csv.ts"]);
  note("A", "decision", "new decision about parse", ["symbol:parse@src/csv.ts"], { supersedes: old });
  note("A", "fail", "regex split fails", ["path:src/csv.ts"]);
  note("B", "contract", "shared contract from B", ["symbol:parse@src/csv.ts"], { scope: "shared" });
  note("B", "decision", "private decision of B", ["symbol:parse@src/csv.ts"]);
  const nodes = (t: { refs: { paths?: string[] }; plan?: { paths?: string[]; symbols?: string[] }; id?: number }) => extractNodes("", { cwd, project: "A", repo: "o/r", paths: [...(t.refs.paths ?? []), ...(t.plan?.paths ?? [])], symbols: t.plan?.symbols, ...(t.id !== undefined ? { task: { id: t.id, created: 1 } } : {}) });
  const briefs = new Briefs(undefined, "A", 8, (t) => store.related("A", nodes(t), 8).map((v) => ({ id: `mem:${v.id}`, line: `mem:${v.id.slice(0, 8)} ${v.kind}: ${v.text}` })));
  return briefs.forTask("codex", { id: 9, title: "t", refs: { paths: ["src/csv.ts"] }, plan: { symbols: ["parse"] } }).then((brief) => {
    const lines = brief!.split("\n");
    expect(lines[0]).toContain("hub memory first");
    expect(lines[1]).toContain("fail: regex split fails");
    expect(brief).toContain("new decision about parse");
    expect(brief).toContain("shared contract from B");
    expect(brief).not.toContain("old decision about parse");
    expect(brief).not.toContain("private decision of B");
  });
});

test("the native store is on with any project config and off in a bare in-code config", () => {
  const root = temp("cfg");
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub", "config.json"), "{}");
  expect(loadConfig(root).memory.native).toBe(true);
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { native: false } }));
  expect(loadConfig(root).memory.native).toBe(false);
  expect(DEFAULT_CONFIG.memory.native).toBeUndefined();
  expect(existsSync(join(root, "memory"))).toBe(false);
});

test("ahub ask takes hub memory as evidence with mem ids, never for a question that carries PII", async () => {
  const dir = temp("ask");
  const board = new Board(join(dir, "hub.db")); cleanup.push(() => board.close());
  const deps = { board, isPii: () => false, onCampus: async () => false, isPiiText: (q: string) => q.includes("900101-1234567"), project: "p", logFile: join(dir, "hub.log"),
    native: (keys: string[]) => keys.includes("parser") ? [{ id: "mem:1a2b3c4d", text: "fail long: regex split fails" }] : [] };
  expect((await gather("why does the parser fail", deps)).evidence).toContainEqual({ id: "mem:1a2b3c4d", kind: "memory", text: "fail long: regex split fails" });
  expect((await gather("parser 900101-1234567", deps)).evidence.some((e) => e.id.startsWith("mem:"))).toBe(false);
  expect(citedIds("it fails [mem:1a2b3c4d, task #3]")).toEqual(["mem:1a2b3c4d", "task #3"]);
});

test("a late note on an already approved task starts its clock at once (review of #352)", async () => {
  const home = temp("late");
  const h = await hub(home);
  await h.op(h.worker, "hub_task_propose", { title: "approved first", class: "implement", owner: "worker" });
  const done = await h.op(h.worker, "hub_task_done", { id: 1, summary: "done" });
  if (done.includes("in_review")) await h.op(h.claude, "hub_review", { id: 1, verdict: "approved", note: "ok" });
  await h.op(h.worker, "hub_remember", { text: "a late finding", kind: "finding", task: 1 });
  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  expect(store.list({ q: "a late finding" })[0]!.expiresAt).not.toBeNull();
}, 30_000);

test("an approval a stop cut off before its settle entry is settled when the hub starts again (review of #352)", async () => {
  const home = temp("reconcile");
  const h = await hub(home);
  await h.op(h.worker, "hub_task_propose", { title: "cut short", class: "implement", owner: "worker" });
  await h.op(h.worker, "hub_remember", { text: "decided before the stop", kind: "decision", task: 1 });
  // The board says approved, but the settle entry never got written (a crash between the two).
  for (const fn of cleanup.splice(0).reverse()) await fn();
  const board = new Board(join(h.stateDir, "hub.db"));
  board.update(1, "worker", "done", { state: "approved" });
  board.close();
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home; // the first hub's cleanup put the caller's value back
  cleanup.push(() => { if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous; });
  const daemon = await startDaemon({ cwd: h.root, stateDir: h.stateDir, projectId: "p-mem", instanceId: "i-mem-2", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true } } });
  cleanup.push(() => daemon.stop());
  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  expect(store.list({ q: "decided before the stop" })).toMatchObject([{ tier: "long" }]);
  expect(readFileSync(join(h.stateDir, "hub.log"), "utf8")).toContain("settled 1 approved task");
}, 30_000);

test("an explicit short horizon on an open task is never promoted, and a bad short_ttl_days fails the config (review of #352)", async () => {
  const home = temp("explicit");
  const h = await hub(home);
  await h.op(h.worker, "hub_task_propose", { title: "keep it short", class: "implement", owner: "worker" });
  await h.op(h.worker, "hub_remember", { text: "a scratch decision", kind: "decision", task: 1, horizon: "short" });
  const done = await h.op(h.worker, "hub_task_done", { id: 1, summary: "done" });
  if (done.includes("in_review")) await h.op(h.claude, "hub_review", { id: 1, verdict: "approved", note: "ok" });
  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  expect(store.list({ q: "a scratch decision" }).map((v) => [v.tier, v.expiresAt !== null])).toEqual([["short", true]]);
  const cwd = temp("ttl"); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "config.json"), JSON.stringify({ memory: { short_ttl_days: "two weeks" } }));
  expect(() => loadConfig(cwd)).toThrow("short_ttl_days");
}, 30_000);

test("a note about a private path is refused before either memory sees it (review of #352)", async () => {
  const home = temp("privpath");
  const h = await hub(home, { pii: { paths: ["src/csv.ts"] }, local: { ...DEFAULT_CONFIG.local, deny: ["src/csv.ts"] } });
  expect(await h.refused(h.worker, "hub_remember", { text: "the parser in src/csv.ts splits badly", kind: "fail", horizon: "long" })).toContain("private"); // denied from the graph, still private
}, 30_000);


test("a saved native note and its recall line share one identity per delivery without changing stored text (#412)", async () => {
  const home = temp("shared-recall-id");
  const h = await hub(home);
  const text = "Retain this explicit recall contract.";
  await h.op(h.worker, "hub_remember", { kind: "contract", horizon: "long", text });
  const store = new MemoryStore({ home }); cleanup.push(() => store.close());
  const saved = store.list({ q: text })[0]!;
  h.daemon.bus.preface("claude", `Hub memory: retained session recall\nmem:${saved.id.slice(0, 8)} contract long: ${text}`);
  const delivery = h.daemon.bus.pull("claude")!;
  const shown = delivery.map(env => env.body).join("\n");
  expect(shown.split(text)).toHaveLength(2);
  expect(shown).toContain(`mem:${saved.id}`);
  expect(store.get(saved.id)!.text).toBe(text);
});
