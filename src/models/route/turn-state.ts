/** Local route state. It carries no cross-scope authority or transcript. */
const SCOPE_ENTRIES = 512;
const SCOPE_TTL_MS = 60 * 60_000;
const SCOPE_KEY_BYTES = 4096;

export interface ScopeStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<T> { value: T; lastAccessAt: number }

/** Bounded LRU order; expiry is an idle TTL renewed by each successful get or set. */
export class ScopeStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private lastTime: number | undefined;

  constructor(options: ScopeStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? SCOPE_ENTRIES;
    this.ttlMs = options.ttlMs ?? SCOPE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > SCOPE_ENTRIES
      || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > SCOPE_TTL_MS) {
      throw new RangeError("invalid route scope bounds");
    }
  }

  get(scope: string): T | undefined {
    this.key(scope);
    const time = this.time();
    const entry = this.entries.get(scope);
    if (!entry) return undefined;
    if (time < entry.lastAccessAt || time - entry.lastAccessAt >= this.ttlMs) {
      this.entries.delete(scope);
      return undefined;
    }
    entry.lastAccessAt = time;
    this.entries.delete(scope);
    this.entries.set(scope, entry);
    return entry.value;
  }

  set(scope: string, value: T): void {
    this.key(scope);
    if (value === undefined) throw new TypeError("route scope values must be defined");
    const time = this.time();
    for (const [key, entry] of this.entries) {
      if (time < entry.lastAccessAt || time - entry.lastAccessAt >= this.ttlMs) this.entries.delete(key);
    }
    this.entries.delete(scope);
    this.entries.set(scope, { value, lastAccessAt: time });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(scope: string): void { this.key(scope); this.entries.delete(scope); }

  private key(scope: string): void {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > SCOPE_KEY_BYTES
      || Buffer.byteLength(scope, "utf8") > SCOPE_KEY_BYTES) throw new RangeError("invalid route scope key");
  }

  private time(): number {
    const time = this.now();
    if (!Number.isFinite(time) || time < 0) throw new RangeError("route clock unavailable");
    if (this.lastTime !== undefined && time < this.lastTime) this.entries.clear();
    this.lastTime = time;
    return time;
  }
}
