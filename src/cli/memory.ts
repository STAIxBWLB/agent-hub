import { detectCliIdentity } from "./identity.ts";
import { createStalenessProbe } from "../hub/memory-staleness.ts";
import { looksSecret, type MemoryStore } from "@staix/agent-mem";
import type { SyncOptions } from "@staix/agent-mem";
import { MEMORY_USAGE as CORE_MEMORY_USAGE, rawMemoryCommand, rawGoalCommand } from "@staix/agent-mem";
import { mentionsPrivatePath, promotionScreen, withoutPii } from "../hub/memory-policy.ts";
import { currentRouting, detectSignals } from "../hub/routing.ts";
import { loadConfig } from "../hub/daemon.ts";
import { bindProfileMemory, memoryProjectFor, openProfileMemory, MEMORY_PROFILE_UNAVAILABLE, MEMORY_SPLIT_INCOMPLETE, type MemoryProfileReceipt, type ProfileMemoryOptions } from "../hub/memory-profile.ts";

export { GOAL_USAGE } from "@staix/agent-mem";
export const MEMORY_USAGE = `${CORE_MEMORY_USAGE} | decay [--days N] [--json] | profile-check [--json]`;

const fail = (message: string): never => { throw new Error(message); };
/** The project's config, or none when there is no valid one (reading memory needs none). */
const loadConfigSafe = (cwd: string) => { try { return loadConfig(cwd); } catch { return undefined; } };


/** Bind each command at entry; the CLI closes default opens and injected stores remain caller-owned. */
function commandStores(provided: MemoryStore | undefined, options: ProfileMemoryOptions) {
  try { return { ...(provided ? bindProfileMemory(provided) : openProfileMemory(options)), owned: !provided }; }
  catch (error) { throw new Error(error instanceof Error && error.message === MEMORY_SPLIT_INCOMPLETE ? error.message : MEMORY_PROFILE_UNAVAILABLE); }
}
function profileOutput(text: string, json: boolean, profile: MemoryProfileReceipt | undefined, person: boolean): string {
  if (!profile) return text;
  if (profile.state !== "ready") throw new Error(MEMORY_PROFILE_UNAVAILABLE);
  if (json) return text;
  return `${text}\nmemory profile: ${profile.profile}${profile.generation ? ` ${person ? profile.generation : profile.generation.slice(0, 8)}` : ""}${person && profile.skippedRows ? `; skipped malformed legacy rows: ${profile.skippedRows}` : ""}`;
}

