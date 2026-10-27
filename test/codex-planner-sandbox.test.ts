import { afterEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { CodexPeer, type CodexOptions } from "../src/adapters/codex-appserver.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

type NativeReply = { result?: unknown; error?: unknown };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 300 && !condition(); i++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
};
const confirmed = (sandbox: unknown = { type: "readOnly" }): NativeReply => ({ result: { thread: { id: "planner-thread" }, sandbox } });
const envelope = () => newEnvelope("claude", "plan this task without changing files", { to: ["codex-plan"] });

async function fixture(response: (message: any) => NativeReply | undefined = () => confirmed(), planner: boolean | CodexOptions["threadSandbox"] = true) {
  const requests: any[] = [], seen: any[] = [], adopted: { id: string; fresh: boolean }[] = [];
  const sockets = new Set<ServerWebSocket<{}>>();
  let current: ServerWebSocket<{}> | undefined, tui: WebSocket | undefined, closed = false;
  const native = Bun.serve<{}>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request, { data: {} }) ? undefined : new Response("fixture", { status: 400 }); },
    websocket: {
      open(socket) { current = socket; sockets.add(socket); },
      close(socket) { sockets.delete(socket); },
      message(socket, raw) {
        const message = JSON.parse(String(raw)); requests.push(message);
        if (message.method === "initialize") return void socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake-codex/0.164.0" } }));
        if (["thread/start", "thread/resume"].includes(message.method)) {
          const reply = response(message);
          if (reply) socket.send(JSON.stringify({ id: message.id, ...reply }));
        } else if (message.method === "turn/start") socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "planner-turn" } } }));
      },
    },
  });
  const threadSandbox = typeof planner === "boolean" ? planner ? "read-only" : undefined : planner;
  const peer = new CodexPeer("codex-plan", { appPort: 0, proxyPort: 0, cwd: process.cwd(), upstreamUrl: `ws://127.0.0.1:${native.port}`,
    ...(threadSandbox === undefined ? {} : { threadSandbox }), onThread: (id, fresh) => adopted.push({ id, fresh }) });
  cleanup.push(async () => { tui?.close(); try { await peer.stop(); } finally { for (const socket of sockets) socket.close(); native.stop(true); } });
  await peer.start();
  tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  tui.onclose = () => { closed = true; };
  await new Promise<void>((resolve, reject) => { tui!.onopen = () => resolve(); tui!.onerror = () => reject(new Error("planner fixture proxy did not open")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "planner-fixture" } } }));
  await until(() => seen.some(message => message.id === 1), "native initialization reply");
  return { peer, tui, requests, seen, adopted, closed: () => closed,
    reply(id: string | number, reply: NativeReply) { current!.send(JSON.stringify({ id, ...reply })); },
    notify(method: string, params: unknown) { current!.send(JSON.stringify({ method, params })); } };
}

for (const method of ["thread/start", "thread/resume"] as const) test(`#525 planner ${method} forces and confirms the native read-only sandbox before adoption`, async () => {
  const f = await fixture(() => confirmed(method === "thread/start" ? { type: "readOnly" } : { type: "readOnly", networkAccess: false }));
  const params = { ...(method === "thread/resume" ? { threadId: "planner-thread" } : {}), sandbox: "danger-full-access", model: "fixture-model" };
  f.tui.send(JSON.stringify({ id: 2, method, params }));
  await until(() => f.peer.state === "idle", "confirmed planner adopted");
  expect(f.requests.find(message => message.id === 2).params).toEqual({ ...params, sandbox: "read-only" });
  expect(f.adopted).toEqual([{ id: "planner-thread", fresh: method === "thread/start" }]);
  expect(f.seen.find(message => message.id === 2).result.sandbox.type).toBe("readOnly");
  await f.peer.deliver([envelope()]);
  const delivery = f.requests.find(message => message.method === "turn/start" && message.id < 0);
  expect(delivery.params.threadId).toBe("planner-thread");
  expect(delivery.params).not.toHaveProperty("sandboxPolicy");
});

