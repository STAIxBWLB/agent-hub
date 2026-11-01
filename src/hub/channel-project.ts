// Which project and state directory the Claude channel plugin joins (#604 PR B, agent-hub#1030 item 10). It applies the same decision the CLI makes at startup: `projectContext` for an
// ordinary process, plus the one exception the CLI has for a declared extra instance, whose cwd is its own managed worktree and whose state directory is the main project's by design.
// Without this the plugin trusted an inherited AGENTHUB_STATE_DIR as is, so a Claude process started in `<repo>/.worktrees/<name>` that inherited the main checkout's variables joined the
// main repository's hub.
//
// Limit, stated plainly: this stops accidental and inherited-environment joins. It is not a defence against a same-user process that sets the variables and the launch evidence itself.
import { definitionOf } from "../adapters/registry.ts";
import { readInstanceConfig } from "./instance-config.ts";
import { effectiveInstanceRoles } from "./instances.ts";
import { resolveInstanceExecutionCwd } from "./instance-execution.ts";
import { inheritedStateDir, projectContext, projectRoot, realPath } from "./project.ts";

export interface ChannelProject { root: string; stateDir: string; /** True when the state directory came from the inherited environment, proven. */ inherited: boolean }

/**
 * `cwd` is the plugin process's working directory, `env` its environment, `policyRoles(root)` the configured roles of a project (the same merge the plugin and the CLI use). Returns
 * `undefined` when the process has no project of its own, or when it names a declared instance whose workspace is not its cwd: the plugin then refuses to start.
 */
export function channelProject(cwd: string, env: NodeJS.ProcessEnv, policyRoles: (root: string) => Record<string, string[]>): ChannelProject | undefined {
  let own: ReturnType<typeof projectContext>;
  try { own = projectContext(cwd, {}); } catch { return undefined; }
  const peer = env.AGENTHUB_PEER_ID, declaredRoot = env.AGENTHUB_PROJECT_DIR?.trim();
  if (peer && declaredRoot && !definitionOf(peer)) {
    // A declared extra instance: its workspace is the exact managed worktree the project declares for it, and its hub is the project that declares it.
    try {
      const root = realPath(declaredRoot), config = readInstanceConfig(root);
      if (config.instances && Object.hasOwn(config.instances, peer)) {
        const workspace = resolveInstanceExecutionCwd(root, peer, config.instances, effectiveInstanceRoles(peer, config.instances, policyRoles(root), config.catalog), config.catalog);
        if (realPath(projectRoot(cwd)) !== realPath(workspace)) return undefined;
        const stateDir = inheritedStateDir(root, env);
        return stateDir ? { root, stateDir, inherited: true } : undefined;
      }
    } catch { return undefined; }
  }
  const inherited = inheritedStateDir(own.root, env);
  return inherited ? { root: own.root, stateDir: inherited, inherited: true } : { root: own.root, stateDir: own.stateDir, inherited: false };
}
