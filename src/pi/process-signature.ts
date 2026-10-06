import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * The one process-identity contract behind the Pi owner claim and every later liveness
 * re-inspection: pid plus the `ps` rendering of its start time and command. `lstart`
 * follows the reader's TZ and locale, so the read pins LC_ALL=C and TZ=UTC, the same
 * contract as `processTable` in src/hub/child-process.ts. Without the pin a hub on one
 * timezone and its Pi child on another hash different strings for the same process and the
 * valid owner is refused at startup (#174). Only the `ps` invocation is pinned; the user's
 * own environment is untouched. Node APIs only: the extension runs inside Pi, not Bun.
 */
export function processSignature(pid: number): string | undefined {
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    return text ? createHash("sha256").update(text).digest("hex") : undefined;
  } catch { return undefined; }
}