const refused: readonly [string, NativeReply][] = [
  ["missing policy", { result: { thread: { id: "planner-thread" } } }],
  ["string policy", confirmed("read-only")],
  ["misplaced policy", { result: { thread: { id: "planner-thread", sandbox: { type: "readOnly" } }, sandboxPolicy: { type: "readOnly" } } }],
  ["workspace-write policy", confirmed({ type: "workspaceWrite", writableRoots: ["/fixture"] })],
  ["full-access policy", confirmed({ type: "dangerFullAccess" })],
  ["malformed policy", confirmed({ type: "readOnly", networkAccess: "false" })],
  ["widened policy", confirmed({ type: "readOnly", writableRoots: ["/fixture"] })],
  ["missing thread identity", { result: { thread: { id: "" }, sandbox: { type: "readOnly" } } }],
  ["native refusal", { error: { code: -32000, message: "PRIVATE_NATIVE_DIAGNOSTIC" } }],
  ["contradictory native reply", { ...confirmed(), error: { code: -32000, message: "PRIVATE_NATIVE_DIAGNOSTIC" } }],
];
for (const method of ["thread/start", "thread/resume"] as const) for (const [reason, response] of refused) test(`#525 planner ${method} refuses ${reason} without adoption or host delivery`, async () => {
  const f = await fixture(() => response);
  f.tui.send(JSON.stringify({ id: 2, method, params: method === "thread/resume" ? { threadId: "planner-thread" } : {} }));
  await until(() => f.seen.some(message => message.id === 2), "planner thread reply received");
  expect(f.seen.find(message => message.id === 2)).toEqual({ id: 2, error: { code: -32000, message: "Codex planner thread requires a confirmed read-only sandbox" } });
  await until(() => f.closed(), "unconfirmed planner link closed");
  expect(f.peer.state).toBe("offline"); expect(f.peer.thread).toBe(""); expect(f.adopted).toEqual([]);
  await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
});

test("#525 a foreign RPC reply is not planner sandbox confirmation", async () => {
  const f = await fixture(() => undefined);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.requests.some(message => message.id === 2), "planner request pending");
  f.reply(999, confirmed());
  await until(() => f.seen.some(message => message.id === 999), "foreign reply forwarded without adoption");
  expect(f.adopted).toEqual([]); expect(f.peer.state).toBe("offline");
  await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  f.reply(2, confirmed());
  await until(() => f.peer.state === "idle", "matching confirmation adopted");
  expect(f.adopted).toHaveLength(1);
});

test("#525 a pending planner resume fences an already idle thread before the native reply", async () => {
  const f = await fixture(message => message.method === "thread/start" ? confirmed() : undefined);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "initial planner thread adopted");
  f.tui.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "another-thread" } }));
  await until(() => f.requests.some(message => message.id === 3), "resume pending");
  await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
  f.reply(3, confirmed({ type: "workspaceWrite" }));
  await until(() => f.closed(), "unconfirmed resumed link closed");
  expect(f.peer.state).toBe("offline"); expect(f.peer.thread).toBe(""); expect(f.adopted).toHaveLength(1);
});

test("#525 a planner cannot pipeline a native turn before thread sandbox confirmation", async () => {
  const f = await fixture(() => undefined);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  f.tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "planner-thread", input: [{ type: "text", text: "must not run" }] } }));
  await until(() => f.closed(), "early planner turn closes unconfirmed link");
  expect(f.seen.find(message => message.id === 3).error.message).toContain("confirmed read-only");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]); expect(f.adopted).toEqual([]);
});

test("#525 duplicate pending planner RPC ids refuse before a second thread request", async () => {
  const f = await fixture(() => undefined);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.requests.some(message => message.id === 2), "first request pending");
  f.tui.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "planner-thread" } }));
  await until(() => f.closed(), "ambiguous request closes link");
  expect(f.requests.filter(message => ["thread/start", "thread/resume"].includes(message.method))).toHaveLength(1);
  expect(f.adopted).toEqual([]);
});

test("#525 malformed planner thread parameters refuse before a native request", async () => {
  const f = await fixture();
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: [] }));
  await until(() => f.closed(), "malformed request closes link");
  expect(f.requests.filter(message => message.method === "thread/start")).toEqual([]); expect(f.adopted).toEqual([]);
});

test("#525 the attached person's later native turn policy remains their ceiling", async () => {
  const f = await fixture();
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "initial read-only thread adopted");
  const sandboxPolicy = { type: "workspaceWrite", writableRoots: ["/fixture"] };
  f.tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "planner-thread", input: [{ type: "text", text: "person turn" }], sandboxPolicy } }));
  await until(() => f.seen.some(message => message.id === 3), "person's native turn reply");
  expect(f.requests.find(message => message.id === 3).params.sandboxPolicy).toEqual(sandboxPolicy);
});

