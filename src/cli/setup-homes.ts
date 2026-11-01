import { checkClaudeHome, claudeHomeEnvironment, type ClaudeHome, type ClaudeHomeProbe } from "./claude-homes.ts";
import { installClaudeProfileHook } from "./claude-profile-hook.ts";

const marketplaceRemovalRefusal = (home: string) => new Error(`Claude setup refused marketplace removal in ${home}; non-user plugin rows were preserved`);

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
  for (const home of ports.homes) initial.push(await checkClaudeHome(home, ports.packageRoot, ports.env, ports.probe, undefined, true));
  for (const check of initial) {
    ports.print(`Claude home ${check.home.path}: plugin ${check.plugin.state}; hook ${check.hook.state}.`);
    for (const notice of ("notices" in check.plugin ? check.plugin.notices : undefined) ?? []) ports.print(`${check.home.path}: ${notice}.`);
    if (check.plugin.state === "unknown" || check.hook.state === "refused") throw new Error(`Claude setup cannot safely inspect ${check.home.path}; nothing was changed`);
    if (check.next?.blocked) throw marketplaceRemovalRefusal(check.home.path);
  }
  for (const check of initial) if (check.next) ports.print(`${check.home.path}: ${check.next.blocked ? "setup blocked" : check.next.argv.join(" ")} (${check.next.why})`);
  if (initial.every(check => !check.next && check.hook.state === "installed")) return;
  if (!ports.yes && ports.interactive === false) throw new Error("not a terminal: nothing was changed; rerun with --yes to apply");
  if (!ports.yes && !["y", "yes"].includes((await ports.ask("Install the hub plugin and project-neutral hook in these Claude homes? [y/N] "))?.trim().toLowerCase() ?? "")) { ports.print("Claude setup was not changed."); return; }
  ports.current?.();
  for (const check of initial) {
    let current = check;
    for (let step = 0; current.next && step < 6; step++) {
      const action = current.next;
      if (action.blocked) throw marketplaceRemovalRefusal(check.home.path);
      ports.print(`${check.home.path}: ${action.argv.join(" ")} (${action.why})`);
      ports.current?.();
      if (action.argv[2] === "marketplace" && action.argv[3] === "remove") {
        const fresh = await checkClaudeHome({ ...check.home, exists: true }, ports.packageRoot, ports.env, ports.probe, undefined, true);
        if (fresh.plugin.state === "unknown") throw new Error(`Claude plugin inventory is unavailable for ${check.home.path}`);
        if (fresh.next?.blocked) throw marketplaceRemovalRefusal(check.home.path);
        if (JSON.stringify(fresh.next?.argv) !== JSON.stringify(action.argv)) { current = fresh; continue; }
        current = fresh;
        ports.current?.();
      }
      if (await ports.run(action.argv, claudeHomeEnvironment(check.home, ports.env)) !== 0) throw new Error(`Claude plugin setup failed for ${check.home.path}; no later home was changed`);
      current = await checkClaudeHome({ ...check.home, exists: true }, ports.packageRoot, ports.env, ports.probe, undefined, true);
      if (current.plugin.state === "unknown") throw new Error(`Claude plugin inventory is unavailable for ${check.home.path}`);
      if (current.next?.blocked) throw marketplaceRemovalRefusal(check.home.path);
    }
    if (current.next) throw new Error(`Claude setup exceeded six plugin steps for ${check.home.path}`);
    ports.current?.();
    const hook = installClaudeProfileHook(check.home);
    if (hook.state !== "installed") throw new Error(hook.reason);
    ports.print(`${check.home.path}: plugin current; hook ${hook.changed ? "installed" : "current"}. ${hook.reason}`);
  }
}
