import { assistantTokens } from "./usage.ts";
import { processSignature } from "./process-signature.ts";
import { PI_CEILING_KIND, PI_CEILING_UNIT } from "./ceiling.ts";
type ExtensionAPI = any;
type BudgetUnit = "model_calls" | "tool_calls";

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
let pollStopped = false;
let toolSteps = 0;
let lastActivity = 0;
let usageSeq = 0;
let shellSeq = 0;
let forcedFailure = "";
let turnGeneration = 0;
let sessionId = "";
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
async function admitBudget(unit: BudgetUnit, idleUserBash = false, generation = turnGeneration, callSessionId = sessionId): Promise<{ allowed: boolean; reservation?: string; reason?: string }> {
  const current = () => generation === turnGeneration && callSessionId === sessionId;
  const stale = () => ({ allowed: false, reason: "Pi tool lineage ended during admission; do not retry the old call" });
  if (!current()) return stale();
  try {
    const result = await post("/budget", { unit, generation, ...(idleUserBash ? { idleUserBash: true } : {}) });
    if (!current()) return stale();
    const decisions = Array.isArray(result?.decisions) ? result.decisions : [];
    const denied = decisions.find((item: any) => item?.allowed === false);
    if (!denied) return { allowed: true, ...(idleUserBash && typeof result?.reservation === "string" ? { reservation: result.reservation } : {}) };
    const reason = `execution budget ${denied.reason ?? "exhausted"}: ${denied.scope} ${denied.unit ?? unit} used ${denied.used}${denied.limit === null ? "" : ` of ${denied.limit}`}`;
    if (idleUserBash) return { allowed: false };
    forcedFailure = reason;
  } catch (error) {
    if (!current()) return stale();
    if (idleUserBash) return { allowed: false };
    forcedFailure = `execution budget admission unavailable: ${(error as Error).message}`;
  }
  const reason = forcedFailure;
  try { await post("/event", { type: "agent_end", generation, failed: true, error: reason }); } catch { /* abort remains authoritative when the bridge is unavailable */ }
  if (current()) runtimeCtx?.abort?.();
  return { allowed: false, reason };
}
async function poll(pi: ExtensionAPI): Promise<void> {
  while (!pollStopped) {
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
          pollStopped = true;
          shutdown?.();
        } else if (command.type === "abort_budget") {
          if (Number.isSafeInteger(command.generation) && command.generation === turnGeneration) {
            if (typeof runtimeCtx?.abort !== "function") throw new Error("Pi runtime cannot abort the current turn");
            const generation = turnGeneration, callSessionId = sessionId;
            const reason = command.cause === "approval" && typeof command.reason === "string" && command.reason
              ? command.reason : "execution budget exhausted: elapsed_ms wall cap reached";
            forcedFailure = reason;
            await post("/event", { type: "agent_end", generation, failed: true, error: reason });
            if (generation === turnGeneration && callSessionId === sessionId) runtimeCtx?.abort?.();
          }
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
    sessionId = String(state?.id ?? "");
    try {
      const claimed = await post("/event", { type: "session_start", ownerToken, pid: process.pid, signature: processSignature(process.pid), sessionId: state?.id, sessionFile: ctx.sessionManager.getSessionFile(), approvalTurnAbort: typeof ctx.abort === "function" });
      if (claimed?.ok === false) { ctx.shutdown?.(); return; }
    } catch (error) { ctx.shutdown?.(); throw error; }
    if (!pollStarted) { pollStarted = true; void poll(pi); }
  });
  pi.on("agent_end", async (event: any) => {
    const message = (event as any).messages?.slice().reverse().find((m: any) => m?.role === "assistant");
    const text = message?.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")?.trim();
    const failed = !!forcedFailure || message?.stopReason === "error";
    const cancelled = !forcedFailure && message?.stopReason === "aborted";
    await post("/event", { type: "agent_end", generation: turnGeneration, text: text ?? "", failed, cancelled, ...(failed ? { error: forcedFailure || message?.errorMessage || message?.stopReason } : {}) });
  });
  pi.on("message_end", async (event: any) => {
    const tokens = assistantTokens(event.message);
    if (tokens === undefined) return;
    // Message-end is the sole usage source: agent_end carries those same messages again.
    try { await post("/event", { type: "tokens", id: `usage-${++usageSeq}`, tokens }); }
    catch { /* telemetry must not break a native turn */ }
  });
  pi.on("message_update", async () => {
    const now = Date.now();
    if (now - lastActivity < 1000) return;
    lastActivity = now;
    try { await post("/event", { type: "activity" }); } catch { /* shutdown owns bridge cleanup */ }
  });
  pi.on("agent_start", async () => { toolSteps = 0; forcedFailure = ""; turnGeneration++; await post("/event", { type: "agent_start", generation: turnGeneration }); });
  pi.on("model_select", async (_event: any, ctx: any) => { if (ctx.model?.provider && ctx.model.provider !== "agent-hub-local") ctx.shutdown?.(); });
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (ctx.model?.provider && ctx.model.provider !== "agent-hub-local") { ctx.abort?.(); return { systemPrompt: event.systemPrompt }; }
    return undefined;
  });
  pi.on("before_provider_request", async (_event: any, ctx: any) => {
    if (ctx.model?.provider && ctx.model.provider !== "agent-hub-local") { ctx.abort?.(); return undefined; }
    const generation = turnGeneration, callSessionId = sessionId;
    const current = () => generation === turnGeneration && callSessionId === sessionId;
    try { if (!(await admitBudget("model_calls", false, generation, callSessionId)).allowed && current()) ctx.abort?.(); }
    catch (error) { if (current()) { forcedFailure = `execution budget admission failed: ${(error as Error).message}`; ctx.abort?.(); } }
    return undefined;
  });
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const message = entries.slice().reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "assistant")?.message;
    const text = message?.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")?.trim();
    await post("/event", { type: "agent_settled", generation: turnGeneration, ...(text ? { text } : {}) });
  });
  pi.on("user_bash", async (event: any) => {
    const generation = turnGeneration, callSessionId = sessionId;
    const admission = await admitBudget("tool_calls", true, generation, callSessionId);
    if (!admission.allowed || !admission.reservation) return { cancel: true };
    const result = await post("/tool", { name: "bash", args: { command: event.command, cwd: event.cwd }, toolCallId: `pi-shell-${Date.now()}-${++shellSeq}`, purpose: "idle_user_bash", generation, sessionId: callSessionId, reservation: admission.reservation });
    return { result: { output: String(result.text ?? result), exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined, cancelled: result.exitCode === null, truncated: false } };
  });
  // Managed sessions may only be handed over by PiPeer after it has fenced the
  // owner and verified the replacement identity. User /fork and /resume would
  // otherwise silently detach the hub from its recorded session.
  pi.on("session_before_switch", async () => ({ cancel: true }));
  pi.on("session_before_fork", async () => ({ cancel: true }));
  pi.on("session_shutdown", async () => { pollStopped = true; await post("/event", { type: "session_shutdown" }); });
  for (const raw of (() => { try { return JSON.parse(process.env.AGENTHUB_PI_TOOLS ?? "[]") as any[]; } catch { return []; } })()) {
    if (!raw || typeof raw.name !== "string" || !raw.parameters) continue;
    pi.registerTool({ name: raw.name, label: raw.name, description: raw.description ?? raw.name, parameters: raw.parameters, async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
      const generation = turnGeneration, callSessionId = sessionId;
      if (signal?.aborted) return { content: [{ type: "text", text: "error: tool call cancelled before execution" }], details: {}, isError: true };
      const admission = await admitBudget("tool_calls", false, generation, callSessionId);
      if (!admission.allowed) return { content: [{ type: "text", text: `error: ${admission.reason ?? forcedFailure}` }], details: {}, isError: true };
      if (toolSteps++ >= maxSteps) {
        const reason = `Pi tool step limit ${maxSteps} reached`;
        forcedFailure = reason;
        // #179: the structured ceiling signal at the actual rejection boundary, before the failure
        // event, so the adapter binds it while the turn still owns it. The counter already counts the
        // rejected pre-effect invocation (toolSteps++ above); its side effect never executes. The
        // reason text stays the failure record; the signal adds the validated counts.
        try { await post("/event", { type: "ceiling", kind: PI_CEILING_KIND, unit: PI_CEILING_UNIT, count: toolSteps, limit: maxSteps, sessionId: callSessionId, generation }); } catch { /* the agent_end failure below remains authoritative */ }
        await post("/event", { type: "agent_end", generation, failed: true, error: reason });
        if (generation === turnGeneration && callSessionId === sessionId) runtimeCtx?.abort?.();
        return { content: [{ type: "text", text: `error: ${reason}` }], details: {}, isError: true };
      }
      const aborted = () => { void post("/event", { type: "tool_abort", sessionId: callSessionId, generation, toolCallId }).catch(() => undefined); };
      if (signal?.aborted) return { content: [{ type: "text", text: "error: tool call cancelled before execution" }], details: {}, isError: true };
      signal?.addEventListener("abort", aborted, { once: true });
      let result: any;
      try {
        result = await post("/tool", { name: raw.name, args: params, toolCallId, sessionId: callSessionId, generation });
        if (signal?.aborted) aborted();
      } finally { signal?.removeEventListener("abort", aborted); }
      const text = String(result.text ?? result);
      // Pi 1.0.1 reads isError === true alone (#181). The bridge computes `failed` with the
      // managed-tool failure contract (toolResultFailed); the extension never re-parses the text.
      // A bridge too old to send `failed` leaves the result unflagged, exactly as before the fix.
      return { content: [{ type: "text", text }], details: {}, isError: result.failed === true };
    } });
  }
}
