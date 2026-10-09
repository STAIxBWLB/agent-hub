import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * The one process-identity contract behind the Pi owner claim, every later liveness
 * re-inspection, the terminal-recovery launcher signature and any other hub identity
 * hash: pid plus the `ps` rendering of its start time and command. `lstart` follows
 * the reader's TZ and locale, so the read pins LC_ALL=C and TZ=UTC, the same contract
 * as `processTable` in src/hub/child-process.ts. Without the pin a writer and a reader
 * in different environments hash different strings for the same process and the valid
 * owner is refused (#174, #177). Only the `ps` invocation is pinned; the user's own
 * environment is untouched. Node APIs only: the extension runs inside Pi, not Bun.
 */
export function processSignature(pid: number): string | undefined {
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    return text ? createHash("sha256").update(text).digest("hex") : undefined;
  } catch { return undefined; }
}

export type Liveness = "live" | "gone" | "unknown";

/**
 * #226: the one ownership check behind every recorded pid (hub manifest, registry claim, recovery runner, manager
 * owner, launcher records). With a recorded `signature` the identity decides: equal is live, different is gone (the
 * pid was reused, after a reboot for example, also by a process we may not signal), and a pid that exists but whose
 * identity cannot be read is unknown. Without one (records written by 0.12.20 and older) the pid probe answers as it
 * always did: live, gone on ESRCH, unknown otherwise. Unknown is never gone.
 */
export function processLiveness(pid: unknown, signature?: string | null, identity: (pid: number) => string | undefined = processSignature): Liveness {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  if (signature) {
    let current: string | undefined;
    try { current = identity(pid); } catch { /* unreadable: the pid probe below decides between gone and unknown */ }
    if (current) return current === signature ? "live" : "gone";
  }
  try { process.kill(pid, 0); return signature ? "unknown" : "live"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
}
