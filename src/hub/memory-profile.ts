import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CandidateStore, MemoryStore, aliasLogPath, realPath, memoryHome, memoryProjectKey, openShardStore, readShardedSelection, resolveAlias, resolveProfile,
  resolveShardProfile, shardKeyHash,
  type BoundProfile, type ProfileInput, type StoreOptions,
} from "@staix/agent-mem";
import * as agentMemExports from "@staix/agent-mem";
import { AGENT_MEM_HOST_API_RANGE, AGENT_MEM_RANGE, agentMemHostApiOk, agentMemVersionInRange } from "./agent-mem-range.ts";

/**
 * Whether a curated store directory holds a derived index. agent-mem names the file per index version (`index.db` through 0.24.0, `index-v4.db` from 0.25.0, a later release its own), and
 * `indexFileName` is not a root export, so any `index.db` or `index-v<N>.db` counts. Read-only; an unreadable directory has none. Never create or probe by opening the file.
 */
export function memoryIndexExists(memoryDir: string): boolean {
  try { return readdirSync(memoryDir).some(name => /^index(-v\d+)?\.db$/.test(name)); } catch { return false; }
}

/** Validate metadata located through the actual imported entry, never the declared range alone. */
export function assertAgentMemVersion(metadata: unknown, range: string = AGENT_MEM_RANGE, hostApi?: { min?: unknown; version?: unknown }): string {
  const value = (metadata ?? {}) as { name?: unknown; version?: unknown };
  if (value.name !== "@staix/agent-mem" || !agentMemVersionInRange(value.version, range)) {
    const loaded = typeof value.version === "string" ? value.version : "unknown";
    throw new Error(`the loaded agent-mem ${loaded} is not a plain release inside the declared range ${range}; install a release in that range with \`bun install --frozen-lockfile\`, or raise the range in package.json with a compatibility review`);
  }
  if (hostApi && !agentMemHostApiOk(hostApi.min, hostApi.version)) {
    throw new Error(`the loaded agent-mem ${value.version as string} declares host API ${String(hostApi.min)}..${String(hostApi.version)}, which does not intersect the supported ${AGENT_MEM_HOST_API_RANGE[0]}..${AGENT_MEM_HOST_API_RANGE[1]} (or HOST_API_MIN and HOST_API_VERSION are missing or invalid); install a release that exports a compatible host API with \`bun install --frozen-lockfile\`, or review the hub for the new host API`);
  }
  return value.version as string;
}

const loadedAgentMem = (() => {
  try {
    if (!new URL(import.meta.url).pathname.endsWith("/src/hub/memory-profile.ts")) throw new Error("unattested bundled memory implementation");
    const entry = import.meta.resolve("@staix/agent-mem");
    if (!new URL(entry).pathname.endsWith("/src/index.ts")) throw new Error("unknown agent-mem entry layout");
    // The package exports src/index.ts. Bundles without this resolvable layout
    // cannot attest the imported implementation and must refuse to open memory.
    const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
    const actual = metadata && typeof metadata === "object" && typeof (metadata as { version?: unknown }).version === "string"
      ? (metadata as { version: string }).version : "unknown";
    // Read through the namespace, never a named import: a package without the constants must refuse with a cause, not fail at module link.
    const exported = agentMemExports as unknown as { HOST_API_MIN?: unknown; HOST_API_VERSION?: unknown };
    try { return { version: assertAgentMemVersion(metadata, AGENT_MEM_RANGE, { min: exported.HOST_API_MIN, version: exported.HOST_API_VERSION }), valid: true, reason: undefined }; }
    catch (error) { return { version: actual, valid: false, reason: (error as Error).message }; }
  } catch (error) { return { version: "unknown", valid: false, reason: `the loaded agent-mem could not be attested: ${(error as Error).message}` }; }
})();
export const AGENT_MEM_VERSION = loadedAgentMem.version;
function assertLoadedAgentMem(): void {
  if (!loadedAgentMem.valid) throw new Error(loadedAgentMem.reason ?? `the loaded agent-mem ${AGENT_MEM_VERSION} is not usable`);
}
/** #1611: why the loaded agent-mem is refused (version or host API, loaded and supported ranges, next step); undefined when it is usable. */
export const AGENT_MEM_REFUSAL: string | undefined = loadedAgentMem.valid ? undefined : loadedAgentMem.reason;
export const MEMORY_PROFILE_UNAVAILABLE = "memory profile unavailable; inspect the selector and generation state, run ahub memory profile-check; use amem migrate --deactivate only to stop using the selected generation";
const UNAVAILABLE = MEMORY_PROFILE_UNAVAILABLE;
/** agent-mem#15 T2: a split marker that is not active (captured, malformed) is never read as an empty or legacy store. */
export const MEMORY_SPLIT_INCOMPLETE = "memory home has a curated split that is not active; finish it with amem migrate --shards --resume, then restart the hub";
/** Hub memory options: the project key selects this project's shard once the home is split. */
/**
 * Hub memory options. `project` is the bound (alias-resolved) key; `projectKey`, when given, is the raw key it came
 * from, and the entry fence latches the binding unavailable once the alias log maps it elsewhere.
 */
