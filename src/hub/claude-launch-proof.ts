import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { claudeStateFile } from "./claude-state.ts";
import { readFileSync } from "node:fs";
import { isWsPeer, type WsPeer } from "../adapters/channel-peer.ts";
import { isFixedBuiltinDefinition, type AdapterDefinition } from "../adapters/registry.ts";
import type { PeerAdapter } from "./peers.ts";

export interface ClaudeLaunchRecordProof {
  launchId: string;
  executionCwd?: string;
  privateRecord: boolean;
  permissionHook: boolean;
  unattended: boolean;
  hookPurpose?: string;
}

/** One bounded reader for current managed launch metadata; no native identity or payload escapes. */
export function readClaudeLaunchProof(stateDir: string, peer: string, instanceId: string): ClaudeLaunchRecordProof | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(stateDir, claudeStateFile("claude-launch", peer)), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    // ponytail: launch metadata is capped at 16 KiB; add a versioned projection if it ever grows.
    if (!stat.isFile() || stat.size > 16 * 1024) return;
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 16 * 1024) return;
    const row = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (row?.instanceId !== instanceId || typeof row.launchId !== "string" || !row.launchId || row.launchId.length > 128) return;
    return { launchId: row.launchId, privateRecord: stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && !!process.getuid && stat.uid === process.getuid(),
      ...(typeof row.executionCwd === "string" && row.executionCwd.length <= 4096 && isAbsolute(row.executionCwd) ? { executionCwd: row.executionCwd } : {}),
      permissionHook: row.permissionHook === true, unattended: row.unattended === true,
      ...(typeof row.hookPurpose === "string" ? { hookPurpose: row.hookPurpose } : {}) };
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Host-only launch and socket-generation evidence; adapter-reported generations cannot establish it. */
export interface ClaudeLaunchProof {
  permissionLaunch(peer: string): { launchId: string; unattended: boolean; hookPurpose?: string } | undefined;
  helloLaunch(peer: string, launchId: unknown): "admit" | "refuse";
  expectedLaunch(peer: string): string | undefined;
  owner(peer: string): WsPeer | undefined;
  bindGeneration(peer: string, generation: string): void;
  verified(peer: string): boolean;
}

export function createClaudeLaunchProof(opts: {
  stateDir: string;
  cwd: string;
  instanceId: string;
  definitionOf(peer: string): AdapterDefinition | undefined;
  peer(peer: string): PeerAdapter | undefined;
}): ClaudeLaunchProof {
  const generations = new Map<string, string>();
  function channel(peer: string): boolean {
    const definition = opts.definitionOf(peer);
    return isFixedBuiltinDefinition(definition) && definition?.transport === "claude-channel";
  }
  function owner(peer: string): WsPeer | undefined {
    if (!channel(peer)) return;
    const current = opts.peer(peer);
    return isWsPeer(current) ? current : undefined;
  }
  function permissionLaunch(peer: string): ReturnType<ClaudeLaunchProof["permissionLaunch"]> {
    if (!channel(peer)) return;
    const row = readClaudeLaunchProof(opts.stateDir, peer, opts.instanceId);
    return row?.permissionHook ? row : undefined;
  }
  function helloLaunch(peer: string, launchId: unknown): "admit" | "refuse" {
    if (!channel(peer) || launchId === undefined) return "admit";
    let currentLaunch: unknown;
    try {
      const launch = readClaudeLaunchProof(opts.stateDir, peer, opts.instanceId);
      if (launch) currentLaunch = launch.launchId;
    } catch { /* No current launch evidence: retain plain/pre-daemon attachment compatibility. */ }
    return currentLaunch !== undefined && launchId !== currentLaunch ? "refuse" : "admit";
  }
  function expectedLaunch(peer: string): string | undefined {
    if (!channel(peer)) return;
    let expectedLaunch: string | undefined;
    try {
      const rows = JSON.parse(readFileSync(join(opts.stateDir, "terminal-recovery.json"), "utf8"));
      expectedLaunch = Array.isArray(rows) ? rows.find(row => row?.peer === peer && opts.definitionOf(row.peer)?.transport === "claude-channel" && row?.projectRoot === opts.cwd && row?.instanceId === opts.instanceId)?.launchId : undefined;
    } catch { /* an ordinary terminal has no Orca recovery identity */ }
    try {
      const launch = readClaudeLaunchProof(opts.stateDir, peer, opts.instanceId);
      if (launch) expectedLaunch = launch.launchId;
    } catch { /* older/manual launches do not have a launcher marker */ }
    return expectedLaunch;
  }
  return {
    permissionLaunch, helloLaunch, expectedLaunch, owner,
    bindGeneration(peer, generation) { if (owner(peer)) generations.set(peer, generation); },
    verified(peer) { const current = owner(peer); return !!current && generations.get(peer) === current.sessionGeneration; },
  };
}
