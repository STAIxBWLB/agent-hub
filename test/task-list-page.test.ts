import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, compactRow, pageTasks, parseListQuery } from "../src/hub/task-list-page.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { BasePeer } from "../src/hub/peers.ts";

class FakePeer extends BasePeer {
  readonly pullOnly = true;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const refusal = (run: () => unknown): string => { try { run(); } catch (error) { expect(error).toBeInstanceOf(PreEffectToolRefusal); return (error as Error).message; } throw new Error("expected a refusal"); };

test("agent callers page by default, the person's console keeps the full array until it names a paging argument (#1083)", () => {
  expect(parseListQuery({}, true)).toEqual({ limit: LIST_DEFAULT_LIMIT, detail: false });
  expect(parseListQuery({}, false)).toBeUndefined();
  expect(parseListQuery({ state: "approved", ready: true }, false)).toBeUndefined();
  expect(parseListQuery({ limit: 5 }, false)).toEqual({ limit: 5, detail: false });
  expect(parseListQuery({ ids: [3, 1] }, true)).toEqual({ limit: 2, ids: [3, 1], detail: true });
});

test("every paging refusal names its cause and a next step (#1083)", () => {
  expect(refusal(() => parseListQuery({ limit: 0 }, true))).toContain("1 to 200");
  expect(refusal(() => parseListQuery({ limit: LIST_MAX_LIMIT + 1 }, true))).toContain("cursor");
  expect(refusal(() => parseListQuery({ limit: 1.5 }, true))).toContain("whole number");
  expect(refusal(() => parseListQuery({ cursor: "garbage" }, true))).toContain("start again without a cursor");
  expect(refusal(() => parseListQuery({ cursor: 5 }, true))).toContain("unchanged");
  expect(refusal(() => parseListQuery({ ids: [] }, true))).toContain("1 to 200");
  expect(refusal(() => parseListQuery({ ids: [1, 1] }, true))).toContain("distinct");
  expect(refusal(() => parseListQuery({ ids: [0] }, true))).toContain("positive");
  expect(refusal(() => parseListQuery({ ids: Array.from({ length: 201 }, (_, i) => i + 1) }, true))).toContain("limit and cursor");
  expect(refusal(() => parseListQuery({ ids: [1], limit: 5 }, true))).toContain("drop limit and cursor");
  expect(refusal(() => parseListQuery({ detail: "yes" }, true))).toContain("true or false");
});

test("pages are newest-updated first, a cursor continues exactly where the last page ended, and ties break by id (#1083)", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, updated: 1000 + Math.floor(i / 2) }));
  const seen: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const query = parseListQuery({ limit: 3, ...(cursor ? { cursor } : {}) }, true)!;
    const page = pageTasks(rows, query);
    expect(page.total).toBe(10);
    seen.push(...page.rows.map(row => row.id));
    cursor = page.next;
    if (!cursor) break;
  }
  expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  expect(new Set(seen).size).toBe(10);
  // The last page has no cursor, and an exact multiple of the limit does not invent an empty page.
  expect(pageTasks(rows, { limit: 10, detail: false }).next).toBeUndefined();
});

test("a cursor stays valid while other tasks change after the page was read (#1083)", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, updated: 1000 + i }));
  const first = pageTasks(rows, { limit: 2, detail: false });
  expect(first.rows.map(row => row.id)).toEqual([6, 5]);
  // task 6 is touched again and a new task arrives: neither makes the next page repeat or skip an older row
  const changed = [...rows.filter(row => row.id !== 6), { id: 6, updated: 5000 }, { id: 7, updated: 5001 }];
  const next = pageTasks(changed, parseListQuery({ limit: 2, cursor: first.next! }, true)!);
  expect(next.rows.map(row => row.id)).toEqual([4, 3]);
});

test("ids returns exactly those tasks in the order given and ignores paging (#1083 AC2)", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, updated: 1000 + i }));
  const page = pageTasks(rows, parseListQuery({ ids: [7, 2, 99, 4] }, true)!);
  expect(page.rows.map(row => row.id)).toEqual([7, 2, 4]);
  expect(page.next).toBeUndefined();
});

test("a compact row keeps only id, state, owner, reviewer and title (#1083)", () => {
  expect(compactRow({ id: 4, state: "proposed", owner: undefined, title: "t", detail: "body", plan: { paths: ["a"] }, flowRevision: 3 })).toEqual({ id: 4, state: "proposed", owner: null, reviewer: null, title: "t" });
});

test("hub_task_list advertises limit, cursor, ids and detail, bounded (#1083)", () => {
  const tool = TASK_TOOLS.find(item => item.name === "hub_task_list")!;
  const properties = (tool.inputSchema as { properties: Record<string, { maximum?: number; maxItems?: number }> }).properties;
  expect(Object.keys(properties)).toEqual(expect.arrayContaining(["state", "ready", "limit", "cursor", "ids", "detail"]));
  expect(properties.limit!.maximum).toBe(LIST_MAX_LIMIT);
  expect(properties.ids!.maxItems).toBe(LIST_MAX_LIMIT);
});

