import { randomUUID } from "node:crypto";
import { renderDigest, replyParent, STANDING_INSTRUCTION, USER, type Envelope, type EnvelopeOpts, type PeerId } from "../hub/envelope.ts";
import { TASK_TOOL_NAMES, TASK_TOOLS } from "../hub/hub-tools.ts";
import { BasePeer } from "../hub/peers.ts";
import { profile } from "../local/sandbox.ts";
import { runTool, TOOL_SCHEMAS, touchedPaths, type ToolContext } from "../local/tools.ts";
import type { Capture } from "../memory/capture.ts";
import type { ChatMessage, ChatResult, OmniRoute } from "../omniroute/client.ts";
import type { Sidecar } from "../switchyard/sidecar.ts";

export interface LocalOptions {
  cwd: string;
  omni: OmniRoute;
  /** Absent = always the fixed model on OmniRoute. */
  sidecar?: Sidecar;
  /** Switchyard route id asked of the sidecar. */
  route?: string;
  /** Model id sent straight to OmniRoute when the sidecar is absent, unhealthy or fails a call. */
  fixedModel: string;
  tools: { deny: string[]; permit: ToolContext["permit"]; bashNetwork?: boolean; readAllow?: string[] };
  capture?: Capture;
  /** Runs a hub task tool (hub_task_*, hub_review, hub_remember) as this peer. Absent = the tools are not offered. */
  taskTool?: (name: string, args: Record<string, unknown>, turn: { pii: boolean }) => Promise<string>;
  /** Per-turn policy from the task the delivery carries: the class's route, and whether it is a PII task. */
  turnPolicy?: (envs: Envelope[]) => { route?: string; fixedModel?: string; pii: boolean; task?: string } | undefined;
  /** Role contract, appended to the system prompt. */
  preamble?: string;
  watchdogMs?: number;
  maxSteps?: number;
  log?: (line: string) => void;
}

const HISTORY_CHARS = 100_000;
/** One turn may hold this much before its oldest tool outputs are replaced by a stub. */
const TURN_CHARS = 120_000;
/** Tools whose effects outlive a failed turn: once one ran, the turn is never redelivered. */
const SIDE_EFFECTS = new Set(["write", "edit", "bash", "git", "hub_send"]);
const chars = (msgs: ChatMessage[]) => msgs.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length, 0);

const asFunction = (t: { name: string; description: string; inputSchema: unknown }) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } });

const system = (cwd: string, preamble = "") =>
  [
    `You are "local", a coding agent run by agent-hub on a self-hosted model, working in ${cwd}.`,
    "You take bulk and low-stakes work (mechanical edits, summaries, test runs) from the other agents and the hub console user.",
    STANDING_INSTRUCTION,
    "Tools: read, write, edit, bash, git, hub_send. They only work inside the project directory; secrets are unreadable; write, edit, bash and mutating git wait for the user's approval, so batch your changes and do not retry a refused call.",
    "When the work is done, answer with a short conclusion: what changed, what you verified, what is left. No tool output, no code dumps.",
    "If a message needs no work from you, answer in one line.",
    preamble,
  ].filter(Boolean).join("\n");

/** Hub-native agent loop: the hub owns every model call, so it can choose the model per call (L2) and the gateway (L3). */
export class LocalPeer extends BasePeer {
  private readonly history: ChatMessage[] = [];
  private readonly sessionId = `agent-hub-local-${randomUUID()}`;
  private turn = 0; // generation guard, as in acp.ts: a turn aborted by the watchdog must not touch the next one
  private abort: AbortController | undefined;
  private readonly sandboxProfile: string; // built once: profile() spawns git and must stay off the per-call path
  /** What served the last call, for `hub status`. */
  lastServedBy = "";

  constructor(
    id: PeerId,
    private readonly opts: LocalOptions,
  ) {
    super(id, opts.watchdogMs);
    this.sandboxProfile = profile(opts.cwd, opts.tools.bashNetwork ?? false, opts.tools.readAllow, opts.tools.deny);
  }

