import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_FEATURES, PROTOCOL, ControlClient } from "../src/hub/control-client.ts";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { personEnv } from "../src/hub/child-process.ts";
import { Board } from "../src/hub/board.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { needs } from "../src/ui/needs.ts";
import { boardColumns } from "../src/ui/task-board.ts";
import { taskProgress } from "../src/ui/task-progress.ts";
import { attentionFacts, attentionCommand } from "../src/cli/attention.ts";
import { initialConsoleState, reduceConsole, paint } from "../src/cli/console-state.ts";
import { renderStatus } from "../src/cli/output.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-cancel-surface-")), stateDir = join(root, "state");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 } } });
  cleanups.push(() => daemon.stop());
  const board = new Board(join(stateDir, "hub.db")); cleanups.push(() => board.close());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => client.close());
  return { root, stateDir, daemon, board, client };
}

test("hello and status advertise one task_cancel feature; cancellation is strict and revision checked", async () => {
  const f = await fixture(), task = f.board.propose("user", { title: "superseded work", class: "implement" });
  expect(f.client.features).toEqual(DAEMON_FEATURES);
  expect((await f.client.request({ t: "status" })).status.features).toEqual(DAEMON_FEATURES);
  expect(JSON.parse(readFileSync(join(f.stateDir, "status.json"), "utf8")).features).toEqual(DAEMON_FEATURES);
  const cancel = (args: Record<string, unknown>) => f.client.request({ t: "task", op: "hub_task_cancel", args });
  for (const args of [{ id: task.id, reason: "", revision: 1 }, { id: task.id, reason: "replaced", revision: 0 }, { id: task.id, reason: "replaced", actor: "user" }]) expect((await cancel(args)).ok).toBe(false);
  expect(f.board.get(task.id)?.state).toBe("proposed");
  const reply = await cancel({ id: task.id, reason: "replaced by current contract", superseded_by: "task #73", revision: task.history.length });
  expect(reply.ok).toBe(true); expect(JSON.parse(reply.text).state).toBe("cancelled");
  expect(f.board.get(task.id)?.cancelled?.supersededBy).toBe("task #73");
  expect(TASK_TOOLS.find(tool => tool.name === "hub_task_cancel")?.inputSchema.additionalProperties).toBe(false);
});

test("recovery rejects cancelled rows without target task_cancel before creating a hold", async () => {
  const f = await fixture(), task = f.board.propose("user", { title: "obsolete", class: "implement" });
  expect((await f.client.request({ t: "task", op: "hub_task_cancel", args: { id: task.id, reason: "obsolete" } })).ok).toBe(true);
  const instanceId = (await f.client.request({ t: "status" })).status.instanceId;
  const request = (op: string, features?: readonly string[]) => f.client.request({ t: "recovery", op, expectedInstanceId: instanceId, operationId: "fixture", ...(features === undefined ? {} : { targetFeatures: features }) });
  for (const op of ["inspect", "prepare", "commit"]) {
    const reply = await request(op, []);
    expect(reply.ok).toBe(false); expect(reply.error).toContain(`cancelled tasks: #${task.id}`);
    expect(f.daemon.bus.isRecoveryHeld).toBe(false);
  }
  expect((await request("prepare")).ok).toBe(false);
  expect((await request("prepare", DAEMON_FEATURES)).ok).toBe(true);
  expect((await request("abort")).ok).toBe(true);
});

test("stall and exact unread pull-only offer facts remain body-free and actionable", () => {
  const facts = attentionFacts([{ kind: "stall", level: "act", id: 85, body: "private" }, { kind: "offer", level: "act", id: 92, peer: "kimi", body: "private" }]);
  expect(facts).toEqual([{ kind: "stall", id: 85 }, { kind: "offer", id: 92, peer: "kimi" }]);
  const value = needs({ facts }, 0); expect(value.act).toBe(2); expect(value.state).toBe("blocked");
  expect(attentionCommand(value.items.find(item => item.kind === "offer")!)).toContain("open kimi: task #92 is waiting for it");
  const rendered = renderStatus({ peers: {}, taskStalls: [{ task: 85, cause: { kind: "reservation", peer: "pi", code: "tests" } }], pendingTaskOffers: [{ task: 92, peer: "kimi" }] }).map(line => paint(line, false)).join("\n");
  expect(rendered).toContain("task #85 stalled"); expect(rendered).toContain("open kimi: task #92");
});

