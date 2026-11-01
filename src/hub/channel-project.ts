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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, inheritedStateDir, projectContext, projectRoot, realPath } from "./project.ts";

export interface ChannelProject {
  root: string; stateDir: string;
  /** True when the state directory came from the inherited environment, proven. */
  inherited: boolean;
  /**
   * Set when this process has no project of its own and an inherited state directory that records another project (agent-hub#1036): it joins that hub as a distinct session, never as the
   * peer id it names. `label` is the origin part of the id the hub mints (`<peer>~<label>`), or empty to let the hub choose a short one.
   */
  session?: { label: string };
}

/**
 * `cwd` is the plugin process's working directory, `env` its environment, `policyRoles(root)` the configured roles of a project (the same merge the plugin and the CLI use).
 * Returns `undefined` only when there is nothing to join at all: no project of its own and no inherited state directory. Everything else joins something (agent-hub#1036: nothing that
 * works today is refused): the proven project, the cwd's own project, or, when the process cannot prove it belongs to the hub its environment names, that hub as a distinct session.
 */
export function channelProject(cwd: string, env: NodeJS.ProcessEnv, policyRoles: (root: string) => Record<string, string[]>): ChannelProject | undefined {
  const override = env.AGENTHUB_STATE_DIR?.trim(), declared = env.AGENTHUB_PROJECT_DIR?.trim();
  // The origin label is left empty on purpose: the hub mints a short id, so no directory name reaches a header another agent reads.
  const asSession = (): ChannelProject | undefined => override
    ? { root: declared ? canonicalPath(declared) : "", stateDir: canonicalPath(override), inherited: false, session: { label: "" } } : undefined;
  let own: ReturnType<typeof projectContext>;
  try { own = projectContext(cwd, {}); } catch { return asSession(); }
  const peer = env.AGENTHUB_PEER_ID;
  if (peer && declared && !definitionOf(peer)) {
    // A declared extra instance: its workspace is the exact managed worktree the project declares for it, and its hub is the project that declares it.
    try {
      const root = realPath(declared), config = readInstanceConfig(root);
      if (config.instances && Object.hasOwn(config.instances, peer)) {
        const workspace = resolveInstanceExecutionCwd(root, peer, config.instances, effectiveInstanceRoles(peer, config.instances, policyRoles(root), config.catalog), config.catalog);
        if (realPath(projectRoot(cwd)) !== realPath(workspace)) return asSession();
        const stateDir = inheritedStateDir(root, env);
        return stateDir ? { root, stateDir, inherited: true } : asSession();
      }
    } catch { return asSession(); }
  }
  const inherited = inheritedStateDir(own.root, env);
  if (inherited) return { root: own.root, stateDir: inherited, inherited: true };
  // No project of its own (no .agenthub/config.json up to the git boundary) and an inherited state directory that is not proven to belong here: it joins that hub as a distinct session.
  // With a project of its own (a linked worktree, say) it keeps that project's own hub, as before.
  if (override && !existsSync(join(own.root, ".agenthub", "config.json"))) return asSession();
  return { root: own.root, stateDir: own.stateDir, inherited: false };
}