  async start(): Promise<void> {
    this.opts.capture?.init(this.sessionId, "agent-hub local worker session");
    this.setState("idle");
  }

  async stop(): Promise<void> {
    this.turn++;
    this.abort?.abort();
    await this.opts.capture?.end();
    this.setState("offline");
  }

  /** Resolves once the turn is claimed; a turn that cannot reach any model hands the envelopes back through onFailed. */
  async deliver(envs: Envelope[]): Promise<void> {
    if (this.state !== "idle") throw new Error(`${this.id} is ${this.state}`);
    const turn = ++this.turn;
    this.setState("busy");
    // The turn works on its own message list and joins the history only as a whole, so a failed or aborted turn can
    // never leave a tool call without its result (strict servers reject that history forever after).
    const msgs: ChatMessage[] = [{ role: "user", content: renderDigest(envs, true) }];
    const progress = { sideEffects: 0, last: "" };
    const policy = this.opts.turnPolicy?.(envs);
    // A PII turn speaks to the console user only, and privately: its answer must not be broadcast to cloud-hosted peers.
    // The task id travels with it, so the board can keep the text (`hub task show`) while tail and log show a stub.
    const reply: EnvelopeOpts = { inReplyTo: replyParent(envs), ...(policy?.pii ? { to: [USER], private: true, priority: "important" as const, ...(policy.task ? { refs: { task: policy.task } } : {}) } : {}) };
    this.run(envs, turn, msgs, progress, policy, reply)
      .then((answer) => {
        if (turn !== this.turn) return;
        if (!policy?.pii) this.commit(msgs); // a PII turn leaves nothing in the history later turns send along
        if (answer) this.onMessage?.(answer, reply);
      })
      .catch((e: Error) => {
        if (turn !== this.turn) return; // aborted by the watchdog or stop(): nothing to report, nothing was committed
        this.opts.log?.(`[${this.id}] turn failed: ${e.message}`);
        if (!progress.sideEffects) return this.onFailed?.(envs); // nothing happened yet: safe to redeliver
        // Tools already changed things. Redelivering would redo approved writes and commits, so report instead.
        // A model call is the only thing that throws here, and every tool call before it has its result: msgs is consistent.
        const note = `(turn failed after ${progress.sideEffects} tool call(s) with side effects: ${e.message.slice(0, 200)}. The work may be partial; check before repeating it.) ${progress.last}`.trim();
        msgs.push({ role: "assistant", content: note });
        if (!policy?.pii) this.commit(msgs);
        this.onMessage?.(note, reply);
      })
      .finally(() => {
        if (turn === this.turn && this.state === "busy") this.setState("idle");
      });
  }

  protected override onWatchdog(): void {
    this.turn++;
    this.abort?.abort();
    super.onWatchdog();
  }

