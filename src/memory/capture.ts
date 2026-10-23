import { defaultCapturePeer } from "../adapters/definitions/native-identity-defaults.ts";
import { BOUNDED_TASK_TOOLS } from "../hub/hub-tools.ts";
import { MEMORY_READ_TOOLS } from "../hub/read-tools.ts";
import { isDenied } from "../local/deny.ts";
import type { MemoryClient } from "./client.ts";

const OUTPUT_CAP = 4000;

export interface CaptureOptions {
  project: string;
  cwd: string;
  platformSource?: string;
  agentId?: string;
  skip?: string[];
  deny?: string[];
}

/** Deterministic local capture. No observer/model runs; private-turn gating stays in the host. */
export class Capture {
  private sessionId = "";
  private readonly toolTimes = new Map<string, string>();
  private sequence = 0;
  private readonly platformSource: string;
  private readonly agentId: string;

  constructor(
    private readonly client: MemoryClient,
    private readonly opts: CaptureOptions,
  ) {
    this.platformSource = opts.platformSource ?? "agent-hub";
    this.agentId = opts.agentId ?? defaultCapturePeer();
  }

  init(sessionId: string, prompt: string): void {
    this.sessionId = sessionId;
    this.toolTimes.clear();
    this.sequence = 0;
    void this.client.appendCapture({ project: this.opts.project, cwd: this.opts.cwd, at: new Date().toISOString(), sessionId, agent: this.agentId, event: "SessionStart", excerpt: prompt, platformSource: this.platformSource });
  }

  observe(call: { tool: string; args: string; output: string; id: string; paths: string[] }): void {
    if (!this.sessionId || ((MEMORY_READ_TOOLS.has(call.tool.replace(/^mcp__[^ ]+__/, "")) || BOUNDED_TASK_TOOLS.has(call.tool.replace(/^mcp__[^ ]+__/, ""))) || call.tool.replace(/^mcp__[^ ]+__/, "") === "hub_memory_correct") || this.opts.skip?.includes(call.tool)) return;
    // Anything that names a denylisted path is kept out of memory entirely, input and output alike.
    if (call.paths.some((p) => p.split(/\s+/).some((word) => isDenied(word, this.opts.deny)))) return;
    let at = this.toolTimes.get(call.id);
    if (!at) {
      at = new Date().toISOString(); this.toolTimes.set(call.id, at);
      // ponytail: duplicate-call timestamps retain the newest 1024 ids; upgrade to a host-supplied source-event timestamp.
      if (this.toolTimes.size > 1024) this.toolTimes.delete(this.toolTimes.keys().next().value!);
    }
    void this.client.appendCapture({ project: this.opts.project, cwd: this.opts.cwd, at, sessionId: this.sessionId, agent: this.agentId, event: "PostToolUse", tool: call.tool, paths: call.paths, excerpt: `${call.args}\n${call.output}`, input: call.args, output: call.output.slice(0, OUTPUT_CAP), toolUseId: call.id, platformSource: this.platformSource });
  }

  summarize(lastAssistantMessage: string): void {
    if (!this.sessionId) return;
    void this.client.appendCapture({ project: this.opts.project, cwd: this.opts.cwd, at: new Date().toISOString(), sessionId: this.sessionId, toolUseId: `summary:${++this.sequence}`, agent: this.agentId, event: "Stop", excerpt: lastAssistantMessage, platformSource: this.platformSource });
  }

  /** Awaited by the caller: the hub process exits right after stop(), and an unawaited request would die with it. The synchronous published store operation has completed before this promise settles. */
  async end(): Promise<void> {
    if (!this.sessionId) return;
    const contentSessionId = this.sessionId;
    this.sessionId = "";
    await this.client.appendCapture({ project: this.opts.project, cwd: this.opts.cwd, at: new Date().toISOString(), sessionId: contentSessionId, agent: this.agentId, event: "SessionEnd", excerpt: "hub stop", platformSource: this.platformSource });
  }
}
