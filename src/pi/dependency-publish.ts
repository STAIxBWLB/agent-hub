import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stopOwnedProcess, trackGroup } from "../hub/child-process.ts";
import { realPath } from "../hub/project.ts";

export interface DependencyPublishTarget { cwd: string; dev: number; ino: number; timeoutMs: number }

// CWD is a kernel-held directory reference. Verify it after spawn, then use a relative
// destination so replacing an ancestor path cannot redirect this host write elsewhere.
const PUBLISH = `
import {lstatSync,renameSync,statSync} from "node:fs";
try {
 const [source,device,inode]=Bun.argv.slice(2);
 const cwd=statSync(".");
 if(String(cwd.dev)!==device||String(cwd.ino)!==inode)throw new Error("worktree changed");
 try{lstatSync("node_modules");throw new Error("target exists")}catch(error){if(error.code!=="ENOENT")throw error}
 const input=lstatSync(source);
 if(!input.isDirectory()||input.isSymbolicLink()||input.dev!==cwd.dev)throw new Error("unsupported publication");
 renameSync(source,"node_modules");
 const output=lstatSync("node_modules");
 if(!output.isDirectory()||output.dev!==input.dev||output.ino!==input.ino)throw new Error("publication changed");
}catch{process.exitCode=1}
`;

/** Trusted host helper only. No project configuration or inherited environment is loaded. */
export async function publishPiDependencies(source: string, target: DependencyPublishTarget, current: () => boolean): Promise<boolean> {
  if (!current() || !Number.isSafeInteger(target.dev) || !Number.isSafeInteger(target.ino) || !(target.timeoutMs > 0)) return false;
  const privateRoot = dirname(source), config = join(privateRoot, ".hub-publish-bunfig.toml"), home = join(privateRoot, ".hub-publish-home"), script = join(privateRoot, ".hub-publish.ts");
  try {
    writeFileSync(config, "", { flag: "wx", mode: 0o600 }); mkdirSync(home, { mode: 0o700 });
    writeFileSync(script, PUBLISH, { flag: "wx", mode: 0o600 });
    const executable = realPath(process.execPath);
    return await new Promise<boolean>(resolve => {
      const child = spawn(executable, ["--no-env-file", `--config=${config}`, script, source, String(target.dev), String(target.ino)], {
        cwd: target.cwd, env: { HOME: home }, detached: true, stdio: "ignore",
      });
      trackGroup(child);
      let settled = false;
      const finish = async (ok: boolean) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (!ok) { try { await stopOwnedProcess(child, { group: true }); } catch { /* No success is certified after uncertain teardown. */ } }
        resolve(ok && current());
      };
      const timer = setTimeout(() => { void finish(false); }, target.timeoutMs);
      child.once("error", () => { void finish(false); });
      child.once("close", code => { void finish(code === 0); });
    });
  } catch { return false; }
}