test("console cancel pins selected task id/revision and requires supported feature", () => {
  const state = initialConsoleState(true); state.panel = 3; state.tasks = [{ id: 72, state: "proposed", flowRevision: 8 }];
  expect(reduceConsole(state, "c").state.editing).toBe(false);
  state.features = DAEMON_FEATURES;
  const edited = reduceConsole(state, "c").state;
  expect(edited.input).toBe("task cancel 72 --revision 8 --reason ");
  expect(edited.actionLock).toMatchObject({ id: "72", revision: 8, prefix: ["task", "cancel"] });
});

test("cancelled board cards are closed and do not release dependent progress", () => {
  const tasks = [{ id: 1, state: "cancelled" }, { id: 2, state: "proposed", deps: [1] }];
  const columns = boardColumns(tasks, {});
  expect(columns.unknown).toEqual([]); expect(columns.columns.at(-1)?.ready[0]).toMatchObject({ id: 1, assignable: false, pull: false });
  expect(taskProgress(tasks).stages).toEqual([expect.objectContaining({ id: 1, label: "cancelled (closed)" }), expect.objectContaining({ id: 2, waiting: true })]);
});


test("current person CLI refuses cancellation without authenticated hello feature before sending its task RPC", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-old-cancel-"))), stateDir = join(root, ".agenthub/state");
  cleanups.push(() => rmSync(root, { recursive: true, force: true })); mkdirSync(stateDir, { recursive: true });
  let taskRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(socket, data) {
      const message = JSON.parse(String(data));
      if (message.t === "hello") socket.send(JSON.stringify({ t: "welcome", rid: message.rid, cwd: root, protocol: PROTOCOL }));
      else { taskRequests++; socket.send(JSON.stringify({ rid: message.rid, ok: true, text: "unexpected task call" })); }
    } },
  }); cleanups.push(() => server.stop(true));
  // Disk metadata alone must never grant a capability missing from the authenticated connection.
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, cwd: root, features: DAEMON_FEATURES }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "task", "cancel", "1", "--reason", "obsolete"],
    { cwd: root, env: personEnv(process.env), stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1); expect(error).toContain("does not support task cancellation"); expect(taskRequests).toBe(0);
});

test("live pull-only adapter offers appear in attention until that exact inbox offer is read", async () => {
  const f = await fixture();
  const peer = await ControlClient.connect(f.stateDir, { role: "peer", peer: "claude", channel: false }); cleanups.push(() => peer.close());
  const proposal = await f.client.request({ t: "task", op: "hub_task_propose", args: { title: "unread task offer", class: "implement", owner: "claude" } });
  expect(proposal.ok).toBe(true);
  const status = (await f.client.request({ t: "status" })).status;
  expect(status.pendingTaskOffers).toHaveLength(1);
  const offer = status.pendingTaskOffers[0];
  expect(offer.peer).toBe("claude"); expect(offer.envelopeId).toBeString();
  expect(status.attentionItems).toContainEqual(expect.objectContaining({ kind: "offer", id: offer.task, peer: "claude" }));
  expect((await peer.request({ t: "inbox" })).ok).not.toBe(false);
  expect((await f.client.request({ t: "status" })).status.pendingTaskOffers).toEqual([]);
});

test("peer actor cannot cancel another proposer work or expose a PII cancellation payload", async () => {
  const f = await fixture(), task = f.board.propose("user", { title: "private patient task", class: "implement", signals: ["pii"] });
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex" }); cleanups.push(() => tools.close());
  expect((await tools.request({ t: "task", op: "hub_task_cancel", args: { id: task.id, reason: "replace" } })).ok).toBe(false);
  expect(f.board.get(task.id)?.state).toBe("proposed");
  const cancelled = await f.client.request({ t: "task", op: "hub_task_cancel", args: { id: task.id, reason: "patient 900101-1234567", superseded_by: "private patient reference" } });
  expect(cancelled.ok).toBe(true); expect(JSON.parse(cancelled.text)).toMatchObject({ title: "[pii]", state: "cancelled" });
  expect(cancelled.text).not.toContain("900101"); expect(cancelled.text).not.toContain("private patient reference");
});
