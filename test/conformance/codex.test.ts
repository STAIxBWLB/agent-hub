import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexPeer } from "../../src/adapters/codex-appserver.ts";
import { newEnvelope } from "../../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../../src/hub/peers.ts";
import { startFakeAppServer } from "../fakes/app-server.ts";
import { processTable } from "../../src/hub/child-process.ts";
import { until } from "./kit.ts";
import { createRegisteredPeer, expire } from "./factories.ts";

async function fixture(fake: Pick<ReturnType<typeof startFakeAppServer>, "url" | "requests" | "stop"> = startFakeAppServer()) {
  const dir = mkdtempSync(join(tmpdir(), "conformance-codex-")), messages: string[] = [], receipts: DeliveryReceipt[] = [], usage: boolean[] = [];
  const peer = createRegisteredPeer<CodexPeer>("codex", { codex: { cwd: dir, upstreamUrl: fake.url, appPort: 0, proxyPort: 0, onUsage: (_reading, hard) => { usage.push(hard); } } });
  peer.onMessage = text => { messages.push(text); }; peer.onDelivery = receipt => { receipts.push(receipt); };
  await peer.start();
  const seen: any[] = [], tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake Codex TUI connection")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "conformance-tui" } } }));
  await until(() => seen.some(row => row.id === 1), "Codex initialize consumed");
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { approvalPolicy: "untrusted" } }));
  await until(() => peer.state === "idle", "Codex thread adopted");
  return { peer, fake, messages, receipts, usage, tui, seen, async close() { try { tui.close(); await peer.stop(); } finally { fake.stop(); rmSync(dir, { recursive: true, force: true }); } } };
}

test("P4 Codex: permission overlays reach real turn RPC and ask restores the native baseline", async () => {
  const f = await fixture();
  try {
    for (const [mode, policy] of [["never-ask", "never"], ["ask", "untrusted"], ["ask-when-needed", "on-request"], ["ask", "untrusted"]] as const) {
      await f.peer.setPermissionMode(mode);
      const completed = f.messages.length;
      await f.peer.deliver([newEnvelope("user", `mode ${mode}`)]);
      await until(() => f.messages.length > completed && f.peer.state === "idle", "Codex policy turn settled");
      expect(f.fake.requests.filter(row => row.method === "turn/start").at(-1).params.approvalPolicy).toBe(policy);
    }
  } finally { await f.close(); }
});