export type ProfileMemoryOptions = Omit<StoreOptions, "memoryDir"> & { project?: string; projectKey?: string };

/** No handle was opened; distinct from an unavailable, still-bound handle. */
export interface UnboundMemoryProfileReceipt {
  state: "disabled" | "unavailable";
  home: string;
  agentMemVersion: string;
  error?: string;
  profile?: never;
  generation?: never;
  selectorRevision?: never;
  skippedRows?: never;
}

export interface MemoryProfileReceipt {
  profile: BoundProfile["kind"];
  generation?: string;
  state: "ready" | "unavailable";
  selectorRevision: string;
  home: string;
  agentMemVersion: string;
  error?: string;
  skippedRows: number;
}

function canonicalHome(path: string): string {
  if (existsSync(path)) return realPath(path);
  const parent = dirname(path);
  return parent === path ? resolve(path) : join(canonicalHome(parent), basename(path));
}
function sameProfile(a: BoundProfile, b: BoundProfile): boolean {
  return a.home === b.home && a.dir === b.dir && a.kind === b.kind
    && a.generation === b.generation && a.selectorRevision === b.selectorRevision
    && !!a.sharded === !!b.sharded && a.shardKey === b.shardKey && !!a.shardUser === !!b.shardUser;
}
// lstat, not exists: a dangling or unreadable marker is still a marker and must fail closed.
const splitMarked = (home: string) => lstatSync(join(home, "shards.json"), { throwIfNoEntry: false }) !== undefined;
/** Refuse an inactive split before any shard read, so the remedy names resume rather than the generic profile check. */
function assertActiveSplit(home: string): void {
  try { readShardedSelection(home); } catch { throw new Error(MEMORY_SPLIT_INCOMPLETE); }
}
/**
 * The one profile a binding may hold: this project's shard on a split home, the selected profile otherwise.
 * ponytail: the entry fence re-checks the project shard only; the user overlay shares its selection and selector
 * revision, so its own seal or machine drift goes unchecked. Add resolveShardProfile(home, { user: true }) if needed.
 */
function currentProfile(home: string, project: string | undefined): BoundProfile {
  if (!splitMarked(home)) return resolveProfile(home);
  assertActiveSplit(home);
  if (!project) throw new Error(UNAVAILABLE);
  return resolveShardProfile(home, { project });
}
function homeFor(opts: Pick<StoreOptions, "home">): string {
  return canonicalHome(opts.home === undefined ? memoryHome() : join(canonicalHome(opts.home), "memory"));
}
function receipt(profile: BoundProfile, state: MemoryProfileReceipt["state"], skippedRows = 0): MemoryProfileReceipt {
  return {
    profile: profile.kind, ...(profile.generation === undefined ? {} : { generation: profile.generation }),
    state, home: profile.home, selectorRevision: profile.selectorRevision, agentMemVersion: AGENT_MEM_VERSION, skippedRows,
    ...(state === "unavailable" ? { error: UNAVAILABLE } : {}),
  };
}

