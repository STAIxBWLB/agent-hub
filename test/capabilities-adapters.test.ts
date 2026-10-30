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
