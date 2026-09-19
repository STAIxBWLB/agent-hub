import { readFileSync } from "node:fs";

export interface OmniRouteConfig {
  /** Candidate base URLs ending in /v1, in order of preference. `AGENTHUB_OMNIROUTE_URL` replaces the list. */
  urls: string[];
  /** Used when `OMNIROUTE_API_KEY` is not set. */
  api_key_file?: string;
  /** Hosts behind Cloudflare Access: only these get the two Access headers. */
  access_hosts: string[];
  cf_client_id_file?: string;
  cf_client_secret_file?: string;
}
export const DEFAULT_OMNIROUTE: OmniRouteConfig = {
  urls: ["http://gateway.internal:20128/v1", "https://gateway.example.edu/v1"],
  access_hosts: ["gateway.example.edu"],
};

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ChatResult {
  message: ChatMessage;
  /** `x-omniroute-provider` (direct path) */
  provider?: string;
  /** `x-model-router-selected-model` (through Switchyard) */
  selectedModel?: string;
}
export interface ChatOptions {
  signal?: AbortSignal;
  /** Switchyard base (`http://127.0.0.1:<port>/v1`). The sidecar holds the key, so none is sent. */
  via?: string;
  sessionId?: string;
}

const readSecret = (file?: string) => {
  try {
    return file ? readFileSync(file, "utf8").trim() : "";
  } catch {
    return "";
  }
};

/** L3 client. Secrets are read here and go nowhere but request headers: never into logs, errors or return values. */
export class OmniRoute {
  private live: string | undefined;

  constructor(
    private readonly cfg: OmniRouteConfig = DEFAULT_OMNIROUTE,
    private readonly log: (line: string) => void = () => {},
  ) {}

  apiKey(): string {
    return process.env.OMNIROUTE_API_KEY?.trim() || readSecret(this.cfg.api_key_file);
  }

  /** True when the live gateway is reached through Cloudflare Access, i.e. the traffic leaves the campus network. */
  async offCampus(): Promise<boolean> {
    const base = await this.base();
    return !!base && this.cfg.access_hosts.includes(new URL(base).hostname);
  }

  /** Cloudflare Access headers, only for hosts that sit behind Access. */
  accessHeaders(url: string): Record<string, string> {
    if (!this.cfg.access_hosts.includes(new URL(url).hostname)) return {};
    const id = readSecret(this.cfg.cf_client_id_file);
    const secret = readSecret(this.cfg.cf_client_secret_file);
    return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
  }

  /**
   * The most preferred candidate that answers `GET <base>/models` with 2xx within 4 s (401 counts only when no key is
   * configured). Health paths differ per gateway (OmniRoute 3.8.50 has /healthz and /api/health, no /health); the
   * models route is what every OpenAI-compatible server has. Candidates are probed at the same time and picked in
   * list order: probing one after the other let a stalled first request over an idle WARP tunnel hand the choice to
   * the off-campus URL (seen live), and a 403 from Cloudflare Access must not pass for healthy.
   * Cached until a call fails at the network level.
   */
  async base(): Promise<string | undefined> {
    if (this.live) return this.live;
    const candidates = (process.env.AGENTHUB_OMNIROUTE_URL ? [process.env.AGENTHUB_OMNIROUTE_URL] : this.cfg.urls).map((u) => u.replace(/\/$/, ""));
    const key = this.apiKey();
    const results = await Promise.all(
      candidates.map((url) =>
        fetch(`${url}/models`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...this.accessHeaders(url) }, signal: AbortSignal.timeout(4000) }).then(
          (r) => r.ok || (!key && r.status === 401),
          () => false,
        ),
      ),
    );
    const url = candidates[results.indexOf(true)];
    if (url) {
      this.log(`omniroute: using ${new URL(url).host}`);
      return (this.live = url);
    }
    this.log(`omniroute: no candidate is healthy (${candidates.map((u) => new URL(u).host).join(", ")})`);
    return undefined;
  }

  async chat(body: { model: string; messages: ChatMessage[]; tools?: unknown[] }, opts: ChatOptions = {}): Promise<ChatResult> {
    const base = opts.via ?? (await this.base());
    if (!base) throw new Error("no OmniRoute endpoint is reachable (WARP off? see hub doctor)");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.via) {
      if (opts.sessionId) headers["x-switchyard-session-id"] = opts.sessionId;
    } else {
      const key = this.apiKey();
      if (!key) throw new Error("no OmniRoute API key (set OMNIROUTE_API_KEY or omniroute.api_key_file)");
      Object.assign(headers, { authorization: `Bearer ${key}` }, this.accessHeaders(base));
    }
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: false }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      if (!opts.via) this.live = undefined; // probe again next time: WARP may have dropped
      throw e;
    }
    if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error("model call returned no message");
    const provider = res.headers.get("x-omniroute-provider") ?? undefined;
    const selectedModel = res.headers.get("x-model-router-selected-model") ?? undefined;
    // reasoning_content and other extras are dropped here: only role, content and tool_calls travel on.
    return {
      message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
      ...(provider ? { provider } : {}),
      ...(selectedModel ? { selectedModel } : {}),
    };
  }
}
