import { TaskRepositories } from "../hub/task-repository.ts";
import type { TaskPlan, TaskRefs } from "../hub/board.ts";
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CodeFacts } from "../hub/code-facts.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "../hub/db-timeout.ts";
import { hubGitEnv, hubGitSync } from "../hub/git.ts";
import { stateDirFor } from "../hub/control-client.ts";
import { isDenied } from "../local/deny.ts";
import { foldSegment } from "../hub/permission-mode.ts";
import { matchesPolicyLexically } from "../hub/path-policy.ts";
import { memoryAnchorTaskIdentity, memoryStaleAnchors, unavailableMemoryStaleAnchors, type MemoryStaleAnchorReport, type MemoryTaskPrivacy } from "../hub/memory-stale-anchors.ts";
import { MEMORY_SYMBOL_START_BUDGET_MS } from "../hub/memory-symbols.ts";
import { detectCliIdentity } from "./identity.ts";
import { createStalenessProbe } from "../hub/memory-staleness.ts";
import { looksSecret, memoryProjectKey, pathCandidates, readProfileJSON, resolveShardProfile, type MemoryStore } from "@staix/agent-mem";
import type { SyncOptions } from "@staix/agent-mem";
import { MEMORY_USAGE as CORE_MEMORY_USAGE, rawMemoryCommand, rawGoalCommand } from "@staix/agent-mem";
import { mentionsPrivatePath, promotionScreen, withoutPii } from "../hub/memory-policy.ts";
import { currentRouting, detectSignals } from "../hub/routing.ts";
import { loadConfig } from "../hub/daemon.ts";
import { bindProfileMemory, memoryProjectFor, memoryProjectForStore, openProfileMemory, MemoryProfileBinding, MEMORY_PROFILE_UNAVAILABLE, MEMORY_SPLIT_INCOMPLETE, type MemoryProfileReceipt, type ProfileMemoryOptions } from "../hub/memory-profile.ts";

export { GOAL_USAGE } from "@staix/agent-mem";
export const MEMORY_USAGE = `${CORE_MEMORY_USAGE} | decay [--days N] [--json] | profile-check [--json]`;

const fail = (message: string): never => { throw new Error(message); };
/** The project's config, or none when there is no valid one (reading memory needs none). */
const loadConfigSafe = (cwd: string) => { try { return loadConfig(cwd); } catch { return undefined; } };


/** The project key: an injected store resolves the alias in its own home, the default open in the ambient one (#240). */
const projectOf = (cwd: string, provided: MemoryStore | undefined): string => provided ? memoryProjectForStore(provided, cwd) : memoryProjectFor(cwd);

