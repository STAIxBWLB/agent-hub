import { afterEach, expect, test } from "bun:test";
import { CodexPeer, type CodexOptions } from "../src/adapters/codex-appserver.ts";
import { Bus } from "../src/hub/bus.ts";
import { DIGEST, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { startFakeAppServer } from "./fakes/app-server.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTable } from "../src/hub/child-process.ts";

const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

async function setup(turnMs?: number, condense?: (envs: Envelope[]) => Promise<Envelope[]>, extra: Partial<CodexOptions> = {}) {
  const fake = startFakeAppServer(turnMs);
  const bus = new Bus({ batchMs: 0, ...(condense ? { condense } : {}) });
  const said: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.env.from === "codex" && said.push(e.env));
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd(), ...extra });
  bus.add(peer);
  await peer.start();
  cleanup.push(fake.stop, () => peer.stop());

  // A minimal TUI: handshake, then start a thread through the proxy.
  const seen: any[] = [];
  const tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
  await new Promise((r) => (tui.onopen = r));
  cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  return { bus, peer, said, tui, seen, fake };
}

test("offline until the TUI starts a thread, then idle", async () => {
  const { peer, tui, seen } = await setup();
  await until(() => seen.some((m) => m.id === 1));
  expect(peer.state).toBe("offline");
  expect(peer.version).toBe("0.154.0"); // from app-server's userAgent: what split records are tagged with (#109)
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  expect(seen.find((m) => m.id === 2).result.thread.id).toBe("th1"); // proxy is transparent
});

test("idle injection uses turn/start with a negative id; only the final answer is shared", async () => {
  const { bus, peer, said, tui, seen } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");

  const env = newEnvelope("claude", "review the diff");
  bus.publish(env);
  await until(() => said.length === 1);
  expect(said[0]!.body).toBe("echo: review the diff");
  expect(said[0]!.hop).toBe(1);
  expect(said[0]!.trace).toBe(env.trace);
  expect(peer.state).toBe("idle");
  // The TUI sees the turn's notifications but never the response to the hub's own request.
  await until(() => seen.some((m) => m.method === "turn/completed")); // forwarded after the hub handled it
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);
});

test("Codex correlates acceptance and silent completion to the native turn id", async () => {
  const { peer, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  const receipts: { id: string; state: string }[] = [];
  peer.onDelivery = (r) => receipts.push({ id: r.id, state: r.state });
  await peer.deliver([newEnvelope("claude", "hello")], "codex-delivery");
  expect(receipts).toEqual([{ id: "codex-delivery", state: "accepted" }]);
  await until(() => receipts.some((r) => r.state === "completed"));
  expect(receipts).toEqual([
    { id: "codex-delivery", state: "accepted" },
    { id: "codex-delivery", state: "completed" },
  ]);
});

test("a turn typed in the TUI makes the peer busy; hub messages queue until turn/completed", async () => {
  const { bus, peer, said, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");

  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "user typed" }] } }));
  await until(() => peer.state === "busy");
  bus.publish(newEnvelope("kimi", "queued one"));
  expect(bus.queued("codex")).toBe(1);

  await until(() => said.length === 2);
  expect(said[0]!.body).toBe("echo: user typed");
  expect(said[0]!.hop).toBe(0); // the user started that turn, not the hub
  expect(said[1]!.body).toBe("echo: queued one");
});

test("important while a turn runs goes in as turn/steer with the running turn's id; status waits for turn/completed", async () => {
  const { bus, peer, said, tui, seen } = await setup(150);
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "long job" }] } }));
  await until(() => peer.state === "busy");

  const urgent = newEnvelope("claude", "wrong branch", { priority: "important", inReplyTo: { trace: "t", hop: 1 } });
  bus.publish(urgent);
  bus.publish(newEnvelope("kimi", "minor note"));
  expect(bus.queued("codex")).toBe(1); // only the status one waits

  await until(() => said.length === 2);
  expect(said[0]!.body).toBe("echo: long job +steered: wrong branch");
  expect(said[0]!.trace).toBe("t"); // the user's turn now also answers the hub
  expect(said[0]!.hop).toBe(urgent.hop + 1);
  expect(said[1]!.body).toBe("echo: minor note");
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);
});

test("a steered high-hop message cannot reset the hop cap, and an unanswered steer comes back to the queue", async () => {
  const { bus, peer, said, tui } = await setup(150);
  const dropped: Envelope[] = [];
  bus.tap((e) => e.t === "envelope" && e.dropped === "hop" && dropped.push(e.env));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");

  bus.publish(newEnvelope("claude", "start", { priority: "important" })); // hub-started turn, hop 0
  await until(() => peer.state === "busy");
  await Bun.sleep(40); // let turn/started announce the turn id
  bus.publish(newEnvelope("kimi", "ping", { priority: "important", inReplyTo: { trace: "loop", hop: 2 } })); // hop 3
  bus.publish(newEnvelope("kimi", "SILENT", { priority: "important" })); // app-server never answers this steer
  await until(() => dropped.length === 1);
  expect(dropped[0]!.body).toBe("echo: start +steered: ping");
  expect(dropped[0]!.hop).toBe(4);

  await until(() => said.length === 2); // the abandoned steer was re-queued and got a turn of its own
  expect(said[1]!.body).toBe("echo: SILENT");
});

