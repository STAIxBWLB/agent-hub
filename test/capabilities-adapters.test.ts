import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AcpPeer } from "../src/adapters/acp.ts";

const fake = (...flags: string[]) => [process.execPath, join(import.meta.dir, "fakes/commands-acp.ts"), ...flags];
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const started = async (...flags: string[]) => {
  const peer = new AcpPeer("kimi", { cmd: fake(...flags), cwd: process.cwd() });
  cleanups.push(() => peer.stop()); await peer.start();
  return peer;
};
const settled = async (peer: AcpPeer, want: number) => { for (let i = 0; i < 300; i++) { const m = await peer.capabilityManifest(); if (m.capabilities.length >= want) return m; await Bun.sleep(10); } return peer.capabilityManifest(); };

test("a Kimi session's command list becomes capabilities: skills only, no builtin", async () => {
  const peer = await started();
  expect((await settled(peer, 1)).capabilities.map(c => c.id)).toEqual(["command:skill:review"]);
});

test("a list that arrives before session/new is answered still belongs to that session", async () => {
  const peer = await started("--early");
  expect((await settled(peer, 1)).capabilities.map(c => c.id)).toEqual(["command:skill:review"]);
});

test("a list for another session is never taken, before or after the session is bound", async () => {
  const peer = await started("--foreign");
  const m = await settled(peer, 1);
  expect(m.capabilities.map(c => c.id)).toEqual(["command:skill:review"]); // not skill:intruder
});

test("a Qwen session lists its skills by source and never a builtin", async () => {
  const peer = new AcpPeer("qwen", { cmd: fake("--qwen"), cwd: process.cwd() });
  cleanups.push(() => peer.stop()); await peer.start();
  expect((await settled(peer, 1)).capabilities.map(c => c.id)).toEqual(["command:review"]);
});

test("an unprobed agent version lists nothing", async () => {
  const peer = await started("--version", "2.1.1");
  await Bun.sleep(150);
  expect((await peer.capabilityManifest()).capabilities).toEqual([]);
});

test("an offline peer and a restarted one list nothing until the new session sends its own list", async () => {
  const peer = await started();
  await settled(peer, 1);
  await peer.stop();
  expect((await peer.capabilityManifest()).capabilities).toEqual([]); // offline: no stale list
  await peer.start();
  expect((await settled(peer, 1)).capabilities.map(c => c.id)).toEqual(["command:skill:review"]);
});

// ---- Codex: skills/list through the attached connection ----
import { CodexPeer } from "../src/adapters/codex-appserver.ts";

/** A minimal `codex app-server` that reports `version` and answers `skills/list` with `skills` (or never answers, or refuses). */
function fakeCodex(version: string, opts: { skills?: unknown[]; silent?: boolean; refuse?: boolean } = {}) {
  const seen: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { return new URL(req.url).pathname === "/healthz" ? new Response("ok") : srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: { message(ws, data): void {
      const msg = JSON.parse(String(data)); seen.push(msg);
      const reply = (result: unknown): void => { ws.send(JSON.stringify({ id: msg.id, result })); };
      if (msg.method === "initialize") { reply({ userAgent: `codex-tui/${version} (test)`, codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" }); return; }
      if (msg.method === "thread/start") { reply({ thread: { id: "th1" } }); return; }
      if (msg.method === "skills/list") {
        if (opts.silent) return;
        if (opts.refuse) { ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } })); return; }
        reply({ data: [{ cwd: msg.params.cwds?.[0], errors: [], skills: opts.skills ?? [{ name: "imagegen", description: "Make images.", scope: "system", enabled: true }, { name: "off", description: "x", scope: "user", enabled: false }] }] });
      }
    } },
  });
  cleanups.push(() => server.stop(true));
  return { url: `ws://127.0.0.1:${server.port}`, seen };
}
async function codexRig(version: string, opts: Parameters<typeof fakeCodex>[1] = {}, attach = true) {
  const fake = fakeCodex(version, opts);
  const peer = new CodexPeer("codex", { proxyPort: 0, appPort: 0, upstreamUrl: fake.url, cwd: process.cwd() });
  await peer.start(); cleanups.push(() => peer.stop());
  if (attach) {
    const tui = new WebSocket(peer.proxyUrl);
    await new Promise(resolve => (tui.onopen = resolve)); cleanups.push(() => tui.close());
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui" } } }));
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    for (let i = 0; i < 300 && (peer.state !== "idle" || peer.version === undefined); i++) await Bun.sleep(10);
  }
  return { peer, fake };
}

test("Codex 0.166.0 lists its enabled skills through the attached connection, with a hub id and the project cwd", async () => {
  const { peer, fake } = await codexRig("0.166.0");
  const m = await peer.capabilityManifest();
  expect(m.capabilities.map(c => [c.id, c.source, c.invoke])).toEqual([["skill:imagegen", "codex-skills", "native"]]);
  const call = fake.seen.find(x => x.method === "skills/list")!;
  expect(call.id).toBeLessThan(0); // a hub request: its answer never reaches the TUI
  expect(call.params).toEqual({ cwds: [process.cwd()], forceReload: false });
});

test("Codex on any other version lists nothing and does not even ask", async () => {
  const { peer, fake } = await codexRig("0.154.0");
  expect((await peer.capabilityManifest()).capabilities).toEqual([]);
  expect(fake.seen.some(x => x.method === "skills/list")).toBe(false);
});

test("Codex with no attached connection, or a refused or unanswered list, gives no list rather than a stale one", async () => {
  const unattached = await codexRig("0.166.0", {}, false);
  expect((await unattached.peer.capabilityManifest().then(() => "listed", () => "rejected"))).toBe("listed"); // no version seen yet: the pin is not met, an empty manifest
  expect((await unattached.peer.capabilityManifest()).capabilities).toEqual([]);
  const refused = await codexRig("0.166.0", { refuse: true });
  expect(await refused.peer.capabilityManifest().then(() => "listed", e => (e as Error).message)).toBe("method not found");
});
