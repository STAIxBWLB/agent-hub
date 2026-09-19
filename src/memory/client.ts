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
    return this.call(method, path, body, (res) => res.json() as Promise<T>);
  }

  /** Recent-context block (text/plain markdown). `chain`: project names, the primary one last. No `platformSource` = all platforms. */
  contextInject(chain: string[], platformSource?: string): Promise<string | undefined> {
    const query = `projects=${encodeURIComponent(chain.join(","))}${platformSource ? `&platformSource=${encodeURIComponent(platformSource)}` : ""}`;
    return this.call("GET", `/api/context/inject?${query}`, undefined, (res) => res.text());
  }

  /** Index search. The worker answers in MCP shape, `{content: [{type: "text", text: <markdown table>}]}`; this returns the text. */
  async search(query: string, project: string, limit = 10): Promise<string | undefined> {
    const q = `query=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}&limit=${limit}`;
    return mcpText(await this.request("GET", `/api/search?${q}`));
  }

  async timeline(anchor: number, project: string, before = 3, after = 3): Promise<string | undefined> {
    return mcpText(await this.request("GET", `/api/timeline?anchor=${anchor}&project=${encodeURIComponent(project)}&depth_before=${before}&depth_after=${after}`));
  }

  /** An explicit shared note. `metadata` carries who said it and about which task. */
  save(note: { text: string; title?: string; project: string; metadata: Record<string, unknown> }): Promise<unknown> {
    return this.request("POST", "/api/memory/save", note);
  }

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, read: (res: Response) => Promise<T>): Promise<T | undefined> {
    try {
      const res = await fetch(`${this.url}${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await read(res);
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

function mcpText(res: unknown): string | undefined {
  const content = (res as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return content?.find((c) => c.type === "text")?.text;
}
