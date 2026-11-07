// #1257: the one small GitHub REST client for the CI tooling scripts (flake ledger, shard timing refresh). Reads and one issue upsert; the token never appears in an error.
const API = "https://api.github.com";

export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const out = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    const token = out.stdout.toString().trim();
    return out.exitCode === 0 && token ? token : undefined;
  } catch { return undefined; }
}

export class GitHubApi {
  constructor(readonly repo: string, private readonly token: string | undefined, private readonly fetchFn: typeof fetch = fetch) {}

  private headers(): Record<string, string> {
    return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agent-hub-ci-tooling", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? "GET";
    const response = await this.fetchFn(`${API}${path}`, { method, headers: { ...this.headers(), ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    if (!response.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]} answered ${response.status}; check the token's permissions and the repository name`);
    return await response.json() as T;
  }

  /** A job log, read only up to `maxBytes` (the stream is cancelled after that). An expired or missing log reads as empty. */
  async log(jobId: number, maxBytes: number): Promise<string> {
    // The logs endpoint answers with a redirect to a signed blob URL that needs no credential: follow it by hand so the token is sent to api.github.com only.
    let response = await this.fetchFn(`${API}/repos/${this.repo}/actions/jobs/${jobId}/logs`, { headers: this.headers(), redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || !/^https:\/\//.test(location)) throw new Error(`GitHub job log ${jobId} answered a redirect with no https location`);
      response = await this.fetchFn(location, { redirect: "follow" });
    }
    if (response.status === 404 || response.status === 410) return "";
    if (!response.ok || !response.body) throw new Error(`GitHub job log ${jobId} answered ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) break;
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return text;
  }
}