  private async run(
    envs: Envelope[],
    turn: number,
    msgs: ChatMessage[],
    progress: { sideEffects: number; last: string },
    policy: { route?: string; fixedModel?: string; pii: boolean; task?: string } | undefined,
    reply: EnvelopeOpts,
  ): Promise<string> {
    const { maxSteps = 30 } = this.opts;
    // claude-mem's observer is a cloud model: nothing of a PII turn is captured.
    const capture = policy?.pii ? undefined : this.opts.capture;
    if (policy?.pii && (await this.opts.omni.offCampus())) {
      return "Refused: this is a PII task and the only reachable gateway is off campus (Cloudflare Access). Connect WARP and assign it again.";
    }
    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      deny: this.opts.tools.deny,
      permit: this.opts.tools.permit,
      sandboxProfile: this.sandboxProfile,
      send: (text, to) => {
        this.onMessage?.(text, policy?.pii ? reply : { inReplyTo: replyParent(envs), ...(to?.length ? { to } : {}) });
        return policy?.pii ? "sent to the console user only (PII task)" : "sent";
      },
    };
    let usedTools = false;
    for (let step = 0; step < maxSteps; step++) {
      this.elide(msgs);
      const res = await this.call(msgs, policy);
      if (turn !== this.turn) return "";
      this.touch();
      msgs.push(res.message);
      progress.last = res.message.content?.trim() || progress.last;
      if (!res.message.tool_calls?.length) {
        if (usedTools) capture?.summarize(progress.last);
        return progress.last;
      }
      for (const call of res.message.tool_calls) {
        // A tool has its own timeout (bash up to 600 s) and an approval can take 120 s: neither is the model going silent.
        const alive = setInterval(() => this.state === "busy" && turn === this.turn && this.touch(), 30_000);
        const name = call.function.name;
        const running = TASK_TOOL_NAMES.has(name) && this.opts.taskTool ? this.opts.taskTool(name, safeParse(call.function.arguments), { pii: !!policy?.pii }).catch((e: Error) => `error: ${e.message}`) : runTool(name, call.function.arguments, ctx);
        const output = await running.finally(() => clearInterval(alive));
        if (turn !== this.turn) return "";
        this.touch();
        usedTools = true;
        if (SIDE_EFFECTS.has(call.function.name) && !output.startsWith("error:")) progress.sideEffects++;
        msgs.push({ role: "tool", tool_call_id: call.id, content: output });
        capture?.observe({ tool: call.function.name, args: call.function.arguments, output, id: call.id, paths: touchedPaths(call.function.name, safeParse(call.function.arguments)) });
      }
    }
    if (usedTools) capture?.summarize(progress.last);
    return `(stopped after ${maxSteps} steps) ${progress.last}`.trim();
  }

  /** L2 when the sidecar is up, otherwise (or when a call through it fails) the fixed model on L3. */
  private async call(turnMsgs: ChatMessage[], policy?: { route?: string; fixedModel?: string }): Promise<ChatResult> {
    const { omni, sidecar } = this.opts;
    // A task turn asks for its class's route; a route needs the sidecar, which exists only when the worker was started with one.
    const route = sidecar ? (policy?.route ?? this.opts.route) : undefined;
    const fixedModel = policy?.fixedModel ?? this.opts.fixedModel;
    const tools = [...TOOL_SCHEMAS, ...(this.opts.taskTool ? TASK_TOOLS.map(asFunction) : [])];
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const messages: ChatMessage[] = [{ role: "system", content: system(this.opts.cwd, this.opts.preamble) }, ...this.history, ...turnMsgs];
    const via = route ? await sidecar?.endpoint() : undefined;
    if (via) {
      try {
        const res = await omni.chat({ model: route!, messages, tools }, { via, sessionId: this.sessionId, signal });
        this.lastServedBy = `switchyard ${route} -> ${res.selectedModel ?? "?"}`;
        return res;
      } catch (e) {
        if (signal.aborted) throw e;
        sidecar!.disable((e as Error).message);
      }
    }
    const res = await omni.chat({ model: fixedModel, messages, tools }, { signal });
    this.lastServedBy = `omniroute ${fixedModel} (provider ${res.provider ?? "?"})`;
    return res;
  }

  /** A finished turn joins the history; whole old turns (user message up to the next one) fall off the front, so tool calls keep their results. */
  private commit(msgs: ChatMessage[]): void {
    this.history.push(...msgs);
    while (chars(this.history) > HISTORY_CHARS) {
      const next = this.history.findIndex((m, i) => i > 0 && m.role === "user");
      if (next === -1) break;
      this.history.splice(0, next);
    }
  }

  /** Inside a long turn the oldest tool outputs are replaced by a stub: the structure stays valid, the context stays bounded. */
  private elide(msgs: ChatMessage[]): void {
    for (const m of msgs) {
      if (chars(msgs) <= TURN_CHARS) return;
      if (m.role === "tool" && (m.content?.length ?? 0) > 200) m.content = "(output elided to save context; run the tool again if you need it)";
    }
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}
