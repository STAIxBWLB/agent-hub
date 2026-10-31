import { checkClaudeHome, claudeHomeEnvironment, type ClaudeHome, type ClaudeHomeProbe } from "./claude-homes.ts";
import { installClaudeProfileHook } from "./claude-profile-hook.ts";

export interface SetupHomesPorts {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  yes: boolean;
  interactive?: boolean;
  homes: readonly ClaudeHome[];
  probe: ClaudeHomeProbe;
  run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number>;
  ask(prompt: string): Promise<string | null>;
  print(line: string): void;
  current?(): void;
}
/** Selected homes only. Native plugin operations and the project-neutral hook share one person confirmation. */
export async function setupClaudeHomes(ports: SetupHomesPorts): Promise<void> {
  ports.current?.();
  if (!ports.homes.length) { ports.print("No Claude configuration home in use was found; set CLAUDE_CONFIG_DIR to select one."); return; }
  const initial = [];
  for (const home of ports.homes) initial.push(await checkClaudeHome(home, ports.packageRoot, ports.env, ports.probe));
  for (const check of initial) {
    ports.print(`Claude home ${check.home.path}: plugin ${check.plugin.state}; hook ${check.hook.state}.`);
    if (check.plugin.state === "unknown" || check.hook.state === "refused") throw new Error(`Claude setup cannot safely inspect ${check.home.path}; nothing was changed`);
  }
  if (initial.every(check => !check.next && check.hook.state === "installed")) return;
  if (!ports.yes && ports.interactive === false) throw new Error("not a terminal: nothing was changed; rerun with --yes to apply");
  if (!ports.yes && !["y", "yes"].includes((await ports.ask("Install the hub plugin and project-neutral hook in these Claude homes? [y/N] "))?.trim().toLowerCase() ?? "")) { ports.print("Claude setup was not changed."); return; }
  ports.current?.();
  for (const check of initial) {
    let current = check;
    for (let step = 0; current.next && step < 6; step++) {
      ports.print(`${check.home.path}: ${current.next.argv.join(" ")} (${current.next.why})`);
      ports.current?.();
      if (await ports.run(current.next.argv, claudeHomeEnvironment(check.home, ports.env)) !== 0) throw new Error(`Claude plugin setup failed for ${check.home.path}; no later home was changed`);
      current = await checkClaudeHome({ ...check.home, exists: true }, ports.packageRoot, ports.env, ports.probe);
      if (current.plugin.state === "unknown") throw new Error(`Claude plugin inventory is unavailable for ${check.home.path}`);
    }
    if (current.next) throw new Error(`Claude setup exceeded six plugin steps for ${check.home.path}`);
    ports.current?.();
    const hook = installClaudeProfileHook(check.home);
    if (hook.state !== "installed") throw new Error(hook.reason);
    ports.print(`${check.home.path}: plugin current; hook ${hook.changed ? "installed" : "current"}. ${hook.reason}`);
  }
}
