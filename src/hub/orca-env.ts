/**
 * #613 (agent-hub#1048): the one source of truth for the Orca terminal environment. No imports, so every layer can read it
 * (the launcher, the hub's terminal opener, the test preload and the gate's comment).
 *
 * The Orca launcher decides whether to open a terminal in the person's running Orca from these four names, so a process
 * that inherits them reaches that Orca. A hub or a test run started from an Orca pane inherits them, so tests and the gate
 * start with the whole `ORCA_` prefix removed and a test that wants one sets it itself.
 */
export const ORCA_LAUNCHER_ENV: readonly string[] = Object.freeze(["ORCA_CLI_COMMAND", "ORCA_DEV_REPO_ROOT", "ORCA_TERMINAL_HANDLE", "ORCA_WORKTREE_ID"]);

/** Every variable an Orca terminal exports: the launcher's four and the rest of the pane's environment. */
export const isOrcaEnvName = (name: string): boolean => name.startsWith("ORCA_");

/** A copy of `env` with every `ORCA_` variable removed. */
export function withoutOrcaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(out)) if (isOrcaEnvName(name)) delete out[name];
  return out;
}
