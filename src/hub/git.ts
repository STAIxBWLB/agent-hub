import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";

/**
 * The one helper for every git call the hub makes outside the sandbox (#281): the repository's own configuration
 * must not name a program the hub then runs with its own rights (defense in depth behind the seatbelt profile,
 * which refuses a sandboxed command the writes that would plant one). Every call gets:
 * - core.fsmonitor=false: the file-system monitor is an arbitrary command read from the repo config.
 * - core.hooksPath=/dev/null: hooks come from a non-directory, so every hook lookup fails closed.
 * - diff.external= (empty): no external diff driver.
 * - core.pager=cat and --no-pager: no pager, whatever the config says (stdout is a pipe everywhere anyway).
 * - credential.helper= (empty resets the list) and core.askpass= (empty fails closed), with GIT_TERMINAL_PROMPT=0:
 *   no hub command authenticates, so any prompt is a bug and must fail instead of running a configured helper.
 * git has no global switch for filter drivers or textconv: both are per-driver config keys. Of the hub's commands
 * only the snapshot's `add`/`restore` would run a filter driver, and only a content diff would run textconv (the
 * hub's one content diff is `diff --no-index`, which reads no attributes); both need .git/config, which the profile
 * refuses to a sandboxed command. GIT_CONFIG_NOSYSTEM/global are left alone: those files are the user's own.
 */
const SAFE_CONFIG = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "credential.helper=", "core.askpass="];

/** `["git", ...safe options, ...args]`: use instead of a literal "git" argv anywhere under src/. */
export const hubGitArgv = (args: string[]): string[] => ["git", "--no-pager", ...SAFE_CONFIG.flatMap((c) => ["-c", c]), ...args];

/** The caller's env plus the no-prompt switch; existing keys (childEnv, GIT_OPTIONAL_LOCKS=0) pass through. */
export const hubGitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, GIT_TERMINAL_PROMPT: "0" });

/** spawnSync form of the same call: the env option is merged with hubGitEnv, everything else passes through. */
export function hubGitSync(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  const argv = hubGitArgv(args);
  return spawnSync(argv[0]!, argv.slice(1), { ...options, env: hubGitEnv(options.env ?? process.env) });
}
