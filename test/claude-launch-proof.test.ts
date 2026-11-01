import { afterEach, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClaudeLaunchProof, readClaudeLaunchProof } from "../src/hub/claude-launch-proof.ts";
import { claudeStateFile } from "../src/hub/claude-state.ts";
import { BasePeer, type PeerAdapter } from "../src/hub/peers.ts";
import { WsPeer, type ChannelSocket } from "../src/adapters/channel-peer.ts";
import { definitionOf, type AdapterDefinition } from "../src/adapters/registry.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-claude-launch-proof-")), cwd = join(stateDir, "project"), instanceId = "fixture-instance";
  cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const peers = new Map<string, PeerAdapter>(), definitions = new Map<string, AdapterDefinition>();
  const lookup = (peer: string) => definitions.get(peer) ?? (peer.startsWith("claude-") ? definitionOf("claude") : definitionOf(peer));
  const proof = createClaudeLaunchProof({ stateDir, cwd, instanceId, definitionOf: lookup, peer: id => peers.get(id) });
  const file = (peer = "claude") => join(stateDir, claudeStateFile("claude-launch", peer));
  const record = (peer = "claude", extra: Record<string, unknown> = {}) => {
    writeFileSync(file(peer), JSON.stringify({ instanceId, launchId: `managed-${peer}`, permissionHook: true, ...extra }), { mode: 0o600 });
    return file(peer);
  };
  const rows = (value: unknown) => writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify(value), { mode: 0o600 });
  return { stateDir, cwd, instanceId, peers, definitions, proof, file, record, rows };
}
function socket(launchId = "fixture-launch"): ChannelSocket {
  return { readyState: WebSocket.OPEN, data: { launchId }, send: () => {}, close() { this.readyState = WebSocket.CLOSED; } };
}
function attached(id: string): { peer: WsPeer; sock: ChannelSocket } {
  const peer = new WsPeer(id), sock = socket();
  peer.claim(sock); peer.attach(sock);
  return { peer, sock };
}
class PlainPeer extends BasePeer {
  constructor(id: string, readonly sessionGeneration: string) { super(id); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async deliver(_envs: Envelope[]): Promise<void> {}
}

test("#625 launch proof reads each instance's permission-bearing record without changing raw metadata", () => {
  const f = fixture();
  f.record("claude", { executionCwd: "/fixture/worktree", unattended: true, hookPurpose: "permission" });
  f.record("claude-one", { launchId: "one-launch", permissionHook: false });
  f.record("claude-two", { launchId: "two-launch" });
  expect(readClaudeLaunchProof(f.stateDir, "claude", f.instanceId)).toMatchObject({ executionCwd: "/fixture/worktree", privateRecord: true });
  expect(f.proof.permissionLaunch("claude")).toMatchObject({ launchId: "managed-claude", unattended: true, hookPurpose: "permission" });
  expect(f.proof.permissionLaunch("claude-one")).toBeUndefined();
  expect(f.proof.permissionLaunch("claude-two")?.launchId).toBe("two-launch");
  expect(f.proof.permissionLaunch("claude-three")).toBeUndefined();
  chmodSync(f.file(), 0o644);
  expect(readClaudeLaunchProof(f.stateDir, "claude", f.instanceId)?.privateRecord).toBe(false);
  expect(f.proof.permissionLaunch("claude")?.launchId).toBe("managed-claude");
});

test("#625 raw launch reader retains its no-follow, 16 KiB, instance and private-record behavior", () => {
  const f = fixture(), file = f.record();
  for (const row of ["not JSON", JSON.stringify({ instanceId: "another-instance", launchId: "foreign", permissionHook: true }),
    JSON.stringify({ instanceId: f.instanceId, launchId: "" }), JSON.stringify({ instanceId: f.instanceId, launchId: "x".repeat(129) }), " ".repeat(16385)]) {
    writeFileSync(file, row); expect(readClaudeLaunchProof(f.stateDir, "claude", f.instanceId)).toBeUndefined();
    expect(f.proof.permissionLaunch("claude")).toBeUndefined();
  }
  f.record("claude", { executionCwd: "relative-worktree" });
  expect(readClaudeLaunchProof(f.stateDir, "claude", f.instanceId)?.executionCwd).toBeUndefined();
  linkSync(file, join(f.stateDir, "linked-record"));
  expect(readClaudeLaunchProof(f.stateDir, "claude", f.instanceId)?.privateRecord).toBe(false);
  rmSync(file); symlinkSync(join(f.stateDir, "linked-record"), file);
  expect(readClaudeLaunchProof(f.stateDir, "claude", f.instanceId)).toBeUndefined();
});

test("#625 hello launch mismatch refuses only with current record evidence and preserves first-launch admission (#604 item 10: an absent id is no longer admitted once a record exists)", () => {
  const f = fixture();
  for (const launch of [undefined, "missing-record", null, 7]) expect(f.proof.helloLaunch("claude", launch)).toBe("admit");   // no record yet: a first launch or a plain session
  f.record();
  expect(f.proof.helloLaunch("claude", undefined)).toBe("refuse");                    // was "admit": a hello with no launch id could join a peer id that has a managed launch
  expect(f.proof.helloLaunch("claude", "managed-claude")).toBe("admit");
  for (const launch of ["older-launch", "", null, 7, { launchId: "managed-claude" }]) expect(f.proof.helloLaunch("claude", launch)).toBe("refuse");
  f.record("claude", { instanceId: "older-instance" });
  expect(f.proof.helloLaunch("claude", "older-launch")).toBe("admit");
});

test("#625 expected facts launch selects the matching Orca row, then the managed launch overrides it", () => {
  const f = fixture();
  expect(f.proof.expectedLaunch("claude")).toBeUndefined();
  f.rows([
    { peer: "claude-one", projectRoot: f.cwd, instanceId: f.instanceId, launchId: "sibling" },
    { peer: "claude", projectRoot: "/different-project", instanceId: f.instanceId, launchId: "foreign-project" },
    { peer: "claude", projectRoot: f.cwd, instanceId: "foreign-instance", launchId: "foreign-instance" },
    { peer: "claude", projectRoot: f.cwd, instanceId: f.instanceId, launchId: "orca-launch" },
    { peer: "claude", projectRoot: f.cwd, instanceId: f.instanceId, launchId: "later-duplicate" },
  ]);
  expect(f.proof.expectedLaunch("claude")).toBe("orca-launch");
  expect(f.proof.expectedLaunch("claude-one")).toBe("sibling");
  f.record("claude", { launchId: "managed-override", permissionHook: false });
  expect(f.proof.expectedLaunch("claude")).toBe("managed-override");
  f.record("claude", { instanceId: "foreign-instance" });
  expect(f.proof.expectedLaunch("claude")).toBe("orca-launch");
});

test("#625 expected launch preserves terminal-row value and read-bound compatibility", () => {
  const f = fixture();
  f.rows([{ padding: "x".repeat(17_000) }, { peer: "claude", projectRoot: f.cwd, instanceId: f.instanceId, launchId: 17 }]);
  // The extraction does not add validation or the managed record's 16 KiB ceiling to Orca recovery rows.
  expect(f.proof.expectedLaunch("claude") as unknown).toBe(17);
  f.rows({ peer: "claude", projectRoot: f.cwd, instanceId: f.instanceId, launchId: "not-an-array" });
  expect(f.proof.expectedLaunch("claude")).toBeUndefined();
  writeFileSync(join(f.stateDir, "terminal-recovery.json"), "not JSON");
  expect(f.proof.expectedLaunch("claude")).toBeUndefined();
});

test("#625 only a fixed builtin Claude channel's actual WsPeer can bind and verify its generation", () => {
  const f = fixture(), { peer } = attached("claude");
  const plain = new PlainPeer("claude", peer.sessionGeneration);
  f.peers.set("claude", plain);
  f.proof.bindGeneration("claude", plain.sessionGeneration);
  expect(f.proof.owner("claude")).toBeUndefined(); expect(f.proof.verified("claude")).toBe(false);
  f.peers.set("claude", peer);
  expect(f.proof.owner("claude")).toBe(peer); expect(f.proof.verified("claude")).toBe(false);
  f.proof.bindGeneration("claude", peer.sessionGeneration);
  expect(f.proof.verified("claude")).toBe(true);
  f.definitions.set("claude", { ...definitionOf("claude")! });
  expect(f.proof.owner("claude")).toBeUndefined(); expect(f.proof.verified("claude")).toBe(false);
});

test("#625 copied definitions and non-channel fixed variants cannot read or claim Claude launch proof", () => {
  const f = fixture(), { peer } = attached("claude");
  f.record(); f.peers.set("claude", peer);
  f.rows([{ peer: "claude", projectRoot: f.cwd, instanceId: f.instanceId, launchId: "orca" }]);
  for (const definition of [{ ...definitionOf("claude")! }, definitionOf("claude")!.headlessVariant!, definitionOf("agy")!]) {
    f.definitions.set("claude", definition);
    expect(f.proof.permissionLaunch("claude")).toBeUndefined();
    expect(f.proof.helloLaunch("claude", "older-launch")).toBe("admit");
    expect(f.proof.expectedLaunch("claude")).toBeUndefined();
    expect(f.proof.owner("claude")).toBeUndefined();
    f.proof.bindGeneration("claude", peer.sessionGeneration);
    expect(f.proof.verified("claude")).toBe(false);
  }
});

test("#625 bound generation becomes stale on claim before attach, without adding an offline-state gate", () => {
  const f = fixture(), { peer, sock } = attached("claude"); f.peers.set("claude", peer);
  f.proof.bindGeneration("claude", peer.sessionGeneration); expect(f.proof.verified("claude")).toBe(true);
  peer.detach(sock); expect(peer.state).toBe("offline");
  expect(f.proof.verified("claude")).toBe(true); // The daemon's callers retain their existing state guards.
  const next = socket("next-launch"), previous = peer.sessionGeneration;
  peer.claim(next); expect(peer.sessionGeneration).not.toBe(previous);
  expect(f.proof.verified("claude")).toBe(false);
  peer.attach(next); expect(f.proof.verified("claude")).toBe(false);
  f.proof.bindGeneration("claude", peer.sessionGeneration); expect(f.proof.verified("claude")).toBe(true);
  const second = createClaudeLaunchProof({ stateDir: f.stateDir, cwd: f.cwd, instanceId: f.instanceId, definitionOf, peer: id => f.peers.get(id) });
  expect(second.verified("claude")).toBe(false);
});