for (const method of ["thread/start", "thread/resume"] as const) test(`#525 an ordinary proxy preserves ${method} without the planner sandbox option`, async () => {
  const f = await fixture(() => confirmed({ type: "workspaceWrite", writableRoots: ["/fixture"] }), false);
  const params = { ...(method === "thread/resume" ? { threadId: "planner-thread" } : {}), sandbox: "workspace-write" };
  f.tui.send(JSON.stringify({ id: 2, method, params }));
  await until(() => f.peer.state === "idle", "ordinary native thread adopted unchanged");
  expect(f.requests.find(message => message.id === 2).params).toEqual(params);
  expect(f.seen.find(message => message.id === 2).result.sandbox.type).toBe("workspaceWrite");
  expect(f.adopted).toHaveLength(1);
});

for (const method of ["thread/start", "thread/resume"] as const) test(`#525 live planner policy is re-read before the first ${method}`, async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(() => confirmed(), () => sandbox);
  sandbox = "read-only";
  f.tui.send(JSON.stringify({ id: 2, method, params: { ...(method === "thread/resume" ? { threadId: "planner-thread" } : {}), sandbox: "workspace-write" } }));
  await until(() => f.peer.state === "idle", "live planner confirmed");
  expect(f.requests.find(message => message.id === 2).params.sandbox).toBe("read-only");
  await f.peer.deliver([envelope()]);
  expect(f.requests.filter(message => message.method === "turn/start")).toHaveLength(1);
});

for (const [name, reply] of [["unknown", { result: { thread: { id: "planner-thread" } } }], ["writable", confirmed({ type: "workspaceWrite" })], ["read-only", confirmed()]] as const) test(`#525 a live planner policy change during pending RPC uses the current ${name} reply`, async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(() => undefined, () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { sandbox: "workspace-write" } }));
  await until(() => f.requests.some(message => message.id === 2), "ordinary thread request pending");
  expect(f.requests.find(message => message.id === 2).params.sandbox).toBe("workspace-write");
  sandbox = "read-only";
  f.reply(2, reply);
  if (name === "read-only") {
    await until(() => f.peer.state === "idle", "current reply confirms planner sandbox");
    await f.peer.deliver([envelope()]);
    expect(f.requests.filter(message => message.method === "turn/start")).toHaveLength(1);
  } else {
    await until(() => f.closed(), "current policy refuses pending ordinary reply");
    expect(f.adopted).toEqual([]);
    await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
    expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
  }
});

for (const [name, initial] of [["unknown", { result: { thread: { id: "planner-thread" } } }], ["writable", confirmed({ type: "workspaceWrite" })]] as const) test(`#525 changing an existing ${name} thread to planner closes it before host delivery`, async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(() => initial, () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "ordinary thread adopted");
  sandbox = "read-only";
  await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  await until(() => f.closed(), "unproved old thread closed");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]); expect(f.peer.thread).toBe("");
});

test("#525 an ordinary writable thread can confirm a read-only resume after its role changes", async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(message => message.method === "thread/start" ? confirmed({ type: "workspaceWrite" }) : confirmed(), () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "ordinary writable thread adopted");
  sandbox = "read-only";
  f.tui.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "planner-thread", sandbox: "workspace-write" } }));
  await until(() => f.adopted.length === 2, "resume confirms current planner policy");
  expect(f.requests.find(message => message.id === 3).params.sandbox).toBe("read-only");
  await f.peer.deliver([envelope()]);
  expect(f.requests.filter(message => message.method === "turn/start")).toHaveLength(1);
});

test("#525 an ordinary reply's correlated read-only confirmation survives a later planner role", async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(() => confirmed(), () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "ordinary read-only thread adopted");
  expect(f.requests.find(message => message.id === 2).params).not.toHaveProperty("sandbox");
  sandbox = "read-only";
  await f.peer.deliver([envelope()]);
  expect(f.requests.filter(message => message.method === "turn/start")).toHaveLength(1);
});

test("#525 another ordinary resume replaces old read-only proof even for the same thread id", async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(message => message.method === "thread/start" ? confirmed() : confirmed({ type: "workspaceWrite" }), () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.adopted.length === 1, "initial read-only thread adopted");
  f.tui.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "planner-thread" } }));
  await until(() => f.adopted.length === 2, "ordinary writable resume adopted");
  sandbox = "read-only";
  await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
});

