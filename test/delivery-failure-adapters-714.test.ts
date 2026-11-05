import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpPeer } from "../src/adapters/acp.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";

class WatchdogPeer extends AcpPeer {
  expireWatchdog(): void { this.onWatchdog(); }
}

test("an accepted ACP turn records a typed timeout at watchdog expiry and no late duplicate (#1178)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-failure-watchdog-714-"));
  const peer = new WatchdogPeer("kimi", {
    cwd: root,
    cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts"), "--mode-after-cancel"],
  });
  const receipts: DeliveryReceipt[] = [];
  let accepted!: () => void;
  const acceptance = new Promise<void>(resolve => { accepted = resolve; });
  peer.onDelivery = receipt => {
    receipts.push(receipt);
    if (receipt.id === "watchdog-delivery" && receipt.state === "accepted") accepted();
  };
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "ACK_SLOW private-body-canary", { to: ["kimi"] })], "watchdog-delivery");
    await acceptance;
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted"]);
    peer.expireWatchdog();
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(receipts.at(-1)?.failureCause).toBe("timeout");
    expect(JSON.stringify(receipts)).not.toContain("private-body-canary");
    // The fake answers this RPC after the cancelled result, proving it was consumed.
    await peer.setPermissionMode("ask");
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]);
    expect(peer.state).toBe("offline");
  } finally {
    await peer.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

class WatchdogCodexPeer extends CodexPeer {
  expireWatchdog(): void { this.onWatchdog(); }
}

test("a Codex pending native acceptance keeps watchdog timeout on its first receipt and ignores late acceptance (#1178)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-pending-watchdog-714-"));
  let entered!: () => void;
  const pendingStart = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const native = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("fixture"); },
    websocket: { message(socket, raw) {
      const message = JSON.parse(String(raw));
      if (message.method === "thread/start") socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "pending-thread" } } }));
      else if (message.method === "turn/start") {
        release = () => {
          socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "late-turn" } } }));
          socket.send(JSON.stringify({ method: "turn/started", params: { threadId: "pending-thread", turn: { id: "late-turn" } } }));
          socket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "pending-thread", turn: { id: "late-turn", status: "completed" } } }));
          socket.send(JSON.stringify({ method: "fixture/consumed", params: {} }));
        };
        entered();
      } else if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
    } },
  });
  const peer = new WatchdogCodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: `ws://127.0.0.1:${native.port}`, cwd: root });
  const receipts: DeliveryReceipt[] = [];
  peer.onDelivery = receipt => { receipts.push(receipt); };
  let tui: WebSocket | undefined;
  try {
    await peer.start();
    tui = new WebSocket(peer.proxyUrl);
    await new Promise<void>(resolve => { tui!.onopen = () => resolve(); });
    const adopted = new Promise<void>(resolve => {
      tui!.onmessage = event => { if (JSON.parse(String(event.data)).id === 1) resolve(); };
    });
    tui.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
    await adopted;
    const result = peer.deliver([newEnvelope("user", "private-pending-canary", { to: ["codex"] })], "pending-delivery")
      .then(() => "accepted", error => error.message);
    await pendingStart;
    expect(peer.state).toBe("busy");
    expect(receipts).toEqual([]);
    peer.expireWatchdog();
    expect(await result).toBe("Codex turn watchdog timeout before native acceptance was confirmed");
    expect(receipts.map(receipt => receipt.state)).toEqual(["needs_review"]);
    expect(receipts[0]?.failureCause).toBe("timeout");
    expect(JSON.stringify(receipts)).not.toContain("private-pending-canary");
    const consumed = new Promise<void>(resolve => {
      tui!.onmessage = event => { if (JSON.parse(String(event.data)).method === "fixture/consumed") resolve(); };
    });
    release();
    await consumed;
    expect(receipts.map(receipt => receipt.state)).toEqual(["needs_review"]);
    expect(peer.state).toBe("offline");
  } finally {
    tui?.close();
    await peer.stop();
    native.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const expiry of ["watchdog", "post-turn RPC timeout"] as const) test(`a pending Codex steer records typed timeout on ${expiry} (#1178)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-steer-timeout-714-"));
  let entered!: () => void, started!: () => void, armed!: () => void;
  const pendingSteer = new Promise<void>(resolve => { entered = resolve; });
  const nativeStarted = new Promise<void>(resolve => { started = resolve; });
  const timerArmed = new Promise<void>(resolve => { armed = resolve; });
  let finish!: () => void, release!: () => void, expire!: () => void;
  const native = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("fixture"); },
    websocket: { message(socket, raw) {
      const message = JSON.parse(String(raw));
      const note = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params }));
      if (message.method === "thread/start") socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "steer-thread" } } }));
      else if (message.method === "turn/start") {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: "steer-turn" } } }));
        note("turn/started", { threadId: "steer-thread", turn: { id: "steer-turn" } });
        finish = () => note("turn/completed", { threadId: "steer-thread", turn: { id: "steer-turn", status: "completed" } });
      } else if (message.method === "turn/steer") {
        release = () => {
          socket.send(JSON.stringify({ id: message.id, result: { turnId: "steer-turn" } }));
          note("fixture/consumed", {});
        };
        entered();
      } else if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
    } },
  });
  const peer = new WatchdogCodexPeer("codex", {
    proxyPort: 0, appPort: 0, upstreamUrl: `ws://127.0.0.1:${native.port}`, cwd: root,
    steerTimeoutMs: 53, onTurn: () => started(),
  });
  const receipts: DeliveryReceipt[] = [];
  peer.onDelivery = receipt => { receipts.push(receipt); };
  const originalSet = globalThis.setTimeout;
  const timerHandles: ReturnType<typeof setTimeout>[] = [];
  let tui: WebSocket | undefined;
  try {
    await peer.start();
    tui = new WebSocket(peer.proxyUrl);
    await new Promise<void>(resolve => { tui!.onopen = () => resolve(); });
    const adopted = new Promise<void>(resolve => {
      tui!.onmessage = event => { if (JSON.parse(String(event.data)).id === 1) resolve(); };
    });
    tui.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
    await adopted;
    await peer.deliver([newEnvelope("user", "ordinary")], "original-delivery");
    await nativeStarted;
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay !== 53) return originalSet(callback, delay, ...args);
      const handle = originalSet(() => {}, 300_000);
      timerHandles.push(handle);
      expire = () => callback(...args);
      armed();
      return handle;
    }) as typeof setTimeout;
    const result = peer.steer([newEnvelope("user", "steer-private-canary", { priority: "important" })], "pending-steer")
      .then(() => "accepted", error => error.message);
    await pendingSteer;
    if (expiry === "watchdog") peer.expireWatchdog();
    else { finish(); await timerArmed; expire(); }
    expect(await result).toBe(expiry === "watchdog" ? "steer unanswered: turn went silent" : "steer unanswered: RPC timeout");
    const failed = receipts.filter(receipt => receipt.id === "pending-steer");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.state).toBe("needs_review");
    expect(failed[0]?.failureCause).toBe("timeout");
    expect(JSON.stringify(failed)).not.toContain("steer-private-canary");
    const consumed = new Promise<void>(resolve => {
      tui!.onmessage = event => { if (JSON.parse(String(event.data)).method === "fixture/consumed") resolve(); };
    });
    release();
    await consumed;
    expect(receipts.filter(receipt => receipt.id === "pending-steer")).toHaveLength(1);
  } finally {
    globalThis.setTimeout = originalSet;
    for (const handle of timerHandles) clearTimeout(handle);
    tui?.close();
    await peer.stop();
    native.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
