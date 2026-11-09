import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { TASK_TOOLS, IMPLEMENTER_HUB_TOOL_NAMES, projectToolList } from "../src/hub/hub-tools.ts";
import { ownerToolEffect } from "../src/hub/no-writes.ts";
import { Capture } from "../src/memory/capture.ts";
import type { MemoryClient } from "../src/memory/client.ts";
import { readRestartSnapshot, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-lineage-control-")), stateDir = join(root, "state");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(stateDir); mkdirSync(join(root, "kimi-home")); mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.local.json"), "{}");
  const board = new Board(join(stateDir, "hub.db")); cleanups.push(() => board.close());
  const task = board.propose("user", { title: "Synthetic lineage task", class: "implement" });
  let sequence = 0;
  const config = { ...DEFAULT_CONFIG, roster: {}, start: { agents: [] }, batch_ms: 0, configWatch: false,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, omniroute: { urls: [], access_hosts: [] },
    pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false },
    approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  const start = () => startDaemon({ cwd: root, stateDir, instanceId: `lineage-fixture-${++sequence}`, kimiHome: join(root, "kimi-home"), config,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, memorySyncTrigger: () => {} });
  let daemon = await start(); cleanups.push(() => daemon.stop());
  let person = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => person.close());
  const reference = { v: 1 as const, tool: "ares" as const, projectKey: "foreign-fixture-project", kind: "run", id: "https://example.invalid/inert-never-fetch", revision: "r1" };
  const link = { taskId: task.id, taskCreated: task.created, flowRevision: task.history.length, reference };
  return { root, stateDir, board, task, reference, link, get daemon() { return daemon; }, get person() { return person; }, instance: () => `lineage-fixture-${sequence}`,
    restart: async () => { person.close(); await daemon.stop(); daemon = await start(); person = await ControlClient.connect(stateDir, { role: "console" }); } };
}

test("CLI control and MCP expose equivalent bounded declared metadata, idempotent links and restart-stable project scope", async () => {
  const f = await fixture(); expect(f.person.features).toContain("execution_lineage");
  const first = await f.person.request({ t: "lineage_show", taskId: f.task.id });
  expect<boolean>(first.ok, first.error).toBe(true); expect(first.lineage.state).toBe("available");
  const key = first.lineage.nodes[0].ref.projectKey;
  expect(key).toMatch(/^ahub-[a-f0-9]{64}$/); expect(key).not.toContain(f.root);
  const saved = await f.person.request({ t: "lineage_link", ...f.link });
  expect<boolean>(saved.ok, saved.error).toBe(true); expect(saved.link).toMatchObject({ taskId: f.task.id, reference: f.reference, strength: "declared", already: false });
  const duplicate = await f.person.request({ t: "task", op: "hub_lineage_link", args: f.link });
  expect<boolean>(duplicate.ok, duplicate.error).toBe(true); expect(JSON.parse(duplicate.text).link).toMatchObject({ id: saved.link.id, already: true });
  const before = f.board.executionReferencesIntegrity();
  const cli = await f.person.request({ t: "lineage_show", taskId: f.task.id });
  const mcp = await f.person.request({ t: "task", op: "hub_lineage_show", args: { taskId: f.task.id } });
  expect<boolean>(mcp.ok, mcp.error).toBe(true); expect(JSON.parse(mcp.text)).toEqual({ ok: true, lineage: cli.lineage });
  expect(cli.lineage.nodes.some((node: any) => node.ref.tool === "ares" && node.strength === "declared")).toBe(true);
  expect(f.board.executionReferencesIntegrity()).toEqual(before);
  const page = await f.person.request({ t: "lineage_show", taskId: f.task.id, nodes: 1 });
  expect(page.lineage.truncated).toBe(true); expect(typeof page.lineage.cursor).toBe("string");
  await f.restart();
  const restarted = await f.person.request({ t: "lineage_show", taskId: f.task.id });
  expect(restarted.lineage.nodes.find((node: any) => node.ref.tool === "ahub").ref.projectKey).toBe(key);
  expect((await f.person.request({ t: "lineage_link", ...f.link })).link).toMatchObject({ id: saved.link.id, already: true });
  const oldCursor = await f.person.request({ t: "lineage_show", taskId: f.task.id, nodes: 1, cursor: page.lineage.cursor });
  expect(oldCursor.lineage).toEqual({ state: "unavailable", reason: "cursor_invalid" });
}, 20_000);

