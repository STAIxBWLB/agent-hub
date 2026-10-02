import { appendFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve, sep } from "node:path";
import { daemonProjectRootFromArgv } from "./process-ownership.mjs";

const rootValue = process.env.AHUB_CHECK_RUN_ROOT;
const ledger = process.env.AHUB_CHECK_PROCESS_LEDGER;
if (rootValue && ledger) {
  const rawProject = daemonProjectRootFromArgv(process.argv, process.execPath);
  try {
    const runRoot = realpathSync(resolve(rootValue));
    const kind = rawProject ? "daemon" : "owned_process";
    const lexicalRoot = resolve(rawProject ?? process.cwd());
    let root;
    try { root = realpathSync(lexicalRoot); }
    catch (error) {
      if (lexicalRoot === runRoot || lexicalRoot.startsWith(`${runRoot}${sep}`)) throw error;
    }
    if (root && (root === runRoot || root.startsWith(`${runRoot}${sep}`))) {
      const info = execFileSync("ps", ["-p", String(process.pid), "-o", "pid=,pgid=,lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const match = /^(\d+)\s+(\d+)\s+(.{24})$/.exec(info);
      if (!match) throw new Error("could not read owned Bun process identity");
      const [, pid, pgid, started] = match;
      if (pid !== String(process.pid)) throw new Error("process identity changed during ownership capture");
      const birth = {
        kind,
        pid,
        pgid,
        started: started.trim(),
        root,
        command: process.argv.join(" "),
        runtime: basename(process.execPath),
        exclusive: pid === pgid,
      };
      appendFileSync(ledger, `${JSON.stringify(birth)}\n`, { mode: 0o600 });
    }
  } catch (error) {
    try { appendFileSync(ledger, `${JSON.stringify({ error: error.message, pid: process.pid, argv: process.argv })}\n`, { mode: 0o600 }); }
    catch { /* The final process scan remains available if the ledger is unwritable. */ }
  }
}
