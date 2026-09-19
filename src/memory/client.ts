import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 37701;

/** claude-mem worker URL: `memory.worker_url` override, else the port in ~/.claude-mem/settings.json. */
export function workerUrl(settingsPath = join(homedir(), ".claude-mem", "settings.json")): string {
  let port = DEFAULT_PORT;
  try {
    port = Number(JSON.parse(readFileSync(settingsPath, "utf8")).CLAUDE_MEM_WORKER_PORT) || DEFAULT_PORT;
  } catch {
    // no settings file: default port
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Client for the claude-mem worker HTTP API. The API is internal and unversioned, so every call is
 * fail-open: a down or changed worker yields `undefined`, never an exception, and never blocks a turn.
 * Typed endpoint wrappers are added by the milestone that first needs them.
 */
export class MemoryClient {
  constructor(
    readonly url = workerUrl(),
    private readonly timeoutMs = 2000,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | undefined> {
    try {
      const res = await fetch(`${this.url}${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      this.log(`memory ${method} ${path} dropped: ${(e as Error).message}`);
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; version?: string }> {
    const h = await this.request<{ status?: string; version?: string }>("GET", "/api/health");
    return h?.status === "ok" ? { ok: true, ...(h.version ? { version: h.version } : {}) } : { ok: false };
  }
}
