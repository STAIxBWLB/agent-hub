import { TaskRepositories } from "../hub/task-repository.ts";
import type { TaskPlan, TaskRefs } from "../hub/board.ts";
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CodeFacts } from "../hub/code-facts.ts";
import { HUB_DB_BUSY_TIMEOUT_MS } from "../hub/db-timeout.ts";
import { hubGitEnv, hubGitSync } from "../hub/git.ts";
import { stateDirFor, ControlClient } from "../hub/control-client.ts";
import { scheduleWhen } from "../hub/schedules.ts";
import { isDenied } from "../local/deny.ts";
import { foldSegment } from "../hub/permission-mode.ts";
import { matchesPolicyLexically } from "../hub/path-policy.ts";
import { memoryAnchorTaskIdentity, memoryStaleAnchors, unavailableMemoryStaleAnchors, type MemoryStaleAnchorReport, type MemoryTaskPrivacy } from "../hub/memory-stale-anchors.ts";
import { MEMORY_SYMBOL_START_BUDGET_MS } from "../hub/memory-symbols.ts";
import { AGENT_MEMORY_RECORDING_SUBS, detectCliIdentity } from "./identity.ts";
import { withAgentAttribution } from "./agent-attribution.ts";
import { createStalenessProbe } from "../hub/memory-staleness.ts";
import { looksSecret, memoryHome, memoryProjectKey, pathCandidates, readProfileJSON, resolveShardProfile, type MemoryStore } from "@staix/agent-mem";
import type { SyncOptions } from "@staix/agent-mem";
import { memoryUsage, goalUsage, rawMemoryCommand, rawGoalCommand } from "@staix/agent-mem";

/** The hub's command names in agent-mem usage and refusal text (agent-mem 0.7.0 defaults to `amem`). */
const AHUB_NAMES = { memory: "ahub memory", goal: "ahub goal" };
import { mentionsPrivatePath, promotionScreen, withoutPii } from "../hub/memory-policy.ts";
import { currentRouting, detectSignals } from "../hub/routing.ts";
import { loadConfig } from "../hub/daemon.ts";
import { bindProfileMemory, memoryProjectFor, memoryProjectForStore, openProfileMemory, MemoryProfileBinding, MEMORY_PROFILE_UNAVAILABLE, MEMORY_SPLIT_INCOMPLETE, type MemoryProfileReceipt, type ProfileMemoryOptions } from "../hub/memory-profile.ts";
import { createMemorySyncPolicy, inspectDeclinedMemoryRows, projectMemorySyncText } from "../hub/memory-sync-policy.ts";

export const GOAL_USAGE = goalUsage(AHUB_NAMES.goal);
export const MEMORY_USAGE = `${memoryUsage(AHUB_NAMES.memory)} | decay [--days N] [--json] | declined [--json] | profile-check [--json] | review on|off|status [--json]`;

const fail = (message: string): never => { throw new Error(message); };
/** The project's config, or none when there is no valid one (reading memory needs none). */
const loadConfigSafe = (cwd: string) => { try { return loadConfig(cwd); } catch { return undefined; } };


/** The project key: an injected store resolves the alias in its own home, the default open in the ambient one (#240). */
const projectOf = (cwd: string, provided: MemoryStore | undefined): string => provided ? memoryProjectForStore(provided, cwd) : memoryProjectFor(cwd);

