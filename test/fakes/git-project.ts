import { hubGitSync } from "../../src/hub/git.ts";

/**
 * #1129: write-class work (`implement`, `bulk_edit`) is offered to a hub-sandboxed peer (Pi, the local worker) only where the hub can make its task worktree, which needs a git
 * repository with a first commit. A daemon fixture that routes such work to one of them calls this on its project directory first. It leaves the directory otherwise untouched
 * (an empty commit), and runs git through the hub's hardened helper, so a signing key or global config on the machine cannot change the result.
 */
export function gitProject(dir: string): void {
  for (const args of [["init", "-q"], ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base"]]) {
    const run = hubGitSync(["-C", dir, ...args], { encoding: "utf8", timeout: 20_000 });
    if (run.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${run.stderr}`);
  }
}
