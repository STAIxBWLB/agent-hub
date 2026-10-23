import { afterEach, expect, test } from "bun:test";
import { CodexPeer, type CodexOptions } from "../src/adapters/codex-appserver.ts";
import { ACTION_BUDGET_OPTION, type PermissionRequest } from "../src/adapters/acp.ts";
import { ActionBudgets, actionPolicyConfig } from "../src/hub/action-policy.ts";
import { actionGate } from "../src/hub/action-enforce.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(check: () => boolean) { for (let n = 0; n < 200 && !check(); n++) await Bun.sleep(5); expect(check()).toBe(true); }
const command = (id: string | number, extra: Record<string, unknown> = {}) => ({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item", startedAtMs: 1, command: "git push origin main", cwd: "/fixture", ...extra } });
async function rig(extra: Partial<CodexOptions> = {}, startTurn = true) {
  let native: { send(text: string): unknown } | undefined;
  const received: any[] = [], seen: any[] = [], asks: PermissionRequest[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, host) { return host.upgrade(request) ? undefined : new Response("fixture"); },
    websocket: { open(socket) { native = socket; }, message(socket, raw) {
      const msg = JSON.parse(String(raw)); received.push(msg);
      if (msg.method === "thread/start" || msg.method === "thread/resume") socket.send(JSON.stringify({ id: msg.id, result: { thread: { id: msg.params?.threadId ?? "thread-1" }, approvalPolicy: "untrusted" } }));
    } },
  });
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: `ws://127.0.0.1:${server.port}`, cwd: "/fixture", actionGate: () => ({ title: "screened classed command" }), onPermission: async req => { asks.push(req); return "deny"; }, ...extra });
  cleanup.push(() => server.stop(true)); cleanup.push(() => peer.stop());
  await peer.start();
  const tui = new WebSocket(peer.proxyUrl); tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  cleanup.push(() => tui.close()); await new Promise<void>(resolve => { tui.onopen = () => resolve(); });
  tui.send(JSON.stringify({ id: 1, method: "thread/start", params: {} })); await until(() => peer.state === "idle");
  const emit = (msg: unknown) => native!.send(JSON.stringify(msg));
  const start = (turn = "turn-1") => emit({ method: "turn/started", params: { threadId: peer.thread, turn: { id: turn } } });
  if (startTurn) { start(); await until(() => peer.state === "busy"); }
  return { peer, tui, emit, start, received, seen, asks };
}

for (const mode of ["ask", "ask-when-needed", "never-ask"] as const) test(`Codex classed approval asks in ${mode} and offers only one-shot answers`, async () => {
  const r = await rig({ permissionMode: mode }); r.emit(command("approval"));
  await until(() => r.received.some(row => row.id === "approval"));
  expect(r.asks).toHaveLength(1); expect(r.asks[0]).toMatchObject({ classed: true, title: "screened classed command" });
  expect(r.asks[0]!.options.map(option => option.kind)).toEqual(["allow_once", "reject_once"]);
  expect(r.received.find(row => row.id === "approval").result).toEqual({ decision: "decline" });
  expect(r.seen.some(row => row.id === "approval")).toBe(false); expect(r.peer.actionGated).toBe(true);
});

test("Codex legacy argv is preserved and a normal allow never records a class-budget grant", async () => {
  let input: unknown, grants = 0;
  const r = await rig({ actionGate: call => { input = call.input; return { title: "screened", budget: { label: "publish x2", approve: () => { grants++; return true; } } }; }, onPermission: async req => { expect(req.options.map(option => option.optionId)).toEqual(["allow", "deny", ACTION_BUDGET_OPTION]); return "allow"; } });
  r.emit({ id: 20, method: "execCommandApproval", params: { conversationId: "thread-1", callId: "call", command: ["git", "push", "argument with spaces"], cwd: "/fixture", parsedCmd: [] } });
  await until(() => r.received.some(row => row.id === 20));
  expect(input).toEqual({ command: ["git", "push", "argument with spaces"], cwd: "/fixture" }); expect(grants).toBe(0);
  expect(r.received.find(row => row.id === 20).result).toEqual({ decision: "approved" });
});

for (const granted of [true, false]) test(`Codex explicit class budget grants only when its ledger accepts (${granted})`, async () => {
  let grants = 0;
  const r = await rig({ actionGate: () => ({ title: "screened", budget: { label: "publish x2", approve: () => { grants++; return granted; } } }), onPermission: async () => ACTION_BUDGET_OPTION });
  r.emit(command(21)); await until(() => r.received.some(row => row.id === 21));
  expect(grants).toBe(1); expect(r.received.find(row => row.id === 21).result.decision).toBe(granted ? "accept" : "decline");
});

test("Codex unclassed or absent command, writeStdin, file and permission RPCs remain native", async () => {
  let calls = 0;
  const r = await rig({ actionGate: () => { calls++; return undefined; } });
  const frames = [command(30), command(31, { command: null }), command(32, { kind: "writeStdin" }), { ...command(33), method: "item/fileChange/requestApproval" }, { ...command(34), method: "item/permissions/requestApproval" }];
  for (const row of frames) r.emit(row);
  await until(() => r.seen.filter(row => row.id >= 30).length === 5);
  expect(calls).toBe(1); expect(r.asks).toHaveLength(0);
  r.tui.send(JSON.stringify({ id: 30, result: { decision: "acceptForSession" } })); await until(() => r.received.some(row => row.id === 30));
  expect(r.received.find(row => row.id === 30).result.decision).toBe("acceptForSession");
});