/** One stat tuple: the identity a metadata object carries between two reads. `follow` resolves a configured home's symlinks. */
function statStamp(path: string, follow = false): string {
  const stat = follow
    ? statSync(path, { bigint: true, throwIfNoEntry: false })
    : lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) return "absent";
  const kind = stat.isDirectory() ? "d" : stat.isFile() ? "f" : stat.isSymbolicLink() ? "l" : "o";
  return `${kind}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * Every metadata object `assertCurrent()` resolves, in a fixed order: the selector pair and machine identity, the alias log,
 * the public-prune and placement markers, this project's shard descriptor and generation files. A stamped directory covers a
 * child created, removed or renamed inside it; an append to an existing placement journal changes no identity the version
 * reads, and the next full fence sees it.
 * ponytail: a stat tuple per call is the whole change signal. A filesystem with a coarser mtime tick could hide an in-place
 * rewrite of the same size within one tick; agent-mem's own placement-binding memo accepts the same ceiling (agent-mem 0.30.0,
 * `readActivePlacementBinding`). Upgrade to a kernel-sequenced revision if a target filesystem loses nanosecond stamps.
 */
function fenceObjects(home: string, profile: BoundProfile, project: string | undefined, projectKey: string | undefined): string[] {
  const paths = [
    home,
    join(home, "profile.json"), join(home, "shards.json"), join(home, "machine.json"),
    join(home, "public-prune-view.intent.json"), join(home, "profile.lock"),
    join(home, "sync-placement"), join(home, "sync-placement", "active.json"), join(home, "sync-placement-activation.json"),
  ];
  if (projectKey !== undefined) paths.push(aliasLogPath(home));
  if (profile.pruneInputSetHash !== undefined) {
    paths.push(join(home, "public-prune-input-sets"), join(home, "public-prune-input-sets", `${profile.pruneInputSetHash}.json`));
  }
  if (profile.placementHead !== undefined) {
    const epochs = join(home, "sync-placement", "epochs"), epoch = join(epochs, profile.placementHead);
    paths.push(epochs, epoch, join(epoch, "epoch.json"), join(epoch, "activation.json"));
  }
  if (profile.sharded === true && project !== undefined) {
    const projects = join(home, "projects"), descriptor = join(projects, shardKeyHash(project));
    paths.push(projects, descriptor, join(descriptor, "project.json"));
  }
  if (profile.kind === "generation" && profile.sharded !== true) paths.push(join(home, "generations"));
  paths.push(profile.dir);
  for (const name of ["generation.json", "generation-seal.json", "migration-sources.json", "machine.json", "project.json", "prune-translations.jsonl"]) {
    paths.push(join(profile.dir, name));
  }
  for (const name of ["legacy", "legacy-main"]) paths.push(join(profile.dir, name));
  return paths;
}

/**
 * The memory sync policy version. `changeKey` is cheap (fence stat tuples plus the policy inputs) and is taken on every call;
 * `read` resolves the profile and is reached only when that key moved. A key that moved without the policy inputs changing
 * recomputes the same version, so a rewrite that keeps the identity does not abort an in-flight pass.
 */
export function createMemoryPolicyVersion(
  changeKey: () => string,
  read: () => { profile: MemoryProfileReceipt | "unbound"; inputs: readonly unknown[] },
): () => string {
  let last: { key: string; version: string } | undefined;
  return () => {
    const key = changeKey();
    if (last?.key === key) return last.version;
    const { profile, inputs } = read();
    const identity = profile === "unbound" ? "unbound" : [profile.state, profile.profile, profile.generation, profile.selectorRevision];
    const version = createHash("sha256").update(JSON.stringify([identity, ...inputs])).digest("hex");
    last = { key, version };
    return version;
  };
}

/**
 * The project key agent-mem's own CLI binds: memoryProjectKey(cwd) through the person-reviewed alias log of the
 * canonical memory home. The daemon and `ahub memory`/`ahub goal` use it so both open the same shard and rows.
 */
export function memoryProjectFor(cwd: string, opts: Pick<StoreOptions, "home"> = {}): string {
  return resolveAlias(homeFor(opts), memoryProjectKey(cwd));
}

/**
 * #240: the project key for a caller-injected store. Its alias log is the one in its own bound home (`profile.home`),
 * never the ambient memory home's: a different alias log could hide that store's rows or refuse its writes.
 */
export function memoryProjectForStore(store: MemoryStore, cwd: string): string {
  return resolveAlias(canonicalHome(store.profile.home), memoryProjectKey(cwd));
}

/** Inspect selection without constructing a store, index, or candidate sidecar. */
export function selectedMemoryProfile(opts: StoreOptions = {}): MemoryProfileReceipt {
  assertLoadedAgentMem();
  const home = homeFor(opts);
  if (!splitMarked(home)) return receipt(resolveProfile(home), "ready");
  // #536: a split home selects through shards.json, not the legacy selector. The user shard is sealed by every split,
  // so it names the active generation and selector revision without opening a store; an inactive split throws the resume remedy.
  assertActiveSplit(home);
  return receipt(resolveShardProfile(home, { user: true }), "ready");
}

/**
 * #536: the shard profile a hub bound to `projectRoot` reports on an active split home, without opening a store.
 * Returns undefined on an unsplit home; throws MEMORY_SPLIT_INCOMPLETE on an inactive split, and whatever the
 * shard resolution throws when this project's seal is missing or corrupt.
 */
export function shardProfileForProject(canonicalMemoryHome: string, projectRoot: string): MemoryProfileReceipt | undefined {
  assertLoadedAgentMem();
  if (!splitMarked(canonicalMemoryHome)) return undefined;
  assertActiveSplit(canonicalMemoryHome);
  return receipt(resolveShardProfile(canonicalMemoryHome, { project: resolveAlias(canonicalMemoryHome, memoryProjectKey(projectRoot)) }), "ready");
}

export class MemoryProfileBinding {
  readonly home: string;
  readonly profile: BoundProfile;
  readonly explicitProfile: ProfileInput;
  private readonly options: Pick<StoreOptions, "home">;
  private readonly directMemoryDir: string | undefined;
  /** The shard key on a split home; unused on an unsplit one. */
  private readonly project: string | undefined;
  /** The raw key `project` was resolved from; an alias added later must not leave writes on the old key. */
  private readonly projectKey: string | undefined;
  private unavailable = false;

  constructor(opts: ProfileMemoryOptions = {}, private readonly onUnavailable?: (neutralReason: string) => void, directMemoryDir?: string) {
    assertLoadedAgentMem();
    this.options = { home: opts.home };
    this.directMemoryDir = directMemoryDir;
    this.project = opts.project;
    this.projectKey = opts.projectKey;
    this.home = this.resolvedHome();
    this.profile = Object.freeze({ ...currentProfile(this.home, this.project) });
    this.explicitProfile = this.profile.kind === "shared-v1" ? "shared-v1" : Object.freeze({ generation: this.profile.generation! });
  }

  /**
   * The memory dir `assertCurrent()` compares against, by the same resolution: the whole string is the change signal for the
   * home itself, so every input agent-mem's resolution reads shows when it moves - `AMEM_HOME` (canonicalized to its target,
   * which a stamp of the old target cannot see), the machine config's `home` key inside the default home, and the
   * `AGENTHUB_HOME` default with its `memory` child. Cost: one resolution, no profile, shard or alias parse.
   */
  private resolvedHome(): string {
    return this.directMemoryDir === undefined ? homeFor(this.options) : canonicalHome(this.directMemoryDir);
  }

  /**
   * The home's own change signal. An explicit home is a fixed string, so its followed tuple already sees every retarget
   * below it (a link swap changes the containing directory's tuple) and costs one stat. The environment home is not fixed:
   * agent-mem canonicalizes `AMEM_HOME` to its target and reads the default home's config pointer, so there the resolution
   * itself is the signal.
   */
  private homeSignal(): string {
    if (this.directMemoryDir !== undefined) return statStamp(this.directMemoryDir, true);
    if (this.options.home !== undefined) return statStamp(this.options.home, true);
    return this.resolvedHome();
  }

  assertCurrent(): void {
    if (this.unavailable) throw new Error(UNAVAILABLE);
    try {
      const currentHome = this.resolvedHome();
      const current = currentProfile(currentHome, this.project);
      if (currentHome !== this.home || !sameProfile(current, this.profile)) throw new Error(UNAVAILABLE);
      if (this.projectKey !== undefined && resolveAlias(currentHome, this.projectKey) !== this.project) throw new Error(UNAVAILABLE);
    } catch {
      this.invalidate();
      throw new Error(UNAVAILABLE);
    }
  }

  /** Entry fence only; migration requires quiescing and closing all consumers first. */
  run<T>(work: () => T): T {
    this.assertCurrent();
    return work();
  }

  private invalidate(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    try { this.onUnavailable?.(UNAVAILABLE); } catch { /* Observer failures cannot undo the latch. */ }
  }

  /**
   * The cheap change signal for `assertCurrent()`: `homeSignal()` plus the stat tuple of every metadata object it resolves,
   * or `unavailable` once the fence latched. It never parses a profile, shard or alias file, so a caller may poll it per
   * fence check.
   * A stat can still throw where `assertCurrent()` would have latched (ENOTDIR once a metadata directory became a file,
   * EACCES on a directory that lost read permission), and callers poll this unguarded on a peer's turn: every stat error
   * latches the binding unavailable and returns `unavailable`, the same fail-closed result the fence gives.
   */
  fenceStamp(): string {
    if (this.unavailable) return "unavailable";
    try {
      const anchor = this.homeSignal();
      return [anchor, ...fenceObjects(this.home, this.profile, this.project, this.projectKey).map(path => statStamp(path))].join("|");
    } catch {
      this.invalidate();
      return "unavailable";
    }
  }

  status(store?: MemoryStore, opts: { skippedRows?: boolean } = {}): MemoryProfileReceipt {
    try { this.assertCurrent(); } catch { /* Report the latched state without exposing metadata errors. */ }
    let skippedRows = 0;
    if (opts.skippedRows !== false && !this.unavailable && store) {
      try { skippedRows = store.bridgeStatus()?.skippedRows ?? 0; } catch { this.invalidate(); }
    }
    return receipt(this.profile, this.unavailable ? "unavailable" : "ready", skippedRows);
  }

  candidateOptions(opts: { home?: string; now?: () => number } = {}): { home?: string; now?: () => number } {
    this.assertCurrent();
    const inheritedHome = this.directMemoryDir === undefined ? this.options.home
      : homeFor({}) === this.home ? undefined : dirname(this.home);
    const options = { ...opts, home: opts.home ?? inheritedHome };
    if (homeFor(options) !== this.home) throw new Error(UNAVAILABLE);
    return options;
  }
}

export function openProfileMemory(opts: ProfileMemoryOptions = {}, onUnavailable?: (neutralReason: string) => void): {
  store: MemoryStore; binding: MemoryProfileBinding;
} {
  const { project, ...storeOptions } = opts;
  const home = homeFor(opts);
  let raw: MemoryStore, binding: MemoryProfileBinding;
  if (splitMarked(home)) {
    // agent-mem#15 T2: a plain MemoryStore refuses a split home. The shard store opens this project's shard (created on
    // first use) with the user shard as its overlay; the binding is resolved after it, since a new shard has no seal yet.
    assertActiveSplit(home);
    if (!project) throw new Error(UNAVAILABLE);
    // The canonical memory directory the binding resolves: a lexical home (a symlinked AGENTHUB_HOME or memory dir)
    // would give the shard a different profile.home and dir than the binding compares against.
    raw = openShardStore({ ...storeOptions, home: undefined, memoryDir: home, project });
    try { binding = new MemoryProfileBinding(opts, onUnavailable); }
    catch (error) { raw.close(); throw error; }
  } else {
    binding = new MemoryProfileBinding(opts, onUnavailable);
    binding.assertCurrent();
    raw = new MemoryStore({ ...storeOptions, profile: binding.explicitProfile });
  }
  try {
    binding.assertCurrent();
    if (!sameProfile(raw.profile, binding.profile)) throw new Error(UNAVAILABLE);
    // ponytail: entry checks exclude an in-flight cutover; quiesce and close
    // consumers before migration. Upgrade to a public core pre-write hook if
    // atomic cutover across an in-flight operation becomes required.
    return { store: raw, binding };
  } catch (error) {
    raw.close();
    throw error;
  }
}

/**
 * Bind a caller-owned store only when it exactly matches the current person selection. `projectKey` is the raw key
 * the caller resolves its project from (#240): a sharded store whose home now aliases that key to another project is
 * refused, and a later remap latches the binding unavailable, so a command never runs as B through A's shard.
 */
export function bindProfileMemory(store: MemoryStore, onUnavailable?: (neutralReason: string) => void, projectKey?: string): {
  store: MemoryStore; binding: MemoryProfileBinding;
} {
  const sharded = store.profile.shardKey !== undefined;
  const binding = new MemoryProfileBinding({ project: store.profile.shardKey, ...(sharded && projectKey !== undefined ? { projectKey } : {}) }, onUnavailable, store.profile.home);
  binding.assertCurrent();
  if (!sameProfile(store.profile, binding.profile)) throw new Error(UNAVAILABLE);
  return { store, binding };
}

export function openProfileCandidates(binding: MemoryProfileBinding, opts: { home?: string; now?: () => number } = {}): CandidateStore {
  const options = binding.candidateOptions(opts);
  const raw = new CandidateStore(options);
  try {
    binding.assertCurrent();
    if (canonicalHome(raw.dir) !== binding.home) throw new Error(UNAVAILABLE);
    return raw;
  } catch (error) {
    raw.close();
    throw error;
  }
}
