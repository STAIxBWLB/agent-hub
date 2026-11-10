import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../src/ui/plugin.ts";
import type { SpaceScene } from "../src/ui/office-space.ts";
import type { Lifecycle, ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); setSystemTime(); });
function gate() {
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(() => release());
  return { entered, release, wait: () => { enter(); return pending; } };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5_000;
  while (!await predicate()) { if (performance.now() >= deadline) throw Error("fake Space observation missing"); await Bun.sleep(1); }
}
type Reply = { scene?: SpaceScene; cursor: number; changed?: false };
function fleet(options: { runningFreshMs?: number; spaceBudgetMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ahub-space1380-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const projects: ProjectRecord[] = [];
  const states = new Map<string, { cursor: number; title: string; instanceId: string; running: boolean; legacy: boolean; refused: boolean; events: unknown[]; hold?: ReturnType<typeof gate> }>();
  const calls: { id: string; after: number; full: boolean }[] = [];
  const listing = { asked: 0, hold: undefined as ReturnType<typeof gate> | undefined };
  function add(id: string) {
    const project: ProjectRecord = { id, root: `/tmp/space-${id}`, stateDir: join(home, id), basePort: 4700, instanceId: `i-${id}`, pid: process.pid };
    const state = { cursor: 1, title: `Public ${id}`, instanceId: project.instanceId!, running: true, legacy: false, refused: false, events: [] as unknown[], hold: undefined as ReturnType<typeof gate> | undefined };
    projects.push(project); states.set(id, state);
    const hub = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(req, server) { if (server.upgrade(req)) return; return new Response("fixture", { status: 400 }); },
      websocket: { async message(ws, data) {
        const m = JSON.parse(String(data));
        if (m.t === "hello") return void ws.send(JSON.stringify({ rid: m.rid, t: "welcome", cwd: project.root, projectId: id, instanceId: state.instanceId }));
        if (m.t === "ui_action") return void ws.send(JSON.stringify({ rid: m.rid, ok: true }));
        if (m.t !== "ui_snapshot") return;
        const full = state.legacy || m.after !== state.cursor;
        calls.push({ id, after: m.after, full });
        const reply = state.refused ? { ok: false } : !full ? { ok: true, changed: false, cursor: state.cursor } : {
          ok: true, cursor: state.cursor, status: { peers: { codex: { state: "busy" }, kimi: { state: "idle" } } },
          tasks: [{ id: 1, title: state.title, state: "in_progress", class: "implement", owner: "codex", detail: "MARKER-1380 private detail" }],
          events: state.events, permissions: [],
        };
        if (state.hold) await state.hold.wait();
        try { ws.send(JSON.stringify({ rid: m.rid, ...reply })); } catch { /* the owning provider may already have closed this connection */ }
      } },
    });
    cleanups.push(() => hub.stop(true));
    mkdirSync(project.stateDir, { recursive: true });
    writeFileSync(join(project.stateDir, "status.json"), JSON.stringify({ pid: process.pid, controlPort: hub.port, protocol: PROTOCOL, cwd: project.root, projectId: id, instanceId: state.instanceId }));
    writeFileSync(join(project.stateDir, "control-token"), "fixture-token");
    return state;
  }
  add("a"); add("b");
  const lifecycle: Lifecycle = {
    async inspectProject(project) { listing.asked++; if (listing.hold) await listing.hold.wait(); const s = states.get(project.id)!; return s.running ? { state: "running", status: { instanceId: s.instanceId, peers: {} } } as never : { state: "stopped" } as never; },
    async startProject() { return {}; }, async stopProject() {},
  };
  const registry = { list: () => projects, get: (id: string) => projects.find(p => p.id === id), close() {} } as never;
  const provider = createProvider({ home, registry, lifecycle, ...options });
  cleanups.push(() => provider.close?.());
  const space = (after = 0) => provider.snapshot({ panel: "space", after }) as Promise<Reply>;
  const restart = (id: string, instanceId: string) => {
    const project = projects.find(p => p.id === id)!;
    states.get(id)!.instanceId = instanceId; project.instanceId = instanceId;
    const file = join(project.stateDir, "status.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), instanceId }));
  };
  return { provider, space, calls, listing, states, add, restart };
}

test("#1380: warm Space reuses its running listing while an expired listing refreshes once in the background", async () => {
  setSystemTime(Date.now());
  const f = fleet();
  await f.space(); expect(f.listing.asked).toBe(2);
  f.listing.hold = gate();
  await f.space(); expect(f.listing.asked).toBe(2);
  setSystemTime(Date.now() + 10_001);
  await f.space(); await f.listing.hold.entered;
  expect(f.listing.asked).toBe(4);
  await f.space(); expect(f.listing.asked).toBe(4);
  f.listing.hold.release();
});

test("#1380 AC1/AC2: project cursors reuse unchanged scenes; only a changed project sends a full snapshot", async () => {
  const f = fleet();
  const first = await f.space();
  expect(first.cursor).toBeGreaterThan(0);
  expect(first.scene!.cards.map(c => c.title)).toEqual(["#1 Public a", "#1 Public b"]);
  const started = performance.now();
  const quiet = await f.space(first.cursor);
  const warmMs = performance.now() - started;
  expect(quiet).toEqual({ changed: false, cursor: first.cursor });
  for (const id of ["a", "b"]) expect(f.calls.filter(c => c.id === id).map(c => [c.after, c.full])).toEqual([[0, true], [1, false]]);
  expect(f.listing.asked).toBe(2);
  console.log(JSON.stringify({ measurement: "space-fake-daemon-warm", warmMs }));
  f.states.get("b")!.cursor++; f.states.get("b")!.title = "Changed b";
  const changed = await f.space(quiet.cursor);
  expect(changed.cursor).not.toBe(first.cursor);
  expect(changed.scene!.cards.map(c => c.title)).toEqual(["#1 Public a", "#1 Changed b"]);
  expect(f.calls.filter(c => c.full).map(c => c.id).sort()).toEqual(["a", "b", "b"]);
  expect(JSON.stringify(changed)).not.toContain("MARKER-1380");
  // A second viewer with no cursor always receives the full current scene, even when the daemon replies unchanged.
  const cold = await f.space();
  expect(cold.scene).toEqual(changed.scene);
  expect(cold.cursor).toBe(changed.cursor);
});