test("#525 live planner policy also fences host steering into an ordinary writable thread", async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(() => confirmed({ type: "workspaceWrite" }), () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "ordinary writable thread adopted");
  f.notify("turn/started", { threadId: "planner-thread", turn: { id: "person-turn" } });
  await until(() => f.peer.state === "busy", "person's ordinary turn running");
  sandbox = "read-only";
  await expect(f.peer.steer([envelope()])).rejects.toThrow("no steerable turn");
  expect(await f.peer.steerText("must not enter the writable turn")).toBe("refused");
  expect(f.requests.filter(message => message.method === "turn/steer")).toEqual([]);
});

for (const cause of ["unavailable", "throw", "malformed"] as const) test(`#525 live ${cause} policy refuses before native thread effects`, async () => {
  let changed = false;
  const policy = () => {
    if (!changed) return undefined;
    if (cause === "throw") throw new Error("PRIVATE_POLICY_DIAGNOSTIC");
    return cause === "unavailable" ? "unavailable" as const : "invalid-host-policy" as any;
  };
  const f = await fixture(() => confirmed(), policy);
  changed = true;
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.closed(), "unavailable policy closes link");
  expect(f.seen.find(message => message.id === 2).error.message).toBe("Codex planner thread requires a confirmed read-only sandbox");
  expect(f.requests.filter(message => message.method === "thread/start")).toEqual([]); expect(f.adopted).toEqual([]);
});

for (const cause of ["unavailable", "throw"] as const) test(`#525 live ${cause} policy refuses a pending native confirmation`, async () => {
  let changed = false;
  const f = await fixture(() => undefined, () => { if (!changed) return undefined; if (cause === "throw") throw new Error("PRIVATE_POLICY_DIAGNOSTIC"); return "unavailable"; });
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.requests.some(message => message.id === 2), "ordinary request pending");
  changed = true; f.reply(2, confirmed());
  await until(() => f.closed(), "current unavailable policy rejects confirmation");
  expect(f.adopted).toEqual([]); expect(f.peer.state).toBe("offline");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
});

for (const cause of ["unavailable", "throw", "malformed"] as const) test(`#525 live ${cause} policy closes a confirmed link before host injection`, async () => {
  let changed = false;
  const policy = () => {
    if (!changed) return undefined;
    if (cause === "throw") throw new Error("PRIVATE_POLICY_DIAGNOSTIC");
    return cause === "unavailable" ? "unavailable" as const : "invalid-host-policy" as any;
  };
  const f = await fixture(() => confirmed(), policy);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "ordinary read-only thread adopted");
  changed = true;
  await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  await until(() => f.closed(), "unavailable policy closes before injection");
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]); expect(f.peer.thread).toBe("");
});

test("#525 planner injection rechecks live policy after synchronous state callbacks", async () => {
  let unavailable = false;
  const f = await fixture(() => confirmed(), () => unavailable ? "unavailable" : undefined);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.peer.state === "idle", "ordinary read-only thread adopted");
  f.peer.onState = state => { if (state === "busy") unavailable = true; };
  await expect(f.peer.deliver([envelope()])).rejects.toThrow();
  expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
  await until(() => f.closed(), "unavailable state callback closes before native effect");
});

for (const tighten of ["pending", "after ordinary reply"] as const) test(`#525 ambiguous ordinary thread RPC ids cannot supply planner proof when roles tighten ${tighten}`, async () => {
  let sandbox: "read-only" | undefined;
  const f = await fixture(() => undefined, () => sandbox);
  f.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => f.requests.filter(message => message.id === 2).length === 1, "first ordinary request pending");
  f.tui.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "planner-thread" } }));
  await until(() => f.requests.filter(message => message.id === 2).length === 2, "ordinary duplicate keeps baseline forwarding");
  if (tighten === "pending") sandbox = "read-only";
  f.reply(2, confirmed());
  if (tighten === "after ordinary reply") {
    await until(() => f.adopted.length === 1, "ordinary adoption remains unchanged");
    sandbox = "read-only";
    await expect(f.peer.deliver([envelope()])).rejects.toThrow("not injectable");
  }
  await until(() => f.closed(), "ambiguous proof closes planner link");
  expect(f.peer.thread).toBe(""); expect(f.requests.filter(message => message.method === "turn/start")).toEqual([]);
});
