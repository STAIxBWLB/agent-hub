type ExtensionAPI = any;
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

type BridgeEvent = { type: string; text?: string; sessionId?: string; sessionFile?: string; error?: string };

const bridgeUrl = process.env.AGENTHUB_PI_BRIDGE_URL ?? "";
const bridgeToken = process.env.AGENTHUB_PI_BRIDGE_TOKEN ?? "";
const ownerToken = process.env.AGENTHUB_PI_OWNER_TOKEN ?? "";
const relayUrl = process.env.AGENTHUB_PI_RELAY_URL ?? "";
const relayToken = process.env.AGENTHUB_PI_RELAY_TOKEN ?? "";
const models = (() => {
  try { return JSON.parse(process.env.AGENTHUB_PI_MODELS ?? "[]") as unknown[]; } catch { return []; }
})();
let pollStarted = false;
let toolSteps = 0;
let lastActivity = 0;
let forcedFailure = "";
const maxSteps = Number(process.env.AGENTHUB_PI_MAX_STEPS ?? 30);
let shutdown: (() => void) | undefined;
let runtimeCtx: any;
let modelRegistry: any;

async function post(path: string, body: unknown): Promise<any> {
  if (!bridgeUrl || !bridgeToken) throw new Error("Pi bridge is not configured");
  const response = await fetch(`${bridgeUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Pi bridge HTTP ${response.status}`);
  return response.json();
}
function processSignature(): string | undefined { try { const text = execFileSync("ps", ["-p", String(process.pid), "-o", "lstart=,comm="], { encoding: "utf8" }).trim(); return text ? createHash("sha256").update(text).digest("hex") : undefined; } catch { return undefined; } }

async function poll(pi: ExtensionAPI): Promise<void> {
  while (true) {
    try {
      const response = await fetch(`${bridgeUrl}/commands`, { headers: { authorization: `Bearer ${bridgeToken}` } });
      const payload = await response.json() as { command?: any };
      const command = payload.command;
      if (!command) continue;
      try {
        if (command.type === "prompt" || command.type === "steer") {
          pi.sendMessage({ customType: "agent-hub", content: String(command.message ?? ""), display: true }, { triggerTurn: command.type === "prompt", deliverAs: command.type === "steer" ? "steer" : "followUp" });
        } else if (command.type === "get_session_state") {
          const entries = runtimeCtx.sessionManager.getEntries();
          await post("/ack", { id: command.id, ok: true, result: {
            sessionId: runtimeCtx.sessionManager.getHeader()?.id,
            sessionFile: runtimeCtx.sessionManager.getSessionFile(),
            idle: runtimeCtx.isIdle() === true,
            empty: entries.every((entry: any) => ["model_change", "thinking_level_change"].includes(entry.type)),
          } });
          continue;
        } else if (command.type === "set_model") {
          const model = modelRegistry?.find(String(command.provider), String(command.modelId));
          if (!model || !(await (pi as any).setModel?.(model))) throw new Error("Pi model is not available");
        } else if (command.type === "shutdown") {
          shutdown?.();
        }
        await post("/ack", { id: command.id, ok: true });
      } catch (error) { await post("/ack", { id: command.id, ok: false, error: (error as Error).message }); }
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
}

export default function(pi: ExtensionAPI): void {
  if (relayUrl) {
    pi.registerProvider("agent-hub-local", {
      baseUrl: relayUrl,
      api: "openai-completions",
      apiKey: relayToken || "agent-hub-local",
      models: models.filter((m): m is any => !!m && typeof m === "object" && typeof (m as any).id === "string").map((m: any) => ({
        id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: m.contextWindow ?? 131072, maxTokens: m.maxTokens ?? 8192,
      })),
    });
  }
  pi.on("session_start", async (_event: any, ctx: any) => {
    runtimeCtx = ctx;
    modelRegistry = ctx.modelRegistry;
    shutdown = ctx.shutdown;
    const state = ctx.sessionManager.getHeader();
    try {
      const claimed = await post("/event", { type: "session_start", ownerToken, pid: process.pid, signature: processSignature(), sessionId: state?.id, sessionFile: ctx.sessionManager.getSessionFile() });
      if (claimed?.ok === false) { ctx.shutdown?.(); return; }
    } catch (error) { ctx.shutdown?.(); throw error; }
    if (!pollStarted) { pollStarted = true; void poll(pi); }
  });
  pi.on("agent_end", async (event: any) => {
    const message = (event as any).messages?.slice().reverse().find((m: any) => m?.role === "assistant");
    const text = message?.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")?.trim();
    const failed = !!forcedFailure || message?.stopReason === "error";
    const cancelled = !forcedFailure && message?.stopReason === "aborted";
    await post("/event", { type: "agent_end", text: text ?? "", failed, cancelled, ...(failed ? { error: forcedFailure || message?.errorMessage || message?.stopReason } : {}) });
  });
  pi.on("message_update", async () => {
    const now = Date.now();
    if (now - lastActivity < 1000) return;
    lastActivity = now;
    try { await post("/event", { type: "activity" }); } catch { /* shutdown owns bridge cleanup */ }
  });
  pi.on("agent_start", async () => { toolSteps = 0; forcedFailure = ""; await post("/event", { type: "agent_start" }); });
  pi.on("model_select", async (_event: any, ctx: any) => { if (ctx.model?.provider && ctx.model.provider !== "agent-hub-local") ctx.shutdown?.(); });
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (ctx.model?.provider && ctx.model.provider !== "agent-hub-local") { ctx.abort?.(); return { systemPrompt: event.systemPrompt }; }
    return undefined;
  });
  pi.on("before_provider_request", async (_event: any, ctx: any) => { if (ctx.model?.provider && ctx.model.provider !== "agent-hub-local") ctx.abort?.(); return undefined; });
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const message = entries.slice().reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "assistant")?.message;
    const text = message?.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")?.trim();
    await post("/event", { type: "agent_settled", ...(text ? { text } : {}) });
  });
  pi.on("user_bash", async (event: any) => {
    const result = await post("/tool", { name: "bash", args: { command: event.command, cwd: event.cwd }, toolCallId: `pi-shell-${Date.now()}` });
    return { result: { output: String(result.text ?? result), exitCode: 0, cancelled: false, truncated: false } };
  });
  // Managed sessions may only be handed over by PiPeer after it has fenced the
  // owner and verified the replacement identity. User /fork and /resume would
  // otherwise silently detach the hub from its recorded session.
  pi.on("session_before_switch", async () => ({ cancel: true }));
  pi.on("session_before_fork", async () => ({ cancel: true }));
  pi.on("session_shutdown", async () => { await post("/event", { type: "session_shutdown" }); });
  for (const raw of (() => { try { return JSON.parse(process.env.AGENTHUB_PI_TOOLS ?? "[]") as any[]; } catch { return []; } })()) {
    if (!raw || typeof raw.name !== "string" || !raw.parameters) continue;
    pi.registerTool({ name: raw.name, label: raw.name, description: raw.description ?? raw.name, parameters: raw.parameters, async execute(toolCallId: string, params: unknown) {
      if (toolSteps++ >= maxSteps) { const reason = `Pi tool step limit ${maxSteps} reached`; forcedFailure = reason; await post("/event", { type: "agent_end", failed: true, error: reason }); runtimeCtx?.abort?.(); return { content: [{ type: "text", text: `error: ${reason}` }], details: {}, isError: true }; }
      const result = await post("/tool", { name: raw.name, args: params, toolCallId });
      return { content: [{ type: "text", text: String(result.text ?? result) }], details: {} };
    } });
  }
}