test("#1380: legacy full replies are screened even when their event cursor is unchanged", async () => {
  const f = fleet(); for (const s of f.states.values()) s.legacy = true;
  const first = await f.space();
  expect(await f.space(first.cursor)).toEqual({ changed: false, cursor: first.cursor });
  // Current daemon event cursors do not fence all public fields. A private-title change must not reuse old text.
  f.states.get("a")!.title = "[pii]";
  const changed = await f.space(first.cursor);
  expect(changed.scene!.cards.find(c => c.id === "a:1")!.title).toBe("#1 [pii]");
  expect(changed.cursor).not.toBe(first.cursor);
});

test("#1380: concurrent viewers share one bounded Space computation", async () => {
  const f = fleet(); const held = gate(); for (const s of f.states.values()) s.hold = held;
  const pending = Array.from({ length: 10 }, () => f.space());
  await held.entered; await until(() => f.calls.length === 2);
  expect(f.listing.asked).toBe(2);
  held.release();
  const replies = await Promise.all(pending);
  expect(f.calls).toHaveLength(2);
  for (const reply of replies) { expect(reply.cursor).toBe(replies[0]!.cursor); expect(reply.scene).toBe(replies[0]!.scene); }
});

test("#1380: unchanged models still expire message links on the wall clock", async () => {
  setSystemTime(Date.now());
  const f = fleet();
  f.states.get("a")!.events = [{ seq: 1, event: { t: "envelope", env: { from: "codex", to: ["kimi"], kind: "chat", priority: "status", ts: Date.now(), body: "MARKER-1380 private body" } } }];
  const first = await f.space();
  expect(first.scene!.links!.some(l => l.kind === "message")).toBe(true);
  setSystemTime(Date.now() + 10_001);
  const expired = await f.space(first.cursor);
  expect(expired.cursor).not.toBe(first.cursor);
  expect(expired.scene!.links!.filter(l => l.kind === "message")).toEqual([]);
  expect(f.calls.filter(c => c.full)).toHaveLength(2);
  expect(JSON.stringify(expired)).not.toContain("MARKER-1380");
});

test("#1380: removal of a running project changes the combined scene after listing refresh", async () => {
  const f = fleet({ runningFreshMs: 0 });
  const first = await f.space(); f.states.get("b")!.running = false;
  await f.space(first.cursor); // starts the one background listing refresh
  let removed: Reply | undefined;
  await until(async () => { removed = await f.space(first.cursor); return !!removed.scene && removed.scene.actors.every(a => a.id.startsWith("a:")); });
  expect(removed!.cursor).not.toBe(first.cursor);
  expect(removed!.scene!.cards.map(c => c.id)).toEqual(["a:1"]);
});

test("#1380: a known refusal drops the project's cached model rather than returning stale public text", async () => {
  const f = fleet(); const first = await f.space(); f.states.get("a")!.refused = true;
  const refused = await f.space(first.cursor);
  expect(refused.scene!.cards.map(c => c.id)).toEqual(["b:1"]);
  expect(refused.cursor).not.toBe(first.cursor);
  f.states.get("a")!.refused = false;
  await f.space(refused.cursor);
  expect(f.calls.filter(c => c.id === "a").at(-1)).toEqual({ id: "a", after: 0, full: true });
});

test("#1380: a new daemon instance starts at after zero even when its event cursor equals the old instance", async () => {
  const f = fleet({ runningFreshMs: 0 }); const first = await f.space();
  f.restart("b", "new-b"); f.states.get("b")!.title = "Restarted b";
  await f.space(first.cursor);
  let restarted: Reply | undefined;
  await until(async () => { restarted = await f.space(first.cursor); return restarted.scene?.cards.some(c => c.title === "#1 Restarted b") ?? false; });
  expect(restarted!.cursor).not.toBe(first.cursor);
  expect(f.calls.filter(c => c.id === "b").some((c, index) => index > 0 && c.after === 0 && c.full)).toBe(true);
});

test("#1380: an action prevents the old in-flight Space response from overwriting the next generation", async () => {
  const f = fleet(); await f.space();
  const held = gate(); for (const s of f.states.values()) s.hold = held;
  const old = f.space(); await held.entered; await until(() => f.calls.length === 4);
  await f.provider.action({ action: "pause", projectId: "a", instanceId: "i-a", peer: "codex" });
  for (const s of f.states.values()) { s.hold = undefined; s.cursor++; s.title = "Current"; }
  const current = await f.space();
  expect(current.scene!.cards.every(c => c.title === "#1 Current")).toBe(true);
  held.release(); await old;
  expect(await f.space(current.cursor)).toEqual({ changed: false, cursor: current.cursor });
});

test("#1380: an office request that outlives its poll budget is joined, not duplicated", async () => {
  const f = fleet({ spaceBudgetMs: 100 }); const first = await f.space();
  const held = gate(); for (const s of f.states.values()) s.hold = held;
  const timed = f.space(first.cursor); await held.entered; await timed;
  await f.space(first.cursor);
  expect(f.calls).toHaveLength(4); // warm-up plus one still-pending request per project
  held.release();
});