test("a refused steer is not lost: it is delivered when the peer goes idle", async () => {
  const { bus, peer, said, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  // busy because the hub claimed the turn, but app-server has not announced a turn id yet: nothing to steer
  bus.publish(newEnvelope("claude", "first"));
  bus.publish(newEnvelope("claude", "urgent", { priority: "important" }));
  await until(() => said.length === 2);
  expect(said.map((e) => e.body)).toEqual(["echo: first", "echo: urgent"]);
});

test("usage: rate limits are read through the TUI's connection without the TUI seeing it; a refused turn reports a hard limit", async () => {
  const fake = startFakeAppServer();
  const bus = new Bus({ batchMs: 0 });
  const usage: { rl: any; hard: boolean }[] = [];
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd(), onUsage: (rl, hard) => usage.push({ rl, hard }) });
  bus.add(peer);
  await peer.start();
  cleanup.push(fake.stop, () => peer.stop());
  const seen: any[] = [];
  const tui = new WebSocket(peer.proxyUrl);
  tui.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
  await new Promise((r) => (tui.onopen = r));
  cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => usage.length === 1);
  expect(usage[0]).toMatchObject({ hard: false, rl: { primary: { usedPercent: 93 } } });
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);

  bus.publish(newEnvelope("claude", "QUOTA", { priority: "important" }));
  await until(() => usage.some((u) => u.hard));
  expect(usage.at(-1)!.rl).toEqual({ rateLimitReachedType: "usageLimitExceeded" });
  await until(() => peer.state === "idle");
});

test("TUI detach takes the peer offline and keeps queued messages", async () => {
  const { bus, peer, tui } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.close();
  await until(() => peer.state === "offline");
  bus.publish(newEnvelope("kimi", "while away"));
  expect(bus.queued("codex")).toBe(1);
});

test("browser origins are refused", async () => {
  const { peer } = await setup();
  const res = await fetch(peer.proxyUrl.replace("ws:", "http:"), { headers: { origin: "https://evil.example" } });
  expect(res.status).toBe(403);
});

test("only one TUI can claim a hub, even before the first thread starts", async () => {
  const { peer, tui } = await setup();
  const second = new WebSocket(peer.proxyUrl);
  const closed = new Promise<CloseEvent>((resolve) => (second.onclose = resolve));
  const event = await closed;
  expect(event.code).toBe(1013);
  expect(event.reason).toContain("already attached");
  tui.close();
});

// issue #3: Codex answered a digest to its highest-hop sender only; every other adapter answers them all.
const busyThenDigest = async (condense?: (envs: Envelope[]) => Promise<Envelope[]>) => {
  const ctx = await setup(120, condense);
  ctx.tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => ctx.peer.state === "idle");
  ctx.tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "own work" }] } }));
  await until(() => ctx.peer.state === "busy");
  ctx.bus.publish(newEnvelope("claude", "question from claude"));
  ctx.bus.publish(newEnvelope("kimi", "status from kimi"));
  await until(() => ctx.said.length === 2); // the TUI's own turn, then the digest turn
  await Bun.sleep(200);
  expect(ctx.said).toHaveLength(2); // both messages went in one delivery
  return ctx.said[1]!;
};

test("an answer to a digest reaches every sender in it", async () => {
  const answer = await busyThenDigest();
  expect(answer.body).toBe("echo: status from kimi"); // the fake echoes the digest's last line
  expect([...(answer.to ?? [])].sort()).toEqual(["claude", "kimi"]);
});

test("an answer to a condensed digest reaches the senders the condensation replaced", async () => {
  const answer = await busyThenDigest(async (envs) => (envs.length < 2 ? envs : [newEnvelope(DIGEST, `condensed ${envs.length}`, { kind: "status" })]));
  expect(answer.body).toBe("echo: condensed 2");
  expect([...(answer.to ?? [])].sort()).toEqual(["claude", "kimi"]);
});

test("a sender steered into a running hub turn is answered too", async () => {
  const { bus, peer, said, tui } = await setup(150);
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope("claude", "start", { priority: "important" }));
  await until(() => peer.state === "busy");
  await Bun.sleep(40); // let turn/started announce the turn id
  bus.publish(newEnvelope("kimi", "also this", { priority: "important" }));
  await until(() => said.length === 1);
  expect(said[0]!.body).toBe("echo: start +steered: also this");
  expect([...(said[0]!.to ?? [])].sort()).toEqual(["claude", "kimi"]);
});