async function hub(count: number) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-task-list-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, ".agenthub", "state");
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const peer = new FakePeer("kimi"); daemon.bus.add(peer); await peer.start();
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "kimi" }); cleanup.push(() => tools.close());
  for (let index = 0; index < count; index++) {
    const reply = await person.request({ t: "task", op: "hub_task_propose", args: { title: `fixture task ${index} ${"x".repeat(80)}`, detail: "d".repeat(2000), class: "implement" } });
    expect(reply.ok, `proposal ${index} refused: ${String(reply.error)}`).toBe(true);
  }
  return { daemon, person, tools, stateDir };
}
const list = async (client: ControlClient, args: Record<string, unknown> = {}) => {
  const reply = await client.request({ t: "task", op: "hub_task_list", args });
  return { reply, text: String(reply.text ?? ""), json: reply.ok ? JSON.parse(String(reply.text)) : undefined };
};

test("with 600 tasks an agent's default list is at most 50 compact rows, a cursor, and under 64 KB (#1083 AC1, AC3)", async () => {
  const r = await hub(600);
  const page = await list(r.tools);
  expect(page.reply.ok).toBe(true);
  expect(page.json.tasks).toHaveLength(50);
  expect(page.json.total).toBe(600);
  expect(typeof page.json.next).toBe("string");
  expect(Buffer.byteLength(page.text, "utf8")).toBeLessThan(64 * 1024);
  expect(Object.keys(page.json.tasks[0]).sort()).toEqual(["id", "owner", "reviewer", "state", "title"]);
  // newest-updated first
  const ids = page.json.tasks.map((row: { id: number }) => row.id);
  expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a));
}, 120_000);

test("an agent can walk the whole board with the cursor, once each, and the last page has no cursor (#1083)", async () => {
  const r = await hub(130);
  const seen: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const page = await list(r.tools, { limit: 60, ...(cursor ? { cursor } : {}) });
    expect(page.reply.ok).toBe(true);
    seen.push(...page.json.tasks.map((row: { id: number }) => row.id));
    cursor = page.json.next;
    if (!cursor) break;
  }
  expect(seen).toHaveLength(130);
  expect(new Set(seen).size).toBe(130);
}, 120_000);

test("ids returns full rows for those tasks and detail returns full rows for a page (#1083 AC2)", async () => {
  const r = await hub(5);
  const byIds = await list(r.tools, { ids: [2, 4] });
  expect(byIds.json.tasks.map((row: { id: number }) => row.id)).toEqual([2, 4]);
  expect(byIds.json.tasks[0]).toHaveProperty("flowRevision");
  expect(byIds.json.tasks[0]).toHaveProperty("class");
  const detail = await list(r.tools, { detail: true, limit: 2 });
  expect(detail.json.tasks).toHaveLength(2);
  expect(detail.json.tasks[0]).toHaveProperty("flowRevision");
  expect(detail.json.total).toBe(5);
});

test("state and ready filters still apply before paging, and a bad argument is refused with a next step (#1083)", async () => {
  const r = await hub(4);
  const proposed = await list(r.tools, { state: "proposed", limit: 2 });
  expect(proposed.json.total).toBe(4);
  expect(proposed.json.tasks).toHaveLength(2);
  const approved = await list(r.tools, { state: "approved" });
  expect(approved.json).toEqual({ tasks: [], total: 0 });
  const bad = await list(r.tools, { limit: 500 });
  expect(bad.reply.ok).toBe(false);
  expect(String(bad.reply.error)).toContain("1 to 200");
});

test("PII tasks stay stubs in compact rows and in ids rows (#1083)", async () => {
  const r = await hub(0);
  const secret = "patient Kim Minsoo 900101-1234567";
  const made = await r.person.request({ t: "task", op: "hub_task_propose", args: { title: secret, detail: secret, class: "implement" } });
  expect(made.ok).toBe(true);
  for (const args of [{}, { ids: [1] }, { detail: true }]) {
    const page = await list(r.tools, args);
    expect(page.reply.ok).toBe(true);
    expect(page.text).not.toContain("Kim Minsoo");
    expect(page.text).not.toContain("900101");
  }
});

test("the person's console keeps the full array, so the CLI JSON contract is stable (#1083)", async () => {
  const r = await hub(60);
  const all = await list(r.person);
  expect(Array.isArray(all.json)).toBe(true);
  expect(all.json).toHaveLength(60);
  expect(all.json[0]).toHaveProperty("flowRevision");
  // naming a paging argument opts the console into the same envelope an agent gets
  const paged = await list(r.person, { limit: 10 });
  expect(paged.json.tasks).toHaveLength(10);
  expect(paged.json.next).toBeDefined();
}, 120_000);

