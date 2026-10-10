import { spawn } from "node:child_process";
import { personEnv } from "./child-process.ts";
import { openStartTerminal, orcaExecutable, shellQuote, startTerminalWorktree, type CommandRunner } from "../cli/terminal-recovery.ts";

/** #269: where a terminal for a hub-made start comes from, or why there is none. */
export type TerminalOpened = { ok: true; via: string } | { ok: false; why: string };
export interface TerminalOpener {
  /** Whether a start could open a terminal now; opens nothing. */
  available(): TerminalOpened;
  /** A terminal running `argv`, which the caller assembled from fixed words: nothing here adds to it. */
  open(title: string, argv: readonly string[]): Promise<TerminalOpened>;
}

const SETTLE_MS = 1500;

/**
 * The providers, in order: the machine-local `terminal.open` command template, then Orca (the path recovery uses)
 * when this project has an Orca worktree. `run` replaces the Orca CLI in tests.
 */
export function terminalOpener(opts: { template: string[]; cwd: string; stateDir: string; env?: NodeJS.ProcessEnv; run?: CommandRunner }): TerminalOpener {
  const env = opts.env ?? process.env;
  const worktree = () => startTerminalWorktree(opts.cwd, opts.stateDir, env);
  const available = (): TerminalOpened => {
    if (opts.template.length) return { ok: true, via: "terminal.open" };
    if (!worktree()) return { ok: false, why: "no terminal.open command is configured and this project has no Orca worktree on record" };
    if (!opts.run && !Bun.which(orcaExecutable())) return { ok: false, why: `the ${orcaExecutable()} command is not on PATH` };
    return { ok: true, via: "orca" };
  };
  return {
    available,
    async open(title, argv) {
      const can = available();
      if (!can.ok) return can;
      // One command line, each word quoted for a POSIX shell: the terminal's shell runs exactly these words.
      const command = argv.map(shellQuote).join(" ");
      try {
        if (can.via === "orca") {
          await openStartTerminal(worktree()!, command, title, opts.run ? { runner: opts.run } : undefined);
          return can;
        }
        const [bin, ...args] = opts.template.map((part) => part.replaceAll("{command}", command).replaceAll("{title}", title).replaceAll("{cwd}", opts.cwd));
        // Detached and unwatched: the terminal is the person's and outlives the hub.
        const child = spawn(bin!, args, { cwd: opts.cwd, env: personEnv(env), stdio: "ignore", detached: true });
        const failed = await new Promise<string | undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), SETTLE_MS); // still running: it is the terminal itself
          child.once("error", (error) => { clearTimeout(timer); resolve(error.message); });
          child.once("exit", (code, signal) => { clearTimeout(timer); resolve(code === 0 ? undefined : `terminal.open exited ${signal ?? code}`); });
        });
        child.unref();
        return failed ? { ok: false, why: failed } : can;
      } catch (error) {
        return { ok: false, why: (error as Error).message };
      }
    },
  };
}