test("a condensed digest with a steer beside it is answered to the condensed senders and the steered one", async () => {
  const { bus, peer, said, tui } = await setup(150, async (envs) => (envs.length < 2 ? envs : [newEnvelope(DIGEST, `condensed ${envs.length}`, { kind: "status" })]));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "own work" }] } }));
  await until(() => peer.state === "busy");
  bus.publish(newEnvelope("claude", "question from claude"));
  bus.publish(newEnvelope("kimi", "status from kimi"));
  await until(() => said.length === 1); // the TUI's own turn ends; the condensed digest goes in next
  await until(() => peer.state === "busy");
  await Bun.sleep(40); // let turn/started announce the digest turn's id
  bus.publish(newEnvelope("pi", "urgent from pi", { priority: "important" }));
  await until(() => said.length === 2);
  expect(said[1]!.body).toBe("echo: condensed 2 +steered: urgent from pi");
  expect([...(said[1]!.to ?? [])].sort()).toEqual(["claude", "kimi", "pi"]);
});

test("a TUI that detaches mid-turn and comes back does not answer the old turn's senders", async () => {
  const { bus, peer, said, tui } = await setup(400);
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope("claude", "hub work", { priority: "important" }));
  await until(() => peer.state === "busy");
  await Bun.sleep(40); // the hub turn is running: its sender is who the turn answers
  tui.close();
  await until(() => peer.state === "offline");
  const tui2 = new WebSocket(peer.proxyUrl);
  await new Promise((r) => (tui2.onopen = r));
  cleanup.push(() => tui2.close());
  tui2.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
  tui2.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  await Bun.sleep(450); // the fake runs one turn at a time: let the abandoned hub turn finish first
  tui2.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "user typed this" }] } }));
  await until(() => said.some((e) => e.body === "echo: user typed this"));
  const answer = said.find((e) => e.body === "echo: user typed this")!;
  expect(answer.to).toBeUndefined();
  expect(answer.hop).toBe(0);
});

// issue #40: Codex reports a running thread total per turn; the adapter passes it on for telemetry.
test("tokens are the thread total's growth: a fresh thread counts from zero, a resumed one from its replayed total, compaction adds none", async () => {
  const added: number[] = [];
  const { bus, peer, tui } = await setup(undefined, undefined, { onTokens: (n) => added.push(n) });
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope("user", "one", { to: ["codex"] }));
  await until(() => added.length === 1 && peer.state === "idle");
  bus.publish(newEnvelope("user", "two COMPACT", { to: ["codex"] }));
  await until(() => added.length === 2 && peer.state === "idle");
  await Bun.sleep(30); // the compaction update came after the turn's own
  expect(added).toEqual([100, 100]);
  // a thread resumed after a hub restart: the replayed total (5000) is its history, not new usage
  tui.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "th-old" } }));
  await until(() => peer.state === "idle");
  await Bun.sleep(30);
  expect(added).toEqual([100, 100]);
  bus.publish(newEnvelope("user", "three", { to: ["codex"] }));
  await until(() => added.length === 3);
  expect(added).toEqual([100, 100, 100]);
});

// issue #33: the hub learns each native turn id, and `ahub undo --context` reverts the conversation through the TUI's link.
test("native turn ids reach onTurn, and revert drops a turn from the thread without reaching the TUI as a response", async () => {
  const native: string[] = [];
  const { bus, peer, tui, seen, fake } = await setup(undefined, undefined, { onTurn: (id) => native.push(id) });
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope("user", "one", { to: ["codex"] }));
  await until(() => native.length === 1 && peer.state === "idle");
  expect(native).toEqual(["turn1"]);
  await peer.revert("turn1");
  expect(fake.reverted).toEqual([{ threadId: "th1", beforeTurnId: "turn1" }]);
  await until(() => seen.some((m) => m.method === "thread/reverted")); // the TUI hears about it
  expect(seen.some((m) => typeof m.id === "number" && m.id < 0)).toBe(false);
});

test("revert is refused while a turn runs", async () => {
  const { bus, peer, tui } = await setup(200);
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  bus.publish(newEnvelope("user", "busy now", { to: ["codex"] }));
  await until(() => peer.state === "busy");
  await expect(peer.revert("turn1")).rejects.toThrow("not idle");
});