test("unauthorized reads hide both missing and denied roots; malformed/stale links reply without effects", async () => {
  const f = await fixture(), peer = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanups.push(() => peer.close());
  const denied = await peer.request({ t: "lineage_show", taskId: f.task.id }), missing = await peer.request({ t: "lineage_show", taskId: f.task.id + 1 });
  expect(denied).toMatchObject({ ok: true, lineage: { state: "unavailable" } }); expect(missing.lineage).toEqual(denied.lineage);
  const before = f.board.executionReferencesIntegrity();
  for (const client of [f.person, peer]) {
    const result = await client.request({ t: "lineage_link", ...f.link, flowRevision: f.link.flowRevision + 1 });
    expect(result.ok).toBe(false); expect(typeof result.error).toBe("string");
  }
  const malformed = await f.person.request({ t: "lineage_link", ...f.link, reference: { ...f.reference, unknown: "not admitted" } });
  expect(malformed.ok).toBe(false); expect(f.board.executionReferencesIntegrity()).toEqual(before);
  const unknown = await f.person.request({ t: "lineage_unknown", taskId: f.task.id }); expect(unknown.ok).toBe(false);
}, 20_000);

test("retained declarations require execution_lineage target support and appear in recovery integrity", async () => {
  const f = await fixture(), targetFeatures = DAEMON_FEATURES.filter(feature => feature !== "execution_lineage");
  const empty = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: f.instance(), targetFeatures });
  expect<boolean>(empty.ok, empty.error).toBe(true);
  expect((await f.person.request({ t: "lineage_link", ...f.link })).ok).toBe(true);
  const blocked = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: f.instance(), targetFeatures });
  expect(blocked.ok).toBe(false); expect(blocked.error).toContain("target lacks execution_lineage");
  const supported = await f.person.request({ t: "recovery", op: "inspect", expectedInstanceId: f.instance(), targetFeatures: DAEMON_FEATURES });
  expect<boolean>(supported.ok, supported.error).toBe(true); expect(supported.recovery.integrity.current.executionReferences).toEqual(f.board.executionReferencesIntegrity());
}, 20_000);

test("restart reader validates optional execution-reference integrity without widening legacy empty state", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-lineage-snapshot-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: RestartSnapshot = { schemaVersion: 1, projectRoot: root, projectId: "fixture", sourceInstanceId: "source", operationId: "operation", committedAt: Date.now(),
    bus: new Bus().snapshot(), manualPaused: [], peers: [], integrity: { queues: {}, manualPaused: [], boardDigest: "a", budgetDigest: "b" } };
  const expected = { projectRoot: root, projectId: "fixture" };
  writeRestartSnapshot(root, snapshot); expect(readRestartSnapshot(root, expected)).toBeDefined();
  snapshot.integrity!.executionReferences = { count: 1, digest: "a".repeat(64) };
  writeRestartSnapshot(root, snapshot); expect(readRestartSnapshot(root, expected)?.integrity?.executionReferences).toEqual(snapshot.integrity!.executionReferences);
  for (const bad of [{ count: -1, digest: "a".repeat(64) }, { count: 1, digest: "bad" }, { count: 1, digest: "a".repeat(64), extra: true }]) {
    writeRestartSnapshot(root, { ...snapshot, integrity: { ...snapshot.integrity!, executionReferences: bad } });
    expect(readRestartSnapshot(root, expected)).toBeUndefined();
  }
});

test("lineage tools stay out of capture, owner progress, and read-only project publication", () => {
  const names = projectToolList(TASK_TOOLS, true).map(tool => tool.name);
  expect(names).not.toContain("hub_lineage_show"); expect(names).not.toContain("hub_lineage_link");
  const ordinaryNames = projectToolList(TASK_TOOLS).map(tool => tool.name);
  expect(ordinaryNames).toContain("hub_lineage_show"); expect(ordinaryNames).toContain("hub_lineage_link");
  expect(IMPLEMENTER_HUB_TOOL_NAMES).toContain("hub_lineage_show"); expect(IMPLEMENTER_HUB_TOOL_NAMES).toContain("hub_lineage_link");
  const captured: unknown[] = [], client = { appendCapture: async (value: unknown) => { captured.push(value); } } as unknown as MemoryClient;
  const capture = new Capture(client, { project: "fixture", cwd: "/fixture", deny: [] }); capture.init("fixture-session", "public fixture"); captured.length = 0;
  for (const tool of ["hub_lineage_show", "hub_lineage_link", "mcp__agent-hub__hub_lineage_link"]) {
    expect(ownerToolEffect(tool, {})).toBe(false);
    capture.observe({ tool, args: "LINEAGE_ARGUMENT_CANARY", output: "LINEAGE_RESULT_CANARY", id: tool, paths: [] });
  }
  expect(captured).toEqual([]);
});