/** Hub wrapper: current project policy and TTL stay here; parsing and storage commands belong to the core. */
export async function memoryCommand(args: string[], cwd: string, opts: { store?: MemoryStore; sync?: Omit<SyncOptions, "remote">; now?: () => number; person?: boolean } = {}): Promise<string> {
  const person = opts.person ?? detectCliIdentity(process.env).role === "console";
  const privatePaths = (): string[] => { try { return loadConfig(cwd).pii?.paths ?? []; } catch (e) { return fail(`the project's config does not load (${(e as Error).message}); fix it before reading hub memory`); } };
  const rest = args.filter(arg => arg !== "--json");
  if (rest[0] === "decay") {
    if (!person) fail("memory decay requires person authority");
    let days = 90;
    if (rest.length !== 1) {
      if (rest.length !== 3 || rest[1] !== "--days" || !/^[1-9][0-9]*$/.test(rest[2]!)) fail("usage: ahub memory decay [--days N] [--json] (N must be a positive integer)");
      days = Number(rest[2]);
    }
    const cutoffMs = (opts.now ?? Date.now)() - days * 24 * 3600_000;
    if (!Number.isSafeInteger(days) || !Number.isFinite(cutoffMs) || Math.abs(cutoffMs) > 8_640_000_000_000_000) fail("--days is outside the supported date range");
    const cutoff = new Date(cutoffMs).toISOString();
    const project = memoryProjectFor(cwd), routing = currentRouting(cwd), paths = privatePaths();
    // Review must not promote a held source while reading it: only explicit person actions may append rows.
    const context = commandStores(opts.store, { project, deferPromotions: true, now: opts.now });
    const store = context.store;
    try {
      context.binding.assertCurrent();
      const candidates = store.withDeferredPromotions(() => {
        const goals = store.goals(project).filter(goal => goal.state !== "done" && goal.state !== "dropped");
        const linkedTasks = new Set(goals.flatMap(goal => goal.links.map(link => link.task)));
        const openGoals = new Set(goals.map(goal => `goal:${goal.id}`));
        return withoutPii(store.list({ project, tier: "long", limit: Number.MAX_SAFE_INTEGER }).filter(note =>
          note.project === project && Date.parse(note.at) < cutoffMs
          && !(note.task && linkedTasks.has(note.task))
          && !note.about.some(node => openGoals.has(node) || (node.startsWith("task:") && linkedTasks.has(node.slice(5))))), routing, cwd, paths);
      });
      const profile = context.binding.status(store);
      if (args.includes("--json")) return profileOutput(JSON.stringify({ days, cutoff, candidates, memoryProfile: profile }), true, profile, person);
      const text = candidates.length
        ? [`${candidates.length} decay candidate${candidates.length === 1 ? "" : "s"} older than ${days} days (review only):`, ...candidates.map(note => `mem:${note.id} ${note.at} ${note.kind}: ${note.title ?? note.text}`)].join("\n")
        : `no decay candidates older than ${days} days`;
      return profileOutput(text, false, profile, person);
    } finally { if (context.owned) store.close(); }
  }
  let showStale = false;
  const project = memoryProjectFor(cwd);
  const context = commandStores(opts.store, { project, ttlMs: (loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000,
    screen: promotionScreen(project, cwd, () => currentRouting(cwd), privatePaths) });
  try {
    context.binding.assertCurrent();
    const text = await rawMemoryCommand(args, cwd, { ...opts, project, store: context.store, open: () => context.store,
      readable: notes => {
      const paths = privatePaths(), visible = withoutPii(notes, currentRouting(cwd), cwd, paths);
      if (args[0] !== "show" || args.includes("--json")) return visible;
      const stale = createStalenessProbe({ cwd, privatePaths: paths, deny: loadConfigSafe(cwd)?.local.deny ?? [] });
      showStale = visible.some(note => stale(note.about));
      return visible;
    },
      importPolicy: () => {
      const routing = currentRouting(cwd), policy = privatePaths();
      return text => detectSignals({ title: text, detail: "", refs: {} }, routing, cwd).includes("pii") || mentionsPrivatePath(text, [], policy, cwd);
    },
    });
    return profileOutput(showStale ? `${text}\n(stale?)` : text, args.includes("--json"), context.binding.status(context.store), person);
  } finally { if (context.owned) context.store.close(); }
}

export async function goalCommand(args: string[], cwd: string, opts: { store?: MemoryStore; link?: (goal: string, task: string) => Promise<string>; person?: boolean } = {}): Promise<string> {
  const person = opts.person ?? detectCliIdentity(process.env).role === "console";
  const policy = (): string[] => { try { return loadConfig(cwd).pii?.paths ?? []; } catch (e) { return fail(`the project's config does not load (${(e as Error).message}); fix it before using long-term tasks`); } };
  const project = memoryProjectFor(cwd);
  const context = commandStores(opts.store, { project });
  try {
    context.binding.assertCurrent();
    const text = await rawGoalCommand(args, cwd, { ...opts, project, store: context.store, open: () => context.store,
      clean: (title, milestones, project) => !looksSecret(`${title}\n${milestones.join("\n")}`) && withoutPii([{ title, text: milestones.join("\n"), project }], currentRouting(cwd), cwd, policy()).length > 0,
    });
    return profileOutput(text, args.includes("--json"), context.binding.status(context.store), person);
  } finally { if (context.owned) context.store.close(); }
}