// issue #108: completed tool items reach onItem, and a fact goes into the running turn by steer, outside the bus; the
// steered input comes back as a user message item, which is its readback.
test("completed file and command items reach onItem; steerText goes into the running turn, is read back, is refused without one, and can go unanswered", async () => {
  const items: any[] = [];
  const steered: string[] = [];
  let codex: CodexPeer | undefined;
  const { bus, peer, said, tui } = await setup(60, undefined, {
    steerTimeoutMs: 200,
    onItem: (item) => {
      items.push(item);
      if (item.type !== "commandExecution") return;
      void codex!.steerText("agent-hub facts: header\nFACT LINE").then((outcome) => steered.push(outcome));
      void codex!.steerText("SILENT: app-server never answers this one").then((outcome) => steered.push(outcome));
    },
  });
  codex = peer;
  expect(await peer.steerText("no turn yet")).toBe("refused");
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "ITEMS job" }] } }));
  await until(() => said.length === 1);
  expect(items.map((i) => i.type)).toEqual(["fileChange", "commandExecution", "userMessage"]);
  expect(items[0].changes[0].path).toBe("/abs/src/a.ts");
  expect(items[2].content).toEqual([{ type: "text", text: "agent-hub facts: header\nFACT LINE" }]);
  await until(() => steered.length === 2);
  expect(steered).toEqual(["accepted", "unanswered"]); // unanswered: it may have gone in, so it is not dropped
  expect(said[0]!.body).toBe("echo: ITEMS job +steered: FACT LINE");
  expect(bus.queued("codex")).toBe(0);
});

// issue #113: `codex` is a launcher with a native child. The adapter spawns it in a process group of its own and stops
// that group as one; without the group, a launcher that ignores SIGTERM is never signalled and the stop fails.
test("the adapter stops a launcher that ignores SIGTERM together with the native app-server it waits for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-codex-launcher-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "native.pid"), launcherFile = join(dir, "launcher.pid"), bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${launcherFile}\ntrap "" TERM\nbun ${join(import.meta.dir, "fakes/codex-bin.ts")} "$@" &\necho $! > ${pidFile}\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  const freePort = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port as number; s.stop(true); return p; };
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: freePort(), bin, cwd: dir });
  await peer.start();
  const native = Number(readFileSync(pidFile, "utf8")), launcher = Number(readFileSync(launcherFile, "utf8"));
  cleanup.push(() => { for (const pid of [native, launcher]) if (processTable()?.some((r) => r.pid === pid && /codex/.test(r.command))) process.kill(pid, "SIGKILL"); });
  await peer.stop();
  const table = processTable()!;
  expect(table.some((r) => r.pid === native)).toBe(false);
}, 20_000);

// issue #115: a start that fails after the app-server is up stops it and reports its own error, not the stop's.
test("a start that fails after the app-server is up reports its own error and leaves nothing running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-codex-start-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "native.pid"), bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nbun ${join(import.meta.dir, "fakes/codex-bin.ts")} "$@" &\necho $! > ${pidFile}\nwait\n`, { mode: 0o755 });
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  cleanup.push(() => taken.stop(true));
  const freePort = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port as number; s.stop(true); return p; };
  const peer = new CodexPeer("codex", { proxyPort: taken.port as number, appPort: freePort(), bin, cwd: dir });
  cleanup.push(() => peer.stop());
  await expect(peer.start()).rejects.toThrow(String(taken.port));
  const native = Number(readFileSync(pidFile, "utf8"));
  expect(processTable()!.some((r) => r.pid === native)).toBe(false);
}, 20_000);

test("Codex reports active context separately from accumulated usage, including compaction with no new billable tokens", async () => {
  const readings: import("../src/hub/context-window.ts").ContextReading[] = [], tokens: number[] = [];
  const { peer, tui, seen, said } = await setup(5, undefined, { onContext: r => readings.push(r), onTokens: n => tokens.push(n) });
  await until(() => seen.some(m => m.id === 1));
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} })); await until(() => peer.state === "idle");
  await peer.deliver([newEnvelope("kimi", "COMPACT")]); await until(() => said.length === 1 && readings.length >= 2);
  expect(readings.map(r => r.tokens)).toEqual([100, 4000]); expect(readings.every(r => r.sessionId === "th1")).toBe(true);
  expect(readings.every(r => r.used === null && r.window === null)).toBe(true); // native fake has no model window, never guess one
  expect(tokens).toEqual([100]);
});

// #215: the planner tells which turns belong to which thread from these adoptions (a started thread vs a resumed one).
test("each adopted thread is reported with whether the TUI started or resumed it", async () => {
  const threads: [string, boolean][] = [];
  const { peer, tui } = await setup(undefined, undefined, { onThread: (thread, fresh) => threads.push([thread, fresh]) });
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "th-old" } }));
  await until(() => threads.length === 2);
  expect(threads).toEqual([["th1", true], ["th-old", false]]);
});