/** Bounded, read-only lookup of current task paths that the daemon's promotion screen also considers. */
function memoryTaskPaths(cwd: string, boundProject: string, rowProject: string, key: string): string[] | undefined {
  if (rowProject !== boundProject) return [];
  const identity = memoryAnchorTaskIdentity(key, boundProject);
  if (!identity) return [];
  let db: Database | undefined;
  try {
    const file = join(stateDirFor(cwd), "hub.db");
    let stat;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    db = new Database(file, { readonly: true, create: false });
    db.run(`PRAGMA busy_timeout = ${HUB_DB_BUSY_TIMEOUT_MS}`);
    const row = db.query(`SELECT id,created,length(refs) AS refsLength,length(plan) AS planLength,
      CASE WHEN length(refs)<=65536 THEN refs END AS refs,CASE WHEN length(plan)<=65536 THEN plan END AS plan
      FROM tasks WHERE id=? AND created=?`).get(identity.id, identity.created) as { id: number; created: number; refsLength: number; planLength: number; refs: string | null; plan: string | null } | null;
    if (!row || row.id !== identity.id || row.created !== identity.created) return [];
    if (row.refsLength > 65536 || row.planLength > 65536 || typeof row.refs !== "string" || typeof row.plan !== "string") return undefined;
    const refs: unknown = JSON.parse(row.refs), plan: unknown = JSON.parse(row.plan);
    if (!refs || typeof refs !== "object" || Array.isArray(refs) || !plan || typeof plan !== "object" || Array.isArray(plan)) return undefined;
    const refPaths = (refs as TaskRefs).paths ?? [], planPaths = (plan as TaskPlan).paths ?? [];
    if (!Array.isArray(refPaths) || !refPaths.every(path => typeof path === "string") || !Array.isArray(planPaths) || !planPaths.every(path => typeof path === "string")) return undefined;
    return [...refPaths, ...planPaths];
  } catch { return undefined; }
  finally { db?.close(); }
}

function hostSyncPolicyInputs(cwd: string, home: string, boundProject: string, profile?: MemoryProfileReceipt): { version: string; denyPaths: string[]; piiPaths: string[]; piiPatterns: string[]; routing: ReturnType<typeof currentRouting> } {
  const config = loadConfig(cwd), routing = currentRouting(cwd);
  const denyPaths = [...config.local.deny], piiPaths = [...(config.pii?.paths ?? [])], piiPatterns = [...routing.signals.pii_patterns];
  return { version: JSON.stringify({ home, boundProject, profile: profile ? { profile: profile.profile, generation: profile.generation, selectorRevision: profile.selectorRevision } : null, denyPaths, piiPaths, piiPatterns }), denyPaths, piiPaths, piiPatterns, routing };
}
function createHubMemorySyncPolicy(cwd: string, home: string, boundProject: string, profile?: MemoryProfileReceipt) {
  const inputs = hostSyncPolicyInputs(cwd, home, boundProject, profile);
  const policy = createMemorySyncPolicy({
    home, cwd, denyPaths: inputs.denyPaths, piiPatterns: inputs.piiPatterns,
    hostScreen: row => {
      const task = typeof row.task === "string" ? row.task : "";
      const project = typeof row.project === "string" ? row.project : "";
      const about = Array.isArray(row.about) ? row.about.filter((node): node is string => typeof node === "string") : [];
      const taskPaths = memoryTaskPaths(cwd, boundProject, project, task);
      if (task && taskPaths === undefined) return { ok: false, rule: "hub privacy policy unavailable" };
      const enrichedAbout = [...about, ...(taskPaths ?? []).map(path => `path:${path}`)];
      const visible = withoutPii([{
        title: typeof row.title === "string" ? row.title : null,
        text: JSON.stringify(row), about: enrichedAbout,
        ...(task ? { task } : {}), ...(project ? { project } : {}),
      }], inputs.routing, cwd, inputs.piiPaths).length > 0;
      return visible ? { ok: true } : { ok: false, rule: "hub privacy policy: PII pattern or private path" };
    },
  });
  return { policy, version: inputs.version };
}

/** Preserve any trusted caller's stricter sync screen and bind its epoch into the host policy stamp. */
export function composeMemorySyncOptions(host: Pick<SyncOptions, "screen" | "policyVersion">, caller?: Omit<SyncOptions, "remote">, canonical = false): Omit<SyncOptions, "remote"> {
  return {
    ...caller,
    screen: row => {
      try {
        const content = projectMemorySyncText(row, canonical);
        return host.screen?.(content) === true && (caller?.screen ? caller.screen(content) === true : true);
      }
      catch { return false; }
    },
    policyVersion: () => JSON.stringify([host.policyVersion?.() ?? null, caller?.policyVersion?.() ?? null]),
  };
}