test("Codex a failing gate asks with withheld text, never propagating native command into its title", async () => {
  const r = await rig({ actionGate: () => { throw new Error("private native text"); } }); r.emit(command(40));
  await until(() => r.asks.length === 1); expect(r.asks[0]!.classed).toBe(true); expect(r.asks[0]!.title).toContain("command withheld"); expect(r.asks[0]!.title).not.toContain("private native text");
});

for (const change of ["complete", "replace", "interrupt", "detach", "stop"] as const) test(`Codex late budget selection after ${change} cannot allow or seed the ledger`, async () => {
  let resolve!: (option: string) => void, signal: AbortSignal | undefined, grants = 0;
  const choice = new Promise<string>(done => { resolve = done; });
  const r = await rig({ actionGate: () => ({ title: "screened", budget: { label: "publish x2", approve: () => { grants++; return true; } } }), onPermission: async (_request, current) => { signal = current; return choice; } });
  r.emit(command(50)); await until(() => signal !== undefined);
  if (change === "complete") r.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  if (change === "replace") r.tui.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-2" } }));
  if (change === "interrupt") r.tui.send(JSON.stringify({ id: 2, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } }));
  if (change === "detach") r.tui.close();
  if (change === "stop") await r.peer.stop();
  await until(() => signal!.aborted); resolve(ACTION_BUDGET_OPTION); await Bun.sleep(5);
  expect(grants).toBe(0); expect(r.received.filter(row => row.id === 50).every(row => row.result?.decision === "decline")).toBe(true);
});

test("Codex intercepted ids suppress guessed, duplicate and late TUI approval replies", async () => {
  let resolve!: (option: string) => void, asked = false;
  const choice = new Promise<string>(done => { resolve = done; });
  const r = await rig({ onPermission: async () => { asked = true; return choice; } });
  r.emit(command("held")); await until(() => asked);
  r.tui.send(JSON.stringify({ id: "held", result: { decision: "acceptForSession" } }));
  r.emit(command("held")); resolve("allow"); await until(() => r.received.some(row => row.id === "held"));
  r.tui.send(JSON.stringify({ id: "held", result: { decision: "accept" } }));
  // A transport barrier proves the late answer has been processed, without timing its absence.
  r.tui.send(JSON.stringify({ id: 99, method: "fixture/barrier" })); await until(() => r.received.some(row => row.id === 99));
  expect(r.received.filter(row => row.id === "held")).toEqual([{ id: "held", result: { decision: "accept" } }]);
});

test("Codex a classed request without an observed native turn fails closed", async () => {
  const r = await rig(); r.emit(command(60, { turnId: "unobserved" })); await until(() => r.received.some(row => row.id === 60));
  expect(r.asks).toHaveLength(0); expect(r.received.find(row => row.id === 60).result.decision).toBe("decline");
});

test("Codex uses the shared policy ledger only when the command is visible", async () => {
  for (const privateTurn of [false, true]) {
    let peer: CodexPeer | undefined;
    const budgets = new ActionBudgets(() => actionPolicyConfig({ budgets: { publish: 2 } }), () => peer?.thread);
    const gate = actionGate({ budgets, policy: () => actionPolicyConfig({ budgets: { publish: 2 } }), root: () => "/fixture", task: () => undefined,
      publicView: () => ({}), isPrivate: () => privateTurn, nameable: () => !privateTurn }, "codex");
    const r = await rig({ actionGate: gate, onPermission: async req => {
      if (privateTurn) { expect(req.title).toContain("[private command withheld]"); expect(req.options.map(o => o.kind)).toEqual(["reject_once"]); }
      else { expect(req.title).toContain("git push origin main"); expect(req.options.some(o => o.optionId === ACTION_BUDGET_OPTION)).toBe(true); }
      return ACTION_BUDGET_OPTION;
    } }); peer = r.peer;
    r.emit(command(70)); await until(() => r.received.some(row => row.id === 70));
    expect(r.received.find(row => row.id === 70).result.decision).toBe(privateTurn ? "decline" : "accept");
    expect(budgets.status("codex", false).remaining.publish).toBe(privateTurn ? 0 : 1);
  }
});


for (const forged of ["allow", ACTION_BUDGET_OPTION]) test(`Codex deny-only view offers no grant and rejects a forged ${forged} answer`, async () => {
  let grants = 0;
  const r = await rig({ actionGate: () => ({ title: "command withheld", denyOnly: true, budget: { label: "publish x2", approve: () => { grants++; return true; } } }),
    onPermission: async req => { expect(req.options.map(o => o.kind)).toEqual(["reject_once"]); return forged; } });
  r.emit(command("deny-only"));
  await until(() => r.received.some(row => row.id === "deny-only"));
  expect(r.received.find(row => row.id === "deny-only").result).toEqual({ decision: "decline" }); expect(grants).toBe(0);
});


test("Codex legacy approval without an observed active turn denies instead of inventing a binding", async () => {
  const r = await rig({}, false);
  r.emit({ id: "legacy-no-turn", method: "execCommandApproval", params: { conversationId: "thread-1", callId: "legacy", command: ["git", "push"], cwd: "/fixture" } });
  await until(() => r.received.some(row => row.id === "legacy-no-turn"));
  expect(r.received.find(row => row.id === "legacy-no-turn").result.decision).toBe("abort"); expect(r.asks).toHaveLength(0);
});