test("Codex permission modes overlay outgoing turns and ask restores the sticky native default once", async () => {
  const { peer, tui, fake } = await setup();
  const sandboxPolicy = { type: "readOnly" };
  const nativePolicy = { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_approval: true } };
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { approvalPolicy: nativePolicy } }));
  await until(() => peer.state === "idle");
  const turn = async (id: number, approvalPolicy?: unknown) => {
    tui.send(JSON.stringify({ id, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "mode check" }], sandboxPolicy, ...(approvalPolicy === undefined ? {} : { approvalPolicy }) } }));
    await until(() => fake.requests.some((m) => m.id === id));
    await until(() => peer.state === "idle");
    return fake.requests.find((m) => m.id === id).params;
  };
  expect((await turn(3)).approvalPolicy).toBeUndefined();
  await peer.setPermissionMode("ask-when-needed");
  expect((await turn(4)).approvalPolicy).toBe("on-request");
  await peer.setPermissionMode("never-ask");
  expect((await turn(5)).approvalPolicy).toBe("never");
  // Hub-originated turns follow the same operator mode as TUI turns.
  await peer.deliver([newEnvelope("user", "hub turn")]);
  await until(() => peer.state === "idle");
  expect(fake.requests.find((m) => m.method === "turn/start" && m.id < 0).params.approvalPolicy).toBe("never");
  await peer.setPermissionMode("ask");
  expect((await turn(6)).approvalPolicy).toEqual(nativePolicy);
  expect((await turn(7)).approvalPolicy).toBeUndefined();
  for (const request of fake.requests.filter((m) => m.method === "turn/start" && m.id > 0)) expect(request.params.sandboxPolicy).toEqual(sandboxPolicy);
  // A TUI-selected policy while the hub overlays becomes the policy to restore, rather than an earlier default.
  await peer.setPermissionMode("never-ask");
  expect((await turn(8, "on-request")).approvalPolicy).toBe("never");
  await peer.setPermissionMode("ask");
  expect((await turn(9)).approvalPolicy).toBe("on-request");
});

test("Codex permission changes require an adopted proxy session", async () => {
  const { peer } = await setup();
  await expect(peer.setPermissionMode("never-ask")).rejects.toThrow("attach the TUI");
  expect(peer.getPermissionMode()).toBe("ask");
});

test("Codex ask restores the previous native policy on the next hub turn too", async () => {
  const { peer, tui, fake } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "th1", approvalPolicy: "on-request" } }));
  await until(() => peer.state === "idle");
  await peer.setPermissionMode("never-ask");
  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "override" }] } }));
  await until(() => fake.requests.some((m) => m.id === 3));
  await until(() => peer.state === "idle");
  await peer.setPermissionMode("ask");
  await peer.deliver([newEnvelope("user", "restore")]);
  await until(() => peer.state === "idle");
  const restored = fake.requests.find((m) => m.method === "turn/start" && m.id < 0);
  expect(restored.params.approvalPolicy).toBe("on-request");
  await peer.deliver([newEnvelope("user", "native default")]);
  await until(() => peer.state === "idle");
  expect(fake.requests.filter((m) => m.method === "turn/start" && m.id < 0).at(-1).params.approvalPolicy).toBeUndefined();
});

test("Codex initial mode overlays the first TUI turn and unknown baseline refuses ask", async () => {
  const fake = startFakeAppServer(30, 0, undefined, 93, false);
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd(), permissionMode: "never-ask" });
  cleanup.push(fake.stop, () => peer.stop());
  await peer.start();
  const tui = new WebSocket(peer.proxyUrl);
  await new Promise((r) => (tui.onopen = r));
  cleanup.push(() => tui.close());
  tui.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  tui.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "initial" }] } }));
  await until(() => fake.requests.some((m) => m.id === 2));
  await until(() => peer.state === "idle");
  expect(fake.requests.find((m) => m.id === 2).params.approvalPolicy).toBe("never");
  await expect(peer.setPermissionMode("ask")).rejects.toThrow("restart the Codex session");
  await expect(peer.setPermissionMode("ask")).rejects.toThrow("close the TUI, then run ahub permission codex ask");
  expect(peer.getPermissionMode()).toBe("never-ask");
});

test("a rejected Codex restoration is retried on the next turn", async () => {
  const { peer, tui, fake } = await setup();
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => peer.state === "idle");
  await peer.setPermissionMode("never-ask");
  tui.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "override" }] } }));
  await until(() => fake.requests.some((m) => m.id === 3));
  await until(() => peer.state === "idle");
  await peer.setPermissionMode("ask");
  await expect(peer.deliver([newEnvelope("user", "REFUSE_TURN")])).rejects.toThrow("turn rejected");
  await peer.deliver([newEnvelope("user", "retry restore")]);
  await until(() => peer.state === "idle");
  const hubTurns = fake.requests.filter((m) => m.method === "turn/start" && m.id < 0);
  expect(hubTurns.map((m) => m.params.approvalPolicy)).toEqual(["untrusted", "untrusted"]);
});