/** Bind each command at entry; the CLI closes default opens and injected stores remain caller-owned. */
function commandStores(provided: MemoryStore | undefined, options: ProfileMemoryOptions, cwd: string) {
  try { return { ...(provided ? bindProfileMemory(provided, undefined, memoryProjectKey(cwd)) : openProfileMemory(options)), owned: !provided }; }
  catch (error) { throw new Error(error instanceof Error && error.message === MEMORY_SPLIT_INCOMPLETE ? error.message : MEMORY_PROFILE_UNAVAILABLE); }
}
/** What a JSON receipt may carry for an agent (#1522): the kind, state and generation prefix, never the home path, selector, version or skip totals the person sees. */
const shownReceipt = (profile: MemoryProfileReceipt | undefined, person: boolean) =>
  person || !profile ? profile : { profile: profile.profile, state: profile.state, ...(profile.generation ? { generation: profile.generation.slice(0, 8) } : {}) };
function profileOutput(text: string, json: boolean, profile: MemoryProfileReceipt | undefined, person: boolean): string {
  if (!profile) return text;
  if (profile.state !== "ready") throw new Error(MEMORY_PROFILE_UNAVAILABLE);
  if (json) return text;
  return `${text}\nmemory profile: ${profile.profile}${profile.generation ? ` ${person ? profile.generation : profile.generation.slice(0, 8)}` : ""}${person && profile.skippedRows ? `; skipped malformed legacy rows: ${profile.skippedRows}` : ""}`;
}

/** Hub wrapper: current project policy and TTL stay here; parsing and storage commands belong to the core. */
export async function memoryCommand(args: string[], cwd: string, opts: { store?: MemoryStore; sync?: Omit<SyncOptions, "remote">; now?: () => number; person?: boolean; /** The agent shell's peer id (#1522): its changes are recorded under this name. */ agent?: string } = {}): Promise<string> {
  const person = opts.person ?? detectCliIdentity(process.env).role === "console";
  const sub = args.find(arg => arg !== "--json");
  // #1522: an agent runs the family as itself. The recording commands run inside amem's agent attribution, so every writer stamps the agent (never "user")
  // and amem applies its screened-visibility checks to each target; with no agent peer id, or no way to attribute, a change is refused rather than run as the person.
  if (!person && sub !== undefined && AGENT_MEMORY_RECORDING_SUBS.includes(sub)) {
    const peer = opts.agent ?? (() => { const identity = detectCliIdentity(process.env); return identity.role === "tools" ? identity.peer : undefined; })();
    if (peer === undefined) fail(`memory ${sub} changes memory and needs an identified agent or the person; no agent identity was found, so nothing was run`);
    return withAgentAttribution(peer!, cwd, () => memoryCommandBody(args, cwd, opts, person));
  }
  return memoryCommandBody(args, cwd, opts, person);
}

/**
 * #1329 part 1: `ahub memory review on|off|status`. The switch, its caps and the open card's cancellation are the daemon's
 * (`memory_review`), so this only carries the answer: the config write, the pause that stops the timer at once and the
 * `Tasks.cancel` of the card a run left open all happen in one op, in that order, where the schedule and the board are.
 */
async function memoryReviewCommand(args: string[], cwd: string, person: boolean): Promise<string> {
  const json = args.includes("--json");
  const rest = args.filter(arg => arg !== "--json");
  const action = rest[1];
  if (rest.length !== 2 || (action !== "on" && action !== "off" && action !== "status")) fail("usage: ahub memory review on|off|status [--json]");
  // The switch is machine-local and a person's: an agent shell must not turn it on, and it must not read as the console either.
  if (!person) fail(`memory review ${action} is the person's switch on the machine-local memory.review config; run it in the person's terminal or the console`);
  const hub = await ControlClient.connect(stateDirFor(cwd), { role: "console", projectRoot: cwd }, 5_000);
  try {
    const res = await hub.request({ t: "task", op: "memory_review", args: { action } }, 30_000);
    if (!res.ok) fail(res.error);
    if (json) return res.text;
    const data = JSON.parse(res.text) as {
      action: string; enabled?: boolean; cancelled?: number; error?: string;
      review?: { every?: string; max_notes?: number; projects?: string[]; max_tokens_run?: number; max_tokens_week?: number };
      schedule?: { state: string; next: number; last?: number; task?: number; error?: string; zone?: string };
    };
    const review = data.review ?? {}, lines = [`memory review: ${data.enabled ? "on" : "off"}`];
    if (data.cancelled !== undefined) lines.push(`cancelled the open review task #${data.cancelled}`);
    if (data.error) lines.push(`not changed: ${data.error}`);
    if (review.every !== undefined) lines.push(`period: every ${review.every}`);
    lines.push(`caps: ${review.max_tokens_run ?? "unset"} per run, ${review.max_tokens_week ?? "unset"} per week`);
    if (review.max_notes !== undefined) lines.push(`notes per run: at most ${review.max_notes}`);
    if (review.projects?.length) lines.push(`projects: ${review.projects.join(", ")}`);
    const schedule = data.schedule;
    lines.push(schedule
      ? `schedule: ${schedule.state}, next ${scheduleWhen(schedule, schedule.next)}${schedule.task !== undefined ? `, last task #${schedule.task}` : ""}${schedule.error ? `, last error: ${schedule.error}` : ""}`
      : "schedule: not running here (the switch is off, or this project is not one it selects)");
    lines.push("spend: unknown (the hub counts no tokens for a review turn yet, so the caps are declared and the stop that enforces them lands with #1329 part 2)");
    return lines.join("\n");
  } finally { hub.close(); }
}

