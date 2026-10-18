import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { hubGitSync } from "./git.ts";
import { hostExecutable } from "./host-executable.ts";
import { childEnv, stopOwnedProcess } from "./child-process.ts";

export interface ReleaseHostAdmission { admitted: boolean; reason?: string; current?: () => boolean; close?: () => Promise<void> }
const READY = "AHUB_RELEASE_SLOT_READY\n";
const HOLD = 'process.stdout.write("AHUB_RELEASE_SLOT_READY\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));';
/** Hold the installed controller's repository lease through the synchronous scope freeze. No caller command. */
export function readReleaseHostAdmission(cwd: string): Promise<ReleaseHostAdmission> {
  const common = hubGitSync(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 1000, maxBuffer: 4096 });
  const directory = common.stdout?.trim();
  if (common.status !== 0 || !directory) return Promise.resolve({ admitted: false, reason: "repository resource identity unavailable" });
  const locked = () => existsSync(join(directory, "ahub-heavy.lock"));
  if (locked()) return Promise.resolve({ admitted: false, reason: "repository heavy-job slot held" });
  return new Promise(resolve => {
    let executable: string;
    try { executable = hostExecutable("dot", cwd); } catch { resolve({ admitted: false, reason: "host resource controller unavailable" }); return; }
    const env = childEnv();
    delete env.DOT_ADMISSION_SCOPE; // A long-lived daemon must not inherit an expired launcher lease.
    const child = spawn(executable, ["admit", "--wait", "0s", "--json", "--", process.execPath, "-e", HOLD], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", bytes = 0, invalid = false, admitted = false;
    const stop = () => { invalid = true; void stopOwnedProcess(child, { group: true }).catch(() => {}); };
    // ponytail: one five-second metadata cut lease, never a build lease. Heavy preparation runs through its own admission.
    const timer = setTimeout(() => { stop(); resolve({ admitted: false, reason: "host resource admission timed out" }); }, 5000);
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (invalid) return;
      output += chunk; bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 || !READY.startsWith(output) && output !== READY) { stop(); resolve({ admitted: false, reason: "host resource admission unknown" }); return; }
      if (!admitted && output === READY && !locked()) {
        admitted = true;
        resolve({ admitted: true, current: () => !invalid && child.exitCode === null && child.signalCode === null && !locked(), close: async () => {
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) {
            await new Promise<void>(done => {
              const grace = setTimeout(done, 500);
              child.once("close", () => { clearTimeout(grace); done(); });
              child.stdin.end();
            });
          }
          await stopOwnedProcess(child, { group: true });
        } });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024) stop(); });
    child.once("error", () => { invalid = true; clearTimeout(timer); resolve({ admitted: false, reason: "host resource controller unavailable" }); });
    child.once("close", code => {
      clearTimeout(timer); invalid = true;
      if (!admitted) resolve({ admitted: false, reason: code === 75 ? "host resource admission deferred (busy repository or pressure)" : "host resource admission unknown" });
    });
  });
}
