import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brokerDropOptions, brokerOptions } from "../src/cli/broker.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { HELP, helpCommands } from "../src/cli/help.ts";
import { encodeBase64url, generateHubIdentity } from "../src/rooms/crypto.ts";
import { acceptRoomEpoch, createRoomEpoch, openFrame, sealFrame } from "../src/rooms/wire.ts";
import { BrokerStore } from "../src/broker/store.ts";
import { FakeBrokerClient } from "./fakes/broker-client.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const roots: string[] = [];
const running: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const process of running.splice(0)) { if (process.exitCode === null) process.kill("SIGTERM"); await process.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-broker-cli-")); roots.push(root);
  const env: Record<string, string | undefined> = { ...process.env, HOME: join(root, "home"), AGENTHUB_HOME: join(root, "ahub"), KIMI_CODE_HOME: join(root, "kimi") };
  for (const name of ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_PEER_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_DELIVERY_ONLY"]) delete env[name];
  return { root, env, stateDir: join(root, "broker-state") };
}

test("broker serve parser and help agree, and all broker forms stay person-only including live-test", async () => {
  expect(HELP.flatMap(helpCommands).includes("broker")).toBe(true);
  expect(brokerOptions(["serve", "--port", "0", "--state-dir", "/tmp/test-broker-state"], "/tmp/default")).toMatchObject({ port: 0, stateDir: "/tmp/test-broker-state" });
  for (const args of [[], ["serve", "--port"], ["serve", "--port", "65536"], ["serve", "--port", "1e3"], ["serve", "--port", "1", "--port", "2"], ["status"]]) expect(() => brokerOptions(args, "/tmp/unused")).toThrow("usage:");
  expect(classifyPeerCommand("broker", ["serve"])).toBe("console");
  expect(liveTestRefusal("broker", ["serve"])).toBe(true);
  const roomId = encodeBase64url(new Uint8Array(32));
  expect(brokerOptions(["serve", "--owner", "1".repeat(64), "--owner", "2".repeat(64)], "/tmp/default").owners).toEqual(["1".repeat(64), "2".repeat(64)]);
  expect(() => brokerDropOptions(["room", "drop", roomId], "/tmp/default")).toThrow("usage:");
  expect(brokerDropOptions(["room", "drop", roomId, "--yes"], "/tmp/default")).toMatchObject({ room: roomId });
  expect(cliCommandLabel("broker", ["room", "drop", roomId, "--yes"])).toBe("broker room drop");
  expect(cliCommandLabel("broker", ["serve", "--state-dir", "private-state"])).toBe("broker serve");
  const f = fixture();
  const markers: Record<string, string>[] = [{ CODEX_THREAD_ID: "test" }, { CLAUDECODE: "1" }, { AGENTHUB_PEER_ID: "codex" }];
  for (const marker of markers) for (const prefix of [[], ["--live-test"]]) for (const action of [["serve", "--port", "0"], ["room", "drop", roomId, "--yes"]]) {
    const child = Bun.spawn([process.execPath, CLI, ...prefix, "broker", ...action, "--state-dir", f.stateDir], { cwd: f.root, env: { ...f.env, ...marker }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    running.push(child);
    const guard = setTimeout(() => child.kill("SIGTERM"), 10_000);
    const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(guard));
    expect(code).not.toBe(0); expect(out).not.toContain("listening"); expect(error).toContain(prefix.length ? "live-test cannot" : "agent"); expect(existsSync(f.stateDir)).toBe(false);
  }
});

test("a separate broker CLI process receives only sealed canary data and stops without changing the hub daemon", async () => {
  const f = fixture();
  const child = Bun.spawn([process.execPath, CLI, "broker", "serve", "--port", "0", "--state-dir", f.stateDir], { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  running.push(child);
  let startupResolve!: (url: string) => void, startupReject!: (error: Error) => void;
  const startup = new Promise<string>((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
  const timer = setTimeout(() => { child.kill("SIGTERM"); startupReject(new Error("broker CLI startup timeout")); }, 10_000);
  const stdout = (async () => {
    let all = ""; const reader = child.stdout.getReader(), decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; all += decoder.decode(value); const url = /broker listening at (ws:\/\/\S+\/)/.exec(all)?.[1]; if (url) { clearTimeout(timer); startupResolve(url); } }
    return all;
  })();
  const stderr = new Response(child.stderr).text();
  void child.exited.then(() => { clearTimeout(timer); startupReject(new Error("broker CLI exited before ready")); });
  const url = await startup;
  const owner = await generateHubIdentity(), guest = await generateHubIdentity();
  const epoch = await createRoomEpoch({ owner, members: [{ ...owner.public, label: "owner", exposedPeers: [] }, { ...guest.public, label: "guest", exposedPeers: [] }] });
  const client = await FakeBrokerClient.connect(url, epoch.epoch.room);
  try {
    await client.authenticate(owner, epoch.wire);
    const canary = `private body ${crypto.randomUUID()}`;
    // The encrypting client is in this test process, not in the broker child.
    const wire = await sealFrame({ epoch: epoch.epoch, identity: owner, recipients: [guest.public.fingerprint], plaintext: new TextEncoder().encode(canary), sequence: { reserve: async () => "1", isCurrent: () => true } });
    expect(Buffer.from(wire).includes(Buffer.from(canary))).toBe(false);
    client.send(wire); await client.take("stored");
    const recipient = await FakeBrokerClient.connect(url, epoch.epoch.room);
    try {
      await recipient.authenticate(guest);
      const guestEpoch = await acceptRoomEpoch({ wire: epoch.wire, identity: guest, pin: { room: epoch.epoch.room, owner: owner.public.fingerprint, minEpoch: "0" } });
      const delivered = await recipient.take("frame");
      const opened = await openFrame({ wire: delivered, identity: guest, current: guestEpoch, replay: { accept: async () => ({ status: "accepted", gap: "0" }) } });
      expect(opened.status).toBe("accepted");
      if (opened.status === "accepted") expect(new TextDecoder().decode(opened.plaintext)).toBe(canary);
    } finally { recipient.close(); }
    for (const name of readdirSync(f.stateDir)) expect(readFileSync(join(f.stateDir, name)).includes(Buffer.from(canary))).toBe(false);
    const busyDrop = Bun.spawn([process.execPath, CLI, "broker", "room", "drop", epoch.epoch.room, "--yes", "--state-dir", f.stateDir], { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    running.push(busyDrop);
    const [busyCode, , busyError] = await Promise.all([busyDrop.exited, new Response(busyDrop.stdout).text(), new Response(busyDrop.stderr).text()]);
    expect(busyCode).not.toBe(0); expect(busyError).toContain("busy");
    client.close(); child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await stdout).not.toContain(canary); expect(await stderr).not.toContain(canary);
    const drop = Bun.spawn([process.execPath, CLI, "broker", "room", "drop", epoch.epoch.room, "--yes", "--state-dir", f.stateDir], { cwd: f.root, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    running.push(drop);
    const [dropCode, dropOut, dropErr] = await Promise.all([drop.exited, new Response(drop.stdout).text(), new Response(drop.stderr).text()]);
    expect({ code: dropCode, error: dropErr }).toEqual({ code: 0, error: "" });
    expect(dropOut).toContain(`broker room dropped: ${epoch.epoch.room}`);
    const inspect = await BrokerStore.open({ stateDir: f.stateDir, create: false });
    try { expect(inspect.stats()).toEqual({ rooms: 0, queuedFrames: 0, queuedBytes: 0 }); }
    finally { inspect.close(); }
  } finally { client.close(); clearTimeout(timer); }
});