async function memoryCommandBody(args: string[], cwd: string, opts: { store?: MemoryStore; sync?: Omit<SyncOptions, "remote">; now?: () => number }, person: boolean): Promise<string> {
  const privatePaths = (): string[] => { try { return loadConfig(cwd).pii?.paths ?? []; } catch (e) { return fail(`the project's config does not load (${(e as Error).message}); fix it before reading hub memory`); } };
  const rest = args.filter(arg => arg !== "--json");
  if (rest[0] === "review") return memoryReviewCommand(args, cwd, person);
  if (rest[0] === "decay") {
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
      // #1522: decay is open to an agent, so its JSON carries only the receipt an agent may see.
      if (args.includes("--json")) return profileOutput(JSON.stringify({ days, cutoff, candidates, memoryProfile: shownReceipt(profile, person) }), true, profile, person);
      const text = candidates.length
        ? [`${candidates.length} decay candidate${candidates.length === 1 ? "" : "s"} older than ${days} days (review only):`, ...candidates.map(note => `mem:${note.id} ${note.at} ${note.kind}: ${note.title ?? note.text}`)].join("\n")
        : `no decay candidates older than ${days} days`;
      return profileOutput(text, false, profile, person);
    } finally { if (context.owned) store.close(); }
  }
  if (rest[0] === "declined") {
    if (rest.length !== 1) fail("usage: ahub memory declined [--json]");
    const project = projectOf(cwd, opts.store);
    const context = commandStores(opts.store, { project, deferPromotions: true, now: opts.now }, cwd);
    try {
      context.binding.assertCurrent();
      const boundPolicy = createHubMemorySyncPolicy(cwd, context.binding.home, project, context.binding.status(context.store));
      const result = inspectDeclinedMemoryRows(context.store, { screen: (row, canonical) => {
        const content = projectMemorySyncText(row, canonical);
        const host = boundPolicy.policy.screen(content, true);
        if (!host.ok) return host;
        try { return opts.sync?.screen ? (opts.sync.screen(content) === true ? { ok: true } : { ok: false, rule: "caller sync policy" }) : { ok: true }; }
        catch { return { ok: false, rule: "caller sync policy" }; }
      } }, () => JSON.stringify([boundPolicy.version, opts.sync?.policyVersion?.() ?? null]));
      context.binding.assertCurrent();
      const profile = context.binding.status(context.store);
      if (hostSyncPolicyInputs(cwd, context.binding.home, project, profile).version !== boundPolicy.version)
        fail("memory declined policy changed during inspection; retry with stable privacy policy");
      if (args.includes("--json")) return JSON.stringify({ rows: result.rows, complete: result.complete, ...(result.reason ? { reason: result.reason } : {}), memoryProfile: shownReceipt(profile, person) });
      const text = result.complete
        ? result.rows.length
          ? [`${result.rows.length} declined physical outbound row${result.rows.length === 1 ? "" : "s"}:`, ...result.rows.map(row => `mem:${row.id} ${row.rule}`), "Review the source or approved policy, then run `ahub memory sync`. `forget` does not remove append-only physical rows."].join("\n")
          : "no declined physical outbound rows; inspection complete"
        : [`declined-row inspection incomplete: ${result.reason ?? "physical memory rows could not be inspected"}`, ...(result.rows.length ? [`${result.rows.length} declined row${result.rows.length === 1 ? "" : "s"} found before inspection stopped:`, ...result.rows.map(row => `mem:${row.id} ${row.rule}`)] : []), "No complete result is available; resolve the inspection issue before treating the list as empty."].join("\n");
      return text;
    } finally { if (context.owned) context.store.close(); }
  }
  let showStale = false;
  const project = projectOf(cwd, opts.store);
  let policyHome = opts.store?.profile.home ?? memoryHome();
  const context = commandStores(opts.store, { project, ttlMs: (loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000,
    screen: promotionScreen(project, cwd, () => currentRouting(cwd), privatePaths, task => memoryTaskPaths(cwd, project, project, task) ?? [], () => createHubMemorySyncPolicy(cwd, policyHome, project).policy) }, cwd);
  policyHome = context.binding.home;
  try {
    context.binding.assertCurrent();
    let boundSyncPolicy: ReturnType<typeof createHubMemorySyncPolicy> | undefined;
    const syncPolicy = () => boundSyncPolicy ??= createHubMemorySyncPolicy(cwd, context.binding.home, project, context.binding.status(context.store));
    const text = await rawMemoryCommand(args, cwd, { ...opts, names: AHUB_NAMES, project, store: context.store, open: () => context.store,
      sync: composeMemorySyncOptions({ screen: row => syncPolicy().policy.screen(row, true).ok,
        policyVersion: () => { context.binding.assertCurrent(); return hostSyncPolicyInputs(cwd, context.binding.home, project, context.binding.status(context.store)).version; } }, opts.sync, true),
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
    const text = await rawGoalCommand(args, cwd, { ...opts, names: AHUB_NAMES, project, store: context.store, open: () => context.store,
      clean: (title, milestones, project) => !looksSecret(`${title}\n${milestones.join("\n")}`) && withoutPii([{ title, text: milestones.join("\n"), project }], currentRouting(cwd), cwd, policy()).length > 0,
    });
    return profileOutput(text, args.includes("--json"), context.binding.status(context.store), person);
  } finally { if (context.owned) context.store.close(); }
}


interface StaleAnchorCommandOptions {
  store?: MemoryStore;
  facts?: Pick<CodeFacts, "exists">;
  /** Trusted host test seam; never read from CLI arguments or project configuration. */
  createFacts?: () => Pick<CodeFacts, "exists" | "close">;
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
      const logDirectory = lstatSync(join(profile.dir, "log"));
      const localDirectory = lstatSync(join(profile.dir, "local"));
      if (!logDirectory.isDirectory() || logDirectory.isSymbolicLink() || !localDirectory.isDirectory() || localDirectory.isSymbolicLink()) return false;
    }
    binding.assertCurrent(); return true;
  } catch { return false; }
}

