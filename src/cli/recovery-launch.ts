import { constants, closeSync, fstatSync, linkSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { looksSecret } from "@staix/agent-mem";
import { loadConfig } from "../hub/daemon.ts";
import { loadRouting, detectSignals } from "../hub/routing.ts";
import { mentionsPrivatePath } from "../hub/memory-policy.ts";
import { sanitize } from "../hub/envelope.ts";
import { terminalText } from "./console-state.ts";
import { shellQuote } from "./shell-quote.ts";

export class RecoveryLaunchError extends Error {
  constructor(readonly peer: string, readonly failure: RecoveryLaunchFailure, resume: string) { super(`${peer}: restoration launch ${failure.code} (exit ${failure.exitCode}): ${failure.firstLine}; fix the cause, then ${resume}`); }
}

export interface RecoveryLaunchFailure {
  code: "version_refused" | "launch_exit";
  exitCode: number;
  firstLine: string;
}
interface Capture { file: string; nonce: string; peer: string }
const CAPTURE_BYTES = 2048;
const OUTCOME_BYTES = 8192;
const LINE_POINTS = 512;

/** Existing private attempt directory only: never recreate it after the reader has disposed it. */
function publish(capture: Capture, exitCode: number, firstLine: string, complete: boolean): void {
  if (!Number.isInteger(exitCode) || exitCode <= 0 || exitCode > 255) return;
  const temp = `${capture.file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ schemaVersion: 1, nonce: capture.nonce, peer: capture.peer, exitCode, firstLine, complete }), { flag: "wx", mode: 0o600 });
    linkSync(temp, capture.file); // first complete producer wins, without replacing any existing inode
  } catch { /* Capture is optional; a closed/ready attempt must not create new files. */ }
  finally { try { unlinkSync(temp); } catch { /* absent or already disposed */ } }
}

/** Preloaded only in the hub CLI child, not its native child. TTY descriptors/properties stay unchanged. */
export function captureLaunchExit(capture: Capture): void {
  let first = Buffer.alloc(0), complete = false;
  const collect = (bytes: Buffer) => {
    if (complete || first.length >= CAPTURE_BYTES) return;
    const newline = bytes.indexOf(10), end = newline < 0 ? bytes.length : newline;
    const remaining = CAPTURE_BYTES - first.length;
    first = Buffer.concat([first, bytes.subarray(0, Math.min(end, remaining))]);
    complete = newline >= 0 && end <= remaining;
  };
  // Bun's console writes directly to the descriptor, bypassing stderr.write.
  const error = console.error.bind(console);
  console.error = (...args: any[]) => { try { collect(Buffer.from(format(...args) + "\n")); } catch { /* original console behavior below */ } error(...args); };
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk: any, ...args: any[]) {
    collect(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk)));
    return (write as (...parts: any[]) => boolean)(chunk, ...args);
  } as typeof process.stderr.write;
  process.once("exit", code => publish(capture, code, first.toString("utf8"), complete));
}

function screenedLine(raw: string, complete: boolean, cwd: string): string {
  const withheld = "launch diagnostic unavailable or withheld by privacy policy; inspect the launch terminal";
  if (!complete || raw.includes("�")) return withheld;
  try {
    const routing = loadRouting(cwd), config = loadConfig(cwd);
    if (routing.signals.pii_screen !== "off" || looksSecret(raw)
      || detectSignals({ title: raw, detail: "", refs: {} }, routing, cwd).includes("pii")
      || mentionsPrivatePath(raw, [], config.pii?.paths ?? [], cwd)) return withheld;
    return Array.from(sanitize(terminalText(raw)).replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()).slice(0, LINE_POINTS).join("") || withheld;
  } catch { return withheld; }
}

/** Bounded no-follow read; an outcome is diagnostic only, never proof of ownership or readiness. */
function readOutcome(capture: Capture, cwd: string): RecoveryLaunchFailure | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(capture.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > OUTCOME_BYTES) return;
    const bytes = Buffer.alloc(OUTCOME_BYTES + 1), count = readSync(fd, bytes);
    if (count > OUTCOME_BYTES) return;
    const row = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (row?.schemaVersion !== 1 || row.nonce !== capture.nonce || row.peer !== capture.peer
      || !Number.isInteger(row.exitCode) || row.exitCode <= 0 || row.exitCode > 255
      || typeof row.firstLine !== "string" || Buffer.byteLength(row.firstLine) > CAPTURE_BYTES || typeof row.complete !== "boolean"
      || Object.keys(row).some(key => !["schemaVersion", "nonce", "peer", "exitCode", "firstLine", "complete"].includes(key))) return;
    const firstLine = screenedLine(row.firstLine, row.complete, cwd);
    const version = row.complete && /^(?:ahub: )?Version not verified: /.test(row.firstLine);
    return { code: version ? "version_refused" : "launch_exit", exitCode: row.exitCode, firstLine };
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function prepareRecoveryLaunch(stateDir: string, peer: string, argv: readonly string[], env: Record<string, string>, cwd: string) {
  if (argv.length < 2) throw new Error("restoration launch argv is missing; inspect the operation before resuming");
  const dir = mkdtempSync(join(stateDir, "restore-launch-"));
  const capture: Capture = { file: join(dir, "outcome.json"), nonce: randomUUID(), peer };
  const module = fileURLToPath(import.meta.url), preload = join(dir, "capture.ts");
  try {
    writeFileSync(preload, `import { captureLaunchExit } from ${JSON.stringify(module)}; captureLaunchExit(${JSON.stringify(capture)});\n`, { flag: "wx", mode: 0o600 });
    const prefix = ["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)];
    const launch = [...prefix, argv[0]!, "--preload", preload, ...argv.slice(1)].map(shellQuote).join(" ");
    const record = [...prefix, process.execPath, module, JSON.stringify(capture), "--exit-code"].map(shellQuote).join(" ");
    // A shell status observation adds no long-lived proxy or pipe to the native TTY.
    const command = `${launch}; ahub_restore_exit=$?; if [ "$ahub_restore_exit" -ne 0 ]; then ${record} "$ahub_restore_exit"; fi; (exit "$ahub_restore_exit")`;
    return { command, read: () => readOutcome(capture, cwd), dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  const [raw, marker, status] = process.argv.slice(2);
  if (!raw || marker !== "--exit-code" || !status || !/^[0-9]+$/.test(status)) throw new Error("invalid private restoration launch outcome");
  publish(JSON.parse(raw) as Capture, Number(status), "", false);
}
