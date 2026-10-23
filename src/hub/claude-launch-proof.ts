import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { claudeStateFile } from "./claude-state.ts";

export interface ClaudeLaunchProof {
  launchId: string;
  executionCwd?: string;
  privateRecord: boolean;
  permissionHook: boolean;
  unattended: boolean;
  hookPurpose?: string;
}

/** One bounded reader for current managed launch metadata; no native identity or payload escapes. */
export function readClaudeLaunchProof(stateDir: string, peer: string, instanceId: string): ClaudeLaunchProof | undefined {
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