/** Bind each command at entry; the CLI closes default opens and injected stores remain caller-owned. */
function commandStores(provided: MemoryStore | undefined, options: ProfileMemoryOptions, cwd: string) {
  try { return { ...(provided ? bindProfileMemory(provided, undefined, memoryProjectKey(cwd)) : openProfileMemory(options)), owned: !provided }; }
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
    const project = projectOf(cwd, opts.store), routing = currentRouting(cwd), paths = privatePaths();
    // Review must not promote a held source while reading it: only explicit person actions may append rows.
    const context = commandStores(opts.store, { project, deferPromotions: true, now: opts.now }, cwd);
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
  const project = projectOf(cwd, opts.store);
  const context = commandStores(opts.store, { project, ttlMs: (loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000,
    screen: promotionScreen(project, cwd, () => currentRouting(cwd), privatePaths) }, cwd);
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
  const project = projectOf(cwd, opts.store);
  const context = commandStores(opts.store, { project }, cwd);
  try {
    context.binding.assertCurrent();
    const text = await rawGoalCommand(args, cwd, { ...opts, project, store: context.store, open: () => context.store,
      clean: (title, milestones, project) => !looksSecret(`${title}\n${milestones.join("\n")}`) && withoutPii([{ title, text: milestones.join("\n"), project }], currentRouting(cwd), cwd, policy()).length > 0,
    });
    return profileOutput(text, args.includes("--json"), context.binding.status(context.store), person);
  } finally { if (context.owned) context.store.close(); }
}


interface StaleAnchorCommandOptions {
  store?: MemoryStore;
  facts?: Pick<CodeFacts, "exists">;
  stateDir?: string;
  head?: () => string | undefined;
  taskPrivacy?: (key: string) => MemoryTaskPrivacy;
  now?: () => number;
}
/** Unlike an ordinary core open, inspection must not initialize a missing profile, machine or shard. */
function existingInspectionProfile(project: string, cwd: string): boolean {
  try {
    const binding = new MemoryProfileBinding({ project, projectKey: memoryProjectKey(cwd) });
    const profiles = [binding.profile, ...(binding.profile.sharded ? [resolveShardProfile(binding.home, { user: true })] : [])];
    for (const profile of profiles) {
      const machineFile = join(profile.sharded ? profile.home : profile.dir, "machine.json"), machine = lstatSync(machineFile);
      if (!machine.isFile() || machine.isSymbolicLink()) return false;
      const metadata = readProfileJSON(machineFile, 4096) as { id?: unknown } | undefined;
      if (!metadata || typeof metadata.id !== "string" || !/^[a-f0-9]{16}$/.test(metadata.id)) return false;
      for (const name of ["log", "local"]) { const folder = lstatSync(join(profile.dir, name)); if (!folder.isDirectory() || folder.isSymbolicLink()) return false; }
    }
    binding.assertCurrent(); return true;
  } catch { return false; }
}

/** Host-only doctor report: selected amem reads may maintain derived indexes/leases, never notes or candidates. */
export async function memoryStaleAnchorsCommand(cwd: string, opts: StaleAnchorCommandOptions = {}): Promise<MemoryStaleAnchorReport> {
  let ownedFacts: CodeFacts | undefined;
  let context: ReturnType<typeof commandStores> | undefined;
  try {
    const project = projectOf(cwd, opts.store);
    if (!opts.store && !existingInspectionProfile(project, cwd)) return unavailableMemoryStaleAnchors();
    context = commandStores(opts.store, { project, projectKey: memoryProjectKey(cwd), deferPromotions: true }, cwd);
    const config = () => loadConfig(cwd);
    const publicMetadataText = (text: string): boolean => {
      try {
        const c = config(), paths = [...(c.pii?.paths ?? []), ...c.local.deny];
        return !looksSecret(text) && !detectSignals({ title: "", detail: text, refs: {} }, currentRouting(cwd), cwd).includes("pii")
          && !mentionsPrivatePath(text, [], paths, cwd)
          && !pathCandidates(text).some(path => isDenied(path, c.local.deny) || isDenied(foldSegment(path), c.local.deny.map(foldSegment)));
      } catch { return false; }
    };
    const clock = opts.now ?? performance.now.bind(performance), metadataDeadline = clock() + MEMORY_SYMBOL_START_BUDGET_MS;
    const blockedTasks = new Map<string, "private" | "unknown">(), repositories = new TaskRepositories(cwd); let taskSourceUnavailable = false;
    const taskPrivacy = opts.taskPrivacy ?? ((key: string): MemoryTaskPrivacy => {
      const identity = memoryAnchorTaskIdentity(key, project); if (!identity) return "unknown";
      const blocked = blockedTasks.get(key); if (blocked) return blocked;
      if (taskSourceUnavailable || clock() >= metadataDeadline) return "unknown";
      let db: Database | undefined;
      try {
        const file = join(opts.stateDir ?? stateDirFor(cwd), "hub.db"), stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) { taskSourceUnavailable = true; return "unknown"; }
        db = new Database(file, { readonly: true, create: false });
        db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
        const row = db.query(`SELECT id,created,signals,title,detail,refs,plan FROM tasks WHERE id=? AND created=?
          AND length(signals)<=65536 AND length(title)<=300 AND length(detail)<=8000 AND length(refs)<=65536 AND length(plan)<=65536`).get(identity.id, identity.created) as { id: number; created: number; signals: string; title: string; detail: string; refs: string; plan: string } | null;
        if (!row || row.id !== identity.id || row.created !== identity.created) { blockedTasks.set(key, "unknown"); return "unknown"; }
        const signals: unknown = JSON.parse(row.signals), refs: unknown = JSON.parse(row.refs), plan: unknown = JSON.parse(row.plan);
        if (!Array.isArray(signals) || !signals.every(signal => typeof signal === "string") || !refs || typeof refs !== "object" || Array.isArray(refs) || !plan || typeof plan !== "object" || Array.isArray(plan)) { blockedTasks.set(key, "unknown"); return "unknown"; }
        const raw = [row.title, row.detail];
        JSON.stringify({ refs, plan }, (key: string, value: unknown) => { if (key) raw.push(key); if (typeof value === "string") raw.push(value); return value; });
        if (signals.includes("pii") || signals.includes("pii_path") || !publicMetadataText(raw.join("\n"))) { blockedTasks.set(key, "private"); return "private"; }
        const paths = [...Object.values(refs), ...Object.values(plan)].flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
        const c = config();
        if (paths.some(path => isDenied(path, c.local.deny) || matchesPolicyLexically(cwd, path, [...(c.pii?.paths ?? []), ...c.local.deny]))) { blockedTasks.set(key, "private"); return "private"; }
        const scope = repositories.scope(refs as TaskRefs);
        if (scope.key !== repositories.project.key || repositories.mismatch(refs as TaskRefs, plan as TaskPlan)) { blockedTasks.set(key, "unknown"); return "unknown"; }
        return "public";
      } catch { taskSourceUnavailable = true; return "unknown"; }
      finally { db?.close(); }
    });
    const head = opts.head ?? (() => {
      try {
        const result = hubGitSync(["-C", cwd, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", env: hubGitEnv(process.env, { repositoryIsolation: true }), timeout: 1000, maxBuffer: 4096 });
        const value = result.stdout.trim(); return result.status === 0 && /^[a-f0-9]{40}$/.test(value) ? value : undefined;
      } catch { return undefined; }
    });
    const facts = opts.facts ?? (ownedFacts = new CodeFacts({ timeoutMs: MEMORY_SYMBOL_START_BUDGET_MS }));
    const binding = context.binding;
    return await memoryStaleAnchors({ cwd, project, store: context.store, head, now: opts.now, taskPrivacy, publicMetadataText,
      assertCurrent: () => binding.assertCurrent(),
      context: () => ({ cwd, project, repo: project, deny: config().local.deny, allowed: publicMetadataText }),
      exists: (repo, at, name) => facts.exists(repo, at, name),
      finishQueries: async () => { if (ownedFacts) { await ownedFacts.close(); ownedFacts = undefined; } } });
  } catch { return unavailableMemoryStaleAnchors(); }
  finally { try { if (ownedFacts) await ownedFacts.close(); } finally { if (context?.owned) context.store.close(); } }
}