for (const [mode, policy] of [["ask-when-needed", "on-request"], ["never-ask", "never"]] as const) {
  test(`Codex ${mode} applies to the next hub-originated turn and ask restores native default`, async () => {
    const { peer, tui, fake } = await setup();
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => peer.state === "idle");
    await peer.setPermissionMode(mode);
    await peer.deliver([newEnvelope("user", "mode")]);
    await until(() => peer.state === "idle");
    await peer.setPermissionMode("ask");
    await peer.deliver([newEnvelope("user", "restore")]);
    await until(() => peer.state === "idle");
    await peer.deliver([newEnvelope("user", "default")]);
    await until(() => peer.state === "idle");
    const turns = fake.requests.filter((m) => m.method === "turn/start");
    expect(turns.map((m) => m.params.approvalPolicy)).toEqual([policy, "untrusted", undefined]);
    expect(turns.some((m) => "sandboxPolicy" in m.params)).toBe(false);
  });
}

for (const mode of ["never-ask", "ask-when-needed"] as const) for (const echoPolicy of [false, true]) {
  test(`detached Codex ${mode} debt survives another thread and restores once${echoPolicy ? " with echoed resume policy" : ""}`, async () => {
    const { peer, tui, fake } = await setup();
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { approvalPolicy: "untrusted" } }));
    await until(() => peer.state === "idle");
    await peer.setPermissionMode(mode);
    await peer.deliver([newEnvelope("user", "overlay")]);
    await until(() => peer.state === "idle");
    tui.close();
    await until(() => peer.state === "offline");
    expect(peer.clearPermissionMode()).toBe(true);
    const resumed = new WebSocket(peer.proxyUrl);
    const seen: any[] = [];
    resumed.onmessage = event => seen.push(JSON.parse(String(event.data)));
    await new Promise(resolve => { resumed.onopen = resolve; });
    cleanup.push(() => resumed.close());
    const resume = async (id: number, threadId: string, approvalPolicy: string) => {
      resumed.send(JSON.stringify({ id, method: "thread/resume", params: { threadId, approvalPolicy } }));
      await until(() => seen.some(msg => msg.id === id));
      expect(peer.state).toBe("idle");
    };
    await resume(10, "other-thread", "on-request");
    await peer.deliver([newEnvelope("user", "unrelated native thread")]);
    await until(() => peer.state === "idle");
    expect(fake.requests.filter(msg => msg.method === "turn/start").at(-1).params.approvalPolicy).toBeUndefined();
    // Simulate either native sticky override returned by a resumed app-server.
    await resume(11, "th1", mode === "never-ask" ? "never" : "on-request");
    await expect(peer.deliver([newEnvelope("user", "REFUSE_TURN")])).rejects.toThrow("turn rejected");
    const reportedPolicy = mode === "never-ask" ? "never" : "on-request";
    await resume(12, "th1", reportedPolicy);
    resumed.send(JSON.stringify({ id: 13, method: "turn/start", params: { threadId: "th1", input: [{ type: "text", text: "restore native" }], ...(echoPolicy ? { approvalPolicy: reportedPolicy } : {}) } }));
    await until(() => seen.some(msg => msg.id === 13));
    await until(() => peer.state === "idle");
    expect(fake.requests.find(msg => msg.id === 13).params.approvalPolicy).toBe("untrusted");
    await peer.deliver([newEnvelope("user", "restored native default")]);
    await until(() => peer.state === "idle");
    const turns = fake.requests.filter(msg => msg.method === "turn/start");
    expect(turns.map(msg => msg.params.approvalPolicy)).toEqual([mode === "never-ask" ? "never" : "on-request", undefined, "untrusted", "untrusted", undefined]);
  });
}


for (const mode of ["never-ask", "ask-when-needed"] as const) {
  test(`Codex resume before ask keeps its baseline across echoed ${mode} turns`, async () => {
    const { peer, tui, fake } = await setup();
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: { approvalPolicy: "untrusted" } }));
    await until(() => peer.state === "idle");
    await peer.setPermissionMode(mode);
    await peer.deliver([newEnvelope("user", "original overlay")]);
    await until(() => peer.state === "idle");
    tui.close(); await until(() => peer.state === "offline");
    const resumed = new WebSocket(peer.proxyUrl), seen: any[] = [];
    resumed.onmessage = event => seen.push(JSON.parse(String(event.data)));
    await new Promise(resolve => { resumed.onopen = resolve; });
    cleanup.push(() => resumed.close());
    const policy = mode === "never-ask" ? "never" : "on-request";
    resumed.send(JSON.stringify({ id: 10, method: "thread/resume", params: { threadId: "th1", approvalPolicy: policy } }));
    await until(() => seen.some(msg => msg.id === 10));
    const turn = async (id: number) => {
      resumed.send(JSON.stringify({ id, method: "turn/start", params: { threadId: "th1", approvalPolicy: policy, input: [{ type: "text", text: "echo" }] } }));
      await until(() => seen.some(msg => msg.id === id));
      await until(() => peer.state === "idle");
    };
    await turn(11); // the resumed TUI echoes while the overlay is still selected
    await peer.setPermissionMode("ask");
    await turn(12); // restoration keeps the original despite the repeated echoed value
    await peer.deliver([newEnvelope("user", "native default after restoration")]);
    await until(() => peer.state === "idle");
    expect(fake.requests.filter(msg => msg.method === "turn/start").map(msg => msg.params.approvalPolicy)).toEqual([policy, policy, "untrusted", undefined]);
  });
}


