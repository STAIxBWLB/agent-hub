import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexPeer } from "../src/adapters/codex-appserver.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(): CodexPeer {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-codex-frontend-port-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  return new CodexPeer("codex", { cwd, appPort: 0, proxyPort: 0, bin: "fixture-never-started" });
}

test("#625 Codex frontendProxy is stable while its URL and attachment read current adapter state", () => {
  const peer = fixture(), port = peer.frontendProxy;
  expect(peer.frontendProxy).toBe(port);
  expect(port.url).toBe(peer.proxyUrl); expect(port.url).toBe("ws://127.0.0.1:0");
  expect(port.attached).toBe(false);
  // Pure state seams: no server, socket, native process or user configuration is opened.
  Reflect.set(peer, "server", { port: 12345 });
  expect(port.url).toBe("ws://127.0.0.1:12345"); expect(port.url).toBe(peer.proxyUrl);
  const link = { up: { readyState: WebSocket.OPEN as number } };
  Reflect.set(peer, "link", link);
  expect(port.attached).toBe(true); expect(port.attached).toBe(peer.proxyAttached);
  link.up.readyState = WebSocket.CLOSED;
  expect(port.attached).toBe(false);
  Reflect.set(peer, "link", undefined); Reflect.set(peer, "server", undefined);
  expect(peer.frontendProxy).toBe(port); expect(port.url).toBe("ws://127.0.0.1:0");
});

test("#625 detached frontend callbacks retain their Codex receiver and existing permission behavior", () => {
  const peer = fixture(), { setStartupPermissionMode, clearPermissionMode } = peer.frontendProxy;
  setStartupPermissionMode("ask-when-needed");
  expect(peer.getPermissionMode()).toBe("ask-when-needed");
  expect(clearPermissionMode()).toBe(true); expect(peer.getPermissionMode()).toBe("ask");
  peer.setStartupPermissionMode("never-ask");
  expect(peer.frontendProxy.clearPermissionMode()).toBe(peer.clearPermissionMode());
  expect(peer.getPermissionMode()).toBe("ask");
});

test("#625 frontend startup reconciliation keeps the native unattached, offline and debt guards", () => {
  const peer = fixture(), { setStartupPermissionMode } = peer.frontendProxy;
  Reflect.set(peer, "link", {});
  expect(() => setStartupPermissionMode("never-ask")).toThrow("fresh unattached proxy");
  Reflect.set(peer, "link", undefined); Reflect.set(peer, "_state", "idle");
  expect(() => setStartupPermissionMode("never-ask")).toThrow("fresh unattached proxy");
  Reflect.set(peer, "_state", "offline");
  (Reflect.get(peer, "overriddenApprovals") as Set<string>).add("fixture-thread");
  expect(() => setStartupPermissionMode("never-ask")).toThrow("fresh unattached proxy");
  expect(peer.getPermissionMode()).toBe("ask");
});

test("#625 frontend clear preserves each restoration debt and its unknown-baseline result", () => {
  const peer = fixture(), { clearPermissionMode } = peer.frontendProxy;
  peer.setStartupPermissionMode("never-ask");
  const debt = Reflect.get(peer, "overriddenApprovals") as Set<string>, policies = Reflect.get(peer, "nativeApprovalPolicies") as Map<string, unknown>;
  debt.add("fixture-thread");
  expect(clearPermissionMode()).toBe(false); expect(peer.getPermissionMode()).toBe("ask");
  expect(debt.has("fixture-thread")).toBe(true);
  policies.set("fixture-thread", "on-request");
  expect(clearPermissionMode()).toBe(true);
  expect(debt.has("fixture-thread")).toBe(true);
});

test("#625 revertTurn forwards the native turn and the existing revert promise without another protocol path", async () => {
  const peer = fixture(), calls: string[] = [];
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  peer.revert = function(this: CodexPeer, nativeTurn: string): Promise<void> {
    expect(this).toBe(peer); calls.push(nativeTurn); return pending;
  };
  const result = peer.revertTurn("fixture-native-turn");
  expect(result).toBe(pending); expect(calls).toEqual(["fixture-native-turn"]);
  complete(); await result;
  peer.revert = () => Promise.reject(new Error("fixture revert refusal"));
  await expect(peer.revertTurn("another-turn")).rejects.toThrow("fixture revert refusal");
});

test("#625 unstarted native revert refusals remain identical through the alias", async () => {
  const peer = fixture();
  await expect(peer.revert("fixture-native-turn")).rejects.toThrow("codex is not idle");
  await expect(peer.revertTurn("fixture-native-turn")).rejects.toThrow("codex is not idle");
  expect(peer.state).toBe("offline");
});
