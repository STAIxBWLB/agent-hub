import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realPath } from "../../src/hub/project.ts";
import { ReceiptError, type ReceiptSummary } from "./types.ts";

const HELPER_MS = 2_000;
export const RECEIPT_OUTPUT_MS = HELPER_MS * 2;
const PAYLOAD_BYTES = 4 * 1024 * 1024;
const DIAGNOSTIC_BYTES = 4096;
const SYSTEM_ALIASES = new Set(["/tmp", "/var", "/etc"]);

export interface ReceiptOutput {
  write(summary: ReceiptSummary, receipt: string): void;
  close(): void;
}

function reject(): never { throw new ReceiptError("input"); }
/** Other principals must not be able to replace a component before the directory capability is acquired. */
function safeAncestors(directory: string, uid: number): void {
  let current = parse(directory).root;
  for (const name of ["", ...directory.slice(current.length).split(sep).filter(Boolean)]) {
    if (name) current = join(current, name);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) {
      if (info.uid !== 0 || !SYSTEM_ALIASES.has(current)) reject();
      safeAncestors(realPath(current), uid);
      continue;
    }
    if (!info.isDirectory() || info.uid !== 0 && info.uid !== uid) reject();
    // Root/caller-owned sticky temporary roots protect our owned children from other users' renames.
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) reject();
  }
}

/** The native/installer processes never receive this FD; only the fixed isolated Python writer does. */
export function openReceiptOutput(out: string): ReceiptOutput {
  let descriptor: number | undefined;
  try {
    if (!out || /\p{Cc}/u.test(out) || !process.getuid) reject();
    const uid = process.getuid(), directory = resolve(out);
    const python = Bun.which("python3", { PATH: "/usr/bin:/bin" });
    if (!python) reject();
    safeAncestors(directory, uid);
    const previous = lstatSync(directory, { throwIfNoEntry: false });
    if (previous?.isSymbolicLink() || previous && !previous.isDirectory()) reject();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const physical = realPath(directory);
    safeAncestors(physical, uid);
    const before = lstatSync(physical);
    descriptor = openSync(physical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const fd = descriptor, identity: Stats = fstatSync(fd);
    if (!identity.isDirectory() || identity.uid !== uid || (identity.mode & 0o022) !== 0 || before.dev !== identity.dev || before.ino !== identity.ino) reject();
    const helper = fileURLToPath(new URL("./write-output.py", import.meta.url));
    let closed = false, written = false;
    const run = (mode: "check" | "write", input?: string): void => {
      if (closed) reject();
      const current = fstatSync(fd);
      if (current.dev !== identity.dev || current.ino !== identity.ino) reject();
      const result = spawnSync(python, ["-I", helper, mode], {
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
        input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe", fd], timeout: HELPER_MS,
        killSignal: "SIGKILL", maxBuffer: DIAGNOSTIC_BYTES,
      });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new ReceiptError("timeout");
      if (result.error || result.signal || result.status !== 0) reject();
    };
    run("check");
    return {
      write(summary, receipt) {
        try {
          if (written || typeof receipt !== "string") reject();
          const input = JSON.stringify([`${JSON.stringify(summary, null, 2)}\n`, receipt]);
          if (Buffer.byteLength(input, "utf8") > PAYLOAD_BYTES) reject();
          run("write", input); written = true;
        } catch (error) { if (error instanceof ReceiptError) throw error; reject(); }
      },
      close() { if (!closed) { closed = true; closeSync(fd); } },
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof ReceiptError) throw error;
    reject();
  }
}