test("a known steer rejection after native completion remains failed_safe", async () => {
  const nativeTurns: string[] = [];
  const wire: string[] = [], receipts: { id: string; state: string; reason?: string }[] = [];
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const msg = JSON.parse(String(data));
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
      const note = (method: string, params: unknown) => ws.send(JSON.stringify({ method, params }));
      if (msg.method === "initialize") return void reply({ userAgent: "codex-cli/0.154.0" });
      if (msg.method === "thread/start") return void reply({ thread: { id: "th1" } });
      if (msg.method === "turn/start") { reply({ turn: { id: "turn1" } }); note("turn/started", { threadId: "th1", turn: { id: "turn1" } }); return; }
      if (msg.method === "turn/steer") {
        // A turn can finish while its steer is in flight. The ordered definitive refusal follows its completion.
        wire.push("turn/completed"); note("turn/completed", { threadId: "th1", turn: { id: "turn1", status: "completed" } });
        wire.push("known steer rejection"); ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } }));
      }
    },
  } });
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: `ws://127.0.0.1:${fake.port}`, cwd: process.cwd(), onTurn: id => nativeTurns.push(id) });
  peer.onDelivery = receipt => receipts.push(receipt);
  let tui: WebSocket | undefined;
  try {
    await peer.start(); tui = new WebSocket(peer.proxyUrl); await new Promise(resolve => tui!.onopen = resolve);
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "late-rejection-fixture" } } }));
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => peer.state === "idle");
    await peer.deliver([newEnvelope("user", "normal")], "normal-delivery");
    await until(() => nativeTurns.includes("turn1"));
    let error = "";
    await peer.steer([newEnvelope("user", "urgent", { priority: "important" })], "late-steer").catch(reason => { error = reason.message; });
    console.log("296 LATE REJECTION", JSON.stringify({ wire, receipts, error }));
    expect(wire).toEqual(["turn/completed", "known steer rejection"]);
    expect(receipts.find(receipt => receipt.id === "late-steer")).toMatchObject({ state: "failed_safe", reason: "no active turn to steer" });
    expect(error).toBe("no active turn to steer");
  } finally { tui?.close(); await peer.stop(); fake.stop(true); }
});

async function lateDurableSteerFixture(answer: "accepted" | "silent", options: Partial<CodexOptions> = {}) {
  const nativeTurns: string[] = [], wire: string[] = [], said: { body: string; opts: any }[] = [];
  const receipts: { id: string; state: string; reason?: string }[] = [];
  let turns = 0;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, data) {
      const msg = JSON.parse(String(data));
      const reply = (result: unknown) => void ws.send(JSON.stringify({ id: msg.id, result }));
      const note = (method: string, params: unknown) => void ws.send(JSON.stringify({ method, params }));
      const finish = (id: string, text: string) => {
        note("item/completed", { threadId: "th1", turnId: id, item: { type: "agentMessage", id: `${id}-answer`, phase: "final_answer", text } });
        wire.push(`completed ${id}`); note("turn/completed", { threadId: "th1", turn: { id, status: "completed" } });
      };
      if (msg.method === "initialize") return reply({ userAgent: "codex-cli/0.154.0" });
      if (msg.method === "thread/start") return reply({ thread: { id: "th1" } });
      if (msg.method === "turn/start") {
        const id = `turn${++turns}`;
        reply({ turn: { id } }); note("turn/started", { threadId: "th1", turn: { id } });
        if (turns > 1) finish(id, "next result");
      }
      if (msg.method === "turn/steer") {
        finish("turn1", "original result");
        if (answer === "accepted") { wire.push("late acceptance"); reply({ turnId: "turn1" }); }
      }
    },
  } });
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: `ws://127.0.0.1:${fake.port}`, cwd: process.cwd(), ...options, onTurn: id => nativeTurns.push(id) });
  peer.onDelivery = receipt => receipts.push(receipt);
  peer.onMessage = (body, opts) => said.push({ body, opts });
  let tui: WebSocket | undefined;
  const stop = async () => { tui?.close(); try { await peer.stop(); } finally { fake.stop(true); } };
  try {
    await peer.start();
    tui = new WebSocket(peer.proxyUrl);
    await new Promise(resolve => tui!.onopen = resolve);
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "late-steer-fixture" } } }));
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => peer.state === "idle");
    await peer.deliver([newEnvelope("user", "normal")], "normal-delivery");
    await until(() => nativeTurns.includes("turn1"));
    return { peer, tui, wire, receipts, said, nativeTurns, stop };
  } catch (error) { await stop(); throw error; }
}