test("P4 Codex: rejected admission is failed_safe; accepted quota failure remains needs_review", async () => {
  const f = await fixture();
  try {
    const refusal = f.peer.deliver([newEnvelope("user", "REFUSE_TURN")], "refusal").catch(error => error);
    await refusal;
    await until(() => f.receipts.some(receipt => receipt.id === "refusal"), "definitive rejection receipt");
    expect(f.receipts.find(receipt => receipt.id === "refusal")?.state).toBe("failed_safe");
    await until(() => f.peer.state === "idle", "Codex refusal releases occupancy");
    await f.peer.deliver([newEnvelope("user", "QUOTA")], "quota");
    await until(() => f.receipts.some(receipt => receipt.id === "quota" && receipt.state === "needs_review"), "accepted quota failure");
    expect(f.usage).toContain(true);
    expect(f.receipts.filter(receipt => receipt.id === "quota").map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(f.messages).toEqual([]);
  } finally { await f.close(); }
});

test("P4 Codex: watchdog fences a late result after observed native acceptance", async () => {
  const f = await fixture();
  try {
    await f.peer.deliver([newEnvelope("user", "SLOW:100")], "old");
    await until(() => f.receipts.some(receipt => receipt.state === "accepted"), "Codex native acceptance");
    expire(f.peer);
    // Forwarded turn/completed is a transport consumption barrier, not a guessed grace delay.
    await until(() => f.seen.some(row => row.method === "turn/completed"), "late result consumed");
    expect(f.messages).toEqual([]);
    expect(f.receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(f.peer.state).toBe("idle");
  } finally { await f.close(); }
});

test("P4 Codex: stopping owns the launcher's group and its native app-server child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conformance-codex-group-")), bin = join(dir, "codex"), launcher = join(dir, "launcher.pid"), native = join(dir, "native.pid");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${quote(launcher)}\ntrap '' TERM\n${quote(process.execPath)} ${quote(join(import.meta.dir, "../fakes/codex-bin.ts"))} "$@" &\necho $! > ${quote(native)}\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const appPort = reservation.port!; reservation.stop(true);
  const peer = createRegisteredPeer<CodexPeer>("codex", { codex: { cwd: dir, bin, appPort, proxyPort: 0 } });
  try {
    await peer.start();
    const leader = Number(readFileSync(launcher, "utf8")), child = Number(readFileSync(native, "utf8"));
    const before = processTable(); expect(before).toBeDefined();
    expect(before!.some(row => row.pid === child && row.pgid === leader)).toBe(true);
    await peer.stop();
    const after = processTable(); expect(after).toBeDefined();
    expect(after!.some(row => row.pid === child || row.pid === leader || row.pgid === leader)).toBe(false);
  } finally { await peer.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

/** Every release and the consuming-proxy barrier are controlled by the test, never by wall-clock sleeps. */
function controlledAppServer() {
  const requests: any[] = [];
  let socket: { send(data: string): unknown } | undefined;
  const send = (message: unknown) => { if (!socket) throw new Error("controlled app-server not attached"); socket.send(JSON.stringify(message)); };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("not a websocket", { status: 400 }); },
    websocket: { message(ws, raw) {
      socket = ws;
      const request = JSON.parse(String(raw)); requests.push(request);
      if (request.method === "initialize") send({ id: request.id, result: { userAgent: "fake-codex/0.154.0" } });
      else if (request.method === "thread/start" || request.method === "thread/resume") send({ id: request.id, result: { thread: { id: request.params.threadId ?? "th1" }, approvalPolicy: "untrusted" } });
      else if (request.method === "account/rateLimits/read") send({ id: request.id, result: { rateLimits: {} } });
      else if (request.method === "conformance/barrier") send({ id: request.id, result: {} });
    } },
  });
  return { url: `ws://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true), send,
    note(method: string, params: Record<string, unknown>) { send({ method, params: { threadId: "th1", ...params } }); },
  };
}
async function barrier(f: Awaited<ReturnType<typeof fixture>>, id: number): Promise<void> {
  f.tui.send(JSON.stringify({ id, method: "conformance/barrier", params: {} }));
  await until(() => f.seen.some(row => row.id === id), "ordered controlled-app-server barrier consumed");
}

test("P4 Codex: accepted-before-start watchdog tombstone survives delayed native start until exact completion", async () => {
  const native = controlledAppServer(), f = await fixture(native);
  try {
    const delivery = f.peer.deliver([newEnvelope("user", "old accepted prompt")], "old-accepted");
    await until(() => native.requests.some(row => row.method === "turn/start"), "native turn request observed");
    const request = native.requests.find(row => row.method === "turn/start");
    native.send({ id: request.id, result: { turn: { id: "retired" } } });
    await delivery; // The fake has deliberately emitted no turn/started.
    expire(f.peer);
    native.note("turn/started", { turn: { id: "retired" } });
    native.note("item/completed", { turnId: "retired", item: { id: "old-answer", type: "agentMessage", text: "must not publish" } });
    await barrier(f, 50);
    expect(f.peer.state).toBe("idle"); expect(f.messages).toEqual([]);
    expect(f.receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    native.note("turn/completed", { turn: { id: "retired", status: "completed" } });
    await barrier(f, 51);
    expect(f.messages).toEqual([]); expect(f.receipts).toHaveLength(2);
  } finally { await f.close(); }
});

for (const acceptance of [true, false]) test(`P4 Codex: invalidated pending ${acceptance ? "acceptance" : "refusal"} never contaminates a newer personal turn or duplicates uncertainty`, async () => {
  const native = controlledAppServer(), f = await fixture(native);
  try {
    const delivery = f.peer.deliver([newEnvelope("user", "cancelled audience")], "pending").catch(error => error as Error);
    await until(() => native.requests.some(row => row.method === "turn/start"), "pending start observed");
    const request = native.requests.find(row => row.method === "turn/start");
    native.note("turn/started", { turn: { id: "old-pending" } });
    await barrier(f, 60);
    expire(f.peer);
    expect((await delivery as Error).message).toContain("watchdog");
    expect(f.receipts.map(receipt => receipt.state)).toEqual(["needs_review"]);
    native.note("turn/started", { turn: { id: "personal-current" } });
    await barrier(f, 61);
    expect(f.peer.state).toBe("busy");
    native.send(acceptance ? { id: request.id, result: { turn: { id: "old-pending" } } } : { id: request.id, error: { message: "turn rejected" } });
    native.note("item/completed", { turnId: "old-pending", item: { id: "old-answer", type: "agentMessage", text: "stale answer" } });
    native.note("turn/completed", { turn: { id: "old-pending", status: "completed" } });
    await barrier(f, 62);
    expect(f.peer.state).toBe("busy"); expect(f.messages).toEqual([]);
    expect(f.receipts.map(receipt => receipt.state)).toEqual(["needs_review"]);
    const replies: unknown[] = [];
    f.peer.onMessage = (text, options) => { f.messages.push(text); replies.push(options?.inReplyTo); };
    native.note("item/completed", { turnId: "personal-current", item: { id: "current-answer", type: "agentMessage", text: "current personal answer" } });
    native.note("turn/completed", { turn: { id: "personal-current", status: "completed" } });
    await barrier(f, 63);
    expect(f.messages).toEqual(["current personal answer"]); expect(replies).toEqual([undefined]);
    expect(f.peer.state).toBe("idle"); expect(f.receipts).toHaveLength(1);
  } finally { await f.close(); }
});

test("P4 Codex: legacy unnamed turn works until cancellation makes its identity ambiguous", async () => {
  const native = controlledAppServer(), f = await fixture(native);
  try {
    native.note("turn/started", { turn: {} });
    native.note("item/completed", { turnId: "legacy", item: { id: "legacy-answer", type: "agentMessage", text: "legacy answer" } });
    native.note("turn/completed", { turn: { id: "legacy", status: "completed" } });
    await barrier(f, 70);
    expect(f.messages).toEqual(["legacy answer"]); expect(f.peer.state).toBe("idle");
    native.note("turn/started", { turn: {} }); await barrier(f, 71);
    expire(f.peer); expect(f.peer.state).toBe("offline");
    native.note("turn/started", { turn: { id: "unattributable-late" } });
    native.note("item/completed", { item: { id: "late", type: "agentMessage", text: "unattributable answer" } });
    native.note("turn/completed", { turn: { id: "unattributable-late", status: "completed" } });
    await barrier(f, 72);
    expect(f.messages).toEqual(["legacy answer"]); expect(f.peer.state).toBe("offline");
    // Adopting a verified session again is the explicit boundary that clears the attribution ceiling.
    f.tui.send(JSON.stringify({ id: 73, method: "thread/resume", params: { threadId: "th1" } }));
    await until(() => f.seen.some(row => row.id === 73), "session reattachment consumed");
    expect(f.peer.state).toBe("idle");
  } finally { await f.close(); }
});
