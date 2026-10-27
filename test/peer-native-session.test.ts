import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpPeer } from "../src/adapters/acp.ts";
import { PiPeer } from "../src/adapters/pi.ts";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";
import { WsPeer } from "../src/adapters/channel-peer.ts";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { ReviewerPrintPeer } from "../src/adapters/reviewer-print.ts";
import { ClaudeImplementerPeer } from "../src/adapters/claude-implementer.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ahub-native-session-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function pi(root: string): PiPeer {
  return new PiPeer("pi", { cwd: root, stateDir: root, mode: "headless", backend: "dgx", cmd: ["fixture-never-started"],
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture-only", models: [] }, tools: [], executeTool: async () => "fixture only" });
}

test("#625 ACP nativeSession matches the existing metadata reader before and after a bound session", () => {
  const peer = new AcpPeer("kimi", { cwd: scratch(), cmd: ["fixture-never-started"] });
  expect(peer.state).toBe("offline");
  expect(peer.nativeSession).toBeUndefined();
  // Supply only protocol-observed fields, without starting any native process or opening a user home.
  Reflect.set(peer, "sessionId", "fixture-acp-session");
  expect<unknown>(peer.nativeSession).toBe(peer.recoveryMetadata().sessionId);
  expect(peer.nativeSession).toBe("fixture-acp-session");
  Reflect.set(peer, "sessionId", "");
  expect(peer.nativeSession).toBeUndefined();
});

test("#625 ACP nativeSession preserves an explicitly empty metadata string and refuses non-string metadata", () => {
  const peer = new AcpPeer("kimi", { cwd: scratch(), cmd: ["fixture-never-started"] });
  Reflect.set(peer, "sessionId", "private-field-must-not-bypass-reader");
  peer.recoveryMetadata = () => ({ sessionId: "" });
  expect(peer.nativeSession).toBe("");
  peer.recoveryMetadata = () => ({ sessionId: 7 });
  expect(peer.nativeSession).toBeUndefined();
  peer.recoveryMetadata = () => ({});
  expect(peer.nativeSession).toBeUndefined();
});

test("#625 Pi nativeSession preserves the metadata reader's persisted-session side effects", () => {
  const root = scratch(), peer = pi(root);
  expect(peer.nativeSession).toBeUndefined();
  Reflect.set(peer, "sessionId", "fixture-pi-session");
  const file = join(root, "fixture-pi-session.jsonl"); writeFileSync(file, "{}\n");
  Reflect.set(peer, "sessionFile", file);
  Reflect.set(peer, "verifiedEmptyResume", { sessionId: "fixture-pi-session" });
  expect(Reflect.get(peer, "persistedOnce")).toBe(false);
  expect(peer.nativeSession).toBe("fixture-pi-session");
  expect(Reflect.get(peer, "persistedOnce")).toBe(true);
  expect(Reflect.get(peer, "verifiedEmptyResume")).toBeUndefined();
  expect<unknown>(peer.nativeSession).toBe(peer.recoveryMetadata().sessionId);
  expect(peer.state).toBe("offline");
});

test("#625 Pi nativeSession keeps the metadata string check, including empty and unknown values", () => {
  const peer = pi(scratch());
  peer.recoveryMetadata = () => ({ sessionId: "" });
  expect(peer.nativeSession).toBe("");
  peer.recoveryMetadata = () => ({ sessionId: undefined });
  expect(peer.nativeSession).toBeUndefined();
  peer.recoveryMetadata = () => ({ sessionId: false });
  expect(peer.nativeSession).toBeUndefined();
});

test("#625 Codex nativeSession is its current thread or undefined when no thread is bound", () => {
  const peer = new CodexPeer("codex", { cwd: scratch(), appPort: 0, proxyPort: 0, bin: "fixture-never-started" });
  expect(peer.nativeSession).toBeUndefined();
  Reflect.set(peer, "threadId", "fixture-codex-thread");
  expect(peer.nativeSession).toBe(peer.thread);
  expect(peer.nativeSession).toBe("fixture-codex-thread");
  Reflect.set(peer, "threadId", "");
  expect(peer.nativeSession).toBeUndefined();
  expect(peer.state).toBe("offline");
});

test("#625 local, reviewer, channel and Claude implementer keep nativeSession absent", () => {
  const root = scratch();
  const local = new LocalPeer("local", { cwd: root, omni: new OmniRoute({ urls: [], access_hosts: [] }), fixedModel: "fixture-only", tools: { deny: [], permit: async () => false } });
  const reviewer = new ReviewerPrintPeer("claude-review", { cwd: root, mcpConfig: "{}", systemPrompt: "fixture-only", watchdogMs: 5000,
    backend: { id: "fixture", prepare: async () => { throw new Error("native reviewer must never start in a session-port test"); } }, verdictSince: () => false });
  const implementer = new ClaudeImplementerPeer("claude-worker", { cwd: root, stateDir: root, projectRoot: root, instanceId: "fixture-instance", server: join(root, "server.js"), factsHook: join(root, "hook.ts"), systemPrompt: "fixture-only", watchdogMs: 5000,
    command: ["fixture-never-started"], admit: () => false, chatTask: () => undefined, prove: async () => { throw new Error("native implementer must never start in a session-port test"); } });
  expect(typeof local.recoveryMetadata().sessionId).toBe("string");
  for (const peer of [local, reviewer, new WsPeer("claude"), implementer] as PeerAdapter[]) {
    expect("nativeSession" in peer, peer.id).toBe(false);
    expect(peer.nativeSession, peer.id).toBeUndefined();
    expect(peer.state, peer.id).toBe("offline");
  }
});
