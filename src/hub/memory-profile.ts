import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CandidateStore, MemoryStore, realPath, memoryHome, resolveProfile,
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
const UNAVAILABLE = "memory profile unavailable; restart the hub";

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
    && a.generation === b.generation && a.selectorRevision === b.selectorRevision;
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

/** Inspect selection without constructing a store, index, or candidate sidecar. */
export function selectedMemoryProfile(opts: StoreOptions = {}): MemoryProfileReceipt {
  assertLoadedAgentMem();
  return receipt(resolveProfile(homeFor(opts)), "ready");
}

export class MemoryProfileBinding {
  readonly home: string;
  readonly profile: BoundProfile;
  readonly explicitProfile: ProfileInput;
  private readonly options: Pick<StoreOptions, "home">;
  private readonly directMemoryDir: string | undefined;
  private unavailable = false;

  constructor(opts: StoreOptions = {}, private readonly onUnavailable?: (neutralReason: string) => void, directMemoryDir?: string) {
    assertLoadedAgentMem();
    this.options = { home: opts.home };
    this.directMemoryDir = directMemoryDir;
    this.home = directMemoryDir === undefined ? homeFor(this.options) : canonicalHome(directMemoryDir);
    this.profile = Object.freeze({ ...resolveProfile(this.home) });
    this.explicitProfile = this.profile.kind === "shared-v1" ? "shared-v1" : Object.freeze({ generation: this.profile.generation! });
  }

  assertCurrent(): void {
    if (this.unavailable) throw new Error(UNAVAILABLE);
    try {
      const currentHome = this.directMemoryDir === undefined ? homeFor(this.options) : canonicalHome(this.directMemoryDir);
      const current = resolveProfile(currentHome);
      if (currentHome !== this.home || !sameProfile(current, this.profile)) throw new Error(UNAVAILABLE);
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

export function openProfileMemory(opts: StoreOptions = {}, onUnavailable?: (neutralReason: string) => void): {
  store: MemoryStore; binding: MemoryProfileBinding;
} {
  const binding = new MemoryProfileBinding(opts, onUnavailable);
  binding.assertCurrent();
  const raw = new MemoryStore({ ...opts, profile: binding.explicitProfile });
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
  const binding = new MemoryProfileBinding({}, onUnavailable, store.profile.home);
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
