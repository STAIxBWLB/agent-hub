import { spawn } from "node:child_process";
import { descendantsOf, parseProcessTable, stopOwnedProcess, trackGroup, type ProcRow } from "../../src/hub/child-process.ts";
import { dirname } from "node:path";
import type { CommandResult, ReceiptCommand } from "./types.ts";

// Operational cleanup bounds; diagnostics never inherit the caller's credential environment.
const TABLE_MS = 2_000, TERM_MS = 250, KILL_MS = 1_000;
export const RECEIPT_CLEANUP_MS = 10_000;
async function cleanProcessTable(): Promise<ProcRow[] | undefined> {
  const executable = Bun.which("ps", { PATH: "/usr/bin:/bin" });
  if (!executable) return;
  const child = Bun.spawn([executable, "-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), TABLE_MS);
  try {
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return;
    const rows = parseProcessTable(text);
    return rows.some(row => row.pid === process.pid) ? rows : undefined;
  } finally { clearTimeout(timer); }
}

/** Uses the production owned-group/descendant teardown, including on normal exit. */
export const runBoundedReceiptCommand: ReceiptCommand = async (argv, options) => {
  if (!argv.length || options.signal.aborted) return { exitCode: null, stdout: "", stderr: "", timedOut: false, ownedStopConfirmed: true, processCleanup: "proven", processCleanupReason: "No process was started." };
  return new Promise<CommandResult>(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    trackGroup(child);
    let stdout = "", stderr = "", bytes = 0, overflow = false, timedOut = false, settled = false;
    const cap = options.maxBytes ?? 1024 * 1024;
    const finish = async (exitCode: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal.removeEventListener("abort", aborted);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let survivorDetected = false;
      const ownedStopConfirmed = await Promise.race([
        (async () => {
          try {
            const before = await cleanProcessTable();
            const known = child.pid && before ? descendantsOf(before, child.pid) : [];
            await stopOwnedProcess(child, { group: true, termMs: TERM_MS, killMs: KILL_MS, table: cleanProcessTable });
            const after = await cleanProcessTable();
            const runRoot = options.env.AGENTHUB_HOME ? dirname(options.env.AGENTHUB_HOME) : undefined;
            // Observed identities or a private-run path are sufficient to report a
            // survivor, never authority to signal an otherwise unowned process.
            survivorDetected = !!after?.some(row => known.some(owned => owned.pid === row.pid && owned.started === row.started) ||
              runRoot?.includes("/ahub-compat-receipt-") && row.command.includes(`${runRoot}/`));
            return !!before && !!after && !survivorDetected;
          } catch { return false; }
        })(),
        new Promise<false>(done => { cleanupTimer = setTimeout(() => done(false), RECEIPT_CLEANUP_MS); }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      // An exited leader and an empty original PGID cannot prove that no helper
      // detached into a new group with ignored pipes. Runner destruction supplies
      // containment; a portable process supervisor is outside T1.
      resolve({ exitCode: overflow ? 1 : exitCode, stdout, stderr, timedOut, ownedStopConfirmed, survivorDetected,
        processCleanup: "unproven", processCleanupReason: "Detached helpers can outlive an exited leader outside its original process group; disposable runner destruction is the containment boundary." });
    };
    const aborted = () => { void finish(null); };
    const timer = setTimeout(() => { timedOut = true; void finish(null); }, options.timeoutMs);
    options.signal.addEventListener("abort", aborted, { once: true });
    const accept = (chunk: Buffer, error: boolean) => {
      bytes += chunk.length;
      if (bytes > cap) { overflow = true; void finish(null); return; }
      if (error) stderr += chunk.toString("utf8"); else stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => accept(chunk, false));
    child.stderr.on("data", chunk => accept(chunk, true));
    child.once("error", () => { void finish(1); });
    child.once("close", code => { void finish(code); });
    child.once("spawn", () => { if (options.signal.aborted) aborted(); });
  });
};
