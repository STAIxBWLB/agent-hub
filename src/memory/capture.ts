import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDenied } from "../local/deny.ts";
import type { MemoryClient } from "./client.ts";

const OUTPUT_CAP = 4000;

/** claude-mem's own skip list, so the hub captures what the native hooks would. */
export function skipTools(settingsPath = join(homedir(), ".claude-mem", "settings.json")): string[] {
  try {
    return String(JSON.parse(readFileSync(settingsPath, "utf8")).CLAUDE_MEM_SKIP_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface CaptureOptions {
  project: string;
  cwd: string;
  platformSource?: string;
  agentId?: string;
  skip?: string[];
  deny?: string[];
}

/**
 * The hub acting as claude-mem's hook client for the local worker (payload shapes read from the 13.25.1 hook code).
 * Fire-and-forget on top of the fail-open client: a down worker costs one log line per call and never a turn.
 */
export class Capture {
  private sessionId = "";
  private readonly platformSource: string;
  private readonly agentId: string;

  constructor(
    private readonly client: MemoryClient,
    private readonly opts: CaptureOptions,
  ) {
    this.platformSource = opts.platformSource ?? "agent-hub";
    this.agentId = opts.agentId ?? "local";
  }

  init(sessionId: string, prompt: string): void {
    this.sessionId = sessionId;
    void this.client.request("POST", "/api/sessions/init", { contentSessionId: sessionId, project: this.opts.project, prompt, platformSource: this.platformSource });
  }

  observe(call: { tool: string; args: string; output: string; id: string; paths: string[] }): void {
    if (!this.sessionId || this.opts.skip?.includes(call.tool)) return;
    // Anything that names a denylisted path is kept out of memory entirely, input and output alike.
    if (call.paths.some((p) => p.split(/\s+/).some((word) => isDenied(word, this.opts.deny)))) return;
    void this.client.request("POST", "/api/sessions/observations", {
      contentSessionId: this.sessionId,
      platformSource: this.platformSource,
      tool_name: call.tool,
      tool_input: call.args,
      tool_response: call.output.slice(0, OUTPUT_CAP),
      cwd: this.opts.cwd,
      agentId: this.agentId,
      agentType: "local-worker",
      tool_use_id: call.id,
    });
  }

  summarize(lastAssistantMessage: string): void {
    if (!this.sessionId) return;
    // No agentId here: the worker answers a summarize that carries one with {status: "skipped", reason: "subagent_context"} (verified live).
    void this.client.request("POST", "/api/sessions/summarize", {
      contentSessionId: this.sessionId,
      last_assistant_message: lastAssistantMessage,
      platformSource: this.platformSource,
    });
  }

  /** Awaited by the caller: the hub process exits right after stop(), and an unawaited request would die with it. Bounded by the client timeout. */
  async end(): Promise<void> {
    if (!this.sessionId) return;
    const contentSessionId = this.sessionId;
    this.sessionId = "";
    await this.client.request("POST", "/api/sessions/session-end", { contentSessionId, platformSource: this.platformSource, reason: "hub stop", cwd: this.opts.cwd });
  }
}
