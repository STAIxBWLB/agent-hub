import { looksSecret, MemoryStore } from "../memory/store.ts";
import type { SyncOptions } from "../memory/sync.ts";
import { rawMemoryCommand, rawGoalCommand } from "../memory/commands.ts";
import { memoryProjectKey } from "../memory/project.ts";
import { mentionsPrivatePath, promotionScreen, withoutPii } from "../hub/memory-policy.ts";
import { currentRouting, detectSignals } from "../hub/routing.ts";
import { loadConfig } from "../hub/daemon.ts";

export { MEMORY_USAGE, GOAL_USAGE } from "../memory/commands.ts";

const fail = (message: string): never => { throw new Error(message); };
/** The project's config, or none when there is no valid one (reading memory needs none). */
const loadConfigSafe = (cwd: string) => { try { return loadConfig(cwd); } catch { return undefined; } };

/** Hub wrapper: current project policy and TTL stay here; parsing and storage commands belong to the core. */
export function memoryCommand(args: string[], cwd: string, opts: { store?: MemoryStore; sync?: Omit<SyncOptions, "remote"> } = {}): Promise<string> {
  const privatePaths = (): string[] => { try { return loadConfig(cwd).pii?.paths ?? []; } catch (e) { return fail(`the project's config does not load (${(e as Error).message}); fix it before reading hub memory`); } };
  return rawMemoryCommand(args, cwd, { ...opts,
    open: () => new MemoryStore({ ttlMs: (loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000,
      screen: promotionScreen(memoryProjectKey(cwd), cwd, () => currentRouting(cwd), privatePaths) }),
    readable: notes => withoutPii(notes, currentRouting(cwd), cwd, privatePaths()),
    importPolicy: () => {
      const routing = currentRouting(cwd), policy = privatePaths();
      return text => detectSignals({ title: text, detail: "", refs: {} }, routing, cwd).includes("pii") || mentionsPrivatePath(text, [], policy, cwd);
    },
  });
}

export function goalCommand(args: string[], cwd: string, opts: { store?: MemoryStore; link?: (goal: string, task: string) => Promise<string> } = {}): Promise<string> {
  const policy = (): string[] => { try { return loadConfig(cwd).pii?.paths ?? []; } catch (e) { return fail(`the project's config does not load (${(e as Error).message}); fix it before using long-term tasks`); } };
  return rawGoalCommand(args, cwd, { ...opts, open: () => new MemoryStore(),
    clean: (title, milestones, project) => !looksSecret(`${title}\n${milestones.join("\n")}`) && withoutPii([{ title, text: milestones.join("\n"), project }], currentRouting(cwd), cwd, policy()).length > 0,
  });
}
