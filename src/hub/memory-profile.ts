import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CandidateStore, MemoryStore, realPath, memoryHome, memoryProjectKey, openShardStore, readShardedSelection, resolveAlias, resolveProfile, resolveShardProfile,
  type BoundProfile, type ProfileInput, type StoreOptions,
} from "@staix/agent-mem";
import packageJson from "../../package.json";

const EXPECTED_AGENT_MEM_VERSION = packageJson.dependencies["@staix/agent-mem"];

/** Validate metadata located through the actual imported entry, never the hub pin alone. */
export function assertAgentMemVersion(metadata: unknown, expectedVersion = EXPECTED_AGENT_MEM_VERSION): string {
  if (!metadata || typeof metadata !== "object") throw new Error("cannot attest loaded agent-mem version");
  const value = metadata as { name?: unknown; version?: unknown };
  if (value.name !== "@staix/agent-mem" || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+$/.test(value.version) || value.version !== expectedVersion) {
    throw new Error("loaded agent-mem version does not match the exact dependency pin");
  }
  return value.version;
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
    try { return { version: assertAgentMemVersion(metadata), valid: true }; }
    catch { return { version: actual, valid: false }; }
  } catch { return { version: "unknown", valid: false }; }
})();
export const AGENT_MEM_VERSION = loadedAgentMem.version;
function assertLoadedAgentMem(): void {
  if (!loadedAgentMem.valid) throw new Error("cannot attest loaded agent-mem version against the exact dependency pin");
}
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
    this.home = directMemoryDir === undefined ? homeFor(this.options) : canonicalHome(directMemoryDir);
    this.profile = Object.freeze({ ...currentProfile(this.home, this.project) });
    this.explicitProfile = this.profile.kind === "shared-v1" ? "shared-v1" : Object.freeze({ generation: this.profile.generation! });
  }

  assertCurrent(): void {
    if (this.unavailable) throw new Error(UNAVAILABLE);
    try {
      const currentHome = this.directMemoryDir === undefined ? homeFor(this.options) : canonicalHome(this.directMemoryDir);
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

  status(store?: MemoryStore): MemoryProfileReceipt {
    try { this.assertCurrent(); } catch { /* Report the latched state without exposing metadata errors. */ }
    let skippedRows = 0;
    if (!this.unavailable && store) {
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

/** Bind a caller-owned store only when it exactly matches the current person selection. */
export function bindProfileMemory(store: MemoryStore, onUnavailable?: (neutralReason: string) => void): {
  store: MemoryStore; binding: MemoryProfileBinding;
} {
  const binding = new MemoryProfileBinding({ project: store.profile.shardKey }, onUnavailable, store.profile.home);
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