/** Host-only doctor report: selected amem reads may maintain derived indexes/leases, never notes or candidates. */
export async function memoryStaleAnchorsCommand(cwd: string, opts: StaleAnchorCommandOptions = {}): Promise<MemoryStaleAnchorReport> {
  let ownedFacts: Pick<CodeFacts, "exists" | "close"> | undefined;
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
    const facts = opts.facts ?? (ownedFacts = opts.createFacts?.() ?? new CodeFacts({ timeoutMs: MEMORY_SYMBOL_START_BUDGET_MS }));
    const binding = context.binding;
    return await memoryStaleAnchors({ cwd, project, store: context.store, head, now: opts.now, taskPrivacy, publicMetadataText,
      assertCurrent: () => binding.assertCurrent(),
      context: () => ({ cwd, project, repo: project, deny: config().local.deny, allowed: publicMetadataText }),
      exists: (repo, at, name) => facts.exists(repo, at, name),
      finishQueries: async () => { if (ownedFacts) { await ownedFacts.close(); ownedFacts = undefined; } } });
  } catch { return unavailableMemoryStaleAnchors(); }
  finally {
    try { if (ownedFacts) await ownedFacts.close(); } catch { /* Optional cleanup failure remains neutral, including a second failed close. */ }
    try { if (context?.owned) context.store.close(); } catch { /* Inspection must still return its neutral report. */ }
  }
}