test("durable steer acceptance after native completion is uncertain and never addresses the next turn", async () => {
  const fixture = await lateDurableSteerFixture("accepted");
  try {
    let error = "";
    await fixture.peer.steer([newEnvelope("claude", "urgent", { priority: "important" })], "late-steer").catch(reason => { error = reason.message; });
    expect(fixture.wire).toEqual(["completed turn1", "late acceptance"]);
    expect(fixture.receipts.filter(receipt => receipt.id === "late-steer")).toEqual([{ id: "late-steer", state: "needs_review", reason: "steer accepted after its original native turn ended or changed" }]);
    expect(error).toBe("steer accepted after its original native turn ended or changed");
    expect(fixture.said).toHaveLength(1);
    expect(fixture.said[0]!.opts.to).toEqual(["user"]);
    await fixture.peer.deliver([newEnvelope("kimi", "new work")], "next-delivery");
    await until(() => fixture.said.length === 2 && fixture.peer.state === "idle");
    expect(fixture.said[1]!.body).toBe("next result");
    expect(fixture.said[1]!.opts.to).toEqual(["kimi"]);
    expect(fixture.receipts.filter(receipt => receipt.id === "late-steer")).toHaveLength(1);
  } finally { await fixture.stop(); }
});

/** Control only this request's timeout; ordinary protocol I/O and the inactivity watchdog keep their normal bounds. */
function createControlledSteer(peer: CodexPeer) {
  const original = globalThis.setTimeout;
  let expire!: () => void;
  try {
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 53) { expire = () => callback(...args); return original(() => {}, 300_000); }
      return original(callback, delay, ...args);
    }) as typeof setTimeout;
    let error = "", settled = false;
    const result = peer.steer([newEnvelope("claude", "urgent", { priority: "important" })], "late-steer")
      .then(() => { settled = true; }, reason => { error = reason.message; settled = true; });
    return { expire: () => expire(), result, error: () => error, settled: () => settled };
  } finally { globalThis.setTimeout = original; }
}

test("an unanswered durable steer stays pending past native completion and holds only at its RPC bound", async () => {
  const fixture = await lateDurableSteerFixture("silent", { steerTimeoutMs: 53 });
  try {
    const steer = createControlledSteer(fixture.peer);
    await until(() => fixture.peer.state === "idle" && fixture.wire.includes("completed turn1"));
    expect(steer.settled()).toBe(false);
    expect(fixture.receipts.some(receipt => receipt.id === "late-steer")).toBe(false);
    steer.expire(); await steer.result;
    expect(steer.error()).toBe("steer unanswered: RPC timeout");
    expect(fixture.receipts.filter(receipt => receipt.id === "late-steer")).toEqual([{ id: "late-steer", state: "needs_review", reason: "steer unanswered: RPC timeout" }]);
  } finally { await fixture.stop(); }
});

for (const interruption of ["detach", "thread change", "stop"] as const) test(`a pending durable steer is held and its timer is cleared on ${interruption}`, async () => {
  const fixture = await lateDurableSteerFixture("silent", { steerTimeoutMs: 53 });
  try {
    const steer = createControlledSteer(fixture.peer);
    await until(() => fixture.peer.state === "idle" && fixture.wire.includes("completed turn1"));
    if (interruption === "detach") fixture.tui.close();
    else if (interruption === "thread change") fixture.tui.send(JSON.stringify({ id: 3, method: "thread/start", params: {} }));
    else await fixture.peer.stop();
    await steer.result;
    expect(steer.settled()).toBe(true); expect(steer.error()).not.toBe("steer unanswered: RPC timeout");
    expect(fixture.receipts.filter(receipt => receipt.id === "late-steer")).toHaveLength(1);
    expect(fixture.receipts.find(receipt => receipt.id === "late-steer")!.state).toBe("needs_review");
    expect(fixture.receipts.some(receipt => receipt.id === "late-steer")).toBe(true);
    const before = fixture.receipts.length;
    steer.expire(); await Promise.resolve();
    expect(fixture.receipts).toHaveLength(before);
  } finally { await fixture.stop(); }
});
